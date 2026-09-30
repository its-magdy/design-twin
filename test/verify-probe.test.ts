// Offline tests for the shipped web probe's output contract and what --compare does with it (group 7).
// No browser here: the compare/contract half builds real expectations through buildExpectation / --expect
// and feeds them measured.json shapes the probe writes (every STYLE_KEY present, null + unmeasured[key]).
// Run with:  node test/verify-probe.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as VS from "../design-to-code/verify-screen.ts";
import type { BuiltExpectation, ExpectInput } from "../design-to-code/verify-screen.ts";
import type { FontSpec, MeasuredNode, MeasuredStyles, ProbeIdentity, ScreenExport, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { malformed, screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";
import { buildPool, census, chooseMatch, claimOnce, isMatch, resolveFrame, shapeNode } from "../design-to-code/probe-match.ts";
import type { Match, MatchPool, NoMatch, ResolvedFrame } from "../design-to-code/probe-match.ts";
import type { Candidate, CollectOutput, ElemFlags, MeasureResult, SizedCandidate } from "../design-to-code/probe-page.ts";
import { errorKind, installHint, resolvePlaywright } from "../design-to-code/verify-probe.ts";
import type { VerifySpec } from "../design-to-code/types.ts";
import { must } from "./fixtures.ts";

// A check whose body may throw (a missing export on an older tree): a throw is a clean ✗, never a crash.
const t = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch { r = false; } return check(name, r); };
// A group of checks that shares setup: setup that throws on an older tree is one clean ✗, not a crash.
// (Nodes whose spec has padding send a real padding in the groups below, so those run on a tree where
// padding: null still crashed compare — each change's checks then fail on their own.)
const block = (name: string, fn: () => void): void => { try { fn(); } catch (e) { check(`${name} — setup threw: ${e instanceof Error ? e.message : String(e)}`, false); } };

// ---- compare/contract (group 7)
const { buildExpectation, compare, FIELDS } = VS;
// Read through the namespace so this file still RUNS against a tree without them (the "fails before" check).
const vsNs: Record<string, unknown> = { ...VS };
const STYLE_KEYS: readonly string[] = Array.isArray(vsNs.STYLE_KEYS) ? vsNs.STYLE_KEYS.filter((k): k is string => typeof k === "string") : [];
type ProbeLineFn = (r: Pick<VerifyReport, "inputs" | "coverage">) => string;
const isProbeLineFn = (f: unknown): f is ProbeLineFn => typeof f === "function";
const probeLineFn = vsNs.probeLine;
const probeLine: ProbeLineFn = (r) => (isProbeLineFn(probeLineFn) ? probeLineFn(r) : "");

const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
const text = (id: string, name: string, chars: string, font: FontSpec, extra?: Partial<NodeInput>): NodeInput => ({ type: "TEXT", id, name, text: chars, font, ...extra });
const FONT: FontSpec = { family: "Inter", size: 14, weight: "Regular", lineHeight: { value: 20, unit: "px" }, color: "#1d1d1f" };
// The Orders screen: a frame > toolbar (auto-layout, gap 12, padding) > a button > its label; a card with a radius; a list of 3 rows.
const screen = (rows = 3): ScreenExport => screenExport([{
  type: "FRAME", id: "1:1", name: "Orders", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }],
  children: [
    { type: "FRAME", id: "1:2", name: "Toolbar", layout: { flexDirection: "row", gap: 12, padding: [8, 16, 8, 16] }, fills: [{ type: "solid", color: "#f4f4f5" }], box: { w: 1280, h: 48 },
      children: [
        { type: "INSTANCE", id: "1:3", name: "New order", mainComponent: { name: "Button", setName: "Button", key: "k1" }, fills: [{ type: "solid", color: "#0a84ff" }], radius: 8, box: { w: 120, h: 32 },
          children: [text("1:4", "Label", "New order", FONT)] },
        { type: "FRAME", id: "1:5", name: "Spacer", fills: [{ type: "solid", color: "#eeeeee" }], box: { w: 40, h: 32 } },
      ] },
    { type: "FRAME", id: "1:6", name: "List", layout: { flexDirection: "column", gap: 4 },
      children: Array.from({ length: rows }, (_, i) => text(`2:${i + 1}`, `Row ${i + 1}`, `Order ${i + 1}`, FONT)) },
  ],
}], { exportedAt: "2026-09-30T00:00:00Z", screen: "Orders" });
const exp = (rows = 3): BuiltExpectation => { const d: ExpectInput = { doc: screen(rows), label: "Orders" }; return buildExpectation([d]); };

