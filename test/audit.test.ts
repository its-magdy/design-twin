// Offline tests for design-to-code/audit.ts — the pre-implementation design audit.
//   node test/audit.test.ts
// The fixture is a deliberately flawed login screen: every seeded flaw has one assertion that the
// audit reports it, and the clean parts have assertions that it does NOT (no false positives).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind } from "../design-to-code/audit.ts";
import type { AuditInput } from "../design-to-code/audit.ts";
import type { AuditFinding, CrossCheckFinding, IrNode, TokensDoc } from "../design-to-code/types.ts";
import { locateAuditFile, auditGateStatus } from "../design-to-code/audit-gate.ts";
import { check, report } from "./assert.ts";
import { catalog as catalog1, malformed, must, node, parseAs, readFixture, screenExport } from "./fixtures.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isAuditReport, isComponentsCatalog } from "../design-to-code/doc-guards.ts";
import { isJsonObject } from "../design-to-code/types.ts";
// cross-check --json: a report whose findings are the only part read here.
const isCrossCheckOut = (x: unknown): x is { findings: CrossCheckFinding[] } => isJsonObject(x) && Array.isArray(x.findings);

const screen = readFixture(path.join(import.meta.dirname, "fixtures", "audit", "flawed-login.json"), isScreenExport);
const catalog = readFixture(path.join(import.meta.dirname, "fixtures", "audit", "components.local.json"), isComponentsCatalog);
type FindingCode = AuditFinding["code"];
const codes = (res: { findings: AuditFinding[] }, code: FindingCode) => res.findings.filter((f) => f.code === code);
const onNode = (res: { findings: AuditFinding[] }, code: FindingCode, id: string) => codes(res, code).some((f) => f.nodeId === id);

console.log("color math:");
check("parseHex reads 6- and 8-digit hex", parseHex("#ff0000")!.r === 255 && Math.abs(parseHex("#0000001a")!.a - 26 / 255) < 1e-9);
check("parseHex rejects junk", parseHex("red") === null && parseHex(undefined) === null);
check("contrast black/white = 21:1", Math.abs(contrastRatio(parseHex("#000000")!, parseHex("#ffffff")!) - 21) < 0.01);
check("contrast #767676 on white ≈ 4.54 (the AA boundary)", Math.abs(contrastRatio(parseHex("#767676")!, parseHex("#ffffff")!) - 4.54) < 0.02);
check("ΔE of near-identical colors < 3, distinct colors > 3", deltaE(parseHex("#4f46e5")!, parseHex("#4f46e6")!) < 3 && deltaE(parseHex("#4f46e5")!, parseHex("#e54f46")!) > 3);
check("controlKind classifies common names", controlKind("Text Field") === "input" && controlKind("Primary Button") === "button" && controlKind("Toggle") === "toggle" && controlKind("Tabs") === "tab" && controlKind("Avatar") === null);

console.log("audit — ios:");
const ios = audit({ doc: screen, label: "Login" }, { platform: "ios", catalog });
check("reports the screen label", ios.screens[0] === "Login");
check("fake status bar flagged", onNode(ios, "fake-status-bar", "1:2"));
check("fake home indicator flagged", onNode(ios, "fake-home-indicator", "1:15"));
check("32×32 close button flagged below 44pt", onNode(ios, "small-touch-target", "1:8") && codes(ios, "small-touch-target").find((f) => f.nodeId === "1:8")?.min === 44);
check("icon INSIDE the tappable close button not double-reported", !onNode(ios, "small-touch-target", "1:9"));
check("48pt button/input not flagged", !onNode(ios, "small-touch-target", "1:7") && !onNode(ios, "small-touch-target", "1:6"));
check("fixed-size Subtitle text flagged", onNode(ios, "fixed-size-text", "1:4"));
check("auto-height Title text NOT flagged", !onNode(ios, "fixed-size-text", "1:3"));
check("#bbbbbb on white is low contrast", onNode(ios, "low-contrast", "1:4") && codes(ios, "low-contrast").find((f) => f.nodeId === "1:4")?.required === 4.5);
check("#111 28px bold on white passes", !onNode(ios, "low-contrast", "1:3"));
check("white text on #4f46e6 footer passes (real ancestor bg, not assumed white)", !onNode(ios, "low-contrast", "1:11"));
check("text over an image fill → manual contrast check", onNode(ios, "contrast-manual", "1:14"));
check("missing font is a blocker", codes(ios, "missing-font").length === 1 && codes(ios, "missing-font")[0].severity === "blocker");
check("detached instance flagged", onNode(ios, "detached-instance", "1:12"));
check("no-auto-layout frame flagged", onNode(ios, "no-auto-layout", "1:12"));
check("crop image scale mode flagged", onNode(ios, "image-scale-mode", "1:13"));
check("shadow spread flagged on iOS", onNode(ios, "shadow-spread", "1:7"));
check("corner smoothing NOT flagged on iOS (native continuous corners)", !onNode(ios, "corner-smoothing", "1:7"));
const formGrid = codes(ios, "off-grid-spacing").find((f) => f.nodeId === "1:5");
check("off-grid spacing: gap 10 + padding 13 reported on Form", !!formGrid && /gap=10/.test(formGrid.message) && /paddingTop=13/.test(formGrid.message));
check("auto-layout parent: siblings are NOT treated as a text backdrop", !onNode(ios, "contrast-manual", "1:4"));
check("on-grid root spacing (16/24/34?) — 34 IS off-grid, reported", onNode(ios, "off-grid-spacing", "1:1") && /paddingBottom=34/.test(codes(ios, "off-grid-spacing").find((f) => f.nodeId === "1:1")!.message));
check("near-duplicate raw colors #4f46e6 not paired with bound #4f46e5 (only unbound are clustered)", codes(ios, "near-duplicate-colors").every((f) => !(f.colors || []).includes("#4f46e5")));
check("annotations collected verbatim", ios.annotations.some((a) => a.label === "Email must be validated on blur" && a.nodeId === "1:1"));

