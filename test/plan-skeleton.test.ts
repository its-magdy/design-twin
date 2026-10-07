// Offline tests for design-to-code/plan-skeleton.ts — the build-screen plan, generated from the export
// (livetest-3 §2.9 f; P2b). Driven by test/fixtures/livetest3/plan/, the live run's real export pruned
// by its build.ts (visibility, bindings and instances are the export's own — see the counts below).
//   node test/plan-skeleton.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { visibility, buildTokens } from "../design-to-code/plan-skeleton.ts";
import { check, report } from "./assert.ts";
import { malformed, must, node, parseAs, readFixture, screenExport, tokens } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { isPlan } from "../design-to-code/doc-guards.ts";
import type { DocGuard } from "../design-to-code/doc-guards.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { SkeletonPlan } from "../design-to-code/plan-skeleton.ts";
import type { IrNode, ScreenExport } from "../design-to-code/types.ts";

const SKEL = path.join(import.meta.dirname, "..", "design-to-code", "plan-skeleton.ts");
const BUNDLE = path.join(import.meta.dirname, "..", "claude-plugin", "scripts", "plan-skeleton.js");
const FX = path.join(import.meta.dirname, "fixtures", "livetest3", "plan");
const PAGE = path.join(FX, "export", "pages", "__Organization_management_");
const DS = path.join(FX, "export", "design-system");
const JR = "positions___7314_87192", GP = "System_Configurations__1359_21337";
// Files this repo wrote (the fixture export, or a plan the skeleton just wrote) — checked as what they are.
const read = <T,>(f: string, guard: DocGuard<T>): T => readFixture(f, guard);
// A plan as plan-skeleton writes it: every skeleton-owned field present.
const isSkeletonPlan = (x: unknown): x is SkeletonPlan => isPlan(x) && Array.isArray(x.tokens) && Array.isArray(x.components) && x.anchors !== undefined && Array.isArray(x.hidden) && x.counts !== undefined
  && x.tokens.every((t) => typeof t.figmaName === "string" && isJsonObject(t.sites));
const run = (args: string[], opts?: { cwd?: string }) => spawnSync(process.execPath, [SKEL, ...args], { encoding: "utf8", cwd: FX, ...opts });
/** The skeleton's stdout / --out file. */
const planOf = (stdout: string): SkeletonPlan => parseAs(stdout, isSkeletonPlan, "plan-skeleton stdout");
const screen = (s: string) => path.join(PAGE, s + ".json");
const vars = (s: string) => path.join(PAGE, s + ".vars.json");

// The independent answer: every id that is hidden or under a hidden ancestor, straight off the JSON.
type Walkable = Pick<IrNode, "hidden" | "children"> & { id?: string };
function hiddenIds(doc: ScreenExport) {
  const out = new Set<string>();
  (function walk(n: Walkable, h: boolean) { h = h || n.hidden === true; if (h && n.id) out.add(n.id); for (const c of n.children || []) walk(c, h); })({ children: doc.nodes }, false);
  return out;
}

console.log("acceptance (§2.9 f) — the skeleton for 7314:87192 (Job Roles):");
const jrDoc = read(screen(JR), isScreenExport);
const r = run([screen(JR), vars(JR), DS]);
const plan = planOf(r.stdout);
const hid = hiddenIds(jrDoc);
check(`45 tokens — every variable the screen binds (PHASE2-TOKENS.md: 45 distinct) — got ${plan.tokens.length}`, r.status === 0 && plan.tokens.length === 45);
check(`51 visible instances (scripts-test/out/components/mapping.md: 51) — got ${plan.components.length}`, plan.components.length === 51);
check(`0 hidden ids in anchors{} (of ${hid.size} hidden nodes in the export)`, hid.size === 129 && Object.keys(plan.anchors).filter((id) => hid.has(id)).length === 0);
check("anchors{} holds EVERY visible node — 254 = 383 nodes − 129 hidden — each with mapModule empty",
  Object.keys(plan.anchors).length === 254 && Object.values(plan.anchors).every((a) => a.mapModule === "" && a.name !== undefined && a.type));
