// Offline tests for design-to-code/audit.ts — the pre-implementation design audit.
//   node test/audit.test.ts
// The fixture is a deliberately flawed login screen: every seeded flaw has one assertion that the
// audit reports it, and the clean parts have assertions that it does NOT (no false positives).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind, BLOCKER_CODES } from "../design-to-code/audit.ts";
import type { AuditInput, AuditOptions } from "../design-to-code/audit.ts";
import type { AuditFinding, CatalogComponent, ComponentsCatalog, CrossCheckFinding, IrNode, ScreenAssetsDoc, TokensDoc } from "../design-to-code/types.ts";
import { locateAuditFile, auditGateStatus } from "../design-to-code/audit-gate.ts";
import { check, report } from "./assert.ts";
import { catalog as catalog1, malformed, must, node, parseAs, readFixture, screenExport } from "./fixtures.ts";
import { isScreenExport } from "../design-to-code/export-shape.ts";
import { isAuditReport, isComponentsCatalog, isScreenAssetsDoc } from "../design-to-code/doc-guards.ts";
import { isJsonObject } from "../design-to-code/types.ts";
// cross-check --json: a report whose findings are the only part read here.
const isCrossCheckOut = (x: unknown): x is { findings: CrossCheckFinding[] } => isJsonObject(x) && Array.isArray(x.findings);

const screen = readFixture(path.join(import.meta.dirname, "fixtures", "audit", "flawed-login.json"), isScreenExport);
const catalog = readFixture(path.join(import.meta.dirname, "fixtures", "audit", "components.local.json"), isComponentsCatalog);
type FindingCode = AuditFinding["code"];
const codes = (res: { findings: AuditFinding[] }, code: FindingCode) => res.findings.filter((f) => f.code === code);
const onNode = (res: { findings: AuditFinding[] }, code: FindingCode, id: string) => codes(res, code).some((f) => f.nodeId === id);

console.log("color math:");
check("parseHex reads 6- and 8-digit hex", parseHex("#ff0000")?.r === 255 && Math.abs((parseHex("#0000001a")?.a ?? NaN) - 26 / 255) < 1e-9);
check("parseHex rejects junk", parseHex("red") === null && parseHex(undefined) === null);
check("contrast black/white = 21:1", Math.abs(contrastRatio(must(parseHex("#000000"), "parseHex('#000000')"), must(parseHex("#ffffff"), "parseHex('#ffffff')")) - 21) < 0.01);
check("contrast #767676 on white ≈ 4.54 (the AA boundary)", Math.abs(contrastRatio(must(parseHex("#767676"), "parseHex('#767676')"), must(parseHex("#ffffff"), "parseHex('#ffffff')")) - 4.54) < 0.02);
check("ΔE of near-identical colors < 3, distinct colors > 3", deltaE(must(parseHex("#4f46e5"), "parseHex('#4f46e5')"), must(parseHex("#4f46e6"), "parseHex('#4f46e6')")) < 3 && deltaE(must(parseHex("#4f46e5"), "parseHex('#4f46e5')"), must(parseHex("#e54f46"), "parseHex('#e54f46')")) > 3);
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
check("missing font is a blocker", codes(ios, "missing-font").length === 1 && must(codes(ios, "missing-font")[0], "missing-font finding").severity === "blocker");
check("detached instance flagged", onNode(ios, "detached-instance", "1:12"));
check("no-auto-layout frame flagged", onNode(ios, "no-auto-layout", "1:12"));
check("crop image scale mode flagged", onNode(ios, "image-scale-mode", "1:13"));
check("shadow spread flagged on iOS", onNode(ios, "shadow-spread", "1:7"));
check("corner smoothing NOT flagged on iOS (native continuous corners)", !onNode(ios, "corner-smoothing", "1:7"));
const formGrid = codes(ios, "off-grid-spacing").find((f) => f.nodeId === "1:5");
check("off-grid spacing: gap 10 + padding 13 reported on Form", !!formGrid && /gap=10/.test(formGrid.message) && /paddingTop=13/.test(formGrid.message));
check("auto-layout parent: siblings are NOT treated as a text backdrop", !onNode(ios, "contrast-manual", "1:4"));
check("on-grid root spacing (16/24/34?) — 34 IS off-grid, reported", onNode(ios, "off-grid-spacing", "1:1") && /paddingBottom=34/.test(String(codes(ios, "off-grid-spacing").find((f) => f.nodeId === "1:1")?.message)));
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
const screenRoot = must(screen.nodes[0], "screen.nodes[0]");
const bare = audit(screenRoot, { platform: "ios" });
check("bare layer tree accepted", bare.screens[0] === "Login" && onNode(bare, "fake-status-bar", "1:2"));
check("{tree} wrapper accepted", audit({ name: "Login", id: screenRoot.id, tree: screenRoot }, { platform: "ios" }).findings.length === bare.findings.length);
check("no catalog → component states unknown, not invented", bare.components.find((c) => c.name === "Button")?.known === false);
const truncated = audit(Object.assign({}, screen, { manifest: { truncated: 2, assetsFailed: 1 } }), { platform: "ios" });
check("truncated export is a blocker", must(codes(truncated, "export-truncated")[0], "export-truncated finding").severity === "blocker");
check("failed assets are a blocker", must(codes(truncated, "assets-failed")[0], "assets-failed finding").severity === "blocker");
check("blockers sort first", must(truncated.findings[0], "truncated.findings[0]").severity === "blocker");
const drawnStates = structuredClone(screen);
const drawnStatesRoot = must(drawnStates.nodes[0], "drawnStates.nodes[0]");
must(drawnStatesRoot.children, "the login root's children").push({ type: "FRAME", name: "Skeleton", id: "3:1", hidden: true }, { type: "FRAME", name: "Error toast", id: "3:2", hidden: true });
const ds = audit(drawnStates, { platform: "ios" });
check("hidden 'Skeleton' / 'Error toast' count as designed states", ds.screenStates.loading === "designed" && ds.screenStates.error === "designed" && ds.screenStates.empty === "not-found");
check("garbage input doesn't throw", audit(null).findings.length === 0 && audit(malformed<AuditInput[]>([{}, 42])).screens.length === 0);