console.log("audit — component states:");
const btn = ios.components.find((c) => c.name === "Button");
const field = ios.components.find((c) => c.name === "Text Field");
check("Button on iOS is missing pressed + disabled (hover doesn't count on touch)", btn?.missing.join(",") === "pressed,disabled");
check("Button 'hover' variant VALUE detected despite property named 'Property 1'", btn?.present.includes("hover") === true);
check("Text Field has focus/error/disabled → nothing missing", field?.missing.length === 0);
check("missing-component-states is a warning for a local component", codes(ios, "missing-component-states").some((f) => f.component === "Button" && f.severity === "warning"));
check("Status Bar (remote, not a control) not in state table", !ios.components.some((c) => c.name === "Status Bar"));

console.log("audit — screen states + questions:");
check("no loading/empty/error drawn → not-found", ios.screenStates.loading === "not-found" && ios.screenStates.empty === "not-found" && ios.screenStates.error === "not-found");
check("questions ask for loading, empty, error", ["loading", "empty", "error"].every((s) => ios.questions.some((q) => q.includes(`No ${s} state`))));
check("questions ask about Button's missing states", ios.questions.some((q) => q.includes("'Button'")));

console.log("audit — token binding:");
check("color binding counted (bound < total)", ios.tokenBinding.color.total > ios.tokenBinding.color.bound && ios.tokenBinding.color.bound >= 3);
check("typography: styled Title counts as bound", ios.tokenBinding.typography.bound >= 1);

console.log("audit — platform differences:");
const web = audit(screen, { platform: "web", catalog });
const android = audit(screen, { platform: "android", catalog });
check("web: 32px close button passes the 24px WCAG 2.5.8 minimum", !onNode(web, "small-touch-target", "1:8"));
check("android: 32dp close flagged below 48dp", codes(android, "small-touch-target").find((f) => f.nodeId === "1:8")?.min === 48);
check("web: no fake-status-bar check (no system chrome on web)", codes(web, "fake-status-bar").length === 0);
check("web: Button needs hover+pressed+focus+disabled → missing pressed/focus/disabled", web.components.find((c) => c.name === "Button")?.missing.join(",") === "pressed,focus,disabled");
check("android: corner smoothing flagged (no native squircle)", onNode(android, "corner-smoothing", "1:7"));
check("unknown platform falls back to web", audit(screen, { platform: "watchos" }).platform === "web");

console.log("audit — input shapes + manifest gates:");
const bare = audit(screen.nodes[0], { platform: "ios" });
check("bare layer tree accepted", bare.screens[0] === "Login" && onNode(bare, "fake-status-bar", "1:2"));
check("{tree} wrapper accepted", audit({ name: "Login", id: screen.nodes[0].id, tree: screen.nodes[0] }, { platform: "ios" }).findings.length === bare.findings.length);
check("no catalog → component states unknown, not invented", bare.components.find((c) => c.name === "Button")?.known === false);
const truncated = audit(Object.assign({}, screen, { manifest: { truncated: 2, assetsFailed: 1 } }), { platform: "ios" });
check("truncated export is a blocker", codes(truncated, "export-truncated")[0].severity === "blocker");
check("failed assets are a blocker", codes(truncated, "assets-failed")[0].severity === "blocker");
check("blockers sort first", truncated.findings[0].severity === "blocker");
const drawnStates = structuredClone(screen);
must(drawnStates.nodes[0].children, "the login root's children").push({ type: "FRAME", name: "Skeleton", id: "3:1", hidden: true }, { type: "FRAME", name: "Error toast", id: "3:2", hidden: true });
const ds = audit(drawnStates, { platform: "ios" });
check("hidden 'Skeleton' / 'Error toast' count as designed states", ds.screenStates.loading === "designed" && ds.screenStates.error === "designed" && ds.screenStates.empty === "not-found");
check("garbage input doesn't throw", audit(null).findings.length === 0 && audit(malformed<AuditInput[]>([{}, 42])).screens.length === 0);

