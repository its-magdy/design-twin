// Offline tests for design-to-code/audit.js — the pre-implementation design audit.
//   node test/audit.test.js
// The fixture is a deliberately flawed login screen: every seeded flaw has one assertion that the
// audit reports it, and the clean parts have assertions that it does NOT (no false positives).
const path = require("path");
const { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind } = require("../design-to-code/audit");
const { check, report } = require("./assert");

const screen = require("./fixtures/audit/flawed-login.json");
const catalog = require("./fixtures/audit/components.local.json");
const codes = (res, code) => res.findings.filter((f) => f.code === code);
const onNode = (res, code, id) => codes(res, code).some((f) => f.nodeId === id);

console.log("color math:");
check("parseHex reads 6- and 8-digit hex", parseHex("#ff0000").r === 255 && Math.abs(parseHex("#0000001a").a - 26 / 255) < 1e-9);
check("parseHex rejects junk", parseHex("red") === null && parseHex(undefined) === null);
check("contrast black/white = 21:1", Math.abs(contrastRatio(parseHex("#000000"), parseHex("#ffffff")) - 21) < 0.01);
check("contrast #767676 on white ≈ 4.54 (the AA boundary)", Math.abs(contrastRatio(parseHex("#767676"), parseHex("#ffffff")) - 4.54) < 0.02);
check("ΔE of near-identical colors < 3, distinct colors > 3", deltaE(parseHex("#4f46e5"), parseHex("#4f46e6")) < 3 && deltaE(parseHex("#4f46e5"), parseHex("#e54f46")) > 3);
check("controlKind classifies common names", controlKind("Text Field") === "input" && controlKind("Primary Button") === "button" && controlKind("Toggle") === "toggle" && controlKind("Tabs") === "tab" && controlKind("Avatar") === null);

console.log("audit — ios:");
const ios = audit({ doc: screen, label: "Login" }, { platform: "ios", catalog });
check("reports the screen label", ios.screens[0] === "Login");
check("fake status bar flagged", onNode(ios, "fake-status-bar", "1:2"));
check("fake home indicator flagged", onNode(ios, "fake-home-indicator", "1:15"));
check("32×32 close button flagged below 44pt", onNode(ios, "small-touch-target", "1:8") && codes(ios, "small-touch-target").find((f) => f.nodeId === "1:8").min === 44);
check("icon INSIDE the tappable close button not double-reported", !onNode(ios, "small-touch-target", "1:9"));
check("48pt button/input not flagged", !onNode(ios, "small-touch-target", "1:7") && !onNode(ios, "small-touch-target", "1:6"));
check("fixed-size Subtitle text flagged", onNode(ios, "fixed-size-text", "1:4"));
check("auto-height Title text NOT flagged", !onNode(ios, "fixed-size-text", "1:3"));
check("#bbbbbb on white is low contrast", onNode(ios, "low-contrast", "1:4") && codes(ios, "low-contrast").find((f) => f.nodeId === "1:4").required === 4.5);
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
check("on-grid root spacing (16/24/34?) — 34 IS off-grid, reported", onNode(ios, "off-grid-spacing", "1:1") && /paddingBottom=34/.test(codes(ios, "off-grid-spacing").find((f) => f.nodeId === "1:1").message));
check("near-duplicate raw colors #4f46e6 not paired with bound #4f46e5 (only unbound are clustered)", codes(ios, "near-duplicate-colors").every((f) => !f.colors.includes("#4f46e5")));
check("annotations collected verbatim", ios.annotations.some((a) => a.label === "Email must be validated on blur" && a.nodeId === "1:1"));

console.log("audit — component states:");
const btn = ios.components.find((c) => c.name === "Button");
const field = ios.components.find((c) => c.name === "Text Field");
check("Button on iOS is missing pressed + disabled (hover doesn't count on touch)", btn && btn.missing.join(",") === "pressed,disabled");
check("Button 'hover' variant VALUE detected despite property named 'Property 1'", btn.present.includes("hover"));
check("Text Field has focus/error/disabled → nothing missing", field && field.missing.length === 0);
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
check("android: 32dp close flagged below 48dp", codes(android, "small-touch-target").find((f) => f.nodeId === "1:8").min === 48);
check("web: no fake-status-bar check (no system chrome on web)", codes(web, "fake-status-bar").length === 0);
check("web: Button needs hover+pressed+focus+disabled → missing pressed/focus/disabled", web.components.find((c) => c.name === "Button").missing.join(",") === "pressed,focus,disabled");
check("android: corner smoothing flagged (no native squircle)", onNode(android, "corner-smoothing", "1:7"));
check("unknown platform falls back to web", audit(screen, { platform: "watchos" }).platform === "web");

console.log("audit — input shapes + manifest gates:");
const bare = audit(screen.nodes[0], { platform: "ios" });
check("bare layer tree accepted", bare.screens[0] === "Login" && onNode(bare, "fake-status-bar", "1:2"));
check("{tree} wrapper accepted", audit({ tree: screen.nodes[0] }, { platform: "ios" }).findings.length === bare.findings.length);
check("no catalog → component states unknown, not invented", bare.components.find((c) => c.name === "Button").known === false);
const truncated = audit(Object.assign({}, screen, { manifest: { truncated: 2, assetsFailed: 1 } }), { platform: "ios" });
check("truncated export is a blocker", codes(truncated, "export-truncated")[0].severity === "blocker");
check("failed assets are a blocker", codes(truncated, "assets-failed")[0].severity === "blocker");
check("blockers sort first", truncated.findings[0].severity === "blocker");
const drawnStates = JSON.parse(JSON.stringify(screen));
drawnStates.nodes[0].children.push({ type: "FRAME", name: "Skeleton", id: "3:1", hidden: true }, { type: "FRAME", name: "Error toast", id: "3:2", hidden: true });
const ds = audit(drawnStates, { platform: "ios" });
check("hidden 'Skeleton' / 'Error toast' count as designed states", ds.screenStates.loading === "designed" && ds.screenStates.error === "designed" && ds.screenStates.empty === "not-found");
check("garbage input doesn't throw", audit(null).findings.length === 0 && audit([{}, 42]).screens.length === 0);

console.log("audit — regressions:");
const styled = audit({ nodes: [{ type: "FRAME", name: "S", id: "9:1", children: [
  { type: "INSTANCE", name: "Delete", id: "9:2", component: "Button", mainComponent: { key: "K", setKey: "KS", setName: "Button" }, box: { w: 120, h: 44 } },
  { type: "TEXT", name: "T", id: "9:3", text: "x", autoResize: "height", font: { size: 14, color: "#111111" }, fills: [{ type: "solid", color: "#111111" }] },
] }] }, { platform: "ios", catalog: { components: [{ name: "Button", type: "COMPONENT_SET", key: "KS", props: { Variant: { type: "VARIANT", options: ["Primary", "Danger", "Destructive"] } } }] } });
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
const { execFileSync } = require("child_process");
const cli = path.join(__dirname, "..", "design-to-code", "audit.js");
const out = execFileSync(process.execPath, [cli, path.join(__dirname, "fixtures/audit/flawed-login.json"), "--platform", "android", "--catalog", path.join(__dirname, "fixtures/audit/components.local.json"), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const parsed = JSON.parse(out);
check("CLI --json emits the audit for the chosen platform", parsed.platform === "android" && parsed.summary.blockers === 1);
let badExit = 0;
try { execFileSync(process.execPath, [cli, "x.json", "--platform", "tvos"], { stdio: "ignore" }); } catch (e) { badExit = e.status; }
check("CLI rejects an unknown --platform with exit 2", badExit === 2);

report();
