// Offline tests for design-to-code/plan-skeleton.ts — the build-screen plan, generated from the export.
// Driven by test/fixtures/livetest3/plan/, the live run's real export pruned
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
const PAGE = path.join(FX, "export", "pages", "__Optimization_management_");
const DS = path.join(FX, "export", "design-system");
const JR = "positions___7314_87192", GP = "Studio_Configurations__1359_21337";
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

console.log("acceptance (§2.9 f) — the skeleton for 7314:87192 (Jet Roles):");
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

console.log("tokens[] — a COLOR value is written in color.ts's one spelling, so equal colours compare equal:");
{
  // #abc and #AABBCCFF are the same opaque colour: both "#aabbcc" (shorthand expanded, opaque alpha dropped), so the
  // design system's "#aabbcc" agrees with a screen's "#abc". A string that is not a hex colour is kept, trimmed and lowercased.
  const v = tokens({
    collections: [{ name: "C", modes: ["M"], default: "M" }],
    variables: [
      { name: "Short", collection: "C", type: "COLOR", values: { M: "#ABC" } },
      { name: "Full", collection: "C", type: "COLOR", values: { M: " #AABBCCFF " } },
      { name: "Half", collection: "C", type: "COLOR", values: { M: "#abc8" } },
      { name: "Word", collection: "C", type: "COLOR", values: { M: " Not-A-Colour " } },
    ],
  });
  const dsv = tokens({ collections: [{ name: "C", modes: ["M"], default: "M" }], variables: [{ name: "Short", collection: "C", type: "COLOR", values: { M: "#aabbcc" } }] });
  const names = ["Short", "Full", "Half", "Word"];
  const doc = { screen: "S", nodes: names.map((n, i) => node({ id: `2:${i}`, type: "RECTANGLE", name: n, tokens: { fills: n } })) };
  const rows = buildTokens(doc, v, dsv, { C: "M" });
  const row = (n: string) => rows.find((t) => t.figmaName === n);
  check("#ABC -> #aabbcc, ' #AABBCCFF ' -> #aabbcc, #abc8 -> #aabbcc88, a word kept lowercased",
    row("Short")?.value === "#aabbcc" && row("Full")?.value === "#aabbcc" && row("Half")?.value === "#aabbcc88" && row("Word")?.value === "not-a-colour");
  check("the design system's #aabbcc agrees with the screen's #ABC", row("Short")?.designSystem?.agrees === true);
}

console.log("the plan header — so every other skill can find the plan:");
check("screenName / nodeId / file are written; route is left for the builder",
  plan.nodeId === "7314:87192" && plan.screenName === "positions" && plan.file === "export/pages/__Optimization_management_/positions___7314_87192.json" && plan.route === null && plan.status === "pending");
check("--route fills it", planOf(run([screen(JR), vars(JR), DS, "--route", "/jet-roles"]).stdout).route === "/jet-roles");

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

