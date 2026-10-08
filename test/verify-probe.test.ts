// Offline tests for the shipped web probe's output contract and what --compare does with it (group 7).
// No browser here: the compare/contract half builds real expectations through buildExpectation / --expect
// and feeds them measured.json shapes the probe writes (every STYLE_KEY present, null + unmeasured[key]).
// Run with:  node test/verify-probe.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as VS from "../design-to-code/verify-screen.ts";
import type { BuiltExpectation, ExpectInput } from "../design-to-code/verify-screen.ts";
import type { FontSpec, MeasuredNode, MeasuredStyles, ProbeIdentity, ScreenExport, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { malformed, screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";
import { buildPool, census, chooseMatch, claimOnce, isMatch, resolveFrame, shapeNode } from "../design-to-code/probe-match.ts";
import * as PM from "../design-to-code/probe-match.ts";
import * as PP from "../design-to-code/probe-page.ts";
import * as VP from "../design-to-code/verify-probe.ts";
import type { Match, MatchPool, NoMatch, ResolvedFrame } from "../design-to-code/probe-match.ts";
import type { Candidate, CollectOutput, ElemFlags, MeasureResult, SizedCandidate } from "../design-to-code/probe-page.ts";
import { errorKind, installHint, resolvePlaywright } from "../design-to-code/verify-probe.ts";
import type { VerifySpec } from "../design-to-code/types.ts";
import { must } from "./fixtures.ts";
import type * as PDT from "../design-to-code/probe-drive.ts";
import type { VerifyExpectation, VerifyInteraction } from "../design-to-code/types.ts";
import type * as PBT from "../design-to-code/probe-behaviour.ts";
import { parseCssColor } from "../design-to-code/color.ts";
import type { BehaviourCheck as BehaviourCheckRow, InteractionEvidence } from "../design-to-code/types.ts";
// group 12b: probe-behaviour.ts is loaded dynamically too (a tree without it: every 12b check is a clean ✗)
const PB: Partial<typeof PBT> = await import("../design-to-code/probe-behaviour.ts").then((m) => ({ ...m }), () => ({}));
// group 12a: probe-drive.ts is loaded dynamically so this file still RUNS on a tree without it (the "fails before" check)
const PD: Partial<typeof PDT> = await import("../design-to-code/probe-drive.ts").then((m) => ({ ...m }), () => ({}));

// A check whose body may throw (a missing export on an older tree): a throw is a clean ✗, never a crash.
const t = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch { r = false; } return check(name, r); };
// A group of checks that shares setup: setup that throws on an older tree is one clean ✗, not a crash.
// (Nodes whose spec has padding send a real padding in the groups below, so those run on a tree where
// padding: null still crashed compare — each change's checks then fail on their own.)
/** D54(b) (fix 10): the fake documents' root element — the own-content check walks the page from it for a label laid over the
 *  container from outside (the fakes put the tested tree under it; its own style is empty) */
const fakeDe = (root: unknown, extra?: Record<string, unknown>): Record<string, unknown> => ({ tagName: "HTML", children: [root], childNodes: [], parentElement: null, shadowRoot: null,
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 700, right: 1000, bottom: 700 }), getClientRects: () => [], checkVisibility: () => true,
  getAttribute: () => null, clientWidth: 1000, clientHeight: 700, css: {}, before: {}, overflow: "visible", ...extra });
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
  const handFile = path.join(import.meta.dirname, "fixtures", "livetest3", "verify", "JetRoles.measured.json");
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

// ---- F-71 notes (severity unchanged); a position match caps the severity at low (D30)
block("F-71 / position notes", () => {
  const e = exp();
  const onButton = compare(e, measured([probeNode("1:4", { fontWeight: 500, text: "New order", tag: "button" })]));
  const d = onButton.deltas.find((x) => x.nodeId === "1:4" && x.field === "font-weight");
  t("[F-71] a TEXT weight read off a <button> without textFrom: note names the container, severity still high", () => !!d && d.severity === "high" && /typography read from a <button>, not the text run/.test(d.note || ""));
  const onSpan = compare(e, measured([probeNode("1:4", { fontWeight: 500, text: "New order", tag: "button" }, { textFrom: "span" })]));
  t("[F-71] ... no note when the probe says it read the text run (textFrom)", () => onSpan.deltas.some((x) => x.field === "font-weight" && !/typography read from/.test(x.note || "")));
  const byPos = compare(e, measured([probeNode("1:2", { backgroundColor: "#000000", padding: [8, 16, 8, 16], tag: "div" }, { matchedBy: "position" })]));
  const pd = byPos.deltas.find((x) => x.nodeId === "1:2" && x.field === "background");
  t("[position] a position-matched delta is capped at low (D30), its severity kept in cappedFrom, the note says why", () => !!pd && pd.severity === "low" && pd.cappedFrom === "high" && /capped at low: matched by position/.test(pd.note || ""));
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
  // tied to this expectation (L-6: a measured file naming no expectation is an integrity failure → incomplete, never fail)
  put("m185e.json", { ...rows(185, "a".repeat(64)), expectationSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(cwd, expFile))).digest("hex") });
  run("--compare", expFile, "m185e.json", "--out", "design/verify/Ev", "--interactions", "evidence.json");
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

  // DT-30 (D112): --browser-path is checked first — before the project's Playwright is resolved (`none` has none) or a browser
  // launched: a missing path, a directory (a macOS .app), a file that is not executable → exit 3, one line, no stack
  const notExec = path.join(tmp, "not-executable");
  fs.writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
  const app = path.join(tmp, "Invented Browser.app");
  fs.mkdirSync(app, { recursive: true });
  const bp = (p: string) => spawnSync(process.execPath, [PROBE_CLI, "--check", "--project", none, "--browser-path", p], { encoding: "utf8" });
  const oneLine = (r: { status: number | null; stderr: string }, p: string): boolean => r.status === 3 && r.stderr.trim().split("\n").length === 1 && !/\n\s+at /.test(r.stderr)
    && r.stderr.trim() === `verify-probe: renderer unavailable — --browser-path ${p} is not an executable file (on macOS pass the binary inside the .app: …/Contents/MacOS/…) — nothing was measured or written.`;
  const missing = path.join(tmp, "nonexistent", "chrome");
  t("[DT-30] --browser-path <missing> → exit 3 before resolving Playwright: one line naming the path and the macOS inner-binary hint, no stack", () => oneLine(bp(missing), missing));
  t("[DT-30] --browser-path <an .app directory> / <a file without the execute bit> → the same exit 3", () => oneLine(bp(app), app) && (process.platform === "win32" || oneLine(bp(notExec), notExec)));
  const help = spawnSync(process.execPath, [PROBE_CLI, "--help"], { encoding: "utf8" });
  t("[DT-30] --help: --browser-path, only guaranteed with the bundled Chromium, the inner binary on macOS, executable \"custom\"", () =>
    /\[--browser-path <executable>\]/.test(help.stdout) && /only\s+guaranteed with the bundled Chromium/.test(help.stdout) && /Contents\/MacOS/.test(help.stdout) && /executable says "custom"/.test(help.stdout));
  t("[DT-30] browserPathError: null for an executable file (this node binary)", () => {
    const f = (VP as Partial<typeof VP>).browserPathError;
    return f !== undefined && f(process.execPath) === null && typeof f(missing) === "string";
  });
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
// D135 (ABORT-2): a failed load's cause in plain words — a 204 and a download both end net::ERR_ABORTED; the thrown message
// tells them apart; another cause is Playwright's first line, as before
t("[D135 ABORT-2] loadFailureWhy: net::ERR_ABORTED → no document (e.g. 204 No Content) or the page stopped its own load",
  () => /^the browser cancelled the navigation before any page arrived \(net::ERR_ABORTED\) — the URL answered with no document \(e\.g\. 204 No Content\) or the page stopped its own load; point it at the page that renders the screen$/.test(VP.loadFailureWhy("page.goto: net::ERR_ABORTED at http://h/none\nCall log:\n  - navigating")));
t("[D135 ABORT-2] loadFailureWhy: 'Download is starting' → a file download, not a page",
  () => VP.loadFailureWhy("page.goto: Download is starting\nCall log:\n  - navigating") === "the URL started a file download, not a page — point it at the page that renders the screen");
t("[D135 ABORT-2] loadFailureWhy: another cause → its first line, unchanged",
  () => VP.loadFailureWhy("page.goto: net::ERR_CONNECTION_REFUSED at http://h/\nCall log:") === "page.goto: net::ERR_CONNECTION_REFUSED at http://h/");

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

// ---------------------------------------------------------------- group 11: tag-alias (D32), display (F-78), rings (D34), foreign tags (DT-47)
console.log("verify-probe — group 11 (tag-alias, display, rings, foreign tags):");
{
  // read through namespaces, so this block RUNS (and fails cleanly) on a tree without them
  const pmNs: Record<string, unknown> = { ...PM };
  const canon: unknown = pmNs.CANONICAL_MATCHED_BY;
  t("[D30] CANONICAL_MATCHED_BY is the rule order: tag, tag-shared-path, tag-alias, text, text-ordinal, position, frame", () =>
    JSON.stringify(canon) === JSON.stringify(["tag", "tag-shared-path", "tag-alias", "text", "text-ordinal", "position", "frame"]));
  t("[F-78] STYLE_KEYS carries display (measured on every node; not a FIELDS key)", () => STYLE_KEYS.includes("display") && !FIELDS.some((f) => String(f.key) === "display"));

  // D32: the shell built once and tagged with ANOTHER screen's ids
  const sh = spec({ nodeId: "I60:5;8:1", type: "FRAME", aliases: ["I71:9;3:4"] });
  const shellEl = cand({ dt: "I71:9;3:4", tag: "nav" });
  const ma = chooseMatch(sh, pool([sh], { tagged: [shellEl] }), { position: false });
  t("[D32] one visible element tagged with the spec's alias → matchedBy tag-alias, on that element, selector names the alias", () =>
    matched(ma)?.matchedBy === "tag-alias" && matched(ma)?.cand === shellEl && matched(ma)?.selector === '[data-dt-node="I71:9;3:4"]' && matched(ma)?.selectorCount === 1);
  const amb = spec({ nodeId: "I60:5;8:2", type: "FRAME", aliases: ["I71:9;3:5", "I72:1;3:5"] });
  const mAmb = chooseMatch(amb, pool([amb], { tagged: [cand({ dt: "I71:9;3:5" }), cand({ dt: "I72:1;3:5" })] }), { position: false });
  t("[D32] two visible elements carry its aliases → not measured, 'ambiguous', naming both and 'tag it'", () =>
    !isMatch(mAmb) && /^ambiguous: 2 visible elements carry this node's aliases \(I71:9;3:5, I72:1;3:5\)/.test(whyOf(mAmb)) && /data-dt-node="I60:5;8:2"/.test(whyOf(mAmb)));
  const two = spec({ nodeId: "I60:5;8:6", type: "FRAME", aliases: ["I71:9;3:6"] });
  t("[D32] the same alias on two visible elements → ambiguous too", () => /^ambiguous: 2 visible/.test(whyOf(chooseMatch(two, pool([two], { tagged: [cand({ dt: "I71:9;3:6" }), cand({ dt: "I71:9;3:6" })] }), { position: false }))));
  const hiddenOnly = spec({ nodeId: "I60:5;8:7", type: "FRAME", aliases: ["I71:9;3:7"] });
  t("[D32] an alias only on a hidden element → no alias match (falls through to 'tag it')", () =>
    /no data-dt-node and no text; tag it/.test(whyOf(chooseMatch(hiddenOnly, pool([hiddenOnly], { tagged: [cand({ dt: "I71:9;3:7", flags: { box: false, visible: false } })] }), { position: false }))));
  const own = spec({ nodeId: "I60:5;8:3", type: "FRAME", aliases: ["60:9"] });
  t("[D32] an alias that is one of the expectation's own ids is that node's, never this one's", () =>
    !isMatch(chooseMatch(own, pool([own, spec({ nodeId: "60:9", type: "FRAME" })], { tagged: [cand({ dt: "60:9" })] }), { position: false })));
  const both = spec({ nodeId: "I60:5;8:8", type: "FRAME", aliases: ["I71:9;3:8"] });
  const ownEl = cand({ dt: "I60:5;8:8" });
  t("[D32] its own tag wins over an alias (rule 1 before 2b)", () => matched(chooseMatch(both, pool([both], { tagged: [cand({ dt: "I71:9;3:8" }), ownEl] }), { position: false }))?.matchedBy === "tag");
  const sfxSpec = spec({ nodeId: "I60:5;8:9", type: "FRAME", aliases: ["I71:9;3:9"] });
  t("[D32] tag-shared-path comes before tag-alias", () =>
    matched(chooseMatch(sfxSpec, pool([sfxSpec], { tagged: [cand({ dt: "I71:9;3:9" }), cand({ dt: "I80:1;8:9" })] }), { position: false }))?.matchedBy === "tag-shared-path");
  const noAlias = spec({ nodeId: "I60:5;8:10", type: "FRAME" });
  t("[D32] a spec without aliases (an older expectation) is unaffected", () => !isMatch(chooseMatch(noAlias, pool([noAlias], { tagged: [cand({ dt: "I71:9;3:4" })] }), { position: false })));
  const shaped = isMatch(ma) ? shapeNode(sh, ma, { nodeId: sh.nodeId, found: true, styles: {}, unmeasured: {} }, STYLE_KEYS) : null;
  t("[D32] a tag-alias node says which alias it was matched by (note)", () => shaped?.matchedBy === "tag-alias" && /another screen's id .*I71:9;3:4/.test(shaped.note || ""));
  t("[census] tag-alias has its own bucket (tagAlias)", () => {
    const c: Record<string, number> = { ...census([{ matchedBy: "tag" }, { matchedBy: "tag-alias" }, { matchedBy: "tag-alias" }], []) };
    return c.tagAlias === 2 && c.tag === 1 && c.sharedPath === 0;
  });

  // DT-47: foreign tags
  const vpNs: Record<string, unknown> = { ...VP };
  type ForeignFn = (tagged: Candidate[], expectedIds: ReadonlySet<string>, frameIds: ReadonlySet<string>) => { count: number; ids: Array<{ id: string; elements: number }> };
  const isForeignFn = (f: unknown): f is ForeignFn => typeof f === "function";
  const ft = vpNs.foreignTags;
  const tags = [cand({ dt: "I99:9;7:7" }), cand({ dt: "60:2" }), cand({ dt: "60:1" }), cand({ dt: "88:2" }), cand({ dt: "88:2" }), cand({ dt: "88:1", flags: { box: false, visible: false } }), cand({ dt: "88:3", flags: { inClosedDialog: true } }), cand({ dt: "I71:9;3:4" })];
  const fr = isForeignFn(ft) ? ft(tags, new Set(["60:2"]), new Set(["60:1"])) : null;
  t("[DT-47] tagsNotInExpectation: visible tags that are no expected id and no frame id, sorted, with element counts", () =>
    fr !== null && fr.count === 3 && JSON.stringify(fr.ids) === JSON.stringify([{ id: "88:2", elements: 2 }, { id: "I71:9;3:4", elements: 1 }, { id: "I99:9;7:7", elements: 1 }]));
  const many = Array.from({ length: 60 }, (_, i) => cand({ dt: `90:${String(i).padStart(2, "0")}` }));
  const fm = isForeignFn(ft) ? ft(many, new Set(), new Set()) : null;
  t("[DT-47] … count is all of them, ids the first 50", () => fm !== null && fm.count === 60 && fm.ids.length === 50 && fm.ids[0]?.id === "90:00" && fm.ids[49]?.id === "90:49");
  t("[DT-47] a measured file carrying tagsNotInExpectation is a VerifyMeasured; one without ids[] is not", () => { const rt: unknown = JSON.parse(JSON.stringify(measured([], { tagsNotInExpectation: { count: 1, ids: [{ id: "88:2", elements: 2 }] } }))); return isVerifyMeasured(rt) && !isVerifyMeasured({ nodes: [], tagsNotInExpectation: { count: 1 } }); });

  // D34 + F-78: measureElements on computed-style strings exactly as Chromium writes them (facts §7). The page
  // function runs here against a one-element stand-in document (the e2e suite runs it in a real chromium).
  const ppNs: Record<string, unknown> = { ...PP };
  type MeasureFn = (input: { frameRect: { x: number; y: number; w: number; h: number }; keys: readonly string[]; items: Array<{ nodeId: string; path: string; isText: boolean; isPaint: boolean; isPlaceholder: boolean; sharesWith: string | null }> }) => MeasureResult[];
  const isMeasureFn = (f: unknown): f is MeasureFn => typeof f === "function";
  const measureFn = ppNs.measureElements;
  const PAD = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";
  const tw5 = (i: number, ring: string): string => [PAD, PAD, PAD, PAD, PAD].map((p, k) => (k === i ? ring : p)).join(", ");
  const measureCss = (css: Record<string, string>): MeasureResult["styles"] => {
    const computed: Record<string, string> = { "border-top-width": "0px", "border-right-width": "0px", "border-bottom-width": "0px", "border-left-width": "0px",
      "box-shadow": "none", "outline-style": "none", "outline-width": "0px", "outline-offset": "0px", "outline-color": "rgb(0, 0, 0)", display: "block", color: "rgb(0, 0, 0)", ...css };
    const el = { tagName: "DIV", childNodes: [], children: [], getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 40 }) };
    Object.assign(globalThis, { document: { querySelector: () => el }, getComputedStyle: () => ({ getPropertyValue: (prop: string) => computed[prop] ?? "" }), scrollX: 0, scrollY: 0 });
    if (!isMeasureFn(measureFn)) return {};
    const [r] = measureFn({ frameRect: { x: 0, y: 0, w: 800, h: 600 }, keys: ["borderWidth", "borderColor", "display"], items: [{ nodeId: "60:30", path: "div", isText: false, isPaint: false, isPlaceholder: false, sharesWith: null }] });
    return r ? r.styles : {};
  };
  const inset1 = measureCss({ "box-shadow": tw5(3, "rgb(204, 204, 204) 0px 0px 0px 1px inset") });
  t("[D34] Tailwind `ring-1 ring-inset`: five shadows, the ring 4th, transparent padding → borderWidth 1, its colour, strokeFrom box-shadow, inside", () =>
    inset1.borderWidth === 1 && inset1.borderColor === "rgb(204, 204, 204)" && inset1.strokeFrom === "box-shadow" && inset1.strokeAlign === "inside");
  const insetRing = measureCss({ "box-shadow": tw5(1, "rgb(10, 20, 30) 0px 0px 0px 2px inset") });
  t("[D34] `inset-ring-2` (the 2nd shadow) → borderWidth 2, inside — read by content, not by index", () => insetRing.borderWidth === 2 && insetRing.borderColor === "rgb(10, 20, 30)" && insetRing.strokeAlign === "inside");
  const outset1 = measureCss({ "box-shadow": tw5(3, "rgb(204, 204, 204) 0px 0px 0px 1px") });
  t("[D34] plain `ring-1` (no inset) → borderWidth 1, outside", () => outset1.borderWidth === 1 && outset1.strokeFrom === "box-shadow" && outset1.strokeAlign === "outside");
  const twoRings = measureCss({ "box-shadow": tw5(1, "rgb(1, 2, 3) 0px 0px 0px 1px inset").replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px, rgba\(0, 0, 0, 0\) 0px 0px 0px 0px$/, `${PAD}, rgb(9, 9, 9) 0px 0px 0px 3px, ${PAD}`) });
  t("[D34] two rings, one inset → the inset one", () => twoRings.borderWidth === 1 && twoRings.borderColor === "rgb(1, 2, 3)" && twoRings.strokeAlign === "inside");
  const twoOuter = measureCss({ "box-shadow": `rgb(1, 2, 3) 0px 0px 0px 1px, ${PAD}, rgb(9, 9, 9) 0px 0px 0px 3px` });
  t("[D34] two outside rings → none read: borderWidth 0, borderColor null, no strokeFrom", () => twoOuter.borderWidth === 0 && twoOuter.borderColor === null && twoOuter.strokeFrom === undefined);
  const dup = measureCss({ "box-shadow": "rgb(1, 2, 3) 0px 0px 0px 1px inset, rgb(1, 2, 3) 0px 0px 0px 1px inset" });
  t("[D34] the same ring twice counts once", () => dup.borderWidth === 1 && dup.strokeAlign === "inside");
  const drop = measureCss({ "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px" });
  t("[D34] a drop shadow (offset/blur) is no ring", () => drop.borderWidth === 0 && drop.strokeFrom === undefined);
  const pad5 = measureCss({ "box-shadow": [PAD, PAD, PAD, PAD, PAD].join(", ") });
  t("[D34] five transparent paddings → no ring", () => pad5.borderWidth === 0 && pad5.borderColor === null);
  const clearRing = measureCss({ "box-shadow": tw5(3, "rgba(0, 0, 0, 0) 0px 0px 0px 2px inset") });
  t("[D34] a transparent ring with a spread (ring-transparent) draws nothing → no ring", () => clearRing.borderWidth === 0 && clearRing.strokeFrom === undefined);
  const outlineIn = measureCss({ "outline-style": "solid", "outline-width": "1px", "outline-offset": "-1px", "outline-color": "rgb(118, 118, 128)" });
  t("[D34] `outline-1 -outline-offset-1` → borderWidth 1, outline colour, strokeFrom outline, inside", () =>
    outlineIn.borderWidth === 1 && outlineIn.borderColor === "rgb(118, 118, 128)" && outlineIn.strokeFrom === "outline" && outlineIn.strokeAlign === "inside");
  const outlineOut = measureCss({ "outline-style": "solid", "outline-width": "2px", "outline-offset": "0px", "outline-color": "rgb(118, 118, 128)" });
  t("[D34] an outline at offset 0 → outside", () => outlineOut.borderWidth === 2 && outlineOut.strokeAlign === "outside");
  const centred = measureCss({ "outline-style": "solid", "outline-width": "2px", "outline-offset": "-1px", "outline-color": "rgb(118, 118, 128)" });
  t("[D34] a centred outline (offset −w/2) is not read", () => centred.borderWidth === 0 && centred.strokeFrom === undefined);
  const restingFocus = measureCss({ "outline-style": "solid", "outline-width": "2px", "outline-offset": "2px", "outline-color": "rgba(0, 0, 0, 0)" });
  const transparentAt0 = measureCss({ "outline-style": "solid", "outline-width": "2px", "outline-offset": "0px", "outline-color": "rgba(0, 0, 0, 0)" });
  const uaRing = measureCss({ "outline-style": "auto", "outline-width": "1px", "outline-offset": "0px", "outline-color": "rgb(16, 16, 16)" });
  t("[D34] a transparent resting focus outline and the UA's `auto` focus ring are no stroke", () => restingFocus.borderWidth === 0 && transparentAt0.borderWidth === 0 && uaRing.borderWidth === 0 && uaRing.strokeFrom === undefined);
  const border = measureCss({ "border-top-width": "1px", "border-right-width": "1px", "border-bottom-width": "1px", "border-left-width": "1px", "border-top-color": "rgb(5, 5, 5)", "box-shadow": tw5(3, "rgb(204, 204, 204) 0px 0px 0px 3px inset") });
  t("[D34] a real border wins over a ring (the ring is read only when every border side is 0): strokeFrom border, no strokeAlign", () =>
    border.borderWidth === 1 && border.borderColor === "rgb(5, 5, 5)" && border.strokeFrom === "border" && border.strokeAlign === undefined);
  t("[F-78] display is the computed display", () => measureCss({ display: "inline" }).display === "inline" && inset1.display === "block");
  const ringNode = isMatch(ma) ? shapeNode(sh, ma, { nodeId: sh.nodeId, found: true, styles: { ...inset1 }, unmeasured: {} }, STYLE_KEYS) : null;
  t("[D34] shapeNode carries strokeFrom/strokeAlign through to measured.json", () => ringNode?.styles?.strokeFrom === "box-shadow" && ringNode.styles.strokeAlign === "inside");
  const noStroke = isMatch(ma) ? shapeNode(sh, ma, { nodeId: sh.nodeId, found: true, styles: {}, unmeasured: {} }, STYLE_KEYS) : null;
  t("[D34] … and adds neither key (no null to explain) when the page read no stroke", () => noStroke !== null && noStroke.styles !== undefined && !("strokeFrom" in noStroke.styles) && !("strokeAlign" in noStroke.styles));
}

