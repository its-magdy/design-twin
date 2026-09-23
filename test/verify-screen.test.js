// Offline tests for design-to-code/verify-screen.js — the per-node comparison behind a "pass".
//
// Every fixture is a miniature of something three verification passes called "pass" on the live run
// while an independent measurement pass found it wrong: a heading rendered at the page-title style,
// a body at 16px/#d4d4d4 where the export says 14px/#a0a0a0, a chip whose fill token was never
// applied, a modal at radius 20 against a spec of 12, two toolbar components never built, and a set
// of designed interactions nobody exercised.
// Run with:  node test/verify-screen.test.js
const { buildExpectation, compare, reportToMarkdown, normColor, normWeight, normFamily, lineHeightPx } = require("../design-to-code/verify-screen.js");
const { ok, report } = require("./assert");
const okOuter = ok;

const doc = (children, extra) => ({
  doc: Object.assign({ exportedAt: "2026-09-22T00:00:00Z", screen: "Checkout", nodes: [{ type: "FRAME", id: "1:1", name: "Checkout", children }] }, extra),
  label: "Checkout",
});
const textNode = (id, name, text, font, fills) => ({ type: "TEXT", id, name, text, font, fills });
const measured = (nodes, extra) => Object.assign({ measuredAt: "2026-09-22T01:00:00Z", renderer: "playwright-chromium", viewport: "1440x1236", nodes }, extra);

// ---------------------------------------------------------------- normalisation
console.log("verify-screen — normalising what Figma and CSS each call the same thing:");
ok("[norm] #fff and #ffffffff are the same colour", normColor("#fff") === normColor("#ffffffff"));
ok("[norm] rgb() is compared as hex", normColor("rgb(29, 29, 31)") === "#1d1d1fff");
ok("[norm] a fully transparent background is 'no background', whatever its channels", normColor("rgba(0, 0, 0, 0)") === "transparent");
ok("[norm] Figma's 'SemiBold' and CSS's 600 are the same weight", normWeight("SemiBold") === 600 && normWeight(600) === 600);
ok("[norm] 'Medium' is 500, which is what makes 500-vs-600 a real mismatch", normWeight("Medium") === 500);
ok("[norm] a CSS font stack compares on its FIRST family", normFamily('"Poppins", ui-sans-serif, system-ui') === "poppins");
ok("[norm] a percentage line-height resolves against the font size", lineHeightPx({ value: 150, unit: "PERCENT" }, 16) === 24);
ok("[norm] line-height 'normal' is unknowable, not a mismatch", lineHeightPx("normal", 16) === null);