console.log("audit — regressions:");
const styled = audit({ nodes: [{ type: "FRAME", name: "S", id: "9:1", children: [
  { type: "INSTANCE", name: "Delete", id: "9:2", component: "Button", mainComponent: { name: "Type=Danger", key: "K", setKey: "KS", setName: "Button" }, box: { w: 120, h: 44 } },
  { type: "TEXT", name: "T", id: "9:3", text: "x", autoResize: "height", font: { size: 14, color: "#111111" }, fills: [{ type: "solid", color: "#111111" }] },
] }] }, { platform: "ios", catalog: catalog1([{ name: "Button", type: "COMPONENT_SET", key: "KS", props: { Variant: { type: "VARIANT", options: ["Primary", "Danger", "Destructive"] } } }]) });
check("'Danger'/'Destructive' style variants are not an error state", !styled.components[0].present.includes("error"));
check("TEXT node fills not double-counted as a second color", styled.tokenBinding.color.total === 1);
const stroked = audit({ type: "FRAME", name: "Search", id: "8:1", strokes: { colors: ["#d4d4d8"], weight: 1, align: "outside" } }, { platform: "web" });
check("outside stroke flagged with the web border/outline note", onNode(stroked, "stroke-align", "8:1") && /outline/.test(codes(stroked, "stroke-align")[0].message));
check("inside stroke (the Figma default for borders) not flagged", !onNode(ios, "stroke-align", "1:6"));