console.log("components[] — identity from the catalog, never from a hand-placed attribute:");
const names = new Set(plan.components.map((c) => c.name));
const matched = new Set(plan.components.filter((c) => c.catalog && c.catalog.by !== "ambiguous").map((c) => c.name)); // ambiguous is never a match
check(`41 distinct components, 26 matched to the catalog by name+prop signature (the name matcher; mapping.json agrees 26/15) — got ${names.size}/${matched.size}`,
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
  must(filled.anchors["7314:87192"], "filled.anchors['7314:87192']").mapModule = "app/src/features/jet-roles/screens/JetRolesScreen.tsx";
  filled.files = ["app/src/features/jet-roles/screens/JetRolesScreen.tsx"];
  filled.route = "/jet-roles";
  filled.verification = { mode: "static-only", reason: "x" };
  fs.writeFileSync(out, JSON.stringify(filled));
  const again = run([screen(JR), vars(JR), DS, "--out", out]);
  const m = read(out, isSkeletonPlan);
  const mAnchor = m.anchors["7314:87192"];
  check("re-running --out MERGES: every filled field and every top-level field it does not own survives",
    again.status === 0 && /merged into/.test(again.stderr) && m.tokens.find((t) => t.figmaName === "Space 4")?.codeToken === "spacing-figma-space-4"
    && m.components[0]?.mapModule === "app/src/layout/Sidebar.tsx" && mAnchor?.mapModule?.endsWith("JetRolesScreen.tsx") === true
    && m.files?.length === 1 && m.route === "/jet-roles" && m.verification?.mode === "static-only" && m.tokens.length === 45);
  // --out merges through the one plan writer (plan-record.ts writePlan) — atomic, in the file's own format
  fs.writeFileSync(out, JSON.stringify(m, null, 4).split("\n").join("\r\n") + "\r\n");
  const crlf = run([screen(JR), vars(JR), DS, "--out", out]);
  const crlfText = fs.readFileSync(out, "utf8");
  // The plan keeps its own format; it is not rewritten as LF with 2-space indentation
  check("re-running --out keeps a hand-edited plan's own format (CRLF, 4-space indent) and leaves no temp file beside it",
    crlf.status === 0 && crlfText.includes("\r\n    \"") && !/[^\r]\n/.test(crlfText) && fs.readdirSync(dir).join() === "plan.json");
  const old = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(out, old, old);
  const same = run([screen(JR), vars(JR), DS, "--out", out]);
  // An unchanged plan is still rewritten, so its mtime is fresh: verify-build skips a plan with a day-old mtime
  check("re-running --out on an unchanged plan refreshes its mtime (verify-build's staleness cutoff reads it)",
    same.status === 0 && fs.readFileSync(out, "utf8") === crlfText && Date.now() - fs.statSync(out).mtimeMs < 3600 * 1000);
  fs.writeFileSync(out, "{ not json");
  check("an existing plan that is not JSON is never overwritten", run([screen(JR), vars(JR), DS, "--out", out]).status === 1 && fs.readFileSync(out, "utf8") === "{ not json");
}
{
  const gp = planOf(run([screen(GP), vars(GP), DS]).stdout);
  const gh = hiddenIds(read(screen(GP), isScreenExport));
  check(`Guided Policies (1359:21337): 50 tokens (PHASE2-TOKENS.md: 50), 42 visible instances, 207 anchors, 0 hidden — got ${gp.tokens.length}/${gp.components.length}/${Object.keys(gp.anchors).length}`,
    gp.tokens.length === 50 && gp.components.length === 42 && Object.keys(gp.anchors).length === 207 && Object.keys(gp.anchors).every((id) => !gh.has(id)));
}
check("visibility() never reads `visible` — a component PROPERTY called \"visible\" does not hide a node", (() => {
  // `visible: false` is not a field the producer writes — which is the point: it must not hide anything.
  const v = visibility(screenExport([{ id: "1:1", type: "FRAME", children: [malformed<NodeInput>({ id: "1:2", type: "INSTANCE", props: { visible: "Show Breadcrumb" }, visible: false }), { id: "1:3", type: "FRAME", hidden: true, children: [{ id: "1:4", type: "FRAME" }] }] }]));
  return v.visible.has("1:2") && !v.visible.has("1:3") && v.hidden.has("1:4") && v.hiddenRoots.length === 1 && v.hiddenRoots[0]?.nodes === 2;
})());

console.log("CLI:");
const help = run(["--help"]);
// The script's path is double-quoted in the usage line, or single-quoted when it holds a backslash (cli-args.ts shellQuote): every Windows path.
const Q = process.platform === "win32" ? "'" : '"';
check("--help prints usage and exits 0", help.status === 0 && new RegExp(`usage: node ${Q}[^${Q}]*plan-skeleton\\.(ts|js)${Q} <screen\\.json> <screen\\.vars\\.json> <design-system dir>`).test(help.stdout));
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