check("0 hidden instances in components[] (the export has 112 instances, 61 of them hidden)", plan.components.every((c) => !hid.has(must(c.nodeId, "component.nodeId"))));
check("hidden[] lists the roots of the hidden subtrees, and they account for all 129 hidden nodes",
  plan.hidden.length > 0 && plan.hidden.every((h) => hid.has(h.id)) && plan.hidden.reduce((a, h) => a + h.nodes, 0) === 129);
check("stderr states the counts", /45 bound token\(s\) \(33 on visible nodes\), 51 visible instance\(s\), 254 visible node anchor slot\(s\), 129 hidden node\(s\) excluded/.test(r.stderr));

console.log("tokens[] — a composed colour (colour + separate 0–100 opacity) resolves to ONE colour:");
{
  // alpha = colour alpha × opacity/100 (an inference — Figma documents the 0–100 range, not the combination
  // with a colour's own alpha), the opacity clamped to 0–100 as Figma clamps it.
  const composedVars = tokens({
    collections: [{ name: "C", modes: ["M"], default: "M" }],
    variables: [
      { name: "Red", collection: "C", type: "COLOR", values: { M: "#ff0000" } },
      { name: "Op", collection: "C", type: "FLOAT", scopes: ["COLOR_OPACITY"], values: { M: 60 } },
      { name: "A", collection: "C", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: 60 } } } },
      { name: "B", collection: "C", type: "COLOR", values: { M: { composed: { color: "#ff000080", opacity: { aliasOf: "Op" } } } } },
      { name: "D", collection: "C", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: 120 } } } },
      { name: "E", collection: "C", type: "COLOR", values: { M: { composed: { color: { aliasOf: "Red" }, opacity: { aliasOf: "Gone" } } } } },
    ],
  });
  const doc = { screen: "S", nodes: ["A", "B", "D", "E"].map((n, i) => node({ id: `1:${i}`, type: "RECTANGLE", name: n, tokens: { fills: n } })) };
  const rows = buildTokens(doc, composedVars, null, { C: "M" });
  const val = (n: string) => rows.find((t) => t.figmaName === n)?.value;
  check("colour alias + opacity 60: #ff0000 at alpha 0.6 (0x99)", val("A") === "#ff000099");
  check("#ff000080 (alpha ~0.5) + opacity alias -> 60: alpha ~0.3 (0x4d), multiplied", val("B") === "#ff00004d");
  check("opacity 120 clamps to 100: the colour, opaque", val("D") === "#ff0000");
  check("an opacity alias that does not resolve stays null", val("E") === null);
}

console.log("the P3 header — so every other skill can find the plan:");
check("screenName / nodeId / file are written; route is left for the builder",
  plan.nodeId === "7314:87192" && plan.screenName === "positions" && plan.file === "export/pages/__Organization_management_/positions___7314_87192.json" && plan.route === null && plan.status === "pending");
check("--route fills it", planOf(run([screen(JR), vars(JR), DS, "--route", "/job-roles"]).stdout).route === "/job-roles");

console.log("tokens[] — keyed by Figma key, valued in the frame's own mode:");
const tok = (n: string) => must(plan.tokens.find((t) => t.figmaName === n), `plan.tokens with figmaName '${n}'`);
check("`Space 4` is key e26d506e… = 24 (the screen's own variable — NOT the 16 a name lookup in the merged file gives)",
  /^e26d506e/.test(String(tok("Space 4").key)) && tok("Space 4").value === 24 && tok("Space 4").kind === "spacing");
check("an aliased colour resolves through its alias in the frame's mode (Backgrounds/Side menu → #121319, Dark)",
  tok("Backgrounds/Side menu").value === "#121319" && tok("Backgrounds/Side menu").mode === "Dark" && tok("Backgrounds/Side menu").kind === "color");
check("`Space 2` — two variables of that name in the screen's own .vars.json — is not given a guessed key",
  tok("Space 2").key === null && tok("Space 2").keyCandidates?.length === 2 && /same value/.test(String(tok("Space 2").note)));
check("the 12 tokens bound only by hidden layers are pre-marked verdict \"hidden-only\" (33 visible + 12 = 45)",
  plan.tokens.filter((t) => t.verdict === "hidden-only").length === 12 && plan.tokens.filter((t) => t.sites.visible > 0).length === 33
  && plan.tokens.filter((t) => t.verdict === "hidden-only").every((t) => t.sites.visible === 0));