console.log("markdown:");
const md = toMarkdown(ios);
check("markdown has summary, binding table, states, questions", /# Design audit — Login/.test(md) && /## Token binding/.test(md) && /## Component states/.test(md) && /## Questions for the designer/.test(md));
check("markdown lists blockers before warnings", md.indexOf("## Blockers") < md.indexOf("## Warnings"));

console.log("CLI:");
const cli = path.join(import.meta.dirname, "..", "design-to-code", "audit.ts");
const out = execFileSync(process.execPath, [cli, path.join(import.meta.dirname, "fixtures/audit/flawed-login.json"), "--platform", "android", "--catalog", path.join(import.meta.dirname, "fixtures/audit/components.local.json"), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const parsed = parseAs(out, isAuditReport, "audit --json");
check("CLI --json emits the audit for the chosen platform", parsed.platform === "android" && parsed.summary.blockers === 1);
const badExit = spawnSync(process.execPath, [cli, "x.json", "--platform", "tvos"], { stdio: "ignore" }).status;
check("CLI rejects an unknown --platform with exit 2", badExit === 2);
{
  // Wrong-kind inputs are one line + exit 2 (doc-guards.ts), where they used to audit nothing silently
  // (a non-screen JSON) or die with a stack (a malformed design-system file, a bad --grid).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-shape-"));
  const put = (name: string, doc: unknown): string => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const login = path.join(import.meta.dirname, "fixtures/audit/flawed-login.json");
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: tmp });
  const oneLine = (r: { status: number | null; stderr: string }, re: RegExp): boolean => r.status === 2 && re.test(r.stderr) && !/\n {4}at /.test(r.stderr);
  check("[shape] a screen argument that is not a screen export -> exit 2, one line (was: an empty audit)",
    oneLine(run([put("not-a-screen.json", { hello: "world" }), "--json"]), /screen export: '.*not-a-screen\.json' is not a screen export/));
  check("[shape] --catalog that is not a component catalog -> exit 2, one line",
    oneLine(run([login, "--catalog", put("cat.json", { components: [{ type: "COMPONENT" }] }), "--json"]), /component catalog: '.*cat\.json' is not a component catalog/));
  const ds = path.join(tmp, "ds");
  fs.mkdirSync(ds);
  fs.writeFileSync(path.join(ds, "tokens.json"), JSON.stringify({ variables: "none" }));
  check("[shape] a --design-system tokens.json that is not a token catalog -> exit 2 (was: a TypeError stack)",
    oneLine(run([login, "--design-system", ds, "--json"]), /design-system tokens: '.*tokens\.json' is not a token catalog/));
  check("[shape] a --variables file that is not a token catalog -> exit 2, one line",
    oneLine(run([login, "--variables", put("vars.json", { collections: {} }), "--json"]), /variables: '.*vars\.json' is not a token catalog/));
  check("[grid] `--grid abc` is refused (was: silently the 4px default)", oneLine(run([login, "--grid", "abc", "--json"]), /--grid must be a positive number of px, got "abc"/));
  check("[args] `--out --json` is '--out needs a value', never a report written to a file named --json", (() => {
    const r = run([login, "--out", "--json"]);
    return r.status === 2 && /audit: --out needs a value/.test(r.stderr) && !fs.existsSync(path.join(tmp, "--json.json"));
  })());
}

// ---------- the platform is a GUESS unless it was given (live run #10) -------------------------
// Touch-target minimums, shadow spread, blur and blend-mode support are all platform-dependent, so
// a wrong guess silently mis-audits the whole screen. The guess still happens — refusing to run is
// worse — but it must be visible, and it used to surface only as one designer question among 13.
(() => {
  const doc = screen;
  const guessed = audit([{ doc, label: "login" }]);
  const given = audit([{ doc, label: "login" }], { platform: "ios" });
  check("[platform-assumed] no platform -> still audits, still 'web', but flagged as assumed",
    guessed.platform === "web" && guessed.platformAssumed === true);
  check("[platform-assumed] an explicit platform is not flagged", given.platform === "ios" && given.platformAssumed === false);
  check("[platform-assumed] an UNKNOWN platform string is a guess too, not silently honoured",
    audit([{ doc, label: "login" }], { platform: "windows" }).platformAssumed === true);
  const md = toMarkdown(guessed);
  const head = md.split("## Token binding")[0];
  check("[platform-assumed] the markdown says so at the TOP, above the findings, not in a question list",
    /\(ASSUMED — not given\)/.test(head) && /assumed `web`/.test(head) && /--platform ios\|android/.test(head));
  check("[platform-assumed] a given platform gets no banner", !/ASSUMED/.test(toMarkdown(given)));
})();

// ---------- "not found" is scoped to what was audited (live run #9) ---------------------------
(() => {
  const one = audit([{ doc: screen, label: "login" }]);
  check("[states-scope] a single-frame audit says so in the result, not only in prose",
    one.screenStatesScope.rootsAudited === 1 && one.screenStatesScope.singleFrame === true);
  const md = toMarkdown(one);
  const block = md.split("## Screen states")[1].split("##")[0];
  check("[states-scope] the markdown reads 'not in this frame', with the caveat above it",
    /not in this frame — ask/.test(block) && /does not/.test(block) && !/\*\*not found — ask\*\*/.test(block));
  const two = audit([{ doc: screen, label: "a" }, { doc: screen, label: "b" }]);
  check("[states-scope] several frames report the plain verdict and the count",
    two.screenStatesScope.singleFrame === false && two.screenStatesScope.rootsAudited === 2
    && /2 frames audited/.test(toMarkdown(two)));
})();

// The audit must never tell the build to approximate a value (see also [platform-assumed]).
check("[no-snap] the off-grid finding says to keep exact values, not to snap to the grid", (() => {
  const msgs = audit([{ doc: screen, label: "login" }]).findings.map((f) => f.message).join("\n");
  return !/snap to the nearest/.test(msgs) && !/map raw values to the nearest/.test(msgs);
})());

// ---------- CLI: --out defaults to the INPUT file's own basename (P3 #72 #73) ------------------
// Live-run findings 72/73: the SAME node audited twice under two names the skill invented on the
// spot (`positions.md` vs `job-roles.md`, `global-policies.md` vs `System_Configurations.md`) wrote
// byte-identical reports under two filenames in design/audit/. The export file is already named
// `<LayerName>__<node-id>.json` (write-out.js/pages-layout.js) — the one artefact-naming rule — so
// defaulting `--out` to that same basename means two runs against the SAME export file always land
// on the SAME report pair, with no name to agree on out of band.
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-out-"));
  const screenFile = path.join(cwd, "positions___7314_87192.json");
  fs.writeFileSync(screenFile, JSON.stringify({
    exportedAt: "2026-09-22T00:00:00.000Z", screen: "positions ", page: "P", pageId: "1:1", nodeId: "7314:87192",
    nodes: [{ type: "FRAME", name: "positions ", id: "7314:87192", box: { w: 100, h: 100 }, children: [] }],
    manifest: { nodes: 1, truncated: 0, assetsFailed: 0, warnings: [] },
  }));
  const scriptPath = path.join(import.meta.dirname, "..", "design-to-code", "audit.ts");
  const r = spawnSync(process.execPath, [scriptPath, screenFile], { encoding: "utf8", cwd });
  check("[cli-out] with no --out, a report pair is written under design/audit/<the input file's own basename>",
    r.status === 0 &&
    fs.existsSync(path.join(cwd, "design", "audit", "positions___7314_87192.md")) &&
    fs.existsSync(path.join(cwd, "design", "audit", "positions___7314_87192.json")));
  // Re-run: same input file -> same default -> same report pair, not a second name.
  spawnSync(process.execPath, [scriptPath, screenFile], { encoding: "utf8", cwd });
  const dir = fs.readdirSync(path.join(cwd, "design", "audit"));
  check("[cli-out] re-auditing the SAME screen never produces a second name for it",
    dir.filter((f) => f.startsWith("positions")).length === 2); // .md + .json, no duplicate under another name
  check("[cli-out] an explicit --out under a NEW name for the SAME already-audited node is refused (finding 315's sibling), naming the existing file", (() => {
    const r2 = spawnSync(process.execPath, [scriptPath, screenFile, "--out", path.join(cwd, "design", "audit", "custom-name")], { encoding: "utf8", cwd });
    return r2.status === 1 && /already has an audit report/.test(r2.stderr) && /positions___7314_87192/.test(r2.stderr) &&
      !fs.existsSync(path.join(cwd, "design", "audit", "custom-name.md"));
  })());
  check("[cli-out] --force overrides the refusal and writes the second name anyway", (() => {
    const r3 = spawnSync(process.execPath, [scriptPath, screenFile, "--out", path.join(cwd, "design", "audit", "custom-name"), "--force"], { encoding: "utf8", cwd });
    return r3.status === 0 && fs.existsSync(path.join(cwd, "design", "audit", "custom-name.md"));
  })());
})();