// Every STYLE_KEY present, as the shipped probe writes it; `over` replaces some; the rest are null with a reason.
const allNull = (why: string): { styles: MeasuredStyles; unmeasured: Record<string, string> } => {
  const styles: MeasuredStyles = {}, unmeasured: Record<string, string> = {};
  // (the literal list only on a tree without STYLE_KEYS, so the null checks below still bite there)
  for (const k of STYLE_KEYS.length ? STYLE_KEYS : [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText"]) { styles[k] = null; unmeasured[k] = why; }
  return { styles, unmeasured };
};
const probeNode = (nodeId: string, over: MeasuredStyles, extra?: Partial<MeasuredNode>): MeasuredNode => {
  const base = allNull("not applicable to this element");
  const styles: MeasuredStyles = { ...base.styles, ...over };
  const unmeasured: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) if (v === null) unmeasured[k] = base.unmeasured[k] ?? "not applicable";
  return { nodeId, matchedBy: "tag", selector: `[data-dt-node="${nodeId}"]`, selectorCount: 1, styles, unmeasured, ...extra };
};
const IDENT: ProbeIdentity = { name: "verify-probe", version: "0.9.0", sha256: "a".repeat(64), playwright: { package: "playwright", version: "1.63.0" }, browser: { name: "chromium", version: "140.0.7339.16" } };
const measured = (nodes: MeasuredNode[], extra?: Partial<VerifyMeasured>): VerifyMeasured => ({ measuredAt: "2026-09-30T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes, ...extra });

console.log("verify-probe — compare/contract (group 7):");

// ---- DT-23: the probe's key list is generated from what compare reads
block("DT-23", () => {
  const e = exp();
  const stylesLine = (e.measuredKeys || {})["nodes[].styles"] || "";
  t("[DT-23] STYLE_KEYS carries every FIELDS key plus padding/gapVisual/text/tag/textBox/placeholderText", () =>
    STYLE_KEYS.length > 0 && FIELDS.every((f) => STYLE_KEYS.includes(f.key)) && ["padding", "gapVisual", "text", "tag", "textBox", "placeholderText"].every((k) => STYLE_KEYS.includes(k)));
  t("[DT-23] the expectation's measuredKeys styles line names every FIELDS key — `fill` included", () =>
    FIELDS.every((f) => new RegExp(`(^|[\\s:])${f.key}(\\s|$)`).test(stylesLine)) && /(^|\s)fill(\s|$)/.test(stylesLine));
  t("[DT-23] measuredKeys tells the probe how to say it could not read a value (unmeasured)", () => typeof (e.measuredKeys || {})["nodes[].unmeasured"] === "string");
});

// ---- --expect: ancestorIds per spec (nearest first, frame root excluded)
block("--expect", () => {
  const e = exp();
  const label = e.nodes.find((n) => n.nodeId === "1:4");
  const toolbar = e.nodes.find((n) => n.nodeId === "1:2");
  const frame = e.nodes.find((n) => n.nodeId === "1:1");
  t("[ancestorIds] a label inside a button inside the toolbar lists [button, toolbar] — nearest first, no frame", () => JSON.stringify(label?.ancestorIds) === JSON.stringify(["1:3", "1:2"]));
  t("[ancestorIds] a direct child of the frame, and the frame itself, get []", () => JSON.stringify(toolbar?.ancestorIds) === "[]" && JSON.stringify(frame?.ancestorIds) === "[]");
  t("[ancestorIds] compare ignores them (not an unknown key, not a field)", () => {
    const r = compare(e, measured([probeNode("1:4", { fontFamily: "Inter", fontSize: 14, fontWeight: 400, lineHeight: 20, letterSpacing: 0, color: "rgb(29, 29, 31)", text: "New order", tag: "span", width: 60, x: 40 })]));
    return !r.deltas.some((d) => /ancestor/i.test(d.field)) && r.probe.unknownKeys.length === 0;
  });
});

// ---- DT-43: a null is not measured, never checked, never a pass
block("DT-43", () => {
  const e = exp();
  const label = probeNode("1:4", { fontFamily: "Inter", fontSize: null, fontWeight: 400, lineHeight: 20, color: "rgb(29, 29, 31)", text: "New order", tag: "span" },
    { unmeasured: { fontSize: "font-size resolved to a calc() the probe cannot read" } });
  const r = compare(e, measured([label]));
  const gapRow = r.fieldsNotMeasured.find((f) => f.nodeId === "1:4" && f.field === "font-size");
  t("[DT-43] fontSize: null with unmeasured.fontSize → a fieldsNotMeasured gap carrying that reason", () => gapRow?.why === "font-size resolved to a calc() the probe cannot read");
  t("[DT-43] ... and it is not counted in fieldsChecked (only the non-null typography of this node is)", () => {
    const withValue = compare(e, measured([probeNode("1:4", { fontFamily: "Inter", fontSize: 14, fontWeight: 400, lineHeight: 20, color: "rgb(29, 29, 31)", text: "New order", tag: "span" })]));
    return withValue.coverage.fieldsChecked === r.coverage.fieldsChecked + 1;
  });
  t("[DT-43] a null with no reason says 'reported null'", () => {
    const n = probeNode("1:4", { color: null }); delete n.unmeasured;
    return compare(e, measured([n])).fieldsNotMeasured.some((f) => f.nodeId === "1:4" && f.field === "color" && f.why === "reported null");
  });
  t("[DT-43] a null key still counts as sent: no NEVER MEASURED for it", () => !r.coverage.fieldsNeverMeasured.some((f) => f.field === "fontSize"));

  // A probe that nulls EVERYTHING on every spec must not pass.
  // (padding: null crashed compare before group 7 — caught so that shows as ✗, not a crash)
  const nothing = (() => { try { return compare(e, measured(e.nodes.map((s) => ({ nodeId: s.nodeId, matchedBy: "tag", ...allNull("the probe could not read computed styles") })))); } catch { return null; } })();
  t("[DT-43] a probe that reports every value null: 0 values compared, verdict not pass", () => !!nothing && nothing.coverage.fieldsChecked === 0 && nothing.verdict !== "pass" && nothing.coverage.fieldsNotMeasured > 0);
  t("[DT-43] ... and the why line says how many were reported null", () => !!nothing && nothing.why.some((w) => /reported null/.test(w)));

  // padding: null used to crash compare (got.padding.every); padding [8, null, 8, 16] used to compare null as 0.
  t("[DT-43] padding: null is a gap with its reason, not a crash", () => {
    const rr = compare(e, measured([probeNode("1:2", { backgroundColor: "rgb(244, 244, 245)", padding: null, gap: 12, width: 1280, height: 48, tag: "div" }, { unmeasured: { padding: "padding is on a pseudo-element" } })]));
    return rr.fieldsNotMeasured.some((f) => f.nodeId === "1:2" && f.field === "padding" && f.why === "padding is on a pseudo-element");
  });
  t("[DT-43] a padding array holding a null is not measured (not compared as 0)", () => {
    const rr = compare(e, measured([probeNode("1:2", { backgroundColor: "rgb(244, 244, 245)", padding: [8, null, 8, 16], gap: 12, width: 1280, height: 48, tag: "div" })]));
    return rr.fieldsNotMeasured.some((f) => f.nodeId === "1:2" && f.field === "padding") && !rr.deltas.some((d) => d.nodeId === "1:2" && d.field === "padding");
  });
  // borderRadius null used to read "could not read 'null' as a radius" — now the probe's reason.
  t("[DT-43] borderRadius: null carries the probe's reason", () => {
    const rr = compare(e, measured([probeNode("1:3", { backgroundColor: "rgb(10, 132, 255)", borderRadius: null, width: 120, height: 32, tag: "button" }, { unmeasured: { borderRadius: "clip-path, not border-radius" } })]));
    return rr.fieldsNotMeasured.some((f) => f.nodeId === "1:3" && f.field === "border-radius" && f.why === "clip-path, not border-radius");
  });
  // gapVisual is sent on every node (null when not a table): a null gapVisual must not hide a measured gap.
  t("[DT-43] gapVisual: null does not mask a wrong gap (24 vs 12 is a delta)", () => {
    const rr = compare(e, measured([probeNode("1:2", { backgroundColor: "rgb(244, 244, 245)", padding: [8, 16, 8, 16], gap: 24, gapVisual: null, width: 1280, height: 48, tag: "div" })]));
    return rr.deltas.some((d) => d.nodeId === "1:2" && d.field === "gap" && d.actual === 24);
  });
  t("[DT-43] placeholderText: null is a gap, not a high 'text changed to null' delta", () => {
    const pe = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "5:1", name: "Search", box: { x: 0, y: 0, w: 400, h: 60 },
      children: [text("5:2", "Placeholder", "Search orders", { ...FONT, color: "#a0a0a0" })] }], { screen: "Search" }), label: "Search" }]);
    const rr = compare(pe, measured([probeNode("5:2", { placeholderText: null, placeholderColor: "rgb(160, 160, 160)", tag: "input" })]));
    return !rr.deltas.some((d) => d.field === "placeholder text") && rr.fieldsNotMeasured.some((f) => f.field === "placeholder text");
  });
});

// ---- measured.notMeasured[].why replaces the generic reason
block("measured.notMeasured[].why replaces the generic reason", () => {
  const e = exp();
  const r = compare(e, measured([], { notMeasured: [{ nodeId: "2:2", why: "text 'Order 2' matched 3 visible elements; tag it with data-dt-node" }, { nodeId: "2:3", reason: "hand-written: not tagged" }, "2:1"] }));
  t("[notMeasured] the probe's why is the report's why", () => r.notMeasured.find((n) => n.nodeId === "2:2")?.why === "text 'Order 2' matched 3 visible elements; tag it with data-dt-node");
  t("[notMeasured] a hand-written {nodeId, reason} row is used too; a bare id keeps the generic reason", () =>
    r.notMeasured.find((n) => n.nodeId === "2:3")?.why === "hand-written: not tagged" && r.notMeasured.find((n) => n.nodeId === "2:1")?.why === "no measurement for this node id");
});