check("every other row leaves codeToken/verdict for the model", plan.tokens.filter((t) => t.sites.visible).every((t) => t.codeToken === null && t.verdict === null));
check("the design-system definition is attached, labelled with HOW it matched",
  tok("Medium").designSystem?.match === "key" && tok("Backgrounds/Side menu").designSystem?.match === "name" && tok("(Space 3)").designSystem === null);

console.log("components[] — identity from the catalog, never from a hand-placed attribute (finding 79):");
const names = new Set(plan.components.map((c) => c.name));
const matched = new Set(plan.components.filter((c) => c.catalog && c.catalog.by !== "ambiguous").map((c) => c.name)); // ambiguous (DT-27) is never a match
check(`41 distinct components, 26 matched to the NERA catalog by name+prop signature (P1's matcher; mapping.json agrees 26/15) — got ${names.size}/${matched.size}`,
  names.size === 41 && matched.size === 26 && plan.components.filter((c) => c.catalog).every((c) => !!c.catalog && c.catalog.by !== "key" && c.catalog.by !== "ambiguous" && c.catalog.confirmed === false));
const first = must(plan.components[0], "plan.components[0]");
check("each row carries key/setKey/name/variant/props and an empty mapModule/verdict to fill",
  first.nodeId === "10970:111588" && !!first.key && !!first.setKey && first.name === "Component 1" && !!first.variant && first.mapModule === "" && first.verdict === null);
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-skel-"));
  const map = path.join(dir, "codeconnect.local.json");
  fs.writeFileSync(map, JSON.stringify({ version: 1, components: { [must(first.key, "first.key")]: { figma: { key: first.key, name: "Component 1" }, code: { module: "app/src/layout/Sidebar.tsx", export: "Sidebar" }, status: "active" } } }));
  const p = planOf(run([screen(JR), vars(JR), DS, "--map", map]).stdout);
  const pFirst = must(p.components[0], "p.components[0]");
  check("--map: an instance whose key is mapped in codeconnect.local.json gets that module pre-filled",
    pFirst.mapped?.module === "app/src/layout/Sidebar.tsx" && pFirst.mapModule === "app/src/layout/Sidebar.tsx");
}

console.log("determinism, merge, and the second screen:");
check("byte-identical output on the same input (no timestamps of its own)", run([screen(JR), vars(JR), DS]).stdout === r.stdout);
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-skel-"));
  const out = path.join(dir, "plan.json");
  run([screen(JR), vars(JR), DS, "--out", out]);
  const filled = read(out, isSkeletonPlan);
  const filledSpace4 = must(filled.tokens.find((t) => t.figmaName === "Space 4"), "filled.tokens 'Space 4'");
  filledSpace4.codeToken = "spacing-figma-space-4";
  filledSpace4.verdict = "exact";
  must(filled.components[0], "filled.components[0]").mapModule = "app/src/layout/Sidebar.tsx";
  must(filled.anchors["7314:87192"], "filled.anchors['7314:87192']").mapModule = "app/src/features/job-roles/screens/JobRolesScreen.tsx";
  filled.files = ["app/src/features/job-roles/screens/JobRolesScreen.tsx"];
  filled.route = "/job-roles";
  filled.verification = { mode: "static-only", reason: "x" };
  fs.writeFileSync(out, JSON.stringify(filled));
  const again = run([screen(JR), vars(JR), DS, "--out", out]);
  const m = read(out, isSkeletonPlan);
  const mAnchor = m.anchors["7314:87192"];
  check("re-running --out MERGES: every filled field and every top-level field it does not own survives",
    again.status === 0 && /merged into/.test(again.stderr) && m.tokens.find((t) => t.figmaName === "Space 4")?.codeToken === "spacing-figma-space-4"
    && m.components[0]?.mapModule === "app/src/layout/Sidebar.tsx" && mAnchor?.mapModule?.endsWith("JobRolesScreen.tsx") === true
    && m.files?.length === 1 && m.route === "/job-roles" && m.verification?.mode === "static-only" && m.tokens.length === 45);
  fs.writeFileSync(out, "{ not json");
  check("an existing plan that is not JSON is never overwritten", run([screen(JR), vars(JR), DS, "--out", out]).status === 1 && fs.readFileSync(out, "utf8") === "{ not json");
}
{
  const gp = planOf(run([screen(GP), vars(GP), DS]).stdout);
  const gh = hiddenIds(read(screen(GP), isScreenExport));
  check(`Global Policies (1359:21337): 50 tokens (PHASE2-TOKENS.md: 50), 42 visible instances, 207 anchors, 0 hidden — got ${gp.tokens.length}/${gp.components.length}/${Object.keys(gp.anchors).length}`,
    gp.tokens.length === 50 && gp.components.length === 42 && Object.keys(gp.anchors).length === 207 && Object.keys(gp.anchors).every((id) => !gh.has(id)));
}
check("visibility() never reads `visible` — a component PROPERTY called \"visible\" does not hide a node (finding 34)", (() => {
  // `visible: false` is not a field the producer writes — which is the point: it must not hide anything.
  const v = visibility(screenExport([{ id: "1:1", type: "FRAME", children: [malformed<NodeInput>({ id: "1:2", type: "INSTANCE", props: { visible: "Show Breadcrumb" }, visible: false }), { id: "1:3", type: "FRAME", hidden: true, children: [{ id: "1:4", type: "FRAME" }] }] }]));
  return v.visible.has("1:2") && !v.visible.has("1:3") && v.hidden.has("1:4") && v.hiddenRoots.length === 1 && v.hiddenRoots[0]?.nodes === 2;
})());