// ---------------------------------------------------------------- group 17: owner hover (F-74), paintedBy / textTransform (F-74, F-69)
console.log("verify-probe — group 17 (owner hover, paintedBy, textTransform):");
{
  type OwnerHoverFn = (spec: VerifySpec, m: { path: string }, byTag: ReadonlyMap<string, Candidate[]>) => { kind: string; id?: string; path?: string; owner?: string; next?: Array<{ id: string; path: string }> };
  const ohRaw: unknown = ({ ...PM } as Record<string, unknown>).ownerHover;
  const isOh = (f: unknown): f is OwnerHoverFn => typeof f === "function";
  const oh = (sp: VerifySpec, mPath: string, tagged: Candidate[]): ReturnType<OwnerHoverFn> | null => {
    if (!isOh(ohRaw)) return null;
    const byTag = new Map<string, Candidate[]>();
    for (const c of tagged) if (c.dt !== null) byTag.set(c.dt, [...(byTag.get(c.dt) || []), c]);
    return ohRaw(sp, { path: mPath }, byTag);
  };
  const row = cand({ dt: "71:3", tag: "tr" }), cell = cand({ dt: "71:5", tag: "td" }), btn = cand({ dt: "71:6", tag: "button" }), table = cand({ dt: "71:2", tag: "table" });
  const hiddenRow = cand({ dt: "71:3", tag: "tr", flags: { visible: false } });
  const inherited = spec({ nodeId: "71:6", type: "INSTANCE", drawnState: "hover", drawnStateFrom: "71:3", ancestorIds: ["71:5", "71:3", "71:2"] });
  t("[F-74] ownerHover: drawnStateFrom names a visible tagged owner → hover it (its path)", () => { const r = oh(inherited, btn.path, [row, cell, btn, table]); return r?.kind === "owner" && r.id === "71:3" && r.path === row.path; });
  t("[F-74] …the owner not rendered → the nearest visible tagged ancestor BELOW it (the cell), never one above it (the table)", () => {
    const r = oh(inherited, btn.path, [hiddenRow, cell, btn, table]), r2 = oh(inherited, btn.path, [hiddenRow, btn, table]);
    return r?.kind === "owner" && r.id === "71:5" && r.path === cell.path && r2?.kind === "untagged" && r2.owner === "71:3";
  });
  t("[F-74] …an own state, or an expectation written before drawnStateFrom → none (hovered as before)", () =>
    oh(spec({ nodeId: "71:3", type: "FRAME", drawnState: "hover", ancestorIds: ["71:2"] }), row.path, [row])?.kind === "none"
    && oh(spec({ nodeId: "71:6", type: "INSTANCE", drawnState: "hover", ancestorIds: ["71:5", "71:3"] }), btn.path, [row, btn])?.kind === "none"
    && oh(spec({ nodeId: "71:3", drawnState: "hover", drawnStateFrom: "71:3" }), row.path, [row])?.kind === "none");
  t("[F-74] …a label written straight into the owner's tagged element (the measured element IS the owner's) → none", () =>
    oh(spec({ nodeId: "71:7", drawnState: "hover", drawnStateFrom: "71:3", ancestorIds: ["71:3"] }), row.path, [row])?.kind === "none");
  // L1 (fix pass 1): the first candidate may have no free point (a same-box <span> around the control) — the rest follow
  t("[L1] ownerHover lists the other visible tagged candidates below the owner in `next` (same order), never the measured element nor one above the owner", () => {
    const wrap = cand({ dt: "71:8", tag: "span" });
    const r = oh(spec({ nodeId: "71:6", type: "INSTANCE", drawnState: "hover", drawnStateFrom: "71:3", ancestorIds: ["71:8", "71:5", "71:3", "71:2"] }), btn.path, [hiddenRow, wrap, cell, btn, table]);
    const r2 = oh(inherited, btn.path, [row, cell, btn, table]);
    return r?.kind === "owner" && r.id === "71:8" && JSON.stringify(r.next) === JSON.stringify([{ id: "71:5", path: cell.path }])
      && r2?.kind === "owner" && r2.id === "71:3" && JSON.stringify(r2.next) === JSON.stringify([{ id: "71:5", path: cell.path }]);
  });
  t("[F-74] …the owner is the frame root (not among ancestorIds) → every tagged ancestor may stand in, nearest first", () => {
    const r = oh(spec({ nodeId: "71:6", drawnState: "hover", drawnStateFrom: "71:1", ancestorIds: ["71:5", "71:2"] }), btn.path, [cell, table, btn]);
    return r?.kind === "owner" && r.id === "71:5";
  });

  const sm = spec({ nodeId: "71:4", type: "FRAME", backgroundColor: "#46464fff" });
  const mm: Match = { nodeId: "71:4", matchedBy: "tag", selector: '[data-dt-node="71:4"]', selectorCount: 1, path: "html > body > td", cand: null };
  const pbv = { backgroundColor: "rgb(70, 70, 79)", via: "ancestor", tag: "tr", depth: 1, dt: "71:3" };
  const shaped = shapeNode(sm, mm, { nodeId: "71:4", found: true, styles: { backgroundColor: "rgba(0, 0, 0, 0)", paintedBy: pbv, textTransform: "capitalize" }, unmeasured: {} }, STYLE_KEYS);
  t("[F-74/F-69] shapeNode carries the page's paintedBy and textTransform into measured styles (optional keys, beside the STYLE_KEYS)", () =>
    JSON.stringify(shaped.styles?.paintedBy) === JSON.stringify(pbv) && shaped.styles?.textTransform === "capitalize" && !STYLE_KEYS.includes("paintedBy") && !STYLE_KEYS.includes("textTransform"));
  const bad = shapeNode(sm, mm, { nodeId: "71:4", found: true, styles: { paintedBy: { backgroundColor: "rgb(1, 2, 3)", via: "sibling", tag: "div", depth: 1 }, textTransform: "" }, unmeasured: {} }, STYLE_KEYS);
  t("[F-74/F-69] …and adds neither when the page read none (a malformed paintedBy, an empty transform) — never a null to explain", () =>
    bad.styles !== undefined && !("paintedBy" in bad.styles) && !("textTransform" in bad.styles) && !("paintedBy" in (bad.unmeasured || {})));
}

fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- group 12a: which rows the probe drives, its time budget, what it calls an outcome, when it says ok (probe-drive.ts)
block("[12a] probe-drive:", () => {
  const { drivable, driveBudget, classifyOutcome, judge } = PD;
  const ia = (nodeId: string, extra: Partial<VerifyInteraction>): VerifyInteraction => ({ nodeId, name: nodeId, trigger: "on_click", ...extra });
  const exp: Pick<VerifyExpectation, "interactions" | "hidden"> = {
    hidden: { roots: [], ids: ["9:9"] },
    interactions: [
      ia("1:1", { action: "overlay", destinationId: "5:1", destinationExported: false }),
      ia("1:2", { action: "overlay", destinationId: "5:2" }),
      ia("1:3", { action: "swap", trigger: "on_press", destinationId: "5:3" }),
      ia("1:4", { action: "navigate", destinationId: "5:4" }),
      ia("1:5", { action: "overlay", trigger: "on_hover", destinationId: "5:5" }),
      ia("9:9", { action: "overlay", destinationId: "5:6" }),
      ia("1:6", { action: "overlay", expect: "dialog", source: "plan", destinationId: "5:7" }),
      ia("1:7", { action: "other", expect: "selector:.x", source: "plan" }),
      ia("1:2", { action: "overlay", destinationId: "5:8" }),
      ia("1:8", { action: "change_to", destinationId: "5:9" }),
      ia("1:9", { action: "overlay", expect: "dialog", source: "plan", trigger: "on_hover", destinationId: "5:7" }),
      ia("1:10", { action: "overlay", expect: "dialog", source: "plan", trigger: "on_key_down", destinationId: "5:7" }),
      ia("1:11", { action: "overlay", expect: "dialog", source: "plan", trigger: "on_press", destinationId: "5:7" }),
    ],
  };
  const ids = drivable ? drivable(exp).map((r) => r.nodeId) : [];
  t("[D40(1)] drivable(): overlay/swap on click/press + plan dialog rows; not navigate, hover, change_to, plan selector:, a hidden layer; one per nodeId|trigger; designed destinations first",
    () => ids.includes("1:2") && ids.includes("1:3") && ids.includes("1:6") && ids.indexOf("1:1") === ids.length - 1 && !["1:4", "1:5", "9:9", "1:7", "1:8"].some((x) => ids.includes(x)) && ids.filter((x) => x === "1:2").length === 1);
  t("[L2] drivable(): a plan dialog row is driven only with an on_click/on_press trigger (not on_hover, not a key)",
    () => JSON.stringify(ids) === JSON.stringify(["1:2", "1:3", "1:6", "1:11", "1:1"]));
  t("[D41] driveBudget(): min(60 s, --max-time left − 15 s), never below 0", () => !!driveBudget
    && driveBudget(0, 180_000) === 60_000 && driveBudget(130_000, 180_000) === 35_000 && driveBudget(0, 16_000) === 1_000 && driveBudget(10_000, 16_000) === 0);
  const opened = { selector: "html > body > dialog", modal: true, position: "fixed", rect: { x: 0, y: 0, w: 10, h: 10 }, scrollY: 0 };
  t("[F-70] classifyOutcome(overlay): a contract match → dialog-opened (its selector); only the destination tag → selector-appeared via destination-tag; nothing → none", () => !!classifyOutcome
    && classifyOutcome("overlay", { detectedBy: ":modal", dest: { count: 1, inside: true, newly: true }, opened }).outcome === "dialog-opened"
    && classifyOutcome("overlay", { detectedBy: ":modal", dest: null, opened }).detectedBy === ":modal"
    && classifyOutcome("overlay", { detectedBy: null, dest: { count: 1, inside: true, newly: true }, opened }).detectedBy === "destination-tag"
    && classifyOutcome("overlay", { detectedBy: null, dest: { count: 0, inside: false, newly: false }, opened: null }).outcome === "none");
  t("[F-70] classifyOutcome(swap): the destination tag appearing → selector-appeared; a dialog without it is reported as what it is (dialog-opened, which a swap does not allow)", () => !!classifyOutcome
    && classifyOutcome("swap", { detectedBy: ":modal", dest: { count: 1, inside: true, newly: true }, opened }).outcome === "selector-appeared"
    && classifyOutcome("swap", { detectedBy: ":modal", dest: { count: 0, inside: false, newly: false }, opened }).outcome === "dialog-opened"
    && classifyOutcome("swap", { detectedBy: null, dest: { count: 0, inside: false, newly: false }, opened: null }).outcome === "none");
  const good = { selectorCount: 1, outcome: "dialog-opened", navEvents: 0, destination: { nodeId: "5:2", inside: true, count: 1 }, activation: "mouse" as const };
  t("[D41] judge(): ok:true only with one opener, an allowed outcome, no load, the destination inside, a mouse click", () => !!judge && judge("overlay", good).ok === true);
  t("[D41] judge(): the destination tag NOT inside what opened → ok:null naming it (never false)", () => !!judge
    && judge("overlay", { ...good, destination: { nodeId: "5:2", inside: false, count: 1 } }).ok === null
    && /not inside the opened element/.test(judge("overlay", { ...good, destination: { nodeId: "5:2", inside: false, count: 1 } }).missing.join(";"))
    && /tag the dialog's root/.test(judge("overlay", { ...good, destination: { nodeId: "5:2", inside: false, count: 0 } }).missing.join(";")));
  t("[D24/F-70] judge(): a synthetic click, a load, 2 openers, a swap's dialog-opened, no destination id → each ok:null", () => !!judge
    && judge("overlay", { ...good, activation: "synthetic" }).ok === null && judge("overlay", { ...good, navEvents: 1 }).ok === null
    && judge("overlay", { ...good, selectorCount: 2 }).ok === null && judge("swap", good).ok === null
    && judge("overlay", { selectorCount: 1, outcome: "dialog-opened", navEvents: 0, activation: "mouse" }).ok === null);
  const away = (VP as Partial<typeof VP>).isNavigationAway;
  t("[H-a] isNavigationAway(): another path or query is a navigation; the same URL (a fragment aside) is a reload", () => !!away
    && away("http://h/a?s=beds", "http://h/a") && away("http://h/b", "http://h/a#x")
    && !away("http://h/a", "http://h/a") && !away("http://h/a#y", "http://h/a#x") && !away("http://h/pushed", "http://h/pushed"));
  // fix 4 LOW a: a partial hash (bodies left out) is recorded, so verify-screen never calls it the same build
  const served = new Map([["/assets/app.js", "a".repeat(64)]]);
  t("[fix4 LOW a] buildFrom(): unhashed bodies recorded as build.unhashed (none → no field)", () => {
    const partial: { unhashed?: unknown } = VP.buildFrom("http://h/", served, false, 2), whole: { unhashed?: unknown } = VP.buildFrom("http://h/", served, false);
    return partial.unhashed === 2 && !("unhashed" in whole);
  });
  // fix 5 LOW 6: which links are followed in the main frame (the page function, against stand-ins)
  const vpNs: Record<string, unknown> = { ...VP };
  type LinkFn = (el: { closest(sel: string): { href?: unknown; target?: unknown; hasAttribute(n: string): boolean } | null; ownerDocument: { querySelector(sel: string): { getAttribute(n: string): string | null } | null } }) => string | null;
  const isLinkFn = (f: unknown): f is LinkFn => typeof f === "function";
  const lh = vpNs.linkHref;
  const link = (target: string, opts: { base?: string; download?: boolean } = {}): string | null => !isLinkFn(lh) ? "no linkHref" : lh({
    closest: () => ({ href: "http://h/a?tab=beds", target, hasAttribute: (n: string) => n === "download" && opts.download === true }),
    ownerDocument: { querySelector: () => (opts.base !== undefined ? { getAttribute: () => opts.base ?? null } : null) },
  });
  t("[fix5 LOW 6] linkHref(): _self/_top/_parent/none are the main frame; _blank, a <base target=_blank>, a download are not", () => isLinkFn(lh)
    && link("") === "http://h/a?tab=beds" && link("_top") === "http://h/a?tab=beds" && link("_parent") === "http://h/a?tab=beds" && link("_self") === "http://h/a?tab=beds"
    && link("_blank") === null && link("", { base: "_blank" }) === null && link("_self", { base: "_blank" }) === "http://h/a?tab=beds" && link("", { download: true }) === null);
  // fix 5 LOW 8: the submit guard clips the first quad to the layout viewport WITHOUT the scrollbar (documentElement.clientWidth)
  t("[fix5 LOW 8] submitGuard(): a wide wrapper's click point is the middle of its part inside clientWidth (1009), not innerWidth (1024)", () => {
    const sg = PD.submitGuard;
    if (!sg) return false;
    const rect = { x: 0, y: 0, width: 2000, height: 20, right: 2000, bottom: 20 };
    const btn = { tagName: "BUTTON", form: {}, getAttribute: () => null, hasAttribute: () => false, closest: (): unknown => btn };
    const el = { tagName: "SPAN", getAttribute: () => null, hasAttribute: () => false, closest: () => null, getBoundingClientRect: () => rect, getClientRects: () => [rect],
      contains: (o: unknown) => o === btn, querySelectorAll: () => [] };
    Object.assign(globalThis, { innerWidth: 1024, innerHeight: 700, document: { documentElement: { clientWidth: 1009, clientHeight: 700 }, elementFromPoint: (x: number) => (x < 508 ? btn : el) } });
    const r: unknown = Reflect.apply(sg, undefined, [el]);
    return typeof r === "string" && /at its click point/.test(r);
  });
  // fix 6 MED 3: in quirks mode documentElement.clientHeight is the PAGE's height (3016), not the viewport's (640)
  t("[fix6 MED 3] submitGuard() in quirks mode: a 2000-px wrapper's click point is the middle of its part in the 640-px window (a button there), not of 0..2000", () => {
    const sg = PD.submitGuard;
    if (!sg) return false;
    const rect = { x: 0, y: 0, width: 1024, height: 2000, right: 1024, bottom: 2000 };
    const btn = { tagName: "BUTTON", form: {}, getAttribute: () => null, hasAttribute: () => false, closest: (): unknown => btn };
    const el = { tagName: "DIV", getAttribute: () => null, hasAttribute: () => false, closest: () => null, getBoundingClientRect: () => rect, getClientRects: () => [rect],
      contains: (o: unknown) => o === btn, querySelectorAll: () => [] };
    Object.assign(globalThis, { innerWidth: 1024, innerHeight: 640, document: { compatMode: "BackCompat", documentElement: { clientWidth: 1024, clientHeight: 3016 }, elementFromPoint: (_x: number, y: number) => (y > 300 && y < 340 ? btn : el) } });
    const r: unknown = Reflect.apply(sg, undefined, [el]);
    return typeof r === "string" && /at its click point/.test(r);
  });
  // 12b review 3 L-2: the drive's click point on another ACTIVATING control inside the opener → described (not driven); the
  // container's only button there (D47), a text field there, or the opener's own label → null
  t("[L-2] clickPointControl(): a card's centred Delete with a 2nd control → '<button aria-label=\"Delete\">'; a cell's only button / a readonly field / a label at the centre → null", () => {
    const cp = PD.clickPointControl;
    if (!cp) return false;
    interface CpEl { tagName: string; parentElement: CpEl | null; children: CpEl[]; childNodes: CpEl[]; nodeType: number; nodeValue: null; checkVisibility(): boolean; getAttribute(n: string): string | null; hasAttribute(n: string): boolean; matches(sel: string): boolean;
      getBoundingClientRect(): { x: number; y: number; width: number; height: number; right: number; bottom: number }; getClientRects(): Array<ReturnType<CpEl["getBoundingClientRect"]>>;
      closest(sel: string): CpEl | null; contains(q: unknown): boolean; querySelectorAll(sel: string): CpEl[] }
    const mkEl = (tag: string, o: { focusable?: boolean; buttonLike?: boolean; label?: string; x: number; w: number }, kids: CpEl[] = []): CpEl => {
      const rect = { x: o.x, y: 0, width: o.w, height: 20, right: o.x + o.w, bottom: 20 };
      const el: CpEl = { tagName: tag.toUpperCase(), parentElement: null, children: kids, childNodes: kids, nodeType: 1, nodeValue: null, checkVisibility: () => true,
        getAttribute: (n) => (n === "aria-label" ? o.label ?? null : null), hasAttribute: () => false,
        matches: (sel) => (/^a\[href\], area\[href\], button/.test(sel) ? o.focusable === true : /^button, a\[href\], summary/.test(sel) ? o.buttonLike === true : false),
        getBoundingClientRect: () => rect, getClientRects: () => [rect],
        closest: (sel) => { for (let p: CpEl | null = el; p; p = p.parentElement) if (p.matches(sel)) return p; return null; },
        contains: (q) => q === el || kids.some((k) => k.contains(q)), querySelectorAll: (sel) => kids.filter((k) => k.matches(sel)) };
      for (const k of kids) k.parentElement = el;
      return el;
    };
    const at = (root: CpEl, hit: CpEl): unknown => {
      // D56: ownContent reads window.__dtTipPre (none here: no tooltip is exempt)
      Object.assign(globalThis, { innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0, window: {}, getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop.startsWith("overflow") ? "visible" : "") }),
        document: { documentElement: fakeDe(root), elementFromPoint: () => hit, createRange: () => ({ selectNodeContents: () => undefined, getClientRects: () => [] }) } });
      return Reflect.apply(cp, undefined, [root]);
    };
    const del = mkEl("button", { focusable: true, buttonLike: true, label: "Delete", x: 90, w: 20 }), more = mkEl("button", { focusable: true, buttonLike: true, x: 170, w: 20 });
    const card = mkEl("div", { x: 0, w: 200 }, [del, more]);
    const icon = mkEl("button", { focusable: true, buttonLike: true, x: 90, w: 20 }), cell = mkEl("td", { x: 0, w: 200 }, [icon]);
    const field = mkEl("input", { focusable: true, x: 0, w: 200 }), picker = mkEl("span", { x: 0, w: 200 }, [field]);
    const text = mkEl("span", { x: 80, w: 40 }), labelled = mkEl("div", { x: 0, w: 200 }, [text, mkEl("button", { focusable: true, buttonLike: true, x: 0, w: 20 })]);
    // review 4 H-1: a FOCUSABLE card (role=button tabindex=0, or an <a href> card) is not exempt: its centred Delete is refused,
    // also when it is the card's only inner control
    const del2 = mkEl("button", { focusable: true, buttonLike: true, label: "Delete", x: 90, w: 20 }), more2 = mkEl("button", { focusable: true, buttonLike: true, x: 170, w: 20 });
    const focCard = mkEl("div", { focusable: true, buttonLike: true, x: 0, w: 200 }, [del2, more2]);
    const del3 = mkEl("button", { focusable: true, buttonLike: true, label: "Delete", x: 90, w: 20 }), linkCard = mkEl("a", { focusable: true, buttonLike: true, x: 0, w: 200 }, [del3]);
    return at(card, del) === "<button aria-label=\"Delete\">" && at(cell, icon) === null && at(picker, field) === null && at(labelled, text) === null
      && at(focCard, del2) === "<button aria-label=\"Delete\">" && at(linkCard, del3) === "<button aria-label=\"Delete\">" && at(focCard, focCard) === null;
  });
  // review 5 H-1: what the mouse presses at the click point — a <label> (its control), a role=button without tabindex, a button
  // inside an open shadow root (also when the point is text slotted into it), an <iframe> — refused, naming that control; a label
  // without a control never stops the walk; a cell's own sole button (D47/D51) is still the opener's
  t("[review 5 H-1] clickPointControl(): label for= / a wrapping label → its checkbox; span role=button (no tabindex); a shadow-DOM button (hit through shadowRoot.elementFromPoint, or slotted text → its slot's button); an iframe → refused naming it; review 6 H-2: a tabindex=-1 glyph inside a Delete button / a contenteditable label inside a role=button (on and off screen) → the Delete; an <object> / <embed> → refused naming it; a cell's sole centred button → null", () => {
    const cp = PD.clickPointControl;
    if (!cp) return false;
    interface Rect { x: number; y: number; width: number; height: number; right: number; bottom: number }
    interface Txt { nodeType: number; nodeValue: string; assignedSlot: H1 | null; rects: Rect[] }
    interface H1 { tagName: string; nodeType: number; nodeValue: null; parentElement: H1 | null; children: H1[]; childNodes: Array<H1 | Txt>; host: H1 | null; assignedSlot: H1 | null;
      control?: H1 | null; shadowRoot: { children: H1[]; childNodes: Array<H1 | Txt>; elementFromPoint(x: number, y: number): H1 | null } | null; rect: Rect; attrs: Record<string, string>;
      foc: boolean; btn: boolean; act: boolean; getRootNode(): { host?: H1 }; matches(sel: string): boolean; getAttribute(n: string): string | null; hasAttribute(n: string): boolean;
      getBoundingClientRect(): Rect; getClientRects(): Rect[]; checkVisibility(): boolean; querySelectorAll(sel: string): H1[]; contains(q: unknown): boolean; closest(sel: string): H1 | null }
    const box = (x: number, w: number): Rect => ({ x, y: 0, width: w, height: 20, right: x + w, bottom: 20 });
    const desc = (e: H1): H1[] => e.children.flatMap((c) => [c, ...desc(c)]);
    const mk = (tag: string, o: { x: number; w: number; foc?: boolean; btn?: boolean; act?: boolean; attrs?: Record<string, string> }, ...nodes: Array<H1 | Txt>): H1 => {
      const kids = nodes.filter((n): n is H1 => n.nodeType === 1);
      const el: H1 = { tagName: tag.toUpperCase(), nodeType: 1, nodeValue: null, parentElement: null, children: kids, childNodes: nodes, host: null, assignedSlot: null, shadowRoot: null,
        rect: box(o.x, o.w), attrs: o.attrs ?? {}, foc: o.foc === true, btn: o.btn === true, act: o.act === true || o.btn === true,
        getRootNode: () => (el.host ? { host: el.host } : {}),
        // FOC / ACT (it lists role=checkbox) / BTN, told apart by their text
        matches: (sel) => (/^a\[href\], area\[href\], button/.test(sel) ? el.foc : /role=checkbox/.test(sel) ? el.act : /^button, a\[href\], summary/.test(sel) ? el.btn : false),
        getAttribute: (n) => el.attrs[n] ?? null, hasAttribute: (n) => n in el.attrs, getBoundingClientRect: () => el.rect, getClientRects: () => [el.rect], checkVisibility: () => true,
        querySelectorAll: (sel) => desc(el).filter((c) => c.matches(sel)), contains: (q) => q === el || desc(el).some((d) => d === q),
        closest: (sel) => { for (let p: H1 | null = el; p; p = p.parentElement) if (p.matches(sel)) return p; return null; } };
      for (const k of kids) k.parentElement = el;
      return el;
    };
    const txt = (v: string, r: Rect): Txt => ({ nodeType: 3, nodeValue: v, assignedSlot: null, rects: [r] });
    const shadow = (host: H1, inner: H1[], hit: (() => H1 | null)): void => {
      for (const i of inner) i.host = host;
      host.shadowRoot = { children: inner, childNodes: inner, elementFromPoint: hit };
    };
    const run = (root: H1, hit: H1): unknown => {
      let sel: Txt | null = null;
      // D56: ownContent reads window.__dtTipPre (none here: no tooltip is exempt)
      Object.assign(globalThis, { innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0, window: {}, getComputedStyle: () => ({ getPropertyValue: (prop: string) => (prop.startsWith("overflow") ? "visible" : "") }),
        document: { documentElement: fakeDe(root), elementFromPoint: () => hit,
          createRange: () => ({ selectNodeContents: (n: Txt) => { sel = n; }, getClientRects: () => (sel ? sel.rects : []) }) } });
      try { return Reflect.apply(cp, undefined, [root]); } catch (e) { return `throws ${String(e)}`; }
    };
    const results: Array<[string, unknown, unknown]> = [];
    { // <label for> a checkbox at the card's left; the label fills the centre
      const pk = mk("input", { x: 4, w: 16, foc: true, act: true, attrs: { type: "checkbox", "aria-label": "Packed" } });
      const lab = mk("label", { x: 30, w: 180 }, txt("Packed", box(90, 40)));
      lab.control = pk;
      results.push(["label for=", run(mk("div", { x: 0, w: 240 }, pk, lab), lab), "<input type=\"checkbox\" aria-label=\"Packed\">"]);
    }
    { // a label wrapping its checkbox (a todo row); the point is the label's text
      const pk = mk("input", { x: 90, w: 16, foc: true, act: true, attrs: { type: "checkbox", "aria-label": "Done" } });
      const lab = mk("label", { x: 80, w: 80 }, pk, txt(" Done", box(110, 40)));
      lab.control = pk;
      results.push(["wrapping label", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 10 }), lab), lab), "<input type=\"checkbox\" aria-label=\"Done\">"]);
    }
    { // a span role=button without tabindex: activating, not focusable
      const del = mk("span", { x: 100, w: 40, btn: true, attrs: { role: "button", "aria-label": "Delete crate" } });
      results.push(["role=button, no tabindex", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), del), del), "<span role=\"button\" aria-label=\"Delete crate\">"]);
    }
    { // a web component's shadow <button>: the document hit is the host, its shadow root's hit the button
      const host = mk("x-del", { x: 100, w: 40 });
      const b = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Delete" } });
      shadow(host, [b], () => b);
      results.push(["shadow button", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), host), host), "<button aria-label=\"Delete\">"]);
    }
    { // text slotted into a shadow <button><slot>: both hits are the host — the text's slot leads to the button
      const label = txt("Delete", box(105, 30));
      const host = mk("x-btn", { x: 100, w: 40 }, label);
      const slot = mk("slot", { x: 100, w: 40 });
      const b = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Remove" } }, slot);
      shadow(host, [b], () => host);
      label.assignedSlot = slot;
      results.push(["slotted text", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), host), host), "<button aria-label=\"Remove\">"]);
    }
    { // an iframe at the centre: what is inside cannot be seen — a control
      const f = mk("iframe", { x: 60, w: 120, foc: true });
      results.push(["iframe", run(mk("div", { x: 0, w: 240 }, f), f), "<iframe>"]);
    }
    { // a label with no control inside a card's Delete (2nd control beside it) never stops the walk at the label
      const lab = mk("label", { x: 105, w: 30 }, txt("x", box(105, 10)));
      lab.control = null;
      const del = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Delete" } }, lab);
      results.push(["label without control", run(mk("div", { x: 0, w: 240 }, del, mk("button", { x: 200, w: 30, foc: true, btn: true })), lab), "<button aria-label=\"Delete\">"]);
    }
    // review 6 H-2: an activating control anywhere on the path wins over a merely focusable element below it (a tabindex=-1
    // glyph, a contenteditable label); <object> / <embed> are nested browsing contexts; the off-screen branch the same
    { // a <button> Delete whose glyph is a tabindex=-1 span; the point is the glyph
      const glyph = mk("span", { x: 105, w: 30, foc: true, attrs: { tabindex: "-1" } });
      const del = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Delete" } }, glyph);
      results.push(["tabindex=-1 glyph in a button", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), del), glyph), "<button aria-label=\"Delete\">"]);
    }
    { // a span role=button Delete (activating, not focusable) around a contenteditable label (focusable, not activating)
      const label = mk("span", { x: 105, w: 30, foc: true, attrs: { contenteditable: "true" } });
      const del = mk("span", { x: 100, w: 40, btn: true, attrs: { role: "button", "aria-label": "Delete crate" } }, label);
      results.push(["contenteditable label in a role=button", run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), del), label), "<span role=\"button\" aria-label=\"Delete crate\">"]);
    }
    for (const tag of ["object", "embed"]) { // a same-origin page in an <object> / <embed> at the centre
      const f = mk(tag, { x: 60, w: 120, attrs: { type: "text/html" } });
      results.push([`<${tag}>`, run(mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 50 }, txt("Move crate", box(0, 50))), f), f), `<${tag} type="text/html">`]);
    }
    { // off screen (the opener below the fold): the innermost activating control holding the point, not the glyph inside it
      const glyph = mk("span", { x: 105, w: 30, foc: true, attrs: { tabindex: "-1" } });
      const del = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Delete" } }, glyph);
      const card = mk("div", { x: 0, w: 240 }, mk("span", { x: 0, w: 60 }, txt("Move crate", box(0, 60))), del);
      const lower = (e: H1): void => { e.rect = { ...e.rect, y: 2000, bottom: 2020 }; for (const c of e.children) lower(c); };
      lower(card);
      results.push(["off screen: tabindex=-1 glyph in a button", run(card, card), "<button aria-label=\"Delete\">"]);
    }
    { // D47/D51: a cell's sole centred icon button, nothing of its own beside it → the opener's own control
      const b = mk("button", { x: 100, w: 40, foc: true, btn: true, attrs: { "aria-label": "Move crate" } });
      results.push(["D47 cell", run(mk("td", { x: 0, w: 240 }, b), b), null]);
    }
    const bad = results.filter(([, got, want]) => got !== want);
    for (const [name, got, want] of bad) console.log(`    [review 5 H-1 / review 6 H-2] ${name}: got ${String(got)}, want ${String(want)}`);
    return bad.length === 0;
  });
  t("[F-70] the dialog contract, in detection order", () => JSON.stringify(PD.DIALOG_CONTRACT) === JSON.stringify([":modal", "dialog[open]", "[role=dialog]", "[role=alertdialog]", "[aria-modal=\"true\"]", ":popover-open"]));
});

