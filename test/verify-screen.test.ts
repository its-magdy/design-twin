// Offline tests for design-to-code/verify-screen.ts — the per-node comparison behind a "pass".
//
// Every fixture is a miniature of something three verification passes called "pass" on the live run
// while an independent measurement pass found it wrong: a heading rendered at the page-title style,
// a body at 16px/#d4d4d4 where the export says 14px/#a0a0a0, a chip whose fill token was never
// applied, a modal at radius 20 against a spec of 12, two toolbar components never built, and a set
// of designed interactions nobody exercised.
// Run with:  bun test/verify-screen.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { liveStatusFile } from "../design-to-code/verify-run.ts";
import { reportToMarkdown } from "../design-to-code/verify-report-md.ts";
import { compare, tokenFor } from "../design-to-code/verify-compare.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { normColor, normWeight, normFamily, lineHeightPx, fontWeightOf, FIELDS } from "../design-to-code/verify-shared.ts";
import { planCodeFiles } from "../design-to-code/content-hash.ts";
import { audit } from "../design-to-code/audit.ts";
import type { ExpectInput } from "../design-to-code/verify-expect.ts";
import type { FontSpec, MeasuredNode, MeasuredStyles, Paint, ScreenExport, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { malformed, must, readFixture, screenExport } from "./fixtures.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { NodeInput } from "./fixtures.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import type { DocGuard } from "../design-to-code/doc-guards.ts";
import { check as ok, report } from "./assert.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { cliRunner } from "./cli-runner.ts";
import { main as verifyScreenMain } from "../design-to-code/verify-screen.ts";
// the first runs are real children, the rest verify-screen.ts's main in-process (test/cli-runner.ts); --wait polls (async): a child
const verifyScreen = cliRunner(path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts"), verifyScreenMain, { spawnIf: (a) => a.some((w) => w === "--wait" || w.startsWith("--wait=")) });
const okOuter = ok;

// A one-frame screen export around the given children (typed IR nodes: fixtures.ts node()).
const doc = (children: NodeInput[], extra?: Omit<ScreenExport, "nodes">): ExpectInput => ({
  doc: screenExport([{ type: "FRAME", id: "1:1", name: "Checkout", children }], { exportedAt: "2026-09-22T00:00:00Z", screen: "Checkout", ...extra }),
  label: "Checkout",
});
const textNode = (id: string, name: string, text: string, font: FontSpec, fills?: Paint[]): NodeInput => ({ type: "TEXT", id, name, text, font, ...(fills ? { fills } : {}) });
const measured = (nodes: MeasuredNode[], extra?: Partial<VerifyMeasured>): VerifyMeasured => Object.assign({ measuredAt: "2026-09-22T01:00:00Z", renderer: "playwright-chromium", viewport: "1440x1236", nodes }, extra);

// ---------------------------------------------------------------- normalisation
console.log("verify-screen — normalising what Figma and CSS each call the same thing:");
ok("[norm] #fff and #ffffffff are the same colour", normColor("#fff") === normColor("#ffffffff"));
ok("[norm] oklch() is compared as hex: a non-zero colour converts (oklch red = #ff0000ff, a mid grey = #808080ff)", normColor("oklch(0.628 0.2577 29.23)") === "#ff0000ff" && normColor("oklch(0.6 0 0)") === "#808080ff");
ok("[norm] rgb() is compared as hex", normColor("rgb(29, 29, 31)") === "#1d1d1fff");
ok("[norm] a fully transparent background is 'no background', whatever its channels", normColor("rgba(0, 0, 0, 0)") === "transparent");
// normColor reads rgb() with color.ts parseCssColor (the probe's reader): a % alpha is read, not left as a raw string; an
// out-of-range channel clamps (CSS Color 4 §5.1) instead of writing a 3-digit "12c"; oklab(… / 0) is transparent.
ok("[norm] rgba(0, 0, 0, 50%) -> #00000080; rgb(300, 0, 0) -> #ff0000ff; rgb(0 0 0 / 0.5) -> #00000080; oklab(0 0 0 / 0) -> transparent; 'red' stays 'red'",
  normColor("rgba(0, 0, 0, 50%)") === "#00000080" && normColor("rgb(300, 0, 0)") === "#ff0000ff" && normColor("rgb(0 0 0 / 0.5)") === "#00000080"
  && normColor("oklab(0 0 0 / 0)") === "transparent" && normColor("red") === "red");
ok("[norm] Figma's 'SemiBold' and CSS's 600 are the same weight", normWeight("SemiBold") === 600 && normWeight(600) === 600);
ok("[norm] 'Medium' is 500, which is what makes 500-vs-600 a real mismatch", normWeight("Medium") === 500);
ok("[norm] a CSS font stack compares on its FIRST family", normFamily('"Poppins", ui-sans-serif, system-ui') === "poppins");
ok("[norm] a percentage line-height resolves against the font size", lineHeightPx({ value: 150, unit: "PERCENT" }, 16) === 24);
ok("[norm] line-height 'normal' is unknowable, not a mismatch", lineHeightPx("normal", 16) === null);
// the producer's own LengthSpec spelling (text.ts lenUnit / lineH): lower-case "percent" | "px" | "auto" — a live 14px
// "Back to Employees" exported {value:150, unit:"percent"} and Figma's CSS said `150% /* 21px */`
ok("[norm] the producer's {value:150, unit:'percent'} on 14px text is 21px, not 150", lineHeightPx({ value: 150, unit: "percent" }, 14) === 21);
ok("[norm] the producer's {unit:'auto'} is unknowable (null) and {value:20, unit:'px'} is 20", lineHeightPx({ unit: "auto" }, 14) === null && lineHeightPx({ value: 20, unit: "px" }, 14) === 20);
ok("[norm] a percentage over a 'mixed' or absent font size is null, never NaN", lineHeightPx({ value: 150, unit: "percent" }, "mixed") === null && lineHeightPx({ value: 150, unit: "percent" }, undefined) === null);
ok("[norm] a style name with Italic/Oblique still names its weight ('Semibold Italic' 600, 'Bold Oblique' 700, 'Italic' 400)",
  normWeight("Semibold Italic") === 600 && normWeight("Bold Oblique") === 700 && normWeight("Italic") === 400 && normWeight("") === null && normWeight("Condensed") === null);
ok("[norm] a fractional computed weight string is that number ('650.5' → 650.5), as a variable font may compute it", normWeight("650.5") === 650.5);
ok("[norm] fontWeightOf: a fractional weightValue/wght stays fractional; every branch is bounded to CSS's 1–1000 (a style 'name' of '0' or '1001' is no weight)",
  fontWeightOf({ weightValue: 650.5 }) === 650.5 && fontWeightOf({ variationSettings: { wght: 650.5 } }) === 650.5
  && fontWeightOf({ weight: "0" }) === null && fontWeightOf({ weight: "1001" }) === null && fontWeightOf({ weight: "Bold" }) === 700);

// ---------------------------------------------------------------- the expectation is data, not prose
console.log("verify-screen — the spec as data:");
{
  const exp = buildExpectation([
    doc([
      textNode("2:1", "Title", "Nothing here yet.", { family: "Poppins", size: 18, weight: "Medium", lineHeight: { value: 22, unit: "px" }, color: "#ffffff" }),
      // gap is only a gap between two laid-out children (see the slack rules below)
      // the legacy per-side padding keys (paddingTop…) an older export wrote — read beside padding[]
      malformed<NodeInput>({ type: "FRAME", id: "2:2", name: "Card", fills: [{ type: "solid", color: "#121319" }], radius: 20, layout: { gap: 16, paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32 }, box: { w: 400, h: 200 },
        children: [{ type: "FRAME", id: "2:21", name: "a" }, { type: "FRAME", id: "2:22", name: "b" }] }),
      { type: "FRAME", id: "2:3", name: "Nothing checkable" },
    ]),
  ]);
  ok("[expect] one row per node that actually carries a checkable value", exp.nodes.length === 2);
  const title = must(exp.nodes.find((n) => n.nodeId === "2:1"), "exp.nodes '2:1'");
  ok("[expect] a text node's spec carries family/size/weight/line-height/colour",
    title.fontFamily === "Poppins" && title.fontSize === 18 && title.fontWeight === 500 && title.lineHeight === 22 && title.color === "#ffffffff");
  ok("[expect] a TEXT node's fill is its COLOUR, never a background", title.backgroundColor === undefined);
  const card = must(exp.nodes.find((n) => n.nodeId === "2:2"), "exp.nodes '2:2'");
  ok("[expect] a frame's fill IS a background", card.backgroundColor === "#121319ff");
  ok("[expect] radius, gap, padding and size come through as numbers",
    card.borderRadius === 20 && card.gap === 16 && card.padding?.join(",") === "32,32,32,32" && card.width === 400);
  ok("[expect] a field the export does not state is ABSENT, not defaulted", !("fontWeight" in card) && !("color" in card));
  ok("[expect] the file says out loud not to retype these numbers", /do NOT retype/i.test(must(exp.note, "exp.note")));
}
{
  // Typography in the producer's own shapes (figma-plugin/src/text.ts fontObj): lineHeight is a lower-case LengthSpec,
  // `weight` the style name verbatim, `weightValue` Figma's numeric fontWeight, `variationSettings` the applied axes, and
  // mixed text puts the FIRST run's font on the node with every run under `runs`.
  const run = (text: string, weight: string, weightValue: number): { text: string; font: FontSpec } => ({ text, font: { family: "Inter", size: 20, weight, weightValue } });
  const exp = buildExpectation([doc([
    textNode("4:1", "Back", "Back to Employees", { family: "Poppins", size: 14, weight: "Medium", weightValue: 500, lineHeight: { value: 150, unit: "percent" } }),
    // a numeric weight the style name does not say (a variable font's custom weight under the "Regular" instance name)
    textNode("4:2", "Custom", "Custom weight", { family: "Inter", size: 16, weight: "Regular", weightValue: 650 }),
    // no weightValue (an older export): the applied wght axis, then the style name
    textNode("4:3", "Axis", "Axis only", { family: "Inter", size: 16, weight: "Regular", variationSettings: { wght: 650, slnt: 0 } }),
    textNode("4:4", "Named", "Name only", { family: "Inter", size: 16, weight: "Semibold Italic" }),
    textNode("4:5", "Junk", "Out of range", { family: "Inter", size: 16, weight: "Bold", weightValue: 0 }),
    { ...textNode("4:6", "Rich", "Rich text", { family: "Inter", size: 20, weight: "Bold", weightValue: 700 }), runs: [run("Rich", "Bold", 700), run(" text", "Regular", 400)] },
    { ...textNode("4:7", "Even", "Even text", { family: "Inter", size: 20, weight: "Bold", weightValue: 700 }), runs: [run("Even", "Bold", 700), run(" text", "Bold", 700)] },
  ])]);
  const at = (id: string) => must(exp.nodes.find((n) => n.nodeId === id), `exp.nodes '${id}'`);
  ok("[expect] a percent line-height in the producer's spelling resolves against the font size (150% of 14px → 21)", at("4:1").lineHeight === 21);
  ok("[expect] the numeric weightValue wins over the style name ('Regular' + weightValue 650 → 650)", at("4:2").fontWeight === 650);
  ok("[expect] with no weightValue the applied wght axis is the weight (650), not the 'Regular' name", at("4:3").fontWeight === 650);
  ok("[expect] with neither, the style name decides — 'Semibold Italic' is 600", at("4:4").fontWeight === 600);
  ok("[expect] a weightValue outside CSS's 1–1000 is not a weight — the style name decides (Bold → 700)", at("4:5").fontWeight === 700);
  ok("[expect] mixed runs of different weights state no single node weight: no fontWeight, a font-weight notComparable row",
    !("fontWeight" in at("4:6")) && exp.notComparable.some((g) => g.nodeId === "4:6" && g.field === "font-weight" && /700.*400/.test(g.why)));
  ok("[expect] mixed runs that share one weight keep it (700)", at("4:7").fontWeight === 700 && !exp.notComparable.some((g) => g.nodeId === "4:7"));
}
{
  // primaryAxisAlignItems SPACE_EVENLY/SPACE_AROUND distribute the frame's free space along the
  // primary axis just like SPACE_BETWEEN, ignoring itemSpacing — so a stored gap is slack there too,
  // not a real gap (see the comment above the justifyContent check in verify-screen.ts).
  const evenlyExp = buildExpectation([
    doc([{ type: "FRAME", id: "3:1", name: "Row", radius: 8, fills: [{ type: "solid", color: "#ffffff" }], layout: { gap: 24, justifyContent: "space-evenly" }, box: { w: 300, h: 40 },
      children: [{ type: "FRAME", id: "3:11", name: "a" }, { type: "FRAME", id: "3:12", name: "b" }] }]),
  ]);
  const evenlyRow = must(evenlyExp.nodes.find((n) => n.nodeId === "3:1"), "evenlyExp.nodes '3:1'");
  ok("[expect] space-evenly: the stored gap is excluded, not treated as a real gap",
    !("gap" in evenlyRow) && evenlyExp.notComparable.some((n) => n.nodeId === "3:1" && n.field === "gap"));
  const aroundExp = buildExpectation([
    doc([{ type: "FRAME", id: "3:2", name: "Row", radius: 8, fills: [{ type: "solid", color: "#ffffff" }], layout: { gap: 24, justifyContent: "space-around" }, box: { w: 300, h: 40 },
      children: [{ type: "FRAME", id: "3:21", name: "a" }, { type: "FRAME", id: "3:22", name: "b" }] }]),
  ]);
  const aroundRow = must(aroundExp.nodes.find((n) => n.nodeId === "3:2"), "aroundExp.nodes '3:2'");
  ok("[expect] space-around: the stored gap is excluded, not treated as a real gap",
    !("gap" in aroundRow) && aroundExp.notComparable.some((n) => n.nodeId === "3:2" && n.field === "gap"));
}
{
  // an asset leaf carried an inferred `layout` whose padding/gap is the inset already baked into the
  // exported file — never a spec to compare. Real shapes: asset = "assets/<name>", layout.padding = [t,r,b,l].
  const BAKED = "inset baked into the exported asset";
  const leaf = (id: string, extra: Record<string, unknown>): NodeInput => malformed<NodeInput>({ type: "FRAME", id, name: "Mark", box: { w: 24, h: 24 }, layout: { display: "flex", padding: [3.33, 3.33, 3.33, 3.33], gap: 2 }, ...extra });
  const exp = buildExpectation([doc([
    leaf("4:1", { asset: "assets/mark.svg" }),
    leaf("4:2", { geometry: { fills: ["M0 0"] } }),
    leaf("4:3", { assetSkipped: true }),
    leaf("4:4", { assetSkipped: "hidden" }),
    malformed<NodeInput>({ type: "FRAME", id: "4:5", name: "Plain", box: { w: 24, h: 24 }, layout: { display: "flex", padding: [4, 4, 4, 4] }, children: [{ type: "FRAME", id: "4:51", name: "a" }] }),
  ])]);
  for (const id of ["4:1", "4:2", "4:3", "4:4"]) {
    const row = exp.nodes.find((r) => r.nodeId === id);
    ok(`${id}: an asset leaf's inferred padding/gap is not a spec`, !row || (row.padding === undefined && row.gap === undefined && row.paddingSkip === undefined));
    ok(`${id}: …it is a notComparable row for padding (value kept) and for gap, with the baked-inset reason`,
      exp.notComparable.some((r) => r.nodeId === id && r.field === "padding" && r.why === BAKED && JSON.stringify(r.value) === "[3.33,3.33,3.33,3.33]")
      && exp.notComparable.some((r) => r.nodeId === id && r.field === "gap" && r.why === BAKED && r.value === 2));
  }
  ok("a non-leaf frame keeps its padding spec", JSON.stringify(exp.nodes.find((r) => r.nodeId === "4:5")?.padding) === "[4,4,4,4]" && !exp.notComparable.some((r) => r.nodeId === "4:5"));
}
{
  // Hidden nodes are not rendered, so measuring them is a false failure waiting to happen. The export
  // marks them `hidden: true` — NOT `visible: false`, and a hidden parent hides its subtree.
  const exp = buildExpectation([doc([
    { type: "TEXT", id: "2:9", hidden: true, text: "hidden", font: { family: "Poppins", size: 12 } },
    { type: "FRAME", id: "2:10", name: "Breadcrumb", hidden: true, children: [textNode("2:11", "crumb", "Home", { family: "Poppins", size: 12 })] },
  ])]);
  ok("[expect] a node with hidden:true produces no expectation — nor does anything under a hidden parent", exp.nodes.length === 0);
  ok("[expect] …and the skipped layers are counted and listed, not silently dropped",
    exp.counts.hidden.layers === 2 && exp.counts.hidden.nodes === 3 && exp.hidden.ids.join(",") === "2:9,2:10,2:11");
  // `visible` in this export is a component-property REFERENCE (`propRefs.visible: "Show Breadcrumb"`),
  // not a visibility flag; filtering on it gives a confidently wrong answer.
  const exp2 = buildExpectation([doc([Object.assign(textNode("2:12", "Back", "Back", { family: "Poppins", size: 12 }), { propRefs: { visible: "Show back link" }, visible: false })])]);
  ok("[expect] a `visible` key is NOT the hidden flag — the predicate reads `hidden` only", exp2.nodes.length === 1);
}

// ---------------------------------------------------------------- the live run's actual misses
console.log("verify-screen — the mismatches three 'pass' verdicts let through:");
{
  const exp = buildExpectation([
    doc([
      textNode("2:1", "Empty title", "Nothing here yet.", { family: "Poppins", size: 18, weight: "Medium", lineHeight: { value: 22, unit: "px" }, color: "#ffffff" }),
      textNode("2:2", "Empty body", "Add your first item to get started", { family: "Poppins", size: 14, weight: "Regular", color: "#a0a0a0" }),
      { type: "FRAME", id: "2:3", name: "Modal", fills: [{ type: "solid", color: "#121319" }], radius: 12 },
      { type: "FRAME", id: "2:4", name: "Badge", fills: [{ type: "solid", color: "#001d17" }], radius: 100, tokens: { fills: "Success/green BG" } },
    ]),
  ]);
  const rep = compare(exp, measured([
    // the page-title style reused on a heading that is spec'd smaller — the live bug exactly
    { nodeId: "2:1", styles: { fontFamily: "Poppins", fontSize: 20, fontWeight: 600, lineHeight: 30, color: "rgb(255,255,255)" } },
    { nodeId: "2:2", styles: { fontFamily: "Poppins", fontSize: 16, fontWeight: 400, color: "#d4d4d4" } },
    { nodeId: "2:3", styles: { backgroundColor: "#121319", borderRadius: 20 } },
    { nodeId: "2:4", styles: { backgroundColor: "rgba(0,0,0,0)", borderRadius: 100 } },
  ]));
  const at = (id: string, field: string) => rep.deltas.find((d) => d.nodeId === id && d.field === field); // callers guard with !!at(…) first, then read via ?.
  ok("[diff] a heading rendered two sizes up is caught", !!at("2:1", "font-size") && at("2:1", "font-size")?.expected === 18 && at("2:1", "font-size")?.actual === 20);
  ok("[diff] …and so is its weight, because 500 vs 600 is never a rendering artifact", !!at("2:1", "font-weight"));
  ok("[diff] a wrong-but-plausible colour token is caught exactly, with no perceptual slack", !!at("2:2", "color"));
  ok("[diff] radius 20 against a spec of 12 is caught", !!at("2:3", "border-radius"));
  ok("[diff] a chip whose fill was never applied is caught as a transparent background",
    !!at("2:4", "background") && at("2:4", "background")?.actual === "transparent");
  ok("[diff] the mismatch names the TOKEN behind the value, so a reader knows where to look",
    at("2:4", "background")?.token === "Success/green BG");
  ok("[diff] font/colour misses are graded high, geometry medium",
    at("2:1", "font-size")?.severity === "high" && at("2:3", "border-radius")?.severity === "medium");
  ok("[diff] the verdict is FAIL, and it is computed, not asserted", rep.verdict === "fail");
  ok("[diff] and the report says in words why it is not a pass", rep.why.some((w) => /high-severity/.test(w)));
}
{
  // Everything correct, within tolerance. Line-height rounding by a pixel or two is a real browser
  // behaviour and must NOT be reported, or the signal drowns.
  const exp = buildExpectation([doc([textNode("2:1", "T", "Hi", { family: "Poppins", size: 14, weight: "Regular", lineHeight: { value: 21, unit: "px" }, color: "#ffffff" })])]);
  // (opacity: every node that carries copy states opacity 1 — a full probe reports it)
  const rep = compare(exp, measured([{ nodeId: "2:1", styles: { fontFamily: '"Poppins", sans-serif', fontSize: 14, fontWeight: 400, lineHeight: 22, color: "#fff", text: "Hi", opacity: 1 } }]));
  ok("[diff] a 1px line-height difference is within tolerance and is not reported", rep.deltas.length === 0);
  ok("[diff] with nothing wrong and nothing unchecked, the verdict is pass", rep.verdict === "pass");
  ok("[diff] and the report still states exactly how much was checked", rep.coverage.fieldsChecked >= 5);
}

// ---------------------------------------------------------------- text, and the two honest exceptions
console.log("verify-screen — text:");
{
  const exp = buildExpectation([doc([
    textNode("2:1", "Back", "Back to Orders", { family: "Poppins", size: 14 }),
    textNode("2:2", "Header", "NO. of Employees", { family: "Poppins", size: 14 }),
    textNode("2:3", "Empty", "No jet roles\u00a0added yet.", { family: "Poppins", size: 14 }),
  ])]);
  const rep = compare(exp, measured([
    { nodeId: "2:1", styles: { text: "Back to List" } },
    { nodeId: "2:2", styles: { text: "NO. Of Employees" } },
    { nodeId: "2:3", styles: { text: "Nothing here yet." } },
  ]));
  const t = (id: string) => rep.deltas.filter((d) => d.nodeId === id && d.field === "text");
  ok("[text] a copy change is a HIGH-severity delta", t("2:1").length === 1 && must(t("2:1")[0], "t('2:1')[0]").severity === "high");
  ok("[text] a case-only difference is LOW and names text-transform as the likely cause",
    (() => { const d = must(t("2:2")[0], "t('2:2')[0]"); return t("2:2").length === 1 && d.severity === "low" && /text-transform/.test(must(d.note, "t('2:2')[0].note")); })());
  ok("[text] a designed non-breaking space is surfaced rather than silently normalised",
    rep.deltas.some((d) => d.nodeId === "2:3" && /non-breaking space/.test(d.note || "")));
  ok("[text] …and printed as an ESCAPE, so the row is not two identical-looking strings",
    (() => { const d = rep.deltas.find((x) => x.nodeId === "2:3" && /invisible/.test(x.field)); return d !== undefined && /\\u00a0/.test(String(d.expected)) && !/\\u00a0/.test(String(d.actual)); })());
}
{
  // A non-breaking space and a plain space are the same copy, in either direction; only the invisible-character
  // row marks the NBSP, and it marks NBSPs alone — the ordinary spaces in the same string stay spaces.
  const exp = buildExpectation([doc([
    textNode("2:4", "Save", "Save\u00a0changes now", { family: "Poppins", size: 14 }),
    textNode("2:5", "Plain", "Save changes now", { family: "Poppins", size: 14 }),
    textNode("2:6", "Both", "Pay\u00a0now", { family: "Poppins", size: 14 }),
    // a layer named Placeholder is an input placeholder: its copy is compared as placeholderText
    textNode("2:7", "Placeholder", "Search by\u00a0name", { family: "Poppins", size: 14 }),
    textNode("2:8", "Placeholder plain", "Search by name", { family: "Poppins", size: 14 }),
  ])]);
  const rep = compare(exp, measured([
    { nodeId: "2:4", styles: { text: "Save changes now" } },
    { nodeId: "2:6", styles: { text: "Pay\u00a0now" } },
    { nodeId: "2:7", styles: { tag: "input", placeholderText: "Search by name" } },
    { nodeId: "2:8", styles: { tag: "input", placeholderText: "Search by\u00a0name" } },
    { nodeId: "2:5", styles: { text: "Save\u00a0changes now" } },
  ]));
  ok("[text] a designed NBSP matches a built plain space (no text delta)", !rep.deltas.some((d) => d.nodeId === "2:4" && d.field === "text"));
  ok("[text] a designed plain space matches a built NBSP (no text delta)", !rep.deltas.some((d) => d.nodeId === "2:5" && d.field === "text"));
  ok("[text] the invisible-character row escapes the NBSP only, and only for the design that has one",
    (() => {
      const rows = rep.deltas.filter((x) => /invisible/.test(x.field) && (x.nodeId === "2:4" || x.nodeId === "2:5"));
      const d = rows.find((x) => x.nodeId === "2:4");
      return rows.length === 1 && d !== undefined && d.expected === "Save\\u00a0changes now" && d.actual === "Save changes now";
    })());
  const noteOf = (id: string): string => must(rep.deltas.find((x) => x.nodeId === id && /invisible/.test(x.field))?.note, `${id} invisible-character note`);
  ok("[text] a designed NBSP the build carries too stays a low row and says to decide deliberately",
    rep.deltas.some((x) => x.nodeId === "2:6" && /invisible/.test(x.field) && x.severity === "low") && /decide deliberately/.test(noteOf("2:6")) && !/ordinary space/.test(noteOf("2:6")));
  ok("[text] a designed NBSP the build spells as a plain space stays a low row and says the ordinary space is fine unless it was meant to keep the words on one line",
    rep.deltas.some((x) => x.nodeId === "2:4" && /invisible/.test(x.field) && x.severity === "low") && /ordinary space/.test(noteOf("2:4")) && /one line/.test(noteOf("2:4")) && !/decide deliberately/.test(noteOf("2:4")));
  ok("[placeholder] the specs under test carry placeholderText", exp.nodes.filter((s) => s.placeholderText !== undefined).length === 2);
  ok("[placeholder] a designed NBSP matches a built plain space, and the reverse (no placeholder text delta)",
    !rep.deltas.some((d) => (d.nodeId === "2:7" || d.nodeId === "2:8") && d.field === "placeholder text"));
}
{
  // A search hint no layer or token name marks (Figma has no placeholder role: a hint and a typed value are both TEXT) is
  // ordinary text — never guessed from its words. The plan declares it: a deviations[] row with field "placeholder".
  const hint = textNode("2:9", "Search by crate name", "Search by crate name ", { family: "Poppins", size: 14, color: "#938f99" });
  const box: NodeInput = { type: "FRAME", id: "2:10", name: "Search item", children: [hint] };
  const row = { nodeId: "2:9", field: "placeholder", designed: "Search by crate name", built: "<input placeholder>", reason: "the search field's hint" };
  const plan = { file: "design/plan/Checkout__1_1.json", plan: { deviations: [row] } };
  const bare = buildExpectation([doc([box])]);
  const bareSpec = bare.nodes.find((s) => s.nodeId === "2:9");
  ok("[placeholder-plan] without a plan row an unnamed hint stays ordinary text and colour (no guess from its words), and no planPlaceholders",
    bareSpec?.text === "Search by crate name " && bareSpec.color === "#938f99ff" && bareSpec.placeholder === undefined && bare.planPlaceholders === undefined);
  const exp = buildExpectation([doc([box])], { plan });
  const spec = exp.nodes.find((s) => s.nodeId === "2:9");
  ok(`[placeholder-plan] a plan row makes it a placeholder: copy and colour move to placeholderText/placeholderColor, placeholderFrom "plan", no text/colour/width/x (got ${JSON.stringify(spec)})`,
    spec?.placeholder === true && spec.placeholderFrom === "plan" && spec.placeholderText === "Search by crate name " && spec.placeholderColor === "#938f99ff"
    && spec.text === undefined && spec.color === undefined && spec.width === undefined && spec.x === undefined && spec.fontSize === 14);
  ok(`[placeholder-plan] the expectation records which plan, the rows' hash and the node ids (got ${JSON.stringify(exp.planPlaceholders)})`,
    exp.planPlaceholders?.plan === plan.file && JSON.stringify(exp.planPlaceholders.nodeIds) === '["2:9"]' && exp.planPlaceholders.dropped.length === 0
    && /^[0-9a-f]{64}$/.test(exp.planPlaceholders.sha256));
  const named = buildExpectation([doc([box, textNode("2:7", "Placeholder", "Find", { family: "Poppins", size: 14 })])], { plan });
  ok("[placeholder-plan] a layer its name marks stays a placeholder with no placeholderFrom (the plan is not why)",
    named.nodes.find((s) => s.nodeId === "2:7")?.placeholder === true && named.nodes.find((s) => s.nodeId === "2:7")?.placeholderFrom === undefined);
  const badPlan = { file: plan.file, plan: { deviations: [{ ...row, nodeId: "2:10" }, { ...row, nodeId: "9:99" }, { field: "placeholder", designed: "x", built: "y", reason: "z" }, { ...row, field: "control" }] } };
  const bad = buildExpectation([doc([box])], { plan: badPlan });
  const why = (id: string): string => bad.planPlaceholders?.dropped.find((d) => d.nodeId === id)?.why ?? "";
  ok(`[placeholder-plan] a row naming a non-TEXT layer, an unknown id or no id is dropped with why; a "control" row is not a placeholder row (got ${JSON.stringify(bad.planPlaceholders)})`,
    /a FRAME layer, not TEXT/.test(why("2:10")) && /no visible node/.test(why("9:99")) && /names no nodeId/.test(why("(placeholder row #2)"))
    && bad.planPlaceholders?.nodeIds.length === 0 && bad.planPlaceholders.dropped.length === 3 && bad.nodes.find((s) => s.nodeId === "2:9")?.text === "Search by crate name ");
  // compared as a placeholder: the hint's copy matches; a lighter ::placeholder colour (built for contrast) stays a delta
  const rep = compare(exp, measured([{ nodeId: "2:9", styles: { tag: "input", placeholderText: "Search by crate name", placeholderColor: "rgb(185, 180, 192)", fontSize: 14 } }]), { plan: { now: plan } });
  ok("[placeholder-plan] measured on the <input>: the hint's copy matches (no text delta), the different ::placeholder colour is a high delta — never waived",
    !rep.deltas.some((d) => d.nodeId === "2:9" && /text/.test(d.field)) && rep.deltas.some((d) => d.nodeId === "2:9" && d.field === "placeholder colour" && d.severity === "high"));
  const wrong = compare(exp, measured([{ nodeId: "2:9", styles: { tag: "input", placeholderText: "Search", placeholderColor: "rgb(147, 143, 153)" } }]), { plan: { now: plan } });
  ok("[placeholder-plan] a different placeholder copy is a high 'placeholder text' delta",
    wrong.deltas.some((d) => d.nodeId === "2:9" && d.field === "placeholder text" && d.severity === "high"));
}
{
  // Copy that differs only in HTML-collapsible whitespace (spaces, tabs, line breaks) is the same copy as rendered —
  // a LOW row naming which side has more of it, not a HIGH copy delta. The built-in probe reports spaces collapsed and a
  // line break the page shows (a <br>, a newline under white-space pre-line…) as "\n"; a hand-written probe may report
  // a raw run. Another space character (U+3000, U+2009) is not collapsed: a LOW row naming it as an escape.
  const f = { family: "Poppins", size: 14 };
  const exp = buildExpectation([doc([
    textNode("2:9", "Double", "Save  changes", f),
    textNode("2:10", "Break", "Line one\nLine two", f),
    textNode("2:11", "Built break", "Pay now", f),
    textNode("2:12", "Cased", "save  draft", { ...f, case: "upper" }),
    textNode("2:13", "Real change", "Keep  editing", f),
    textNode("2:14", "One break", "Row one\nRow two", f),
    textNode("2:15", "Space at break", "Line one\n Line two", f),
    textNode("2:16", "Case and space", "Send  invite", f),
    textNode("2:17", "Wide built", "Buy now", f),
    textNode("2:18", "Wide designed", "Tokyo\u3000Osaka", f),
    textNode("2:19", "NBSP run", "Pay\u00a0\u00a0now", f),
    textNode("2:20", "Built run", "Pay later", f),
    textNode("2:21", "Kept break", "Part one\nPart two", f),
  ])]);
  const rep = compare(exp, measured([
    { nodeId: "2:9", styles: { text: "Save changes" } },
    { nodeId: "2:10", styles: { text: "Line one Line two" } },
    { nodeId: "2:11", styles: { text: "Pay\nnow" } },
    { nodeId: "2:12", styles: { text: "SAVE DRAFT" } },
    { nodeId: "2:13", styles: { text: "Stop editing" } },
    { nodeId: "2:14", styles: { text: "Row one\n\nRow two" } },
    { nodeId: "2:15", styles: { text: "Line one\nLine two" } },
    { nodeId: "2:16", styles: { text: "send invite" } },
    { nodeId: "2:17", styles: { text: "Buy\u3000now" } },
    { nodeId: "2:18", styles: { text: "Tokyo Osaka" } },
    { nodeId: "2:19", styles: { text: "Pay now" } },
    { nodeId: "2:20", styles: { text: "Pay  later" } },
    { nodeId: "2:21", styles: { text: "Part one\nPart two" } },
  ]));
  const row = (id: string) => rep.deltas.filter((d) => d.nodeId === id && d.field === "text");
  const noteOf = (id: string): string => row(id)[0]?.note || "";
  const lowWith = (id: string, re: RegExp): boolean => { const r = row(id); return r.length === 1 && r[0]?.severity === "low" && re.test(noteOf(id)); };
  ok("[text] a designed double space against a single built space is a LOW row naming the repeated spaces, white-space and &nbsp;",
    lowWith("2:9", /^differs only in whitespace: the design has repeated spaces/) && /pre-wrap/.test(noteOf("2:9")) && /&nbsp;/.test(noteOf("2:9")));
  ok("[text] a designed line break against a built space is a LOW row saying the design has the line break (kept by pre, pre-wrap, pre-line, break-spaces)",
    lowWith("2:10", /the design has 1 line break here and the build no line breaks/) && /pre-line or break-spaces/.test(noteOf("2:10")));
  ok("[text] a build line break (a <br>) the design does not have is a LOW row saying the build has it", lowWith("2:11", /the build has 1 line break here and the design no line breaks/));
  ok("[text] the whitespace rule holds through a text case (UPPER 'save  draft' against 'SAVE DRAFT')", lowWith("2:12", /repeated spaces/));
  ok("[text] a real copy change in a string with a double space stays HIGH",
    row("2:13").length === 1 && row("2:13")[0]?.severity === "high" && !/whitespace/.test(noteOf("2:13")));
  ok("[text] one designed line break against two built ones names the BUILD's extra break, not the design's",
    lowWith("2:14", /the build has 2 line breaks here and the design 1 line break/) && !/the design has/.test(noteOf("2:14")));
  ok("[text] a space beside a designed line break is not 'repeated spaces' (HTML drops it where it keeps the break)",
    lowWith("2:15", /it sits beside a line break or in another order/) && !/repeated spaces/.test(noteOf("2:15")));
  ok("[text] a case change and a double space together are LOW and name both",
    lowWith("2:16", /differs only in case and whitespace/) && /repeated spaces/.test(noteOf("2:16")));
  ok("[text] a built ideographic space against a designed plain space is LOW, naming U+3000 as an escape — never 'HTML collapses it'",
    lowWith("2:17", /differs only in the kind of space: the design has ordinary spaces where the build has \\u3000 \(ideographic space\)/) && !/collapses it to one/.test(noteOf("2:17")));
  ok("[text] a designed ideographic space against a plain built one is the kind of space, not 'repeated spaces'",
    lowWith("2:18", /the design has \\u3000 \(ideographic space\) where the build has ordinary spaces/) && !/repeated spaces/.test(noteOf("2:18")));
  ok("[text] a designed run of non-breaking spaces against one built space is LOW (repeated spaces: the build's gap is narrower), and the NBSP row still shows",
    lowWith("2:19", /repeated spaces/) && rep.deltas.some((d) => d.nodeId === "2:19" && /invisible/.test(d.field)));
  ok("[text] a run only a hand-written probe reports for the build is LOW: it collapses when rendered", lowWith("2:20", /build's text has a run of spaces/));
  ok("[text] a designed line break the build keeps (\\n from the probe) is no text row at all", row("2:21").length === 0);
  // the report's markdown: a text row's cells show the whitespace (\n, · per extra space, escapes for other spaces)
  // and carry the row's advice, and a designed newline cannot split the table row
  const md = reportToMarkdown(rep);
  const line = (id: string): string => md.split("\n").find((l) => l.includes(`\`${id}\``) && /\| text/.test(l)) ?? "";
  ok("[md] a text row's designed double space shows as a · in its cell, so the two cells differ", /\| Save ·changes \| Save changes \|/.test(line("2:9")));
  ok("[md] a designed line break shows as \\n and keeps the row on one table line", /\| Line one\\\\nLine two \| Line one Line two \|/.test(line("2:10")));
  ok("[md] another space character shows as its escape", /\| Buy\\\\u3000now \|/.test(line("2:17")));
  ok("[md] the row carries its advice", /differs only in whitespace: the design has repeated spaces/.test(line("2:9")));
}

{
  // A whitespace-only difference is LOW only when it renders alike: a zero-width no-break space or a non-breaking space the
  // build holds changes what shows (the first merges two words, the second keeps a gap's width); a design's soft line
  // break (U+2028) is a line break; a tab is not any number of spaces. A real copy change is never downgraded to LOW.
  const f = { family: "Poppins", size: 14 };
  const exp = buildExpectation([doc([
    textNode("3:1", "Merged", "log in", f),
    textNode("3:2", "Merged back", "sign\ufeffup", f),
    textNode("3:3", "Wide built", "Pay now", f),
    textNode("3:4", "Cased wide", "Sign In", f),
    textNode("3:5", "Wide designed", "Pay\u00a0\u00a0later", f),
    textNode("3:6", "Soft break", "Line one\u2028Line two", f),
    textNode("3:7", "Soft break, built space", "Part one\u2028Part two", f),
    textNode("3:8", "Paragraph", "Para one\u2029Para two", f),
    textNode("3:9", "Built separator", "Side one Side two", f),
    textNode("3:10", "Designed tab", "Name\tvalue", f),
    textNode("3:11", "Built tab", "Key  value", f),
    textNode("3:12", "Plain copy", "Save", f),
    textNode("3:13", "Designed run", "Gap\u00a0\u00a0here", f),
    textNode("3:14", "Designed single", "One\u00a0two", f),
    textNode("3:15", "Designed spaces", "Hold  there", f),
    textNode("3:16", "Identical", "Fix\u00a0this  now", f),
    textNode("3:17", "Wider build", "Two  here", f),
  ])]);
  const rep = compare(exp, measured([
    { nodeId: "3:1", styles: { text: "log\ufeffin" } },
    { nodeId: "3:2", styles: { text: "sign up" } },
    { nodeId: "3:3", styles: { text: "Pay\u00a0\u00a0now" } },
    { nodeId: "3:4", styles: { text: "SIGN\u00a0\u00a0IN" } },
    { nodeId: "3:5", styles: { text: "Pay\u00a0later" } },
    { nodeId: "3:6", styles: { text: "Line one\nLine two" } },
    { nodeId: "3:7", styles: { text: "Part one Part two" } },
    { nodeId: "3:8", styles: { text: "Para one\nPara two" } },
    { nodeId: "3:9", styles: { text: "Side one\u2028Side two" } },
    { nodeId: "3:10", styles: { text: "Name  value" } },
    { nodeId: "3:11", styles: { text: "Key\tvalue" } },
    { nodeId: "3:12", styles: { text: "Save" } },
    { nodeId: "3:13", styles: { text: "Gap  here" } },
    { nodeId: "3:14", styles: { text: "One two" } },
    { nodeId: "3:15", styles: { text: "Hold\u00a0\u00a0there" } },
    { nodeId: "3:16", styles: { text: "Fix\u00a0this  now" } },
    { nodeId: "3:17", styles: { text: "Two\u00a0\u00a0\u00a0here" } },
  ]));
  const row = (id: string) => rep.deltas.filter((d) => d.nodeId === id && d.field === "text");
  const noteOf = (id: string): string => row(id)[0]?.note || "";
  const sev = (id: string): string => (row(id).length === 1 ? row(id)[0]?.severity ?? "" : `${row(id).length} rows`);
  ok("[text] a zero-width no-break space that merges the built words is HIGH, not 'the kind of space'", sev("3:1") === "high" && !/kind of space/.test(noteOf("3:1")));
  ok("[text] a designed zero-width no-break space against a built space is HIGH too", sev("3:2") === "high" && !/kind of space/.test(noteOf("3:2")));
  ok("[text] a built run of non-breaking spaces against a designed single space is HIGH and names the gap widths, never 'collapses'",
    sev("3:3") === "high" && /width of a gap: the design's is 1 space wide and the build's 2 spaces wide/.test(noteOf("3:3")) && !/collapses it to one/.test(noteOf("3:3")));
  ok("[text] the same through a case change", sev("3:4") === "high" && /width of a gap/.test(noteOf("3:4")));
  ok("[text] a designed non-breaking run against a built single non-breaking space is LOW: the build's gap is narrower", sev("3:5") === "low" && /the design has repeated spaces/.test(noteOf("3:5")));
  ok("[text] a designed soft line break (U+2028) against a built newline is no text row", row("3:6").length === 0);
  ok("[text] a designed soft line break against a built space is the line-break advice, not 'the kind of space'",
    sev("3:7") === "low" && /the design has 1 line break here and the build no line breaks/.test(noteOf("3:7")) && !/kind of space/.test(noteOf("3:7")));
  ok("[text] a designed paragraph separator (U+2029) against a built newline is no text row", row("3:8").length === 0);
  ok("[text] a U+2028 the BUILD carries is still a space character named by its escape", sev("3:9") === "low" && /the build has \\u2028 \(line separator\)/.test(noteOf("3:9")));
  ok("[text] a designed tab against built spaces says it is a tab, not 'another order'",
    sev("3:10") === "low" && /the build has no tabs|the design has 1 tab here and the build no tabs/.test(noteOf("3:10")) && !/another order/.test(noteOf("3:10")));
  ok("[text] a built tab against designed spaces names the build's tab", sev("3:11") === "low" && /the build has 1 tab here and the design no tabs/.test(noteOf("3:11")) && !/another order/.test(noteOf("3:11")));
  ok("[text] identical copy has no text row", row("3:12").length === 0);
  ok("[text] a designed run of non-breaking spaces against built ordinary spaces is LOW (a plain run renders one wide), with the repeated-spaces advice",
    sev("3:13") === "low" && /the design has repeated spaces where the build has fewer/.test(noteOf("3:13")) && /&nbsp;/.test(noteOf("3:13")));
  ok("[text] two designed plain spaces against two built non-breaking spaces render alike: no text row",
    row("3:15").length === 0);
  ok("[text] a designed gap narrower than the build's non-breaking run is HIGH", sev("3:17") === "high" && /the design's is 2 spaces wide and the build's 3 spaces wide/.test(noteOf("3:17")));
  ok("[text] identical copy with a non-breaking space and a plain double space is no text row", row("3:16").length === 0);
  ok("[text] a single designed non-breaking space against a built space is no text row (only the invisible-character row)",
    row("3:14").length === 0 && rep.deltas.some((d) => d.nodeId === "3:14" && /invisible/.test(d.field)));
  const md = reportToMarkdown(rep);
  ok("[md] no raw U+2028 reaches the report", !md.includes("\u2028"));
}
{
  // A layer name, a token, an accepted reason and a non-text value are all text the table prints: a | or a newline in one
  // must not split the row.
  const f = { family: "Poppins", size: 14 };
  const exp = buildExpectation([doc([textNode("4:1", "Pipe | name\nnext", "Copy", f)])]);
  const rep = compare(exp, measured([{ nodeId: "4:1", styles: { text: "Other", fontFamily: "Poppins | Sans" } }]));
  const d = rep.deltas.find((x) => x.nodeId === "4:1");
  if (d) { d.token = "color/a|b"; d.accepted = { reason: "kept | on purpose\nsecond line", decidedBy: "a|b", decidedAt: "2026-10-14" }; d.expected = "x | y"; }
  const lines = reportToMarkdown(rep).split("\n").filter((l) => l.startsWith("| ") && l.includes("`4:1`"));
  const pipes = (l: string): number => (l.match(/(?<!\\)\|/g) || []).length;
  ok(`[md] a | or newline in the layer name, token, accepted reason or a value leaves the row one table line with 8 live pipes (got ${lines.map(pipes).join(",")})`,
    lines.length >= 1 && lines.every((l) => pipes(l) === 8) && lines.some((l) => l.includes("Pipe \\| name next")) && lines.some((l) => l.includes("color/a\\|b")) && lines.some((l) => l.includes("kept \\| on purpose second line")));
}

// ---------------------------------------------------------------- coverage and interactions
console.log("verify-screen — a screen can match every pixel and still be a dead mockup:");
{
  const exp = buildExpectation([doc([
    { type: "INSTANCE", id: "3:1", name: "Date", mainComponent: { name: "Date range", setName: "Date range", setKey: "k1" } },
    { type: "INSTANCE", id: "3:2", name: "View", mainComponent: { name: "Segmented Control", setName: "Segmented Control", setKey: "k2" } },
    { type: "INSTANCE", id: "3:3", name: "Add", mainComponent: { name: "Button", setName: "Button", setKey: "k3" },
      reactions: [{ trigger: "on_click", actions: [{ type: "node", navigation: "overlay", destinationId: "20170:132666" }] }] },
  ])]);
  ok("[cover] the expectation carries every instance and every designed reaction",
    exp.counts.instances === 3 && exp.counts.interactions === 1);

  const rep = compare(exp, measured([], { components: [{ setName: "Button" }], interactions: [] }));
  ok("[cover] instance sets the probe could not point at are named — as TAG COVERAGE, not as 'never built'",
    rep.untaggedInstanceSets.length === 2 && rep.missingComponents === undefined && !rep.why.some((w) => /never built/.test(w)));
  ok("[cover] and each one says how many instances it stands for", must(rep.untaggedInstanceSets[0], "rep.untaggedInstanceSets[0]").instances === 1);
  ok("[cover] a designed interaction nobody exercised is 'not-probed', never silently passed",
    rep.interactions.length === 1 && must(rep.interactions[0], "rep.interactions[0]").result === "not-probed");
  ok("[cover] missing tags alone do not FAIL a screen (a .map() row and a shared shell leave gaps by design)",
    rep.verdict === "incomplete" && rep.summary.componentsAbsent === 0);
  ok("[cover] a component the probe reports ABSENT (present:false) does fail it",
    (() => {
      const r = compare(exp, measured([], { components: [{ setName: "Button" }, { setName: "Date range", present: false, detail: "no date filter in the toolbar" }] }));
      return r.verdict === "fail" && r.componentsAbsent.length === 1 && must(r.componentsAbsent[0], "r.componentsAbsent[0]").setName === "Date range";
    })());
  ok("[cover] and untested interactions alone make it INCOMPLETE rather than a pass",
    (() => {
      const r = compare(exp, measured([], { components: [{ setName: "Date range" }, { setName: "Segmented Control" }, { setName: "Button" }] }));
      return r.verdict === "incomplete" && r.why.some((w) => /not probed/.test(w));
    })());
  ok("[cover] an interaction the probe drove and that failed is a FAIL",
    (() => {
      const r = compare(exp, measured([], {
        components: [{ setName: "Date range" }, { setName: "Segmented Control" }, { setName: "Button" }],
        interactions: [{ nodeId: "3:3", trigger: "on_click", ok: false, detail: "clicking opened nothing" }],
      }));
      const interaction0 = must(r.interactions[0], "r.interactions[0]");
      return r.verdict === "fail" && interaction0.result === "fail" && /opened nothing/.test(must(interaction0.detail, "r.interactions[0].detail"));
    })());
}

// ---------------------------------------------------------------- reaction rows
console.log("verify-screen — a reaction is read as the producer writes it:");
{
  const exp = buildExpectation([doc([
    malformed<NodeInput>({ type: "FRAME", id: "5:1", name: "Open", reactions: [
      { trigger: "ON_HOVER", actions: [{ type: "node", navigation: "overlay", destinationId: "9:9" }, { type: "back" }] },
      { actions: [{ navigation: "navigate", destinationId: "9:8" }] },
      { trigger: "on_press", actions: [{}, { destination: "nowhere" }] },
    ] }),
    // the singular `action` and an object trigger are not the export's shape: no interaction
    malformed<NodeInput>({ type: "FRAME", id: "5:2", name: "Old", reactions: [{ trigger: { type: "on_click" }, action: { type: "node", navigation: "overlay", destinationId: "9:7" } }] }),
    malformed<NodeInput>({ type: "FRAME", id: "5:3", name: "Gone", hidden: true, reactions: [
      { trigger: "on_click", actions: [{ type: "node", destinationId: "9:6" }, {}, { navigation: "swap" }] }, { trigger: "on_hover" }] }),
  ])]);
  const rows = exp.interactions.map((i) => `${i.nodeId}|${i.trigger}|${i.action}|${i.destinationId ?? ""}`);
  ok("[reaction] one row per action that names a type or a navigation; the trigger is lowercased",
    rows.join(" ") === "5:1|on_hover|overlay|9:9 5:1|on_hover|back| 5:1|on_click|navigate|9:8");
  ok("[reaction] a reaction with no trigger reads as on_click", exp.interactions.some((i) => i.destinationId === "9:8" && i.trigger === "on_click"));
  ok("[reaction] a singular `action` / object trigger gives no row", !exp.interactions.some((i) => i.nodeId === "5:2"));
  ok("[reaction] a hidden layer's reactions are counted by the same rule (2 actions name something), never listed",
    exp.counts.hidden.interactionsSkipped === 2 && !exp.interactions.some((i) => i.nodeId === "5:3"));
}

// ---------------------------------------------------------------- a pass must never be a silence
console.log("verify-screen — an unmeasured expectation is not a passed one:");
{
  const exp = buildExpectation([doc([textNode("2:1", "T", "Hi", { family: "Poppins", size: 14, color: "#fff" })])]);
  const rep = compare(exp, measured([]));
  ok("[gaps] a node the probe never measured is reported, not skipped", rep.notMeasured.length === 1);
  ok("[gaps] and it blocks the pass", rep.verdict !== "pass" && rep.why.some((w) => /never measured/.test(w)));
  ok("[gaps] the markdown renders the gaps as gaps in the PROBE, not as clean results",
    /Gaps in the probe, not clean results/.test(reportToMarkdown(rep)));
  ok("[gaps] the report is machine-readable and self-describing",
    rep.schema === "designtwin/verify-report@2" && typeof rep.coverage.fieldsChecked === "number");
  ok("[gaps] the markdown leads with the verdict and what was actually checked",
    /^# Verify/m.test(reportToMarkdown(rep)) && /What was actually checked/.test(reportToMarkdown(rep)));
}

// ---------- CLI: --out is the verify directory; the set is named by the frame's node ----------
// One node, one set: the set's name is `<Layer>__<id>` (the stem a set of the node already has, else the frame's), never
// the input file's basename or a name the caller typed — so no nickname can start a second artefact set.
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-out-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const vdir = path.join(cwd, "design", "verify");
  const put = (rel: string, d: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(d)); return rel; };
  const screen = (name: string) => ({ exportedAt: "2026-09-22T00:00:00.000Z", screen: name, nodes: [{ type: "FRAME", id: "5:6", name, children: [] }] });
  const nick = put("Nick.json", screen("Screen"));
  const r = run("--expect", nick);
  ok("[out-dir] --expect with no --out writes design/verify/<Layer>__<id>.expected.json — the frame's node, not the input file's basename",
    r.status === 0 && fs.existsSync(path.join(vdir, "Screen__5_6.expected.json")) && !fs.existsSync(path.join(vdir, "Nick.expected.json")));
  fs.mkdirSync(path.join(cwd, "elsewhere"));
  const rDir = run("--expect", nick, "--out", "elsewhere");
  ok("[out-dir] --out <an existing directory> writes <dir>/<Layer>__<id>.expected.json", rDir.status === 0 && fs.existsSync(path.join(cwd, "elsewhere", "Screen__5_6.expected.json")));
  const rNew = run("--expect", nick, "--out", "fresh/");
  ok("[out-dir] --out <a new directory>/ (trailing separator) creates it and writes the set there", rNew.status === 0 && fs.existsSync(path.join(cwd, "fresh", "Screen__5_6.expected.json")));
  const rOld = run("--expect", nick, "--out", "design/verify/Screen__5_6");
  ok(`[out-dir] --out <dir>/<the set's own name> (the older spelling) is taken, with a note naming the directory (got ${rOld.status}: ${rOld.stderr.split("\n")[0] ?? ""})`,
    rOld.status === 0 && /^note {2}--out design\/verify\/Screen__5_6 names the set: pass the directory design\/verify$/m.test(rOld.stderr));
  const before = fs.readdirSync(vdir).sort().join(",");
  const rNick = run("--expect", nick, "--out", "design/verify/JetRoles");
  ok(`[out-dir] --out <dir>/<a nickname> → exit 2 naming the set, nothing written (got ${rNick.status})`,
    rNick.status === 2 && /--out takes the verify directory; this set is Screen__5_6/.test(rNick.stderr) && fs.readdirSync(vdir).sort().join(",") === before);
  const rCase = run("--expect", nick, "--out", "design/verify/screen__5_6");
  ok("[out-dir] --out <dir>/<the set's name in another case> → exit 2 (compared case-exactly)", rCase.status === 2 && /this set is Screen__5_6/.test(rCase.stderr));
  const rFile = run("--expect", nick, "--out", nick);
  ok("[out-dir] --out <an existing file> → exit 2", rFile.status === 2 && /--out Nick\.json is a file/.test(rFile.stderr));
  const rForce = run("--expect", nick, "--force");
  ok(`[force] --force → exit 2: one node, one set — a variant or --migrate instead (got ${rForce.status}: ${rForce.stderr.split("\n")[0] ?? ""})`,
    rForce.status === 2 && /^--force is gone: one node, one set — a second set of the node is a variant \(--expect --variant <slug>\); a legacy-named set: verify-screen --migrate$/m.test(rForce.stderr));

  // --compare: the report takes the expectation's set name; --out is a directory
  const expFile = path.join(vdir, "Screen__5_6.expected.json");
  const measuredFile = path.join(cwd, "measured.json");
  fs.writeFileSync(measuredFile, JSON.stringify({ measuredAt: "2026-09-22T00:00:01.000Z", renderer: "test", viewport: { w: 1, h: 1 }, artifacts: [], nodes: [], components: [], interactions: [] }));
  run("--compare", expFile, measuredFile);
  ok("[compare-out] --compare with no --out writes design/verify/<the expectation's set>.report.json", fs.existsSync(path.join(vdir, "Screen__5_6.report.json")));
  run("--compare", expFile, measuredFile, "--out", "elsewhere");
  ok("[compare-out] --compare --out <dir> writes <dir>/<set>.report.json", fs.existsSync(path.join(cwd, "elsewhere", "Screen__5_6.report.json")));
  const cOther = run("--compare", expFile, measuredFile, "--out", "elsewhere/Other");
  ok("[compare-out] --compare --out <dir>/<another name> → exit 2, no report", cOther.status === 2 && /this set is Screen__5_6/.test(cOther.stderr) && !fs.existsSync(path.join(cwd, "elsewhere", "Other.report.json")));
  // an expectation under a legacy name, or named for another node than its frame: refused before anything is compared
  fs.copyFileSync(expFile, path.join(vdir, "Nick.expected.json"));
  const cLegacy = run("--compare", path.join(vdir, "Nick.expected.json"), measuredFile);
  ok(`[compare-name] a legacy-named expectation → exit 2 with --migrate, no report (got ${cLegacy.status}: ${cLegacy.stderr.split("\n")[0] ?? ""})`,
    cLegacy.status === 2 && /is a legacy-named verify set — run verify-screen --migrate/.test(cLegacy.stderr) && !fs.existsSync(path.join(vdir, "Nick.report.json")));
  fs.copyFileSync(expFile, path.join(vdir, "Other__9_9.expected.json"));
  const cNode = run("--compare", path.join(vdir, "Other__9_9.expected.json"), measuredFile);
  ok("[compare-name] an expectation named for node 9:9 whose frame is 5:6 → exit 2, no report",
    cNode.status === 2 && /is named for node 9:9, its frame is 5:6/.test(cNode.stderr) && !fs.existsSync(path.join(vdir, "Other__9_9.report.json")));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ---------- the stem is fixed once a set exists; a legacy-named set of the node is noted, never reused ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-stem-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const vdir = path.join(cwd, "design", "verify");
  fs.mkdirSync(vdir, { recursive: true });
  const screenFile = path.join(cwd, "New__5_6.json");
  fs.writeFileSync(screenFile, JSON.stringify({ exportedAt: "2026-09-22T00:00:00.000Z", screen: "New", nodes: [{ type: "FRAME", id: "5:6", name: "New", children: [] }] }));
  // an older run under a nickname: its expectation + a state screenshot
  fs.writeFileSync(path.join(vdir, "Nick.expected.json"), JSON.stringify({ frame: { nodeId: "5:6" } }));
  fs.writeFileSync(path.join(vdir, "Nick-dialog.png"), "x");
  const r = run("--expect", screenFile);
  ok(`[legacy] a legacy-named set of the node → the <Layer>__<id> set is written (exit 0) and a note names the legacy set and --migrate (got ${r.status}: ${r.stderr.split("\n")[0] ?? ""})`,
    r.status === 0 && fs.existsSync(path.join(vdir, "New__5_6.expected.json")) && /^note {2}legacy-named verify set\(s\) Nick of node 5:6 — verify-screen --migrate renames them to New__5_6$/m.test(r.stderr)
    && fs.existsSync(path.join(vdir, "Nick.expected.json")));
  // the frame renamed in Figma: the set keeps the stem it has
  fs.rmSync(path.join(vdir, "Nick.expected.json"));
  fs.renameSync(path.join(vdir, "New__5_6.expected.json"), path.join(vdir, "Old__5_6.expected.json"));
  const r2 = run("--expect", screenFile);
  ok("[fixed-stem] a set Old__5_6 of the node exists and the frame is now 'New' → --expect writes Old__5_6 again, never New__5_6",
    r2.status === 0 && fs.existsSync(path.join(vdir, "Old__5_6.expected.json")) && !fs.existsSync(path.join(vdir, "New__5_6.expected.json")) && /wrote [^\n]*Old__5_6\.expected\.json/.test(r2.stderr));
  // two grammar-named sets of the node: which one is not ours to guess
  fs.copyFileSync(path.join(vdir, "Old__5_6.expected.json"), path.join(vdir, "New__5_6.expected.json"));
  const r3 = run("--expect", screenFile);
  ok("[fixed-stem] two <Layer>__<id> sets of the node → exit 2 naming both", r3.status === 2 && /node 5:6 has 2 verify sets \(New__5_6, Old__5_6\) — one node, one verify set: keep one/.test(r3.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ---------- --expect --variant <slug>: a second set of the node is a variant, named once ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-variant-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const vdir = path.join(cwd, "design", "verify");
  const screenFile = path.join(cwd, "Screen__5_6.json");
  fs.writeFileSync(screenFile, JSON.stringify({ exportedAt: "2026-09-22T00:00:00.000Z", screen: "Screen", nodes: [{ type: "FRAME", id: "5:6", name: "Screen", children: [] }] }));
  const r = run("--expect", screenFile, "--variant", "w320");
  ok(`[variant] --expect --variant w320 writes design/verify/Screen__5_6.w320.expected.json (got ${r.status}: ${r.stderr.split("\n")[0] ?? ""})`,
    r.status === 0 && fs.existsSync(path.join(vdir, "Screen__5_6.w320.expected.json")) && !fs.existsSync(path.join(vdir, "Screen__5_6.expected.json")));
  const base = run("--expect", screenFile);
  ok("[variant] …the base set beside it is the node's own set (the variant fixes the same stem)", base.status === 0 && fs.existsSync(path.join(vdir, "Screen__5_6.expected.json")));
  const upper = run("--expect", screenFile, "--variant", "W320");
  ok(`[variant] an upper-case slug → exit 2 suggesting the slug (got ${upper.status}: ${upper.stderr.trim()})`, upper.status === 2 && /variant 'W320' is not a slug .* — use 'w320'/.test(upper.stderr));
  const reserved = run("--expect", screenFile, "--variant", "diff");
  ok("[variant] a reserved slug (diff: <set>.diff.png is the base set's diff) → exit 2, nothing written",
    reserved.status === 2 && /variant 'diff' is reserved/.test(reserved.stderr) && !fs.existsSync(path.join(vdir, "Screen__5_6.diff.expected.json")));
  const long = run("--expect", screenFile, "--variant", "a".repeat(33));
  ok("[variant] a 33-character slug → exit 2", long.status === 2 && /is 33 characters long — a slug is at most 32/.test(long.stderr));
  // `<set>-<state>.png`: w320's dialog shot is w320-dialog's screenshot
  const ext = run("--expect", screenFile, "--variant", "w320-dialog");
  ok(`[variant] a slug that extends a live variant of the node by "-" (w320 → w320-dialog) → exit 2 naming it (got ${ext.status}: ${ext.stderr.trim()})`,
    ext.status === 2 && /--variant w320-dialog overlaps the variant Screen__5_6\.w320 of node 5:6 by "-"/.test(ext.stderr) && !fs.existsSync(path.join(vdir, "Screen__5_6.w320-dialog.expected.json")));
  fs.renameSync(path.join(vdir, "Screen__5_6.w320.expected.json"), path.join(vdir, "Screen__5_6.w320-wide.expected.json"));
  const short = run("--expect", screenFile, "--variant", "w320");
  ok("[variant] …and the other way (w320-wide live → w320) → exit 2", short.status === 2 && /--variant w320 overlaps the variant Screen__5_6\.w320-wide/.test(short.stderr));
  const unrelated = run("--expect", screenFile, "--variant", "w3200");
  ok("[variant] a slug that only shares a prefix without \"-\" (w3200) is not an overlap", unrelated.status === 0 && fs.existsSync(path.join(vdir, "Screen__5_6.w3200.expected.json")));
  // --variant names a set once: everywhere else the set's name carries it
  const meas = path.join(cwd, "measured.json");
  fs.writeFileSync(meas, JSON.stringify({ measuredAt: "2026-09-22T00:00:01.000Z", renderer: "test", viewport: { w: 1, h: 1 }, artifacts: [], nodes: [], components: [], interactions: [] }));
  const withCompare = run("--compare", path.join(vdir, "Screen__5_6.w3200.expected.json"), meas, "--variant", "w3200");
  ok("[variant] --variant with --compare → exit 2 (only --expect takes it)", withCompare.status === 2 && /--variant only applies to --expect/.test(withCompare.stderr));
  const cmp = run("--compare", path.join(vdir, "Screen__5_6.w3200.expected.json"), meas);
  ok("[variant] --compare of the variant's expectation writes the variant's report (the set's name carries the slug)",
    (cmp.status === 0 || cmp.status === 1) && fs.existsSync(path.join(vdir, "Screen__5_6.w3200.report.json")));
  const withStatus = run("--status", "Screen__5_6.w3200", "--phase", "starting", "--new-run", "--variant", "w3200");
  ok("[variant] --status takes none of --variant (exit 2)", withStatus.status === 2 && /--status takes none of --variant/.test(withStatus.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ================================================================= regressions from a recorded run
// Every fixture below is the REAL export / probe output of a recorded run, pruned from a
// live-test export, names replaced (the pruned exports gave byte-identical expectations and
// audits to the full ones). The "not N" numbers in the comments are the counts
// a verify-screen.js that kept hidden layers would show on these exact files.
(() => {
  const FX = path.join(import.meta.dirname, "fixtures", "livetest3", "verify");
  const load = <T,>(f: string, guard: DocGuard<T>): T => readFixture(path.join(FX, f), guard);
  const JR_FILE = "positions___7314_87192.json", GP_FILE = "Studio_Configurations__1359_21337.json";
  const jrDoc = load(JR_FILE, isScreenExport), gpDoc = load(GP_FILE, isScreenExport);
  const jrExp = buildExpectation([{ doc: jrDoc, label: "positions___7314_87192" }]);
  const gpExp = buildExpectation([{ doc: gpDoc, label: "Studio_Configurations__1359_21337" }]);
  const jrMeasured = load("JetRoles.measured.json", isVerifyMeasured), gpMeasured = load("GuidedPolicies.measured.json", isVerifyMeasured);
  const clone = <T,>(o: T): T => structuredClone(o);
  // An assertion that THROWS on an older report shape is a failure of that assertion, not of the suite.
  const ok = (name: string, cond: boolean | undefined | (() => unknown)) => { let v: unknown; try { v = typeof cond === "function" ? cond() : cond; } catch (e) { v = false; } return okOuter(name, !!v); };

  // An INDEPENDENT hidden walk — the snippet from the prompt, not visible-tree.ts — so the test does not
  // grade the code with its own predicate.
  const hiddenOf = (doc: ScreenExport) => { const h = new Set<string | undefined>(); (function w(n: { id?: string; hidden?: boolean; children?: ScreenExport["nodes"] }, p: boolean) { const x = p || !!n.hidden; if (x && n.id) h.add(n.id); for (const c of n.children || []) w(c, x); })({ children: doc.nodes }, false); return h; };
  const jrHidden = hiddenOf(jrDoc), gpHidden = hiddenOf(gpDoc);
  const hiddenIn = (arr: Array<{ nodeId: string }>, H: Set<string | undefined>) => arr.filter((x) => H.has(x.nodeId)).length;

  console.log("verify-screen — hidden layers are never specified:");
  // to rule out: hidden specs 83 of 272 · instances 61 of 112 · interactions 22 of 28
  ok("[hidden] Jet Roles: 0 specs, 0 instances, 0 interactions on hidden layers (not 83/272, 61/112, 22/28)",
    () => hiddenIn(jrExp.nodes, jrHidden) === 0 && hiddenIn(jrExp.instances, jrHidden) === 0 && hiddenIn(jrExp.interactions, jrHidden) === 0);
  // to rule out: 75 of 233, 45 of 87, 11 of 12
  ok("[hidden] Guided Policies: 0 / 0 / 0 on hidden layers (not 75/233, 45/87, 11/12)",
    () => hiddenIn(gpExp.nodes, gpHidden) === 0 && hiddenIn(gpExp.instances, gpHidden) === 0 && hiddenIn(gpExp.interactions, gpHidden) === 0);
  ok("[hidden] what was skipped is counted: 61+45 instances and 22+11 interactions — the numbers originally reported",
    () => jrExp.counts.hidden.instancesSkipped === 61 && jrExp.counts.hidden.interactionsSkipped === 22 &&
    gpExp.counts.hidden.instancesSkipped === 45 && gpExp.counts.hidden.interactionsSkipped === 11);
  ok("[hidden] the visible instance list is exactly the frame's visible instances (51 on Jet Roles, 42 on Guided Policies)",
    () => jrExp.instances.length === 51 && gpExp.instances.length === 42);
  ok("[hidden] the expectation lists the hidden ids so --compare can refuse credit for them", () => jrExp.hidden.ids.length === jrHidden.size && gpExp.hidden.ids.length === gpHidden.size);
  ok("[determinism] --expect stays byte-deterministic on the real export",
    () => JSON.stringify(buildExpectation([{ doc: jrDoc, label: "positions___7314_87192" }])) === JSON.stringify(jrExp) && !/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?!\.000Z)/.test(JSON.stringify(jrExp).replace(must(jrDoc.exportedAt, "jrDoc.exportedAt"), "")));

  console.log("verify-screen — --compare filters hidden layers too:");
  const gpRep = compare(gpExp, gpMeasured);
  // The real GP probe drove 4 hidden hovers (4×30 s timeouts → 'fail') and credited 2 hidden popup rows
  // with hovers performed on other controls ('pass').
  ok("[hidden] evidence for hidden layers is ignored and counted, never graded (11 rows on GP)",
    () => gpRep.probe.interactionEvidenceOnHiddenLayers === 11 && gpRep.interactions.length === 1 && gpRep.coverage.interactionsFailed === 0);
  ok("[hidden] a legacy @1 expectation (hidden rows baked in) is refused as evidence, not silently graded",
    () => (() => { const legacy = Object.assign(clone(gpExp), { schema: "designtwin/verify-expectation@1" }); const r = compare(legacy, gpMeasured); return r.verdict !== "pass" && r.why.some((w) => /predates hidden-layer filtering/.test(w)); })());

  console.log("verify-screen — a field the probe names differently is LOUD:");
  const jrRep = compare(jrExp, jrMeasured);
  // to rule out: a JR report with 0 border-radius deltas and nothing saying radius was never checked.
  ok("[radius] the real Jet Roles probe wrote `radius`: the HEADLINE says borderRadius was present on 0 of the nodes that state it",
    /'borderRadius' present on 0 of \d+ nodes that state it \(probe sent 'radius'\)/.test(jrRep.headline) && jrRep.coverage.fieldsNeverMeasured.some((f) => f.field === "borderRadius" && f.measuredOn === 0));
  ok("[radius] …and the unknown key is named with its canonical spelling, not accepted", () => jrRep.probe.unknownKeys.some((k) => k.key === "radius" && k.canonical === "borderRadius"));
  ok("[radius] …and that alone keeps the verdict from passing", () => jrRep.why.some((w) => /field 'borderRadius' was present on 0 of the \d+ measured node/.test(w)));
  const renamed = clone(jrMeasured);
  const asRadius = (r: unknown): MeasuredStyles["borderRadius"] => (typeof r === "number" || typeof r === "string" ? r : Array.isArray(r) && r.every((x) => typeof x === "number") ? r.map(Number) : undefined);
  for (const n of renamed.nodes || []) { if ("radius" in n) { const br = asRadius(n.radius); if (br === undefined) delete n.borderRadius; else n.borderRadius = br; delete n.radius; } }
  const jrRad = compare(jrExp, renamed);
  const rd = (id: string, corner: string) => jrRad.deltas.find((d) => d.nodeId === id && d.field === `border-radius (${corner})`); // callers guard with rd(…) && first, then read via ?.
  ok("[radius] with the canonical key, the four dropped Jet Roles radii are deltas: 20173:142077 tl/tr and 20173:142137 bl/br, 12 → 0",
    () => ["top-left", "top-right"].every((c) => rd("20173:142077", c) && rd("20173:142077", c)?.expected === 12 && rd("20173:142077", c)?.actual === 0) &&
    ["bottom-left", "bottom-right"].every((c) => rd("20173:142137", c) && rd("20173:142137", c)?.expected === 12 && rd("20173:142137", c)?.actual === 0));
  ok("[radius] a bottom-only radius ({bl,br}) is specified at all — not only radius.tl is read",
    () => JSON.stringify(jrExp.nodes.find((n) => n.nodeId === "20173:142137")?.radiusCorners) === JSON.stringify({ tl: 0, tr: 0, br: 12, bl: 12 }));
  ok("[radius] the Guided Policies card that ships 16 where the design says 12 is caught",
    () => gpRep.deltas.some((d) => d.nodeId === "18580:60755" && d.field === "border-radius" && d.expected === 12 && d.actual === 16));

  console.log("verify-screen — positions are compared, frame-relative:");
  // Each row carries the numbers its own case needs (y/height for the pagination bar, textBoxX for the header).
  type Positions = Record<string, { y?: number; height?: number; textBoxX?: number }>;
  const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";
  const pos = load("prefix-positions.json", (x: unknown): x is Positions => isJsonObject(x) && Object.values(x).every((p) => isJsonObject(p) && optNum(p.y) && optNum(p.height) && optNum(p.textBoxX)));
  ok("[xy] FIELDS carries x and y", () => FIELDS.some((f) => f.key === "x") && FIELDS.some((f) => f.key === "y"));
  ok("[xy] the expectation states its coordinate convention", () => /FRAME-RELATIVE/.test(must(jrExp.coordinates, "jrExp.coordinates")) && jrExp.frame.w === 1440 && jrExp.frame.h === 1236);
  {
    const m = clone(jrMeasured);
    const pg = m.nodes?.find((n) => n.nodeId === "20173:142142");
    const posPg = must(pos["20173:142142"], "pos['20173:142142']");
    Object.assign(must(pg, "pg node 20173:142142"), { y: posPg.y, height: posPg.height });
    const r = compare(jrExp, m);
    const place = r.deltas.find((d) => d.nodeId === "20173:142142" && d.field === "placement");
    ok("[xy] Jet Roles on the recorded broken build: the pagination bar is reported OUTSIDE the frame, high severity (bottom edge 1366 > 1236)",
      () => !!place && place.severity === "high" && /y=1366 in a 1236-high frame/.test(String(place.actual)));
    ok("[xy] …and its y is a delta against the design's own position (864)", () => r.deltas.some((d) => d.nodeId === "20173:142142" && d.field === "y (frame-relative)" && d.expected === 864 && d.actual === 1342));
  }
  {
    const m = clone(gpMeasured);
    const st = m.nodes?.find((n) => n.nodeId === "18580:60861");
    const stNode = must(st, "st node 18580:60861");
    must(stNode.styles, "st.styles").textBox = { ...ifDefined("x", must(pos["18580:60861"], "pos['18580:60861']").textBoxX) };
    const r = compare(gpExp, m);
    const d = r.deltas.find((x) => x.nodeId === "18580:60861" && x.field === "x (frame-relative)");
    // (a hug TEXT's x is its box's left edge — 1296, what a Range reports — not the ink start 1296.81)
    ok("[xy] Guided Policies on the recorded broken build: the Status header is +19.75px right of the design (1296 → 1315.75)",
      () => !!d && d.expected === 1296 && d.actual === 1315.75 && d.delta === 19.75);
  }

  console.log("verify-screen — the coverage line closes:");
  for (const [name, rep, m] of [["Jet Roles", jrRep, jrMeasured], ["Guided Policies", gpRep, gpMeasured]] as const) {
    const ids = new Set(m.nodes?.map((n) => String(n.nodeId)));
    ok(`[cover] ${name}: nodesExpected − nodesMeasured == notMeasured.length, one row per node`,
      () => rep.coverage.nodesExpected - rep.coverage.nodesMeasured === rep.notMeasured.length && new Set(rep.notMeasured.map((n) => n.nodeId)).size === rep.notMeasured.length);
    ok(`[cover] ${name}: no id is both 'never measured' and in measured.nodes`, () => rep.notMeasured.every((n) => !ids.has(String(n.nodeId))));
    ok(`[cover] ${name}: the headline leads with nodes measured N/M`, () => rep.headline.includes(`nodes measured ${rep.coverage.nodesMeasured}/${rep.coverage.nodesExpected}`));
    ok(`[cover] ${name}: unmeasured nodes still block the pass`, () => rep.verdict !== "pass" && rep.why.some((w) => /never measured/.test(w)));
  }

  console.log("verify-screen — the token on a delta is the token for THAT field:");
  const hoverRow = jrExp.nodes.find((n) => n.nodeId === "20173:142096");
  ok("[token] the drawn-hover row's background token is Backgrounds/Row Hover, its padding token Space 3 / Space 4",
    () => tokenFor(hoverRow, "backgroundColor") === "Backgrounds/Row Hover" && tokenFor(hoverRow, "padding") === "Space 3 / Space 4");
  {
    // The row measured hovered but NOT repainting (#121319 still): a real background delta, and its
    // token must be the fill's, not "Space 4".
    const m = clone(jrMeasured);
    must(must(m.nodes, "m.nodes").find((n) => n.nodeId === "20173:142096"), "m.nodes '20173:142096'").states = { hover: { backgroundColor: "#121319ff" } };
    const d = compare(jrExp, m).deltas.find((x) => x.nodeId === "20173:142096" && x.field === "background");
    ok("[token] a background delta on 20173:142096 carries token 'Backgrounds/Row Hover', not 'Space 4'", () => !!d && d.token === "Backgrounds/Row Hover" && d.measuredIn === "hover");
  }
  ok("[token] the filter button's gap delta names Rows Spacing", () => jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "gap" && d.token === "Rows Spacing"));

  console.log("verify-screen — 'not probed' is a third state:");
  const addBtnHover = jrRep.interactions.find((i) => i.nodeId === "I20173:137670;72:3440" && i.trigger === "on_hover");
  ok("[interaction] the real `ok:null, \"not measured — … not probed\"` row is not-probed, not fail", addBtnHover && addBtnHover.result === "not-probed");
  ok("[interaction] not-probed rows do not count toward 'designed interaction(s) failed'",
    () => jrRep.coverage.interactionsFailed === jrRep.interactions.filter((i) => i.result === "fail").length && !jrRep.interactions.some((i) => i.result === "fail" && /not probed|not measured/i.test(i.detail || "")));
  // the two genuinely unimplemented interactions must STILL fail.
  ok("[interaction] the two genuinely unimplemented interactions still FAIL (import overlay; row → Jet Role Details)",
    () => jrRep.interactions.some((i) => i.nodeId === "I20173:137670;2006:22479" && i.result === "fail") &&
    ["20173:142081", "20173:142086", "20173:142091"].every((id) => jrRep.interactions.some((i) => i.nodeId === id && i.result === "fail")) && jrRep.verdict === "fail");
  ok("[interaction] ok:true with no selector is not a pass (the evidence rule)",
    () => { const gp0 = must(gpRep.interactions[0], "gpRep.interactions[0]"); return gp0.nodeId === "18580:60879" && gp0.result === "not-probed" && /without evidence/.test(must(gp0.detail, "gpRep.interactions[0].detail")); });
  ok("[interaction] ok:true naming the selector it drove, a match count of 1, an outcome and no navigation is a pass",
    () => (() => { const r = compare(gpExp, gpMeasured, { interactions: [{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="18580:60879"]', selectorCount: 1, detail: "dialog open=1", outcome: "dialog-opened", navEvents: 0 }] }); const r0 = must(r.interactions[0], "r.interactions[0]"); return r0.result === "pass" && r0.selector && r.coverage.interactionsPassed === 1; })());
  ok("[interaction] a selector that matched 0 elements is not a pass",
    () => (() => { const r = compare(gpExp, gpMeasured, { interactions: [{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="1359:21364"]', selectorCount: 0 }] }); return must(r.interactions[0], "r.interactions[0]").result === "not-probed"; })());

  console.log("verify-screen — none of the eight false-positive families is a high delta:");
  // The real GP probe's 4 highs and JR's 2 were all false positives; none is left.
  ok("[fp] the real Guided Policies probe output yields 0 high deltas (not 4)", () => gpRep.summary.high === 0);
  ok("[fp] the real Jet Roles probe output yields 0 high deltas (not 2)", () => jrRep.summary.high === 0);
  // The same probe fed the REAL DOM evidence from the independent Playwright pass.
  // GuidedPolicies.dom.json — the independent Playwright pass's evidence (only the fields read here).
  interface DomBox { tag: string; width: number; height: number; x: number; y: number; backgroundColor: string; color: string; radius: number[]; padding: number[]; svgFill?: string }
  interface DomEvidence { checks: Array<{ designId: string; sel: string; measured: DomBox }>; hoverState: { row: DomBox; editButton: DomBox }; measuredRowGap: number }
  const dom = load("GuidedPolicies.dom.json", (x: unknown): x is DomEvidence => isJsonObject(x) && Array.isArray(x.checks) && isJsonObject(x.hoverState) && typeof x.measuredRowGap === "number");
  const chk = (id: string, selPart?: string) => must(dom.checks.find((c) => c.designId === id && (!selPart || c.sel.includes(selPart))), `a DOM check for ${id}`).measured;
  const S = (m: DomBox) => ({ tag: m.tag, width: m.width, height: m.height, x: m.x, y: m.y, backgroundColor: m.backgroundColor, color: m.color, borderRadius: m.radius, padding: m.padding });
  const gpDom = clone(gpMeasured);
  const domNodes = gpDom.nodes || (gpDom.nodes = []);
  const node = (id: string) => { let n = domNodes.find((x) => x.nodeId === id); if (!n) { n = { nodeId: id, styles: {} }; domNodes.push(n); } return n; };
  const stylesOf = (id: string) => { const n = node(id); return n.styles || (n.styles = {}); };
  // 1. the row drawn hovered — measured hovered
  node("18580:60874").states = { hover: S(dom.hoverState.row) };
  // 2. inline SVG paint — the glyph's computed fill
  Object.assign(stylesOf("20024:144120"), { fill: chk("20024:144120").svgFill });
  // 3. ::placeholder — el.placeholder and the pseudo-element's colour
  Object.assign(stylesOf("I20024:134073;885:2724;880:3726"), { tag: "input", placeholderText: "Search by policy description", placeholderColor: chk("I20024:134073;885:2724;880:3724").svgFill });
  // 4. hover-only control — measured on hover
  node("18580:60880").states = { hover: S(dom.hoverState.editButton) };
  // 6. <table> row gap — the rendered row-to-row distance
  Object.assign(stylesOf("18580:60858"), { gapVisual: dom.measuredRowGap });
  // 8. TEXT id on a <th> — the tag is reported
  Object.assign(stylesOf("18580:60861"), { tag: chk("18580:60861", "th[").tag });
  const domRep = compare(gpExp, gpDom);
  const on = (id: string, re: RegExp) => domRep.deltas.filter((d) => d.nodeId === id && re.test(d.field));
  ok("[fp] 1 drawn-hovered row: no delta when measured hovered (#46464f)", () => on("18580:60874", /background/).length === 0 && gpRep.fieldsNotMeasured.some((f) => f.nodeId === "18580:60874" && /hover/.test(f.why)));
  ok("[fp] 2 inline SVG: compared as `fill`, never against background-color", on("20024:144120", /background|fill/).length === 0 && gpExp.nodes.find((n) => n.nodeId === "20024:144120")?.fill === "#d4d4d4ff");
  ok("[fp] 3 ::placeholder: text and colour compared as placeholder, not as textContent/color",
    () => on("I20024:134073;885:2724;880:3726", /text|colou?r/).length === 0 &&
    !domRep.fieldsNotMeasured.some((f) => f.nodeId === "I20024:134073;885:2724;880:3726" && /placeholder/.test(f.field)) &&
    !domRep.unverifiable.some((f) => f.nodeId === "I20024:134073;885:2724;880:3726") &&
    !gpExp.nodes.find((n) => n.nodeId === "I20024:134073;885:2724;880:3726")?.color);
  ok("[fp] 4 hover-only control at rest: 0×0 is 'measure it hovered', not a size delta; hovered it matches",
    () => gpRep.deltas.filter((d) => d.nodeId === "18580:60880").length === 0 && on("18580:60880", /./).length === 0);
  ok("[fp] 5 auto-layout slack (gap 200 / 146 / 160) is excluded by method, with the reason",
    () => ["18580:60762", "18580:60859", "18580:60863"].every((id) => gpExp.notComparable.some((n) => n.nodeId === id && n.field === "gap")) && on("18580:60762", /gap/).length === 0);
  ok("[fp] 6 table border-spacing: the rendered row gap (8) is compared, not CSS gap (4)", () => on("18580:60858", /gap/).length === 0);
  ok("[fp] 7 radius 500 on a 36px box vs rounded-full (33554400): both are circles — no delta", () => ["18580:60760", "18580:60767", "18580:60774"].every((id) => on(id, /radius/).length === 0));
  ok("[fp] 8 TEXT node id on its <th>: the th's box is not graded as the text's", () => on("18580:60861", /width|height/).length === 0 && gpRep.deltas.filter((d) => d.nodeId === "18580:60861").length === 0);
  ok("[fp] with the real DOM evidence, still no high delta anywhere", () => domRep.summary.high === 0);
  // True positives that must survive — leniency is not the fix.
  ok("[tolerance] the Jet Roles filter button's Rows Spacing gap 8 → 12 and width 110 → 115.83 are still reported",
    () => jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "gap" && d.expected === 8 && d.actual === 12) &&
    jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "width" && d.actual === 115.83));
  ok("[tolerance] 111.83×38 against 110×36 is reported (size tolerance 1, not an inclusive 2)",
    () => gpRep.deltas.some((d) => d.nodeId === "I20024:134073;885:2723" && d.field === "height" && d.expected === 36 && d.actual === 38) &&
    gpRep.deltas.some((d) => d.nodeId === "I20024:134073;885:2723" && d.field === "width" && d.actual === 111.83));
  ok("[tolerance] the content column's extra 24px bottom padding is reported (padding was never read from layout.padding)",
    () => gpRep.deltas.some((d) => d.nodeId === "18580:60747" && d.field === "padding"));
  // verify-only pins (no plugin change beyond audit.js).
  ok("every sidebar nav item (I10970:111588;1910:23337) is still reported 220 → 224",
    () => jrRep.deltas.some((d) => d.nodeId === "I10970:111588;1910:23337" && d.field === "width" && d.expected === 220 && d.actual === 224));
  // the row half was a false positive — the row's 24px child is hidden, and its
  // visible content (16+16+16) is exactly the declared 48. Only the header's contradiction is real.
  ok("the table header's contradiction (box.h vs padding+children) is reported by audit.js's self-inconsistent-geometry; the row (hidden 24px child) is not",
    () => {
      const ares = audit([{ doc: jrDoc, label: "positions___7314_87192" }], { platform: "web" });
      return ares.findings.some((f) => f.code === "self-inconsistent-geometry" && f.nodeId === "20173:142077")
        && !ares.findings.some((f) => f.code === "self-inconsistent-geometry" && f.nodeId === "20173:142081");
    });

  console.log("verify-screen — 'components never built' is gone; tag coverage is named as such:");
  for (const [name, rep] of [["Jet Roles", jrRep], ["Guided Policies", gpRep]] as const) {
    ok(`[components] ${name}: 0 components reported absent (not ${name === "Jet Roles" ? 31 : 52} 'never built'), and no 'never built' reason`,
      rep.summary.componentsAbsent === 0 && rep.missingComponents === undefined && !rep.why.some((w) => /never built/.test(w)));
    ok(`[components] ${name}: the metric is named tag coverage, not presence, and counts visible sets only`,
      () => /tag coverage, not presence/.test(rep.headline) && rep.untaggedInstanceSets.every((s) => s.nodeIds.every((id) => !(name === "Jet Roles" ? jrHidden : gpHidden).has(id))));
  }
  {
    // A shared AppShell tagged with the OTHER frame's instance ids: the real Jet Roles
    // measurement of the sidebar item, fed to Guided Policies.
    const jrItem = jrMeasured.nodes?.find((n) => n.nodeId === "I10970:111588;1910:23337");
    const m = clone(gpMeasured); m.nodes?.push(clone(must(jrItem, "jrItem (I10970:111588;1910:23337)")));
    const r = compare(gpExp, m);
    ok("[components] one implementation, two frames: I10970:111588;1910:23337 counts for I10970:109860;1910:23337 via the component path",
      () => r.coverage.nodesMatchedByComponentPath >= 1 && r.coverage.instanceSetsWithEvidence > gpRep.coverage.instanceSetsWithEvidence);
  }

  {
    // the search field's id spread onto the inner <input> (330x20) instead of the <label>
    // that draws the 380x36 field. The real input measurement, attached to the Text Input frame's id.
    const m = clone(jrMeasured);
    const input = m.nodes?.find((n) => n.nodeId === "I20173:142047;885:2724");
    m.nodes?.push(Object.assign(clone(must(input, "input (I20173:142047;885:2724)")), { nodeId: "I20173:142047;885:2724;880:3724", tag: "input" }));
    const r = compare(jrExp, m);
    ok("[leaf] a FRAME's id on a leaf <input> is not graded as the frame (no size/fill/radius/padding deltas), and says why", () =>
      r.deltas.filter((d) => d.nodeId === "I20173:142047;885:2724;880:3724").length === 0 &&
      r.fieldsNotMeasured.some((f) => f.nodeId === "I20173:142047;885:2724;880:3724" && /leaf <input>/.test(f.why)));
  }

  console.log("verify-screen — text and pseudo-elements:");
  {
    const m = clone(jrMeasured);
    const th = must(m.nodes?.find((n) => n.nodeId === "20173:142078"), "m.nodes '20173:142078'");
    th.text = "Jet Role▲";
    const d = compare(jrExp, m).deltas.find((x) => x.nodeId === "20173:142078" && x.field === "text");
    ok("[text] 'Jet Role▲' (a th with a sort caret) is compared — low, naming the extra glyph, not a copy change", () => !!d && d.severity === "low" && /▲/.test(must(d.note, "d.note")));
    th.text = null;
    ok("[text] text: null from a probe that skips elements with children is a named gap", () => compare(jrExp, m).fieldsNotMeasured.some((f) => f.nodeId === "20173:142078" && /text: null/.test(f.why)));
  }
  ok("[limits] ::placeholder colour with no probe value is 'unverifiable', listed, not a delta", () => gpRep.unverifiable.some((u) => u.nodeId === "I20024:134073;885:2724;880:3726"));
  ok("[limits] the report states the pseudo-element hole and the rotate/transform trap", () => gpRep.limits.some((l) => /::before\/::after/.test(l)) && gpRep.limits.some((l) => /rotate/.test(l)));

  console.log("verify-screen — evidence is tied to its inputs, CLI:");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p2a-verify-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const src = path.join(FX, GP_FILE);
  // (no export index here: the set is named by the frame's own layer name, `Studio Configurations`)
  const GP = "Studio_Configurations__1359_21337";
  const r1 = run("--expect", src, "--out", "design/verify");
  const expFile = path.join(cwd, `design/verify/${GP}.expected.json`);
  const bytes1 = fs.readFileSync(expFile);
  const r2 = run("--expect", src, "--out", "design/verify");
  ok("[cli] --expect prints what it skipped as hidden (45 instances, 11 interactions)", () => /skipped 23 hidden layer\(s\) \(\d+ spec\(s\), 45 instance\(s\), 11 interaction\(s\)\)/.test(r1.stderr));
  ok("[cli] a second identical --expect is byte-identical and says 'unchanged'", () => r2.status === 0 && Buffer.compare(bytes1, fs.readFileSync(expFile)) === 0 && /byte-identical to the expectation on disk \(same export inputs.*says nothing about the build/.test(r2.stderr));
  fs.writeFileSync(path.join(cwd, `design/verify/${GP}.measured.json`), JSON.stringify(Object.assign(clone(gpMeasured), { expectationSha256: "0".repeat(64) })));
  const c1 = run("--compare", expFile, `design/verify/${GP}.measured.json`);
  // The CLI always runs the on-disk artifact check, so its report's artifacts are ArtifactCheck rows.
  const rep1 = readFixture(path.join(cwd, `design/verify/${GP}.report.json`), isVerifyReport);
  ok("[cli] the report records the sha256 of the expectation it was computed on", () => rep1.inputs?.expectationSha256 === crypto.createHash("sha256").update(bytes1).digest("hex"));
  ok("[cli] a measurement taken against a different expectation is called stale", () => (rep1.why || []).some((w) => /DIFFERENT expectation/.test(w)));
  // The CLI always runs the on-disk artifact check, so every artifact row is an ArtifactCheck.
  ok("[cli] artifacts that do not exist on disk are flagged: no screenshot, no pass", () => (rep1.why || []).some((w) => /no screenshot/.test(w)) && (rep1.artifacts || []).every((a) => typeof a === "object" && a.exists === false));
  ok("[cli] the stdout headline is the coverage line", () => c1.status === 1 && /^INCOMPLETE — .*nodes measured \d+\/\d+/m.test(c1.stderr));
  const edited = clone(gpDoc); must(edited.nodes[0], "edited.nodes[0]").children = (must(edited.nodes[0], "edited.nodes[0]").children || []).slice(0, 2);
  fs.writeFileSync(path.join(cwd, "edited.json"), JSON.stringify(edited));
  const r3 = run("--expect", "edited.json", "--out", "design/verify");
  ok("[cli] re-running --expect over a different export says REPLACED and names the now-stale report/measurement",
    () => /REPLACED an existing/.test(r3.stderr) && new RegExp(`${GP}\\.report\\.json`).test(r3.stderr) && /PREVIOUS expectation/.test(r3.stderr));
  ok("…it says the EXPORT changed and keeps the previous bytes as .expected.prev.json", () =>
    /: the export changed \(content sha [0-9a-f]{12}… → [0-9a-f]{12}…\)/.test(r3.stderr) && Buffer.compare(bytes1, fs.readFileSync(path.join(cwd, `design/verify/${GP}.expected.prev.json`))) === 0);
  fs.writeFileSync(path.join(cwd, "ints.json"), JSON.stringify([{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="18580:60879"]', selectorCount: 1, outcome: "dialog-opened", navEvents: 0 }]));
  run("--expect", src, "--out", "design/verify");
  run("--compare", expFile, `design/verify/${GP}.measured.json`, "--interactions", "ints.json");
  ok("[cli] --interactions <file> is the input channel for interaction evidence",
    () => readFixture(path.join(cwd, `design/verify/${GP}.report.json`), isVerifyReport).coverage?.interactionsPassed === 1);
  ok("[cli] --help says there is no browser in --compare", () => /NO browser/.test(run("--help").stdout));
})();


// ---------- wrong-kind inputs are one line + exit 2 (doc-guards.ts) — never compared as `{}` ----------
// A non-object expectation or measurement is not read as an EMPTY document (--compare would grade
// nothing and print a verdict about it).
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-shape-"));
  const put = (name: string, doc: unknown): string => { fs.writeFileSync(path.join(cwd, name), JSON.stringify(doc)); return name; };
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const oneLine = (r: { status: number | null; stderr: string }, re: RegExp): boolean => r.status === 2 && re.test(r.stderr) && !/\n {4}at /.test(r.stderr);
  const exp = put("x.expected.json", buildExpectation([doc([textNode("2:1", "T", "Hi", { family: "Poppins", size: 14 })])]));
  const meas = put("m.json", measured([{ nodeId: "2:1", styles: { fontSize: 14 } }]));
  okOuter("[shape] --compare: an expectation that is a list, not {frame, nodes} -> exit 2, one line",
    oneLine(run("--compare", put("bad.expected.json", [1]), meas), /expectation: 'bad\.expected\.json' is not a verify expectation/));
  okOuter("[shape] --compare: measurements whose artifacts is an object (not a list) -> exit 2, one line",
    oneLine(run("--compare", exp, put("bad-m.json", { nodes: [], artifacts: {} })), /probe measurements: 'bad-m\.json' is not probe measurements/));
  okOuter("[shape] --interactions rows without a nodeId are refused like any other wrong list",
    run("--compare", exp, meas, "--interactions", put("ints.json", [{ trigger: "on_click", ok: true }])).status === 2);
  okOuter("[shape] --expect: a screen argument that is not a screen export -> exit 2, one line",
    oneLine(run("--expect", put("notscreen.json", { nodes: "none" })), /screen export: 'notscreen\.json' is not a screen export/));
  okOuter("[args] `--out --force` is '--out needs a value' (not an artefact set named --force)",
    (() => { const r = run("--expect", put("s.json", { nodes: [{ id: "1:1", type: "FRAME", name: "S" }] }), "--out", "--force"); return r.status === 2 && /verify-screen: --out needs a value/.test(r.stderr); })());
})();

// ---------- --expect says what state the old artefacts are in; a replaced expectation is kept ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-dt45-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const vdir = path.join(cwd, "design", "verify");
  const screen = (fill: string) => ({ exportedAt: "2026-10-07T00:00:00.000Z", screen: "Orders",
    nodes: [{ type: "FRAME", id: "5:6", name: "Orders", box: { x: 0, y: 0, w: 800, h: 600 }, fills: [{ type: "solid", color: fill }], children: [] }] });
  const screenFile = path.join(cwd, "Orders__5_6.json");
  fs.writeFileSync(screenFile, JSON.stringify(screen("#ffffff")));
  const target = path.join(vdir, "Orders__5_6.expected.json"), prevFile = path.join(vdir, "Orders__5_6.expected.prev.json");
  const statusAt = (base: string, phase: string, extra: Record<string, string> = {}): void =>
    fs.writeFileSync(path.join(vdir, base + ".status.json"), JSON.stringify({ schema: "designtwin/verify-status@2", screen: base, runId: "r-7f3a", rev: 4, phase, detail: "", at: new Date().toISOString(), by: "verify-probe", ...extra }));
  const r0 = run("--expect", screenFile);
  const bytes0 = fs.readFileSync(target);
  okOuter("first --expect: no .prev, no status note", r0.status === 0 && !fs.existsSync(prevFile) && !/note {2}the last run/.test(r0.stderr));
  // the last run failed: its measured/report files are partial
  statusAt("Orders__5_6", "failed", { detail: "the probe could not reach the page" });
  const r1 = run("--expect", screenFile);
  okOuter("a failed last run → the note names the run, the phase and its detail",
    /note {2}the last run of Orders__5_6 \(run r-7f3a\) ended at phase failed \(the probe could not reach the page\) — its measured\/report files are partial/.test(r1.stderr));
  okOuter("identical bytes → 'byte-identical … says nothing about the build', and no .prev written",
    /byte-identical to the expectation on disk \(same export inputs/.test(r1.stderr) && /re-measure to check the code/.test(r1.stderr) && !fs.existsSync(prevFile));
  // a probe's own run (no --run) that failed recorded no measured file: nothing beside the expectation is partial. Its
  // ownRun lives only in the LIVE status (the run cache: no package.json here, so the OS temp dir) — never the published one
  const ownLive = liveStatusFile(path.join(vdir, "Orders__5_6"));
  fs.mkdirSync(path.dirname(ownLive), { recursive: true });
  fs.writeFileSync(ownLive, JSON.stringify({ schema: "designtwin/verify-status@2", screen: "Orders__5_6", runId: "r-own", rev: 2, phase: "failed",
    detail: "probe exit 4 — nothing written", at: new Date().toISOString(), by: "verify-probe", ownRun: { pid: 4242, host: "h", startedAt: new Date().toISOString(), deadline: new Date().toISOString() } }));
  const rOwn = run("--expect", screenFile);
  fs.rmSync(path.dirname(ownLive), { recursive: true, force: true }); // the live status goes: the published one below is read again
  okOuter("a failed probe's own run → 'was a probe's own run (no --run) that ended failed (…) — it recorded no measured file', never 'partial'",
    /note {2}the last run of Orders__5_6 \(run r-own\) was a probe's own run \(no --run\) that ended failed \(probe exit 4 — nothing written\) — it recorded no measured file; this expectation is safe to re-measure against/.test(rOwn.stderr)
    && !/are partial/.test(rOwn.stderr));
  statusAt("Orders__5_6", "measuring", { at: new Date(Date.now() - 3_600_000).toISOString() });
  okOuter("a non-terminal phase older than the stall (300 s) → 'never finished'", /the last run of Orders__5_6 \(run r-7f3a\) never finished — still at phase measuring/.test(run("--expect", screenFile).stderr));
  fs.writeFileSync(path.join(vdir, "Orders__5_6.status.json"), JSON.stringify({ phase: "done" }));
  okOuter("a v1 (hand-written) status → 'hand-written status … not checked'", /Orders__5_6\.status\.json is a hand-written status \(no run id\) — not checked/.test(run("--expect", screenFile).stderr));
  statusAt("Orders__5_6", "done");
  okOuter("a done run → no status note", !/note {2}(the last run|a run of)/.test(run("--expect", screenFile).stderr));
  // same export content, different bytes → the generator changed; the old bytes are kept, one generation
  const edited: unknown = JSON.parse(bytes0.toString("utf8"));
  if (isJsonObject(edited)) edited.note = "written by an older verify-screen";
  const olderBytes = JSON.stringify(edited, null, 2) + "\n";
  fs.writeFileSync(target, olderBytes);
  const r2 = run("--expect", screenFile);
  okOuter("same export content → REPLACED … 'the expectation generator changed (verify-screen upgrade)'",
    r2.status === 0 && /REPLACED an existing [^\n]*: same export content — the expectation generator changed \(verify-screen upgrade\); the previous one is kept as [^\n]*Orders__5_6\.expected\.prev\.json/.test(r2.stderr));
  okOuter(".expected.prev.json holds exactly the replaced bytes", fs.readFileSync(prevFile, "utf8") === olderBytes);
  fs.writeFileSync(screenFile, JSON.stringify(screen("#f0f0f0")));
  const r3 = run("--expect", screenFile);
  okOuter("another export → 'the export changed (content sha a… → b…)'; .prev overwritten (one generation) with the last bytes",
    /: the export changed \(content sha [0-9a-f]{12}… → [0-9a-f]{12}…\)/.test(r3.stderr) && Buffer.compare(fs.readFileSync(prevFile), bytes0) === 0);
  // the replaced expectation recorded no export hash (written before exportContentSha256) — say so; never
  // claim "the export changed"
  const noSha: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
  if (isJsonObject(noSha)) { delete noSha.exportContentSha256; noSha.note = "written before the export hash"; }
  fs.writeFileSync(target, JSON.stringify(noSha, null, 2) + "\n");
  const r4 = run("--expect", screenFile);
  okOuter("the replaced expectation recorded no export hash → 'the expectation recorded no export hash … cannot tell whether the export or the expectation generator changed', not 'the export changed'",
    /REPLACED an existing [^\n]*: the expectation recorded no export hash \(exportContentSha256\) — cannot tell whether the export or the expectation generator changed; the previous one is kept/.test(r4.stderr) && !/the export changed/.test(r4.stderr));
  // a .prev is never taken for a live set: with the expectation gone, --expect writes Orders__5_6 again, and no other set is named
  fs.rmSync(target);
  const rPrev = run("--expect", screenFile);
  okOuter("a .expected.prev.json alone is no set: --expect writes Orders__5_6 again, with no legacy-set note",
    rPrev.status === 0 && fs.existsSync(target) && !/legacy-named/.test(rPrev.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ---------- --compare --record-plan — the plan is the one compare chose; none / several → exit 2 first ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-record-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const put = (rel: string, doc: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(doc, null, 4) + "\n"); return rel; };
  const exp = put("design/verify/Orders__1_1.expected.json", buildExpectation([doc([textNode("2:1", "Title", "Orders", { family: "Inter", size: 14 })])]));
  const meas = put("design/verify/Orders__1_1.measured.json", measured([{ nodeId: "2:1", styles: { fontSize: 14, fontFamily: "Inter", text: "Orders" } }]));
  const report = path.join(cwd, "design/verify/Orders__1_1.report.json");
  const none = run("--compare", exp, meas, "--record-plan");
  okOuter("--record-plan with no plan for the frame → exit 2, says so, NO report written",
    none.status === 2 && /--record-plan: no plan in design\/plan\/ describes this frame/.test(none.stderr) && !fs.existsSync(report));
  put("src/Orders.tsx", "export {}\n");
  const planA = { nodeId: "1:1", files: ["src/Orders.tsx"], verification: { coverage: "hand-written" } };
  put("design/plan/Orders__1_1.json", planA);
  put("design/plan/Orders.json", { nodeId: "1:1", files: ["src/Orders.tsx"] });
  const amb = run("--compare", exp, meas, "--record-plan");
  okOuter("two plans of the frame's node, no --plan → exit 2 naming both, NO report written",
    amb.status === 2 && /^error {2}node 1:1 has 2 plans \(design\/plan\/Orders\.json, design\/plan\/Orders__1_1\.json\) — one node, one plan: keep one, or pass --plan/m.test(amb.stderr) && !fs.existsSync(report));
  okOuter("--record-plan outside --compare → exit 2", run("--expect", "x.json", "--record-plan").status === 2);
  fs.rmSync(path.join(cwd, "design/plan/Orders.json"));
  const rec = run("--compare", exp, meas, "--record-plan");
  const rep = fs.existsSync(report) ? readFixture(report, isVerifyReport) : null;
  // recordPlan: until it lands the step-0 stub throws — the report is still written and the error is named
  okOuter("the one plan: report written, then recordPlan is called (recorded, or the stub's error with exit 1)",
    !!rep && (/recorded design\/verify\/Orders__1_1\.report\.json in design\/plan\/Orders__1_1\.json/.test(rec.stderr)
      || (rec.status === 1 && /error {2}--record-plan: .* — design\/verify\/Orders__1_1\.report\.json is written; design\/plan\/Orders__1_1\.json was not updated/.test(rec.stderr))));
  okOuter("[shared-shell] the report hashes planCodeFiles(plan) (files[] + mapped modules)",
    !!rep && JSON.stringify(Object.keys(rep.inputs?.code?.files ?? {})) === JSON.stringify(planCodeFiles(planA)));
  okOuter("a plan whose mapModules are all project files → no 'not hashed' input note", !!rep && !(rep.probe?.inputNotes || []).some((n) => /mapModule path\(s\) not hashed/.test(n)));
  // an alias / package mapModule is named once in the report's input notes (beside the code hashes)
  put("design/plan/Orders__1_1.json", { ...planA, anchors: { "1:2": { mapModule: "@/components/Shell" } }, components: [{ name: "Badge", mapModule: "@acme/ui" }] });
  run("--compare", exp, meas);
  const rep2 = fs.existsSync(report) ? readFixture(report, isVerifyReport) : null;
  const hits = (rep2?.probe?.inputNotes || []).filter((n) => /^design\/plan\/Orders__1_1\.json: mapModule path\(s\) not hashed with this plan's code: @\/components\/Shell, @acme\/ui — /.test(n));
  okOuter(`an alias/package mapModule → ONE input note in the report naming them (got ${hits.length})`, hits.length === 1);
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ---------- [plans] a frame's plans are found by its node id only; several are a data error ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plans-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const put = (rel: string, d: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), typeof d === "string" ? d : JSON.stringify(d, null, 4) + "\n"); return rel; };
  const docs = [doc([textNode("2:1", "Title", "Bins", { family: "Inter", size: 14 })])]; // frame 1:1
  const exp = put("design/verify/Bins__1_1.expected.json", buildExpectation(docs));
  const expSha = crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, exp))).digest("hex");
  const meas = put("design/verify/Bins__1_1.measured.json", measured([{ nodeId: "2:1", styles: { fontSize: 20, fontFamily: "Inter", text: "Bins" } }], { expectationSha256: expSha }));
  const report = path.join(cwd, "design/verify/Bins__1_1.report.json");
  const repOf = (): VerifyReport | null => (fs.existsSync(report) ? readFixture(report, isVerifyReport) : null);
  const codeOf = (): string => { const c = repOf()?.inputs?.code; return c ? `${c.plan} ${Object.keys(c.files).join(",")}` : "none"; };
  put("src/A.tsx", "export {}\n");
  put("src/B.tsx", "export {}\n");
  // a plan whose nodeId names another node (its name carries this frame's id: nodeId wins), and a plan that names no node
  put("design/plan/Bins__1_1.json", { nodeId: "9:9", files: ["src/A.tsx"] });
  put("design/plan/Bins.json", { screen: "Bins__1_1", files: ["src/A.tsx"] });
  const none = run("--compare", exp, meas);
  okOuter(`[plans] a plan's nodeId wins over the id its name carries; a plan named for the frame's set but with no node id describes it not — the note names it (add "nodeId") (got ${codeOf()}: ${none.stderr.split("\n").filter((l) => /plan/.test(l)).join(" | ")})`,
    codeOf() === "none" && /^note {2}no plan in design\/plan\/ describes this frame \(design\/plan\/Bins\.json names no node — add "nodeId"\)/m.test(none.stderr));
  // two plans of node 1:1: one by its nodeId, one by the id its name carries
  fs.rmSync(path.join(cwd, "design/plan/Bins.json"));
  put("design/plan/Bins__1_1.json", { files: ["src/A.tsx"] });
  put("design/plan/Crates_bins.json", { nodeId: "1:1", files: ["src/B.tsx"] });
  fs.rmSync(report);
  const two = run("--compare", exp, meas);
  okOuter(`[plans] two plans of the node at --compare → exit 2 naming both, no report written (got ${two.status}: ${two.stderr.trim()})`,
    two.status === 2 && /^error {2}node 1:1 has 2 plans \(design\/plan\/Bins__1_1\.json, design\/plan\/Crates_bins\.json\) — one node, one plan: keep one, or pass --plan/m.test(two.stderr) && !fs.existsSync(report));
  const flag = run("--compare", exp, meas, "--plan", "design/plan/Crates_bins.json");
  okOuter(`[plans] --plan wins over them: the report is written with that plan's code hashes, and a note names the other (got ${codeOf()})`,
    (flag.status === 0 || flag.status === 1) && codeOf() === "design/plan/Crates_bins.json src/B.tsx"
    && /^note {2}using design\/plan\/Crates_bins\.json \(--plan\); design\/plan\/ also describes node 1:1 in design\/plan\/Bins__1_1\.json$/m.test(flag.stderr));
  // --accept with no --plan and no plan recorded in the report: the two plans of its node are a data error too
  const rep = repOf();
  if (rep) { const { inputs, ...rest } = rep; fs.writeFileSync(report, JSON.stringify({ ...rest, inputs: { exportContentSha256: inputs?.exportContentSha256 } }, null, 2)); }
  const acc = run("--accept", "design/verify/Bins__1_1.report.json", "--node", "2:1", "--field", "font-size", "--reason", "kept", "--by", "owner");
  okOuter(`[plans] --accept: two plans of the report's node → exit 2 naming both (got ${acc.status}: ${acc.stderr.trim()})`,
    acc.status === 2 && /node 1:1 has 2 plans \(design\/plan\/Bins__1_1\.json, design\/plan\/Crates_bins\.json\) — one node, one plan: keep one, or pass --plan/.test(acc.stderr));
  // the report's set names no node (its expectation is of 2:2, its report of 1:1): no plan is guessed, none is written
  fs.rmSync(path.join(cwd, "design/plan/Crates_bins.json"));
  const expDoc = readFixture(path.join(cwd, exp), isVerifyExpectation);
  put(exp, { ...expDoc, frame: { ...expDoc.frame, nodeId: "2:2" } });
  const repNow = readFixture(report, isVerifyReport);
  fs.writeFileSync(report, JSON.stringify({ ...repNow, nodeId: "1:1" }, null, 2));
  const planBefore = fs.readFileSync(path.join(cwd, "design/plan/Bins__1_1.json"), "utf8");
  const clash = run("--accept", "design/verify/Bins__1_1.report.json", "--node", "2:1", "--field", "font-size", "--reason", "kept", "--by", "owner");
  okOuter(`[plans] --accept on a set whose expectation and report name different nodes → refused, no plan written (got ${clash.status}: ${clash.stderr.trim()})`,
    clash.status === 1 && /the set Bins__1_1 names no node/.test(clash.stderr) && fs.readFileSync(path.join(cwd, "design/plan/Bins__1_1.json"), "utf8") === planBefore);
  put("design/plan/Crates_bins.json", { nodeId: "1:1", files: ["src/B.tsx"] });
  // the plan --expect merged interactions from (outside design/plan/) is used at --compare: the code hashes are ITS files
  const mine = { nodeId: "1:1", interactions: [], files: ["src/A.tsx"] };
  put("scratch/mine.json", mine);
  put(exp, buildExpectation(docs, { plan: { file: "scratch/mine.json", plan: mine } }));
  put(meas, measured([{ nodeId: "2:1", styles: { fontSize: 20, fontFamily: "Inter", text: "Bins" } }], { expectationSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, exp))).digest("hex") }));
  const rec = run("--compare", exp, meas);
  okOuter(`[plans] the recorded plan wins at --compare over two plans of the node (a note), and the code hashes come from it (got ${rec.status}, ${codeOf()})`,
    (rec.status === 0 || rec.status === 1) && codeOf() === "scratch/mine.json src/A.tsx" && /note {2}using scratch\/mine\.json \(the plan --expect merged interactions from\); 2 plans in design\/plan\/ describe this frame now/.test(rec.stderr));
  const recRep = repOf();
  okOuter("[plans] …its waivers bind (report.inputs.waivers names it) and the note is a report input note",
    recRep?.inputs?.waivers?.plan === "scratch/mine.json" && (recRep.probe?.inputNotes ?? []).some((n) => n.startsWith("using scratch/mine.json (the plan --expect merged interactions from)")));
  // the recorded plan gone, two plans of the node and no --plan: a data error before anything is compared or written
  fs.rmSync(path.join(cwd, "scratch/mine.json"));
  const repBefore = fs.readFileSync(report, "utf8");
  const goneTwo = run("--compare", exp, meas);
  okOuter(`[plans] the recorded plan gone + two plans of the node → exit 2 naming both, the report untouched (got ${goneTwo.status}: ${goneTwo.stderr.trim()})`,
    goneTwo.status === 2 && /^error {2}node 1:1 has 2 plans \(design\/plan\/Bins__1_1\.json, design\/plan\/Crates_bins\.json\)/m.test(goneTwo.stderr) && fs.readFileSync(report, "utf8") === repBefore);
  // an expectation naming two plans (no --expect writes one): refused the same way
  const expDoc2 = readFixture(path.join(cwd, exp), isVerifyExpectation);
  put(exp, { ...expDoc2, planPlaceholders: { plan: "scratch/other.json", sha256: "0".repeat(64), nodeIds: [], dropped: [] } });
  const twoPlans = run("--compare", exp, meas);
  okOuter(`[plans] an expectation whose interactions and placeholder rows name different plans → exit 2, both named, the report untouched (got ${twoPlans.status}: ${twoPlans.stderr.trim()})`,
    twoPlans.status === 2 && /names two plans — interactions from scratch\/mine\.json, placeholder rows from scratch\/other\.json/.test(twoPlans.stderr) && fs.readFileSync(report, "utf8") === repBefore);
  fs.rmSync(cwd, { recursive: true, force: true });
})();

// ---------- a plan named `<Layer>__<id>` describes the frame whose id it carries — an instance sublayer's too ----------
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plan-stem-"));
  const run = (...a: string[]) => verifyScreen([...a], { cwd });
  const put = (rel: string, doc: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(doc, null, 4) + "\n"); return rel; };
  // a --node pull of a layer inside an instance: its frame id is "I5:2;30:7", its files `<Name>__I5_2_30_7.*`
  const e = buildExpectation([doc([textNode("2:1", "Title", "Chip", { family: "Inter", size: 14 })])]);
  e.frame.nodeId = "I5:2;30:7";
  const exp = put("design/verify/Chip__I5_2_30_7.expected.json", e);
  const meas = put("design/verify/Chip__I5_2_30_7.measured.json", measured([{ nodeId: "2:1", styles: { fontSize: 14, fontFamily: "Inter", text: "Chip" } }]));
  put("src/Chip.tsx", "export {}\n");
  // named for the id only (not the expectation's stem), and no nodeId header: only the id in its name ties it to the frame
  put("design/plan/Chip_copy__I5_2_30_7.json", { files: ["src/Chip.tsx"] });
  const r = run("--compare", exp, meas, "--record-plan");
  okOuter(`the plan whose name carries the instance sublayer's id describes the frame (exit ${r.status}: ${r.stderr.split("\n").filter((l) => /record-plan|plan/.test(l)).slice(0, 2).join(" | ")})`,
    !/no plan in design\/plan\/ describes this frame/.test(r.stderr) && /design\/plan\/Chip_copy__I5_2_30_7\.json/.test(r.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
})();

report();