// ---------------------------------------------------------------- auditGate pre-fill
// Real audit: FX/design/audit/Studio_Configurations.json (5 blockers, copied verbatim from the
// livetest-3 run). Guided Policies (Studio_Configurations__1359_21337) is the screen it belongs to.
console.log("auditGate is pre-filled from an existing Blocked audit:");
{
  const auditCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-cwd-"));
  fs.mkdirSync(path.join(auditCwd, "design", "audit"), { recursive: true });
  fs.copyFileSync(path.join(FX, "audit", "Studio_Configurations.json"), path.join(auditCwd, "design", "audit", "Studio_Configurations.json"));
  const gp = run([screen(GP), vars(GP), DS], { cwd: auditCwd });
  const p = planOf(gp.stdout);
  check("a screen with a Blocked audit on disk gets auditGate pre-filled: auditFile, verdict, every blocker id, overridden empty",
    gp.status === 0 && p.auditGate !== null && p.auditGate.auditFile === "design/audit/Studio_Configurations.json" && p.auditGate.verdict === "blocked"
      && p.auditGate.blockers.length === 5 && Array.isArray(p.auditGate.overridden) && p.auditGate.overridden.length === 0 && p.auditGate.reason === null);
  check("a screen with no matching audit (Jet Roles: no design/audit/positions*.json in this fixture) gets auditGate: null", planOf(r.stdout).auditGate === null);

  // merge(): a person's decision (overridden/reason/decidedBy/decidedAt) survives a re-run — the
  // skeleton must never clear what was already decided.
  const decided = Object.assign({}, p, { auditGate: Object.assign({}, p.auditGate, { overridden: p.auditGate?.blockers, reason: "provenance issues, not build issues", decidedBy: "owner", decidedAt: "2026-09-23" }) });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "p6-136-plan-"));
  const planFile = path.join(out, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(decided, null, 2));
  const merged = run([screen(GP), vars(GP), DS, "--out", planFile], { cwd: auditCwd });
  const after = read(planFile, isSkeletonPlan);
  check("a re-run (--out onto an existing plan) keeps the decided overridden/reason/decidedBy — never clears it",
    merged.status === 0 && after.auditGate?.overridden.length === 5 && after.auditGate.reason === "provenance issues, not build issues" && after.auditGate.decidedBy === "owner");

  // the gate points at the cross-check report beside the audit, and a merge REFRESHES the skeleton-owned
  // blockers (the audit's current ids) while keeping the person-owned decision. Before: `prev.auditGate ||
  // fresh.auditGate` froze the first run's ids, and there was no crossCheckFile.
  check("no <audit>.cross.json beside the audit: auditGate.crossCheckFile is null", p.auditGate?.crossCheckFile === null);
  fs.writeFileSync(path.join(auditCwd, "design", "audit", "Studio_Configurations.cross.json"), JSON.stringify({ summary: {}, findings: [] }));
  const stale = Object.assign({}, p, { auditGate: { auditFile: "design/audit/Studio_Configurations.json", verdict: "blocked",
    blockers: ["catalog-covers-nothing#0", "text-style-near-miss#1"], overridden: ["catalog-covers-nothing#0"], reason: "decided on the old ids", decidedBy: "owner", decidedAt: "2026-09-23" } });
  fs.writeFileSync(planFile, JSON.stringify(stale, null, 2));
  const re = run([screen(GP), vars(GP), DS, "--out", planFile], { cwd: auditCwd });
  const g = read(planFile, isSkeletonPlan).auditGate;
  check(`a merge over an old gate sets crossCheckFile (got ${JSON.stringify(g?.crossCheckFile)})`, re.status === 0 && g?.crossCheckFile === "design/audit/Studio_Configurations.cross.json");
  check(`…refreshes blockers to the audit's current ids (got ${JSON.stringify(g?.blockers)})`,
    JSON.stringify(g?.blockers) === JSON.stringify(p.auditGate?.blockers) && g?.blockers.includes("catalog-covers-nothing") === true);
  check("…and keeps the person-owned overridden/reason/decidedBy/decidedAt/verdict as they were",
    JSON.stringify(g?.overridden) === JSON.stringify(["catalog-covers-nothing#0"]) && g?.reason === "decided on the old ids" && g.decidedBy === "owner" && g.decidedAt === "2026-09-23" && g.verdict === "blocked");
}

