// compare value hygiene: what a measured value IS before it is compared. Expectations come from the real
// `buildExpectation` over a plugin-shaped screen export (test/fixtures.ts, invented names); measurements are the shapes probes actually wrote in the field
// ("20px" strings, ["8px",…] radii, `fill` read off an <img>, a -220 gap, a top-level `notFound`).
// The last block runs the shipped probe's in-page function in chromium (skipped locally without one; CI fails).
// Run with:  node test/verify-values.test.ts
import { buildExpectation, compare, reportToMarkdown, radiusCorners } from "../design-to-code/verify-screen.ts";
import type { ExpectInput } from "../design-to-code/verify-screen.ts";
import { measureElements } from "../design-to-code/probe-page.ts";
import type { MeasureInput, MeasureResult } from "../design-to-code/probe-page.ts";
import type { JsonValue, MeasuredNode, MeasuredStyles, VerifyMeasured, VerifyReportV2 } from "../design-to-code/types.ts";
import { malformed, screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const doc = (children: NodeInput[]): ExpectInput => ({
  doc: screenExport([{ type: "FRAME", id: "1:1", name: "Team Directory", box: { x: 0, y: 0, w: 1280, h: 800 }, children }], { exportedAt: "2026-09-30T00:00:00Z", screen: "Team Directory" }),
  label: "Team Directory",
});
const measured = (nodes: MeasuredNode[], extra?: Partial<VerifyMeasured>): VerifyMeasured => ({ measuredAt: "2026-09-30T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, ...extra });
// A hand-written probe's values are whatever JSON it wrote — strings where the type says number.
const loose = (s: Record<string, JsonValue>): MeasuredStyles => malformed<MeasuredStyles>(s);
const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
const deltaOn = (r: VerifyReportV2, id: string, field: RegExp) => r.deltas.find((d) => d.nodeId === id && field.test(d.field));
const gapOn = (r: VerifyReportV2, id: string, field: RegExp) => r.fieldsNotMeasured.find((g) => g.nodeId === id && field.test(g.field));

// ---------------------------------------------------------------- the screen
const title: NodeInput = { type: "TEXT", id: "2:1", name: "Title", text: "Team", font: { family: "Inter", size: 20, weight: "SemiBold", lineHeight: { value: 28, unit: "px" }, letterSpacing: { value: 0.15, unit: "px" }, color: "#1d1d1f" } };
const card: NodeInput = {
  type: "FRAME", id: "2:2", name: "Card", box: { w: 320, h: 120 }, radius: 8, fills: [{ type: "solid", color: "#ffffff" }],
  strokes: { colors: ["#e0e0e0"], weight: 1 }, layout: { display: "flex", flexDirection: "row", gap: 16, padding: [8, 16, 8, 16] },
  children: [{ type: "FRAME", id: "2:21", name: "Avatar", box: { w: 40, h: 40 } }, { type: "FRAME", id: "2:22", name: "Meta", box: { w: 200, h: 40 } }],
};
const icon: NodeInput = { type: "VECTOR", id: "2:3", name: "Chevron", box: { w: 16, h: 16 }, fills: [{ type: "solid", color: "#d4d4d4" }], asset: "assets/chevron.svg" };
const pill: NodeInput = { type: "FRAME", id: "2:4", name: "Status Pill", box: { w: 64, h: 24 }, radius: 12, fills: [{ type: "solid", color: "#e8f5e9" }] };
const exp = buildExpectation([doc([title, card, icon, pill])]);

// ---------------------------------------------------------------- px strings are numbers
console.log("a probe's px strings are the numbers they spell:");
{
  // Every value equals the design; a getComputedStyle-shaped probe wrote them as strings.
  const r = compare(exp, measured([
    { nodeId: "2:1", styles: loose({ fontSize: "20px", fontWeight: "600", lineHeight: "28px", letterSpacing: "0.15px", color: "rgb(29, 29, 31)", fontFamily: "Inter, sans-serif", opacity: "1" }) },
    { nodeId: "2:2", styles: loose({ width: "320px", height: "120px", gap: "16px", padding: ["8px", "16px", "8px", "16px"], borderWidth: "1px", borderColor: "rgb(224, 224, 224)", backgroundColor: "rgb(255, 255, 255)", borderRadius: ["8px", "8px", "8px", "8px"], opacity: "1" }) },
    { nodeId: "2:4", styles: loose({ width: 64, height: 24, backgroundColor: "rgb(232, 245, 233)", borderRadius: "3.35544e+07px", opacity: "1" }) },
  ]));
  safe("'20px', '28px', '0.15px', '16px', '1px' equal to the design → no delta", () => r.deltas.length === 0);
  // 2:1 font-size/weight/line-height/letter-spacing/color/family (6) + 2:2 width/height/gap/padding/border-width/border-colour/background/radius (8) + 2:4 width/height/background/radius (4)
  // + opacity on each (a node that paints or carries copy states opacity 1)
  safe("…and they were compared, not skipped: 21 values checked, none listed as not measured", () => r.fieldsNotMeasured.length === 0 && r.coverage.fieldsChecked === 21);
  safe("a radius list of px strings (['8px',…]) is compared per corner, not 'could not read'", () => !gapOn(r, "2:2", /radius/) && !deltaOn(r, "2:2", /radius/));
  safe("radiusCorners(['8px','8px','8px','8px']) → [8,8,8,8]; '8px 4px' → [8,4,8,4]", () =>
    JSON.stringify(radiusCorners(["8px", "8px", "8px", "8px"])) === "[8,8,8,8]" && JSON.stringify(radiusCorners("8px 4px")) === "[8,4,8,4]");
  safe("a pill's '3.35544e+07px' radius is a circle on a 64×24 box, like the design's 12", () => !gapOn(r, "2:4", /radius/) && !deltaOn(r, "2:4", /radius/));
  safe("a percentage radius is not read as px (a hand-written '50%' used to become 50)", () => radiusCorners("50%") === null && radiusCorners(["50%", "8px", "8px", "8px"]) === null);
  // padding: "16px" strings used to be NaN → comparePadding returned "no mismatch" — a silent pass
  const p = compare(exp, measured([{ nodeId: "2:2", styles: loose({ padding: ["8px", "24px", "8px", "24px"] }) }]));
  safe("padding ['8px','24px',…] against [8,16,8,16] is a mismatch (was a silent pass on NaN)", () => {
    const d = deltaOn(p, "2:2", /^padding$/); return !!d && JSON.stringify(d.actual) === "[8,24,8,24]";
  });

  // A real mismatch in px strings: the delta carries numbers, and the markdown prints the unit once.
  const m = compare(exp, measured([{ nodeId: "2:1", styles: loose({ lineHeight: "24px", fontSize: "18px" }) }]));
  const lh = deltaOn(m, "2:1", /line-height/);
  safe("line-height '24px' vs 28 → one delta with actual 24 (a number), delta 4", () => !!lh && lh.actual === 24 && lh.delta === 4);
  const md = reportToMarkdown(m);
  safe("report.md prints '24px', never '24pxpx'", () => /\| 24px \|/.test(md) && !/pxpx/.test(md));
  // A delta whose actual still holds a unit (an older report, an in-process caller)
  const legacy = { ...m, deltas: [{ severity: "medium" as const, nodeId: "2:1", name: "Title", field: "line-height", expected: 28, actual: "28px", unit: "px", delta: null }] };
  safe("a delta whose actual is already '28px' renders '28px', not '28pxpx'", () => { const t = reportToMarkdown(legacy); return /\| 28px \| 28px \|/.test(t) && !/pxpx/.test(t); });

  // Keywords and other units are not px values: listed as not measured with the value, never a string delta.
  const k = compare(exp, measured([
    { nodeId: "2:1", styles: loose({ lineHeight: "normal", letterSpacing: "normal", fontSize: "1.25rem" }) },
    { nodeId: "2:2", styles: loose({ gap: "[object Object]", width: "20%" }) },
  ]));
  safe("line-height 'normal' → not measured (its px depends on the font), no delta", () => !!gapOn(k, "2:1", /line-height/) && !deltaOn(k, "2:1", /line-height/));
  safe("letter-spacing 'normal' is 0 (CSS: no extra spacing) → compared against 0.15, within the 0.2 tolerance", () => !gapOn(k, "2:1", /letter-spacing/) && !deltaOn(k, "2:1", /letter-spacing/));
  const g = compare(exp, measured([{ nodeId: "2:2", styles: loose({ gap: "normal", display: "flex" }) }]));
  safe("gap 'normal' on a display:flex element is 0 → a real delta against 16", () => deltaOn(g, "2:2", /^gap$/)?.actual === 0);
  const gn = compare(exp, measured([{ nodeId: "2:2", styles: loose({ gap: "normal" }) }]));
  safe("gap 'normal' with no display → not measured (block layout has no gap), no delta", () => /not applicable in block layout/.test(gapOn(gn, "2:2", /^gap$/)?.why ?? "") && !deltaOn(gn, "2:2", /^gap$/));
  const gi = compare(exp, measured([{ nodeId: "2:2", styles: loose({ gap: "normal", display: "inline-flex" }) }]));
  safe("gap 'normal' on inline-flex is 0 too", () => deltaOn(gi, "2:2", /^gap$/)?.actual === 0);
  // a font-weight the normaliser cannot read is neither 'cannot be known → no mismatch' nor counted as checked
  const fw = compare(exp, measured([{ nodeId: "2:1", styles: loose({ fontWeight: "bolder" }) }, { nodeId: "2:2", styles: loose({ width: 320 }) }]));
  safe("fontWeight 'bolder' → not measured (quoted), not a silent pass", () => /bolder/.test(gapOn(fw, "2:1", /font-weight/)?.why ?? "") && !deltaOn(fw, "2:1", /font-weight/) && fw.coverage.fieldsChecked === 1);
  // a null inside a list is the probe saying it could not read one side — reported null
  const nl = compare(exp, measured([{ nodeId: "2:2", styles: loose({ borderRadius: [8, null, 8, 8], padding: [8, null, 8, 16] }), unmeasured: { borderRadius: "one corner unreadable", padding: "one side unreadable" } }]));
  safe("[8,null,8,8] radius / padding → reported null with the probe's reason", () => gapOn(nl, "2:2", /radius/)?.why === "one corner unreadable" && gapOn(nl, "2:2", /^padding$/)?.why === "one side unreadable");
  // an object where a colour belongs is not measured (it is never read as "[object object]" → a high)
  const oc = compare(exp, measured([{ nodeId: "2:1", styles: loose({ color: {}, fontFamily: { family: "Inter" } }) }]));
  safe("color {} / fontFamily {} → not measured, no delta", () => !!gapOn(oc, "2:1", /^color$/) && !!gapOn(oc, "2:1", /font-family/) && oc.deltas.length === 0);
  // the producer writes letter-spacing unit "percent" (lower case) — a share of the font size
  const pe = buildExpectation([doc([{ ...title, font: { family: "Inter", size: 20, letterSpacing: { value: -2, unit: "percent" } } }])]);
  safe("-2 percent on 20px text expects -0.4px (was -2)", () => pe.nodes.find((n) => n.nodeId === "2:1")?.letterSpacing === -0.4);
  safe("…so a build measuring '-0.4px' has no letter-spacing delta", () => !deltaOn(compare(pe, measured([{ nodeId: "2:1", styles: loose({ letterSpacing: "-0.4px" }) }])), "2:1", /letter-spacing/));
  // negative x/y and letter-spacing are legitimate values and are still compared
  const neg = compare(buildExpectation([doc([{ ...title, font: { family: "Inter", size: 20, letterSpacing: { value: -0.5, unit: "px" } } }])]), measured([{ nodeId: "2:1", styles: loose({ letterSpacing: "-1.5px" }) }]));
  safe("a negative letter-spacing ('-1.5px' vs -0.5) is compared, not called impossible", () => deltaOn(neg, "2:1", /letter-spacing/)?.actual === -1.5);
  safe("'1.25rem', '20%', '[object Object]' → not measured with the value quoted, no string delta", () =>
    /1\.25rem/.test(gapOn(k, "2:1", /font-size/)?.why ?? "") && /20%/.test(gapOn(k, "2:2", /^width$/)?.why ?? "") && /object Object/.test(gapOn(k, "2:2", /^gap$/)?.why ?? "") && k.deltas.length === 0);
}

// ---------------------------------------------------------------- values CSS cannot produce
console.log("a value CSS cannot produce is an artefact, not a mismatch:");
{
  const r = compare(exp, measured([
    { nodeId: "2:2", styles: { width: 320, height: 120, gap: -220, padding: [8, 16, 8, 16] } },
    { nodeId: "2:4", styles: { width: 64, height: 24, borderRadius: -4 } },
  ]));
  safe("gap -220 on a 320×120 card → not measured ('impossible'), no '16 vs -220' delta", () => /impossible/.test(gapOn(r, "2:2", /^gap$/)?.why ?? "") && !deltaOn(r, "2:2", /^gap$/));
  safe("a negative radius → not measured, no delta", () => /impossible/.test(gapOn(r, "2:4", /radius/)?.why ?? "") && !deltaOn(r, "2:4", /radius/));
  const big = compare(exp, measured([{ nodeId: "2:2", styles: { width: 320, height: 120, gapVisual: 1360 } }]));
  safe("a gap (gapVisual) of 1360 on a 320×120 element → not measured ('larger than the element')", () => /larger than the element/.test(gapOn(big, "2:2", /^gap$/)?.why ?? "") && !deltaOn(big, "2:2", /^gap$/));
  const neg = compare(exp, measured([{ nodeId: "2:2", styles: { gapVisual: -1360 } }]));
  safe("gapVisual -1360 → not measured", () => /impossible/.test(gapOn(neg, "2:2", /^gap$/)?.why ?? "") && !deltaOn(neg, "2:2", /^gap$/));
  const pad = compare(exp, measured([{ nodeId: "2:2", styles: { padding: [8, -16, 8, 16] } }]));
  safe("negative padding → not measured, no delta", () => /impossible/.test(gapOn(pad, "2:2", /^padding$/)?.why ?? "") && !deltaOn(pad, "2:2", /^padding$/));
  // a COMPUTED gap is a real CSS value — only a rendered distance (gapVisual) is bounded by the box
  const css = compare(exp, measured([{ nodeId: "2:2", styles: loose({ width: 32, height: 32, gap: 40, display: "flex" }) }]));
  safe("computed gap 40 on a 32×32 flex element is a real delta, not an 'artefact'", () => deltaOn(css, "2:2", /^gap$/)?.actual === 40);
  // a design with a NEGATIVE gap (overlapping avatars) may render as a negative distance
  const over = compare(buildExpectation([doc([{ ...card, id: "2:9", layout: { display: "flex", flexDirection: "row", gap: -8 } }])]), measured([{ nodeId: "2:9", styles: { gap: -8 } }]));
  safe("design gap -8, measured -8 → compared (no delta), not 'impossible'", () => !gapOn(over, "2:9", /^gap$/) && !deltaOn(over, "2:9", /^gap$/) && over.coverage.fieldsChecked >= 1);
  // a <button> sends gap 10 AND an artefact gapVisual -13 — the readable CSS gap is compared
  const both = compare(exp, measured([{ nodeId: "2:2", styles: { width: 320, height: 120, gap: 40, gapVisual: -13, tag: "button" } }]));
  safe("gapVisual -13 is an artefact, so the computed gap 40 is compared → a 16 vs 40 delta", () => deltaOn(both, "2:2", /^gap$/)?.actual === 40 && !gapOn(both, "2:2", /^gap$/));
  const ok = compare(exp, measured([{ nodeId: "2:2", styles: { width: 320, height: 120, gap: 24 } }]));
  safe("a plausible wrong gap (24 vs 16) is still a delta — the rule only drops impossible values", () => deltaOn(ok, "2:2", /^gap$/)?.actual === 24);
}

// ---------------------------------------------------------------- an <img> icon's fill
console.log("an icon drawn by an <img> has no readable fill:");
{
  // the shipped probe: fill null + fillSource "img" (probe-page.ts), on a spec whose export has an .svg asset
  const shipped = compare(exp, measured([{ nodeId: "2:3", matchedBy: "tag", styles: { width: 16, height: 16, fill: null, tag: "img", opacity: 1 }, unmeasured: { fill: "an <img>: its paint is pixels, not a CSS property" }, fillSource: "img" }]));
  safe("shipped probe: <img> fill → unverifiable (method limit), not a field gap", () =>
    shipped.unverifiable.some((u) => u.nodeId === "2:3" && /fill/.test(u.field)) && !gapOn(shipped, "2:3", /fill/));
  safe("…and 'fill' is not NEVER MEASURED in the headline or the census", () => !/NEVER MEASURED/.test(shipped.headline) && !shipped.coverage.fieldsNeverMeasured.some((f) => f.field === "fill"));
  // a hand-written probe read `fill` off the <img> itself: the inherited default, black
  const black = compare(exp, measured([{ nodeId: "2:3", styles: { width: 16, height: 16, fill: "rgb(0, 0, 0)", tag: "img" } }]));
  safe("hand-written: <img> read as rgb(0,0,0) → no false high, listed unverifiable", () =>
    !deltaOn(black, "2:3", /fill/) && black.unverifiable.some((u) => u.nodeId === "2:3") && black.verdict !== "fail");
  const svg = compare(exp, measured([{ nodeId: "2:3", styles: { width: 16, height: 16, fill: "rgb(0, 0, 0)", tag: "svg" } }]));
  // the shipped probe on a wrapper that holds an <img> (probe-page.ts fill(): an element with <img> and no <svg>)
  const wrap = compare(exp, measured([{ nodeId: "2:3", matchedBy: "tag", styles: { width: 16, height: 16, fill: null, tag: "span" }, unmeasured: { fill: "an <img>: its paint is pixels, not a CSS property" }, fillSource: "img" }]));
  safe("a <span> around an <img> (fillSource 'img') → unverifiable too, not a field gap", () => wrap.unverifiable.some((u) => u.nodeId === "2:3" && /<img>/.test(u.why)) && !gapOn(wrap, "2:3", /fill/));
  safe("an inline <svg> whose paint IS wrong is still a high", () => deltaOn(svg, "2:3", /fill/)?.severity === "high");
  safe("the report's limits say why", () => shipped.limits?.some((l) => /<img>/.test(l)) === true);
  safe("the headline counts it (not a verdict reason, never silent)", () => /1 value\(s\) unverifiable by method/.test(shipped.headline));
}

// ---------------------------------------------------------------- the NEVER MEASURED denominator
console.log("NEVER MEASURED counts the nodes that state the field:");
{
  // Only the Status Pill states `borderWidth`; 40 other measured nodes carry none of it. Before: "present in 0 of 41 measurements".
  // (`opacity` is not the example: every node that paints or carries copy states it)
  const rows: NodeInput[] = Array.from({ length: 40 }, (_, i): NodeInput => ({ type: "TEXT", id: `3:${i + 1}`, name: `Name ${i + 1}`, text: `Person ${i + 1}`, font: { family: "Inter", size: 14 } }));
  const e2 = buildExpectation([doc([...rows, { ...pill, strokes: { colors: ["#2e7d32"], weight: 1 } }])]);
  // (the other nodes DO send borderWidth — like a probe whose nodes all sent y; their specs just do not state it)
  const r = compare(e2, measured([...rows.map((n): MeasuredNode => ({ nodeId: n.id, styles: { fontFamily: "Inter", fontSize: 14, opacity: 1, borderWidth: 0, text: n.text ?? "" } })), { nodeId: "2:4", styles: { width: 64, height: 24, backgroundColor: "rgb(232, 245, 233)", borderColor: "rgb(46, 125, 50)", borderRadius: 12, opacity: 1 } }]));
  const nm = r.coverage.fieldsNeverMeasured.find((f) => f.field === "borderWidth");
  safe("the census keeps it: borderWidth expectedOn 1, measuredOn 0", () => nm?.expectedOn === 1 && nm.measuredOn === 0);
  safe("the reason says '0 of the 1 measured node(s) whose spec states it', never '0 of 41'", () => r.why.some((w) => /0 of the 1 measured node/.test(w)) && !r.why.some((w) => /0 of 41/.test(w)));
  safe("one node's gap does not take the headline's NEVER MEASURED slot", () => !/NEVER MEASURED/.test(r.headline) && !!gapOn(r, "2:4", /border-width/));
  // a field the probe got wrong everywhere still leads the headline, with the right denominator
  const all = compare(e2, measured(rows.map((n): MeasuredNode => ({ nodeId: n.id, styles: loose({ fontFamily: "Inter", size: 14, text: n.text ?? "" }) }))));
  safe("'fontSize' missing on all 40 TEXT nodes → headline 'present on 0 of 40 nodes that state it'", () => /NEVER MEASURED: 'fontSize' present on 0 of 40 nodes that state it/.test(all.headline));
  // a key NO measured node carries is systemic even when one spec states it (`fill` missing from the probe)
  const e3 = buildExpectation([doc([...rows, icon])]);
  const nofill = compare(e3, measured([...rows.map((n): MeasuredNode => ({ nodeId: n.id, styles: { fontFamily: "Inter", fontSize: 14, opacity: 1, text: n.text ?? "" } })), { nodeId: "2:3", styles: { width: 16, height: 16, tag: "svg", opacity: 1 } }]));
  safe("'fill' absent from every measured node, stated by 1 → still in the headline", () => /NEVER MEASURED: 'fill' present on 0 of 1 nodes that state it/.test(nofill.headline));
  const hinted = compare(e2, measured([...rows.map((n): MeasuredNode => ({ nodeId: n.id, styles: { fontFamily: "Inter", fontSize: 14, opacity: 1, borderWidth: 0, text: n.text ?? "" } })), { nodeId: "2:4", styles: loose({ width: 64, height: 24, backgroundColor: "rgb(232, 245, 233)", borderColor: "rgb(46, 125, 50)", radius: 12, opacity: 1 }) }]));
  safe("a one-node field the probe sent under another name (radius) still reaches the headline", () => /NEVER MEASURED: 'borderRadius' present on 0 of 1 nodes that state it \(probe sent 'radius'\)/.test(hinted.headline));
}

// ---------------------------------------------------------------- top-level keys
console.log("top-level keys verify-screen does not read are listed:");
{
  const m = malformed<VerifyMeasured>({ ...measured([{ nodeId: "2:1", styles: { fontSize: 20 } }]), notFound: ["2:2", "2:3"], extra: { hoverReloads: 1 }, notMeasured: [{ nodeId: "2:4", why: "no element with this text" }] });
  const r = compare(exp, m);
  const keys = (r.probe?.unknownTopLevelKeys ?? []).map((k) => k.key).sort();
  safe("measured with top-level `notFound` and `extra` → report.probe.unknownTopLevelKeys lists both", () => JSON.stringify(keys) === JSON.stringify(["extra", "notFound"]));
  safe("…`notFound` names its canonical key `notMeasured`", () => r.probe?.unknownTopLevelKeys?.find((k) => k.key === "notFound")?.canonical === "notMeasured");
  safe("every key the shipped probe writes is known (none listed)", () => {
    // every top-level key verify-probe.ts writes (its measured object + `notes`), whatever their values
    const shippedTop = measured([], { artifacts: ["design/verify/TeamDirectory.png"], expectationSha256: "0".repeat(64), notMeasured: [], components: [], matchedByCensus: { tag: 0 }, frames: [], navigation: { events: [], afterInitialLoad: 0, reruns: 0 }, notes: ["measured at 1280x800"] });
    return (compare(exp, shippedTop).probe?.unknownTopLevelKeys ?? []).length === 0;
  });
  safe("the canonical notMeasured reason is used for the unmatched spec", () => r.notMeasured.find((n) => n.nodeId === "2:4")?.why === "no element with this text");
  safe("report.md names the unread top-level keys", () => /top-level key `notFound` is not read by verify-screen — the canonical key is `notMeasured`/.test(reportToMarkdown(r)));
}

// ---------------------------------------------------------------- the shipped probe (real chromium)
console.log("the shipped probe drops impossible gaps (chromium):");
{
  const CI = process.env.CI === "true";
  const pw = await import("playwright").catch(() => null); // not installed → skipped (locally)
  // no LAUNCH_ARGS (--disable-lcd-text): these checks read geometry only, never rendered text pixels
  const browser = pw ? await pw.chromium.launch().catch(() => null) : null;
  if (!browser) {
    // the runner's marker (test/run-suites.ts): a local run lists this suite as skipped, not as a plain pass
    if (!CI) console.log("SKIPPED (no playwright: chromium unavailable — the probe checks did not run)");
    check(`[probe] chromium unavailable — ${CI ? "CI must run this" : "SKIPPED locally"}`, !CI);
  } else {
    try {
      const page = await browser.newPage();
      await page.setContent(`<body style="margin:0">
        <div id="pct" style="display:flex;gap:10%;width:400px"><i style="width:10px;height:10px"></i><i style="width:10px;height:10px"></i></div>
        <table id="side"><tr><td><table id="inner" style="border-spacing:0 10px"><tr style="height:40px"><td>a</td></tr><tr style="height:40px"><td>b</td></tr></table></td><td>c</td></tr><tr><td>d</td><td>e</td></tr></table>
        <table id="rows" style="border-spacing:0 8px"><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table>
        <table id="flat"><tbody style="display:flex"><tr style="display:block;width:80px;height:40px"><td>x</td></tr><tr style="display:block;width:80px;height:40px"><td>y</td></tr></tbody></table>
      </body>`);
      const item = (nodeId: string, sel: string) => ({ nodeId, path: sel, isText: false, isPaint: false, isPlaceholder: false, sharesWith: null });
      const input: MeasureInput = { frameRect: { x: 0, y: 0, w: 1280, h: 800 }, keys: ["gap", "gapVisual"], items: [item("9:1", "#pct"), item("9:2", "#side"), item("9:3", "#rows"), item("9:4", "#flat")] };
      const out: MeasureResult[] = await page.evaluate(measureElements, input);
      const [pct, side, rows, flat] = out;
      check("[probe] a percentage gap is null with a reason, not 10 (px)", pct?.styles.gap === null && /percentage/.test(pct.unmeasured.gap ?? ""));
      check("[probe] a nested table's rows are not this table's: gapVisual is the outer rows' spacing (2, the default border-spacing)", side?.styles.gapVisual === 2);
      check("[probe] rows laid out side by side → gapVisual null ('not stacked'), not a negative number", flat?.styles.gapVisual === null && /not stacked/.test(flat.unmeasured.gapVisual ?? ""));
      check("[probe] a real table's row spacing is still measured (8)", rows?.styles.gapVisual === 8);
    } finally { await browser.close(); }
  }
}

report();
