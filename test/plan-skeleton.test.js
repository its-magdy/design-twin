// Offline tests for design-to-code/plan-skeleton.js — the build-screen plan, generated from the export
// (livetest-3 §2.9 f; P2b). Driven by test/fixtures/livetest3/plan/, the live run's real export pruned
// by its build.js (visibility, bindings and instances are the export's own — see the counts below).
//   node test/plan-skeleton.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { skeleton, merge, visibility } = require("../design-to-code/plan-skeleton");
const { check, report } = require("./assert");

const SKEL = require.resolve("../design-to-code/plan-skeleton.js");
const BUNDLE = path.join(__dirname, "..", "claude-plugin", "scripts", "plan-skeleton.js");
const FX = path.join(__dirname, "fixtures", "livetest3", "plan");
const PAGE = path.join(FX, "export", "pages", "__Organization_management_");
const DS = path.join(FX, "export", "design-system");
const JR = "positions___7314_87192", GP = "System_Configurations__1359_21337";
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const run = (args, opts) => spawnSync(process.execPath, [SKEL, ...args], Object.assign({ encoding: "utf8", cwd: FX }, opts));
const screen = (s) => path.join(PAGE, s + ".json");
const vars = (s) => path.join(PAGE, s + ".vars.json");

// The independent answer: every id that is hidden or under a hidden ancestor, straight off the JSON.
function hiddenIds(doc) {
  const out = new Set();
  (function walk(n, h) { h = h || n.hidden === true; if (h && n.id) out.add(n.id); for (const c of n.children || []) walk(c, h); })({ children: doc.nodes }, false);
  return out;
}

console.log("acceptance (§2.9 f) — the skeleton for 7314:87192 (Job Roles):");
const jrDoc = read(screen(JR));
const r = run([screen(JR), vars(JR), DS]);
const plan = JSON.parse(r.stdout);
const hid = hiddenIds(jrDoc);
check(`45 tokens — every variable the screen binds (PHASE2-TOKENS.md: 45 distinct) — got ${plan.tokens.length}`, r.status === 0 && plan.tokens.length === 45);
check(`51 visible instances (scripts-test/out/components/mapping.md: 51) — got ${plan.components.length}`, plan.components.length === 51);
check(`0 hidden ids in anchors{} (of ${hid.size} hidden nodes in the export)`, hid.size === 129 && Object.keys(plan.anchors).filter((id) => hid.has(id)).length === 0);
check("anchors{} holds EVERY visible node — 254 = 383 nodes − 129 hidden — each with mapModule empty",
  Object.keys(plan.anchors).length === 254 && Object.values(plan.anchors).every((a) => a.mapModule === "" && a.name !== undefined && a.type));
check("0 hidden instances in components[] (the export has 112 instances, 61 of them hidden)", plan.components.every((c) => !hid.has(c.nodeId)));
check("hidden[] lists the roots of the hidden subtrees, and they account for all 129 hidden nodes",
  plan.hidden.length > 0 && plan.hidden.every((h) => hid.has(h.id)) && plan.hidden.reduce((a, h) => a + h.nodes, 0) === 129);
check("stderr states the counts", /45 bound token\(s\) \(33 on visible nodes\), 51 visible instance\(s\), 254 visible node anchor slot\(s\), 129 hidden node\(s\) excluded/.test(r.stderr));

console.log("the P3 header — so every other skill can find the plan:");
check("screenName / nodeId / file are written; route is left for the builder",
  plan.nodeId === "7314:87192" && plan.screenName === "positions" && plan.file === "export/pages/__Organization_management_/positions___7314_87192.json" && plan.route === null && plan.status === "pending");
check("--route fills it", JSON.parse(run([screen(JR), vars(JR), DS, "--route", "/job-roles"]).stdout).route === "/job-roles");

console.log("tokens[] — keyed by Figma key, valued in the frame's own mode:");
const tok = (n) => plan.tokens.find((t) => t.figmaName === n);
check("`Space 4` is key e26d506e… = 24 (the screen's own variable — NOT the 16 a name lookup in the merged file gives)",
  /^e26d506e/.test(tok("Space 4").key) && tok("Space 4").value === 24 && tok("Space 4").kind === "spacing");
check("an aliased colour resolves through its alias in the frame's mode (Backgrounds/Side menu → #121319, Dark)",
  tok("Backgrounds/Side menu").value === "#121319" && tok("Backgrounds/Side menu").mode === "Dark" && tok("Backgrounds/Side menu").kind === "color");