console.log("audit — regressions:");
const styled = audit({ nodes: [{ type: "FRAME", name: "S", id: "9:1", children: [
  { type: "INSTANCE", name: "Delete", id: "9:2", component: "Button", mainComponent: { name: "Type=Danger", key: "K", setKey: "KS", setName: "Button" }, box: { w: 120, h: 44 } },
  { type: "TEXT", name: "T", id: "9:3", text: "x", autoResize: "height", font: { size: 14, color: "#111111" }, fills: [{ type: "solid", color: "#111111" }] },
] }] }, { platform: "ios", catalog: catalog1([{ name: "Button", type: "COMPONENT_SET", key: "KS", props: { Variant: { type: "VARIANT", options: ["Primary", "Danger", "Destructive"] } } }]) });
check("'Danger'/'Destructive' style variants are not an error state", !must(styled.components[0], "styled.components[0]").present.includes("error"));
check("TEXT node fills not double-counted as a second color", styled.tokenBinding.color.total === 1);
const stroked = audit({ type: "FRAME", name: "Search", id: "8:1", strokes: { colors: ["#d4d4d8"], weight: 1, align: "outside" } }, { platform: "web" });
check("outside stroke flagged with the web border/outline note", onNode(stroked, "stroke-align", "8:1") && /outline/.test(must(codes(stroked, "stroke-align")[0], "stroke-align finding").message));
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
  check("[grid] `--grid -1` (space form) reaches the same message, not '--grid needs a value'", oneLine(run([login, "--grid", "-1", "--json"]), /--grid must be a positive number of px, got "-1"/));
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
  const head = must(md.split("## Token binding")[0], "markdown before '## Token binding'");
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
  const block = must(must(md.split("## Screen states")[1], "'## Screen states' section").split("##")[0], "block before next '##'");
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
  for (const [file, label] of [["positions___7314_87192.json", "Job Roles"], ["System_Configurations__1359_21337.json", "Global Policies"]] satisfies [string, string][]) {
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
// DT-13 correction (field tests): the rows' 24-high child is a menu instance with `hidden: true`; the
// visible content is 16+14…16+16 = 48, exactly as declared, so the rows were a false positive and no
// longer fire. The header stays: its only FLOW child is 24 high (the other four are `absolute`).
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
  check("[172/DT-13] no table row fires — their 24px child is hidden, the visible content is the declared 48", rowIds.every((id) => !hits.some((f) => f.nodeId === id)));
  check("[172] the message names the stated box.h, heightMode and the resulting mismatch", hits.some((f) => f.nodeId === "20173:142077" && /box\.h=44/.test(f.message) && /heightMode:"fixed"/.test(f.message) && /= 56/.test(f.message)));
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
  // The REAL tokens.json shape (F-16): a flat variables[] naming its collection. The legacy
  // {collections[].variables[].valuesByMode} shape this test used to feed exists in no export.
  const step = (name: string, v: number) => ({ name, type: "FLOAT" as const, collection: "Spacing", tier: "primitive" as const, values: { "Mode 1": v } });
  const dsTokens: TokensDoc = { collections: [{ name: "Spacing", modes: ["Mode 1"], theming: false }], variables: [step("Space 1", 8), step("Space 2", 16), step("Space 3", 24)] };
  const withDefault = audit([{ doc: screen, label: "s" }], { catalog, designSystem: { tokens: dsTokens } });
  check("[grid] the default (no --grid given) is recorded as assumed", withDefault.gridAssumed === true && withDefault.grid === 4);
  check("[grid] an 8px design-system spacing scale is detected and reported as a mismatch", withDefault.gridMismatch === 8);
  check("[grid] the markdown headline names the real step and suggests --grid 8", /grid 4px .*8px.*--grid 8/.test(must(toMarkdown(withDefault).split("\n")[2], "markdown headline line")));

  const withExplicit = audit([{ doc: screen, label: "s" }], { catalog, designSystem: { tokens: dsTokens }, grid: 8 });
  check("[grid] passing --grid explicitly turns gridAssumed off and reports no mismatch", withExplicit.gridAssumed === false && withExplicit.gridMismatch === null);
  check("[grid] the markdown headline carries no '(default'/'ASSUMED' grid note when --grid was given", !/grid 8px \*/.test(must(toMarkdown(withExplicit).split("\n")[2], "markdown headline line")));
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

// ================================================================ field tests, group 4 (audit correctness)
// Shapes below are the plugin's real ones (serialize.ts / write-out.ts / library-layout.ts) as seen in
// the field-test exports; names are invented.
console.log("field-test group 4:");
const g4 = (nodes: Parameters<typeof screenExport>[0], screenName = "Items"): AuditInput => ({ doc: screenExport(nodes, { screen: screenName }), label: screenName });

// ---- DT-13 / DT-17 / F-14: hidden and absolute children take no part in the flow height
{
  const res = audit(g4([{ id: "1:1", type: "FRAME", name: "Items", box: { w: 800, h: 600 }, children: [
    // hug row, padding 16/16, one visible 16px label and a HIDDEN 24px menu → 16+16+16 = 48 as declared
    { id: "1:2", type: "FRAME", name: "Row", heightMode: "hug", box: { w: 800, h: 48 }, layout: { display: "flex", flexDirection: "row", padding: [16, 24, 16, 24] }, children: [
      { id: "1:3", type: "TEXT", name: "Label", text: "Label", autoResize: "width_and_height", box: { w: 100, h: 16 } },
      { id: "1:4", type: "INSTANCE", name: "Row Menu", hidden: true, box: { w: 24, h: 24 } },
    ] },
    // hug column, gap 24, padding 40: 130 + 36 + one gap; the close icon is layoutPositioning ABSOLUTE
    { id: "1:5", type: "FRAME", name: "Dialog Body", heightMode: "hug", box: { w: 400, h: 270 }, layout: { display: "flex", flexDirection: "column", gap: 24, padding: [40, 24, 40, 24] }, children: [
      { id: "1:6", type: "FRAME", name: "Art", box: { w: 352, h: 130 } },
      { id: "1:7", type: "TEXT", name: "Title", text: "Title", autoResize: "height", box: { w: 352, h: 36 } },
      { id: "1:8", type: "INSTANCE", name: "Close Icon", absolute: true, box: { w: 24, h: 24, x: 360, y: 16 } },
    ] },
    // control: a hug row that really contradicts itself is still reported
    { id: "1:9", type: "FRAME", name: "Broken Row", heightMode: "hug", box: { w: 800, h: 40 }, layout: { display: "flex", flexDirection: "row", padding: [16, 24, 16, 24] }, children: [
      { id: "1:10", type: "TEXT", name: "Label", text: "Label", autoResize: "width_and_height", box: { w: 100, h: 24 } },
    ] },
  ] }]), { platform: "web" });
  check("[DT-13] a hidden child does not count toward a hug row's height (was: 56 ≠ 48)", !onNode(res, "self-inconsistent-geometry", "1:2"));
  check("[DT-17] an absolute child and its gap do not count toward a column's height (was: 318 ≠ 270)", !onNode(res, "self-inconsistent-geometry", "1:5"));
  check("[DT-13] a real hug mismatch is still reported (16+24+16 = 56 ≠ 40)", codes(res, "self-inconsistent-geometry").some((f) => f.nodeId === "1:9" && f.expectedH === 56));
  check("[172] the hug row's message says a hug box's height IS the content height", codes(res, "self-inconsistent-geometry").some((f) => f.nodeId === "1:9" && /heightMode:"hug"/.test(f.message) && /IS the content height/.test(f.message)));
}

// ---- F-15 / DT-14(1): TEXT siblings' glyph fills are not a backdrop; a disjoint sibling is not either
{
  const white = [{ type: "solid" as const, color: "#ffffff" }];
  const res = audit(g4([{ id: "2:1", type: "FRAME", name: "Items", fills: [{ type: "solid", color: "#ffffff" }], box: { w: 1112, h: 600, x: 0, y: 0 }, children: [
    { id: "2:2", type: "FRAME", name: "table header", fills: [{ type: "solid", color: "#46464f" }], box: { w: 1112, h: 44 }, layout: { display: "flex", flexDirection: "row", gap: 146, padding: [16, 32, 16, 32] }, children: [
      { id: "2:3", type: "TEXT", name: "Table Header", text: "Name", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 102, h: 24 } },
      { id: "2:4", type: "TEXT", name: "Table Header", text: "Amount", autoResize: "width_and_height", absolute: true, fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 120, h: 24, x: 1025, y: 10 } },
      { id: "2:5", type: "TEXT", name: "Table Header", text: "Date", autoResize: "width_and_height", absolute: true, fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 121, h: 24, x: 578, y: 10 } },
    ] },
    // no auto layout: a pale chip UNDER the caption is a real backdrop; one far away is not
    { id: "2:6", type: "FRAME", name: "Card", fills: [{ type: "solid", color: "#46464f" }], box: { w: 400, h: 200, x: 0, y: 100 }, children: [
      { id: "2:7", type: "RECTANGLE", name: "Chip", fills: [{ type: "solid", color: "#eeeeee" }], box: { w: 100, h: 30, x: 10, y: 110 } },
      { id: "2:8", type: "TEXT", name: "Option 1", text: "Pick a category for this entry", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 80, h: 20, x: 15, y: 115 } },
      { id: "2:9", type: "RECTANGLE", name: "Far Chip", fills: [{ type: "solid", color: "#eeeeee" }], box: { w: 50, h: 30, x: 300, y: 250 } },
      { id: "2:10", type: "TEXT", name: "Caption", text: "Caption", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 80, h: 20, x: 150, y: 150 } },
    ] },
  ] }]), { platform: "web" });
  check("[F-15] white absolute header labels after a white TEXT sibling are not 1:1 (was: low-contrast on both)", !onNode(res, "low-contrast", "2:4") && !onNode(res, "low-contrast", "2:5"));
  check("[F-15] white text over an overlapping pale chip IS low contrast", onNode(res, "low-contrast", "2:8"));
  check("[F-15] a sibling that does not overlap the text is not its backdrop", !onNode(res, "low-contrast", "2:10"));
  const lc = codes(res, "low-contrast").find((f) => f.nodeId === "2:8");
  check("[DT-14(2)/F-25] a contrast finding quotes the layer's text beside its name", !!lc && /'Option 1' \("Pick a category for this entry"\)/.test(lc.message) && lc.text === "Pick a category for this entry");
}

// ---- F-23 / DT-14(3,4): empty-state copy at any depth; dialogs; validation
{
  const deep = (depth: number, leaf: Parameters<typeof node>[0]): Parameters<typeof node>[0] => depth ? { id: `3:d${depth}`, type: "FRAME", name: `Level ${depth}`, children: [deep(depth - 1, leaf)] } : leaf;
  const res = audit(g4([{ id: "3:1", type: "FRAME", name: "Items", children: [deep(8, { id: "3:2", type: "TEXT", name: "Main Text", text: "No items added yet.", autoResize: "height" })] }]), { platform: "web" });
  check("[F-23] 'No items added yet.' 8 levels down (with a non-breaking space) → empty: designed", res.screenStates.empty === "designed" && !res.questions.some((q) => /No empty state/.test(q)));
  const neg = audit(g4([{ id: "3:3", type: "FRAME", name: "Items", children: [{ id: "3:4", type: "TEXT", name: "Answer", text: "No, keep editing", autoResize: "height" }] }]), { platform: "web" });
  check("[F-23] ordinary 'No, …' copy is not an empty state", neg.screenStates.empty === "not-found");
  check("[DT-14(4)] a page with no inputs has no validation state at all", !("validation" in res.screenStates));
  const field = (id: string, variant: string): Parameters<typeof node>[0] => ({ id, type: "INSTANCE", name: "Name Field", mainComponent: { name: variant, setName: "input Field", key: `k-${id}`, setKey: "k-field", remote: true }, box: { w: 300, h: 48 } });
  const dialog = audit(g4([{ id: "3:5", type: "FRAME", name: "Popup", children: [field("3:6", "Status=Default")] }], "Popup"), { platform: "web" });
  check("[DT-14(4)] a dialog's empty state is not-applicable and not asked", dialog.screenStates.empty === "not-applicable" && !dialog.questions.some((q) => /No empty state/.test(q)));
  check("[DT-14(4)] a dialog with an input asks about validation", dialog.screenStates.validation === "not-found" && dialog.questions.some((q) => /validation state/.test(q)));
  check("[DT-14(4)] a dialog's loading question is about its action, not data", dialog.questions.some((q) => /No loading state.*action runs/.test(q)));
  const withError = audit(g4([{ id: "3:7", type: "FRAME", name: "Popup", children: [field("3:8", "Status=Default"), field("3:9", "Status=Error")] }], "Popup"), { platform: "web" });
  check("[DT-14(4)] an input drawn in its Error variant → validation: designed", withError.screenStates.validation === "designed");
  const md4 = toMarkdown(dialog);
  check("[DT-14(4)] markdown says not-applicable in words", /- empty: not applicable/.test(md4) && /- validation: \*\*not in this frame — ask\*\*/.test(md4));
}