// ---------------------------------------------------------------- the expectation is data, not prose
console.log("verify-screen — the spec as data:");
{
  const exp = buildExpectation([
    doc([
      textNode("2:1", "Title", "Nothing here yet.", { family: "Poppins", size: 18, weight: "Medium", lineHeight: { value: 22, unit: "px" }, color: "#ffffff" }),
      // gap is only a gap between two laid-out children (finding 194 — see the slack rules below)
      { type: "FRAME", id: "2:2", name: "Card", fills: [{ type: "solid", color: "#121319" }], radius: 20, layout: { gap: 16, paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32 }, box: { w: 400, h: 200 },
        children: [{ type: "FRAME", id: "2:21", name: "a" }, { type: "FRAME", id: "2:22", name: "b" }] },
      { type: "FRAME", id: "2:3", name: "Nothing checkable" },
    ]),
  ]);
  ok("[expect] one row per node that actually carries a checkable value", exp.nodes.length === 2);
  const title = exp.nodes.find((n) => n.nodeId === "2:1");
  ok("[expect] a text node's spec carries family/size/weight/line-height/colour",
    title.fontFamily === "Poppins" && title.fontSize === 18 && title.fontWeight === 500 && title.lineHeight === 22 && title.color === "#ffffffff");
  ok("[expect] a TEXT node's fill is its COLOUR, never a background", title.backgroundColor === undefined);
  const card = exp.nodes.find((n) => n.nodeId === "2:2");
  ok("[expect] a frame's fill IS a background", card.backgroundColor === "#121319ff");
  ok("[expect] radius, gap, padding and size come through as numbers",
    card.borderRadius === 20 && card.gap === 16 && card.padding.join(",") === "32,32,32,32" && card.width === 400);
  ok("[expect] a field the export does not state is ABSENT, not defaulted", !("fontWeight" in card) && !("color" in card));
  ok("[expect] the file says out loud not to retype these numbers", /do NOT retype/i.test(exp.note));
}
{
  // Hidden nodes are not rendered, so measuring them is a false failure waiting to happen. The export
  // marks them `hidden: true` — NOT `visible: false` (finding 34), and a hidden parent hides its subtree.
  const exp = buildExpectation([doc([
    { type: "TEXT", id: "2:9", hidden: true, text: "hidden", font: { family: "Poppins", size: 12 } },
    { type: "FRAME", id: "2:10", name: "Breadcrumb", hidden: true, children: [textNode("2:11", "crumb", "Home", { family: "Poppins", size: 12 })] },
  ])]);
  ok("[expect] a node with hidden:true produces no expectation — nor does anything under a hidden parent", exp.nodes.length === 0);
  ok("[expect] …and the skipped layers are counted and listed, not silently dropped",
    exp.counts.hidden.layers === 2 && exp.counts.hidden.nodes === 3 && exp.hidden.ids.join(",") === "2:9,2:10,2:11");
  // `visible` in this export is a component-property REFERENCE (`propRefs.visible: "Show Breadcrumb"`),
  // not a visibility flag; filtering on it gives a confidently wrong answer (finding 34).
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
  const at = (id, field) => rep.deltas.find((d) => d.nodeId === id && d.field === field);
  ok("[diff] a heading rendered two sizes up is caught", !!at("2:1", "font-size") && at("2:1", "font-size").expected === 18 && at("2:1", "font-size").actual === 20);
  ok("[diff] …and so is its weight, because 500 vs 600 is never a rendering artifact", !!at("2:1", "font-weight"));
  ok("[diff] a wrong-but-plausible colour token is caught exactly, with no perceptual slack", !!at("2:2", "color"));
  ok("[diff] radius 20 against a spec of 12 is caught", !!at("2:3", "border-radius"));
  ok("[diff] a chip whose fill was never applied is caught as a transparent background",
    !!at("2:4", "background") && at("2:4", "background").actual === "transparent");
  ok("[diff] the mismatch names the TOKEN behind the value, so a reader knows where to look",
    at("2:4", "background").token === "Success/green BG");
  ok("[diff] font/colour misses are graded high, geometry medium",
    at("2:1", "font-size").severity === "high" && at("2:3", "border-radius").severity === "medium");
  ok("[diff] the verdict is FAIL, and it is computed, not asserted", rep.verdict === "fail");
  ok("[diff] and the report says in words why it is not a pass", rep.why.some((w) => /high-severity/.test(w)));
}
{
  // Everything correct, within tolerance. Line-height rounding by a pixel or two is a real browser
  // behaviour and must NOT be reported, or the signal drowns.
  const exp = buildExpectation([doc([textNode("2:1", "T", "Hi", { family: "Poppins", size: 14, weight: "Regular", lineHeight: { value: 21, unit: "px" }, color: "#ffffff" })])]);
  const rep = compare(exp, measured([{ nodeId: "2:1", styles: { fontFamily: '"Poppins", sans-serif', fontSize: 14, fontWeight: 400, lineHeight: 22, color: "#fff", text: "Hi" } }]));
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
    textNode("2:3", "Empty", "No job roles added yet.", { family: "Poppins", size: 14 }),
  ])]);
  const rep = compare(exp, measured([
    { nodeId: "2:1", styles: { text: "Back to List" } },
    { nodeId: "2:2", styles: { text: "NO. Of Employees" } },
    { nodeId: "2:3", styles: { text: "Nothing here yet." } },
  ]));
  const t = (id) => rep.deltas.filter((d) => d.nodeId === id && d.field === "text");
  ok("[text] a copy change is a HIGH-severity delta", t("2:1").length === 1 && t("2:1")[0].severity === "high");
  ok("[text] a case-only difference is LOW and names text-transform as the likely cause",
    t("2:2").length === 1 && t("2:2")[0].severity === "low" && /text-transform/.test(t("2:2")[0].note));
  ok("[text] a designed non-breaking space is surfaced rather than silently normalised",
    rep.deltas.some((d) => d.nodeId === "2:3" && /non-breaking space/.test(d.note || "")));
  ok("[text] …and printed as an ESCAPE, so the row is not two identical-looking strings",
    (() => { const d = rep.deltas.find((x) => x.nodeId === "2:3" && /invisible/.test(x.field)); return d && /\\u00a0/.test(d.expected) && !/\\u00a0/.test(d.actual); })());
}