// ---- identity + census
block("identity + census", () => {
  const e = exp();
  const handFile = path.join(import.meta.dirname, "fixtures", "livetest3", "verify", "JobRoles.measured.json");
  const hand = readJsonOrNull(handFile, isVerifyMeasured);
  const rh = hand ? compare(e, hand) : null;
  t("[identity] a hand-written measured.json (livetest3 fixture) → inputs.probe 'unknown'", () => rh !== null && rh.inputs?.probe === "unknown");
  t("[identity] ... and the probe line says it is not comparable round to round", () => rh !== null && /^probe unknown \(hand-written — not comparable round to round\) · matched: tag 0 · text 0 · ordinal 0 · position 0/.test(probeLine(rh)));
  const nodes: MeasuredNode[] = [
    probeNode("1:1", { backgroundColor: "#ffffff", width: 1280, height: 800, tag: "div" }, { matchedBy: "frame" }),
    probeNode("1:2", { backgroundColor: "#f4f4f5", padding: [8, 16, 8, 16], tag: "div" }, { matchedBy: "tag" }),
    probeNode("1:3", { backgroundColor: "#0a84ff", tag: "button" }, { matchedBy: "tag-shared-path" }),
    probeNode("1:4", { text: "New order", tag: "span" }, { matchedBy: "text" }),
    probeNode("2:1", { text: "Order 1", tag: "li" }, { matchedBy: "text-ordinal" }),
    probeNode("2:2", { text: "Order 2", tag: "li" }, { matchedBy: "position" }),
    probeNode("2:3", { text: "Order 3", tag: "li" }, { matchedBy: "lift-common-ancestor" }),
    probeNode("1:5", { backgroundColor: "#eeeeee", tag: "div" }, {}),
  ];
  const noMatch = nodes[7]; if (noMatch) delete noMatch.matchedBy;
  const r = compare(e, measured(nodes, { probe: IDENT }));
  const c = r.coverage.matchedBy || {};
  t("[census] one bucket per rule: tag, tagSharedPath, text, textOrdinal, position, frame, other, unstated", () =>
    c.tag === 1 && c.tagSharedPath === 1 && c.text === 1 && c.textOrdinal === 1 && c.position === 1 && c.frame === 1 && c.other === 1 && c.unstated === 1);
  t("[census] the buckets add up to nodesMeasured", () => Object.values(c).reduce((a, b) => a + b, 0) === r.coverage.nodesMeasured);
  t("[identity] inputs.probe is the probe's identity", () => JSON.stringify(r.inputs?.probe) === JSON.stringify(IDENT));
  t("[identity] probe line: name, version, sha, playwright, browser, matched counts", () =>
    probeLine(r) === "probe verify-probe 0.9.0 (sha aaaaaaaaaaaa…) · playwright 1.63.0 · chromium 140.0.7339.16 · matched: tag 1 · text 1 · ordinal 1 · position 1 · shared path 1 · frame 1 · other 1 · unstated 1");
  t("[census] the .md has a 'How nodes were matched' table", () => /## How nodes were matched[\s\S]*\| ordinal \| 1 \|/.test(VS.reportToMarkdown(r)));
  t("[census] a legacy 'data-dt-node' matchedBy counts as a tag match", () => compare(e, measured([probeNode("1:2", { padding: [8, 16, 8, 16] }, { matchedBy: "data-dt-node" })])).coverage.matchedBy?.tag === 1);
});

// ---- F-71 / position notes (severity unchanged)
block("F-71 / position notes (severity unchanged)", () => {
  const e = exp();
  const onButton = compare(e, measured([probeNode("1:4", { fontWeight: 500, text: "New order", tag: "button" })]));
  const d = onButton.deltas.find((x) => x.nodeId === "1:4" && x.field === "font-weight");
  t("[F-71] a TEXT weight read off a <button> without textFrom: note names the container, severity still high", () => !!d && d.severity === "high" && /typography read from a <button>, not the text run/.test(d.note || ""));
  const onSpan = compare(e, measured([probeNode("1:4", { fontWeight: 500, text: "New order", tag: "button" }, { textFrom: "span" })]));
  t("[F-71] ... no note when the probe says it read the text run (textFrom)", () => onSpan.deltas.some((x) => x.field === "font-weight" && !/typography read from/.test(x.note || "")));
  const byPos = compare(e, measured([probeNode("1:2", { backgroundColor: "#000000", padding: [8, 16, 8, 16], tag: "div" }, { matchedBy: "position" })]));
  const pd = byPos.deltas.find((x) => x.nodeId === "1:2" && x.field === "background");
  t("[position] a position-matched delta is marked low confidence, severity unchanged", () => !!pd && pd.severity === "high" && /low confidence/.test(pd.note || ""));
});

// ---- measured ids the expectation does not know
block("measured ids the expectation does not know", () => {
  const e = exp();
  const r = compare(e, measured([probeNode("1:2", { padding: [8, 16, 8, 16] }), probeNode("9:1", {}), probeNode("9:2", {}), probeNode("1:1", {})]));
  t("[not-in-expectation] 2 measured ids outside the expectation are counted and sampled (the frame id is not one)", () =>
    r.probe.measuredIdsNotInExpectation === 2 && JSON.stringify(r.probe.measuredIdsNotInExpectationSample) === JSON.stringify(["9:1", "9:2"]));
  t("[not-in-expectation] the .md lists them", () => /2 measured node id\(s\) are not in the expectation/.test(VS.reportToMarkdown(r)));
});

// ---- components from the --interactions object; D18 coverage baseline — through the CLI
block("components from the --interactions object; D18 coverage baseline — through the CLI", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-probe-contract-"));
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  const put = (name: string, doc: unknown): string => { fs.writeFileSync(path.join(cwd, name), JSON.stringify(doc)); return name; };
  put("orders.json", screen(185));
  const ex = run("--expect", "orders.json", "--out", "design/verify/Orders");
  const expFile = "design/verify/Orders.expected.json";
  const e = readJsonOrNull(path.join(cwd, expFile), (x: unknown): x is BuiltExpectation => typeof x === "object" && x !== null);
  t("[cli] --expect wrote a 185-row list expectation", () => ex.status === 0 && !!e && e.nodes.filter((n) => /^2:/.test(n.nodeId)).length === 185);
  const rows = (k: number, sha: string): VerifyMeasured => measured(Array.from({ length: k }, (_, i) => probeNode(`2:${i + 1}`, { text: `Order ${i + 1}`, tag: "li" }, { matchedBy: "text" })), { probe: { ...IDENT, sha256: sha } });
  put("m185.json", rows(185, "a".repeat(64)));
  put("m42.json", rows(42, "b".repeat(64)));
  const first = run("--compare", expFile, "m185.json", "--out", "design/verify/Orders");
  const second = run("--compare", expFile, "m42.json", "--out", "design/verify/Orders");
  const rep2 = readJsonOrNull(path.join(cwd, "design/verify/Orders.report.json"), isVerifyReport);
  t("[D18] first round: no baseline, no COVERAGE FELL", () => !/COVERAGE FELL/.test(first.stderr));
  t("[D18] the probe line follows the headline on stderr", () => /\nprobe verify-probe 0\.9\.0 \(sha aaaaaaaaaaaa…\) · playwright 1\.63\.0 · chromium 140\.0\.7339\.16 · matched: tag 0 · text 185/.test(first.stderr));
  t("[DT-44/D18] implicit baseline: the report being overwritten → 'COVERAGE FELL 185→42 vs design/verify/Orders.report.json' + 'probe changed'", () =>
    /COVERAGE FELL 185→42 vs design\/verify\/Orders\.report\.json/.test(second.stderr) && /· probe changed/.test(second.stderr));
  t("[D18] report.against records both rounds", () => {
    const a = rep2?.against;
    return !!a && a.report === "design/verify/Orders.report.json" && a.nodesMeasured.before === 185 && a.nodesMeasured.after === 42 && a.probeChanged === true && a.expectationChanged === false;
  });
  t("[D18] the verdict is the one compare gives without a baseline", () => {
    const m42 = readJsonOrNull(path.join(cwd, "m42.json"), isVerifyMeasured);
    return !!e && !!m42 && !!rep2 && rep2.verdict === compare(e, m42).verdict;
  });
  put("old.report.json", { verdict: "incomplete", why: [], deltas: [], inputs: { probe: "unknown" }, coverage: { nodesExpected: 190, nodesMeasured: 190, fieldsChecked: 1 } });
  const third = run("--compare", expFile, "m42.json", "--out", "design/verify/Orders", "--against", "old.report.json");
  t("[D18] --against <file> overrides the implicit baseline", () => /COVERAGE FELL 190→42 vs old\.report\.json/.test(third.stderr) && /· probe changed/.test(third.stderr));
  const bad = run("--compare", expFile, "m42.json", "--out", "design/verify/Orders", "--against", "missing.report.json");
  t("[D18] an unreadable --against is exit 2, naming the file", () => bad.status === 2 && /--against 'missing\.report\.json' does not exist/.test(bad.stderr));
  fs.writeFileSync(path.join(cwd, "design/verify/Orders.report.json"), "{ not json");
  const garbled = run("--compare", expFile, "m42.json", "--out", "design/verify/Orders");
  t("[D18] an unreadable implicit baseline is a note, not an error", () => garbled.status === 1 && /note {2}design\/verify\/Orders\.report\.json is not valid JSON/.test(garbled.stderr) && !/COVERAGE FELL/.test(garbled.stderr));
  t("[cli] --against is registered and documented; only with --compare", () => /--against <report\.json>/.test(run("--help").stdout) && run("--expect", "orders.json", "--against", "x.json").status === 2);

  put("evidence.json", { interactions: [], components: [{ setName: "Button", present: false, detail: "no button in the toolbar" }] });
  run("--compare", expFile, "m185.json", "--out", "design/verify/Ev", "--interactions", "evidence.json");
  const ev = readJsonOrNull(path.join(cwd, "design/verify/Ev.report.json"), isVerifyReport);
  t("[components] components[] in the --interactions object are read: Button reported ABSENT → fail", () =>
    !!ev && (ev.componentsAbsent || []).some((c) => c.setName === "Button" && c.detail === "no button in the toolbar") && ev.verdict === "fail");
  const withIds = run("--compare", expFile, "m185.json", "--out", "design/verify/Ev2");
  t("[not-in-expectation] the CLI prints nothing when every measured id is known", () => !/not in the expectation/.test(withIds.stderr));
  put("mx.json", measured([probeNode("2:1", { text: "Order 1" }), probeNode("77:1", {}), probeNode("77:2", {})]));
  const mx = run("--compare", expFile, "mx.json", "--out", "design/verify/Ev3");
  t("[not-in-expectation] the CLI prints the count and the first ids", () => /note {2}2 measured node id\(s\) are not in the expectation \(e\.g\. 77:1, 77:2\)/.test(mx.stderr));
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ---- a hand-written file's own `probe` / `notMeasured` is ignored with a note, never a refusal (review LOW)
block("malformed extras", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-probe-extras-"));
  const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: "utf8", cwd });
  fs.writeFileSync(path.join(cwd, "orders.json"), JSON.stringify(screen()));
  run("--expect", "orders.json", "--out", "design/verify/Orders");
  fs.writeFileSync(path.join(cwd, "hand.json"), JSON.stringify({ measuredAt: "2026-09-30T01:00:00Z", renderer: "hand", probe: "handmade", notMeasured: {}, nodes: [{ nodeId: "2:1", styles: { text: "Order 1" } }] }));
  const r = run("--compare", "design/verify/Orders.expected.json", "hand.json", "--out", "design/verify/Hand");
  const rep = readJsonOrNull(path.join(cwd, "design/verify/Hand.report.json"), isVerifyReport);
  t("[extras] probe: \"handmade\" + notMeasured: {} still compares (exit 1 = a verdict, not 2 = refused)", () => r.status === 1 && !!rep && rep.coverage?.nodesMeasured === 1);
  t("[extras] ... reports probe: unknown", () => rep?.inputs?.probe === "unknown");
  t("[extras] ... and says what it ignored, on stderr and in the report", () =>
    /note {2}hand\.json: measured\.probe is not/.test(r.stderr) && /measured\.notMeasured is not a list/.test(r.stderr)
    && (rep?.probe?.inputNotes || []).length === 2 && /measured\.probe is not/.test(fs.readFileSync(path.join(cwd, "design/verify/Hand.report.md"), "utf8")));
  fs.writeFileSync(path.join(cwd, "broken.json"), JSON.stringify({ nodes: [{ styles: {} }] }));
  t("[extras] measurements compare cannot read (a node without nodeId) are still refused, exit 2", () => run("--compare", "design/verify/Orders.expected.json", "broken.json", "--out", "design/verify/B").status === 2);
  t("[extras] in-process: a non-identity probe reads as unknown, with a note", () => {
    const rr = compare(exp(), malformed<VerifyMeasured>({ nodes: [], probe: "handmade" }));
    return rr.inputs?.probe === "unknown" && (rr.probe.inputNotes || []).some((n) => /measured\.probe is not/.test(n));
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ---- a null in a state's styles is not measured — never the resting value
block("state nulls", () => {
  const he = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "6:1", name: "Table", box: { x: 0, y: 0, w: 800, h: 200 },
    children: [{ type: "FRAME", id: "6:2", name: "Row", fills: [{ type: "solid", color: "#121319", tokens: { color: "Backgrounds/Row Hover" } }], box: { w: 800, h: 48 } }] }], { screen: "Table" }), label: "Table" }]);
  const row = he.nodes.find((n) => n.nodeId === "6:2");
  t("[state] the fixture's row is drawn hovered", () => row?.drawnState === "hover");
  // at rest it happens to show the hover colour; hovered, the probe could not read it
  const node = probeNode("6:2", { backgroundColor: "rgb(18, 19, 25)", width: 800, height: 48, tag: "tr" },
    { states: { hover: { styles: { backgroundColor: null }, unmeasured: { backgroundColor: "hover could not be triggered: element covered" } } } });
  const r = compare(he, measured([node]));
  t("[state] states.hover.styles.backgroundColor: null is not measured, with the state's own reason", () =>
    r.fieldsNotMeasured.some((f) => f.nodeId === "6:2" && f.field === "background" && f.why === "hover could not be triggered: element covered"));
  t("[state] ... and the resting value is not compared in its place", () => {
    const hovered = compare(he, measured([probeNode("6:2", { backgroundColor: "rgb(18, 19, 25)", width: 800, height: 48, tag: "tr" }, { states: { hover: { styles: { backgroundColor: "rgb(18, 19, 25)" } } } })]));
    return hovered.coverage.fieldsChecked === r.coverage.fieldsChecked + 1;
  });
});

