// Offline tests for design-to-code/cross-check.js — the JOIN between a screen and the design system.
//
// Every fixture here is a miniature of a defect the live run hit by hand and the tooling missed:
// a duplicated file that re-keys every collection, a catalog that covers 0% of the screen, two
// libraries whose token names collide on different values, a text style that differs by one capital
// letter, a radius of a billion, a Dark-only export of a two-mode system.
// Run with:  node test/cross-check.test.js
const { crossCheck, toMarkdown } = require("../design-to-code/cross-check.js");
const { screenCoverage } = require("../design-to-code/drift-lint.js");
const { ok, report } = require("./assert");

const has = (res, code) => res.findings.some((f) => f.code === code);
const get = (res, code) => res.findings.find((f) => f.code === code);
const sev = (res, code) => (get(res, code) || {}).severity;

// ---------------------------------------------------------------- fixtures
const instance = (id, setKey, setName, props) => ({
  type: "INSTANCE", id, name: setName, props: props || {},
  mainComponent: { name: setName, key: setKey + "-v", setKey, setName },
});
const text = (id, family, style, token) => ({
  type: "TEXT", id, font: { family, size: 14 }, styles: style ? { text: style } : undefined,
  tokens: token ? { fills: token } : undefined,
});
const screen = (label, children) => ({
  doc: { exportedAt: "2026-09-22T00:00:00Z", screen: label, nodes: [{ type: "FRAME", id: "1:1", resolvedModes: { Sem: "Dark" }, children }] },
  label,
});

const DS_TOKENS = {
  collections: [
    { name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" },
    { name: "Spacing", key: "ds-space", modes: ["Mode 1"], default: "Mode 1" },
  ],
  variables: [
    { name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } },
    { name: "Space 3", collection: "Spacing", key: "ds-k2", type: "FLOAT", values: { "Mode 1": 16 } },
    { name: "Full", collection: "Spacing", key: "ds-k3", type: "FLOAT", values: { "Mode 1": 1000000000 } },
  ],
};
const DS_COMPONENTS = {
  components: [
    { name: "Button", key: "ds-btn", type: "COMPONENT_SET", props: { "Btn Text": { type: "TEXT" } } },
    { name: "Header", key: "ds-hdr", type: "COMPONENT_SET", props: {} },
    { name: "Header", key: "ds-hdr2", type: "COMPONENT_SET", props: {} },
  ],
};
const DS_TEXT_STYLES = { styles: [{ name: "Medium/14 medium", font: "Poppins", size: 14 }] };