// ---------- livetest-3 finding 74: no finding may cite a layer the designer switched off ----------
// Real exports (test/fixtures/livetest3/verify/, built from the livetest-3 run and proven to audit
// byte-identically to the full files). Before: 44 of Job Roles' 119 findings (and 40 of Global
// Policies' 105) cited hidden nodes, including I7314:87216;6:87 "_selected icon" with the instruction
// "the build uses these values EXACTLY".
(() => {
  const FX = path.join(import.meta.dirname, "fixtures", "livetest3", "verify");
  for (const [file, label] of [["positions___7314_87192.json", "Job Roles"], ["System_Configurations__1359_21337.json", "Global Policies"]]) {
    const doc = readFixture(path.join(FX, file), isScreenExport);
    // independent walk — the prompt's own snippet, not hidden.js
    const hidden = new Set<string | undefined>();
    (function w(n: { id?: string; hidden?: boolean; children?: IrNode[] }, h: boolean) { h = h || !!n.hidden; if (h && n.id) hidden.add(n.id); for (const c of n.children || []) w(c, h); })({ children: doc.nodes }, false);
    const res = audit([{ doc, label: file.replace(/\.json$/, "") }], { platform: "web" });
    const cited = res.findings.filter((f) => f.nodeId && hidden.has(f.nodeId));
    check(`[74] ${label}: no finding cites a hidden node (${cited.length} do)`, cited.length === 0);
    check(`[74] ${label}: the skipped layers are counted in the result (${res.hiddenLayers && res.hiddenLayers.nodesSkipped} of ${hidden.size})`, !!res.hiddenLayers && res.hiddenLayers.nodesSkipped === hidden.size);
    check(`[74] ${label}: the markdown says hidden layers were skipped`, /hidden layers \(switched off in Figma\) were skipped/.test(toMarkdown(res)));
    if (label === "Job Roles") {
      check("[74] I7314:87216;6:87 ('_selected icon', hidden) is not cited at all", !res.findings.some((f) => f.nodeId === "I7314:87216;6:87"));
      check("[74] …while visible off-grid spacing is still reported (the audit did not go quiet)", res.findings.some((f) => f.code === "off-grid-spacing" && !hidden.has(f.nodeId)));
    }
  }
})();