// ---- doc-guards: the probe's output shape, and every hand-written file still reads
block("doc-guards", () => {
  const full = measured([probeNode("1:4", { text: "New order", tag: "span" }, { textFrom: "span", textFromMixed: false, fillSource: "css" })], {
    probe: IDENT, frame: { nodeId: "1:1", selector: "#root > div", via: "size-and-fill", rect: { x: 0, y: 0, w: 1280, h: 800 } },
    frames: [{ nodeId: "1:1", selector: "#root > div", via: "size-and-fill", rect: { x: 0, y: 0, w: 1280, h: 800 } }],
    navigation: { events: [{ type: "load", url: "http://localhost:5173/orders", at: 120 }], afterInitialLoad: 0, reruns: 0 },
    matchedByCensus: { tag: 0, text: 1 }, notMeasured: [{ nodeId: "2:1", why: "hidden" }],
  });
  t("[guard] the shipped probe's full output is a VerifyMeasured", () => { const roundTrip: unknown = JSON.parse(JSON.stringify(full)); return isVerifyMeasured(roundTrip); });
  t("[guard] a probe identity without a sha256 is rejected", () => !isVerifyMeasured({ nodes: [], probe: { name: "verify-probe", version: null, playwright: { package: "playwright", version: "1" }, browser: { name: "chromium", version: "1" } } }));
  t("[guard] unmeasured reasons must be strings", () => !isVerifyMeasured({ nodes: [{ nodeId: "1:4", styles: {}, unmeasured: { color: 3 } }] }));
  const dir = path.join(import.meta.dirname, "fixtures", "livetest3", "verify");
  t("[guard] every hand-written measured fixture still reads", () => fs.readdirSync(dir).filter((f) => f.endsWith(".measured.json")).every((f) => readJsonOrNull(path.join(dir, f), isVerifyMeasured) !== null));
});