// ---------------------------------------------------------------- a duplicated file re-keys everything
console.log("cross-check — the screen's token library vs the design system's:");
{
  // Same collection NAME, same values, different key: the signature of "(Copy)".
  const duplicated = {
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "screen-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  };
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", null, "Text/Main")])], variables: duplicated, tokens: DS_TOKENS });
  ok("[tokens] a screen whose collections are ALL re-keyed is a blocker, not a warning", sev(res, "foreign-token-library") === "blocker");
  ok("[tokens] and the message names the duplicated-file cause rather than just 'not found'",
    /DUPLICATED Figma file/.test(get(res, "foreign-token-library").message));
  ok("[tokens] it names the ONE command that can attribute a collection to a library",
    /list libraries/.test(get(res, "foreign-token-library").message));
  ok("[tokens] identical values under a different key are NOT reported as a value conflict",
    !has(res, "token-name-collision"));
}
{
  const same = {
    collections: [{ name: "Sem", key: "ds-sem", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "ds-k1", type: "COLOR", values: { Dark: "#fff", Light: "#000" } }],
  };
  const res = crossCheck({ screens: [screen("S", [])], variables: same, tokens: DS_TOKENS });
  ok("[tokens] a screen that really does use the design system's collections says so",
    has(res, "token-library-matches") && !has(res, "foreign-token-library"));
}

// ---------------------------------------------------------------- name collides, value differs
console.log("cross-check — two libraries, one name, two values:");
{
  // The live case exactly: `(Space 3)`=12 on Desktop vs `Space 3`=16 on "Mode 1". No mode name is
  // shared, so any comparison that needs aligned modes reports nothing — and this is the single most
  // dangerous collision there is, because a slugger maps both onto one custom property.
  const vars = {
    collections: [{ name: "Spacing", key: "screen-space", modes: ["Desktop", "Tablet"], default: "Desktop" }],
    variables: [{ name: "(Space 3)", collection: "Spacing", key: "screen-k2", type: "FLOAT", values: { Desktop: 12, Tablet: 8 } }],
  };
  const res = crossCheck({ screens: [screen("S", [])], variables: vars, tokens: DS_TOKENS });
  ok("[collision] a punctuation-only name twin with disjoint values is a blocker", sev(res, "token-name-collision") === "blocker");
  ok("[collision] the message carries BOTH values so the reader can pick", /12/.test(get(res, "token-name-collision").message) && /16/.test(get(res, "token-name-collision").message));
  ok("[collision] and says why no per-mode comparison was possible",
    /no mode name is shared/.test(get(res, "token-name-collision").message));
}
{
  // Aliases that point at the same target agree, even across libraries — the common, safe case. An
  // early version called every re-keyed variable a conflict, which would have cried wolf on the whole file.
  const vars = {
    collections: [{ name: "Sem", key: "screen-sem", modes: ["Dark"], default: "Dark" }],
    variables: [{ name: "Text/Main", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" } } }],
  };
  const ds = { collections: DS_TOKENS.collections, variables: [{ name: "Text/Main", collection: "Sem", key: "d1", type: "COLOR", values: { Dark: { aliasOf: "Gray/900" }, Light: { aliasOf: "Gray/0" } } }] };
  const res = crossCheck({ screens: [screen("S", [])], variables: vars, tokens: ds });
  ok("[collision] two libraries that alias the same target are NOT a conflict", !has(res, "token-name-collision"));
}

// ---------------------------------------------------------------- catalog coverage of THIS screen
console.log("cross-check — does the catalog cover the screen:");
{
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "other-a", "Widget"), instance("2:2", "other-b", "Gadget"), instance("2:3", "other-b", "Gadget")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] 0% by key is a BLOCKER, not an empty success", sev(res, "catalog-covers-nothing") === "blocker");
  ok("[coverage] it counts distinct components, not instances", res.coverage.distinct === 2 && res.coverage.instances === 3);
  ok("[coverage] and says outright that a catalog-vs-map count means nothing here",
    /measures the catalog against itself/.test(get(res, "catalog-covers-nothing").message));
  ok("[coverage] it names the one Figma action that finds the owning library",
    /Go to main component/.test(get(res, "catalog-covers-nothing").message));
}
{
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "ds-btn", "Button"), instance("2:2", "other", "Widget")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] a real partial match is a warning with the real percentage",
    sev(res, "partial-catalog-coverage") === "warning" && res.coverage.localPct === 50);
}
{
  // A hit in components.library.json means both FILES consume the same third-party set — it must not
  // be folded into the local number, which is the one build-screen actually maps against.
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "lib-icon", "icons/linear/book")])],
    components: DS_COMPONENTS,
    componentsLibrary: { components: [{ name: "icons/linear/book", key: "lib-icon", type: "COMPONENT" }] },
  });
  ok("[coverage] a library-catalog hit does NOT count towards local coverage",
    res.coverage.matchedByKey === 1 && res.coverage.matchedByLocalKey === 0 && res.coverage.localPct === 0);
  ok("[coverage] and the blocker still fires, saying what the library hit actually means",
    sev(res, "catalog-covers-nothing") === "blocker" && /same third-party set/.test(get(res, "catalog-covers-nothing").message));
}
{
  // Name fallback: a unique name with overlapping props is a LEAD. An ambiguous one is a coin flip
  // and is deliberately left unmatched — `Header` exists twice in the catalog.
  const res = crossCheck({
    screens: [screen("S", [instance("2:1", "x", "Button", { "Btn Text": "Go" }), instance("2:2", "y", "Header")])],
    components: DS_COMPONENTS,
  });
  ok("[coverage] a unique name + prop overlap is offered as an unverified lead", res.coverage.matchedByName === 1);
  ok("[coverage] the lead is reported ONCE for the whole set, not once per component",
    res.findings.filter((f) => f.code === "name-matched-components").length === 1);
  ok("[coverage] and every lead carries verified:false", get(res, "name-matched-components").components.every((c) => c.verified === false));
  ok("[coverage] an AMBIGUOUS name is left unmatched, not guessed",
    res.coverage.ambiguousName === 1 && has(res, "ambiguous-component-name"));
  ok("[coverage] the ambiguous warning says how many candidates there were",
    /2 candidates/.test(get(res, "ambiguous-component-name").message));
}