// ---------------------------------------------------------------- --seed-from a sibling plan
console.log("--seed-from fills a sibling screen's answers (same key + same value), never overwriting:");
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
  check(`a token with the same key AND value is seeded, marked seededFrom (exit ${rb.status}: ${rb.stderr.trim().split("\n")[0]})`,
    rb.status === 0 && bt("Space 2")?.codeToken === "--spacing-2" && bt("Space 2")?.verdict === "exact" && bt("Space 2")?.decision === "the spacing scale" && bt("Space 2")?.seededFrom === "A.json");
  check("a token with the same key but a DIFFERENT value is left empty (no seededFrom)",
    !!bt("Radius") && bt("Radius")?.codeToken === null && bt("Radius")?.verdict === null && bt("Radius")?.seededFrom === undefined);
  check("components are seeded by setKey (Button) and, with no setKey, by key (Avatar)",
    bc("Button")?.mapModule === "src/ui/Button.tsx" && bc("Button")?.verdict === "mapped" && bc("Button")?.seededFrom === "A.json" && bc("Avatar")?.mapModule === "src/ui/Avatar.tsx" && bc("Avatar")?.seededFrom === "A.json");
  check("stderr counts what was seeded and asks for a review", /seeded 1 token row\(s\), 2 component row\(s\) from .*A\.json — review them \(seededFrom\)/.test(rb.stderr));
  // never overwrites: B's own answer stays, and a re-run without --seed-from keeps the seeded rows (they count as filled)
  if (b) {
    const own = <T extends { seededFrom?: string }>(row: T | undefined, what: string, v: Partial<T>): void => { const r = must(row, what); Object.assign(r, v); delete r.seededFrom; };
    own(b.components.find((c) => c.name === "Button"), "B Button", { mapModule: "src/ui/OwnButton.tsx" });
    own(b.tokens.find((t) => t.figmaName === "Space 2"), "B 'Space 2'", { codeToken: "--own-space", verdict: "exact", decision: "own" });
    fs.writeFileSync(planB, JSON.stringify(b, null, 2));
  }
  const again = run([sB, vB, ds, "--out", planB, "--seed-from", planA], { cwd: dir });
  const b2 = readB();
  check("a filled field is never overwritten by a seed (own Button module, own Space 2 token)",
    again.status === 0 && !!b2 && b2.components.find((c) => c.name === "Button")?.mapModule === "src/ui/OwnButton.tsx" && b2.tokens.find((t) => t.figmaName === "Space 2")?.codeToken === "--own-space"
      && b2.tokens.find((t) => t.figmaName === "Space 2")?.seededFrom === undefined);
  const avatar = () => readB()?.components.find((c) => c.name === "Avatar");
  const plain = run([sB, vB, ds, "--out", planB], { cwd: dir });
  check("seeded rows count as filled: a re-run without --seed-from keeps them and their seededFrom",
    plain.status === 0 && avatar()?.mapModule === "src/ui/Avatar.tsx" && avatar()?.seededFrom === "A.json");
  const bad = run([sB, vB, ds, "--seed-from", put("notplan.json", { tokens: "none" })], { cwd: dir });
  check("a --seed-from that is not a plan is refused, one line, exit 1", bad.status === 1 && /cannot read the --seed-from plan .*notplan\.json/.test(bad.stderr) && bad.stdout === "");
  check("--seed-from is in --help", /--seed-from <plan>/.test(run(["--help"]).stdout));
}