// ---- probe (group 7)
// The probe's own logic: resolving the project's Playwright (D2), the fixed matching order (F-57, F-63, D17)
// and the output contract (DT-23). probe-match.ts is pure; the resolver runs on fake packages in temp dirs.
// test/verify-probe-e2e.test.ts runs the built bundle in a real chromium.
{
// ---------------------------------------------------------------- D2: resolving the project's Playwright
console.log("verify-probe — resolving the project's Playwright (D2):");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-unit-"));
const fakePkg = (dir: string, name: string, version: string, body: string): void => {
  const p = path.join(dir, "node_modules", ...name.split("/"));
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
  fs.writeFileSync(path.join(p, "index.js"), body);
};
const WITH_CHROMIUM = "module.exports = { chromium: { launch() { throw new Error('fake'); } } };\n";
const project = (name: string, pkgs: Array<[string, string, string]>, files: Record<string, string> = {}): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "invented-app", private: true }));
  for (const [n, v, b] of pkgs) fakePkg(d, n, v, b);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  return d;
};
{
  const onlyTest = project("only-test", [["@playwright/test", "1.60.1", WITH_CHROMIUM]]);
  const r = resolvePlaywright(onlyTest);
  t("[D2] only @playwright/test installed → it is picked, with its version", () => r.ok && r.pkg === "@playwright/test" && r.version === "1.60.1");
  const both = project("both", [["playwright", "1.61.0", WITH_CHROMIUM], ["playwright-core", "1.61.0", WITH_CHROMIUM]]);
  const rb = resolvePlaywright(both);
  t("[D2] playwright + playwright-core → playwright first", () => rb.ok && rb.pkg === "playwright" && rb.version === "1.61.0");
  const onlyCore = project("only-core", [["playwright-core", "1.59.0", WITH_CHROMIUM]]);
  const rc = resolvePlaywright(onlyCore);
  t("[D2] only playwright-core → playwright-core", () => rc.ok && rc.pkg === "playwright-core");
  const none = project("none", []);
  const rn = resolvePlaywright(none);
  t("[D2] nothing installed → not ok, the reason names <project>/package.json and the hint is the npm install command", () =>
    !rn.ok && rn.reason.includes(path.join(none, "package.json")) && rn.hint === "npm i -D playwright && npx playwright install chromium");
  const noChromium = project("no-chromium", [["playwright", "1.62.0", "module.exports = { firefox: {} };\n"]]);
  const rx = resolvePlaywright(noChromium);
  t("[D2] a package with no chromium launcher is rejected (the type guard checks at runtime)", () => !rx.ok && /no chromium launcher/.test(rx.reason));
  const fallThrough = project("fall-through", [["playwright", "1.62.0", "module.exports = {};\n"], ["playwright-core", "1.62.0", WITH_CHROMIUM]]);
  const rf = resolvePlaywright(fallThrough);
  t("[D2] a package without chromium falls through to the next one", () => rf.ok && rf.pkg === "playwright-core");
  t("[D2] the install hint follows the lockfile (pnpm / yarn / bun / npm)", () =>
    installHint(project("pnpm", [], { "pnpm-lock.yaml": "" })).startsWith("pnpm add -D playwright") &&
    installHint(project("yarn", [], { "yarn.lock": "" })).startsWith("yarn add -D playwright") &&
    installHint(project("bun", [], { "bun.lock": "" })).startsWith("bun add -d playwright") &&
    installHint(none).startsWith("npm i -D playwright"));
  const pnp = project("pnp", [], { ".pnp.cjs": "" });
  const rp = resolvePlaywright(pnp);
  t("[D2] Yarn Plug'n'Play → the reason says to retry via `yarn node`", () => !rp.ok && /yarn node/.test(rp.reason));

  const PROBE_CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  const run = spawnSync(process.execPath, [PROBE_CLI, "--check", "--project", none], { encoding: "utf8" });
  t("[D2] --check with nothing resolvable → exit 3, prints the install command for the USER, never installs", () =>
    run.status === 3 && /renderer unavailable/.test(run.stderr) && /npm i -D playwright && npx playwright install chromium/.test(run.stderr)
    && !fs.existsSync(path.join(none, "node_modules")) && !fs.existsSync(path.join(none, "package-lock.json")));
  const launchFails = spawnSync(process.execPath, [PROBE_CLI, "--check", "--project", onlyTest], { encoding: "utf8" });
  t("[D2] a launch failure → exit 3 with the browser install command", () => launchFails.status === 3 && /chromium did not launch: fake/.test(launchFails.stderr) && /npx playwright install chromium/.test(launchFails.stderr));
  const usage = spawnSync(process.execPath, [PROBE_CLI, "--url", "http://127.0.0.1:1/"], { encoding: "utf8" });
  t("[CLI] --url without --expected → exit 2 (usage)", () => usage.status === 2);
  const badVp = spawnSync(process.execPath, [PROBE_CLI, "--expected", path.join(tmp, "missing.expected.json"), "--url", "http://127.0.0.1:1/"], { encoding: "utf8" });
  t("[CLI] an unreadable --expected → exit 2 before any browser work", () => badVp.status === 2 && /does not exist/.test(badVp.stderr));
}

// ---------------------------------------------------------------- matching (F-57, F-63, D17)
console.log("verify-probe — the fixed matching order (F-57, F-63, D17):");
const VISIBLE: ElemFlags = { box: true, visible: true, zeroSize: false, inClosedDialog: false, inert: false, opacity0: false, ariaHidden: false };
let order = 0;
const cand = (p: Partial<Omit<Candidate, "flags">> & { flags?: Partial<ElemFlags> } = {}): Candidate => {
  const { flags, ...rest } = p;
  const rect = rest.rect ?? { x: 0, y: 0, w: 100, h: 20 };
  return { path: `html > body > x:nth-child(${++order})`, tag: "div", dt: null, rect, rangeRect: rect, taggedAncestors: [], order: order, depth: 3, ...rest, ownText: rest.ownText ?? "", flags: { ...VISIBLE, ...flags } };
};
const FRAME: ResolvedFrame = { nodeId: "10:1", selector: '[data-dt-node="10:1"]', via: "tag", rect: { x: 0, y: 0, w: 1280, h: 800 }, path: "html > body > div:nth-child(1)" };
const collect = (c: Partial<CollectOutput>): CollectOutput => ({ viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 }, tagged: [], frames: {}, text: {}, placeholders: {}, positions: {}, ...c });
const pool = (specs: VerifySpec[], c: Partial<CollectOutput>, expectedIds: string[] = specs.map((s) => s.nodeId)): MatchPool =>
  buildPool(collect(c), specs, new Set(expectedIds), new Map([["10:1", FRAME]]), "10:1");
const spec = (s: Partial<VerifySpec> & { nodeId: string }): VerifySpec => ({ name: "Invented", type: "TEXT", ...s });
const matched = (m: Match | NoMatch): Match | null => (isMatch(m) ? m : null);
const whyOf = (m: Match | NoMatch): string => (isMatch(m) ? "" : m.why);