// ---------------------------------------------------------------- fonts and text styles
console.log("cross-check — fonts and text styles:");
{
  const res = crossCheck({
    screens: [screen("S", [text("2:1", "Poppins"), text("2:2", "Poppins"), text("2:3", "Roboto", "material-theme/label/large")])],
    stylesText: DS_TEXT_STYLES,
  });
  ok("[fonts] a minority family is reported as a stray with its count",
    has(res, "font-family-stray") && /Roboto \(1\)/.test(get(res, "font-family-stray").message));
  ok("[fonts] a font no design-system text style uses is called out separately",
    has(res, "font-not-in-design-system"));
  ok("[fonts] and the licensing question the export cannot answer is raised, not assumed",
    /licensed/.test(get(res, "font-not-in-design-system").message));
  ok("[styles] a text style absent from the design system is listed", has(res, "text-style-absent"));
}
{
  // One capital letter apart. This is a blocker because a name-based mapping binds it silently.
  const res = crossCheck({ screens: [screen("S", [text("2:1", "Poppins", "Medium/14 Medium")])], stylesText: DS_TEXT_STYLES });
  ok("[styles] a case-only near-miss is a BLOCKER, not a missing style", sev(res, "text-style-near-miss") === "blocker");
  ok("[styles] and it prints both spellings side by side",
    /'Medium\/14 Medium' vs 'Medium\/14 medium'/.test(get(res, "text-style-near-miss").message));
}

// ---------------------------------------------------------------- sentinels and single-mode exports
console.log("cross-check — sentinel values and missing modes:");
{
  const res = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS, variables: DS_TOKENS });
  ok("[sentinel] a radius of 1e9 is reported as a sentinel, not a measurement", has(res, "sentinel-token-value"));
  ok("[sentinel] it is reported ONCE even though both inputs carry the same variable",
    get(res, "sentinel-token-value").tokens.length === 1);
  ok("[sentinel] and it names each platform's real idiom instead of a number",
    /9999px or 50%/.test(get(res, "sentinel-token-value").message) && /infinity/.test(get(res, "sentinel-token-value").message));
}
{
  const res = crossCheck({ screens: [screen("S", [])], tokens: DS_TOKENS });
  ok("[modes] a two-mode collection exported only in Dark is flagged", has(res, "single-mode-export"));
  ok("[modes] the message names the modes that were never rendered",
    /'Light'/.test(get(res, "single-mode-export").message));
  ok("[modes] and warns that a derived mode can be mechanically right and visually broken",
    /visually broken/.test(get(res, "single-mode-export").message));
}

// ---------------------------------------------------------------- the mode nobody ever saw
console.log("cross-check — contrast in a mode that was derived, not drawn:");
{
  // The live case: `Backgrounds/Side menu` stays a DARK surface in Light while the sidebar's own
  // label token flips to a dark gray, so the derived Light sidebar's nav labels are near-invisible.
  // Mechanically correct, visually broken, and nothing in the toolchain looked.
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Backgrounds/Side menu", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#2b2b4f" } },
      { name: "Neutrals/Neutral 500", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#d4d4d4", Light: "#46464f" } },
    ],
  };
  const sidebar = {
    type: "FRAME", id: "1:1", name: "Side menu", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Backgrounds/Side menu" },
    children: [text("2:1", "Poppins", null, "Neutrals/Neutral 500")],
  };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [sidebar] }, label: "S" }], variables: vars });
  ok("[contrast] a derived mode's unreadable pair is a BLOCKER", sev(res, "derived-mode-contrast") === "blocker");
  ok("[contrast] it names the mode that was never drawn, not the one that was",
    get(res, "derived-mode-contrast").mode === "Light");
  ok("[contrast] and reports the actual ratio, not a verdict",
    get(res, "derived-mode-contrast").pairs[0].ratio < 4.5 && get(res, "derived-mode-contrast").pairs[0].ratio > 1);
  ok("[contrast] the fix it asks for is a designer answer or a real frame, never an invented override",
    /Do not invent an override/.test(get(res, "derived-mode-contrast").message));
}
{
  // The mode that WAS exported already has a strictly better check in audit.js, which walks the real
  // composited backgrounds. Reporting it here just re-raises that check's known false positives.
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Dark: "#121319", Light: "#ffffff" } },
      { name: "Fg", collection: "Sem", key: "t1", type: "COLOR", values: { Dark: "#131320", Light: "#000000" } },
    ],
  };
  const frame = { type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Dark" }, tokens: { fills: "Bg" }, children: [text("2:1", "Poppins", null, "Fg")] };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] the mode that WAS rendered is left to the audit's composited check", !has(res, "derived-mode-contrast"));
}
{
  const vars = {
    collections: [{ name: "Sem", key: "c1", modes: ["Only"], default: "Only" }],
    variables: [{ name: "Bg", collection: "Sem", key: "b1", type: "COLOR", values: { Only: "#000000" } }],
  };
  const frame = { type: "FRAME", id: "1:1", name: "F", resolvedModes: { Sem: "Only" }, tokens: { fills: "Bg" }, children: [] };
  const res = crossCheck({ screens: [{ doc: { screen: "S", nodes: [frame] }, label: "S" }], variables: vars });
  ok("[contrast] a single-mode system derives nothing, so it is never warned about", !has(res, "derived-mode-contrast"));
}