// ---------- finding 172: self-inconsistent-geometry (round 2: FIXED-overflow / HUG-mismatch only) ----------
// Real Job Roles table: header 20173:142077 (heightMode absent="fixed", padding [16,32,16,32], tallest
// child box.h=24, declared box.h=44 — content computes 56, OVERFLOWING a fixed box) and every table row
// 20173:142081/086/091/.../137 (heightMode:"hug", padding [16,24,16,24], declared box.h=48, content
// computes 56 — a hug box's declared size must equal its content, in EITHER direction).
//
// Round-2 correction: the first cut also fired on ordinary auto-layout — a FIXED-height sidebar row
// (I10970:111588;1910:23337 'Component 2', box.h=40, padding [0,4,0,12]) whose tallest child is a
// 24-high icon centred in it. Content SHORTER than a fixed box is normal, not a contradiction; the
// rule must only fire when content OVERFLOWS a fixed/fill box, or a hug box's declared size does not
// equal its content (over or under). node.heightMode is the export's own sizing-mode field
// (figma-plugin/src/serialize.ts layoutSizingVertical -> heightMode, default "fixed").
(() => {
  const FX = path.join(import.meta.dirname, "fixtures", "livetest3", "verify");
  const doc = readFixture(path.join(FX, "positions___7314_87192.json"), isScreenExport);
  const res = audit([{ doc, label: "positions___7314_87192" }], { platform: "web" });
  const hits = res.findings.filter((f) => f.code === "self-inconsistent-geometry");
  const rowIds = ["20173:142081", "20173:142086", "20173:142091", "20173:142096", "20173:142102", "20173:142107", "20173:142112", "20173:142117", "20173:142122", "20173:142127", "20173:142132", "20173:142137"];
  check("[172] table header (20173:142077, fixed, overflow 56>44) fires", hits.some((f) => f.nodeId === "20173:142077"));
  check("[172] every table row (hug, declared 48 != computed 56) fires — 12 rows", rowIds.every((id) => hits.some((f) => f.nodeId === id)));
  check("[172] the message names the stated box.h, heightMode and the resulting mismatch", hits.some((f) => f.nodeId === "20173:142077" && /box\.h=44/.test(f.message) && /heightMode:"fixed"/.test(f.message) && /= 56/.test(f.message)));
  check("[172] the hug row's message says a hug box's height IS the content height", hits.some((f) => f.nodeId === "20173:142081" && /heightMode:"hug"/.test(f.message) && /IS the content height/.test(f.message)));
  check("[172] round-2: the sidebar's FIXED 40-high row (I10970:111588;1910:23337, 24-high icon centred, content fits) does NOT fire", !hits.some((f) => f.nodeId === "I10970:111588;1910:23337"));
  check("[172] round-2: its siblings Component 5 / License Health Check (same shape) do NOT fire either", !hits.some((f) => /Component 5|License Health Check/.test(f.nodeName || "")));

  // A consistent FIXED node (padding + tallest child fits inside the declared box) must NOT fire.
  const consistentFixed = node({
    id: "root", name: "root", type: "FRAME", box: { w: 100, h: 100 },
    children: [{ id: "c1", name: "Row", type: "FRAME", box: { w: 100, h: 40 }, layout: { display: "flex", flexDirection: "row", padding: [8, 0, 8, 0] },
      children: [{ id: "c1a", name: "Icon", type: "FRAME", box: { w: 24, h: 24 } }] }], // 8+24+8=40 == declared 40: exact fit
  });
  const resFixed = audit([{ doc: screenExport([consistentFixed]), label: "consistent-fixed" }], { platform: "web" }); // ts-port: hand-built fixture
  check("[172] a FIXED box with children fitting exactly (8+24+8=40, declared 40) does not fire", !resFixed.findings.some((f) => f.code === "self-inconsistent-geometry"));

  // A FIXED box with children SHORTER than the box (the sidebar-row shape) must NOT fire.
  const shorterFixed = node({
    id: "root", name: "root", type: "FRAME", box: { w: 100, h: 100 },
    children: [{ id: "c1", name: "Row", type: "FRAME", box: { w: 220, h: 40 }, layout: { display: "flex", flexDirection: "row", padding: [0, 4, 0, 12] },
      children: [{ id: "c1a", name: "Icon", type: "FRAME", box: { w: 24, h: 24 } }] }], // 0+24+0=24 < declared 40: content fits with room to spare
  });
  const resShorter = audit([{ doc: screenExport([shorterFixed]), label: "shorter-fixed" }], { platform: "web" }); // ts-port: hand-built fixture
  check("[172] a FIXED box whose content is SHORTER than the declared box (normal centred auto-layout) does not fire", !resShorter.findings.some((f) => f.code === "self-inconsistent-geometry"));

  // A HUG box whose declared size DOES equal its content must NOT fire.
  const consistentHug = node({
    id: "root", name: "root", type: "FRAME", box: { w: 100, h: 100 },
    children: [{ id: "c1", name: "Row", type: "FRAME", box: { w: 100, h: 56 }, heightMode: "hug", layout: { display: "flex", flexDirection: "row", padding: [16, 0, 16, 0] },
      children: [{ id: "c1a", name: "Label", type: "TEXT", box: { w: 60, h: 24 } }] }],
  });
  const resHug = audit([{ doc: screenExport([consistentHug]), label: "consistent-hug" }], { platform: "web" }); // ts-port: hand-built fixture
  check("[172] a HUG box whose declared size equals its content (16+24+16=56, declared 56) does not fire", !resHug.findings.some((f) => f.code === "self-inconsistent-geometry"));

  // A HUG box whose declared size is SMALLER than its content must fire (a hug mismatch, not just overflow).
  const shortHug = node({
    id: "root", name: "root", type: "FRAME", box: { w: 100, h: 100 },
    children: [{ id: "c1", name: "Row", type: "FRAME", box: { w: 100, h: 40 }, heightMode: "hug", layout: { display: "flex", flexDirection: "row", padding: [16, 0, 16, 0] },
      children: [{ id: "c1a", name: "Label", type: "TEXT", box: { w: 60, h: 24 } }] }], // 16+24+16=56 != declared 40
  });
  const resShortHug = audit([{ doc: screenExport([shortHug]), label: "short-hug" }], { platform: "web" }); // ts-port: hand-built fixture
  check("[172] a HUG box whose declared size is smaller than its content (40 vs computed 56) DOES fire", resShortHug.findings.some((f) => f.code === "self-inconsistent-geometry"));
})();