{
  // F-57: the same words in the sidebar button, the page title and a CLOSED dialog's heading
  const s = spec({ nodeId: "10:3", text: "Shift Planner", x: 24 });
  const dialogH2 = cand({ tag: "h2", flags: { inClosedDialog: true }, rect: { x: 400, y: 300, w: 100, h: 20 } }); // styled visible: only the dialog rule rejects it
  const h1 = cand({ tag: "h1", rect: { x: 220, y: 16, w: 200, h: 24 } });
  const button = cand({ tag: "button", rect: { x: 24, y: 20, w: 90, h: 16 } });
  const p = pool([s], { text: { "Shift Planner": { exact: [dialogH2, h1, button], caseless: [] } } });
  const m = chooseMatch(s, p, { position: false });
  t("[F-57] same text in a closed dialog, a page <h1> and the sidebar button → the sidebar button by the spec's x (never first-wins)", () => matched(m)?.cand === button && matched(m)?.matchedBy === "text");
  const onlyDialog = pool([spec({ nodeId: "10:4", text: "Save" })], { text: { Save: { exact: [cand({ flags: { inClosedDialog: true } }), cand()], caseless: [] } } });
  const md = chooseMatch(spec({ nodeId: "10:4", text: "Save" }), onlyDialog, { position: false });
  t("[F-57] text inside a closed <dialog> is rejected even when its styles say visible", () => matched(md) !== null && matched(md)?.cand?.flags.inClosedDialog === false);
  const inert = pool([spec({ nodeId: "10:4", text: "Save" })], { text: { Save: { exact: [cand({ flags: { inert: true } }), cand({ flags: { zeroSize: true } }), cand({ flags: { opacity0: true } }), cand({ tag: "span" })], caseless: [] } } });
  t("[F-57] inert, 0×0 and opacity-0 owners are rejected", () => matched(chooseMatch(spec({ nodeId: "10:4", text: "Save" }), inert, { position: false }))?.cand?.tag === "span");
  const aria = pool([spec({ nodeId: "10:4", text: "Save" })], { text: { Save: { exact: [cand({ tag: "span", flags: { ariaHidden: true } })], caseless: [] } } });
  t("[F-57] aria-hidden is NOT a reason to reject (decorative ≠ invisible)", () => matched(chooseMatch(spec({ nodeId: "10:4", text: "Save" }), aria, { position: false }))?.cand?.tag === "span");
  const hidden = pool([spec({ nodeId: "10:4", text: "Save" })], { text: { Save: { exact: [cand({ flags: { inClosedDialog: true, box: false, visible: false } })], caseless: [] } } });
  t("[F-57] only hidden owners → notMeasured, saying why", () => /hidden: text 'Save'.*closed <dialog>/.test(whyOf(chooseMatch(spec({ nodeId: "10:4", text: "Save" }), hidden, { position: false }))));

  const tie = spec({ nodeId: "10:5", text: "Status", x: 100 });
  const tp = pool([tie], { text: { Status: { exact: [cand({ rect: { x: 96, y: 0, w: 40, h: 16 } }), cand({ rect: { x: 106, y: 0, w: 40, h: 16 } })], caseless: [] } } });
  t("[F-57] two owners less than 8px apart from the spec's x → notMeasured 'tag it', not a guess", () => /matched 2 visible elements; tag it/.test(whyOf(chooseMatch(tie, tp, { position: false }))));
  const noX = spec({ nodeId: "10:6", text: "Status" });
  const np = pool([noX], { text: { Status: { exact: [cand(), cand()], caseless: [] } } });
  t("[F-57] two owners, one spec, no x → notMeasured", () => !isMatch(chooseMatch(noX, np, { position: false })));

  const a = spec({ nodeId: "10:7", text: "Edit" }), b = spec({ nodeId: "10:8", text: "Edit" });
  const c1 = cand({ tag: "button" }), c2 = cand({ tag: "button" });
  const op = pool([a, b], { text: { Edit: { exact: [c2, c1], caseless: [] } } });
  t("[D17] k specs sharing a text and exactly k owners → text-ordinal, paired in document order", () =>
    matched(chooseMatch(a, op, { position: false }))?.cand === c1 && matched(chooseMatch(b, op, { position: false }))?.cand === c2 && matched(chooseMatch(b, op, { position: false }))?.matchedBy === "text-ordinal");
  const op3 = pool([a, b], { text: { Edit: { exact: [cand(), cand(), cand()], caseless: [] } } });
  t("[D17] 2 specs, 3 owners → notMeasured (no ordinal)", () => !isMatch(chooseMatch(a, op3, { position: false })));

  const scoped = spec({ nodeId: "10:9", text: "Delete", ancestorIds: ["10:20", "10:30"] });
  const inRow = cand({ taggedAncestors: ["10:20"] }), elsewhere = cand({ taggedAncestors: ["10:40"] });
  const sp = pool([scoped], { tagged: [cand({ dt: "10:20" })], text: { Delete: { exact: [elsewhere, inRow], caseless: [] } } });
  t("[F-57] text scoped to the nearest tagged ancestor from ancestorIds", () => matched(chooseMatch(scoped, sp, { position: false }))?.cand === inRow);
  const oldExp = spec({ nodeId: "10:9", text: "Delete" });
  t("[F-57] an expectation without ancestorIds (written before group 7) is tolerated: unscoped, two owners → notMeasured, no crash", () => !isMatch(chooseMatch(oldExp, pool([oldExp], { text: { Delete: { exact: [elsewhere, inRow], caseless: [] } } }), { position: false })));

  const ci = spec({ nodeId: "10:10", text: "Sign in" });
  t("[F-57] case-insensitive fallback only when there is no exact owner", () =>
    matched(chooseMatch(ci, pool([ci], { text: { "Sign in": { exact: [], caseless: [cand({ tag: "a" })] } } }), { position: false }))?.cand?.tag === "a");

  const tagged = spec({ nodeId: "10:11", type: "FRAME" });
  const hid = cand({ dt: "10:11", flags: { box: false, visible: false } }), vis = cand({ dt: "10:11" });
  const tg = chooseMatch(tagged, pool([tagged], { tagged: [hid, vis] }), { position: false });
  t("[tag] data-dt-node → the first VISIBLE hit, selectorCount = every hit", () => matched(tg)?.cand === vis && matched(tg)?.selectorCount === 2 && matched(tg)?.selector === '[data-dt-node="10:11"]');
  t("[tag] tagged but never rendered → notMeasured 'hidden', not a text guess", () => /^hidden: data-dt-node="10:11"/.test(whyOf(chooseMatch(tagged, pool([tagged], { tagged: [hid] }), { position: false }))));
  const shared = spec({ nodeId: "I10:50;7:1", type: "FRAME" });
  const foreign = cand({ dt: "I10:60;7:1" });
  t("[tag-shared-path] one element tagged with another instance's id for the same internal node", () =>
    matched(chooseMatch(shared, pool([shared], { tagged: [foreign] }), { position: false }))?.matchedBy === "tag-shared-path");
  t("[tag-shared-path] two such elements → not taken", () => !isMatch(chooseMatch(shared, pool([shared], { tagged: [foreign, cand({ dt: "I10:70;7:1" })] }), { position: false })));

  const box = spec({ nodeId: "10:12", type: "FRAME", x: 10, y: 10, width: 50, height: 20 });
  const bp = pool([box], { positions: { "10:12": [cand({ tag: "section" })] } });
  t("[D17] position matching only with --position", () => !isMatch(chooseMatch(box, bp, { position: false })) && matched(chooseMatch(box, bp, { position: true }))?.matchedBy === "position");
  t("[D17] an untagged container with no text → notMeasured 'tag it'", () => /no data-dt-node and no text; tag it/.test(whyOf(chooseMatch(box, bp, { position: false }))));

  const f2 = spec({ nodeId: "10:13", type: "FRAME", frameId: "10:2" });
  const mp = buildPool(collect({}), [f2], new Set(["10:13"]), new Map<string, ResolvedFrame | null>([["10:1", FRAME], ["10:2", null]]), "10:1");
  t("[D17] a spec in a frame that did not render → notMeasured 'frame … not rendered'", () => /frame 10:2 not rendered/.test(whyOf(chooseMatch(f2, mp, { position: false }))));
}

