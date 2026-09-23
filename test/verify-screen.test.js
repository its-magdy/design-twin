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
      { type: "FRAME", id: "2:2", name: "Card", fills: [{ type: "solid", color: "#121319" }], radius: 20, layout: { gap: 16, paddingTop: 32, paddingRight: 32, paddingBottom: 32, paddingLeft: 32 }, box: { w: 400, h: 200 } },
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
  // Hidden nodes are not rendered, so measuring them is a false failure waiting to happen.
  const exp = buildExpectation([doc([{ type: "TEXT", id: "2:9", visible: false, text: "hidden", font: { family: "Poppins", size: 12 } }])]);
  ok("[expect] an invisible node produces no expectation", exp.nodes.length === 0);
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
  ok("[cover] components on the frame with no counterpart in the build are named", rep.missingComponents.length === 2);
  ok("[cover] and each one says how many instances it stands for", rep.missingComponents[0].instances === 1);
  ok("[cover] a designed interaction nobody exercised is 'not-tested', never silently passed",
    rep.interactions.length === 1 && rep.interactions[0].result === "not-tested");
  ok("[cover] missing components make the verdict FAIL, not 'pass with notes'", rep.verdict === "fail");
  ok("[cover] and untested interactions alone make it INCOMPLETE rather than a pass",
    (() => {
      const r = compare(exp, measured([], { components: [{ setName: "Date range" }, { setName: "Segmented Control" }, { setName: "Button" }] }));
      return r.verdict === "incomplete" && r.why.some((w) => /never exercised/.test(w));
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
  ok("[gaps] and it blocks the pass", rep.verdict !== "pass" && rep.why.some((w) => /could not be measured/.test(w)));
  ok("[gaps] the markdown renders the gaps as gaps in the PROBE, not as clean results",
    /Gaps in the probe, not clean results/.test(reportToMarkdown(rep)));
  ok("[gaps] the report is machine-readable and self-describing",
    rep.schema === "designtwin/verify-report@1" && typeof rep.coverage.fieldsChecked === "number");
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

report();