console.log("CLI:");
const help = run(["--help"]);
check("--help prints usage and exits 0", help.status === 0 && /usage: node "[^"]*plan-skeleton\.(ts|js)" <screen\.json> <screen\.vars\.json> <design-system dir>/.test(help.stdout));
check("an unknown flag is refused (exit 2), not swallowed", run([screen(JR), vars(JR), DS, "--output", "x"]).status === 2);
{
  // Every input is checked as it is read (doc-guards.ts); each failure is one line naming the file, exit 1.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-skel-shape-"));
  const put = (name: string, doc: unknown): string => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const r1 = run([put("notscreen.json", { nodes: [{ name: "no id" }] }), vars(JR), DS]);
  check("[shape] a screen argument that is not a screen export -> 'cannot read the screen JSON …: is not a screen export', exit 1",
    r1.status === 1 && /plan-skeleton: cannot read the screen JSON .*notscreen\.json: is not a screen export/.test(r1.stderr) && r1.stdout === "");
  const r2 = run([screen(JR), vars(JR), DS, "--map", put("map.json", { version: 1, components: { K: { figma: { key: "K" } } } })]);
  check("[shape] an invalid --map is refused, one line (was: read blindly, every instance silently unmapped)",
    r2.status === 1 && /plan-skeleton: cannot read the component map .*map\.json: is not a valid component map/.test(r2.stderr));
  const ds = path.join(dir, "ds");
  fs.mkdirSync(ds);
  fs.writeFileSync(path.join(ds, "tokens.json"), "{ not json");
  const r3 = run([screen(JR), vars(JR), ds]);
  check("[shape] a design-system tokens.json that is there but broken is refused (was: silently no design system)",
    r3.status === 1 && /cannot read the design system's tokens .*tokens\.json: is not valid JSON/.test(r3.stderr));
  const planFile = put("plan.json", { tokens: "none" });
  const r4 = run([screen(JR), vars(JR), DS, "--out", planFile]);
  check("[shape] an existing --out that is not a plan is refused untouched (never merged into)",
    r4.status === 1 && /exists but is not a valid plan: `tokens` must be an array — refusing to overwrite it/.test(r4.stderr) && fs.readFileSync(planFile, "utf8") === JSON.stringify({ tokens: "none" }));
  check("[args] `--out --route x` is '--out needs a value', not a plan written to a file named --route", (() => { const r = run([screen(JR), vars(JR), DS, "--out", "--route", "x"]); return r.status === 2 && /plan-skeleton: --out needs a value/.test(r.stderr); })());
}
check("wrong arity is refused (exit 2)", run([screen(JR)]).status === 2);
{
  const nods = run([screen(JR), vars(JR), path.join(FX, "no-such-dir")]);
  const p = planOf(nods.stdout);
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
  const p = planOf(gp.stdout);
  check("[P6-136] a screen with a Blocked audit on disk gets auditGate pre-filled: auditFile, verdict, every blocker id, overridden empty",
    gp.status === 0 && p.auditGate !== null && p.auditGate.auditFile === "design/audit/System_Configurations.json" && p.auditGate.verdict === "blocked"
      && p.auditGate.blockers.length === 5 && Array.isArray(p.auditGate.overridden) && p.auditGate.overridden.length === 0 && p.auditGate.reason === null);
  check("[P6-136] a screen with no matching audit (Job Roles: no design/audit/positions*.json in this fixture) gets auditGate: null", planOf(r.stdout).auditGate === null);

  // merge(): a person's decision (overridden/reason/decidedBy/decidedAt) survives a re-run — the
  // skeleton must never clear what was already decided.
  const decided = Object.assign({}, p, { auditGate: Object.assign({}, p.auditGate, { overridden: p.auditGate?.blockers, reason: "provenance issues, not build issues", decidedBy: "owner", decidedAt: "2026-09-23" }) });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-plan-"));
  const planFile = path.join(out, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(decided, null, 2));
  const merged = run([screen(GP), vars(GP), DS, "--out", planFile], { cwd: auditCwd });
  const after = read(planFile, isSkeletonPlan);
  check("[P6-136] a re-run (--out onto an existing plan) keeps the decided overridden/reason/decidedBy — never clears it",
    merged.status === 0 && after.auditGate?.overridden.length === 5 && after.auditGate.reason === "provenance issues, not build issues" && after.auditGate.decidedBy === "owner");

  // F-44: the gate points at the cross-check report beside the audit, and a merge REFRESHES the skeleton-owned
  // blockers (the audit's current ids) while keeping the person-owned decision. Before: `prev.auditGate ||
  // fresh.auditGate` froze the first run's ids, and there was no crossCheckFile.
  check("[F44-5] no <audit>.cross.json beside the audit: auditGate.crossCheckFile is null", p.auditGate?.crossCheckFile === null);
  fs.writeFileSync(path.join(auditCwd, "design", "audit", "System_Configurations.cross.json"), JSON.stringify({ summary: {}, findings: [] }));
  const stale = Object.assign({}, p, { auditGate: { auditFile: "design/audit/System_Configurations.json", verdict: "blocked",
    blockers: ["catalog-covers-nothing#0", "text-style-near-miss#1"], overridden: ["catalog-covers-nothing#0"], reason: "decided on the old ids", decidedBy: "owner", decidedAt: "2026-09-23" } });
  fs.writeFileSync(planFile, JSON.stringify(stale, null, 2));
  const re = run([screen(GP), vars(GP), DS, "--out", planFile], { cwd: auditCwd });
  const g = read(planFile, isSkeletonPlan).auditGate;
  check(`[F44-5] a merge over an old gate sets crossCheckFile (got ${JSON.stringify(g?.crossCheckFile)})`, re.status === 0 && g?.crossCheckFile === "design/audit/System_Configurations.cross.json");
  check(`[F44-5] …refreshes blockers to the audit's current ids (got ${JSON.stringify(g?.blockers)})`,
    JSON.stringify(g?.blockers) === JSON.stringify(p.auditGate?.blockers) && g?.blockers.includes("catalog-covers-nothing") === true);
  check("[F44-5] …and keeps the person-owned overridden/reason/decidedBy/decidedAt/verdict as they were",
    JSON.stringify(g?.overridden) === JSON.stringify(["catalog-covers-nothing#0"]) && g?.reason === "decided on the old ids" && g.decidedBy === "owner" && g.decidedAt === "2026-09-23" && g.verdict === "blocked");
}

// ---------------------------------------------------------------- DT-33: --seed-from a sibling plan
console.log("DT-33 — --seed-from fills a sibling screen's answers (same key + same value), never overwriting:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt33-"));
  const put = (name: string, doc: unknown): string => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const variable = (name: string, key: string, value: number) => ({ name, key, type: "FLOAT", collection: "Spacing", values: { Default: value } });
  const varsDoc = (radius: number) => ({ collections: [{ name: "Spacing", modes: ["Default"], default: "Default" }], variables: [variable("Space 2", "k-space-2", 8), variable("Radius", "k-radius", radius)] });
  const screenDoc = (id: string, name: string) => ({ screen: name, nodes: [{ id, type: "FRAME", name, tokens: { itemSpacing: "Space 2", topLeftRadius: "Radius" }, children: [
    { id: id + "1", type: "INSTANCE", name: "Button", mainComponent: { name: "State=Default", key: "k-button-default", setKey: "k-button", setName: "Button" } },
    { id: id + "2", type: "INSTANCE", name: "Avatar", mainComponent: { name: "Avatar", key: "k-avatar" } },
  ] }] });
  const sA = put("A_screen.json", screenDoc("5:6", "Sample A")), vA = put("A_screen.vars.json", varsDoc(4));
  const sB = put("B_screen.json", screenDoc("7:8", "Sample B")), vB = put("B_screen.vars.json", varsDoc(12)); // Radius differs: 4 vs 12
  const planA = path.join(dir, "A.json"), planB = path.join(dir, "B.json");
  const ds = path.join(dir, "no-design-system");
  run([sA, vA, ds, "--out", planA], { cwd: dir });
  const a = read(planA, isSkeletonPlan);
  const fill = <T extends object>(row: T | undefined, what: string, v: Partial<T>): void => { Object.assign(must(row, what), v); };
  fill(a.tokens.find((t) => t.figmaName === "Space 2"), "A 'Space 2'", { codeToken: "--spacing-2", verdict: "exact", decision: "the spacing scale" });
  fill(a.tokens.find((t) => t.figmaName === "Radius"), "A 'Radius'", { codeToken: "--radius-sm", verdict: "exact" });
  fill(a.components.find((c) => c.name === "Button"), "A Button", { mapModule: "src/ui/Button.tsx", verdict: "mapped" });
  fill(a.components.find((c) => c.name === "Avatar"), "A Avatar", { mapModule: "src/ui/Avatar.tsx" });
  fs.writeFileSync(planA, JSON.stringify(a, null, 2));
  const rb = run([sB, vB, ds, "--out", planB, "--seed-from", planA], { cwd: dir });
  const readB = (): SkeletonPlan | null => fs.existsSync(planB) ? read(planB, isSkeletonPlan) : null; // never crash when an older script wrote nothing
  const b = readB();
  const bt = (n: string) => b?.tokens.find((t) => t.figmaName === n);
  const bc = (n: string) => b?.components.find((c) => c.name === n);
  check(`[DT33-1] a token with the same key AND value is seeded, marked seededFrom (exit ${rb.status}: ${rb.stderr.trim().split("\n")[0]})`,
    rb.status === 0 && bt("Space 2")?.codeToken === "--spacing-2" && bt("Space 2")?.verdict === "exact" && bt("Space 2")?.decision === "the spacing scale" && bt("Space 2")?.seededFrom === "A.json");
  check("[DT33-1] a token with the same key but a DIFFERENT value is left empty (no seededFrom)",
    !!bt("Radius") && bt("Radius")?.codeToken === null && bt("Radius")?.verdict === null && bt("Radius")?.seededFrom === undefined);
  check("[DT33-1] components are seeded by setKey (Button) and, with no setKey, by key (Avatar)",
    bc("Button")?.mapModule === "src/ui/Button.tsx" && bc("Button")?.verdict === "mapped" && bc("Button")?.seededFrom === "A.json" && bc("Avatar")?.mapModule === "src/ui/Avatar.tsx" && bc("Avatar")?.seededFrom === "A.json");
  check("[DT33-1] stderr counts what was seeded and asks for a review", /seeded 1 token row\(s\), 2 component row\(s\) from .*A\.json — review them \(seededFrom\)/.test(rb.stderr));
  // never overwrites: B's own answer stays, and a re-run without --seed-from keeps the seeded rows (they count as filled)
  if (b) {
    const own = <T extends { seededFrom?: string }>(row: T | undefined, what: string, v: Partial<T>): void => { const r = must(row, what); Object.assign(r, v); delete r.seededFrom; };
    own(b.components.find((c) => c.name === "Button"), "B Button", { mapModule: "src/ui/OwnButton.tsx" });
    own(b.tokens.find((t) => t.figmaName === "Space 2"), "B 'Space 2'", { codeToken: "--own-space", verdict: "exact", decision: "own" });
    fs.writeFileSync(planB, JSON.stringify(b, null, 2));
  }
  const again = run([sB, vB, ds, "--out", planB, "--seed-from", planA], { cwd: dir });
  const b2 = readB();
  check("[DT33-1] a filled field is never overwritten by a seed (own Button module, own Space 2 token)",
    again.status === 0 && !!b2 && b2.components.find((c) => c.name === "Button")?.mapModule === "src/ui/OwnButton.tsx" && b2.tokens.find((t) => t.figmaName === "Space 2")?.codeToken === "--own-space"
      && b2.tokens.find((t) => t.figmaName === "Space 2")?.seededFrom === undefined);
  const avatar = () => readB()?.components.find((c) => c.name === "Avatar");
  const plain = run([sB, vB, ds, "--out", planB], { cwd: dir });
  check("[DT33-1] seeded rows count as filled: a re-run without --seed-from keeps them and their seededFrom",
    plain.status === 0 && avatar()?.mapModule === "src/ui/Avatar.tsx" && avatar()?.seededFrom === "A.json");
  const bad = run([sB, vB, ds, "--seed-from", put("notplan.json", { tokens: "none" })], { cwd: dir });
  check("[DT33-1] a --seed-from that is not a plan is refused, one line, exit 1", bad.status === 1 && /cannot read the --seed-from plan .*notplan\.json/.test(bad.stderr) && bad.stdout === "");
  check("[DT33-1] --seed-from is in --help", /--seed-from <plan>/.test(run(["--help"]).stdout));
}