// ---------- --grid default is echoed, and flagged when the design system's own scale disagrees (P4 #43) ----------
{
  const dsTokens = malformed<TokensDoc>({
    collections: [{ name: "Spacing", variables: [
      { valuesByMode: { Mode1: 8 } }, { valuesByMode: { Mode1: 16 } }, { valuesByMode: { Mode1: 24 } },
    ] }],
  }); // the legacy {collections[].variables[].valuesByMode} shape audit's grid probe still reads
  const withDefault = audit([{ doc: screen, label: "s" }], { catalog, designSystem: { tokens: dsTokens } });
  check("[grid] the default (no --grid given) is recorded as assumed", withDefault.gridAssumed === true && withDefault.grid === 4);
  check("[grid] an 8px design-system spacing scale is detected and reported as a mismatch", withDefault.gridMismatch === 8);
  check("[grid] the markdown headline names the real step and suggests --grid 8", /grid 4px .*8px.*--grid 8/.test(toMarkdown(withDefault).split("\n")[2]));

  const withExplicit = audit([{ doc: screen, label: "s" }], { catalog, designSystem: { tokens: dsTokens }, grid: 8 });
  check("[grid] passing --grid explicitly turns gridAssumed off and reports no mismatch", withExplicit.gridAssumed === false && withExplicit.gridMismatch === null);
  check("[grid] the markdown headline carries no '(default'/'ASSUMED' grid note when --grid was given", !/grid 8px \*/.test(toMarkdown(withExplicit).split("\n")[2]));
}

// ---------- livetest-3 #311: the audit's gate judges token collisions on the screen's OWN slice ----------
// audit.js embeds cross-check but used to feed it only the merged variables.json, so its --gate raised
// Create Activity Type's `Space 4` (key 64928e3a…, 16) against Job Roles, whose own .vars.json carries
// only the design system's 24 — 5 blockers where cross-check said 3. Real export: test/fixtures/livetest3/.
{
  const FX = path.join(import.meta.dirname, "fixtures", "livetest3");
  const D2C = path.join(import.meta.dirname, "..", "design-to-code");
  const POS = path.join(FX, "pages/__Organization_management_/positions___7314_87192.json");
  const CAT = path.join(FX, "pages/In_progress/Create_Activity_Type__18411_84111.json");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-311-"));
  interface AuditOut { findings: AuditFinding[]; crossFile: { findings?: CrossCheckFinding[] } }
  const runAudit = (f: string, tag: string) => {
    const r = spawnSync(process.execPath, [path.join(D2C, "audit.ts"), f, "--platform", "web", "--design-system", path.join(FX, "design-system"), "--out", path.join(out, tag), "--gate", "--grid", "4"], { encoding: "utf8" });
    let json: AuditOut = { findings: [], crossFile: { findings: [] } };
    if (fs.existsSync(path.join(out, tag + ".json"))) { const rep = readFixture(path.join(out, tag + ".json"), isAuditReport); json = { findings: rep.findings, crossFile: { findings: rep.crossFile ? rep.crossFile.findings : [] } }; }
    return { r, json, md: fs.existsSync(path.join(out, tag + ".md")) ? fs.readFileSync(path.join(out, tag + ".md"), "utf8") : "" };
  };
  const runCross = (f: string): { findings: CrossCheckFinding[] } => {
    const r = spawnSync(process.execPath, [path.join(D2C, "cross-check.ts"), f, "--design-system", path.join(FX, "design-system"), "--json"], { encoding: "utf8" });
    return r.stdout ? parseAs(r.stdout, isCrossCheckOut, "cross-check --json") : { findings: [] };
  };
  const blockerSet = (findings: AuditFinding[]) => findings.filter((f) => f.severity === "blocker" && (f.crossFile === undefined || f.crossFile)).map((f) => `${f.code}|${String(f.token || "")}|${String(f.key || "")}`).sort();
  const pos = runAudit(POS, "pos"), posCross = runCross(POS);
  const collision = (res: { findings: AuditFinding[] }, token: string) => res.findings.filter((f) => f.severity === "blocker" && f.code === "token-name-collision" && f.token === token);
  check("[311] Job Roles: the audit gate raises NO Space 4 collision blocker (its own slice has only the 24-valued key)",
    pos.json.findings.length > 0 && collision(pos.json, "Space 4").length === 0);
  check("[311] Job Roles: the audit's cross-file blockers are exactly cross-check's, same code/token/key",
    blockerSet(pos.json.findings.filter((f) => f.crossFile)).join() === blockerSet(posCross.findings).join() && blockerSet(posCross.findings).length > 0);
  check("[311] and it no longer claims the screen's .vars.json 'was not available' while it sits beside the screen",
    !pos.json.findings.some((f) => /was not available/.test(f.message)));
  check("[311] the union's Space 4 ambiguity stays visible as the -elsewhere NOTE, naming the screen it belongs to",
    /token-name-collision-elsewhere/.test(pos.md) && (pos.json.crossFile.findings || []).some((f) => f.code === "token-name-collision-elsewhere" && f.severity === "info" && /Create_Activity_Type__18411_84111/.test(f.message)));
  const cat = runAudit(CAT, "cat");
  check("[311] Create Activity Type still gets its REAL Space 4 blocker — on key 64928e3a…, the 16-valued one its own slice carries",
    collision(cat.json, "Space 4").some((f) => f.key === "64928e3a5f094c0d9a2c916f50b98ff37c789882") && cat.r.status === 1);
}

