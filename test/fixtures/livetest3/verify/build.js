// Build test/fixtures/livetest3/verify/ from livetest-3's REAL artefacts (P2a — verify-screen / audit
// hidden-layer and comparison regressions). Nothing here is hand-typed except where a number exists
// only in the run's prose report; those carry the file:line they were copied from.
//
//   node test/fixtures/livetest3/verify/build.js [/path/to/design-twin-livetest-3]
//
// 1. The two screen exports, EVERY node kept (the hidden-layer counts depend on the whole tree), with
//    only the fields no verifier/audit reads dropped. The build asserts that verify-screen --expect
//    and audit.js give byte-identical results on the pruned and the full file, so pruning cannot
//    change what the tests see.
// 2. The real probe outputs: design/verify/{JobRoles,GlobalPolicies}.measured.json (notes dropped).
// 3. GlobalPolicies.dom.json: the independent Playwright pass over the running Global Policies build
//    (scripts-test/out/phase6/global-policies/measured-independent.json — tag, x/y, svgFill,
//    ::placeholder colour, hover state, row gap), trimmed to what the tests read.
// 4. prefix-positions.json: two positions that exist only in the run's reports.
const fs = require("fs");
const path = require("path");
const L = process.argv[2] || "/Users/mohamedomarwork/design-twin-livetest-3";
const OUT = __dirname;
const P = path.join(L, "design/export/pages/__Organization_management_");
const SCREENS = ["positions___7314_87192", "System_Configurations__1359_21337"];
const DROP = new Set(["overrides", "propRefs", "exposedInstances", "pin", "gridColumnStart", "gridRowStart", "variableModes", "resolvedModes", "exportSettings", "layoutGrids", "flipped", "aspectRatio", "strokesInLayout"]);
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f, v) => { fs.writeFileSync(path.join(OUT, f), JSON.stringify(v) + "\n"); console.log("wrote", f, fs.statSync(path.join(OUT, f)).size, "bytes"); };

const prune = (n) => {
  const o = {};
  for (const [k, v] of Object.entries(n)) if (!DROP.has(k) && k !== "children") o[k] = v;
  if (Array.isArray(n.children)) o.children = n.children.map(prune);
  return o;
};
const { buildExpectation } = require("../../../../design-to-code/verify-screen.js");
const { audit } = require("../../../../design-to-code/audit.js");
for (const s of SCREENS) {
  const full = read(path.join(P, s + ".json"));
  const pruned = { exportedAt: full.exportedAt, screen: full.screen, page: full.page, pageId: full.pageId, nodeId: full.nodeId, manifest: full.manifest, nodes: full.nodes.map(prune) };
  const a = JSON.stringify(buildExpectation([{ doc: full, label: s }]));
  const b = JSON.stringify(buildExpectation([{ doc: pruned, label: s }]));
  if (a !== b) throw new Error(`${s}: pruning changed the expectation`);
  const fa = JSON.stringify(audit([{ doc: full, label: s }], { platform: "web" }));
  const fb = JSON.stringify(audit([{ doc: pruned, label: s }], { platform: "web" }));
  if (fa !== fb) throw new Error(`${s}: pruning changed the audit`);
  write(s + ".json", pruned);
}

for (const s of ["JobRoles", "GlobalPolicies"]) {
  const m = read(path.join(L, "design/verify", s + ".measured.json"));
  delete m.notes;
  write(s + ".measured.json", m);
}

const ind = read(path.join(L, "scripts-test/out/phase6/global-policies/measured-independent.json"));
write("GlobalPolicies.dom.json", {
  source: "scripts-test/out/phase6/global-policies/measured-independent.json (livetest-3, Playwright 1440x1236, frame at the viewport origin)",
  checks: ind.checks.map((c) => ({ designId: c.designId, sel: c.sel, measured: c.measured })),
  hoverState: ind.hoverState,
  measuredRowGap: ind.measuredRowGap,
});

write("prefix-positions.json", {
  "20173:142142": { what: "Job Roles pagination bar, pre-fix build: bottom edge at y=1366 in a 1236-high frame, height 24", y: 1342, height: 24, width: 1112,
    source: "FIDELITY-job-roles.md:38 ('the pagination bar's bottom edge is at y = 1366 in a 1236-high frame'); height/width from design/verify/JobRoles.measured.json" },
  "18580:60861": { what: "Global Policies 'Status' header, pre-fix build: frame-relative INK x of a Range over the text", textBoxX: 1315.75,
    source: "FIDELITY-global-policies.md:231 ('header ink x — Status | 1296.81 | 1315.75 | FAIL (+18.94)')" },
});