// ---------------------------------------------------------------- coverage and interactions
console.log("verify-screen — a screen can match every pixel and still be a dead mockup:");
{
  const exp = buildExpectation([doc([
    { type: "INSTANCE", id: "3:1", name: "Date", mainComponent: { setName: "Date range", setKey: "k1" } },
    { type: "INSTANCE", id: "3:2", name: "View", mainComponent: { setName: "Segmented Control", setKey: "k2" } },
    { type: "INSTANCE", id: "3:3", name: "Add", mainComponent: { setName: "Button", setKey: "k3" },
      reactions: [{ trigger: { type: "on_click" }, action: { type: "navigate", navigation: "overlay", destinationId: "20170:132666" } }] },
  ])]);
  ok("[cover] the expectation carries every instance and every designed reaction",
    exp.counts.instances === 3 && exp.counts.interactions === 1);

  const rep = compare(exp, measured([], { components: [{ setName: "Button" }], interactions: [] }));
  ok("[cover] instance sets the probe could not point at are named — as TAG COVERAGE, not as 'never built'",
    rep.untaggedInstanceSets.length === 2 && rep.missingComponents === undefined && !rep.why.some((w) => /never built/.test(w)));
  ok("[cover] and each one says how many instances it stands for", rep.untaggedInstanceSets[0].instances === 1);
  ok("[cover] a designed interaction nobody exercised is 'not-probed', never silently passed",
    rep.interactions.length === 1 && rep.interactions[0].result === "not-probed");
  ok("[cover] missing tags alone do not FAIL a screen (a .map() row and a shared shell leave gaps by design — 107/139/169)",
    rep.verdict === "incomplete" && rep.summary.componentsAbsent === 0);
  ok("[cover] a component the probe reports ABSENT (present:false) does fail it",
    (() => {
      const r = compare(exp, measured([], { components: [{ setName: "Button" }, { setName: "Date range", present: false, detail: "no date filter in the toolbar" }] }));
      return r.verdict === "fail" && r.componentsAbsent.length === 1 && r.componentsAbsent[0].setName === "Date range";
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
      return r.verdict === "fail" && r.interactions[0].result === "fail" && /opened nothing/.test(r.interactions[0].detail);
    })());
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

// ---------- CLI: --out defaults to the input file's own basename (P3 #152) ----------------------
// Live-run finding 152: `--expect` run once by base name and once by a nickname for the SAME screen
// wrote two byte-identical files under two names in design/verify/. Defaulting `--out` to the input
// file's own basename (already `<LayerName>__<node-id>` by construction) means two runs against the
// same export always land on the same artefact.
(() => {
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-out-"));
  const screenFile = path.join(cwd, "positions___7314_87192.json");
  fs.writeFileSync(screenFile, JSON.stringify({
    exportedAt: "2026-09-22T00:00:00.000Z", screen: "positions ",
    nodes: [{ type: "FRAME", id: "7314:87192", name: "positions ", children: [] }],
  }));
  const scriptPath = path.join(__dirname, "..", "design-to-code", "verify-screen.js");
  const r = spawnSync(process.execPath, [scriptPath, "--expect", screenFile], { encoding: "utf8", cwd });
  ok("[cli-out] --expect with no --out writes design/verify/<the input file's own basename>.expected.json",
    r.status === 0 && fs.existsSync(path.join(cwd, "design", "verify", "positions___7314_87192.expected.json")));
  const expFile = path.join(cwd, "design", "verify", "positions___7314_87192.expected.json");
  const measuredFile = path.join(cwd, "measured.json");
  fs.writeFileSync(measuredFile, JSON.stringify({ measuredAt: "2026-09-22T00:00:01.000Z", renderer: "test", viewport: { w: 1, h: 1 }, artifacts: {}, nodes: [], components: [], interactions: [] }));
  spawnSync(process.execPath, [scriptPath, "--compare", expFile, measuredFile], { encoding: "utf8", cwd });
  ok("[cli-out] --compare defaults to the .expected.json's own basename, not a new name",
    fs.existsSync(path.join(cwd, "design", "verify", "positions___7314_87192.report.json")));
})();

// ================================================================= livetest-3 regressions (P2a)
// Every fixture below is the REAL export / probe output of the livetest-3 run, built by
// test/fixtures/livetest3/verify/build.js (which proves the pruned exports give byte-identical
// expectations and audits to the full ones). The "before" numbers in the comments are what the
// pre-fix verify-screen.js printed on these exact files.
(() => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const crypto = require("crypto");
  // defaults so the block still runs (and fails assertion by assertion) against an older verify-screen.js
  const { FIELDS = [], tokenFor = () => undefined } = require("../design-to-code/verify-screen.js");
  const FX = path.join(__dirname, "fixtures", "livetest3", "verify");
  const load = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
  const JR_FILE = "positions___7314_87192.json", GP_FILE = "System_Configurations__1359_21337.json";
  const jrDoc = load(JR_FILE), gpDoc = load(GP_FILE);
  const jrExp = buildExpectation([{ doc: jrDoc, label: "positions___7314_87192" }]);
  const gpExp = buildExpectation([{ doc: gpDoc, label: "System_Configurations__1359_21337" }]);
  const jrMeasured = load("JobRoles.measured.json"), gpMeasured = load("GlobalPolicies.measured.json");
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // An assertion that THROWS on an older report shape is a failure of that assertion, not of the suite.
  const ok = (name, cond) => { let v; try { v = typeof cond === "function" ? cond() : cond; } catch (e) { v = false; } return okOuter(name, v); };

  // An INDEPENDENT hidden walk — the snippet from the prompt, not hidden.js — so the test does not
  // grade the code with its own predicate.
  const hiddenOf = (doc) => { const h = new Set(); (function w(n, p) { const x = p || !!n.hidden; if (x && n.id) h.add(n.id); for (const c of n.children || []) w(c, x); })({ children: doc.nodes }, false); return h; };
  const jrHidden = hiddenOf(jrDoc), gpHidden = hiddenOf(gpDoc);
  const hiddenIn = (arr, H) => arr.filter((x) => H.has(x.nodeId)).length;

  console.log("verify-screen — livetest-3: hidden layers are never specified (97/126/157/181):");
  // before: specs 272 hidden 83 · instances 112 hidden 61 · interactions 28 hidden 22
  ok("[lt3-hidden] Job Roles: 0 specs, 0 instances, 0 interactions on hidden layers (were 83/272, 61/112, 22/28)",
    () => hiddenIn(jrExp.nodes, jrHidden) === 0 && hiddenIn(jrExp.instances, jrHidden) === 0 && hiddenIn(jrExp.interactions, jrHidden) === 0);
  // before: 75 of 233, 45 of 87, 11 of 12
  ok("[lt3-hidden] Global Policies: 0 / 0 / 0 on hidden layers (were 75/233, 45/87, 11/12)",
    () => hiddenIn(gpExp.nodes, gpHidden) === 0 && hiddenIn(gpExp.instances, gpHidden) === 0 && hiddenIn(gpExp.interactions, gpHidden) === 0);
  ok("[lt3-hidden] what was skipped is counted: 61+45 instances and 22+11 interactions — the numbers the finding reported",
    () => jrExp.counts.hidden.instancesSkipped === 61 && jrExp.counts.hidden.interactionsSkipped === 22 &&
    gpExp.counts.hidden.instancesSkipped === 45 && gpExp.counts.hidden.interactionsSkipped === 11);
  ok("[lt3-hidden] the visible instance list is exactly the frame's visible instances (51 on Job Roles, 42 on Global Policies)",
    () => jrExp.instances.length === 51 && gpExp.instances.length === 42);
  ok("[lt3-hidden] the expectation lists the hidden ids so --compare can refuse credit for them", () => jrExp.hidden.ids.length === jrHidden.size && gpExp.hidden.ids.length === gpHidden.size);
  ok("[lt3-determinism] --expect stays byte-deterministic on the real export (finding 154)",
    () => JSON.stringify(buildExpectation([{ doc: jrDoc, label: "positions___7314_87192" }])) === JSON.stringify(jrExp) && !/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?!\.000Z)/.test(JSON.stringify(jrExp).replace(jrDoc.exportedAt, "")));

  console.log("verify-screen — livetest-3: --compare filters hidden layers too (157/187/188):");
  const gpRep = compare(gpExp, gpMeasured);
  // The real GP probe drove 4 hidden hovers (4×30 s timeouts → 'fail') and credited 2 hidden popup rows
  // with hovers performed on other controls ('pass').
  ok("[lt3-hidden] evidence for hidden layers is ignored and counted, never graded (11 rows on GP)",
    () => gpRep.probe.interactionEvidenceOnHiddenLayers === 11 && gpRep.interactions.length === 1 && gpRep.coverage.interactionsFailed === 0);
  ok("[lt3-hidden] a legacy @1 expectation (hidden rows baked in) is refused as evidence, not silently graded",
    () => (() => { const legacy = Object.assign(clone(gpExp), { schema: "designtwin/verify-expectation@1" }); const r = compare(legacy, gpMeasured); return r.verdict !== "pass" && r.why.some((w) => /predates hidden-layer filtering/.test(w)); })());

  console.log("verify-screen — livetest-3: a field the probe names differently is LOUD (162/182/195):");
  const jrRep = compare(jrExp, jrMeasured);
  // before: the JR report had 0 border-radius deltas and nothing said radius was never checked.
  ok("[lt3-radius] the real Job Roles probe wrote `radius`: the HEADLINE says borderRadius was present in 0 measurements",
    /'borderRadius' present in 0 of \d+ measurements \(probe sent 'radius'\)/.test(jrRep.headline) && jrRep.coverage.fieldsNeverMeasured.some((f) => f.field === "borderRadius" && f.measuredOn === 0));
  ok("[lt3-radius] …and the unknown key is named with its canonical spelling, not accepted", () => jrRep.probe.unknownKeys.some((k) => k.key === "radius" && k.canonical === "borderRadius"));
  ok("[lt3-radius] …and that alone keeps the verdict from passing", () => jrRep.why.some((w) => /field 'borderRadius' was present in 0/.test(w)));
  const renamed = clone(jrMeasured);
  for (const n of renamed.nodes) { if ("radius" in n) { n.borderRadius = n.radius; delete n.radius; } }
  const jrRad = compare(jrExp, renamed);
  const rd = (id, corner) => jrRad.deltas.find((d) => d.nodeId === id && d.field === `border-radius (${corner})`);
  ok("[lt3-radius] with the canonical key, the four dropped Job Roles radii are deltas: 20173:142077 tl/tr and 20173:142137 bl/br, 12 → 0",
    () => ["top-left", "top-right"].every((c) => rd("20173:142077", c) && rd("20173:142077", c).expected === 12 && rd("20173:142077", c).actual === 0) &&
    ["bottom-left", "bottom-right"].every((c) => rd("20173:142137", c) && rd("20173:142137", c).expected === 12 && rd("20173:142137", c).actual === 0));
  ok("[lt3-radius] a bottom-only radius ({bl,br}) is specified at all — the old code read radius.tl only",
    () => JSON.stringify(jrExp.nodes.find((n) => n.nodeId === "20173:142137").radiusCorners) === JSON.stringify({ tl: 0, tr: 0, br: 12, bl: 12 }));
  ok("[lt3-radius] the Global Policies card that ships 16 where the design says 12 is caught (finding 183)",
    () => gpRep.deltas.some((d) => d.nodeId === "18580:60755" && d.field === "border-radius" && d.expected === 12 && d.actual === 16));

  console.log("verify-screen — livetest-3: positions are compared, frame-relative (164/192):");
  const pos = load("prefix-positions.json");
  ok("[lt3-xy] FIELDS carries x and y", () => FIELDS.some((f) => f.key === "x") && FIELDS.some((f) => f.key === "y"));
  ok("[lt3-xy] the expectation states its coordinate convention", () => /FRAME-RELATIVE/.test(jrExp.coordinates) && jrExp.frame.w === 1440 && jrExp.frame.h === 1236);
  {
    const m = clone(jrMeasured);
    const pg = m.nodes.find((n) => n.nodeId === "20173:142142");
    Object.assign(pg, { y: pos["20173:142142"].y, height: pos["20173:142142"].height });
    const r = compare(jrExp, m);
    const place = r.deltas.find((d) => d.nodeId === "20173:142142" && d.field === "placement");
    ok("[lt3-xy] Job Roles pre-fix: the pagination bar is reported OUTSIDE the frame, high severity (bottom edge 1366 > 1236)",
      () => !!place && place.severity === "high" && /y=1366 in a 1236-high frame/.test(place.actual));
    ok("[lt3-xy] …and its y is a delta against the design's own position (864)", () => r.deltas.some((d) => d.nodeId === "20173:142142" && d.field === "y (frame-relative)" && d.expected === 864 && d.actual === 1342));
  }
  {
    const m = clone(gpMeasured);
    const st = m.nodes.find((n) => n.nodeId === "18580:60861");
    st.styles.textBox = { x: pos["18580:60861"].textBoxX };
    const r = compare(gpExp, m);
    const d = r.deltas.find((x) => x.nodeId === "18580:60861" && x.field === "x (frame-relative)");
    ok("[lt3-xy] Global Policies pre-fix: the Status header is +18.94px right of the design (1296.81 → 1315.75)",
      () => !!d && d.expected === 1296.81 && d.actual === 1315.75 && d.delta === 18.94);
  }

  console.log("verify-screen — livetest-3: the coverage line closes (165/184):");
  for (const [name, rep, m] of [["Job Roles", jrRep, jrMeasured], ["Global Policies", gpRep, gpMeasured]]) {
    const ids = new Set(m.nodes.map((n) => String(n.nodeId)));
    ok(`[lt3-cover] ${name}: nodesExpected − nodesMeasured == notMeasured.length, one row per node`,
      () => rep.coverage.nodesExpected - rep.coverage.nodesMeasured === rep.notMeasured.length && new Set(rep.notMeasured.map((n) => n.nodeId)).size === rep.notMeasured.length);
    ok(`[lt3-cover] ${name}: no id is both 'never measured' and in measured.nodes (6 were on GP before)`, () => rep.notMeasured.every((n) => !ids.has(String(n.nodeId))));
    ok(`[lt3-cover] ${name}: the headline leads with nodes measured N/M`, () => rep.headline.includes(`nodes measured ${rep.coverage.nodesMeasured}/${rep.coverage.nodesExpected}`));
    ok(`[lt3-cover] ${name}: unmeasured nodes still block the pass`, () => rep.verdict !== "pass" && rep.why.some((w) => /never measured/.test(w)));
  }

  console.log("verify-screen — livetest-3: the token on a delta is the token for THAT field (98/160):");
  const hoverRow = jrExp.nodes.find((n) => n.nodeId === "20173:142096");
  ok("[lt3-token] the drawn-hover row's background token is Backgrounds/Row Hover, its padding token Space 3 / Space 4",
    () => tokenFor(hoverRow, "backgroundColor") === "Backgrounds/Row Hover" && tokenFor(hoverRow, "padding") === "Space 3 / Space 4");
  {
    // The row measured hovered but NOT repainting (#121319 still): a real background delta, and its
    // token must be the fill's — the old code said "Space 4".
    const m = clone(jrMeasured);
    m.nodes.find((n) => n.nodeId === "20173:142096").states = { hover: { backgroundColor: "#121319ff" } };
    const d = compare(jrExp, m).deltas.find((x) => x.nodeId === "20173:142096" && x.field === "background");
    ok("[lt3-token] a background delta on 20173:142096 carries token 'Backgrounds/Row Hover', not 'Space 4'", () => !!d && d.token === "Backgrounds/Row Hover" && d.measuredIn === "hover");
  }
  ok("[lt3-token] the filter button's gap delta names Rows Spacing", () => jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "gap" && d.token === "Rows Spacing"));

  console.log("verify-screen — livetest-3: 'not probed' is a third state (158/175):");
  const addBtnHover = jrRep.interactions.find((i) => i.nodeId === "I20173:137670;72:3440" && i.trigger === "on_hover");
  ok("[lt3-int] the real `ok:null, \"not measured — … not probed\"` row is not-probed, not fail", addBtnHover && addBtnHover.result === "not-probed");
  ok("[lt3-int] not-probed rows do not count toward 'designed interaction(s) failed'",
    () => jrRep.coverage.interactionsFailed === jrRep.interactions.filter((i) => i.result === "fail").length && !jrRep.interactions.some((i) => i.result === "fail" && /not probed|not measured/i.test(i.detail || "")));
  // finding 175: the two genuinely unimplemented interactions must STILL fail.
  ok("[lt3-int] the two genuinely unimplemented interactions still FAIL (import overlay; row → Job Role Details)",
    () => jrRep.interactions.some((i) => i.nodeId === "I20173:137670;2006:22479" && i.result === "fail") &&
    ["20173:142081", "20173:142086", "20173:142091"].every((id) => jrRep.interactions.some((i) => i.nodeId === id && i.result === "fail")) && jrRep.verdict === "fail");
  ok("[lt3-int] ok:true with no selector is not a pass (finding 187's evidence rule)",
    () => gpRep.interactions[0].nodeId === "18580:60879" && gpRep.interactions[0].result === "not-probed" && /without evidence/.test(gpRep.interactions[0].detail));
  ok("[lt3-int] ok:true naming the selector it drove and a match count ≥1 is a pass",
    () => (() => { const r = compare(gpExp, gpMeasured, { interactions: [{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="18580:60879"]', selectorCount: 1, detail: "dialog open=1" }] }); return r.interactions[0].result === "pass" && r.interactions[0].selector && r.coverage.interactionsPassed === 1; })());
  ok("[lt3-int] a selector that matched 0 elements is not a pass",
    () => (() => { const r = compare(gpExp, gpMeasured, { interactions: [{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="1359:21364"]', selectorCount: 0 }] }); return r.interactions[0].result === "not-probed"; })());

  console.log("verify-screen — livetest-3: none of the eight false-positive families is a high delta (128/161/194):");
  // Before: 4 of 4 highs on the real GP probe were wrong, and 2 of 2 on JR.
  ok("[lt3-fp] the real Global Policies probe output now yields 0 high deltas (was 4)", () => gpRep.summary.high === 0);
  ok("[lt3-fp] the real Job Roles probe output now yields 0 high deltas (was 2)", () => jrRep.summary.high === 0);
  // The same probe fed the REAL DOM evidence from the independent Playwright pass.
  const dom = load("GlobalPolicies.dom.json");
  const chk = (id, selPart) => dom.checks.find((c) => c.designId === id && (!selPart || c.sel.includes(selPart))).measured;
  const S = (m) => ({ tag: m.tag, width: m.width, height: m.height, x: m.x, y: m.y, backgroundColor: m.backgroundColor, color: m.color, borderRadius: m.radius, padding: m.padding });
  const gpDom = clone(gpMeasured);
  const node = (id) => { let n = gpDom.nodes.find((x) => x.nodeId === id); if (!n) { n = { nodeId: id, styles: {} }; gpDom.nodes.push(n); } return n; };
  // 1. the row drawn hovered — measured hovered
  node("18580:60874").states = { hover: S(dom.hoverState.row) };
  // 2. inline SVG paint — the glyph's computed fill
  Object.assign(node("20024:144120").styles, { fill: chk("20024:144120").svgFill });
  // 3. ::placeholder — el.placeholder and the pseudo-element's colour
  Object.assign(node("I20024:134073;885:2724;880:3726").styles, { tag: "input", placeholderText: "Search by policy description", placeholderColor: chk("I20024:134073;885:2724;880:3724").svgFill });
  // 4. hover-only control — measured on hover
  node("18580:60880").states = { hover: S(dom.hoverState.editButton) };
  // 6. <table> row gap — the rendered row-to-row distance
  Object.assign(node("18580:60858").styles, { gapVisual: dom.measuredRowGap });
  // 8. TEXT id on a <th> — the tag is reported
  Object.assign(node("18580:60861").styles, { tag: chk("18580:60861", "th[").tag });
  const domRep = compare(gpExp, gpDom);
  const on = (id, re) => domRep.deltas.filter((d) => d.nodeId === id && re.test(d.field));
  ok("[lt3-fp] 1 drawn-hovered row: no delta when measured hovered (#46464f)", () => on("18580:60874", /background/).length === 0 && gpRep.fieldsNotMeasured.some((f) => f.nodeId === "18580:60874" && /hover/.test(f.why)));
  ok("[lt3-fp] 2 inline SVG: compared as `fill`, never against background-color", on("20024:144120", /background|fill/).length === 0 && gpExp.nodes.find((n) => n.nodeId === "20024:144120").fill === "#d4d4d4ff");
  ok("[lt3-fp] 3 ::placeholder: text and colour compared as placeholder, not as textContent/color",
    () => on("I20024:134073;885:2724;880:3726", /text|colou?r/).length === 0 &&
    !domRep.fieldsNotMeasured.some((f) => f.nodeId === "I20024:134073;885:2724;880:3726" && /placeholder/.test(f.field)) &&
    !domRep.unverifiable.some((f) => f.nodeId === "I20024:134073;885:2724;880:3726") &&
    !gpExp.nodes.find((n) => n.nodeId === "I20024:134073;885:2724;880:3726").color);
  ok("[lt3-fp] 4 hover-only control at rest: 0×0 is 'measure it hovered', not a size delta; hovered it matches",
    () => gpRep.deltas.filter((d) => d.nodeId === "18580:60880").length === 0 && on("18580:60880", /./).length === 0);
  ok("[lt3-fp] 5 auto-layout slack (gap 200 / 146 / 160) is excluded by method, with the reason",
    () => ["18580:60762", "18580:60859", "18580:60863"].every((id) => gpExp.notComparable.some((n) => n.nodeId === id && n.field === "gap")) && on("18580:60762", /gap/).length === 0);
  ok("[lt3-fp] 6 table border-spacing: the rendered row gap (8) is compared, not CSS gap (4)", () => on("18580:60858", /gap/).length === 0);
  ok("[lt3-fp] 7 radius 500 on a 36px box vs rounded-full (33554400): both are circles — no delta", () => ["18580:60760", "18580:60767", "18580:60774"].every((id) => on(id, /radius/).length === 0));
  ok("[lt3-fp] 8 TEXT node id on its <th>: the th's box is not graded as the text's", () => on("18580:60861", /width|height/).length === 0 && gpRep.deltas.filter((d) => d.nodeId === "18580:60861").length === 0);
  ok("[lt3-fp] with the real DOM evidence, still no high delta anywhere", () => domRep.summary.high === 0);
  // True positives that must survive (171/183/193) — leniency is not the fix.
  ok("[lt3-tp] 171: the Job Roles filter button's Rows Spacing gap 8 → 12 and width 110 → 115.83 are still reported",
    () => jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "gap" && d.expected === 8 && d.actual === 12) &&
    jrRep.deltas.some((d) => d.nodeId === "I20173:142047;885:2723" && d.field === "width" && d.actual === 115.83));
  ok("[lt3-tp] 193: 111.83×38 against 110×36 is reported now (size tolerance 1, was an inclusive 2)",
    () => gpRep.deltas.some((d) => d.nodeId === "I20024:134073;885:2723" && d.field === "height" && d.expected === 36 && d.actual === 38) &&
    gpRep.deltas.some((d) => d.nodeId === "I20024:134073;885:2723" && d.field === "width" && d.actual === 111.83));
  ok("[lt3-tp] 193: the content column's extra 24px bottom padding is reported (padding was never read from layout.padding)",
    () => gpRep.deltas.some((d) => d.nodeId === "18580:60747" && d.field === "padding"));

  console.log("verify-screen — livetest-3: 'components never built' is gone; tag coverage is named as such (129/159/169/185):");
  for (const [name, rep] of [["Job Roles", jrRep], ["Global Policies", gpRep]]) {
    ok(`[lt3-comp] ${name}: 0 components reported absent (was ${name === "Job Roles" ? 31 : 52} 'never built'), and no 'never built' reason`,
      rep.summary.componentsAbsent === 0 && rep.missingComponents === undefined && !rep.why.some((w) => /never built/.test(w)));
    ok(`[lt3-comp] ${name}: the metric is named tag coverage, not presence, and counts visible sets only`,
      () => /tag coverage, not presence/.test(rep.headline) && rep.untaggedInstanceSets.every((s) => s.nodeIds.every((id) => !(name === "Job Roles" ? jrHidden : gpHidden).has(id))));
  }
  {
    // A shared AppShell tagged with the OTHER frame's instance ids (finding 185): the real Job Roles
    // measurement of the sidebar item, fed to Global Policies.
    const jrItem = jrMeasured.nodes.find((n) => n.nodeId === "I10970:111588;1910:23337");
    const m = clone(gpMeasured); m.nodes.push(clone(jrItem));
    const r = compare(gpExp, m);
    ok("[lt3-comp] one implementation, two frames: I10970:111588;1910:23337 counts for I10970:109860;1910:23337 via the component path",
      () => r.coverage.nodesMatchedByComponentPath >= 1 && r.coverage.instanceSetsWithEvidence > gpRep.coverage.instanceSetsWithEvidence);
  }

  {
    // finding 170: the search field's id spread onto the inner <input> (330x20) instead of the <label>
    // that draws the 380x36 field. The real input measurement, attached to the Text Input frame's id.
    const m = clone(jrMeasured);
    const input = m.nodes.find((n) => n.nodeId === "I20173:142047;885:2724");
    m.nodes.push(Object.assign(clone(input), { nodeId: "I20173:142047;885:2724;880:3724", tag: "input" }));
    const r = compare(jrExp, m);
    ok("[lt3-leaf] 170: a FRAME's id on a leaf <input> is not graded as the frame (no size/fill/radius/padding deltas), and says why", () =>
      r.deltas.filter((d) => d.nodeId === "I20173:142047;885:2724;880:3724").length === 0 &&
      r.fieldsNotMeasured.some((f) => f.nodeId === "I20173:142047;885:2724;880:3724" && /leaf <input>/.test(f.why)));
  }

  console.log("verify-screen — livetest-3: text and pseudo-elements (163/177):");
  {
    const m = clone(jrMeasured);
    const th = m.nodes.find((n) => n.nodeId === "20173:142078");
    th.text = "Job Role▲";
    const d = compare(jrExp, m).deltas.find((x) => x.nodeId === "20173:142078" && x.field === "text");
    ok("[lt3-text] 'Job Role▲' (a th with a sort caret) is compared — low, naming the extra glyph, not a copy change", () => !!d && d.severity === "low" && /▲/.test(d.note));
    th.text = null;
    ok("[lt3-text] text: null from a probe that skips elements with children is a named gap", () => compare(jrExp, m).fieldsNotMeasured.some((f) => f.nodeId === "20173:142078" && /text: null/.test(f.why)));
  }
  ok("[lt3-limits] ::placeholder colour with no probe value is 'unverifiable', listed, not a delta", () => gpRep.unverifiable.some((u) => u.nodeId === "I20024:134073;885:2724;880:3726"));
  ok("[lt3-limits] the report states the pseudo-element hole and the rotate/transform trap", () => gpRep.limits.some((l) => /::before\/::after/.test(l)) && gpRep.limits.some((l) => /rotate/.test(l)));

  console.log("verify-screen — livetest-3: evidence is tied to its inputs (153/166/181/190), CLI:");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p2a-verify-"));
  const script = path.join(__dirname, "..", "design-to-code", "verify-screen.js");
  const run = (...a) => spawnSync(process.execPath, [script, ...a], { encoding: "utf8", cwd });
  const src = path.join(FX, GP_FILE);
  const r1 = run("--expect", src, "--out", "design/verify/GlobalPolicies");
  const expFile = path.join(cwd, "design/verify/GlobalPolicies.expected.json");
  const bytes1 = fs.readFileSync(expFile);
  const r2 = run("--expect", src, "--out", "design/verify/GlobalPolicies");
  ok("[lt3-cli] --expect prints what it skipped as hidden (45 instances, 11 interactions)", () => /skipped 23 hidden layer\(s\) \(\d+ spec\(s\), 45 instance\(s\), 11 interaction\(s\)\)/.test(r1.stderr));
  ok("[lt3-cli] a second identical --expect is byte-identical and says 'unchanged'", () => r2.status === 0 && Buffer.compare(bytes1, fs.readFileSync(expFile)) === 0 && /already identical/.test(r2.stderr));
  fs.writeFileSync(path.join(cwd, "design/verify/GlobalPolicies.measured.json"), JSON.stringify(Object.assign(clone(gpMeasured), { expectationSha256: "0".repeat(64) })));
  const c1 = run("--compare", expFile, "design/verify/GlobalPolicies.measured.json");
  const rep1 = JSON.parse(fs.readFileSync(path.join(cwd, "design/verify/GlobalPolicies.report.json"), "utf8"));
  ok("[lt3-cli] the report records the sha256 of the expectation it was computed on", () => rep1.inputs.expectationSha256 === crypto.createHash("sha256").update(bytes1).digest("hex"));
  ok("[lt3-cli] a measurement taken against a different expectation is called stale", () => rep1.why.some((w) => /DIFFERENT expectation/.test(w)));
  ok("[lt3-cli] artifacts that do not exist on disk are flagged: no screenshot, no pass (166/190)", () => rep1.why.some((w) => /no screenshot/.test(w)) && rep1.artifacts.every((a) => a.exists === false));
  ok("[lt3-cli] the stdout headline is the coverage line", () => c1.status === 1 && /^INCOMPLETE — .*nodes measured \d+\/\d+/m.test(c1.stderr));
  const edited = clone(gpDoc); edited.nodes[0].children = edited.nodes[0].children.slice(0, 2);
  fs.writeFileSync(path.join(cwd, "edited.json"), JSON.stringify(edited));
  const r3 = run("--expect", "edited.json", "--out", "design/verify/GlobalPolicies");
  ok("[lt3-cli] re-running --expect over a different export says REPLACED and names the now-stale report/measurement",
    () => /REPLACED an existing/.test(r3.stderr) && /GlobalPolicies\.report\.json/.test(r3.stderr) && /PREVIOUS expectation/.test(r3.stderr));
  fs.writeFileSync(path.join(cwd, "ints.json"), JSON.stringify([{ nodeId: "18580:60879", trigger: "on_click", ok: true, selector: '[data-dt-node="18580:60879"]', selectorCount: 1 }]));
  run("--expect", src, "--out", "design/verify/GlobalPolicies");
  run("--compare", expFile, "design/verify/GlobalPolicies.measured.json", "--interactions", "ints.json");
  ok("[lt3-cli] --interactions <file> is the input channel for interaction evidence (127)",
    () => JSON.parse(fs.readFileSync(path.join(cwd, "design/verify/GlobalPolicies.report.json"), "utf8")).coverage.interactionsPassed === 1);
  ok("[lt3-cli] --help says there is no browser in --compare", () => /NO browser/.test(run("--help").stdout));
})();

report();