// ---------- audit-gate: which audit file belongs to a screen -----------------------------------
// The name fallback matched a slug PREFIX either way, so "Job Roles" picked up the audit of
// "Job Roles Detail" — another screen's blockers gating (or pre-filling the plan of) this one.
(() => {
  console.log("audit-gate — locating a screen's audit by name:");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-gate-"));
  fs.mkdirSync(path.join(cwd, "design", "audit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "design", "audit", "Job_Roles_Detail__9_9.json"), JSON.stringify({ findings: [] }));
  check("[gate] screen \"Job Roles\" does NOT take Job_Roles_Detail__9_9.json (longer name, prefix match)",
    locateAuditFile(cwd, null, "Job Roles") === null && auditGateStatus(cwd, null, "Job Roles").auditFile === null);
  fs.writeFileSync(path.join(cwd, "design", "audit", "Job.json"), JSON.stringify({ findings: [] }));
  check("[gate] …nor Job.json (shorter name, reverse prefix match)", locateAuditFile(cwd, null, "Job Roles") === null);
  fs.writeFileSync(path.join(cwd, "design", "audit", "Job_Roles__9_9.json"), JSON.stringify({ findings: [] }));
  check("[gate] the screen's OWN <Name>__<id>.json audit (audit.ts --out naming) is found by name alone",
    locateAuditFile(cwd, null, "Job Roles") === "design/audit/Job_Roles__9_9.json");
  fs.unlinkSync(path.join(cwd, "design", "audit", "Job_Roles__9_9.json"));
  // safe() turns " - " into "___": the name part itself contains "__", so the id split must be at the LAST one.
  fs.writeFileSync(path.join(cwd, "design", "audit", "Detail___Overview__9_9.json"), JSON.stringify({ findings: [] }));
  check("[gate] a doubled separator in the layer name (Detail - Overview) does NOT match the screen \"Detail\"",
    locateAuditFile(cwd, null, "Detail") === null);
  check("[gate] …but does match its own screen \"Detail - Overview\"",
    locateAuditFile(cwd, null, "Detail - Overview") === "design/audit/Detail___Overview__9_9.json");
  fs.unlinkSync(path.join(cwd, "design", "audit", "Detail___Overview__9_9.json"));
  fs.writeFileSync(path.join(cwd, "design", "audit", "job-roles.json"), JSON.stringify({ findings: [] }));
  check("[gate] the exact case/punctuation-insensitive name still matches", locateAuditFile(cwd, null, "Job Roles") === "design/audit/job-roles.json");
  check("[gate] and the screen file's own basename still wins first",
    locateAuditFile(cwd, path.join(cwd, "design", "export", "pages", "P", "Job_Roles_Detail__9_9.json"), "Job Roles") === "design/audit/Job_Roles_Detail__9_9.json");
})();

// A file in design/audit/ that is not an audit report is `unreadable` — never "this screen has no blockers".
(() => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-gate-shape-"));
  fs.mkdirSync(path.join(cwd, "design", "audit"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "design", "audit", "Home__1_1.json"), JSON.stringify({ findings: "none" }));
  const g = auditGateStatus(cwd, null, "Home");
  check("[gate-shape] an audit file that is not an audit report is reported unreadable (was: read blindly as 0 blockers)",
    g.auditFile === "design/audit/Home__1_1.json" && g.unreadable === true && g.blockers.length === 0);
})();

report();