// ---------------------------------------------------------------- honesty about what it could not do
console.log("cross-check — what it could NOT check:");
{
  const res = crossCheck({ screens: [screen("S", [instance("2:1", "a", "Widget")])] });
  ok("[gaps] with no design system, the gap is REPORTED rather than passing quietly", res.notChecked.length >= 2);
  ok("[gaps] and no false clean verdict is emitted", !has(res, "token-library-matches") && !has(res, "catalog-covers-screen"));
  ok("[gaps] the markdown renders the gaps under their own heading", /## Not checked/.test(toMarkdown(res)));
  ok("[gaps] markdown says these are input gaps, not clean results", /gaps in the INPUT/.test(toMarkdown(res)));
}

// ---------------------------------------------------------------- drift-lint's screen coverage
console.log("drift-lint — coverage of the screen, not of the catalog:");
{
  const map = { components: { Button: { figma: { key: "ds-btn", name: "Button" } } } };
  const doc = { nodes: [{ type: "FRAME", id: "1:1", children: [instance("2:1", "other-a", "Widget"), instance("2:2", "other-a", "Widget")] }] };
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a map covering the whole catalog can still cover 0% of the screen",
    cov.distinct === 1 && cov.inMap === 0 && cov.mapPct === 0);
  ok("[screen-cov] instances are counted separately from distinct components", cov.instances === 2);
  ok("[screen-cov] the unmapped list names the component and how often it appears",
    cov.unmapped.length === 1 && cov.unmapped[0].setName === "Widget" && cov.unmapped[0].instances === 2);
}
{
  const map = { components: { Button: { figma: { key: "ds-btn", name: "Button" } } } };
  const doc = { nodes: [{ type: "FRAME", id: "1:1", children: [instance("2:1", "ds-btn", "Button"), instance("2:2", "other", "Widget")] }] };
  const cov = screenCoverage(map, DS_COMPONENTS, [doc]);
  ok("[screen-cov] a real half-match reports 50%, in the map and in the catalog", cov.mapPct === 50 && cov.catalogPct === 50);
}

// ---------- drift-lint SCREEN COVERAGE says how much of "the screen" is hidden (P2a, 107/139/185) ----------
// The real Global Policies export: 87 instances, 45 of them on layers the designer switched off. The
// coverage line keeps its numbers (it is map/catalog coverage by key) but must say how many of those
// instances — and which whole sets — will never be built, and that it is NOT a build-coverage number.
{
  const fs = require("fs");
  const path = require("path");
  const gp = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "livetest3", "verify", "System_Configurations__1359_21337.json"), "utf8"));
  const cov = screenCoverage({ components: {} }, { components: [] }, [gp]);
  ok("[drift-lint wording] instances are still counted in full (87), with the 45 on hidden layers named", cov.instances === 87 && cov.hiddenInstances === 45);
  ok("[drift-lint wording] sets that appear ONLY on hidden layers are counted (never built)", cov.hiddenOnly > 0 && cov.hiddenOnly < cov.distinct);
  const os = require("os");
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p2a-drift-"));
  fs.writeFileSync(path.join(tmp, "map.json"), JSON.stringify({ components: {} }));
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "design-to-code", "drift-lint.js"), path.join(tmp, "map.json"),
    path.join(__dirname, "fixtures", "livetest3", "design-system", "components.local.json"),
    "--screen", path.join(__dirname, "fixtures", "livetest3", "verify", "System_Configurations__1359_21337.json")], { encoding: "utf8" });
  ok("[drift-lint wording] the printed line names the hidden instances and says it measures reuse by key, not what the build contains",
    /SCREEN COVERAGE: \d+\/\d+ .* 87 instance\(s\) total, 45 of them on hidden layers/.test(r.stderr) && /not which ones the build contains/.test(r.stderr));
}