// ---------------------------------------------------------------- DT-27: one name rule (shared fixture with cross-check)
// test/fixtures/g14/dt27/ (cross-check.test.ts asserts the same verdicts on its coverage entries): the plan's
// components[].catalog must say what component-match's nameVerdict says — `by:"ambiguous"` (never a match,
// with the candidates) for a different-signatures tie. Before: Badge was written as a name match.
console.log("DT-27 — plan-skeleton's catalog follows the one name rule (nameVerdict):");
{
  const DT27 = path.join(import.meta.dirname, "fixtures", "g14", "dt27");
  type Expected = { verdicts: Record<string, "matched" | "ambiguous" | "unmatched"> };
  const isExpected = (x: unknown): x is Expected => isJsonObject(x) && isJsonObject(x.verdicts) && Object.values(x.verdicts).every((v) => v === "matched" || v === "ambiguous" || v === "unmatched");
  const have = fs.existsSync(path.join(DT27, "expected.json"));
  check("[DT27-1] the shared fixture test/fixtures/g14/dt27/ is there", have);
  if (have) {
    const expected = read(path.join(DT27, "expected.json"), isExpected);
    const r27 = run([path.join(DT27, "Screen__5_6.json"), path.join(DT27, "Screen__5_6.vars.json"), path.join(DT27, "design-system")], { cwd: DT27 });
    const p27 = r27.status === 0 ? planOf(r27.stdout) : null;
    const verdictOf = (name: string): string => {
      const c = p27?.components.find((x) => x.name === name);
      if (!c) return "missing";
      return !c.catalog ? "unmatched" : c.catalog.by === "ambiguous" ? "ambiguous" : "matched";
    };
    const got = Object.fromEntries(Object.keys(expected.verdicts).map((n) => [n, verdictOf(n)]));
    check(`[DT27-1] one verdict per name, the same as cross-check's (want ${JSON.stringify(expected.verdicts)}, got ${JSON.stringify(got)})`,
      Object.keys(expected.verdicts).length === 3 && JSON.stringify(got) === JSON.stringify(expected.verdicts));
    const badge = p27?.components.find((x) => x.name === "Badge")?.catalog;
    check("[DT27-1] the ambiguous row lists its candidates (id/key/name, catalog order) and has no name of its own",
      !!badge && badge.by === "ambiguous" && JSON.stringify(badge.candidates) === JSON.stringify([{ id: "12:1", key: "acme-badge-a", name: "Badge" }, { id: "12:2", key: "acme-badge-b", name: "Badge" }]) && !("name" in badge));
  }
}

report();