check("`Space 2` — two variables of that name in the screen's own .vars.json — is not given a guessed key",
  tok("Space 2").key === null && tok("Space 2").keyCandidates.length === 2 && /same value/.test(tok("Space 2").note));
check("the 12 tokens bound only by hidden layers are pre-marked verdict \"hidden-only\" (33 visible + 12 = 45)",
  plan.tokens.filter((t) => t.verdict === "hidden-only").length === 12 && plan.tokens.filter((t) => t.sites.visible > 0).length === 33
  && plan.tokens.filter((t) => t.verdict === "hidden-only").every((t) => t.sites.visible === 0));
check("every other row leaves codeToken/verdict for the model", plan.tokens.filter((t) => t.sites.visible).every((t) => t.codeToken === null && t.verdict === null));
check("the design-system definition is attached, labelled with HOW it matched",
  tok("Medium").designSystem.match === "key" && tok("Backgrounds/Side menu").designSystem.match === "name" && tok("(Space 3)").designSystem === null);

console.log("components[] — identity from the catalog, never from a hand-placed attribute (finding 79):");
const names = new Set(plan.components.map((c) => c.name));
const matched = new Set(plan.components.filter((c) => c.catalog).map((c) => c.name));
check(`41 distinct components, 26 matched to the NERA catalog by name+prop signature (P1's matcher; mapping.json agrees 26/15) — got ${names.size}/${matched.size}`,
  names.size === 41 && matched.size === 26 && plan.components.filter((c) => c.catalog).every((c) => c.catalog.by !== "key" && c.catalog.confirmed === false));
const first = plan.components[0];
check("each row carries key/setKey/name/variant/props and an empty mapModule/verdict to fill",
  first.nodeId === "10970:111588" && first.key && first.setKey && first.name === "Component 1" && first.variant && first.mapModule === "" && first.verdict === null);
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-skel-"));
  const map = path.join(dir, "codeconnect.local.json");
  fs.writeFileSync(map, JSON.stringify({ version: 1, components: { [first.key]: { figma: { key: first.key, name: "Component 1" }, code: { module: "app/src/layout/Sidebar.tsx", export: "Sidebar" }, status: "confirmed" } } }));
  const p = JSON.parse(run([screen(JR), vars(JR), DS, "--map", map]).stdout);
  check("--map: an instance whose key is mapped in codeconnect.local.json gets that module pre-filled",
    p.components[0].mapped.module === "app/src/layout/Sidebar.tsx" && p.components[0].mapModule === "app/src/layout/Sidebar.tsx");
}

console.log("determinism, merge, and the second screen:");
check("byte-identical output on the same input (no timestamps of its own)", run([screen(JR), vars(JR), DS]).stdout === r.stdout);
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-skel-"));
  const out = path.join(dir, "plan.json");
  run([screen(JR), vars(JR), DS, "--out", out]);
  const filled = read(out);
  filled.tokens.find((t) => t.figmaName === "Space 4").codeToken = "spacing-figma-space-4";
  filled.tokens.find((t) => t.figmaName === "Space 4").verdict = "exact";
  filled.components[0].mapModule = "app/src/layout/Sidebar.tsx";
  filled.anchors["7314:87192"].mapModule = "app/src/features/job-roles/screens/JobRolesScreen.tsx";
  filled.files = ["app/src/features/job-roles/screens/JobRolesScreen.tsx"];
  filled.route = "/job-roles";
  filled.verification = { mode: "static-only", reason: "x" };
  fs.writeFileSync(out, JSON.stringify(filled));
  const again = run([screen(JR), vars(JR), DS, "--out", out]);
  const m = read(out);
  check("re-running --out MERGES: every filled field and every top-level field it does not own survives",
    again.status === 0 && /merged into/.test(again.stderr) && m.tokens.find((t) => t.figmaName === "Space 4").codeToken === "spacing-figma-space-4"
    && m.components[0].mapModule === "app/src/layout/Sidebar.tsx" && m.anchors["7314:87192"].mapModule.endsWith("JobRolesScreen.tsx")
    && m.files.length === 1 && m.route === "/job-roles" && m.verification.mode === "static-only" && m.tokens.length === 45);
  fs.writeFileSync(out, "{ not json");
  check("an existing plan that is not JSON is never overwritten", run([screen(JR), vars(JR), DS, "--out", out]).status === 1 && fs.readFileSync(out, "utf8") === "{ not json");
}
{
  const gp = JSON.parse(run([screen(GP), vars(GP), DS]).stdout);
  const gh = hiddenIds(read(screen(GP)));
  check(`Global Policies (1359:21337): 50 tokens (PHASE2-TOKENS.md: 50), 42 visible instances, 207 anchors, 0 hidden — got ${gp.tokens.length}/${gp.components.length}/${Object.keys(gp.anchors).length}`,
    gp.tokens.length === 50 && gp.components.length === 42 && Object.keys(gp.anchors).length === 207 && Object.keys(gp.anchors).every((id) => !gh.has(id)));
}
check("visibility() never reads `visible` — a component PROPERTY called \"visible\" does not hide a node (finding 34)", (() => {
  const v = visibility({ nodes: [{ id: "1:1", type: "FRAME", children: [{ id: "1:2", type: "INSTANCE", props: { visible: "Show Breadcrumb" }, visible: false }, { id: "1:3", hidden: true, children: [{ id: "1:4" }] }] }] });
  return v.visible.has("1:2") && !v.visible.has("1:3") && v.hidden.has("1:4") && v.hiddenRoots.length === 1 && v.hiddenRoots[0].nodes === 2;
})());