// review H1: one element, one spec
{
  // (a) five rows' identical dates: a row whose own copy is missing must not borrow another row's cell
  const s2 = spec({ nodeId: "11:2", text: "14 Mar", ancestorIds: ["11:20"] });
  const cell1 = cand({ tag: "td", taggedAncestors: ["11:10"] });
  const hp = pool([s2], { tagged: [cand({ dt: "11:10" }), cand({ dt: "11:20" })], text: { "14 Mar": { exact: [cell1], caseless: [] } } });
  t("[H1a] a visible tagged ancestor that holds none of the owners → notMeasured 'not inside', never the page-wide owner", () =>
    /text '14 Mar' is not inside data-dt-node="11:20"/.test(whyOf(chooseMatch(s2, hp, { position: false }))));
  // (b) a peer matched by its own tag does not count for the ordinal, and its element is not a candidate
  const tagged = spec({ nodeId: "11:3", text: "Draft" }), untagged = spec({ nodeId: "11:4", text: "Draft" });
  const peerEl = cand({ tag: "span", dt: "11:3" }), other = cand({ tag: "span" });
  const tp = pool([tagged, untagged], { tagged: [peerEl], text: { Draft: { exact: [peerEl, other], caseless: [] } } });
  const mu = chooseMatch(untagged, tp, { position: false });
  t("[H1b] a tagged peer's element is never handed to an untagged spec with the same text (no stolen ordinal)", () => matched(mu)?.cand === other && matched(mu)?.matchedBy === "text");
  const third = spec({ nodeId: "11:11", text: "Draft" });
  const o1 = cand({ tag: "span" }), o2 = cand({ tag: "span" });
  const tp3 = pool([tagged, untagged, third], { tagged: [peerEl], text: { Draft: { exact: [peerEl, o1, o2], caseless: [] } } });
  t("[H1b] the tagged peer is left out of the ordinal count: 2 untagged specs, 2 free owners → paired in document order", () =>
    matched(chooseMatch(untagged, tp3, { position: false }))?.cand === o1 && matched(chooseMatch(third, tp3, { position: false }))?.cand === o2 && matched(chooseMatch(third, tp3, { position: false }))?.matchedBy === "text-ordinal");
  t("[H1b] and the tagged peer keeps its own element", () => matched(chooseMatch(tagged, tp, { position: false }))?.cand === peerEl);
  // (c) the global check
  const mk = (nodeId: string, matchedBy: Match["matchedBy"], p: string, dt: string | null = null): Match => ({ nodeId, matchedBy, selector: p, path: p, cand: cand({ path: p, dt }) });
  const res = claimOnce([mk("11:5", "text", "p1"), mk("11:6", "tag", "p1", "11:6"), mk("11:7", "text", "p2"), mk("11:8", "text-ordinal", "p2"), mk("11:9", "text", "p3")]);
  t("[H1c] two specs on one element: the one tagged on it keeps it, the other becomes notMeasured naming the owner", () =>
    !isMatch(must(res[0], "r0")) && /data-dt-node="11:6"'s/.test(whyOf(must(res[0], "r0"))) && isMatch(must(res[1], "r1")));
  t("[H1c] two text matches on one element with no tagged owner → both notMeasured", () => !isMatch(must(res[2], "r2")) && !isMatch(must(res[3], "r3")) && /matched for 2 specs/.test(whyOf(must(res[2], "r2"))));
  const phm: Match = { ...mk("11:12", "text", "p4"), placeholder: true };
  const withPh = claimOnce([mk("11:13", "tag", "p4", "11:13"), phm]);
  t("[H1c] an input placeholder may share the field's tagged <input>", () => isMatch(must(withPh[0], "w0")) && isMatch(must(withPh[1], "w1")));
  const phSpec = spec({ nodeId: "11:14", placeholder: true, placeholderText: "Find staff" });
  const inputEl = cand({ tag: "input", dt: "11:13" });
  t("[H1b] a placeholder spec is matched on an <input> tagged with the field's id (not dropped as claimed)", () =>
    matched(chooseMatch(phSpec, pool([phSpec], { tagged: [inputEl], placeholders: { "Find staff": [inputEl] } }, ["11:13", "11:14"]), { position: false }))?.placeholder === true);
  t("[H1c] an element with one spec is untouched", () => isMatch(must(res[4], "r4")));
}

// re-review M1/M2: an owner that IS the nearest tagged ancestor's element
{
  const field = cand({ tag: "input", dt: "13:1", path: "field" });
  const ph = spec({ nodeId: "13:2", placeholder: true, placeholderText: "Search by name", ancestorIds: ["13:1"] });
  const pp = pool([ph], { tagged: [field], placeholders: { "Search by name": [field] } }, ["13:1", "13:2"]);
  t("[RR-M1] a placeholder nested under the tagged field frame is matched on that field's <input> (its own tag counts as inside)", () => matched(chooseMatch(ph, pp, { position: false }))?.cand === field);
  const btn = cand({ tag: "button", dt: "13:3", ownText: "Filter", path: "btn" });
  const label = spec({ nodeId: "13:4", text: "Filter", ancestorIds: ["13:3"] });
  const lp = pool([label], { tagged: [btn], text: { Filter: { exact: [btn], caseless: [] } } }, ["13:3", "13:4"]);
  const lm = chooseMatch(label, lp, { position: false });
  t("[RR-M2] a TEXT label written straight into its nearest tagged ancestor (<button data-dt-node=X>Filter</button>) shares X's element (sharesWith X)", () => matched(lm)?.cand === btn && matched(lm)?.sharesWith === "13:3" && matched(lm)?.matchedBy === "text");
  const ownerM: Match = { nodeId: "13:3", matchedBy: "tag", selector: "b", path: "btn", cand: btn };
  const both = claimOnce([ownerM, lm]);
  t("[RR-M2] claimOnce lets that one label share with the tag owner", () => isMatch(must(both[0], "b0")) && isMatch(must(both[1], "b1")));
  const other = spec({ nodeId: "13:5", text: "Filter", ancestorIds: ["13:9"] });
  t("[RR-M2] a TEXT spec whose nearest tagged ancestor is ANOTHER element never takes X's element", () => !isMatch(chooseMatch(other, pool([other], { tagged: [btn, cand({ dt: "13:9" })], text: { Filter: { exact: [btn], caseless: [] } } }, ["13:3", "13:5", "13:9"]), { position: false })));
  const wrongText = spec({ nodeId: "13:6", text: "Filter", ancestorIds: ["13:3"] });
  const btn2 = cand({ tag: "button", dt: "13:3", ownText: "Filter all", path: "btn2" });
  t("[RR-M2] only when the element's OWN text is exactly the spec's text", () => !isMatch(chooseMatch(wrongText, pool([wrongText], { tagged: [btn2], text: { Filter: { exact: [btn2], caseless: [] } } }, ["13:3", "13:6"]), { position: false })));
  const split = cand({ tag: "button", dt: "13:30", ownText: "Fil", path: "split" }); // <button data-dt-node=13:30>Fil<b>ter</b></button>
  const sl = spec({ nodeId: "13:31", text: "Filter", ancestorIds: ["13:30"] });
  t("[RR2-LOW1] the tagged ancestor's element counts as 'inside' only when its OWN text is the spec's (Fil<b>ter</b> is not)", () =>
    /is not inside data-dt-node="13:30"/.test(whyOf(chooseMatch(sl, pool([sl], { tagged: [split], text: { Filter: { exact: [split], caseless: [] } } }, ["13:31"]), { position: false }))));
  // Figma: label < Item(13:40) < Group(13:41); DOM nests the other way — Group's element inside Item's, holding the label
  const item = cand({ dt: "13:40", path: "item" }), groupEl = cand({ tag: "span", dt: "13:41", ownText: "Export", taggedAncestors: ["13:40"], path: "group" });
  const nl = spec({ nodeId: "13:42", text: "Export", ancestorIds: ["13:40", "13:41"] });
  t("[RR2-LOW2] only the NEAREST tagged ancestor's element may be shared — not a farther one the DOM happens to nest inside it", () =>
    !isMatch(chooseMatch(nl, pool([nl], { tagged: [item, groupEl], text: { Export: { exact: [groupEl], caseless: [] } } }, ["13:40", "13:41", "13:42"]), { position: false })));
  const twoLabels = claimOnce([ownerM, { ...must(matched(lm), "lm"), nodeId: "13:7" }, { ...must(matched(lm), "lm"), nodeId: "13:8" }]);
  t("[RR-M2] two labels sharing one element → neither keeps it", () => !isMatch(must(twoLabels[1], "t1")) && !isMatch(must(twoLabels[2], "t2")));
}

// review M2: hover-only content that is display:none at rest
{
  const s = spec({ nodeId: "12:2", type: "FRAME", drawnState: "hover", ancestorIds: ["12:1"] });
  const row = cand({ dt: "12:1", path: "row-path" }), btn = cand({ dt: "12:2", flags: { box: false, visible: false, zeroSize: true } });
  const m = chooseMatch(s, pool([s], { tagged: [row, btn] }), { position: false });
  t("[M2] a drawn-hover spec whose tagged element has no box at rest → matched by tag, hovered through its tagged ancestor", () => matched(m)?.cand === btn && matched(m)?.hoverVia === "row-path");
  const rest = spec({ nodeId: "12:2", type: "FRAME", ancestorIds: ["12:1"] });
  t("[M2] the same element with no drawn hover state → notMeasured 'hidden'", () => /^hidden:/.test(whyOf(chooseMatch(rest, pool([rest], { tagged: [row, btn] }), { position: false }))));
}

// review M3 / LOW: a dead browser is not a reload
t("[M3] 'Target page, context or browser has been closed' (or a closed page) → gone, never 'navigated'", () =>
  errorKind("page.evaluate: Target page, context or browser has been closed", false) === "gone" && errorKind("anything", true) === "gone");
t("[M3] a destroyed execution context → navigated", () => errorKind("page.evaluate: Execution context was destroyed, most likely because of a navigation", false) === "navigated");
t("[M3] an unrelated message that merely says 'navigating' is not a reload", () => errorKind("locator.hover: element is navigating away? (invented)", false) === "other");

// real expected.json rows (buildExpectation), not hand-typed specs
{
  const exp = buildExpectation([{ label: "Invented", doc: screenExport([{
    type: "FRAME", id: "20:1", name: "Invented Screen", box: { x: 0, y: 0, w: 800, h: 600 }, fills: [{ type: "solid", color: "#101010" }],
    children: [
      { type: "FRAME", id: "20:2", name: "Menu", box: { x: 0, y: 0, w: 200, h: 600 }, fills: [{ type: "solid", color: "#202020" }],
        children: [{ type: "TEXT", id: "20:3", name: "Item", text: "Reports", box: { w: 80, h: 16 }, renderBox: { x: 24, y: 20, w: 60, h: 12 }, font: { family: "Arial", size: 12, weight: "Regular" } }] },
    ],
  }], { screen: "Invented Screen" }) }]);
  const s = must(exp.nodes.find((n) => n.nodeId === "20:3"), "spec 20:3");
  const inMenu = cand({ taggedAncestors: ["20:2"], rect: { x: 300, y: 0, w: 60, h: 12 } }), title = cand({ tag: "h1", rect: { x: 26, y: 0, w: 60, h: 12 } });
  const p = buildPool(collect({ tagged: [cand({ dt: "20:2" })], text: { Reports: { exact: [title, inMenu], caseless: [] } } }), exp.nodes, new Set(exp.nodes.map((n) => n.nodeId)), new Map([["20:1", { ...FRAME, nodeId: "20:1" }]]), "20:1");
  t("[F-57] a real --expect row: ancestorIds scope beats a nearer x outside the tagged menu", () => (s.ancestorIds || []).includes("20:2") && matched(chooseMatch(s, p, { position: false }))?.cand === inMenu);
  const root = must(exp.nodes.find((n) => n.nodeId === "20:1"), "frame spec");
  const pv = buildPool(collect({}), exp.nodes, new Set(), new Map([["20:1", { ...FRAME, nodeId: "20:1", via: "size-and-fill" as const, selector: "html > body > div" }]]), "20:1");
  t("[F-63] the frame's own spec is matched to the resolved frame root (matchedBy frame)", () => matched(chooseMatch(root, pv, { position: false }))?.matchedBy === "frame");
}

// ---------------------------------------------------------------- the frame root (F-63)
{
  const sized = (bg: string, depth: number, extra: Partial<Candidate> = {}): SizedCandidate => ({ ...cand({ rect: { x: 0, y: 0, w: 800, h: 600 }, depth, ...extra }), background: bg, backgroundImage: "none", paints: false });
  const body = sized("rgba(0, 0, 0, 0)", 0, { tag: "body" }), rootDiv = sized("rgba(0, 0, 0, 0)", 1), app = sized("rgb(29, 29, 31)", 2), inner = sized("rgb(1, 2, 3)", 3);
  const f = { nodeId: "30:1", w: 800, h: 600 };
  const vp = { w: 800, h: 600 };
  t("[F-63] tagged frame root → via tag", () => resolveFrame(f, [cand({ dt: "30:1" })], [app], vp, true)?.via === "tag");
  const r = resolveFrame(f, [], [inner, body, rootDiv, app], vp, true);
  t("[F-63] transparent <body> and #root skipped: the OUTERMOST painted element of the frame's size → via size-and-fill", () => r?.via === "size-and-fill" && r.path === app.path);
  t("[F-63] a background image counts as paint", () => resolveFrame(f, [], [{ ...body, backgroundImage: "url(a.png)" }], vp, true)?.path === body.path);
  t("[F-63] ±2px of the frame size only", () => resolveFrame(f, [], [{ ...app, rect: { x: 0, y: 0, w: 780, h: 600 } }], vp, true)?.via === "viewport");
  const v = resolveFrame(f, [], [body], vp, true);
  t("[F-63] nothing paints → via viewport with a note", () => v?.via === "viewport" && /tag the frame root/.test(v.note || ""));
  t("[F-63] a second frame never falls back to the viewport", () => resolveFrame(f, [], [body], vp, false) === null);
}

// ---------------------------------------------------------------- the output contract (DT-23)
console.log("verify-probe — the output contract (DT-23):");
{
  const s = spec({ nodeId: "40:1", type: "VECTOR", fill: "#ff0000ff" });
  const m: Match = { nodeId: "40:1", matchedBy: "tag", selector: '[data-dt-node="40:1"]', selectorCount: 1, path: "html", cand: null };
  const raw: MeasureResult = { nodeId: "40:1", found: true, styles: { width: 16, height: 16, fill: null, tag: "img" }, unmeasured: { fill: "an <img>: its paint is pixels, not a CSS property" }, fillSource: "img" };
  const n = shapeNode(s, m, raw, STYLE_KEYS);
  const st = n.styles || {};
  t("[DT-23] every STYLE_KEY is present on a shaped node (fill included)", () => STYLE_KEYS.length > 0 && STYLE_KEYS.every((k) => k in st) && "fill" in st);
  t("[DT-23] every null carries a reason in unmeasured", () => STYLE_KEYS.every((k) => st[k] !== null || typeof (n.unmeasured || {})[k] === "string"));
  t("[DT-23] the page's own reason is kept (<img> fill) and fillSource travels", () => (n.unmeasured || {}).fill === "an <img>: its paint is pixels, not a CSS property" && n.fillSource === "img");
  t("[DT-23] a key the page did not send gets a generic reason, never silently absent", () => st.fontFamily === null && typeof (n.unmeasured || {}).fontFamily === "string");
  const gone = shapeNode(s, m, { nodeId: "40:1", found: false, styles: {}, unmeasured: {} }, STYLE_KEYS);
  t("[DT-23] an element gone at measure time → every key null with that reason", () => STYLE_KEYS.every((k) => (gone.unmeasured || {})[k] === "the element was gone when measured"));
  t("[census] counts per matchedBy + notMeasured", () => {
    const c = census([{ matchedBy: "tag" }, { matchedBy: "tag" }, { matchedBy: "tag-shared-path" }, { matchedBy: "text" }, { matchedBy: "text-ordinal" }, { matchedBy: "position" }, { matchedBy: "frame" }], [{}, {}]);
    return c.tag === 2 && c.sharedPath === 1 && c.text === 1 && c.textOrdinal === 1 && c.position === 1 && c.frame === 1 && c.notMeasured === 2;
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
}

report();