// ---- F-25 / DT-14(5): heavy assets from <Screen>.assets.json; prototype links
{
  const assets: ScreenAssetsDoc = {
    heavy: [{ file: "assets/Illustration.svg", bytes: 2465864, paths: 1523 }, { file: "assets/Hidden_Art.svg", bytes: 900000, paths: 800 }],
    files: [{ file: "assets/Illustration.svg", node: "4:3" }, { file: "assets/Hidden_Art.svg", node: "4:4" }],
  };
  const click = (destination: string, navigation: string) => [{ trigger: "on_click", actions: [{ type: "node", destinationId: "9:1", destination, navigation }] }];
  const res = audit({ ...g4([{ id: "4:1", type: "FRAME", name: "Items", children: [
    { id: "4:3", type: "FRAME", name: "Art", asset: "assets/Illustration.svg" },
    { id: "4:4", type: "FRAME", name: "Old Art", hidden: true, asset: "assets/Hidden_Art.svg" },
    { id: "4:5", type: "INSTANCE", name: "Row", reactions: click("Item Details", "navigate") },
    { id: "4:6", type: "INSTANCE", name: "Row", reactions: click("Item Details", "navigate") },
    { id: "4:7", type: "INSTANCE", name: "Add Button", reactions: click("Add Item", "overlay") },
    { id: "4:8", type: "INSTANCE", name: "Menu Item", reactions: [{ trigger: "on_hover", actions: [{ type: "node", destinationId: "9:2", destination: "state=hover", navigation: "change_to" }] }] },
  ] }]), assets }, { platform: "web" });
  const heavy = codes(res, "heavy-asset");
  check("[F-25] a heavy asset in <Screen>.assets.json is an info finding on its node", heavy.length === 1 && heavy[0]?.nodeId === "4:3" && heavy[0]?.severity === "info" && heavy[0]?.bytes === 2465864 && /2\.35 MB \/ 1523 <path>/.test(heavy[0]?.message ?? ""));
  check("[F-25] a hidden layer's heavy asset is not reported", !heavy.some((f) => f.file === "assets/Hidden_Art.svg"));
  const nav = codes(res, "prototype-navigation");
  check("[DT-14(5)] prototype links: one info per destination, counted", nav.length === 2 && nav.some((f) => f.destination === "Item Details" && f.sources === 2) && nav.some((f) => f.destination === "Add Item" && f.navigation === "overlay"));
  check("[DT-14(5)] a hover variant swap (change_to) is not a link", !nav.some((f) => f.destination === "state=hover"));
}

// ---- DT-50 (old exports) / DT-09: asset-leaf spacing is the inset baked into the file; a raster in an SVG shell
{
  const pad = (v: number): { display: "flex"; padding: number[]; gap: number } => ({ display: "flex", padding: [v, v, v, v], gap: 5 });
  const res = audit(g4([{ id: "5:1", type: "FRAME", name: "Items", layout: { display: "flex", padding: [13, 13, 13, 13] }, children: [
    { id: "5:2", type: "VECTOR", name: "mark", asset: "assets/mark.svg", layout: pad(3.33) },
    { id: "5:3", type: "VECTOR", name: "mark two", geometry: { fills: ["M0 0"] }, layout: pad(1.25) },
    { id: "5:4", type: "VECTOR", name: "mark three", assetSkipped: "hidden", layout: pad(0.09375) },
    { id: "5:5", type: "VECTOR", name: "mark four", assetSkipped: true, layout: pad(5.0001) },
  ] }]), { platform: "web" });
  const og = codes(res, "off-grid-spacing");
  check("[DT-50] off-grid inferred padding/gap on asset leaves (asset, geometry, assetSkipped true and \"hidden\") is not reported", !og.some((f) => ["5:2", "5:3", "5:4", "5:5"].includes(String(f.nodeId))));
  check("[DT-50] …while a real frame's off-grid padding still is", og.some((f) => f.nodeId === "5:1" && /paddingTop=13/.test(f.message)));
  const tally = (r: typeof res) => JSON.stringify(r.tokenBinding.spacing);
  const plain = audit(g4([{ id: "5:1", type: "FRAME", name: "Items", layout: { display: "flex", padding: [13, 13, 13, 13] }, children: [] }]), { platform: "web" });
  check("[DT-50] …and the spacing tally counts only the real frame (the asset leaves add nothing)", tally(res) === tally(plain));

  check("[DT-09] the .assets.json guard accepts heavy[].embeddedRaster and extra files[] fields, and rejects a non-number embeddedRaster",
    isScreenAssetsDoc({ heavy: [{ file: "assets/a.svg", bytes: 9, paths: 2, embeddedRaster: 1 }], files: [{ file: "assets/a.svg", node: "1:1", owner: "x", reuseKey: "k" }] })
    && isScreenAssetsDoc({ heavy: [{ file: "assets/a.svg", bytes: 9 }] })
    && !isScreenAssetsDoc({ heavy: [{ file: "assets/a.svg", bytes: 9, embeddedRaster: "1" }] }));
  const mk = (h: { file: string; bytes: number; paths?: number; embeddedRaster?: number }) => audit({ ...g4([{ id: "5:6", type: "FRAME", name: "Avatar", asset: h.file }]), assets: { heavy: [h], files: [{ file: h.file, node: "5:6" }] } }, { platform: "web" });
  const raster = codes(mk({ file: "assets/avatar-raster.svg", bytes: 1980000, paths: 2, embeddedRaster: 1 }), "heavy-asset");
  check("[DT-09] a heavy row with embeddedRaster uses the raster wording, not 'too heavy to inline'",
    raster.length === 1 && /1\.89 MB — a raster image embedded in an SVG shell; use it as an image/.test(raster[0]?.message ?? "") && /PNG\/JPG export/.test(raster[0]?.message ?? "") && !/<path>|too heavy/.test(raster[0]?.message ?? "") && raster[0]?.embeddedRaster === 1);
  const paths = codes(mk({ file: "assets/big.svg", bytes: 2465864, paths: 1523 }), "heavy-asset");
  // L-7: the pull's rule — an <image> in an illustration of 2000 paths is still "too many paths", not a shell.
  // pre-fix: the raster wording (the audit read embeddedRaster alone).
  const busy = codes(mk({ file: "assets/illustration.svg", bytes: 2400000, paths: 2000, embeddedRaster: 1 }), "heavy-asset");
  check("[L-7] embeddedRaster with 2000 paths keeps the paths wording (the bridge's raster-shell rule: under 50 paths)",
    busy.length === 1 && /2\.29 MB \/ 2000 <path> elements — too heavy to inline/.test(busy[0]?.message ?? "") && !/SVG shell/.test(busy[0]?.message ?? "") && busy[0]?.embeddedRaster === 1);
  check("[DT-09] without embeddedRaster the paths wording stays (default)", paths.length === 1 && /2\.35 MB \/ 1523 <path> elements — too heavy to inline/.test(paths[0]?.message ?? "") && paths[0]?.embeddedRaster === undefined);
}