console.log("CLI:");
const help = run(["--help"]);
check("--help prints usage and exits 0", help.status === 0 && /usage: node plan-skeleton\.js <screen\.json> <screen\.vars\.json> <design-system dir>/.test(help.stdout));
check("an unknown flag is refused (exit 2), not swallowed", run([screen(JR), vars(JR), DS, "--output", "x"]).status === 2);
check("wrong arity is refused (exit 2)", run([screen(JR)]).status === 2);
{
  const nods = run([screen(JR), vars(JR), path.join(FX, "no-such-dir")]);
  const p = JSON.parse(nods.stdout);
  check("a missing design-system dir (single-screen pull) still works — values from the screen's own .vars.json, no catalog, and stderr says so",
    nods.status === 0 && /no design-system directory/.test(nods.stderr) && p.tokens.length === 45 && p.components.every((c) => c.catalog === null) && p.tokens.every((t) => t.designSystem === null));
}
check("the shipped bundle runs from outside the repo", (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-plugin-"));
  fs.copyFileSync(BUNDLE, path.join(dir, "plan-skeleton.js"));
  const b = spawnSync(process.execPath, [path.join(dir, "plan-skeleton.js"), screen(JR), vars(JR), DS], { encoding: "utf8", cwd: FX });
  return b.status === 0 && b.stdout === r.stdout;
})());

// ---------------------------------------------------------------- P6-136: auditGate pre-fill
// Real audit: FX/design/audit/System_Configurations.json (5 blockers, copied verbatim from the
// livetest-3 run). Global Policies (System_Configurations__1359_21337) is the screen it belongs to.
console.log("finding 136 — auditGate is pre-filled from an existing Blocked audit:");
{
  const auditCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-cwd-"));
  fs.mkdirSync(path.join(auditCwd, "design", "audit"), { recursive: true });
  fs.copyFileSync(path.join(FX, "audit", "System_Configurations.json"), path.join(auditCwd, "design", "audit", "System_Configurations.json"));
  const gp = run([screen(GP), vars(GP), DS], { cwd: auditCwd });
  const p = JSON.parse(gp.stdout);
  check("[P6-136] a screen with a Blocked audit on disk gets auditGate pre-filled: auditFile, verdict, every blocker id, overridden empty",
    gp.status === 0 && p.auditGate && p.auditGate.auditFile === "design/audit/System_Configurations.json" && p.auditGate.verdict === "blocked"
      && p.auditGate.blockers.length === 5 && Array.isArray(p.auditGate.overridden) && p.auditGate.overridden.length === 0 && p.auditGate.reason === null);
  check("[P6-136] a screen with no matching audit (Job Roles: no design/audit/positions*.json in this fixture) gets auditGate: null", JSON.parse(r.stdout).auditGate === null);

  // merge(): a person's decision (overridden/reason/decidedBy/decidedAt) survives a re-run — the
  // skeleton must never clear what was already decided.
  const decided = Object.assign({}, p, { auditGate: Object.assign({}, p.auditGate, { overridden: p.auditGate.blockers, reason: "provenance issues, not build issues", decidedBy: "owner", decidedAt: "2026-09-23" }) });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-plan-"));
  const planFile = path.join(out, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(decided, null, 2));
  const merged = run([screen(GP), vars(GP), DS, "--out", planFile], { cwd: auditCwd });
  const after = JSON.parse(fs.readFileSync(planFile, "utf8"));
  check("[P6-136] a re-run (--out onto an existing plan) keeps the decided overridden/reason/decidedBy — never clears it",
    merged.status === 0 && after.auditGate.overridden.length === 5 && after.auditGate.reason === "provenance issues, not build issues" && after.auditGate.decidedBy === "owner");
}

report();