// ---------------------------------------------------------------- anchorsSuggested
// A screen has 12-291 anchor slots; the skeleton names the few boundaries worth filling first: the root's
// sections, each outermost instance, and a container of >= 3 same-shaped children (a `.map()`), covering its subtree.
console.log("anchorsSuggested names the anchors worth filling first:");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f34-"));
  const put = (name: string, doc: unknown): string => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const inst = (id: string, key: string, kids: NodeInput[] = [], extra: Partial<NodeInput> = {}): NodeInput =>
    ({ id, type: "INSTANCE", name: "Row " + id, mainComponent: { name: "Row", key, setKey: "set-" + key }, children: kids, ...extra });
  const text = (id: string, extra: Partial<NodeInput> = {}): NodeInput => ({ id, type: "TEXT", name: "T " + id, text: "x", ...extra });
  const rows = [1, 2, 3, 4].map((i) => inst("3:" + i, "k-row", [text("3:" + i + "0")]));
  const screenDoc = screenExport([{ id: "1:1", type: "FRAME", name: "Page", children: [
    inst("2:1", "k-header", [text("2:11"), text("2:12")]),
    { id: "2:2", type: "FRAME", name: "Body", children: [
      text("2:20"),
      { id: "2:3", type: "FRAME", name: "List", children: rows },
      // two visible rows + one hidden twin: not a list, so the instances are suggested one by one
      { id: "2:4", type: "FRAME", name: "Short list", children: [inst("4:1", "k-row"), inst("4:2", "k-row"), inst("4:3", "k-row", [], { hidden: true })] },
      inst("2:5", "k-footer", [text("2:50")]),
    ] },
  ] }], { screen: "Sample" });
  const sf = put("Sample.json", screenDoc), vf = put("Sample.vars.json", { collections: [], variables: [] });
  const ds = path.join(dir, "no-design-system");
  const sug = (p: SkeletonPlan) => (p.anchorsSuggested ?? []).map((a) => `${a.id}:${a.why}:${a.covers}`);
  const r34 = run([sf, vf, ds], { cwd: dir });
  const p34 = planOf(r34.stdout);
  // covers = the node + its visible descendants (Body: itself, a text, List 9, Short list 3, Footer 2; Page: itself, Header 3, Body 16)
  const want = ["1:1:screen:20", "2:1:section:3", "2:2:section:16", "2:3:repeat:9", "4:1:instance:1", "4:2:instance:1", "2:5:instance:2"];
  const got = sug(p34);
  check(`the screen frame first, sections, the repeated list (rows not listed one by one), and the outermost instances, in tree order (got ${JSON.stringify(got)})`,
    r34.status === 0 && JSON.stringify(got) === JSON.stringify(want));
  check("a list's rows are covered by it: none of 3:1..3:4 nor their texts is suggested; a hidden twin does not make a list",
    (p34.anchorsSuggested ?? []).every((a) => !a.id.startsWith("3:")) && (p34.anchorsSuggested ?? []).some((a) => a.id === "4:1") && !(p34.anchorsSuggested ?? []).some((a) => a.id === "4:3" || a.id === "2:4"));
  check("every suggestion is a real visible anchor, with its name; counts.anchors is unchanged by the field",
    (p34.anchorsSuggested ?? []).every((a) => a.id in p34.anchors && p34.anchors[a.id]?.name === a.name) && p34.counts.anchors === Object.keys(p34.anchors).length && !("anchorsSuggested" in p34.counts));
  check("stderr counts the suggested anchor roots", new RegExp(`${(p34.anchorsSuggested ?? []).length} suggested anchor root\\(s\\) \\(anchorsSuggested\\)`).test(r34.stderr));
  check("--help names anchorsSuggested", /anchorsSuggested\[\]/.test(run(["--help"]).stdout + run(["--help"]).stderr));

  // childless leaves have no shape to repeat, a list's shape must be the majority of its children,
  // and the children of a list that are not its rows are still suggested.
  const leaf = (id: string, name: string): NodeInput => ({ id, type: "TEXT", name, text: name });
  const row = (id: string): NodeInput => ({ id, type: "FRAME", name: "row", children: [{ id: id + "0", type: "FRAME", name: "cell" }, { id: id + "1", type: "FRAME", name: "cell" }] });
  const m3 = screenExport([{ id: "1:1", type: "FRAME", name: "Page", children: [{ id: "5:1", type: "FRAME", name: "Body", children: [
    { id: "5:2", type: "FRAME", name: "Intro", children: [leaf("5:3", "Title"), leaf("5:4", "Description"), leaf("5:5", "Note"), inst("5:6", "k-form", [text("5:7")])] },
    { id: "6:1", type: "FRAME", name: "Table", children: [inst("6:2", "k-search", [text("6:3")]), row("6:4"), row("6:5"), row("6:6")] },
    { id: "7:1", type: "FRAME", name: "Mixed", children: [row("7:2"), row("7:3"), row("7:4"), inst("7:5", "k-a"), inst("7:6", "k-b"), inst("7:7", "k-c"), inst("7:8", "k-d")] },
    // a table: a header, three rows with a badge, two "Table row" variants without one (a different shape, same layer name)
    { id: "8:1", type: "FRAME", name: "Table", children: [{ id: "8:2", type: "FRAME", name: "header", children: [leaf("8:3", "Name"), leaf("8:4", "Status")] },
      ...["8:5", "8:6", "8:7"].map((id): NodeInput => ({ id, type: "FRAME", name: "Table row", children: [leaf(id + "1", "Ann"), inst(id + "2", "k-badge")] })),
      ...["8:8", "8:9"].map((id): NodeInput => ({ id, type: "FRAME", name: "Table row", children: [leaf(id + "1", "Bob"), { id: id + "2", type: "FRAME", name: "Frame 9", children: [inst(id + "3", "k-avatar")] }] }))] },
  ] }] }], { screen: "Sample" });
  const pm3 = planOf(run([put("M3.json", m3), put("M3.vars.json", { collections: [], variables: [] }), ds], { cwd: dir }).stdout);
  const why = (id: string): string | undefined => (pm3.anchorsSuggested ?? []).find((a) => a.id === id)?.why;
  check("three TEXT siblings are no list: 'Intro' is not a repeat and its Form instance is suggested", why("5:2") === undefined && why("5:6") === "instance");
  check("a list with a search bar above its rows: the list is a repeat, the search bar instance is still suggested, the rows are not",
    why("6:1") === "repeat" && why("6:2") === "instance" && !["6:4", "6:5", "6:6"].some((id) => why(id) !== undefined));
  check("three same rows among seven children are no majority → no repeat; its instances are suggested one by one",
    why("7:1") === undefined && ["7:5", "7:6", "7:7", "7:8"].every((id) => why(id) === "instance"));
  check("a row variant that keeps the rows' layer name is a row: the table is a repeat and nothing inside its five rows is suggested",
    why("8:1") === "repeat" && !(pm3.anchorsSuggested ?? []).some((a) => /^8:[5-9]/.test(a.id)) && why("8:2") === undefined);

  // full coverage, divided lists, the screen frame, nested instances, empty and INSTANCE roots.
  const plan = (name: string, nodes: NodeInput[]) => {
    const r = run([put(name + ".json", screenExport(nodes, { screen: "Sample" })), put(name + ".vars.json", { collections: [], variables: [] }), ds], { cwd: dir });
    return { status: r.status, plan: r.status === 0 ? planOf(r.stdout) : null };
  };
  // the visible anchors that are neither a suggestion nor under one
  const uncovered = (p: SkeletonPlan | null): string[] => {
    if (!p) return ["<no plan>"];
    const ids = new Set((p.anchorsSuggested ?? []).map((a) => a.id));
    return Object.keys(p.anchors).filter((id) => {
      for (let cur: string | null = id; cur; cur = p.anchors[cur]?.parent ?? null) if (ids.has(cur)) return false;
      return true;
    });
  };
  const line = (id: string): NodeInput => ({ id, type: "LINE", name: "Divider" });
  const divider = (id: string): NodeInput => ({ id, type: "INSTANCE", name: "Divider", mainComponent: { name: "Divider", key: "k-div", setKey: "set-k-div" }, children: [] });
  const body = (kids: NodeInput[]): NodeInput[] => [{ id: "1:1", type: "FRAME", name: "Page", children: [{ id: "2:1", type: "FRAME", name: "Body", children: kids }] }];
  // [title TEXT, row, LINE, row, LINE, row, LINE, row]: leaves do not vote, so 4 rows of 4 shaped children are the majority
  const divided = plan("Divided", body([{ id: "3:1", type: "FRAME", name: "List", children: [
    text("3:2"), inst("4:1", "k-row", [text("4:10")]), line("5:1"), inst("4:2", "k-row", [text("4:20")]), line("5:2"),
    inst("4:3", "k-row", [text("4:30")]), line("5:3"), inst("4:4", "k-row", [text("4:40")])] }]));
  const gotDivided = divided.plan ? sug(divided.plan) : null;
  check(`a list divided by LINEs under a title is ONE repeat, not one instance per row (got ${JSON.stringify(gotDivided)})`,
    JSON.stringify(gotDivided) === JSON.stringify(["1:1:screen:15", "2:1:section:14", "3:1:repeat:13"]));
  // divider INSTANCEs between the rows and a shaped FRAME heading: the dividers ride along with the rows and do not vote
  const dividedI = plan("DividedI", body([{ id: "3:1", type: "FRAME", name: "List", children: [
    { id: "3:2", type: "FRAME", name: "Heading", children: [text("3:3"), text("3:4")] }, inst("4:1", "k-row"), divider("5:1"), inst("4:2", "k-row"), divider("5:2"),
    inst("4:3", "k-row"), divider("5:3"), inst("4:4", "k-row")] }]));
  const gotDividedI = dividedI.plan ? sug(dividedI.plan) : null;
  check(`a list divided by Divider INSTANCEs is ONE repeat; neither a row nor a divider is suggested (got ${JSON.stringify(gotDividedI)})`,
    JSON.stringify(gotDividedI) === JSON.stringify(["1:1:screen:13", "2:1:section:12", "3:1:repeat:11"]));

  // A form — three text fields with a checkbox, a select and a button between/after them — is no list:
  // shaped children between rows are separators only when they share one shape and fill every gap
  const form = plan("Form", body([{ id: "3:1", type: "FRAME", name: "Fields", children: [
    inst("4:1", "k-field"), inst("4:2", "k-check"), inst("4:3", "k-field"), inst("4:4", "k-select"), inst("4:5", "k-field"), inst("4:6", "k-button")] }]));
  const gotForm = form.plan ? sug(form.plan).map((x) => x.split(":").slice(0, 3).join(":")) : null;
  check(`a form's mixed fields are not row separators: no repeat, every field instance suggested (got ${JSON.stringify(gotForm)})`,
    !!gotForm && !gotForm.includes("3:1:repeat") && ["4:1", "4:2", "4:3", "4:4", "4:5", "4:6"].every((id) => gotForm.includes(`${id}:instance`)));

  // review-19 r2 LOW: alternating pairs [Q, A, Q, A, Q, A] are pairs — the A after the last Q is not in a gap, so no A
  // is a separator, and 3 of 6 is no majority
  const qa = plan("Pairs", body([{ id: "3:1", type: "FRAME", name: "Faq", children: [
    inst("4:1", "k-q"), inst("4:2", "k-a"), inst("4:3", "k-q"), inst("4:4", "k-a"), inst("4:5", "k-q"), inst("4:6", "k-a")] }]));
  const gotQa = qa.plan ? sug(qa.plan).map((x) => x.split(":").slice(0, 3).join(":")) : null;
  check(`alternating Q/A pairs are no repeat with separators: every Q and A instance suggested (got ${JSON.stringify(gotQa)})`,
    !!gotQa && !gotQa.includes("3:1:repeat") && ["4:1", "4:2", "4:3", "4:4", "4:5", "4:6"].every((id) => gotQa.includes(`${id}:instance`)));

  check("the screen frame is suggested first, as \"screen\", covering every visible node",
    [p34, pm3, divided.plan, dividedI.plan].every((p) => !!p && p.anchorsSuggested?.[0]?.why === "screen" && p.anchorsSuggested[0].id === "1:1" && p.anchorsSuggested[0].covers === Object.keys(p.anchors).length));
  check(`every visible anchor is a suggestion or under one, the root included (uncovered: ${JSON.stringify([p34, pm3, divided.plan, dividedI.plan].map(uncovered))})`,
    [p34, pm3, divided.plan, dividedI.plan].every((p) => uncovered(p).length === 0));

  // a section instance holding a nested instance and a 3-row list: its internals belong to the component
  const nested = plan("Nested", body([inst("6:1", "k-card", [inst("6:2", "k-avatar"),
    { id: "6:3", type: "FRAME", name: "Items", children: ["6:4", "6:5", "6:6"].map((id): NodeInput => ({ id, type: "FRAME", name: "item", children: [text(id + "0"), text(id + "1")] })) }])]));
  const gotNested = nested.plan ? sug(nested.plan) : null;
  check(`an outermost instance covers its nested instance and inner list; neither is suggested (got ${JSON.stringify(gotNested)})`,
    JSON.stringify(gotNested) === JSON.stringify(["1:1:screen:14", "2:1:section:13", "6:1:instance:12"]) && uncovered(nested.plan).length === 0);
  // a root whose only child is hidden: just the frame, exit 0
  const empty = plan("Empty", [{ id: "1:1", type: "FRAME", name: "Page", children: [{ id: "2:1", type: "FRAME", name: "Gone", hidden: true, children: [text("2:2")] }] }]);
  check(`a root with only hidden children: exit 0, the frame alone is suggested (got ${JSON.stringify(empty.plan && sug(empty.plan))})`,
    empty.status === 0 && JSON.stringify(empty.plan && sug(empty.plan)) === JSON.stringify(["1:1:screen:1"]));
  // a screen frame that is a template INSTANCE: its internals are the component's, not sections
  const tpl = plan("Template", [inst("1:1", "k-tpl", [inst("7:1", "k-nav", [text("7:2")]), { id: "7:3", type: "FRAME", name: "Slot", children: [inst("7:4", "k-btn")] }])]);
  check(`a screen frame that is an INSTANCE is the only suggestion (got ${JSON.stringify(tpl.plan && sug(tpl.plan))})`,
    tpl.status === 0 && JSON.stringify(tpl.plan && sug(tpl.plan)) === JSON.stringify(["1:1:screen:5"]));
  // the real export: the frame, its two sections, the outermost instances and one repeated list (7 before the frame was added)
  const real = planOf(r.stdout).anchorsSuggested ?? [];
  check(`the real fixture's suggestions are pinned: 8, the frame first and every visible anchor covered (got ${real.length})`,
    real.length === 8 && real[0]?.why === "screen" && real[0].id === planOf(r.stdout).nodeId && uncovered(planOf(r.stdout)).length === 0);
  check("a plan's anchorsSuggested must be an array of objects (parsePlan names it)",
    !isPlan({ anchorsSuggested: {} }) && !isPlan({ anchorsSuggested: ["1:1"] }) && isPlan({ anchorsSuggested: [] }));

  // merge: skeleton-owned, so it is REFRESHED (a stale list is replaced), while a filled mapModule survives
  const planFile = path.join(dir, "plan.json");
  const stale = { ...p34, anchorsSuggested: [{ id: "9:9", name: "Gone", why: "section", covers: 1 }], anchors: { ...p34.anchors, "2:1": { ...must(p34.anchors["2:1"], "anchor 2:1"), mapModule: "src/Header.tsx" } } };
  fs.writeFileSync(planFile, JSON.stringify(stale, null, 2));
  const m34 = run([sf, vf, ds, "--out", planFile], { cwd: dir });
  const after = read(planFile, isSkeletonPlan);
  check("a merge refreshes anchorsSuggested (the stale 9:9 is gone, the current list is back) and keeps the filled mapModule",
    m34.status === 0 && JSON.stringify(sug(after)) === JSON.stringify(got) && after.anchors["2:1"]?.mapModule === "src/Header.tsx");
}