// ---- DT-80 / DT-11: state coverage reads every catalog, and says so when it cannot run
{
  const button = (key: string): Parameters<typeof node>[0] => ({ id: `5:${key}`, type: "INSTANCE", name: "Button", mainComponent: { name: "Type=Primary, Status=Default", setName: "Button", key: `v-${key}`, setKey: key, remote: true }, box: { w: 120, h: 40 } });
  const buttonSet = (key: string): CatalogComponent => ({ name: "Button", id: "1:10", type: "COMPONENT_SET", key, props: {
    Type: { key: "Type", type: "VARIANT", options: ["Primary", "Secondary"] },
    Status: { key: "Status", type: "VARIANT", options: ["Default", "Hover", "Disabled"] },
    "Show Text": { key: "Show Text#2007:0", type: "BOOLEAN", default: true },
  } });
  const cat = (components: CatalogComponent[]): ComponentsCatalog => ({ components });
  const screen5 = g4([{ id: "5:1", type: "FRAME", name: "Items", children: [button("k-set"), { id: "5:9", type: "INSTANCE", name: "icons/line/magnifier-search", component: "icons/line/magnifier-search", asset: "assets/magnifier-search.svg", mainComponent: { name: "icons/line/magnifier-search", id: "18:31", key: "k-icon", remote: true } }] }]);
  const dsOnly = audit(screen5, { platform: "web", designSystem: { components: cat([buttonSet("k-set")]) } });
  const b = codes(dsOnly, "missing-component-states")[0];
  check("[DT-80] --design-system alone checks states (was: nothing, no finding)", !!b && b.severity === "warning" && JSON.stringify(b.missing) === JSON.stringify(["pressed", "focus"]));
  check("[DT-80] the row says which catalog and how it matched", dsOnly.components.some((c) => c.name === "Button" && c.known && c.matchedBy === "key" && c.catalog === "the design system"));
  check("[DT-80] an icon instance (exported as an asset) is not a control to check", !dsOnly.components.some((c) => /search/.test(c.name)) && !codes(dsOnly, "component-states-unchecked").length);
  const none = audit(screen5, { platform: "web" });
  const u = codes(none, "component-states-unchecked")[0];
  check("[DT-80] no catalog → a warning that states could not be checked, plus a question", !!u && u.severity === "warning" && JSON.stringify(u.controls) === JSON.stringify(["Button"]) && none.questions.some((q) => /could not be checked/.test(q)));
  // A library export's FULL definitions, found under libraries/: matched by name (the screen's copy is re-keyed); a warning, not "sampled".
  const lib = audit(screen5, { platform: "web", designSystem: { components: cat([]) }, designSystemDir: "design/export/design-system", libraries: [{ rel: "design/export/libraries/shared-kit-ab12cd34", name: "Shared Kit", collectionKeys: ["c-1", "c-2"], components: cat([buttonSet("k-lib")]) }] });
  check("[DT-11] a --as-library export's components.json feeds the state check (by name, a warning — full definitions)", lib.components.some((c) => c.name === "Button" && c.catalog === "design/export/libraries/shared-kit-ab12cd34" && c.matchedBy === "name" && c.sampled === false) && codes(lib, "missing-component-states")[0]?.severity === "warning");
  check("[DT-11] the report names the library export and the command to check against it", lib.crossFile?.notChecked.some((n) => /libraries\/shared-kit-ab12cd34 \('Shared Kit'\).*--design-system design\/export\/libraries\/shared-kit-ab12cd34/.test(n)) === true);
  const self = audit(screen5, { platform: "web", designSystem: { components: cat([buttonSet("k-lib")]) }, designSystemDir: "design/export/libraries/shared-kit-ab12cd34", libraries: [{ rel: "design/export/libraries/shared-kit-ab12cd34", name: "Shared Kit", collectionKeys: [], components: cat([buttonSet("k-lib")]) }] });
  check("[DT-11] no hint when the audit already runs against that library", !self.crossFile?.notChecked.some((n) => /library export/.test(n)));
  // components.library.json: one sampled row per variant in use, values under `observed` → info, present from what was seen
  const sampledRow = (variant: string, status: string): CatalogComponent => ({ name: "Button", key: `v-${status}`, type: "COMPONENT", remote: true, source: "unknown-library", uses: 8, variant, props: { Status: { key: "Status", type: "VARIANT", observed: [status] } }, derivedFrom: "instances" });
  const sampled = audit(screen5, { platform: "web", designSystem: { componentsLibrary: cat([sampledRow("Type=Primary, Status=Default", "Default"), sampledRow("Type=Primary, Status=Hover", "Hover")]) } });
  const sRow = sampled.components.find((c) => c.name === "Button");
  check("[DT-80] a sampled library catalog: every row of the set is read, severity info", !!sRow && sRow.sampled === true && sRow.present.includes("hover") && codes(sampled, "missing-component-states")[0]?.severity === "info");
}

// ---- F-16: the spacing step comes from the REAL tokens.json shape, and a given --grid is checked too
{
  const space = (name: string, v: number) => ({ name, type: "FLOAT" as const, collection: "Spacing", tier: "primitive" as const, values: { "Mode 1": v }, scopes: ["WIDTH_HEIGHT", "GAP"], key: `s-${v}` });
  const tokens: TokensDoc = { collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1", theming: false, key: "c-1" }], variables: [
    space("Space 1", 4), space("Space 2", 8), space("Space 3", 16), space("Space 4", 24), space("Space 5", 32), space("Space 6", 40), space("Space 7", 48),
    { name: "Cards Padding", type: "FLOAT", collection: "Semantic", tier: "semantic", values: { Dark: { aliasOf: "Space 4" } }, scopes: ["WIDTH_HEIGHT", "GAP"] },
    { name: "Radius 1", type: "FLOAT", collection: "Border Radius", tier: "primitive", values: { "Mode 1": 6 }, scopes: ["CORNER_RADIUS"] },
  ] };
  const s6 = g4([{ id: "6:1", type: "FRAME", name: "Items" }]);
  const given8 = audit(s6, { platform: "web", grid: 8, designSystem: { tokens } });
  check("[F-16] --grid 8 on a 4-step spacing scale → gridMismatch 4 (was: never, the reader looked for collections[].variables)", given8.gridMismatch === 4 && /as given; this system's own spacing tokens step by 4px, not 8px/.test(toMarkdown(given8)));
  check("[F-16] the default 4 on a 4-step scale → no mismatch", audit(s6, { platform: "web", designSystem: { tokens } }).gridMismatch === null);
  const eight: TokensDoc = { variables: [space("S1", 8), space("S2", 16), space("S3", 24)] };
  check("[F-16] an 8-step scale with the default grid → gridMismatch 8", audit(s6, { platform: "web", designSystem: { tokens: eight } }).gridMismatch === 8);
}