// ---- group 12b: the behaviour checks' pure helpers (probe-behaviour.ts) — the browser half is test/verify-probe-behaviour-e2e.test.ts
block("12b behaviour helpers", () => {
  t("[12b] behaviourBudget: min(90 s, deadline − now − 20 s), never < 0", () => {
    const bb = PB.behaviourBudget;
    return !!bb && bb(0, 180_000) === 90_000 && bb(0, 50_000) === 30_000 && bb(0, 15_000) === 0 && bb(1000, 1000) === 0;
  });
  t("[L8] the shipped probe-behaviour.ts cites no private working path", () => !/design-twin-g12-work|~\/design-twin/.test(fs.readFileSync(path.join(import.meta.dirname, "..", "design-to-code", "probe-behaviour.ts"), "utf8")));
  // H-1 / D47 / L-3 on a fake DOM: markOpener computes the opener's CONTROL once (window.__dtBeh.control) and keyTarget /
  // focusOpener / walkStep use it — a button INSIDE a card opener is never it; the opener button itself, the button around a
  // tagged label, and a cell's ONLY button-like focusable under its centre are; a 2nd focusable, or the centre elsewhere, is not
  interface FakeEl { tagName: string; parentElement: FakeEl | null; isConnected: boolean; isContentEditable: boolean; children: FakeEl[]; childNodes: FakeEl[]; nodeType: number; nodeValue: null; focusable: boolean; buttonLike: boolean;
    rect: { x: number; y: number; width: number; height: number; right: number; bottom: number }; dt: string | null;
    getAttribute(n: string): string | null; hasAttribute(n: string): boolean; matches(sel: string): boolean; contains(o: FakeEl): boolean; querySelectorAll(sel: string): FakeEl[];
    closest(sel: string): FakeEl | null; getBoundingClientRect(): FakeEl["rect"]; getClientRects(): Array<FakeEl["rect"]>; checkVisibility(): boolean; focus(): void }
  const fakeDom = (): { mk(tag: string, o: { focusable?: boolean; buttonLike?: boolean; dt?: string; x?: number; y?: number; w?: number; h?: number }, ...kids: FakeEl[]): FakeEl; install(root: FakeEl, active?: FakeEl | null): void } => {
    const FOC = /^a\[href\], area\[href\], button/, BTN = /^button, a\[href\], summary/;
    const desc = (e: FakeEl): FakeEl[] => e.children.flatMap((c) => [c, ...desc(c)]);
    let all: FakeEl[] = [];
    return {
      mk: (tag, o, ...kids) => {
        const x = o.x ?? 0, y = o.y ?? 0, w = o.w ?? 10, h = o.h ?? 10;
        const el: FakeEl = { tagName: tag.toUpperCase(), parentElement: null, isConnected: true, isContentEditable: false, children: kids, childNodes: kids, nodeType: 1, nodeValue: null, focusable: o.focusable === true, buttonLike: o.buttonLike === true,
          rect: { x, y, width: w, height: h, right: x + w, bottom: y + h }, dt: o.dt ?? null,
          getAttribute: (n) => (n === "data-dt-node" ? el.dt : null), hasAttribute: () => false,
          matches: (sel) => (FOC.test(sel) ? el.focusable : BTN.test(sel) ? el.buttonLike : /^input, select, textarea/.test(sel) ? /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) : false),
          contains: (q) => q === el || desc(el).includes(q), querySelectorAll: (sel) => desc(el).filter((c) => c.matches(sel)),
          closest: (sel) => { for (let p: FakeEl | null = el; p; p = p.parentElement) if (p.matches(sel)) return p; return null; },
          getBoundingClientRect: () => el.rect, getClientRects: () => [el.rect], checkVisibility: () => true, focus: () => undefined };
        for (const k of kids) k.parentElement = el;
        return el;
      },
      install: (root, active = null) => {
        all = [root, ...desc(root)];
        const hitAt = (px: number, py: number): FakeEl | null => all.filter((e) => px >= e.rect.x && px < e.rect.right && py >= e.rect.y && py < e.rect.bottom).at(-1) ?? null;
        Object.assign(globalThis, { innerWidth: 1000, innerHeight: 700, window: { __dtBeh: undefined }, document: { activeElement: active, body: root, documentElement: fakeDe(root),
          querySelectorAll: (sel: string) => { const m = /^\[data-dt-node="(.*)"\]$/.exec(sel); return m ? all.filter((e) => e.dt === m[1]) : []; }, elementFromPoint: hitAt } });
      },
    };
  };
  const ctlOf = (d: ReturnType<typeof fakeDom>, root: FakeEl, id: string): unknown => {
    d.install(root);
    if (!PB.markOpener) return "no markOpener";
    Reflect.apply(PB.markOpener, undefined, [{ id }]);
    const w: unknown = Reflect.get(globalThis, "window");
    const st: unknown = typeof w === "object" && w !== null ? Reflect.get(w, "__dtBeh") : undefined;
    return typeof st === "object" && st !== null ? Reflect.get(st, "control") : undefined;
  };
  t("[L-3/D47] markOpener(): the opener's control, computed once — the focusable opener itself; the button around a tagged label; a cell's ONLY button under its centre (also off screen: by its box); never a card's off-centre Delete, never one of two focusables", () => {
    const d = fakeDom();
    const own = d.mk("button", { focusable: true, buttonLike: true, dt: "1:1", w: 80, h: 30 });
    const label = d.mk("span", { dt: "1:2", x: 5, y: 5, w: 40, h: 20 }), btn = d.mk("button", { focusable: true, buttonLike: true, w: 60, h: 30 }, label);
    const icon = d.mk("button", { focusable: true, buttonLike: true, x: 70, y: 10, w: 20, h: 20 }), cell = d.mk("td", { dt: "1:3", w: 160, h: 40 }, icon);
    const del = d.mk("button", { focusable: true, buttonLike: true, x: 2, y: 2, w: 20, h: 20 }), card = d.mk("div", { dt: "1:4", w: 200, h: 24 }, del);
    const sort = d.mk("button", { focusable: true, buttonLike: true, x: 70, y: 10, w: 20, h: 20 }), clear = d.mk("button", { focusable: true, buttonLike: true, x: 130, y: 10, w: 20, h: 20 });
    const two = d.mk("td", { dt: "1:5", w: 160, h: 40 }, sort, clear);
    const iconLow = d.mk("button", { focusable: true, buttonLike: true, x: 70, y: 910, w: 20, h: 20 }), cellLow = d.mk("td", { dt: "1:6", y: 900, w: 160, h: 40 }, iconLow);
    return ctlOf(d, own, "1:1") === own && ctlOf(d, btn, "1:2") === btn && ctlOf(d, cell, "1:3") === icon && ctlOf(d, card, "1:4") === null && ctlOf(d, two, "1:5") === null && ctlOf(d, cellLow, "1:6") === iconLow;
  });
  t("[H-1/L-3] keyTarget(): focus on markOpener's control → ok; a control inside a container opener that is not its control → not ok 'the opener is a container …'; a control that left the document → not ok", () => {
    const kt = PB.keyTarget, mo = PB.markOpener;
    if (!kt || !mo) return false;
    const d = fakeDom();
    const del = d.mk("button", { focusable: true, buttonLike: true, x: 2, y: 2, w: 20, h: 20 }), card = d.mk("div", { dt: "2:1", w: 200, h: 24 }, del);
    const icon = d.mk("button", { focusable: true, buttonLike: true, x: 70, y: 10, w: 20, h: 20 }), cell = d.mk("td", { dt: "2:2", w: 160, h: 40 }, icon);
    const press = (root: FakeEl, id: string, active: FakeEl): { ok: boolean; why: string } => {
      d.install(root, active);
      Reflect.apply(mo, undefined, [{ id }]);
      return Reflect.apply(kt, undefined, [null]);
    };
    const a = press(card, "2:1", del), b = press(cell, "2:2", icon);
    d.install(cell, icon); Reflect.apply(mo, undefined, [{ id: "2:2" }]); icon.isConnected = false;
    const c: { ok: boolean } = Reflect.apply(kt, undefined, [null]);
    return !a.ok && /the opener is a container/.test(a.why) && b.ok && !c.ok;
  });
  // D51 (owner, 2026-10-05): a container's sole centred button-like control is the opener's own ONLY when the container shows
  // nothing of its own outside it — the keyboard battery (markOpener's control) and the 12a drive (clickPointControl) run the
  // same inline check; both on the SAME fake DOMs (text nodes with Range rects, overflow clipping, visibility, media)
  interface D51Node { nodeType: number; nodeValue: string | null; rects: Array<{ x: number; y: number; width: number; height: number; right: number; bottom: number }> }
  // review 5: computed style per element (`css`) and per pseudo-element (`before`), an open shadow root (`shadow`; its top
  // elements' root host is `host`) — display:contents has no box (checkVisibility false), as in Chromium
  interface D51El { tagName: string; parentElement: D51El | null; isConnected: boolean; isContentEditable: boolean; children: D51El[]; childNodes: Array<D51El | D51Node>; nodeType: number; nodeValue: null;
    rect: D51Node["rects"][number]; dt: string | null; label: string | null; attrs: Record<string, string>; focusable: boolean; buttonLike: boolean; hidden: boolean; overflow: string; scrollTop?: number;
    css: Record<string, string>; before: Record<string, string>; ps: Record<string, Record<string, string>>; host: D51El | null; shadowRoot: { children: D51El[]; childNodes: Array<D51El | D51Node> } | null; getRootNode(): { host?: D51El };
    getAttribute(n: string): string | null; hasAttribute(n: string): boolean; matches(sel: string): boolean; contains(o: unknown): boolean; querySelectorAll(sel: string): D51El[];
    closest(sel: string): D51El | null; getBoundingClientRect(): D51El["rect"]; getClientRects(): Array<D51El["rect"]>; checkVisibility(): boolean; focus(): void }
  const d51 = (() => {
    const box = (x: number, y: number, w: number, h: number): D51El["rect"] => ({ x, y, width: w, height: h, right: x + w, bottom: y + h });
    const MEDIA = new Set(["IMG", "SVG", "CANVAS", "VIDEO", "PICTURE", "OBJECT", "EMBED", "IFRAME", "INPUT"]);
    // pre-order, with an explicit stack (review 6 L-1 builds a 20000-deep tree)
    const desc = (e: D51El): D51El[] => { const out: D51El[] = [], todo = [...e.children].reverse(); for (let c = todo.pop(); c; c = todo.pop()) { out.push(c); for (let i = c.children.length - 1; i >= 0; i--) { const k = c.children[i]; if (k) todo.push(k); } } return out; };
    const text = (value: string, r: D51El["rect"] | null): D51Node => ({ nodeType: 3, nodeValue: value, rects: r ? [r] : [] });
    const mk = (tag: string, o: { r: D51El["rect"]; focusable?: boolean; buttonLike?: boolean; dt?: string; label?: string; attrs?: Record<string, string>; hidden?: boolean; overflow?: string; css?: Record<string, string>; before?: Record<string, string>; ps?: Record<string, Record<string, string>>; shadow?: Array<D51El | D51Node> }, ...nodes: Array<D51El | D51Node>): D51El => {
      const kids = nodes.filter((n): n is D51El => n.nodeType === 1);
      const shadowKids = (o.shadow ?? []).filter((n): n is D51El => n.nodeType === 1);
      const el: D51El = { tagName: tag.toUpperCase(), parentElement: null, isConnected: true, isContentEditable: false, children: kids, childNodes: nodes, nodeType: 1, nodeValue: null,
        rect: o.r, dt: o.dt ?? null, label: o.label ?? null, attrs: o.attrs ?? {}, focusable: o.focusable === true, buttonLike: o.buttonLike === true, hidden: o.hidden === true, overflow: o.overflow ?? "visible",
        css: o.css ?? {}, before: o.before ?? {}, ps: o.ps ?? {}, host: null, shadowRoot: o.shadow ? { children: shadowKids, childNodes: o.shadow } : null, getRootNode: () => (el.host ? { host: el.host } : {}),
        getAttribute: (n) => (n === "data-dt-node" ? el.dt : n === "aria-label" ? el.label : el.attrs[n] ?? null), hasAttribute: () => false,
        matches: (sel) => (sel === "*" ? true : /^a\[href\], area\[href\], button/.test(sel) ? el.focusable : /^button, a\[href\], summary/.test(sel) ? el.buttonLike
          : /^input, select, textarea/.test(sel) ? /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) : /^img, svg, canvas/.test(sel) ? MEDIA.has(el.tagName) : false),
        contains: (q) => q === el || desc(el).some((d) => d === q), querySelectorAll: (sel) => desc(el).filter((c) => c.matches(sel)),
        closest: (sel) => { for (let p: D51El | null = el; p; p = p.parentElement) if (p.matches(sel)) return p; return null; },
        getBoundingClientRect: () => el.rect, getClientRects: () => [el.rect],
        checkVisibility: () => { if (el.css.display === "contents") return false; for (let p: D51El | null = el; p; p = p.parentElement ?? p.host) if (p.hidden) return false; return true; }, focus: () => undefined };
      for (const k of kids) k.parentElement = el;
      for (const k of shadowKids) k.host = el;
      return el;
    };
    const install = (root: D51El): void => {
      const all = [root, ...desc(root)];
      let sel: D51Node | null = null;
      const hitAt = (px: number, py: number): D51El | null => all.filter((e) => px >= e.rect.x && px < e.rect.right && py >= e.rect.y && py < e.rect.bottom).at(-1) ?? null;
      Object.assign(globalThis, { innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0, window: { __dtBeh: undefined },
        getComputedStyle: (e: D51El, pseudo?: string | null) => ({ getPropertyValue: (prop: string) => (pseudo && e.ps?.[pseudo] ? e.ps[pseudo][prop] ?? "" : pseudo === "::before" ? e.before[prop] ?? "" : pseudo ? "" : e.css[prop] ?? (prop.startsWith("overflow") ? e.overflow : "")) }),
        document: { activeElement: null, body: root, documentElement: fakeDe(root), elementFromPoint: hitAt, elementsFromPoint: (px: number, py: number) => all.filter((e) => px >= e.rect.x && px < e.rect.right && py >= e.rect.y && py < e.rect.bottom).reverse(),
          querySelectorAll: (q: string) => { const m = /^\[data-dt-node="(.*)"\]$/.exec(q); return m ? all.filter((e) => e.dt === m[1]) : []; },
          createRange: () => ({ selectNodeContents: (n: D51Node) => { sel = n; }, getClientRects: () => (sel ? sel.rects : []) }) } });
    };
    return { box, text, mk, install };
  })();
  /** [markOpener's control is the inner button, clickPointControl's answer] for a container tagged `dt` around `btn` */
  const d51Run = (root: D51El, btn: D51El): [boolean, string | null | "throws"] => {
    if (!PB.markOpener || !PD.clickPointControl) return [false, "throws"];
    d51.install(root);
    Reflect.apply(PB.markOpener, undefined, [{ id: root.dt }]);
    const w: unknown = Reflect.get(globalThis, "window");
    const st: unknown = typeof w === "object" && w !== null ? Reflect.get(w, "__dtBeh") : undefined;
    const own = typeof st === "object" && st !== null && Reflect.get(st, "control") === btn;
    d51.install(root);
    let cp: string | null | "throws" = "throws";
    try { const r: unknown = Reflect.apply(PD.clickPointControl, undefined, [root]); cp = typeof r === "string" ? r : null; } catch { cp = "throws"; }
    return [own, cp];
  };
  // review 6 (fix 7): H-1 — opacity 0 hides only an OUT-OF-FLOW box (a tooltip); an in-flow one (a reveal-on-scroll label) shows;
  // H-3 — a positioned label escapes the overflow of the boxes off its containing-block chain; an empty ::before on a background
  // image or colour, a mask-image icon, a filled swatch are content, unless (a colour) the box holds the control or lies over its
  // centre (a hover tint, a filled wrapper); L-2 — what lies past the document's start edge (left:-9999px) shows nothing
  const d51Review6 = (): Array<{ name: string; own: boolean; make(): [D51El, D51El] }> => {
    const { box, text, mk } = d51;
    const btn = (): D51El => mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    const one = (name: string, own: boolean, dt: string, ...kids: Array<D51El | D51Node>): { name: string; own: boolean; make(): [D51El, D51El] } =>
      ({ name, own, make: () => { const b = btn(); return [mk(own ? "td" : "div", { r: box(0, 0, 200, 40), dt, css: { position: "relative" } }, ...kids, b), b]; } });
    const wrap1 = (css: Record<string, string>, ...kids: D51El[]): D51El => mk("span", { r: box(4, 10, 1, 1), overflow: "hidden", css }, ...kids);
    return [
      one("card label at opacity 0 in flow (reveal on scroll)", false, "6:1", mk("span", { r: box(4, 10, 70, 16), css: { opacity: "0" } }, text("Move crate", box(4, 10, 70, 16)))),
      one("card label absolute inside a static 1x1 overflow:hidden wrapper", false, "6:2", wrap1({}, mk("span", { r: box(10, 8, 70, 16), css: { position: "absolute" } }, text("Move crate", box(10, 8, 70, 16))))),
      one("card label fixed inside a static 1x1 overflow:hidden wrapper", false, "6:3", wrap1({}, mk("span", { r: box(10, 8, 70, 16), css: { position: "fixed" } }, text("Move crate", box(10, 8, 70, 16))))),
      one("cell label absolute inside a RELATIVE 1x1 overflow:hidden wrapper (its containing block clips it)", true, "6:4", wrap1({ position: "relative" }, mk("span", { r: box(10, 8, 70, 16), css: { position: "absolute" } }, text("Move crate", box(10, 8, 70, 16))))),
      one("cell label fixed inside a TRANSFORMED 1x1 overflow:hidden wrapper (it holds fixed boxes)", true, "6:5", wrap1({ transform: "matrix(1, 0, 0, 1, 0, 0)" }, mk("span", { r: box(10, 8, 70, 16), css: { position: "fixed" } }, text("Move crate", box(10, 8, 70, 16))))),
      one("card logo as an empty ::before on a background-image", false, "6:6", mk("span", { r: box(4, 10, 80, 20), before: { content: "\"\"", "background-image": "linear-gradient(rgb(51, 51, 51), rgb(153, 153, 153))" } })),
      one("card status dot as an empty ::before on a background colour", false, "6:7", mk("span", { r: box(4, 10, 10, 10), before: { content: "\"\"", "background-color": "rgb(34, 170, 119)" } })),
      one("card mask-image icon", false, "6:8", mk("span", { r: box(4, 10, 24, 24), css: { "mask-image": "url(\"icon.svg\")", "background-color": "rgb(51, 51, 51)" } })),
      one("card mask-image icon badge over the control's centre (a filled box there would be chrome; a masked one is an icon)", false, "6:17", mk("span", { r: box(85, 5, 30, 30), css: { "mask-image": "url(\"badge.svg\")", "background-color": "rgb(51, 51, 51)", position: "absolute" } })),
      one("card colour swatch", false, "6:9", mk("span", { r: box(4, 10, 40, 20), css: { "background-color": "rgb(34, 170, 119)" } })),
      one("card in-flow opacity-0 ::before label", false, "6:10", mk("span", { r: box(4, 10, 70, 16), before: { content: "\"Move crate\"", opacity: "0" } })),
      one("cell hover tint over the whole cell", true, "6:11", mk("span", { r: box(0, 0, 200, 40), css: { position: "absolute", "background-color": "rgba(0, 0, 0, 0.04)" } })),
      one("cell sr-only label at left:-9999px", true, "6:12", mk("span", { r: box(-9999, 0, 90, 16), css: { position: "absolute" } }, text("Move crate", box(-9999, 0, 90, 16)))),
      one("cell transparent wrapper (oklab alpha 0) beside the button", true, "6:13", mk("span", { r: box(4, 10, 40, 20), css: { "background-color": "oklab(0 0 0 / 0)" } })),
      { name: "cell button inside a filled wrapper", own: true, make: () => { const b = btn(); return [mk("td", { r: box(0, 0, 200, 40), dt: "6:14" }, mk("span", { r: box(86, 6, 28, 28), css: { "background-color": "rgb(238, 238, 255)" } }, b)), b]; } },
      { name: "cell's own empty ::before tint on a background colour", own: true, make: () => { const b = btn(); return [mk("td", { r: box(0, 0, 200, 40), dt: "6:15", before: { content: "\"\"", "background-color": "rgba(0, 0, 0, 0.04)", position: "absolute" } }, b), b]; } },
      { name: "cell out-of-flow opacity-0 ::before tooltip", own: true, make: () => { const b = btn(); return [mk("td", { r: box(0, 0, 200, 40), dt: "6:16", before: { content: "\"Open crate\"", opacity: "0", position: "absolute" } }, b), b]; } },
    ];
  };
  t("[D51] markOpener and clickPointControl agree: a container's sole centred button is its own control only when nothing of the container's shows outside it — cell with whitespace / an sr-only label / a visibility:hidden note / an icon inside the button → own (pressed, clicked); a card's visible label / an <img> beside it / a label clipped only partly → refused by both, naming the control; review 5 H-3: an opacity-0 tooltip (or its wrapper), a clip-path inset(50%) or clip rect(0,0,0,0) sr-only label, a clearfix ::before → own; H-2: text in display:contents, in a shadow root, a ::before label, a background-image block, a label under a rounded clip-path → refused; review 6: an in-flow opacity-0 label / ::before, a label escaping a static overflow wrapper (absolute, fixed), an empty ::before logo or status dot, a mask icon, a swatch → refused; a label clipped by its containing block, a hover tint, a filled wrapper, the cell's own ::before tint, an out-of-flow opacity-0 ::before tooltip, a left:-9999px sr-only label, an oklab transparent box → own", () => {
    const { box, text, mk } = d51;
    const btn = (): D51El => mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    const cases: Array<{ name: string; own: boolean; make(): [D51El, D51El] }> = [
      { name: "cell, whitespace only", own: true, make: () => { const b = btn(); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:1" }, text("\n  ", box(0, 0, 4, 16)), b, text(" ", box(110, 0, 4, 16))), b]; } },
      { name: "cell + sr-only label", own: true, make: () => { const b = btn(); const sr = mk("span", { r: box(0, 0, 1, 1), overflow: "hidden" }, text("Delete the crate", box(0, 0, 90, 16))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:2" }, sr, b), b]; } },
      { name: "cell + visibility:hidden note", own: true, make: () => { const b = btn(); const note = mk("span", { r: box(0, 0, 60, 16), hidden: true }, text("Saved", box(0, 0, 60, 16))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:3" }, note, b), b]; } },
      { name: "cell, icon + text inside the button", own: true, make: () => { const b = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" }, mk("svg", { r: box(92, 12, 16, 16) }), text("x", box(92, 12, 8, 16))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:4" }, b), b]; } },
      { name: "card with its own label", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:5" }, mk("span", { r: box(4, 10, 70, 16) }, text("Move crate", box(4, 10, 70, 16))), b), b]; } },
      { name: "card with a bare text node", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:6" }, text("Move crate", box(4, 10, 70, 16)), b), b]; } },
      { name: "card with an <img> beside", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:7" }, mk("img", { r: box(4, 10, 20, 20) }), b), b]; } },
      { name: "label partly clipped by an overflow:hidden wrapper", own: false, make: () => { const b = btn(); const wrap = mk("span", { r: box(4, 10, 30, 16), overflow: "hidden" }, text("Move crate", box(4, 10, 70, 16))); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:8" }, wrap, b), b]; } },
      // review 5 H-3: what shows nothing — an opacity-0 hover tooltip (on it, or on its wrapper), a clip-path inset(50%) sr-only
      // label without overflow:hidden, Tailwind's sr-only (clip rect(0,0,0,0)) on a box the text overflows, a clearfix ::before
      { name: "cell + opacity:0 tooltip", own: true, make: () => { const b = btn(); const tip = mk("span", { r: box(90, -22, 70, 16), css: { opacity: "0", position: "absolute" } }, text("Move crate", box(92, -20, 66, 14))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:9" }, b, tip), b]; } },
      { name: "cell + tooltip inside an opacity:0 wrapper", own: true, make: () => { const b = btn(); const tip = mk("span", { r: box(90, -22, 70, 16), css: { opacity: "0", position: "absolute" } }, mk("span", { r: box(92, -20, 66, 14) }, text("Move crate", box(92, -20, 66, 14)))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:10" }, b, tip), b]; } },
      { name: "cell + clip-path inset(50%) sr-only label", own: true, make: () => { const b = btn(); const sr = mk("span", { r: box(0, 0, 90, 16), css: { "clip-path": "inset(50%)", position: "absolute" } }, text("Move crate", box(0, 0, 90, 16))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:11" }, sr, b), b]; } },
      { name: "cell + clip rect(0,0,0,0) label (no overflow:hidden)", own: true, make: () => { const b = btn(); const sr = mk("span", { r: box(0, 0, 1, 1), css: { clip: "rect(0px, 0px, 0px, 0px)", position: "absolute" } }, text("Move crate", box(0, 0, 90, 16))); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:12" }, sr, b), b]; } },
      { name: "cell + clearfix ::before (empty content)", own: true, make: () => { const b = btn(); return [mk("td", { r: box(0, 0, 200, 40), dt: "5:13", before: { content: "\"\"", display: "table" } }, b), b]; } },
      // review 5 H-2: what shows — text in display:contents wrappers, a title inside a shadow root, a ::before label (an icon font
      // glyph), a background-image block (a logo / avatar); a rounded clip-path inset(0 round 8px) hides nothing
      { name: "card text in display:contents", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:14" }, mk("span", { r: box(0, 0, 0, 0), css: { display: "contents" } }, text("Move crate", box(4, 10, 70, 16))), b), b]; } },
      { name: "card title in a shadow root", own: false, make: () => { const b = btn(); const title = mk("x-title", { r: box(4, 10, 70, 16), shadow: [mk("span", { r: box(4, 10, 70, 16) }, text("Move crate", box(4, 10, 70, 16)))] }); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:15" }, title, b), b]; } },
      { name: "card text directly in a shadow root", own: false, make: () => { const b = btn(); const title = mk("x-title", { r: box(4, 10, 70, 16), shadow: [text("Move crate", box(4, 10, 70, 16))] }); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:16" }, title, b), b]; } },
      { name: "card logo <img> inside a shadow root", own: false, make: () => { const b = btn(); const logo = mk("x-logo", { r: box(4, 10, 40, 20), shadow: [mk("img", { r: box(4, 10, 40, 20) })] }); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:20" }, logo, b), b]; } },
      { name: "card ::before label", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:17" }, mk("span", { r: box(4, 10, 70, 16), before: { content: "\"Move crate\"" } }), b), b]; } },
      { name: "card background-image block", own: false, make: () => { const b = btn(); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:18" }, mk("span", { r: box(4, 10, 80, 20), css: { "background-image": "linear-gradient(rgb(51, 51, 51), rgb(153, 153, 153))" } }), b), b]; } },
      { name: "card label under a rounded clip-path on its wrapper", own: false, make: () => { const b = btn(); const wrap = mk("span", { r: box(4, 10, 80, 16), css: { "clip-path": "inset(0px round 8px)" } }, text("Move crate", box(4, 10, 70, 16))); return [mk("div", { r: box(0, 0, 200, 40), dt: "5:19" }, wrap, b), b]; } },
      ...d51Review6(),
    ];
    return cases.every((c) => {
      const [root, b] = c.make();
      const [own, cp] = d51Run(root, b);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [D51] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // review 8 (fix 9): H-1 — a <progress>, <meter> or <audio> (controls) is media; M-3 — a list item's marker is content, the
  // container's own too (a list-style type or image); a list item with list-style none shows no marker
  t("[review 8 H-1/M-3] markOpener and clickPointControl: a <progress> / <meter> / <audio> beside the sole Delete, a card that is a list item with a decimal marker, a child list item with a marker image → refused by both; a list-item cell with list-style none → its own", () => {
    const { box, mk } = d51;
    const btn = (): D51El => mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    const card = (own: boolean, css: Record<string, string>, ...kids: D51El[]): [D51El, D51El] => { const b = btn(); return [mk(own ? "td" : "div", { r: box(0, 0, 200, 40), dt: "8:1", css }, ...kids, b), b]; };
    const cases: Array<{ name: string; own: boolean; make(): [D51El, D51El] }> = [
      { name: "progress", own: false, make: () => card(false, {}, mk("progress", { r: box(4, 12, 70, 16) })) },
      { name: "meter", own: false, make: () => card(false, {}, mk("meter", { r: box(4, 12, 70, 16) })) },
      { name: "audio", own: false, make: () => card(false, {}, mk("audio", { r: box(4, 4, 80, 30) })) },
      { name: "own decimal marker", own: false, make: () => card(false, { display: "list-item", "list-style-type": "decimal" }) },
      { name: "child marker image", own: false, make: () => card(false, {}, mk("span", { r: box(4, 12, 20, 16), css: { display: "list-item", "list-style-type": "none", "list-style-image": "url(\"dot.png\")" } })) },
      { name: "list-item, list-style none", own: true, make: () => card(true, { display: "list-item", "list-style-type": "none", "list-style-image": "none" }) },
    ];
    return cases.every((c) => {
      const [root, b] = c.make();
      const [own, cp] = d51Run(root, b);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [review 8] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // fix 10 (review 9 M-2/M-3/L-1, owner D54(a)/(b)): the container's OWN paint is decoration only when plain — a background image,
  // border sides in different colours or a stripe are content; a uniform border and a 1-px divider are not. A label laid over the
  // container from OUTSIDE its subtree (a positioned sibling, an ancestor's absolute ::after) counts when at least half of it lies
  // over the container and it is not proven to lie under it; a fixed / sticky one (a toast) is foreign; one mostly outside it does
  // not count. A scroll container's ::scroll-button is a second control. Both copies (markOpener, clickPointControl) agree.
  // D56: `pre` = tipPreMark's set (what was shown before the probe's hover); undefined = it never ran on the page (no set)
  const d51In = (page: D51El, boxEl: D51El, btn: D51El, pre?: D51El[]): [boolean, string | null | "throws"] => {
    if (!PB.markOpener || !PD.clickPointControl) return [false, "throws"];
    const tipSet = (): void => { const w: unknown = Reflect.get(globalThis, "window"); if (pre && typeof w === "object" && w !== null) Reflect.set(w, "__dtTipPre", new WeakSet(pre)); };
    d51.install(page);
    tipSet();
    Reflect.apply(PB.markOpener, undefined, [{ id: boxEl.dt }]);
    const w: unknown = Reflect.get(globalThis, "window");
    const st: unknown = typeof w === "object" && w !== null ? Reflect.get(w, "__dtBeh") : undefined;
    const own = typeof st === "object" && st !== null && Reflect.get(st, "control") === btn;
    d51.install(page);
    tipSet();
    let cp: string | null | "throws" = "throws";
    try { const r: unknown = Reflect.apply(PD.clickPointControl, undefined, [boxEl]); cp = typeof r === "string" ? r : null; } catch (e) { cp = `throws ${String(e)}` as "throws"; }
    return [own, cp];
  };
  const d54Cases = (): Array<{ name: string; own: boolean; make(): [D51El, D51El, D51El] }> => {
    const { box, text, mk } = d51;
    const btn = (): D51El => mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    const WHITE = { "background-color": "rgb(255, 255, 255)" };
    // the page: a row holding the container (dt 10:1) at (0,0)-(200,40) and what else is given
    const inRow = (name: string, own: boolean, boxCss: Record<string, string>, rowO: { css?: Record<string, string>; ps?: Record<string, Record<string, string>> }, before: D51El[], after: D51El[], boxPs?: Record<string, Record<string, string>>): { name: string; own: boolean; make(): [D51El, D51El, D51El] } =>
      ({ name, own, make: () => { const b = btn(); const c = mk("div", { r: box(0, 0, 200, 40), dt: "10:1", css: { ...WHITE, ...boxCss }, ps: boxPs ?? {} }, b); const row = mk("div", { r: box(0, 0, 400, 40), css: rowO.css ?? {}, ps: rowO.ps ?? {} }, ...before, c, ...after); return [mk("main", { r: box(0, 0, 1000, 700) }, row), c, b]; } });
    const label = (css: Record<string, string>, r = box(12, 12, 60, 16)): D51El => mk("span", { r, css: { position: "absolute", ...css } }, text("Oak crate", r));
    const border = (top: string, right: string, bottom: string, left: string): Record<string, string> => {
      const o: Record<string, string> = {};
      for (const [k, v] of [["top", top], ["right", right], ["bottom", bottom], ["left", left]] as const) { const [w = "0px", c = "rgb(0, 0, 0)"] = v.split(" / "); o[`border-${k}-width`] = w; o[`border-${k}-style`] = w === "0px" ? "none" : "solid"; o[`border-${k}-color`] = c; }
      return o;
    };
    return [
      inRow("D54(a) own progress gradient", false, { "background-image": "linear-gradient(90deg, rgb(187, 247, 208) 60%, rgba(0, 0, 0, 0) 60%)" }, {}, [], []),
      inRow("D54(a) own url() background", false, { "background-image": "url(\"https://x.test/a.png\")" }, {}, [], []),
      inRow("D54(a) own border in two colours", false, border("3px / rgb(22, 163, 74)", "3px / rgb(22, 163, 74)", "3px / rgb(187, 247, 208)", "3px / rgb(187, 247, 208)"), {}, [], []),
      inRow("D54(a) own 6-px left stripe, 1 px elsewhere (one colour)", false, border("1px / rgb(200, 196, 184)", "1px / rgb(200, 196, 184)", "1px / rgb(200, 196, 184)", "6px / rgb(200, 196, 184)"), {}, [], []),
      inRow("D54(a) own uniform 2-px status border (one colour)", true, border("2px / rgb(220, 38, 38)", "2px / rgb(220, 38, 38)", "2px / rgb(220, 38, 38)", "2px / rgb(220, 38, 38)"), {}, [], []),
      inRow("D54(a) own 1-px bottom divider only", true, border("0px", "0px", "1px / rgb(238, 238, 238)", "0px"), {}, [], []),
      inRow("D54(a) own border image", false, { "border-image-source": "linear-gradient(red, blue)" }, {}, [], []),
      inRow("D54(b) sibling label over it, pointer-events none (after it)", false, {}, {}, [], [label({ "pointer-events": "none" })]),
      inRow("D54(b) sibling label over it, hittable, stacked above (after it)", false, {}, {}, [], [label({})]),
      inRow("D54(b) sibling label under it, hittable (before it), the container opaque", true, {}, {}, [label({})], []),
      inRow("D54(b) sibling label under it, hittable, the container transparent", false, { "background-color": "rgba(0, 0, 0, 0)" }, {}, [label({})], []),
      inRow("D54(b) a fixed toast with text over it", true, {}, {}, [], [label({ position: "fixed" })]),
      inRow("D54(b) text inside a sticky header over it", true, {}, {}, [], [mk("div", { r: box(0, 0, 80, 30), css: { position: "sticky" } }, mk("span", { r: box(12, 12, 60, 16) }, text("Oak crate", box(12, 12, 60, 16))))]),
      inRow("D54(b) sibling label mostly outside it (a quarter over it)", true, {}, {}, [], [label({ "pointer-events": "none" }, box(185, 12, 60, 16))]),
      inRow("D54(b) sibling <img> over it", false, {}, {}, [], [mk("img", { r: box(4, 4, 32, 32), css: { position: "absolute", "pointer-events": "none" } })]),
      inRow("D54(b) the parent's absolute ::after label over it", false, {}, { css: { position: "relative" }, ps: { "::after": { content: "\"Oak crate\"", position: "absolute", left: "12px", top: "14px", width: "60px", height: "18px", "pointer-events": "none" } } }, [], []),
      inRow("D54(b) the parent's absolute ::after label beside it (left 300 px)", true, {}, { css: { position: "relative" }, ps: { "::after": { content: "\"Oak crate\"", position: "absolute", left: "300px", top: "14px", width: "60px", height: "18px", "pointer-events": "none" } } }, [], []),
      inRow("D54(b) the parent's empty ::after tint over it (no label)", true, {}, { css: { position: "relative" }, ps: { "::after": { content: "\"\"", position: "absolute", left: "0px", top: "0px", width: "200px", height: "40px", "background-color": "rgba(0, 0, 0, 0.04)", "pointer-events": "none" } } }, [], []),
      inRow("D54(b) a sibling plain fill (a ticker bar) over it", true, {}, {}, [], [mk("div", { r: box(140, 4, 50, 6), css: { position: "absolute", "background-color": "rgb(68, 119, 255)" } })]),
      inRow("review 9 L-1 the container is a scroller with a ::scroll-button", false, { "overflow-x": "auto" }, {}, [], [], { "::scroll-button(*)": { content: "\"▶\"" } }),
      inRow("review 9 L-1 a scroller without scroll buttons", true, { "overflow-x": "auto" }, {}, [], []),
      inRow("review 9 L-1 the container holds a scroll-marker group", false, { "scroll-marker-group": "after" }, {}, [], []),
    ];
  };
  t("[fix10 D54(a)/(b), review 9 L-1] markOpener and clickPointControl: the container's own progress gradient / url image / two-colour border / 6-px stripe / border image, a sibling label laid over it (pointer-events none, or hittable above it), a label under a TRANSPARENT container, a sibling <img> over it, the parent's absolute ::after label over it, a ::scroll-button on it, a scroll-marker group → refused by both; a uniform status border, a 1-px divider, a label hit-tested under the opaque container, a fixed toast, a sticky header, a label mostly outside it, the parent's ::after beside it or an empty tint, a ticker fill, a scroller without buttons → its own", () => {
    return d54Cases().every((c) => {
      const [page, boxEl, b] = c.make();
      const [own, cp] = d51In(page, boxEl, b);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [fix10] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // fix 11 (review 10, owner D55): the container's own inset box-shadow (a stripe, a fill, a glow), sharp rings in two colours and
  // its own paint under a mask or a band clip-path are content; one inset ring in one colour, a 1-px inset highlight, a rounded
  // inset(0) clip and a mask over nothing of its own are not. Never foreign: the sole control's own tooltip ([role=tooltip], its
  // aria-describedby target) and a label at effective opacity 0. "Under it" needs no opacity below 1 / blend mode on the
  // container or above it; bare text in a sibling's shadow root is read. Review 10 L-4 (surviving mutations): a label inside a
  // fixed app shell that also holds the container, a sibling background image, a visibility:hidden sibling label, a label whose
  // SECOND line lies over it, an element in a sibling's shadow root, a positioned label under a parent lying elsewhere, a 2-px
  // stripe exactly, a border-style hidden side, a page past 3000 elements
  const d55Cases = (): Array<{ name: string; own: boolean; make(): [D51El, D51El, D51El] }> => {
    const { box, text, mk } = d51;
    const WHITE = { "background-color": "rgb(255, 255, 255)" };
    const btn = (attrs: Record<string, string> = {}): D51El => mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate", attrs });
    type Case = { name: string; own: boolean; make(): [D51El, D51El, D51El] };
    const inRow = (name: string, own: boolean, boxCss: Record<string, string>, before: D51El[], after: D51El[], o: { rowCss?: Record<string, string>; btnAttrs?: Record<string, string>; wrap?: (row: D51El) => D51El; extra?: D51El[] } = {}): Case =>
      ({ name, own, make: () => { const b = btn(o.btnAttrs); const c = mk("div", { r: box(0, 0, 200, 40), dt: "10:1", css: { ...WHITE, ...boxCss } }, b); const row = mk("div", { r: box(0, 0, 400, 40), css: o.rowCss ?? {} }, ...before, c, ...after); return [mk("main", { r: box(0, 0, 1000, 700) }, o.wrap ? o.wrap(row) : row, ...(o.extra ?? [])), c, b]; } });
    const label = (css: Record<string, string>, attrs: Record<string, string> = {}, r = box(12, 12, 60, 16)): D51El => mk("span", { r, css: { position: "absolute", ...css }, attrs }, text("Oak crate", r));
    const border = (w: string, c = "rgb(200, 196, 184)"): Record<string, string> => ({ "border-top-width": w, "border-right-width": w, "border-bottom-width": w, "border-left-width": w, "border-top-style": "solid", "border-right-style": "solid", "border-bottom-style": "solid", "border-left-style": "solid", "border-top-color": c, "border-right-color": c, "border-bottom-color": c, "border-left-color": c });
    const many: D51El[] = [];
    for (let i = 0; i < 3500; i++) many.push(mk("i", { r: box(0, 600, 4, 4) }));
    return [
      inRow("D55 own inset 5-px stripe", false, { "box-shadow": "rgb(220, 38, 38) 5px 0px 0px 0px inset" }, [], []),
      inRow("D55 own inset progress fill (offset 96 px)", false, { "box-shadow": "rgb(187, 247, 208) 96px 0px 0px 0px inset" }, [], []),
      inRow("D55 own inset glow (blur 8 px)", false, { "box-shadow": "rgba(0, 0, 0, 0.2) 0px 0px 8px 0px inset" }, [], []),
      inRow("D55 own two-colour outer ring", false, { "box-shadow": "rgb(22, 163, 74) 0px 0px 0px 3px, rgb(187, 247, 208) 0px 0px 0px 6px" }, [], []),
      // D56 (review 11 H-2) changed this one: the border colour no longer counts against the ring (was: refused)
      inRow("D56 own inset ring in another colour than its border (one ring colour)", true, { "box-shadow": "rgb(22, 163, 74) 0px 0px 0px 2px inset", ...border("1px") }, [], []),
      inRow("D55 own paint under a mask", false, { "mask-image": "linear-gradient(90deg, rgb(0, 0, 0) 60%, rgba(0, 0, 0, 0.25) 60%)" }, [], []),
      inRow("D55 own paint under a band clip-path", false, { "clip-path": "inset(0px 40% 0px 0px)" }, [], []),
      inRow("D55 own one-colour inset ring (ring-inset frame)", true, { "box-shadow": "rgb(200, 196, 184) 0px 0px 0px 2px inset" }, [], []),
      inRow("D55 own 1-px inset highlight", true, { "box-shadow": "rgba(255, 255, 255, 0.1) 0px 1px 0px 0px inset" }, [], []),
      inRow("D55 own soft outer drop shadow (one layer)", true, { "box-shadow": "rgba(0, 0, 0, 0.1) 0px 1px 3px 0px" }, [], []),
      inRow("D55 own rounded inset(0) clip", true, { "clip-path": "inset(0px round 12px)" }, [], []),
      inRow("D55 own mask over nothing of its own (transparent, no border)", true, { "background-color": "rgba(0, 0, 0, 0)", "mask-image": "linear-gradient(90deg, rgb(0, 0, 0) 80%, rgba(0, 0, 0, 0))" }, [], []),
      inRow("D55 the control's tooltip ([role=tooltip]) over it", true, {}, [], [label({ "pointer-events": "none" }, { role: "tooltip" })]),
      inRow("D55 the control's aria-describedby target over it", true, {}, [], [label({ "pointer-events": "none" }, { id: "tip-1" })], { btnAttrs: { "aria-describedby": "note-0 tip-1" } }),
      inRow("D55 a sibling label over it inside a [role=tooltip] popover that holds the container too (an ancestor is never skipped)", false, {}, [], [label({ "pointer-events": "none" })], { wrap: (row) => mk("div", { r: box(0, 0, 1000, 700), attrs: { role: "tooltip" } }, row) }),
      inRow("D55 an element another control describes (not this one's) over it", false, {}, [], [label({ "pointer-events": "none" }, { id: "tip-2" })], { btnAttrs: { "aria-describedby": "tip-1" } }),
      inRow("D55 a foreign label at opacity 0 (in flow)", true, {}, [], [label({ position: "static", opacity: "0" })]),
      inRow("D55 a foreign label under a wrapper at opacity 0", true, {}, [], [mk("div", { r: box(0, 0, 80, 40), css: { position: "absolute", opacity: "0" } }, label({ position: "static" }))]),
      inRow("D55 a sibling's in-flow ::before label at opacity 0 (a \"Copied!\" feedback stacked over it)", true, {}, [], [mk("span", { r: box(12, 12, 60, 16), css: { position: "absolute", "pointer-events": "none" }, ps: { "::before": { content: "\"Copied!\"", opacity: "0" } } })]),
      inRow("review 10 M-4 a label under the opaque container at opacity 0.6", false, { opacity: "0.6" }, [label({})], []),
      inRow("review 10 M-4 a label under the opaque container in multiply blend", false, { "mix-blend-mode": "multiply" }, [label({})], []),
      inRow("review 10 M-4 a label under the opaque container whose parent is at opacity 0.5", false, {}, [label({})], [], { rowCss: { opacity: "0.5" } }),
      inRow("review 10 M-4 bare text in a sibling's shadow root over it", false, { "background-color": "rgba(0, 0, 0, 0)" }, [], [mk("span", { r: box(12, 12, 60, 16), css: { position: "absolute", "pointer-events": "none" }, shadow: [text("Oak crate", box(12, 12, 60, 16))] })]),
      inRow("review 10 L-4 (b2) a label inside a fixed app shell that holds the container too", false, { "background-color": "rgba(0, 0, 0, 0)" }, [], [label({ "pointer-events": "none" })], { wrap: (row) => mk("div", { r: box(0, 0, 1000, 700), css: { position: "fixed" } }, row) }),
      inRow("review 10 L-4 (b5) a sibling background image over it", false, {}, [], [mk("span", { r: box(4, 4, 40, 32), css: { position: "absolute", "pointer-events": "none", "background-image": "url(\"avatar.png\")" } })]),
      inRow("review 10 L-4 (b4) a visibility:hidden sibling label over it", true, {}, [], [label({ visibility: "hidden" })]),
      inRow("review 10 L-4 (b9) a sibling label whose second line lies over it", false, {}, [], [mk("span", { r: box(12, -60, 60, 80), css: { position: "absolute", "pointer-events": "none" } }, { nodeType: 3, nodeValue: "Oak crate", rects: [box(12, -60, 60, 16), box(12, 12, 60, 16)] })]),
      inRow("review 10 L-4 (b11) an element in a sibling's shadow root over it", false, {}, [], [mk("span", { r: box(0, 0, 1, 1), shadow: [label({ "pointer-events": "none" })] })]),
      inRow("review 10 L-4 (b3) a positioned label under a parent lying elsewhere", false, {}, [], [mk("div", { r: box(300, 0, 50, 40) }, label({ "pointer-events": "none" }))]),
      inRow("review 10 L-4 (d1) own stripe exactly 2 px wider (3 px left, 1 px elsewhere)", false, { ...border("1px"), "border-left-width": "3px" }, [], []),
      inRow("review 10 L-4 (d2) own two colours, one side border-style hidden", true, { ...border("1px"), "border-left-style": "hidden", "border-left-color": "rgb(220, 38, 38)" }, [], []),
      inRow("review 10 L-4 (b10) a page of 3500 more elements, nothing over it", true, {}, [], [], { extra: many }),
      inRow("review 10 L-4 (b13) the parent's absolute ::after label at left 40 px of a containing block with a 150-px left border: beside it", true, {}, [], [], { rowCss: { position: "relative", "border-left-width": "150px" }, wrap: (row) => { row.ps = { "::after": { content: "\"Oak crate\"", position: "absolute", left: "40px", top: "14px", width: "60px", height: "18px", "pointer-events": "none" } }; return row; } }),
      inRow("review 10 L-4 (b14) the parent's absolute content-box ::after at left 190 px, 10 px wide + 100 px right padding: mostly beside it", true, {}, [], [], { rowCss: { position: "relative" }, wrap: (row) => { row.ps = { "::after": { content: "\"Oak crate\"", position: "absolute", left: "190px", top: "14px", width: "10px", "padding-right": "100px", height: "18px", "pointer-events": "none" } }; return row; } }),
    ];
  };
  t("[fix11 D55, review 10 M-3/M-4/H-2/L-1/L-4] markOpener and clickPointControl: the container's own inset stripe / fill / glow, a two-colour ring, its paint under a mask or band clip-path, a label shown through an opacity / blend, bare text in a sibling's shadow root, a label in a fixed shell holding it, a sibling background image, a second text line over it, an element in a sibling's shadow root, a positioned label under a distant parent, a 2-px stripe, an element described by another control → refused by both; a one-colour inset ring, a 1-px highlight, a soft drop shadow, a rounded clip, a mask over nothing, the control's tooltip / describedby target, a label at effective opacity 0, a hidden label, a hidden-style side, 3500 more elements → its own", () => {
    return d55Cases().every((c) => {
      const [page, boxEl, b] = c.make();
      // D56: tipPreMark ran and saw nothing shown before the hover (the tooltip cases are revealed by it)
      const [own, cp] = d51In(page, boxEl, b, []);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [fix11] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // fix 12 (review 11, owner D56): H-1 — the tooltip exemption holds only for a [role=tooltip] / aria-describedby target the
  // probe's hover revealed: one in tipPreMark's set (shown before the hover) is the card's own label, and with no set (tipPreMark
  // never ran on the page) nothing is exempt. H-2 — the ring rule counts the sharp ring layers' colours only: not the border, not
  // a layer in the container's own background colour (Tailwind ring-offset)
  t("[fix12 D56, review 11 H-1/H-2] markOpener and clickPointControl: a [role=tooltip] label or the control's aria-describedby target shown BEFORE the hover, a [role=tooltip] label with no tipPreMark set, two ring colours beside a background-coloured offset layer, a white offset layer + a ring on a transparent container → refused by both; a tooltip / describedby target revealed by the hover (another element shown before), a 1-colour ring in another colour than the border, a ring-offset in the container's background colour + one ring → its own", () => {
    const { box, text, mk } = d51;
    const WHITE = { "background-color": "rgb(255, 255, 255)" };
    const border = { "border-top-width": "1px", "border-right-width": "1px", "border-bottom-width": "1px", "border-left-width": "1px", "border-top-style": "solid", "border-right-style": "solid", "border-bottom-style": "solid", "border-left-style": "solid", "border-top-color": "rgb(200, 196, 184)", "border-right-color": "rgb(200, 196, 184)", "border-bottom-color": "rgb(200, 196, 184)", "border-left-color": "rgb(200, 196, 184)" };
    type Pre = "none" | "empty" | "label" | "other";
    const cases: Array<{ name: string; own: boolean; pre: Pre; boxCss?: Record<string, string>; labelAttrs?: Record<string, string>; btnAttrs?: Record<string, string> }> = [
      { name: "a [role=tooltip] label over it, shown before the hover", own: false, pre: "label", labelAttrs: { role: "tooltip" } },
      { name: "the control's aria-describedby target over it, shown before the hover", own: false, pre: "label", labelAttrs: { id: "crate-name" }, btnAttrs: { "aria-describedby": "crate-name" } },
      { name: "a [role=tooltip] label over it, tipPreMark never ran (no set)", own: false, pre: "none", labelAttrs: { role: "tooltip" } },
      { name: "the control's aria-describedby target over it, tipPreMark never ran (no set)", own: false, pre: "none", labelAttrs: { id: "crate-name" }, btnAttrs: { "aria-describedby": "crate-name" } },
      { name: "a [role=tooltip] label revealed by the hover (another element shown before)", own: true, pre: "other", labelAttrs: { role: "tooltip" } },
      { name: "the control's aria-describedby target revealed by the hover (another element shown before)", own: true, pre: "other", labelAttrs: { id: "crate-name" }, btnAttrs: { "aria-describedby": "crate-name" } },
      { name: "ring-border: a 2-px ring in another colour than its 1-px border", own: true, pre: "empty", boxCss: { ...WHITE, ...border, "box-shadow": "rgb(147, 197, 253) 0px 0px 0px 2px" } },
      { name: "ring-offset: a 2-px layer in its own background colour + a 4-px ring", own: true, pre: "empty", boxCss: { ...WHITE, ...border, "box-shadow": "rgb(255, 255, 255) 0px 0px 0px 2px, rgb(59, 130, 246) 0px 0px 0px 4px" } },
      { name: "a background-coloured offset layer + two ring colours", own: false, pre: "empty", boxCss: { ...WHITE, "box-shadow": "rgb(255, 255, 255) 0px 0px 0px 2px, rgb(22, 163, 74) 0px 0px 0px 4px, rgb(187, 247, 208) 0px 0px 0px 7px" } },
      { name: "a white offset layer + a ring on a TRANSPARENT container (white is not its background)", own: false, pre: "empty", boxCss: { "background-color": "rgba(0, 0, 0, 0)", "box-shadow": "rgb(255, 255, 255) 0px 0px 0px 2px, rgb(59, 130, 246) 0px 0px 0px 4px" } },
    ];
    return cases.every((c) => {
      const b = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate", attrs: c.btnAttrs ?? {} });
      const cell = mk("div", { r: box(0, 0, 200, 40), dt: "10:1", css: c.boxCss ?? WHITE }, b);
      const r = box(12, 12, 60, 16);
      const lab = c.labelAttrs ? mk("span", { r, css: { position: "absolute", "pointer-events": "none" }, attrs: c.labelAttrs }, text("Oak crate", r)) : null;
      const other = mk("span", { r: box(500, 500, 40, 16), attrs: { id: "status" } }, text("Ready", box(500, 500, 40, 16)));
      const row = mk("div", { r: box(0, 0, 400, 40) }, cell, ...(lab ? [lab] : []));
      const page = mk("main", { r: box(0, 0, 1000, 700) }, row, other);
      const pre = c.pre === "none" ? undefined : c.pre === "empty" ? [] : c.pre === "other" ? [other] : lab ? [lab, other] : [other];
      const [own, cp] = d51In(page, cell, b, pre);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [fix12] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // fix 13 (review 12 H-1, owner D57): a ring layer in the container's own background colour is ignored only where it cannot
  // show — an outer layer (a ring-offset), or an inset one over its own opaque border-box / padding-box background. Over a
  // semi-transparent background the inset band stacks alpha and shows darker; over a content-box background it paints the
  // padding — both make a two-tone frame
  t("[fix13 D57, review 12 H-1] markOpener and clickPointControl: an inset ring + an inset layer in its own SEMI-TRANSPARENT background colour, an inset ring + an inset layer in its own opaque background colour clipped to the content box → refused by both; an inset ring + an inset layer in its own opaque border-box / padding-box background colour, an outer offset layer in its own background colour (content-box clip) + a ring → its own", () => {
    const { box, mk } = d51;
    const GREEN = "rgb(22, 163, 74)", SEMI = "rgba(22, 163, 74, 0.3)", WHITE = "rgb(255, 255, 255)";
    const cases: Array<{ name: string; own: boolean; css: Record<string, string> }> = [
      { name: "ring-semi: an inset 3-px ring + an inset 7-px layer in its own semi-transparent background colour", own: false, css: { "background-color": SEMI, "background-clip": "border-box", "box-shadow": `${GREEN} 0px 0px 0px 3px inset, ${SEMI} 0px 0px 0px 7px inset` } },
      { name: "an inset ring + an inset layer in its own opaque background colour, the background clipped to the content box", own: false, css: { "background-color": WHITE, "background-clip": "content-box", "box-shadow": `${GREEN} 0px 0px 0px 3px inset, ${WHITE} 0px 0px 0px 7px inset` } },
      { name: "an inset ring + an inset layer in its own opaque border-box background colour", own: true, css: { "background-color": WHITE, "background-clip": "border-box", "box-shadow": `${GREEN} 0px 0px 0px 3px inset, ${WHITE} 0px 0px 0px 7px inset` } },
      { name: "an inset ring + an inset layer in its own opaque padding-box background colour", own: true, css: { "background-color": WHITE, "background-clip": "padding-box", "box-shadow": `${GREEN} 0px 0px 0px 3px inset, ${WHITE} 0px 0px 0px 7px inset` } },
      { name: "an outer offset layer in its own opaque background colour (content-box clip) + an outer ring", own: true, css: { "background-color": WHITE, "background-clip": "content-box", "box-shadow": `${WHITE} 0px 0px 0px 2px, rgb(59, 130, 246) 0px 0px 0px 4px` } },
    ];
    return cases.every((c) => {
      const b = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
      const cell = mk("div", { r: box(0, 0, 200, 40), dt: "10:1", css: c.css }, b);
      const page = mk("main", { r: box(0, 0, 1000, 700) }, mk("div", { r: box(0, 0, 400, 40) }, cell));
      const [own, cp] = d51In(page, cell, b, []);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [fix13] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  // review 6 L-1: the own-content walk on a 12000-deep tree (a label at the bottom, the sole Delete at the top) — the explicit
  // stack gives a clean answer (refused by both, naming the Delete), never a RangeError
  t("[review 6 L-1] markOpener and clickPointControl on a card whose label is 12000 elements deep: no stack overflow, both refuse its centred Delete", () => {
    const { box, text, mk } = d51;
    const b = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    let deep: D51El = mk("span", { r: box(4, 10, 70, 16) }, text("Move crate", box(4, 10, 70, 16)));
    for (let i = 0; i < 12_000; i++) deep = mk("span", { r: box(4, 10, 70, 16) }, deep);
    const [own, cp] = d51Run(mk("div", { r: box(0, 0, 200, 40), dt: "6:20" }, deep, b), b);
    if (own || cp !== "<button aria-label=\"Delete crate\">") console.log(`    [review 6 L-1] markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
    return !own && cp === "<button aria-label=\"Delete crate\">";
  });
  // review 7 (fix 8): L-1 — the start edge moves out by the scroll of the container and every box above it (an app shell's
  // scroller), so a label scrolled above the shell's top still counts while a left:-9999px sr-only label (no scroll) does not;
  // L-2 — overflow:clip on both axes paints overflow-clip-margin past the box; L-4 — a container needing more than the work cap
  // answers "content" at once (was: O(texts × depth), seconds, then "nothing")
  t("[review 7 L-1/L-2] markOpener and clickPointControl: a tall card's label above the top of a scrolled app shell → refused (was: clipped off as past the document's top edge); the same card not scrolled (label above the document top, nothing scrolled) and a left:-9999px sr-only label → own; a label in a 1 × 1 overflow:clip box with overflow-clip-margin:120px → refused (was: clipped to the box), with margin 0 → own", () => {
    const { box, text, mk } = d51;
    const b = (): D51El => mk("button", { r: box(90, -100, 40, 400), focusable: true, buttonLike: true, label: "Delete crate" });
    const tall = (scrolled: boolean): [D51El, D51El] => {
      const btn = b();
      const card = mk("div", { r: box(0, -450, 240, 900), dt: "7:1", css: { position: "relative" } }, mk("span", { r: box(6, -444, 90, 16) }, text("Move crate", box(6, -444, 90, 16))), btn);
      const shell = mk("div", { r: box(0, 0, 1000, 700), overflow: "auto" }, card);
      if (scrolled) shell.scrollTop = 1450;
      return [card, btn];
    };
    const clipM = (margin: string): [D51El, D51El] => {
      const btn = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
      const c = mk("span", { r: box(4, 10, 1, 1), overflow: "clip", css: { "overflow-clip-margin": margin } }, text("Rake crate", box(4, 10, 70, 16)));
      return [mk("div", { r: box(0, 0, 200, 40), dt: "7:2" }, c, btn), btn];
    };
    const cases: Array<{ name: string; own: boolean; make(): [D51El, D51El] }> = [
      { name: "tall card, label above a scrolled shell's top", own: false, make: () => tall(true) },
      { name: "tall card, label above the top, nothing scrolled", own: true, make: () => tall(false) },
      { name: "cell sr-only label at left:-9999px", own: true, make: () => { const btn = b(); return [mk("td", { r: box(0, -150, 200, 500), dt: "7:3" }, mk("span", { r: box(-9999, 190, 90, 16), css: { position: "absolute" } }, text("Move crate", box(-9999, 190, 90, 16))), btn), btn]; } },
      { name: "label in overflow:clip + overflow-clip-margin:120px", own: false, make: () => clipM("120px") },
      { name: "label in overflow:clip, margin 0", own: true, make: () => clipM("0px") },
    ];
    return cases.every((c) => {
      const [root, btn] = c.make();
      const [own, cp] = d51Run(root, btn);
      const ok = c.own ? own && cp === null : !own && cp === "<button aria-label=\"Delete crate\">";
      if (!ok) console.log(`    [review 7 L-1/L-2] ${c.name}: markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}`);
      return ok;
    });
  });
  t("[review 7 L-4] markOpener and clickPointControl on a card of 1500 nested 1 × 1 overflow:hidden boxes, each with a clipped text: past the work cap → both refuse its centred Delete, at once (was: O(texts × depth), then 'nothing of its own')", () => {
    const { box, text, mk } = d51;
    const btn = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    let deep: D51El = mk("span", { r: box(4, 10, 1, 1), overflow: "hidden" }, text("Move crate", box(4, 10, 70, 16)));
    for (let i = 0; i < 1500; i++) deep = mk("span", { r: box(4, 10, 1, 1), overflow: "hidden" }, text(`crate ${i}`, box(4, 10, 70, 16)), deep);
    const t0 = Date.now();
    const [own, cp] = d51Run(mk("div", { r: box(0, 0, 200, 40), dt: "7:4" }, deep, btn), btn);
    const ms = Date.now() - t0;
    if (own || cp !== "<button aria-label=\"Delete crate\">" || ms > 3000) console.log(`    [review 7 L-4] markOpener control=${own ? "the button" : "none"}, clickPointControl=${String(cp)}, ${ms} ms`);
    return !own && cp === "<button aria-label=\"Delete crate\">" && ms <= 3000;
  });
  // D52 (fix 8): the pixels have the last word on a container's sole control — clickPointControl leaves the pair in
  // window.__dtOwn only on its D47 exemption and only when asked ({ mark: true }); markOpener leaves it (sole) the first time a
  // page sees the pair, ownDecide records the pixels' verdict (own content → no control), and the pair is never shot twice
  t("[fix8 D52] clickPointControl({ mark }) leaves the pair for the pixel check only on the D47 exemption; markOpener → sole + the pair, ownDecide(own) drops the control and the page remembers it (no second shot), ownDecide(not own) keeps it", () => {
    const { box, mk } = d51;
    if (!PB.markOpener || !PD.clickPointControl || !PB.ownDecide) return false;
    const w = (): unknown => Reflect.get(globalThis, "window");
    const pair = (): unknown => { const x = w(); return typeof x === "object" && x !== null ? Reflect.get(x, "__dtOwn") : undefined; };
    const ctl = (): unknown => { const x = w(); const st: unknown = typeof x === "object" && x !== null ? Reflect.get(x, "__dtBeh") : undefined; return typeof st === "object" && st !== null ? Reflect.get(st, "control") : undefined; };
    const cellOf = (dt: string): [D51El, D51El] => { const btn = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Open crate" }); return [mk("td", { r: box(0, 0, 200, 40), dt }, btn), btn]; };
    const [cell, btn] = cellOf("8:1");
    d51.install(cell);
    const unmarked: unknown = Reflect.apply(PD.clickPointControl, undefined, [cell]);
    const noPair = pair() === undefined || pair() === null;
    const marked: unknown = Reflect.apply(PD.clickPointControl, undefined, [cell, { mark: true }]);
    const p1 = pair();
    const cpPair = typeof p1 === "object" && p1 !== null && Reflect.get(p1, "box") === cell && Reflect.get(p1, "ctl") === btn;
    // a card with its own label: refused, no pair
    const del = mk("button", { r: box(90, 10, 20, 20), focusable: true, buttonLike: true, label: "Delete crate" });
    const card = mk("div", { r: box(0, 0, 200, 40), dt: "8:2" }, mk("span", { r: box(4, 10, 70, 16) }, d51.text("Move crate", box(4, 10, 70, 16))), del);
    d51.install(card);
    const refused: unknown = Reflect.apply(PD.clickPointControl, undefined, [card, { mark: true }]);
    const cardNoPair = pair() === null;
    // markOpener: sole + pair; ownDecide(own: true) → no control; again → sole false, still no control (remembered)
    d51.install(cell);
    const r1: unknown = Reflect.apply(PB.markOpener, undefined, [{ id: "8:1" }]);
    const sole1 = typeof r1 === "object" && r1 !== null && Reflect.get(r1, "sole") === true && ctl() === btn && pair() !== null;
    Reflect.apply(PB.ownDecide, undefined, [{ own: true }]);
    const dropped = ctl() === null;
    const r2: unknown = Reflect.apply(PB.markOpener, undefined, [{ id: "8:1" }]);
    const remembered = typeof r2 === "object" && r2 !== null && Reflect.get(r2, "sole") === false && ctl() === null && pair() === null;
    // not own → kept, and remembered as kept
    const [cell2, btn2] = cellOf("8:3");
    d51.install(cell2);
    Reflect.apply(PB.markOpener, undefined, [{ id: "8:3" }]);
    Reflect.apply(PB.ownDecide, undefined, [{ own: false }]);
    const kept = ctl() === btn2;
    const r3: unknown = Reflect.apply(PB.markOpener, undefined, [{ id: "8:3" }]);
    const keptAgain = typeof r3 === "object" && r3 !== null && Reflect.get(r3, "sole") === false && ctl() === btn2;
    const ok = unmarked === null && noPair && marked === null && cpPair && refused === "<button aria-label=\"Delete crate\">" && cardNoPair && sole1 && dropped && remembered && kept && keptAgain;
    if (!ok) console.log(`    [fix8 D52] ${JSON.stringify({ unmarked, noPair, marked, cpPair, refused, cardNoPair, sole1, dropped, remembered, kept, keptAgain })}`);
    return ok;
  });
  t("[L-4] unitCap: an even share of what is left, never under 15 s, never over what is left", () => {
    const uc = PB.unitCap;
    return !!uc && uc(60_000, 16) === 15_000 && uc(160_000, 4) === 40_000 && uc(10_000, 3) === 10_000 && uc(90_000, 1) === 90_000 && uc(0, 5) === 0;
  });
  t("[M-1/review 4 M-2] taintedPhases: a blocked write taints every check of the unit from its FIRST action on — a commit deferred > 1 s (Enter at 0, Tabs 300…1200, the write at 1100) still taints keyboard.activation; checks before the first action (reach, a11y.landmarks) never", () => {
    const tp = PB.taintedPhases;
    if (!tp) return false;
    const all = "keyboard.activation|,dialog.focus-on-open|,dialog.focus-trap|";
    // review 4's taint-cases: the earliest-within-1-s rule left activation and focus-on-open judged for the write at 1100
    const trace = { phases: [{ seq: 0, keys: ["reach|"] }, { seq: 1, keys: ["keyboard.activation|"] }, { seq: 2, keys: ["dialog.focus-on-open|"] }, { seq: 3, keys: ["dialog.focus-trap|"] }],
      actions: [{ at: 0, seq: 1 }, { at: 300, seq: 3 }, { at: 600, seq: 3 }, { at: 900, seq: 3 }, { at: 1200, seq: 3 }] };
    const pre = { phases: [{ seq: 0, keys: ["reach|"] }, { seq: 1, keys: ["a11y.landmarks|"] }, { seq: 2, keys: ["keyboard.reachable|", "a11y.name|"] }], actions: [{ at: 5000, seq: 2 }] };
    // (called with the write's time too, as the earlier signature took it: the answer must not depend on when the write landed)
    const at = (tr: typeof trace, ms: number): string => { const r: unknown = Reflect.apply(tp, undefined, [tr, ms]); return Array.isArray(r) ? r.join() : ""; };
    return at(trace, 1100) === all && at(trace, 900) === all && at(trace, 5000) === all && at({ ...trace, actions: trace.actions.slice(1) }, 1100) === "dialog.focus-trap|" && at(pre, 5200) === "keyboard.reachable|,a11y.name|";
  });
  t("[H-2] fingerprintDiff: none of the measured tags shown, or > max(5, 20 %) on one side only → what differs; a handful of hover-only / animated nodes → null; nothing measured → null", () => {
    const fd = PB.fingerprintDiff;
    if (!fd) return false;
    const ids = (n: number, p = "1:"): string[] => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const page = ids(30);
    const empty = fd(page, ["0:9"]), half = fd(page, page.slice(0, 15)), few = fd(page, [...page.slice(0, 26), "9:1"]), none = fd([], page);
    return empty !== null && /^30 of 30 measured tag\(s\) not shown: 1:0, 1:1, 1:2, 1:3, 1:4 \+25 more; 1 not on the measured page: 0:9$/.test(empty) && half !== null && /^15 of 30/.test(half) && few === null && none === null
      && fd(["a", "b"], ["c"]) !== null && fd(["a", "b"], ["a"]) === null;
  });
  t("[review 4 L-1] fingerprintDiff: under the threshold, a tag the unit USES (its opener / destination) shown on the measured page and missing now → names it; one not on the measured page (hover-only, inside the closed dialog) or still shown → null", () => {
    const fd = PB.fingerprintDiff;
    if (!fd) return false;
    const ids = (p: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${p}:${i}`);
    // review 4's fingerprint cases: a 120-tag screen whose empty table hides 20 row tags (one of them the opener 8:3), and a
    // 30-tag screen missing its one data row (5 tags, the opener 3:2 among them)
    const big = ids("9", 100), rows20 = ids("8", 20), shell = ids("1", 20), head = ids("2", 5), row = ids("3", 5);
    const empty = fd([...big, ...rows20], big, ["8:3", "5:60"]), oneRow = fd([...shell, ...head, ...row], [...shell, ...head], ["3:2"]);
    return empty === "8:3 — used by this check, shown on the measured page — not shown" && oneRow !== null && /^3:2 — used by this check/.test(oneRow)
      && fd([...big, ...rows20], big) === null && fd([...big, ...rows20], big, ["5:60"]) === null && fd([...big, ...rows20], [...big, ...rows20], ["8:3"]) === null
      && fd([...shell, ...head, ...row], [...shell, ...head], ["1:1"]) === null;
  });
  t("[L-6] the write block's scope is one line naming what is blocked and what is not", () => typeof PB.WRITE_BLOCK_SCOPE === "string" && !PB.WRITE_BLOCK_SCOPE.includes("\n")
    && /GET\/HEAD\/OPTIONS/.test(PB.WRITE_BLOCK_SCOPE) && /service workers/.test(PB.WRITE_BLOCK_SCOPE) && /WebSocket opened inside a worker/.test(PB.WRITE_BLOCK_SCOPE) && /--steps, a GET/.test(PB.WRITE_BLOCK_SCOPE));
  t("[review 4 L-5/M-1/M-3] the scope says: per unit, armed at the first key press, click, scroll, hover or resize; a WebSocket opened then never reaches the server; every check from the first action on; the 12a drive has no write block; a write deferred past the unit's end is not seen", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /^per unit, from its first key press, click, scroll, hover or resize on/.test(w) && /a WebSocket the page opens then never reaches the server/.test(w)
      && /every check of that unit from its first action on not-run/.test(w) && /the drive of the interactions \(no write block there/.test(w)
      && /not seen: a write the page defers past the unit's end \(an undo window over about 1 s\)/.test(w) && /the scroll unit may press that key again/.test(w);
  });
  t("[review 5 L-4] the scope names what the 12a drive does not see at its click point (a closed shadow root, a bare click listener)", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /it does not see a control in a closed shadow root or one that is only a click listener with no role \(a bare svg onclick\), and clicks those\)/.test(w);
  });
  t("[review 6 L-4] the scope names what the 12a drive refuses at its click point — another activating control (also under a focusable glyph or editable label), a label's control, a nested page (iframe, object, embed), open shadow roots included — and the D47/D51 exemption with what counts as the container's own (a CSS mask, a filled block, an in-flow opacity-0 label; not an out-of-flow opacity-0 tooltip)", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /nor one whose click point is another activating control \(also under a focusable glyph or editable label inside it\), a label's control or a nested page \(an iframe, object or embed\) — open shadow roots included — unless it is the sole button-like control of a container showing nothing of its own \(no text, image, icon, CSS mask, generated content, filled block, progress bar, meter or list marker; a label at opacity 0 in flow counts, an out-of-flow tooltip at opacity 0 does not\)/.test(w)
      && !/a label's control or an iframe — open shadow roots included/.test(w);
  });
  t("[fix8 D52/fix9 D53/fix10 D54] the scope names the pixel rule of the D47/D51 exemption — only the control hidden against all the container's content hidden (shadow content, its marker, its other pseudo-elements), the outside and its ancestors hidden in both, the opener hovered first, any painted difference counts, decoration only when pixel-verified plain against the real outline with filters off, its own background image / two-colour border / stripe, a scroll button and a label laid over it from outside count, a page !important that beats the probe refuses — and every known miss", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /by its DOM nor by its pixels \(the container with only that control hidden against it with all its content hidden — the content of its open shadow roots, its own marker and its other pseudo-elements \(a first letter, a placeholder, a file button, a details' content, scroll buttons and markers\) too — everything outside it, its ancestors included, hidden in both, the opener hovered first so a control shown on hover is at its click point — any painted difference counts, a stripe or a 1-px divider too;/.test(w)
      && /decoration: its own background colour, a border in one colour \(a 1-px divider on one side too\) and its shadow, and a fill over all of it or a wrapper within 8 px of the control only when, alone \(ancestor and own filters, clip-paths and masks off\), they paint one plain colour \(pixel-verified against their real rounded outline, a 1.5-px anti-aliased edge allowed; a progress ring, a wrapper with its own shadow or a frame in another colour is not plain, so refused\);/.test(w)
      && /content too: its own background image \(a gradient, a url\), a border in two colours or a stripe, a scroll button, and a label, image or generated label laid at least half over it from outside its element \(a sibling, an ancestor's ::after\) unless fixed or sticky \(a toast, a banner: ignored\) or proven to lie under its opaque background; an ancestor's own paint \(a row's gradient behind a transparent cell\) is not its own;/.test(w)
      && /a page rule keeping something showing against the probe's \(an inline or cascade-layer !important\) refuses; not seen: the inside of an iframe, a closed shadow root, foreign content inside an ancestor's shadow root, a shadow root attached after the check starts, a part of the container still outside the viewport once scrolled in, content revealed after a delay, a generated label of an element lying elsewhere; the probe's init CSS is lost when a page replaces document.adoptedStyleSheets after load under a strict style CSP; an sr-only label at right:-9999px in a right-to-left page counts, so that cell is refused; the hover runs on every opener, so a mouseenter side effect also fires on one it then refuses\)/.test(w)
      && /only a click listener with no role \(a bare svg onclick\), and clicks those/.test(w)
      && !/a 1-px anti-aliased edge allowed/.test(w) && !/decoration: its own background, border and shadow/.test(w);
  });
  t("[fix11 D55, review 10 L-6] the scope names D55 for the same exemption (own inset shadow / two-colour ring / mask or clip-path paint = content; the control's tooltip and a label at opacity 0 never foreign; under it only without opacity / blend), the re-mount refusal, what is refused by rule (500,000 elements, a shadow-root opener, a role-less tooltip, an oklch background), what is not seen, the focused element shown, and that a refusal names its reason", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /fires on one it then refuses\); the same exemption, content too — its own inset box-shadow offset 2 px or more or blurred \(a stripe, a fill, a glow\), sharp box-shadow ring layers in more than one colour \(not its border, not a layer in its own background colour where that cannot show — an outer one, a ring-offset, or an inset one over an opaque border-box \/ padding-box background\) and its own paint under a mask or a clip-path other than a rounded inset\(0\);/.test(w)
      && /never foreign — a tooltip revealed by the probe's hover \(a \[role=tooltip\] element, or the control's aria-describedby target, not shown before the hover; one already on screen is its own label and refuses\) and a label at effective opacity 0; under it only with no opacity below 1 or blend mode on it or above it; an element the page mounts in it during the screenshots refuses;/.test(w)
      && /refused by rule: a page of more than 500,000 elements, an opener whose content is re-created while it is compared \(an empty spacer a framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on mouseleave; it can differ between runs\), an opener inside a shadow root, a role-less tooltip or other popover laid over it \(with a show delay the result can differ between runs\), a cell whose sole control has a tooltip pre-mounted but hidden by transform scale\(0\) or moved off-screen \(it counts as shown before the hover\), a label under an oklch\(\) \/ lab\(\) \/ color\(\) background \(never proven opaque\);/.test(w)
      && /not seen \(known misses, the drive can write\): a sibling's relative ::before shifted over it from elsewhere, text overflowing a 0-height wrapper beside it, [^;]*; the focused element outside it stays shown in both shots; a refusal names its reason;/.test(w);
  });
  t("[fix12 D56, review 11 L-1/L-2] the scope says the tooltip exemption is only for one the probe's hover revealed (one on screen before refuses), the ring rule counts ring layers only (not the border, not a ring-offset in the background colour), and an opener whose content is re-created while it is compared is refused", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /never foreign — a tooltip revealed by the probe's hover \(a \[role=tooltip\] element, or the control's aria-describedby target, not shown before the hover; one already on screen is its own label and refuses\)/.test(w)
      && /ring layers in more than one colour \(not its border, not a layer in its own background colour where that cannot show — an outer one, a ring-offset, or an inset one over an opaque border-box \/ padding-box background\)/.test(w)
      && /an opener whose content is re-created while it is compared \(an empty spacer a framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on mouseleave; it can differ between runs\)/.test(w)
      && !/the sole control's own tooltip/.test(w) && !/its border's included/.test(w);
  });
  t("[fix13 D57, review 12 H-1/H-2/M-1/M-2/L-1] the scope says a background-coloured ring layer is ignored only where it cannot show, a tooltip pre-mounted at scale(0) or off-screen is refused by rule, and a display: contents tooltip, a label re-created on the hover with tooltip semantics and a page-defined window.__dtTipPre are not seen", () => {
    const w = PB.WRITE_BLOCK_SCOPE ?? "";
    return /not a layer in its own background colour where that cannot show — an outer one, a ring-offset, or an inset one over an opaque border-box \/ padding-box background\)/.test(w)
      && /refused by rule:[^]*?a cell whose sole control has a tooltip pre-mounted but hidden by transform scale\(0\) or moved off-screen \(it counts as shown before the hover\)/.test(w)
      && /not seen \(known misses, the drive can write\):[^;]*, a display: contents \[role=tooltip\] or aria-describedby target laid over it, a label the page re-creates as a new element on the hover with tooltip semantics \(role=tooltip, or the control's aria-describedby target\), and a page that defines window.__dtTipPre itself first turns the record of what was shown before the hover off \(an adversarial page\);/.test(w)
      && !/not a layer in its own background colour — a ring-offset\)/.test(w);
  });
  t("[D40(8) write block] judgeWrites: a check during which the page tried to write is not-run 'the page tried to write (POST /path) — blocked; not judged' (pass or fail alike); a variant-less phase covers every variant; other checks untouched", () => {
    const jw = PB.judgeWrites;
    if (!jw) return false;
    const rows: BehaviourCheckRow[] = [
      { id: "keyboard.activation", status: "fail", nodeId: "9:1", detail: "x" }, { id: "dialog.focus-return", status: "pass", nodeId: "9:1", variant: "escape", detail: "y" },
      { id: "dialog.focus-return", status: "pass", nodeId: "9:1", variant: "close", detail: "z" }, { id: "dialog.scroll-open", status: "fail", nodeId: "9:1", variant: "y=150", detail: "w" }];
    const out = jw(rows, [{ method: "POST", url: "http://h/mutate", phases: ["keyboard.activation|"] }, { method: "PUT", url: "http://h/save", phases: ["dialog.escape-closes|", "dialog.focus-return|escape"] }, { method: "POST", url: "http://h/x", phases: ["dialog.scroll-open|"] }]);
    return out[0]?.status === "not-run" && /^not-run: the page tried to write \(POST \/mutate\) — blocked; not judged$/.test(out[0].detail) && out[0].evidence?.was === "fail"
      && out[1]?.status === "not-run" && /PUT \/save/.test(out[1].detail) && out[2]?.status === "pass" && out[3]?.status === "not-run";
  });
  // review 5 L-1: a page that reopens its WebSocket on every close tried ~1600 times in a unit — the unit keeps its first 20
  // attempts and counts the rest (the count still shows in the not-run row's "+N more")
  t("[review 5 L-1] logTried keeps the first TRIED_CAP (20) write attempts and counts the rest; blockedOf hands the count on; judgeWrites' '+N more' includes it", () => {
    const { logTried, blockedOf, judgeWrites, TRIED_CAP } = PB;
    if (!logTried || !blockedOf || !judgeWrites || TRIED_CAP !== 20) return false;
    const log: { list: Array<{ method: string; url: string }>; more: number } = { list: [], more: 0 };
    const kept = Array.from({ length: 1600 }, () => logTried(log, "WebSocket", "ws://h/ws"));
    const blocked = blockedOf(log, ["keyboard.activation|"]);
    const out = judgeWrites([{ id: "keyboard.activation", status: "pass", nodeId: "9:1", detail: "x" }], blocked);
    return kept.filter(Boolean).length === 20 && kept[19] === true && kept[20] === false && log.list.length === 20 && log.more === 1580
      && blocked.length === 20 && blocked[19]?.more === 1580 && blocked[0]?.more === undefined
      && /^not-run: the page tried to write \(WebSocket \/ws \+1599 more\) — blocked; not judged$/.test(out[0]?.detail ?? "") && ((bw) => Array.isArray(bw) && bw.length <= 5)(out[0]?.evidence?.blockedWrites);
  });
  t("[M7] the reserve covers the worst teardown: a cut unit's settle + both capped close steps + the kill's capped ps + a write margin (≥ 2 s) — so a wedged browser never turns a finished measurement into exit 4", () => {
    const { BEHAVIOUR_RESERVE_MS: r, CUT_SETTLE_MS: c, CLOSE_STEP_CAP_MS: k, WRITE_MARGIN_MS: w, PS_CAP_MS: ps } = PB;
    return r !== undefined && c !== undefined && k !== undefined && w !== undefined && ps !== undefined && w >= 2000 && r >= c + 2 * k + ps + w && (PB.behaviourBudget?.(0, 60_000) ?? -1) === 60_000 - r;
  });
  t("[M2] nameStatus: a titled iframe passes on its DOM name (`- iframe` never carries one), an untitled one fails; <summary> (`- text: …`) passes on its text; an unnamed group passes (its name is optional); an unnamed button fails", () => {
    const ns = PB.nameStatus;
    if (!ns) return false;
    return ns("- iframe", { tag: "iframe", domName: "Map" }).status === "pass" && ns("- iframe", { tag: "iframe", domName: null }).status === "fail"
      && ns("- text: Tray rules", { tag: "summary", domName: "Tray rules" }).status === "pass" && ns("- group: Tray A · Tray B", { tag: "div", domName: null }).status === "pass"
      && ns("- button", { tag: "button", domName: null }).status === "fail" && ns("- text: x", { tag: "div", domName: null }).status === "warn" && ns("- link \"Home\":", { tag: "a", domName: null }).status === "pass";
  });
  // facts.md §1, verbatim (Chromium 153 / Playwright 1.63)
  const FACTS_YAML = [
    "- main:",
    "  - navigation \"Primary\": a",
    "  - navigation \"Footer\": b",
    "  - region \"Plots\":",
    "    - region \"Plots list\":",
    "      - heading \"x\" [level=2]",
    "  - paragraph: unnamed",
    "  - text: h f",
    "  - complementary: s",
    "  - form \"F\"",
  ].join("\n");
  t("[F-115] parseAriaLandmarks: facts §1's snapshot → main, 2 named navigations, region Plots > region Plots list, complementary, form F (depth = indent/2)", () => {
    const p = PB.parseAriaLandmarks;
    const l = p ? p(FACTS_YAML) : null;
    return l !== null && JSON.stringify(l) === JSON.stringify([
      { role: "main", name: null, depth: 0 }, { role: "navigation", name: "Primary", depth: 1 }, { role: "navigation", name: "Footer", depth: 1 },
      { role: "region", name: "Plots", depth: 1 }, { role: "region", name: "Plots list", depth: 2 }, { role: "complementary", name: null, depth: 1 }, { role: "form", name: "F", depth: 1 }]);
  });
  const findings = (yaml: string, unnamed: string[] = []): Array<{ status: string; detail: string }> => {
    const tree = PB.parseAriaLandmarkTree ? PB.parseAriaLandmarkTree(yaml) : null;
    return PB.landmarkFindings ? PB.landmarkFindings(tree, unnamed) : [];
  };
  t("[F-115] landmarkFindings on facts §1: exactly one warn — region \"Plots list\" inside \"Plots\" repeats its name", () => {
    const f = findings(FACTS_YAML);
    return f.length === 1 && f[0]?.status === "warn" && /"Plots list" sits inside region "Plots"/.test(f[0].detail);
  });
  t("[F-115] two main → fail; none → warn; 7 regions → warn; a duplicate named landmark → warn; 2 navigations one unnamed → warn; an unnamed [role=region] → warn", () => {
    const two = findings("- main:\n  - text: a\n- main:\n  - text: b");
    const none = findings("- banner:\n  - text: a");
    const seven = findings(["- main:", ...[1, 2, 3, 4, 5, 6, 7].map((i) => `  - region "R${i}"`)].join("\n"));
    const dup = findings("- main:\n  - complementary \"Filters\"\n  - complementary \"Filters\"");
    const navs = findings("- navigation \"Primary\"\n- navigation\n- main");
    const unnamed = findings("- main", ["html > body > div:nth-child(1)"]);
    return two.some((r) => r.status === "fail" && /2 main/.test(r.detail)) && none.some((r) => r.status === "warn" && /no main/.test(r.detail))
      && seven.some((r) => r.status === "warn" && /7 region/.test(r.detail)) && dup.some((r) => r.status === "warn" && /2 complementary/.test(r.detail))
      && navs.some((r) => r.status === "warn" && /navigation landmarks, 1 unnamed/.test(r.detail)) && unnamed.some((r) => r.status === "warn" && /role="region" and no accessible name/.test(r.detail));
  });
  t("[F-115] a region under a NON-landmark sibling is not nested in the region before it (the tree, not the order, decides)", () => {
    const f = findings("- main:\n  - region \"Trays\":\n    - text: a\n  - paragraph:\n    - region \"Trays list\"");
    return f.length === 1 && f[0]?.status === "pass";
  });
  t("[F-115] an unparseable snapshot → a11y.landmarks not-run (the format is unversioned); an empty one → 0 landmarks (no main: warn)", () => {
    const g = findings("%%% this is not an aria snapshot");
    const e = findings("");
    return g.length === 1 && g[0]?.status === "not-run" && e.length === 1 && e[0]?.status === "warn";
  });
  t("[F-110] parseAriaName on facts-12b §3's first lines: named / unnamed / escaped / link with a colon / cell / text / empty", () => {
    const n = PB.parseAriaName;
    if (!n) return false;
    const eq = (s: string, role: string | null, name: string | null): boolean => { const r = n(s); return r.role === role && r.name === name; };
    return eq("- button \"Save\"", "button", "Save") && eq("- button", "button", null) && eq("- button \"He said \\\"hi\\\" \\\\ ok\": x", "button", "He said \"hi\" \\ ok")
      && eq("- link \"Link\":\n  - /url: \"#\"", "link", "Link") && eq("- link:", "link", null) && eq("- cell \"cell\"", "cell", "cell") && eq("- combobox \"Pick\":", "combobox", "Pick")
      && eq("- text: focus me", null, null) && eq("", null, null) && eq("- checkbox", "checkbox", null);
  });
  t("[F-117] scrimMatches: #00000066 = rgba(0, 0, 0, 0.4), ≠ rgba(0, 0, 0, 0); no scrim designed = transparent built; Tailwind v4 oklab(0 0 0 / 0.25) = #00000040", () => {
    const m = PB.scrimMatches;
    return !!m && m("#00000066", "rgba(0, 0, 0, 0.4)") && !m("#00000066", "rgba(0, 0, 0, 0)") && m(null, "rgba(0, 0, 0, 0)") && m(null, null) && !m(null, "rgba(0, 0, 0, 0.4)")
      && m("#00000040", "oklab(0 0 0 / 0.25)") && !m("#00000066", "rgba(40, 0, 0, 0.4)") && !m("#00000066", "rgba(0, 0, 0, 0.5)") && !m("not-a-colour", "rgba(0, 0, 0, 0.4)");
  });
  t("[F-117] parseCssColor: oklch red → rgb(255, 0, 0); color(srgb …) with alpha; rgb() space syntax with a % alpha", () => {
    const c = parseCssColor;
    const red = c("oklch(0.628 0.2577 29.23)"), s = c("color(srgb 1 0 0 / 0.5)"), r = c("rgb(0 0 0 / 40%)");
    return red !== null && red.r === 255 && red.g === 0 && red.b === 0 && s !== null && s.a === 0.5 && r !== null && r.a === 0.4;
  });
  t("[F-116] centredIn: ±1 px per axis; a rect (nearly) as tall as the viewport skips the vertical axis", () => {
    const c = PB.centredIn;
    return !!c && c({ x: 430, y: 316, w: 420, h: 168 }, { w: 1280, h: 800 }).centred && !c({ x: 432, y: 316, w: 420, h: 168 }, { w: 1280, h: 800 }).centred
      && !c({ x: 430, y: 166, w: 420, h: 168 }, { w: 1280, h: 800 }).centred && c({ x: 430, y: 0, w: 420, h: 799 }, { w: 1280, h: 800 }).v === null && c({ x: 430, y: 0, w: 420, h: 799 }, { w: 1280, h: 800 }).centred;
  });
  t("[F-116/MED5] overlayCentred: position center, or from:\"default\" (Figma's default is centred) — a plan row without overlay settings is not", () => {
    const o = PB.overlayCentred;
    return !!o && o({ position: "center", from: "export" }) && o({ position: "top_left", from: "default" }) && !o({ position: "bottom_center", from: "export" }) && !o(undefined);
  });
  t("[D40(8)] safeCloseName: Cancel / × / Not now / aria-label Close (… dialog) are safe; Save, Delete crate, Close account (text or aria-label) never", () => {
    const s = PB.safeCloseName;
    return !!s && s("Cancel", null) && s("×", "Close") && s(" Not now ", null) && s("Close Edit crate dialog", "Close Edit crate dialog") && s("x", null)
      && !s("Save", null) && !s("Delete crate", null) && !s("Close account", null) && !s("Close account", "Close account") && !s("Delete", "Delete crate");
  });
  t("[D46] axeStatus: critical/serious → fail, moderate/minor only → warn, none → pass", () => {
    const a = PB.axeStatus;
    return !!a && a([{ impact: "serious" }, { impact: "minor" }]) === "fail" && a([{ impact: "critical" }]) === "fail" && a([{ impact: "moderate" }, { impact: null }]) === "warn" && a([]) === "pass";
  });
  t("[DT-60] focusReturnStatus: visible opener → pass; opacity 0 while focused → warn; hidden opener / BODY → fail; opener removed → pass only on a visible non-body element", () => {
    const f = PB.focusReturnStatus;
    if (!f) return false;
    const base = { connected: true, openerVisible: true, opacity0: false, onOpener: true, activeIsBody: false, activeVisible: true, activeDesc: "<button>" };
    return f(base).status === "pass" && f({ ...base, opacity0: true }).status === "warn" && f({ ...base, openerVisible: false }).status === "fail"
      && f({ ...base, onOpener: false, activeIsBody: true, activeVisible: false }).status === "fail" && /<body>/.test(f({ ...base, onOpener: false, activeIsBody: true }).detail)
      && f({ ...base, connected: false, onOpener: false }).status === "pass" && f({ ...base, connected: false, onOpener: false, activeIsBody: true, activeVisible: false }).status === "fail";
  });
  // the in-page read, on a fake DOM: a visibility:hidden opener is NOT visible (checkVisibility needs visibilityProperty —
  // its default ignores visibility, facts.md §5), and an opacity-0 ancestor is seen
  t("[DT-60] focusReturnRead(): focus on a visibility:hidden opener → openerVisible false; on an opacity-0 one → opacity0 true", () => {
    const fr = PB.focusReturnRead;
    if (!fr) return false;
    const mk = (hidden: boolean, opacity: string): ReturnType<typeof fr> => {
      const rect = { x: 0, y: 0, width: 40, height: 20, right: 40, bottom: 20 };
      const opener: Record<string, unknown> = { tagName: "BUTTON", id: "", isConnected: true, parentElement: null, textContent: "Edit",
        getAttribute: () => null, getClientRects: () => [rect], getBoundingClientRect: () => rect, contains: (o: unknown) => o === opener,
        closest: () => opener, checkVisibility: (o?: { visibilityProperty?: boolean; checkVisibilityCSS?: boolean; opacityProperty?: boolean }) => !(hidden && (o?.visibilityProperty || o?.checkVisibilityCSS)) };
      Object.assign(globalThis, { window: { __dtBeh: { opener } }, document: { activeElement: opener, body: {}, documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => opacity }) });
      return Reflect.apply(fr, undefined, [null]);
    };
    const hiddenRead = mk(true, "1"), faded = mk(false, "0"), shown = mk(false, "1");
    return hiddenRead.onOpener && !hiddenRead.openerVisible && faded.openerVisible && faded.opacity0 && shown.openerVisible && !shown.opacity0;
  });
  t("[12b] perElement: ≤ 20 non-pass rows (fail first), then one '+N more' row per status with evidence.count, then one aggregate pass row 'k of n'", () => {
    const pe = PB.perElement;
    if (!pe) return false;
    const mk = (st: "fail" | "warn", i: number): BehaviourCheckRow => ({ id: "a11y.name", status: st, target: `#e${i}`, detail: st });
    const r = pe("a11y.name", [...[1, 2, 3].map((i) => mk("warn", i)), ...Array.from({ length: 25 }, (_, i) => mk("fail", i))], 10, 38, "named");
    const more = r.filter((x) => /^\+\d+ more/.test(x.detail));
    return r.length === 23 && r.slice(0, 20).every((x) => x.status === "fail") && more.length === 2 && more[0]?.evidence?.count === 5 && more[1]?.evidence?.count === 3 && more.every((x) => x.evidence?.more === true)
      && r.at(-1)?.status === "pass" && r.at(-1)?.detail === "10 of 38 named" && pe("a11y.name", [], 0, 0, "x").length === 0;
  });
  t("[D40(1)/M3] batteryRows: rows 12a opened by a real mouse click without a load — a destination-tag detection INCLUDED (its modal root may be a 0-px Headless UI wrapper: the battery's own check decides); synthetic, cut, opened nothing, a load, not driven, a popover → skipped with why", () => {
    const br = PB.batteryRows;
    if (!br) return false;
    const reaction = (dest: string): NonNullable<NodeInput["reactions"]> => [{ trigger: "on_click", actions: [{ type: "node", destinationId: dest, destination: "Crate Form", navigation: "overlay" }] }];
    const ids = ["9:11", "9:12", "9:13", "9:14", "9:15", "9:16", "9:17", "9:18"];
    const e = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "9:1", name: "Crates", box: { x: 0, y: 0, w: 800, h: 600 },
      children: ids.map((id) => ({ type: "FRAME" as const, id, name: `Opener ${id}`, box: { w: 80, h: 32 }, reactions: reaction("9:60") })) }]), label: "Crates" }]);
    const opened = { selector: "html > body > dialog", modal: true, position: "fixed", rect: { x: 0, y: 0, w: 10, h: 10 }, scrollY: 0 };
    const ev = (nodeId: string, extra: Partial<InteractionEvidence>): InteractionEvidence => ({ nodeId, trigger: "on_click", ok: true, activation: "mouse", navEvents: 0, opened, ...extra });
    const driven: InteractionEvidence[] = [ev("9:11", {}), ev("9:12", { activation: "synthetic", ok: null }), { nodeId: "9:13", trigger: "on_click", ok: null, cut: "budget", detail: "not-run: time budget" },
      { nodeId: "9:14", trigger: "on_click", ok: null, activation: "mouse", navEvents: 0, detail: "clicked: nothing opened" }, ev("9:15", { navEvents: 1, ok: null }),
      ev("9:17", { detectedBy: "destination-tag", opened: { ...opened, modal: false, position: "fixed" } }), ev("9:18", { detectedBy: ":popover-open" })];
    const r = br(e, driven);
    const why = (id: string): string => r.skipped.find((x) => x.row.nodeId === id)?.why ?? "";
    return r.battery.map((x) => x.nodeId).join() === "9:11,9:17" && /synthetic/.test(why("9:12")) && /popover/.test(why("9:18")) && /time budget/.test(why("9:13")) && /opened nothing/.test(why("9:14"))
      && /document load/.test(why("9:15")) && /not driven/.test(why("9:16"));
  });
  t("[axe] readAxeResult types the page's answer (non-strings dropped, ≤ 3 targets); a non-result → ran:false", () => {
    const ra = PB.readAxeResult;
    if (!ra) return false;
    const r = ra({ version: "4.13.0", violations: [{ id: "button-name", impact: "critical", nodes: 2, help: "Buttons must have discernible text", targets: ["#a", "#b", "#c", "#d", 5] }, { id: "region", impact: null, nodes: 1, help: "", targets: [] }] }, "x");
    return r.ran && r.version === "4.13.0" && r.violations.length === 2 && r.violations[0]?.targets.length === 3 && r.violations[1]?.impact === null && ra(null, "x").ran === false;
  });
});
t("[axe/D40(5)] resolveAxe: the PROJECT's axe-core (here the repo's devDependency) with its version; a project without it → not installed (optional)", () => {
  const ra = (VP as Partial<typeof VP>).resolveAxe;
  if (!ra) return false;
  const repo = ra(path.join(import.meta.dirname, ".."));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dt-noaxe-"));
  fs.writeFileSync(path.join(empty, "package.json"), "{}\n");
  const none = ra(empty);
  fs.rmSync(empty, { recursive: true, force: true });
  return repo.ok && /^\d+\.\d+\.\d+$/.test(repo.version) && repo.source.length > 100_000 && !none.ok && none.why === "axe-core not installed in the project (optional)";
});
t("[D45] behaviourLine: --behaviour off says so; a run lists fail/warn/pass/not-run, axe, time and CUT", () => {
  const bl = (VP as Partial<typeof VP>).behaviourLine;
  if (!bl) return false;
  const cutLine = bl({ version: 1, ran: true, browser: { name: "chromium", version: "1" }, namesComputedBy: "x", budgetMs: 30_000, elapsedMs: 30_000, cut: true,
    checks: [{ id: "a11y.name", status: "fail", detail: "x" }, { id: "a11y.axe", status: "not-run", detail: "y" }], landmarks: [], axe: { ran: false, why: "axe-core not installed in the project (optional)" }, widths: [], artifacts: [] });
  return bl({ version: 1, ran: false, why: "--behaviour off" }) === "behaviour not run (--behaviour off)" && /^behaviour \(not the fidelity verdict\) 1 fail · 0 warn · 0 pass · 1 not run/.test(cutLine) && /CUT by the time budget/.test(cutLine);
});

// O-1 (12b fix 7): after Browser.close the handle is disconnected at once while the browser process (under load) can take minutes
// to exit, and the probe waits on its pipes past --max-time — closeCapped SIGKILLs a still-running browser child however the
// handle reads. A fake browser (its close done, disconnected) and a real direct child whose command names a headless shell.
if (process.platform !== "win32") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "dt-fake-headless-shell"], { stdio: "ignore" });
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  await new Promise<void>((resolve) => { child.once("spawn", () => resolve()); });
  const fake = { newBrowserCDPSession: () => Promise.reject(new Error("browser has disconnected")), close: () => Promise.resolve(), isConnected: () => false };
  let threw = false;
  try { await VP.closeCapped(fake, 200); } catch { threw = true; }
  const gone = await Promise.race([exited, sleep(3000).then(() => false)]);
  if (!gone) child.kill("SIGKILL");
  check(`[O-1] closeCapped: a browser child still running after the close (the handle already disconnected) is SIGKILLed (${gone ? "gone" : "still running after 3 s"}${threw ? ", closeCapped threw" : ""})`, gone && !threw);
}

check("[LAUNCH_ARGS] the probe's chromium flags include --disable-lcd-text (grayscale text AA; the e2e suites that render references import the same list)", VP.LAUNCH_ARGS.includes("--disable-lcd-text"));

report();