// ---------- cross-check never cites a hidden layer (P2a; hidden.js predicate in both walks) ----------
// Real Job Roles export (test/fixtures/livetest3/verify/). Before: `walkWithBg` skipped
// `visible === false` (a flag the export never sets) and the token-usage walk skipped nothing, so
// `token-name-collision` cited the hidden `I20173:137670;1929:15178` / `;1929:15308` buttons and the
// derived-mode contrast check graded hidden text.
{
  const fs = require("fs");
  const path = require("path");
  const FXL = path.join(__dirname, "fixtures", "livetest3");
  const jr = JSON.parse(fs.readFileSync(path.join(FXL, "verify", "positions___7314_87192.json"), "utf8"));
  const hidden = new Set();
  (function w(n, h) { h = h || !!n.hidden; if (h && n.id) hidden.add(n.id); for (const c of n.children || []) w(c, h); })({ children: jr.nodes }, false);
  const citesHidden = (f) => { let hit = false; JSON.stringify(f, (k, v) => { if (typeof v === "string" && hidden.has(v)) hit = true; return v; }); return hit; };
  const rd = (p) => JSON.parse(fs.readFileSync(path.join(FXL, p), "utf8"));
  const tokRes = crossCheck({ screens: [{ doc: jr, label: "positions___7314_87192" }],
    variables: rd("pages/__Organization_management_/positions___7314_87192.vars.json"), tokens: rd("design-system/tokens.json"),
    components: rd("design-system/components.local.json"), componentsLibrary: rd("design-system/components.library.json") });
  ok("[hidden] token findings on the real Job Roles export cite no hidden node", tokRes.findings.length > 0 && !tokRes.findings.some(citesHidden));
  // Derived-mode contrast. The export was rendered in 'Semantic Variables 01' = Dark (root.resolvedModes);
  // a 'Dim' mode (rendered nowhere — note 'Light' IS rendered, by the 'Default' collection) is declared
  // and both pairs are given a 1:1 contrast there. Pair A
  // ('Text/Description' on 'Backgrounds/Page Color') is used ONLY by hidden text (7 nodes); pair B
  // ('Text/Main Titles' on 'Backgrounds/Table header') only by visible text (5 nodes) — the control.
  const vars = {
    collections: [{ name: "Semantic Variables 01", modes: ["Dark", "Dim"] }],
    variables: [
      { name: "Text/Description", values: { Dim: "#1d1d1f" } }, { name: "Backgrounds/Page Color", values: { Dim: "#1d1d1f" } },
      { name: "Text/Main Titles", values: { Dim: "#46464f" } }, { name: "Backgrounds/Table header", values: { Dim: "#46464f" } },
    ],
  };
  const c = crossCheck({ screens: [{ doc: jr, label: "positions___7314_87192" }], variables: vars });
  const dm = c.findings.find((f) => f.code === "derived-mode-contrast");
  ok("[hidden] derived-mode contrast still fires on VISIBLE text (the check is not dead)", !!dm && dm.pairs.some((p) => p.fg === "Text/Main Titles"));
  ok("[hidden] …and never grades a pair used only by hidden text, nor cites a hidden node", !!dm && !dm.pairs.some((p) => p.fg === "Text/Description") && !citesHidden(dm));
}