// ---- DT-11 end to end: the CLI reads a library dir's components.json and finds libraries/ beside the export
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-lib-"));
  const put = (rel: string, doc: unknown): string => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(doc)); return f; };
  const libDir = "design/export/libraries/shared-kit-ab12cd34";
  put("design/export/design-system/tokens.json", { collections: [{ name: "Local", modes: ["Mode 1"], key: "c-local" }], variables: [] });
  put("design/export/design-system/components.local.json", { components: [{ name: "Header", type: "COMPONENT_SET", key: "k-header", props: {} }] });
  put("design/export/libraries/index.json", { libraries: [{ dir: "shared-kit-ab12cd34", libraryName: "Shared Kit", file: "Shared Kit", collectionKeys: ["c-1"], exportedAt: "2026-01-01T00:00:00.000Z", counts: { collections: 1, variables: 0, stylesPaint: 0, stylesText: 0, stylesEffect: 0, stylesGrid: 0, components: 1, hygiene: 0 }, index: "shared-kit-ab12cd34/index.json" }], generatedAt: "2026-01-01T00:00:00.000Z" });
  put(`${libDir}/tokens.json`, { collections: [{ name: "Spacing", modes: ["Mode 1"], key: "c-1" }], variables: [] });
  put(`${libDir}/components.json`, { components: [{ name: "Button", id: "1:10", type: "COMPONENT_SET", key: "k-lib", props: { Status: { key: "Status", type: "VARIANT", options: ["Default", "Hover", "Disabled"] } } }] });
  const screenFile = put("design/export/pages/Main/Items__1_1.json", screenExport([{ id: "1:1", type: "FRAME", name: "Items", children: [{ id: "1:2", type: "INSTANCE", name: "Button", mainComponent: { name: "Status=Default", setName: "Button", key: "v-1", setKey: "k-copy", remote: true }, box: { w: 120, h: 40 } }] }], { screen: "Items" }));
  put("design/export/pages/Main/Items__1_1.vars.json", { collections: [{ name: "Spacing", modes: ["Mode 1"], key: "c-1" }, { name: "Local", modes: ["Mode 1"], key: "c-local" }], variables: [] });
  const runAudit = (ds: string) => parseAs(execFileSync(process.execPath, [cli, path.relative(root, screenFile), "--platform", "web", "--design-system", ds, "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), isAuditReport, "audit --json");
  const viaDs = runAudit("design/export/design-system");
  check("[DT-11 CLI] with design-system/, the library beside it still defines the Button's states", viaDs.components.some((c) => c.name === "Button" && c.known && c.catalog === libDir));
  check("[DT-11 CLI] …and the report names it, with its by-key share of the screen's collections", viaDs.crossFile?.notChecked.some((n) => n.includes(`--design-system ${libDir}`) && /binds 1 of its 2 variable collection/.test(n)) === true);
  const viaLib = runAudit(libDir);
  check("[DT-11 CLI] --design-system <library dir> reads its components.json (was: silently none)", viaLib.crossFile?.inputs.components === true && viaLib.components.some((c) => c.name === "Button" && c.catalog === libDir) && !viaLib.crossFile?.notChecked.some((n) => /library export/.test(n)));
  const cc = parseAs(execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "cross-check.ts"), path.relative(root, screenFile), "--design-system", libDir, "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), isCrossCheckOut, "cross-check --json");
  check("[DT-11 CLI] cross-check reads a library dir's components.json too", !cc.findings.some((f) => /no components\.local\.json/.test(f.message)) && (cc as { inputs?: { components?: boolean } }).inputs?.components === true);
}

// ---- review round 1 of group 4
{
  const white = [{ type: "solid" as const, color: "#ffffff" }];
  // H1: an ELLIPSE avatar disc and a photo RECTANGLE are exported as assets but ARE surfaces; a VECTOR icon is ink
  const res = audit(g4([{ id: "7:1", type: "FRAME", name: "Items", fills: [{ type: "solid", color: "#ffffff" }], box: { w: 600, h: 400, x: 0, y: 0 }, children: [
    { id: "7:2", type: "FRAME", name: "Avatar", box: { w: 40, h: 40, x: 10, y: 10 }, children: [
      { id: "7:3", type: "ELLIPSE", name: "Disc", asset: "assets/Disc.svg", fills: [{ type: "solid", color: "#1d4ed8" }], box: { w: 40, h: 40, x: 10, y: 10 } },
      { id: "7:4", type: "TEXT", name: "Initials", text: "AB", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 20, h: 16, x: 20, y: 22 } },
    ] },
    { id: "7:5", type: "FRAME", name: "Hero", box: { w: 300, h: 200, x: 100, y: 10 }, children: [
      { id: "7:6", type: "RECTANGLE", name: "Photo", asset: "assets/Photo.png", fills: [{ type: "image", scaleMode: "fill" }], box: { w: 300, h: 200, x: 100, y: 10 } },
      { id: "7:7", type: "TEXT", name: "Caption", text: "Summer sale", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 100, h: 16, x: 120, y: 150 } },
    ] },
    { id: "7:11", type: "FRAME", name: "Banner", box: { w: 200, h: 100, x: 100, y: 250 }, children: [
      { id: "7:12", type: "FRAME", name: "Banner Image", asset: "assets/Banner_Image.png", fills: [{ type: "image", scaleMode: "fill" }], box: { w: 200, h: 100, x: 100, y: 250 } },
      { id: "7:13", type: "TEXT", name: "Banner Title", text: "Welcome", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 80, h: 16, x: 110, y: 300 } },
    ] },
    { id: "7:8", type: "FRAME", name: "Badge", fills: [{ type: "solid", color: "#1f2937" }], box: { w: 40, h: 40, x: 450, y: 10 }, children: [
      { id: "7:9", type: "VECTOR", name: "Star Icon", asset: "assets/Star.svg", fills: white, box: { w: 40, h: 40, x: 450, y: 10 } },
      { id: "7:10", type: "TEXT", name: "Count", text: "3", autoResize: "width_and_height", fills: white, font: { color: "#ffffff", size: 14 }, box: { w: 10, h: 16, x: 465, y: 22 } },
    ] },
  ] }]), { platform: "web" });
  check("[review H1] white initials on a blue ELLIPSE asset disc are not 1:1", !onNode(res, "low-contrast", "7:4"));
  check("[review H1] a caption on a photo RECTANGLE asset → manual check, not 1:1", onNode(res, "contrast-manual", "7:7") && !onNode(res, "low-contrast", "7:7"));
  check("[review H1] a VECTOR icon's ink is still not a backdrop", !onNode(res, "low-contrast", "7:10"));
  check("[re-review L1] an image-filled FRAME asset leaf is a surface (manual check), not ink", onNode(res, "contrast-manual", "7:13") && !onNode(res, "low-contrast", "7:13"));
}
{
  // H2: key matches (sampled included) beat name matches; an unrelated library is not name-matched; same-name rows read together
  const btn: Parameters<typeof node>[0] = { id: "8:2", type: "INSTANCE", name: "Button", mainComponent: { name: "Status=Default", setName: "Button", key: "v-default", setKey: "set-remote", remote: true }, box: { w: 120, h: 40 } };
  const sampledRow = (status: string): CatalogComponent => ({ name: "Button", key: status === "Default" ? "v-default" : `v-${status}`, type: "COMPONENT", remote: true, source: "unknown-library", uses: 3, variant: `Status=${status}`, props: { Status: { key: "Status", type: "VARIANT", observed: [status] } }, derivedFrom: "instances" });
  const unrelated: CatalogComponent = { name: "Button", id: "1:1", type: "COMPONENT_SET", key: "k-other", props: { Size: { key: "Size", type: "VARIANT", options: ["Small", "Large"] } } };
  const vars: TokensDoc = { collections: [{ name: "Brand", modes: ["Mode 1"], theming: false, key: "c-brand" }], variables: [] };
  const input: AuditInput = { doc: screenExport([{ id: "8:1", type: "FRAME", name: "Items", children: [btn] }], { screen: "Items" }), label: "Items", vars };
  const res = audit(input, { platform: "web", designSystem: { componentsLibrary: { components: ["Default", "Hover", "Pressed", "Focus", "Disabled"].map(sampledRow) } },
    libraries: [{ rel: "design/export/libraries/other-kit-00000000", name: "Other Kit", collectionKeys: ["c-other"], components: { components: [unrelated] } }] });
  const row = res.components.find((c) => c.name === "Button");
  const noSample = audit(input, { platform: "web", libraries: [{ rel: "design/export/libraries/other-kit-00000000", name: "Other Kit", collectionKeys: ["c-other"], components: { components: [unrelated] } }] });
  check("[review H2] a library sharing no variable collection with the screen is not name-matched", codes(noSample, "component-states-unchecked").length === 1 && !codes(noSample, "missing-component-states").length);
  const related = audit(input, { platform: "web", libraries: [{ rel: "design/export/libraries/brand-kit-22222222", name: "Brand Kit", collectionKeys: ["c-brand"], components: { components: [unrelated] } }] });
  check("[review H2] …one that does share a collection is", related.components.some((c) => c.name === "Button" && c.matchedBy === "name" && c.catalog === "design/export/libraries/brand-kit-22222222"));
  const defined: CatalogComponent = { name: "Button", id: "1:2", type: "COMPONENT_SET", key: "k-brand", props: { Status: { key: "Status", type: "VARIANT", options: ["Default", "Hover", "Disabled"] } } };
  const both = audit(input, { platform: "web", designSystem: { componentsLibrary: { components: ["Default", "Pressed"].map(sampledRow) } },
    libraries: [{ rel: "design/export/libraries/brand-kit-22222222", name: "Brand Kit", collectionKeys: ["c-brand"], components: { components: [defined] } }] });
  const bothRow = both.components.find((c) => c.name === "Button");
  check("[review H2] a related library's definition gives the list, states seen in use are added: only focus missing, a warning", !!bothRow && bothRow.sampled === false && JSON.stringify(bothRow.missing) === JSON.stringify(["focus"]) && codes(both, "missing-component-states")[0]?.severity === "warning");
  const unknownLib = audit(input, { platform: "web", designSystem: { componentsLibrary: { components: ["Default"].map(sampledRow) } },
    libraries: [{ rel: "design/export/libraries/old-kit-33333333", name: "Old Kit", collectionKeys: [], components: { components: [unrelated] } }] });
  check("[re-review M1] a library related only because its keys are unknown does not outrank a sampled key match", unknownLib.components.find((c) => c.name === "Button")?.catalog === "components.library.json" && codes(unknownLib, "missing-component-states")[0]?.severity === "info");
  check("[review H2] a sampled KEY match wins over a same-named row in an unrelated library", !!row && row.matchedBy === "key" && row.catalog === "components.library.json" && row.missing.length === 0);
  const toggleUse: Parameters<typeof node>[0] = { id: "8:4", type: "INSTANCE", name: "Toggle", mainComponent: { name: "Status=Checked", setName: "Toggle", key: "v-t", setKey: "set-copy", remote: true }, box: { w: 40, h: 24 } };
  const toggleLib = { components: [
    { name: "Toggle", id: "2:1", type: "COMPONENT" as const, key: "k-bare" },
    { name: "Toggle", id: "2:2", type: "COMPONENT_SET" as const, key: "k-set-a", props: { Status: { key: "Status", type: "VARIANT" as const, options: ["Checked", "Unchecked", "Disabled"] } } },
  ] };
  const t = audit(g4([{ id: "8:3", type: "FRAME", name: "Items", children: [toggleUse] }]), { platform: "web", libraries: [{ rel: "design/export/libraries/kit-copy-11111111", name: "Kit Copy", collectionKeys: [], components: toggleLib }] });
  check("[review H2] a bare COMPONENT sharing the name does not hide the set's states (was: toggle has no selected/disabled)", !codes(t, "missing-component-states").length && t.components.some((c) => c.name === "Toggle" && c.present.includes("selected") && c.present.includes("disabled")));
}
{
  const inst = (id: string, name: string, extra: Partial<IrNode> = {}): Parameters<typeof node>[0] => ({ id, type: "INSTANCE", name, mainComponent: { name: "Status=Default", setName: name, key: `v-${id}`, setKey: `s-${id}`, remote: true }, box: { w: 200, h: 40 }, ...extra });
  const list = audit(g4([{ id: "9:1", type: "FRAME", name: "Items", children: [inst("9:2", "search bar"), inst("9:3", "filter button")] }]), { platform: "web" });
  check("[review M1] a list page whose only input is a search bar is not asked about validation", !("validation" in list.screenStates));
  const iconBtn = audit(g4([{ id: "9:4", type: "FRAME", name: "Items", children: [inst("9:5", "Icon Button", { asset: "assets/Icon_Button.svg" })] }]), { platform: "web" });
  check("[review M3] an Icon Button exported as an asset is still a control (row + unchecked warning)", iconBtn.components.some((c) => c.name === "Icon Button") && codes(iconBtn, "component-states-unchecked").length === 1);
  const skipped = audit(g4([{ id: "9:10", type: "FRAME", name: "Items", children: [inst("9:11", "icons/line/magnifier-search", { assetSkipped: true })] }]), { platform: "web" });
  check("[re-review L2] an icon whose asset was skipped (--no-assets) is still an icon, not an input", !skipped.components.length && !("validation" in skipped.screenStates));
  const sheet = audit(g4([{ id: "9:6", type: "FRAME", name: "Time Sheet" }], "Time Sheet"), { platform: "web" });
  check("[review L1] a page named '… Sheet' is not a dialog", sheet.screenStates.empty === "not-found");
  const two = audit(g4([{ id: "9:7", type: "FRAME", name: "Items", children: [
    { id: "9:8", type: "INSTANCE", name: "Row", reactions: [{ trigger: "on_click", actions: [{ type: "node", destinationId: "20:1", destination: "Details", navigation: "navigate" }] }] },
    { id: "9:9", type: "INSTANCE", name: "Row", reactions: [{ trigger: "on_click", actions: [{ type: "node", destinationId: "30:1", destination: "Details", navigation: "navigate" }] }] },
  ] }]), { platform: "web" });
  check("[review L3] two different frames that share a name are two destinations, told apart by id", codes(two, "prototype-navigation").length === 2 && codes(two, "prototype-navigation").some((f) => f.destinationId === "30:1" && /\(30:1\)/.test(f.message)));
}