// ---------------------------------------------------------------- one name rule (shared fixture with cross-check)
// test/fixtures/g14/dt27/ (cross-check.test.ts asserts the same verdicts on its coverage entries): the plan's
// components[].catalog must say what component-match's nameVerdict says — `by:"ambiguous"` (never a match,
// with the candidates) for a different-signatures tie. Before: Badge was written as a name match.
console.log("plan-skeleton's catalog follows the one name rule (nameVerdict):");
{
  const DT27 = path.join(import.meta.dirname, "fixtures", "g14", "dt27");
  type Expected = { verdicts: Record<string, "matched" | "ambiguous" | "unmatched"> };
  const isExpected = (x: unknown): x is Expected => isJsonObject(x) && isJsonObject(x.verdicts) && Object.values(x.verdicts).every((v) => v === "matched" || v === "ambiguous" || v === "unmatched");
  const have = fs.existsSync(path.join(DT27, "expected.json"));
  check("the shared fixture test/fixtures/g14/dt27/ is there", have);
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
    check(`one verdict per name, the same as cross-check's (want ${JSON.stringify(expected.verdicts)}, got ${JSON.stringify(got)})`,
      Object.keys(expected.verdicts).length === 3 && JSON.stringify(got) === JSON.stringify(expected.verdicts));
    const badge = p27?.components.find((x) => x.name === "Badge")?.catalog;
    check("the ambiguous row lists its candidates (id/key/name, catalog order) and has no name of its own",
      !!badge && badge.by === "ambiguous" && JSON.stringify(badge.candidates) === JSON.stringify([{ id: "12:1", key: "acme-badge-a", name: "Badge" }, { id: "12:2", key: "acme-badge-b", name: "Badge" }]) && !("name" in badge));
  }
}

report();