// ---------------------------------------------------------------- CLI: auto-discovery of variables.json (P4 #38/#39/#138) ----------
// Real layout: test/fixtures/livetest3/pages/<Page>/<Screen>.json + test/fixtures/livetest3/variables.json
// (the export root, two levels up from the screen file) — the same shape design/export/ has in a real
// project. Before the fix, the CLI looked in path.dirname(argv[0]) (the <Page> directory) and never
// found the export-root file, so every invocation without an explicit --variables reported "not
// checked". After the fix it is found automatically and the path used is printed on stderr.
{
  const path = require("path");
  const { spawnSync } = require("child_process");
  const FXL = path.join(__dirname, "fixtures", "livetest3");
  const screen = path.join(FXL, "pages", "__Organization_management_", "positions___7314_87192.json");
  const dsDir = path.join(FXL, "design-system");
  const withoutFlag = spawnSync(process.execPath, [path.join(__dirname, "..", "design-to-code", "cross-check.js"),
    screen, "--design-system", dsDir, "--json"], { encoding: "utf8" });
  const withFlag = spawnSync(process.execPath, [path.join(__dirname, "..", "design-to-code", "cross-check.js"),
    screen, "--design-system", dsDir, "--variables", path.join(FXL, "variables.json"), "--json"], { encoding: "utf8" });
  ok("[cli-autodiscover] no --variables prints which path it auto-discovered", withoutFlag.stderr.includes(path.join(FXL, "variables.json")));
  const resNoFlag = JSON.parse(withoutFlag.stdout);
  const resFlag = JSON.parse(withFlag.stdout);
  ok("[cli-autodiscover] auto-discovery reports the SAME blocker count as passing --variables explicitly",
    resNoFlag.summary.blockers === resFlag.summary.blockers && resNoFlag.summary.warnings === resFlag.summary.warnings);
  ok("[cli-autodiscover] the stale-wording bug is gone: never says 'no design/variables.json was given' while one exists",
    !withoutFlag.stdout.includes("no design/variables.json was given"));
}


// ---------- livetest-3 #318 / #326 on the REAL export (test/fixtures/livetest3/) ----------
{
  const fs = require("fs");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const FX = path.join(__dirname, "fixtures", "livetest3");
  const run = (rel) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "design-to-code", "cross-check.js"), path.join(FX, rel), "--design-system", path.join(FX, "design-system"), "--json"], { encoding: "utf8" });
    try { return JSON.parse(r.stdout); } catch (e) { return { coverage: {}, findings: [] }; }
  };
  // What the build sees: the distinct component sets of VISIBLE instances, and the sets used only on
  // hidden layers — computed here from the fixture itself, not from the tool's own counters.
  const sets = (rel) => {
    const doc = JSON.parse(fs.readFileSync(path.join(FX, rel), "utf8"));
    const vis = new Set(), all = new Set();
    const w = (n, hid) => {
      const h = hid || n.hidden === true || n.visible === false;
      if (n.type === "INSTANCE" && n.mainComponent) { const k = n.mainComponent.setKey || n.mainComponent.key; all.add(k); if (!h) vis.add(k); }
      for (const c of n.children || []) w(c, h);
    };
    for (const r of doc.nodes) w(r, false);
    return { visible: vis.size, hiddenOnly: [...all].filter((k) => !vis.has(k)).length };
  };
  for (const [label, rel] of [["Job Roles", "pages/__Organization_management_/positions___7314_87192.json"], ["Global Policies", "pages/__Organization_management_/System_Configurations__1359_21337.json"]]) {
    const res = run(rel), truth = sets(rel);
    const b = res.coverage.buckets || {};
    const sum = Object.values(b).reduce((n, x) => n + x, 0);
    ok(`[318] ${label}: every visible component set lands in exactly ONE bucket — the rows sum to the ${truth.visible} sets the screen really has`,
      truth.visible > 0 && res.coverage.distinct === truth.visible && sum === truth.visible
        && (res.coverage.entries || []).every((e) => typeof e.bucket === "string") && (res.coverage.entries || []).length === truth.visible);
    ok(`[318] ${label}: sets used only on hidden layers are reported apart (${truth.hiddenOnly}), not mixed into the buckets`,
      res.coverage.hiddenOnly === truth.hiddenOnly);
    ok(`[318] ${label}: no name is both a proposal and "new work" or an ambiguous leftover`,
      (res.componentProposals || []).every((p) => !(res.coverage.entries || []).some((e) => e.setName === p.name && e.bucket !== "proposed")));
  }
  const cat = run("pages/In_progress/Create_Activity_Type__18411_84111.json");
  const s4 = cat.findings.find((f) => f.code === "token-name-collision" && f.token === "Space 4");
  ok("[326] an identical-name collision names BOTH subjects: \"The screen's 'Space 4' (key …) and the design system's 'Space 4' share a name\"",
    !!s4 && /^The screen's 'Space 4' \(key 64928e3a…\) and the design system's 'Space 4' share a name but resolve DIFFERENTLY/.test(s4.message));
}

report();