// ================================================================ field tests, group 5 (audit skill + severity model, D1/D11/D12)
console.log("field-test group 5:");
const repoRoot = path.join(import.meta.dirname, "..");
const readRepo = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
{
  // D1/D11 doc-guard: the SKILL's blocker list IS the code's, and no emit site can raise any other code as a blocker.
  const skill = readRepo("claude-plugin/skills/audit-design/SKILL.md");
  const line = /Blocker codes: ([^\n]*)/.exec(skill)?.[1] ?? "";
  const listed = [...line.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
  check("[D1 doc-guard] SKILL.md's 'Blocker codes:' list equals BLOCKER_CODES", JSON.stringify(listed) === JSON.stringify([...BLOCKER_CODES].sort()));
  const emitted = new Set<string>();
  for (const f of ["design-to-code/audit.ts", "design-to-code/cross-check.ts"]) {
    for (const m of readRepo(f).matchAll(/"blocker"(?:\s*:\s*"(?:warning|info)")?,\s*"([a-z]+(?:-[a-z]+)+)"/g)) if (m[1]) emitted.add(m[1]);
  }
  check("[D1 doc-guard] every code emitted as \"blocker\" in audit.ts/cross-check.ts is in BLOCKER_CODES (and the scan found some)",
    emitted.size >= 3 && [...emitted].every((c) => (BLOCKER_CODES as readonly string[]).includes(c)));
  check("[D1 doc-guard] the scan also sees the conditional token-name-collision emit", emitted.has("token-name-collision"));
}
{
  // D1: cross-file warnings carry a confirm question, and the audit asks it with the others.
  const doc = screenExport([{ id: "1:1", type: "FRAME", name: "Items", children: [{ id: "1:2", type: "INSTANCE", name: "Widget", mainComponent: { name: "Widget", key: "k-w-v", setKey: "k-w", setName: "Widget" } }] }], { screen: "Items" });
  const res = audit({ doc, label: "Items" }, { platform: "web", designSystem: { components: { components: [{ name: "Other", type: "COMPONENT_SET", key: "k-o" }] } } });
  const f = res.findings.find((x) => x.code === "catalog-covers-nothing");
  check("[D1] catalog-covers-nothing reaches the audit as a warning, and its confirm question is asked", f?.severity === "warning" && res.questions.some((q) => /^Confirm \(catalog-covers-nothing\): /.test(q)));
  check("[D1] …so the gate has no blocker for it", res.summary.blockers === 0);
}
{
  // DT-21 / F-10: overrides re-render BOTH files; the gate reads the same severity as the .md.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-overrides-"));
  const screenFile = path.join(cwd, "design", "export", "pages", "Main", "Login__1_1.json");
  fs.mkdirSync(path.dirname(screenFile), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures/audit/flawed-login.json"), screenFile);
  const ovFile = path.join(cwd, "design", "audit", "Login__1_1.overrides.json");
  fs.mkdirSync(path.dirname(ovFile), { recursive: true });
  const run = (args: string[] = []) => spawnSync(process.execPath, [cli, path.relative(cwd, screenFile), "--platform", "ios", ...args], { encoding: "utf8", cwd });
  const before = run();
  const beforeGate = auditGateStatus(cwd, screenFile, "Login");
  fs.writeFileSync(ovFile, JSON.stringify({ overrides: [
    { code: "missing-font", nodeId: "1:11", severity: "warning", reason: "the font files are licensed and in the repo", decidedBy: "user", decidedAt: "2026-09-30T00:00:00Z" },
    { code: "export-truncated", severity: "info", reason: "stale decision" },
  ] }));
  const after = run();
  const json = parseAs(fs.readFileSync(path.join(cwd, "design", "audit", "Login__1_1.json"), "utf8"), isAuditReport, "audit report");
  const md = fs.readFileSync(path.join(cwd, "design", "audit", "Login__1_1.md"), "utf8");
  const font = json.findings.find((f) => f.code === "missing-font");
  check("[DT-21] before: missing-font is a blocker the gate sees", before.status === 0 && beforeGate.blockers.includes("missing-font#0"));
  check("[DT-21] an override downgrades it in the .json (summary + finding, with from/reason/decidedBy)",
    after.status === 0 && json.summary.blockers === 0 && font?.severity === "warning" && font.overridden?.from === "blocker" && font.overridden.decidedBy === "user");
  check("[DT-21] …and in the .md, marked with the old severity and the reason", /`missing-font` .*\*\(was blocker: the font files are licensed and in the repo\)\*/.test(md) && /\*\*0 blocker\(s\)\*\*/.test(md));
  check("[F-10] the gate reads the same decision: no blockers left", auditGateStatus(cwd, screenFile, "Login").blockers.length === 0);
  check("[DT-21] an override that matches nothing is reported (JSON, .md, stderr), not dropped",
    json.overridesUnmatched?.length === 1 && json.overridesUnmatched[0]?.code === "export-truncated" && /matched no finding/.test(md) && /override for export-truncated NOT applied: matched no finding/.test(after.stderr));
  fs.writeFileSync(ovFile, JSON.stringify({ overrides: [{ code: "missing-font", severity: "warning", reason: "" }] }));
  const bad = run();
  check("[DT-21] an override with no reason is refused (exit 2, one line) — a silent non-decision would re-open the blocker", bad.status === 2 && /audit overrides: .* is not an audit overrides file/.test(bad.stderr));
  // The gate's name lookup must never take a sidecar (.overrides/.cross) for the report.
  fs.writeFileSync(ovFile, JSON.stringify({ overrides: [] }));
  fs.writeFileSync(path.join(cwd, "design", "audit", "Login__1_1.cross.json"), JSON.stringify({ findings: [{ severity: "blocker", code: "catalog-rekeyed", message: "x" }], summary: {} }));
  check("[gate] name lookup skips <screen>.cross.json / .overrides.json and finds the report itself", locateAuditFile(cwd, null, "Login") === "design/audit/Login__1_1.json");
}
{
  // DT-22 / F-18: a same-page frame whose copy reads like the missing state is named; orphan screenshots are listed.
  const layers = [
    { id: "5:1", name: "Items", page: "Main", pageId: "0:1", file: "pages/Main/Items__5_1.json", title: "Items", texts: ["Items", "Add item"] },
    { id: "5:2", name: "Items", page: "Main", pageId: "0:1", file: "pages/Main/Items__5_2.json", title: "Items", texts: ["Items", "No items added yet.", "Add item"] },
    { id: "6:1", name: "Settings", page: "Other", pageId: "0:2", file: "pages/Other/Settings__6_1.json", texts: ["Something went wrong"] },
    { id: "5:3", name: "Projects", page: "Main", pageId: "0:1", file: "pages/Main/Projects__5_3.json", title: "Projects", texts: ["Projects", "No projects yet."] },
  ];
  const res = audit(g4([{ id: "5:1", type: "FRAME", name: "Items" }]), { platform: "web", neighbours: { layers, unexportedShots: ["7:1", "7:2"] } });
  const sib = res.findings.find((f) => f.code === "state-in-sibling");
  check("[DT-22] a same-page frame reading 'No items added yet.' is named as the likely empty state", sib?.state === "empty" && sib.candidates?.[0]?.id === "5:2" && res.questions.some((q) => /No empty state in this frame — is 'Items' \(5:2: "No items added yet\."\)/.test(q)));
  check("[DT-22] an unrelated frame on the same page ('No projects yet.') is not offered as THIS screen's empty state", !(sib?.candidates || []).some((c) => c.id === "5:3"));
  check("[DT-22] a frame on ANOTHER page is not a candidate (its 'Something went wrong' is someone else's error)", !res.findings.some((f) => f.code === "state-in-sibling" && f.state === "error"));
  check("[DT-22] the state itself stays not-found — a text match is a lead, not proof", res.screenStates.empty === "not-found");
  check("[DT-22] frames screenshotted but never exported are listed", res.findings.some((f) => f.code === "unexported-frames" && JSON.stringify(f.ids) === JSON.stringify(["7:1", "7:2"])));
  // End to end: the CLI reads pages/index.json and assets/ beside the screen.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-neighbours-"));
  const put = (rel: string, body: string | object): void => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); };
  // The index's texts are only the first few strings (on real screens: the sidebar); the empty-state
  // sentence is found in the sibling's own export, deep in its tree.
  put("design/export/pages/index.json", { pageDirs: [{ dir: "Main", index: "pages/Main/index.json" }], layers: layers.map((l) => ({ ...l, texts: ["Dashboard", "Items", "Settings"] })) });
  const nest = (depth: number, leaf: Parameters<typeof node>[0]): Parameters<typeof node>[0] => depth ? { id: `5:n${depth}`, type: "FRAME", name: `Level ${depth}`, children: [nest(depth - 1, leaf)] } : leaf;
  put("design/export/pages/Main/Items__5_2.json", screenExport([{ id: "5:2", type: "FRAME", name: "Items", children: [nest(7, { id: "5:26", type: "TEXT", name: "Main Text", text: "No items added yet." })] }], { screen: "Items" }));
  put("design/export/pages/Main/Items__5_1.json", screenExport([{ id: "5:1", type: "FRAME", name: "Items" }], { screen: "Items" }));
  put("design/export/assets/5_1_ref.png", "png"); put("design/export/assets/7_1_ref.png", "png"); put("design/export/assets/7_2_shot@0.25x.png", "png");
  const out = parseAs(execFileSync(process.execPath, [cli, "design/export/pages/Main/Items__5_1.json", "--platform", "web", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), isAuditReport, "audit --json");
  check("[DT-22 CLI] the sibling sweep and orphan screenshots come from disk (the audited frame's own ref is not an orphan)",
    out.findings.some((f) => f.code === "state-in-sibling" && f.candidates?.[0]?.id === "5:2") && JSON.stringify(out.findings.find((f) => f.code === "unexported-frames")?.ids) === JSON.stringify(["7:1", "7:2"]));
}
{
  // D12 doc-guards: the skill still forks, is disk-only by default, calls Figma only in paragraphs about `live`, and reports its commands.
  const skill = readRepo("claude-plugin/skills/audit-design/SKILL.md");
  check("[D12] audit-design keeps context: fork and takes a `--live` flag", /\ncontext: fork\n/.test(skill) && /argument-hint: .*\[--live\]/.test(skill));
  check("[D12/DT-19] the disk-only rule is stated, keyed on the flag (not a word a screen name can contain)", /\*\*Disk-only unless told otherwise\.\*\*/.test(skill) && /ends with the flag `--live`/.test(skill) && !/contains the word `live`/.test(skill));
  // Any `dtwin <command>` or `figma_*` named in a paragraph — except the one sentence saying what --as-library WRITES.
  const callParas = skill.split(/\n\s*\n/).filter((p) => /`dtwin (?!pull --as-library)[a-z-]+|`figma_[a-z_]+`/.test(p));
  check("[D12/DT-16] every paragraph that names a Figma-reaching call is about `--live` (or is printed output)", callParas.length > 0 && callParas.every((p) => /`--live`|\*\*Live only\*\*|prints/.test(p))); // not "the live run" — the FLAG
  check("[D12/F-21] the hand-back lists every command run", /list \*\*every command you ran\*\*/.test(skill));
  check("[DT-21] the skill says to record severity changes in the overrides file, not the .md", /Never change a severity by editing the `\.md`/.test(skill) && /\.overrides\.json/.test(skill));
}
{
  // F-19: every CLI remediation hint in finding text names its MCP twin, or says it has none.
  const lines = ["design-to-code/cross-check.ts", "design-to-code/drift-lint.ts"].flatMap((f) => readRepo(f).split("\n")).filter((l) => !/^\s*\/\//.test(l));
  const asLib = lines.filter((l) => /dtwin pull --as-library/.test(l));
  const listLib = lines.filter((l) => /dtwin list libraries/.test(l));
  check("[F-19] every `dtwin pull --as-library` hint says it is CLI only", asLib.length >= 2 && asLib.every((l) => /CLI only/.test(l)));
  check("[F-19] every `dtwin list libraries` hint names figma_list_libraries", listLib.length >= 1 && listLib.every((l) => /figma_list_libraries/.test(l)));
}

// ---- review round 1 of group 5
{
  // H1: an override reaches the cross-file section too — .md, crossFile.findings and crossFile.summary agree.
  const vars: TokensDoc = { collections: [{ name: "Spacing", modes: ["Desktop"], default: "Desktop", theming: false, key: "screen-space" }],
    variables: [{ name: "(Space 3)", collection: "Spacing", tier: "primitive", key: "screen-k2", type: "FLOAT", values: { Desktop: 12 } }] };
  const dsTokens: TokensDoc = { collections: [{ name: "Spacing", modes: ["Mode 1"], default: "Mode 1", theming: false, key: "ds-space" }],
    variables: [{ name: "Space 3", collection: "Spacing", tier: "primitive", key: "ds-k2", type: "FLOAT", values: { "Mode 1": 16 } }] };
  const input: AuditInput = { doc: screenExport([{ id: "10:1", type: "FRAME", name: "Items", children: [{ id: "10:2", type: "FRAME", name: "Row", tokens: { itemSpacing: "(Space 3)" } }] }], { screen: "Items" }), label: "Items", vars };
  const base = audit(input, { platform: "web", designSystem: { tokens: dsTokens }, variables: vars });
  check("[review H1] setup: a used name clash is a blocker in both places", base.summary.blockers === 1 && base.crossFile?.summary.blockers === 1);
  const decided = audit(input, { platform: "web", designSystem: { tokens: dsTokens }, variables: vars,
    overrides: [{ code: "token-name-collision", token: "(Space 3)", severity: "warning", reason: "the screen's value is the intended one", decidedBy: "user" }] });
  const md = toMarkdown(decided);
  const crossBlock = md.slice(md.indexOf("## Does this screen come from"), md.indexOf("## Token binding"));
  check("[review H1] after a downgrade, crossFile.findings and crossFile.summary say warning too", decided.summary.blockers === 0 && decided.crossFile?.summary.blockers === 0 && decided.crossFile.findings.find((f) => f.code === "token-name-collision")?.severity === "warning");
  check("[review H1] …and so does the .md's cross-file section, with the decision", !/\*\*blocker\*\*/.test(crossBlock) && /\*\*warning\*\* `token-name-collision`.*\(was blocker: the screen's value is the intended one\)/.test(crossBlock));
}
{
  // M4: override rules.
  const login = readFixture(path.join(import.meta.dirname, "fixtures", "audit", "flawed-login.json"), isScreenExport);
  const run = (overrides: NonNullable<AuditOptions["overrides"]>) => audit({ doc: login, label: "Login" }, { platform: "ios", overrides });
  const broad = run([{ code: "missing-font", severity: "warning", reason: "fonts are licensed", decidedBy: "user" }]);
  check("[review M4a] an entry without nodeId for a node-level code is too broad — not applied", broad.summary.blockers === 1 && /too broad/.test(broad.overridesUnmatched?.[0]?.why ?? ""));
  const raise = run([{ code: "low-contrast", nodeId: "1:4", severity: "blocker", reason: "brand rule", decidedBy: "user" }]);
  check("[review M4b] a non-blocker code cannot be raised to a blocker", raise.summary.blockers === 1 && /can be blockers/.test(raise.overridesUnmatched?.[0]?.why ?? ""));
  const nobody = run([{ code: "missing-font", nodeId: "1:11", severity: "warning", reason: "fonts are licensed" }]);
  check("[review M4e] downgrading a blocker without decidedBy is refused", nobody.summary.blockers === 1 && /needs decidedBy/.test(nobody.overridesUnmatched?.[0]?.why ?? ""));
  const twice = run([{ code: "missing-font", nodeId: "1:11", severity: "warning", reason: "a", decidedBy: "user" }, { code: "missing-font", nodeId: "1:11", severity: "info", reason: "b", decidedBy: "user" }]);
  check("[review M4c] a second entry on an already-decided finding is not reported as stale (first wins)", twice.summary.blockers === 0 && !twice.overridesUnmatched && twice.findings.find((f) => f.code === "missing-font")?.severity === "warning");
  // M4d: a decided cross-file warning's confirm question is not asked again.
  const doc = screenExport([{ id: "1:1", type: "FRAME", name: "Items", children: [{ id: "1:2", type: "INSTANCE", name: "Widget", mainComponent: { name: "Widget", key: "k-w-v", setKey: "k-w", setName: "Widget" } }] }], { screen: "Items" });
  const ds = { components: { components: [{ name: "Other", type: "COMPONENT_SET" as const, key: "k-o" }] } };
  const asked = audit({ doc, label: "Items" }, { platform: "web", designSystem: ds });
  const answered = audit({ doc, label: "Items" }, { platform: "web", designSystem: ds, overrides: [{ code: "catalog-covers-nothing", severity: "info", reason: "confirmed: every instance is new work", decidedBy: "user" }] });
  check("[review M4d] once decided, the confirm question is not asked again", asked.questions.some((q) => /^Confirm \(catalog-covers-nothing\)/.test(q)) && !answered.questions.some((q) => /^Confirm \(catalog-covers-nothing\)/.test(q)));
}
{
  // M3: frames sharing a generic name ("Popup" ×3) are not related through the name; titles decide.
  const layers = [
    { id: "11:1", name: "Popup", page: "Main", pageId: "0:1", file: "pages/Main/Popup__11_1.json", title: "Add Item", texts: ["Add Item"] },
    { id: "11:2", name: "Popup", page: "Main", pageId: "0:1", file: "pages/Main/Popup__11_2.json", title: "Export Report", texts: ["Export Report", "Loading…", "Something went wrong"] },
    { id: "11:3", name: "Popup", page: "Main", pageId: "0:1", file: "pages/Main/Popup__11_3.json", title: "Add Item", texts: ["Add Item", "Something went wrong"] },
  ];
  const res = audit(g4([{ id: "11:1", type: "FRAME", name: "Popup" }], "Popup"), { platform: "web", neighbours: { layers, unexportedShots: [] } });
  const err = res.findings.find((f) => f.code === "state-in-sibling" && f.state === "error");
  check("[review M3] a same-named frame with a DIFFERENT title is not offered; one with the same title is", !!err && JSON.stringify(err.candidates?.map((c) => c.id)) === JSON.stringify(["11:3"]) && !res.findings.some((f) => f.code === "state-in-sibling" && f.state === "loading"));
}
{
  // M7: a sidecar report (<screen>.library.json) is not "an existing report for this node" — the documented re-run works.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "audit-sidecar-"));
  const screenFile = path.join(cwd, "design", "export", "pages", "Main", "Login__1_1.json");
  fs.mkdirSync(path.dirname(screenFile), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures/audit/flawed-login.json"), screenFile);
  const run = (args: string[]) => spawnSync(process.execPath, [cli, path.relative(cwd, screenFile), "--platform", "ios", ...args], { encoding: "utf8", cwd });
  const first = run([]);
  const lib = run(["--out", "design/audit/Login__1_1.library"]);
  check("[review M7] `--out design/audit/<screen>.library` beside the main report is not refused as a duplicate", first.status === 0 && lib.status === 0 && fs.existsSync(path.join(cwd, "design", "audit", "Login__1_1.library.json")));
}

// ---- review round 2 of group 5
{
  // M1: codes that repeat per collection / mode / state are narrowed by that key; a bare entry is too broad.
  const layers = [
    { id: "12:1", name: "Items", page: "Main", pageId: "0:1", file: "pages/Main/Items__12_1.json", title: "Items", texts: ["Items"] },
    { id: "12:2", name: "Items", page: "Main", pageId: "0:1", file: "pages/Main/Items__12_2.json", title: "Items", texts: ["No items added yet.", "Something went wrong"] },
  ];
  const run = (overrides: NonNullable<AuditOptions["overrides"]>) => audit(g4([{ id: "12:1", type: "FRAME", name: "Items" }]), { platform: "web", neighbours: { layers, unexportedShots: [] }, overrides });
  const bare = run([{ code: "state-in-sibling", severity: "warning", reason: "track it" }]);
  check("[re-review M1] a bare entry on a code found twice (empty + error) is too broad", /too broad — name the finding \(.*state/.test(bare.overridesUnmatched?.[0]?.why ?? "") && bare.findings.every((f) => f.code !== "state-in-sibling" || f.severity === "info"));
  const one = run([{ code: "state-in-sibling", state: "empty", severity: "warning", reason: "track it" }]);
  check("[re-review M1] naming `state` decides exactly that finding", one.findings.filter((f) => f.code === "state-in-sibling" && f.severity === "warning").map((f) => f.state).join() === "empty" && !one.overridesUnmatched);
}
{
  // M2 (test gaps): each M3 guard on its own.
  const mk = (rows: Array<{ id: string; name: string; title?: string; texts: string[] }>) => rows.map((r) => ({ ...r, page: "Main", pageId: "0:1", file: `pages/Main/x__${r.id.replace(":", "_")}.json` }));
  const cand = (layers: ReturnType<typeof mk>) => audit(g4([{ id: "13:1", type: "FRAME", name: "Popup" }], "Popup"), { platform: "web", neighbours: { layers, unexportedShots: [] } }).findings.find((f) => f.code === "state-in-sibling")?.candidates?.map((c) => c.id) ?? [];
  check("[re-review M2] a name used 3 times on the page, no titles anywhere → not related by name",
    cand(mk([{ id: "13:1", name: "Popup", texts: [] }, { id: "13:2", name: "Popup", texts: ["Something went wrong"] }, { id: "13:3", name: "Popup", texts: [] }])).length === 0);
  check("[re-review M2] a name used twice but the titles disagree → not related",
    cand(mk([{ id: "13:1", name: "Popup", title: "Add Item", texts: [] }, { id: "13:2", name: "Popup", title: "Export Report", texts: ["Something went wrong"] }])).length === 0);
  check("[re-review M2] a name used twice, no titles → related",
    JSON.stringify(cand(mk([{ id: "13:1", name: "Popup", texts: [] }, { id: "13:2", name: "Popup", texts: ["Something went wrong"] }]))) === JSON.stringify(["13:2"]));
}
{
  // M2 (test gaps): hashed reference names count as screenshots; a sidecar of ANOTHER report never blocks a write;
  // LOW: a sidecar run reads its report's overrides file.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-hash-"));
  const put = (rel: string, body: string | object): string => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); return f; };
  put("design/export/pages/index.json", { pageDirs: [{ dir: "Main", index: "pages/Main/index.json" }], layers: [{ id: "1:1", name: "Login", page: "Main", pageId: "0:1", file: "pages/Main/Login__1_1.json" }] });
  const screenRel = "design/export/pages/Main/Login__1_1.json";
  fs.mkdirSync(path.join(root, path.dirname(screenRel)), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "fixtures/audit/flawed-login.json"), path.join(root, screenRel));
  put("design/export/assets/7_3_ref-a1b2c3.png", "png"); put("design/export/assets/7_4_ref-Zq9x_1.png", "png");
  const nodeId = audit({ doc: readFixture(path.join(import.meta.dirname, "fixtures", "audit", "flawed-login.json"), isScreenExport), label: "Login" }, { platform: "ios" }).nodeIds?.[0] ?? "";
  put("design/audit/Other__9_9.library.json", { nodeIds: [nodeId], findings: [], summary: {} });
  const r = spawnSync(process.execPath, [cli, screenRel, "--platform", "ios"], { encoding: "utf8", cwd: root });
  const repFile = path.join(root, "design/audit/Login__1_1.json");
  const rep = fs.existsSync(repFile) ? parseAs(fs.readFileSync(repFile, "utf8"), isAuditReport, "report") : { findings: [] as AuditFinding[] };
  check("[re-review M2] another report's sidecar that covers the node does not refuse the write", r.status === 0);
  check("[re-review M2] hashed reference names (_ref-<hash>.png, _ref-<hash>_N.png) are screenshots too", JSON.stringify(rep.findings.find((f) => f.code === "unexported-frames")?.ids) === JSON.stringify(["7:3", "7:4"]));
  put("design/audit/Login__1_1.overrides.json", { overrides: [{ code: "missing-font", nodeId: "1:11", severity: "warning", reason: "licensed", decidedBy: "user" }] });
  const lib = spawnSync(process.execPath, [cli, screenRel, "--platform", "ios", "--out", "design/audit/Login__1_1.library"], { encoding: "utf8", cwd: root });
  const libRep = parseAs(fs.readFileSync(path.join(root, "design/audit/Login__1_1.library.json"), "utf8"), isAuditReport, "library report");
  check("[re-review LOW] a `<report>.library` run applies the report's own overrides file", lib.status === 0 && libRep.summary.blockers === 0 && /overrides: design\/audit\/Login__1_1\.overrides\.json/.test(lib.stderr));
}

report();
