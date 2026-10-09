// what --compare does with the probe's behaviour/a11y block: report.behaviour (always written),
// the second headline, the md section, the CLI line, the lenient guard, and that behaviour never reaches the verdict.
// Expectations come from the real `buildExpectation` over plugin-shaped screen exports (test/fixtures.ts). Invented names.
// Run with:  node test/verify-behaviour.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compare, reportToMarkdown, probeLine } from "../design-to-code/verify-screen.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { STYLE_KEYS } from "../design-to-code/verify-shared.ts";
import * as verifyScreen from "../design-to-code/verify-screen.ts";
import type { ExpectInput, ExpectOptions } from "../design-to-code/verify-expect.ts";
import * as guards from "../design-to-code/doc-guards.ts";
import { isVerifyMeasured, isVerifyReport, readableMeasured } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { BehaviourCheck, MeasuredBehaviour, MeasuredNode, MeasuredStyles, ProbeIdentity, ReportBehaviour, ScreenDoc, VerifyMeasured, VerifyReportV2, VerifySpec } from "../design-to-code/types.ts";
import { malformed, screenExport } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
// (looked up by name so this file runs — and fails cleanly — against a verify-screen that predates them)
// (namespace lookups: a namespace read of a missing export is undefined, where a named import would refuse to link)
const ns: Record<string, unknown> = { ...verifyScreen, ...guards };
const has = (name: string): boolean => typeof ns[name] === "function";
const headlineFn = has("behaviourHeadline") ? verifyScreen.behaviourHeadline : null;
const guard = (x: unknown): boolean => has("isMeasuredBehaviour") && guards.isMeasuredBehaviour(x);

// ---------------------------------------------------------------- the "Seed Shelf" screen (invented)
const SHELF = "Seed Shelf";
const btn = (id: string, name: string, dest?: string): NodeInput =>
  ({ type: "FRAME", id, name, fills: [{ type: "solid", color: "#2a6f3a" }], ...(dest ? { reactions: [{ trigger: "on_click", actions: [{ type: "NODE", navigation: "overlay", destinationId: dest }] }] } : {}) });
const CRATES: NodeInput = {
  type: "FRAME", id: "80:1", name: "Crates", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }], children: [
    { type: "TEXT", id: "80:2", name: "Title", text: "Crates", font: { family: "Inter", size: 20, color: "#111111" } },
    btn("80:12", "Edit Crate", "80:60"),
    btn("80:13", "Sort Crates"),
  ],
};
const screen: ExpectInput = { doc: screenExport([CRATES], { exportedAt: "2026-10-02T00:00:00Z", screen: "Crates", nodeId: "80:1", sourceFile: SHELF }), label: "Crates__80_1" };
const form: ScreenDoc = screenExport([{ type: "FRAME", id: "80:60", name: "Crate Form", box: { x: 0, y: 0, w: 480, h: 320 }, fills: [{ type: "solid", color: "#ffffff" }], overlay: { position: "center", closeOnClickOutside: true, background: "#00000066" } }],
  { exportedAt: "2026-10-02T00:00:00Z", screen: "Crate Form", nodeId: "80:60", sourceFile: SHELF });
const OPTS: ExpectOptions = {
  index: { layers: [{ id: "80:1", name: "Crates", file: "pages/Main/Crates__80_1.json", sourceFile: SHELF }, { id: "80:60", name: "Crate Form", file: "pages/Main/Crate_Form__80_60.json", sourceFile: SHELF }] },
  readSibling: (f) => (f === "pages/Main/Crate_Form__80_60.json" ? form : null),
};
const exp = buildExpectation([screen], OPTS);

const PROBE: ProbeIdentity = { name: "verify-probe", version: "1.0.0", sha256: "b".repeat(64), playwright: { package: "playwright", version: "1.63.0" }, browser: { name: "chromium", version: "153.0" } };
function echo(spec: VerifySpec): MeasuredNode {
  const styles: MeasuredStyles = {};
  const src: Record<string, unknown> = { ...spec };
  for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; }
  // one real delta so the fidelity side of the report is not trivially empty
  if (spec.nodeId === "80:13") styles.backgroundColor = "#aa2222ff";
  return { nodeId: spec.nodeId, styles, matchedBy: "tag" };
}
const base = (extra: Partial<VerifyMeasured> = {}): VerifyMeasured => ({
  measuredAt: "2026-10-02T01:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", probe: PROBE, nodes: exp.nodes.map(echo),
  interactions: [{ nodeId: "80:12", trigger: "on_click", ok: true, selector: "[data-dt-node=\"80:12\"]", selectorCount: 1, outcome: "dialog-opened", navEvents: 0 }], ...extra,
});
const row = (id: string, status: BehaviourCheck["status"], detail: string, more: Partial<BehaviourCheck> = {}): BehaviourCheck => ({ id, status, detail, ...more });
const ran = (checks: BehaviourCheck[], more: { axe?: Extract<MeasuredBehaviour, { ran: true }>["axe"]; artifacts?: string[]; cut?: boolean } = {}): MeasuredBehaviour => ({
  version: 1, ran: true, browser: { name: "chromium", version: "153.0" }, namesComputedBy: "Playwright (Chromium) — computed, not screen-reader verified", budgetMs: 90000, elapsedMs: 4200,
  cut: more.cut ?? false, checks, landmarks: [{ role: "main", name: null, depth: 0 }], axe: more.axe ?? { ran: true, package: "axe-core", version: "4.13.0", violations: [] }, widths: [], artifacts: more.artifacts ?? [],
});
// every check fails: the worst a behaviour block can say
const ALL_FAIL = ran(["dialog.focus-return", "dialog.focus-trap", "keyboard.reachable", "a11y.axe", "forced-colors.visible", "overflow.narrow"].map((id) => row(id, "fail", `${id} failed`, { nodeId: "80:12" })),
  { axe: { ran: true, package: "axe-core", version: "4.13.0", violations: [{ id: "button-name", impact: "critical", nodes: 1, help: "Buttons must have discernible text", targets: ["#crate-edit"] }] }, cut: true });
const MIXED = ran([
  row("keyboard.focus-visible", "pass", "12 of 12 stops draw a focus indicator", { evidence: { count: 12 } }),
  row("dialog.scrim", "warn", "backdrop rgba(0, 0, 0, 0) vs designed #00000066", { nodeId: "80:12", trigger: "on_click", variant: "y=0" }),
  row("dialog.focus-return", "fail", "focus on BODY after Escape | opener hidden", { nodeId: "80:12", trigger: "on_click", variant: "escape" }),
  row("dialog.nested-escape", "not-run", "native picker: synthetic (headless), not a real-browser observation", { nodeId: "80:12", synthetic: true }),
  row("forced-colors.visible", "unsupported", "forced colours: Chromium only"),
  row("future.check", "pass", "an id this reader does not know is kept"),
  row("keyboard.reachable", "fail", "not reached by Tab (visibility: hidden at rest)", { nodeId: "80:12" }),
], { artifacts: ["design/verify/Crates__80_1.forced-colors.png"] });

const strip = (r: VerifyReportV2): string => { const { behaviour: _b, ...rest } = r; return JSON.stringify(rest); };
const behaviourOf = (r: VerifyReportV2): ReportBehaviour | undefined => { const b: unknown = r.behaviour; return b && typeof b === "object" ? r.behaviour : undefined; };

// ---------------------------------------------------------------- behaviour never reaches the verdict
console.log("behaviour never reaches the fidelity verdict:");
{
  const without = compare(exp, base());
  const failing = compare(exp, base({ behaviour: ALL_FAIL }));
  safe("the fixture's fidelity side is not empty (a real delta, an interaction) — so the invariance means something", () => without.deltas.length > 0 && without.interactions.length > 0);
  safe("same measured with and without an all-fail behaviour block → verdict, why, integrity, summary, coverage, deltas, headline identical", () =>
    failing.verdict === without.verdict && JSON.stringify(failing.why) === JSON.stringify(without.why) && JSON.stringify(failing.integrity) === JSON.stringify(without.integrity)
    && JSON.stringify(failing.summary) === JSON.stringify(without.summary) && JSON.stringify(failing.coverage) === JSON.stringify(without.coverage)
    && JSON.stringify(failing.deltas) === JSON.stringify(without.deltas) && failing.headline === without.headline);
  safe("…and the whole report is identical except report.behaviour", () => strip(failing) === strip(without) && behaviourOf(failing)?.summary.fail === 6);
  safe("…the fidelity headline never carries the behaviour line", () => !/BEHAVIOUR/.test(failing.headline));
}

// ---------------------------------------------------------------- report.behaviour, always written
console.log("report.behaviour — always written, counted by row, sorted:");
{
  const none = compare(exp, base());
  const b0 = behaviourOf(none);
  safe("no behaviour block → report.behaviour {ran:false, why 'carries no behaviour checks', zero summary, no checks}", () =>
    !!b0 && b0.ran === false && /the measured file carries no behaviour checks \(hand-written, or a probe that predates the behaviour checks\)/.test(b0.why ?? "")
    && JSON.stringify(b0.summary) === JSON.stringify({ pass: 0, fail: 0, warn: 0, notRun: 0, unsupported: 0 }) && b0.checks.length === 0);
  safe("…its headline says 'not run (…)'", () => !!b0 && b0.headline === "BEHAVIOUR/A11Y (not the fidelity verdict) — not run (the measured file carries no behaviour checks (hand-written, or a probe that predates the behaviour checks))");
  const off = behaviourOf(compare(exp, base({ behaviour: { version: 1, ran: false, why: "--behaviour off" } })));
  safe("--behaviour off → ran:false, why '--behaviour off', headline 'not run (--behaviour off)'", () =>
    !!off && off.ran === false && off.why === "--behaviour off" && off.headline.endsWith("— not run (--behaviour off)"));
  const mixed = compare(exp, base({ behaviour: MIXED }));
  const b = behaviourOf(mixed);
  safe("summary counts ROWS by status (an aggregate 'k of n' pass row counts once, an unknown id is kept)", () =>
    !!b && JSON.stringify(b.summary) === JSON.stringify({ pass: 2, fail: 2, warn: 1, notRun: 1, unsupported: 1 }) && b.checks.some((c) => c.id === "future.check"));
  safe("checks sorted fail > warn > not-run > unsupported > pass, probe order kept within a status", () =>
    !!b && b.checks.map((c) => c.id).join(",") === "dialog.focus-return,keyboard.reachable,dialog.scrim,dialog.nested-escape,forced-colors.visible,keyboard.focus-visible,future.check");
  safe("the second headline: counts · axe-core version · names-computed-by label", () =>
    !!b && b.headline === "BEHAVIOUR/A11Y (not the fidelity verdict) — 2 fail · 1 warn · 2 pass · 1 not run · 1 unsupported · axe-core 4.13.0 · names computed by Playwright (Chromium), not screen-reader verified");
  safe("…axe {version}, namesComputedBy and behaviour artifacts copied (the forced-colours PNG is never a fidelity artifact)", () =>
    !!b && JSON.stringify(b.axe) === JSON.stringify({ version: "4.13.0" }) && /not screen-reader verified/.test(b.namesComputedBy ?? "")
    && JSON.stringify(b.artifacts) === JSON.stringify(["design/verify/Crates__80_1.forced-colors.png"]) && JSON.stringify(mixed.artifacts) === JSON.stringify(none.artifacts));
  const noAxe = behaviourOf(compare(exp, base({ behaviour: ran([row("a11y.axe", "not-run", "axe-core not installed in the project (optional)")], { axe: { ran: false, why: "axe-core not installed in the project (optional)" }, cut: true }) })));
  safe("axe not run → axe {notRun: why}; headline 'axe-core not run' and 'cut by the time budget'", () =>
    !!noAxe && JSON.stringify(noAxe.axe) === JSON.stringify({ notRun: "axe-core not installed in the project (optional)" }) && /· cut by the time budget · axe-core not run · names computed/.test(noAxe.headline));
  // the probe's write-block scope line is copied, and stated in the md (one line)
  const scope = "from a unit's first key press on, no request but GET/HEAD/OPTIONS leaves the browser; not blocked: a GET with a side effect, a WebSocket opened inside a worker";
  const wb = compare(exp, base({ behaviour: MIXED.ran ? { ...MIXED, writeBlock: scope } : MIXED }));
  safe("measured.behaviour.writeBlock → report.behaviour.writeBlock, and the md says 'Write block: …' on one line (none when the probe wrote none)", () =>
    behaviourOf(wb)?.writeBlock === scope && reportToMarkdown(wb).split("\n").includes(`Write block: ${scope}`) && behaviourOf(mixed)?.writeBlock === undefined && !/Write block:/.test(reportToMarkdown(mixed)));
  const hf = headlineFn;
  safe("behaviourHeadline is exported and builds the same line", () =>
    !!hf && hf({ pass: 9, fail: 2, warn: 1, notRun: 3, unsupported: 0 }, { ran: true, axe: { version: "4.13.0" } }) === "BEHAVIOUR/A11Y (not the fidelity verdict) — 2 fail · 1 warn · 9 pass · 3 not run · axe-core 4.13.0 · names computed by Playwright (Chromium), not screen-reader verified");
}

// ---------------------------------------------------------------- the md
console.log("report.md — a second bold line and its own section:");
{
  const r = compare(exp, base({ behaviour: MIXED }));
  const md = reportToMarkdown(r);
  const lines = md.split("\n");
  const head = lines.indexOf(`**${r.headline}**`);
  safe("the behaviour headline is a second bold line right under the fidelity headline", () => head >= 0 && lines[head + 2] === `**${behaviourOf(r)?.headline ?? "?"}**`);
  const sec = md.indexOf("## Behaviour and accessibility — not part of the verdict");
  safe("section '## Behaviour and accessibility — not part of the verdict' after 'What was actually checked', before 'How nodes were matched'", () =>
    sec > md.indexOf("## What was actually checked") && sec < md.indexOf("## How nodes were matched"));
  const body = sec >= 0 ? md.slice(sec, md.indexOf("## How nodes were matched")) : "";
  safe("fails listed first, then the table Status | Check | Node/target | Variant | Detail", () => {
    const fails = body.indexOf("### Failed (2)"), table = body.indexOf("| Status | Check | Node/target | Variant | Detail |");
    return fails >= 0 && table > fails && /- \*\*dialog\.focus-return\*\* 80:12 \(on_click\) \[escape\]/.test(body);
  });
  safe("…a pipe in a detail is escaped in the table; a synthetic row is labelled", () => /focus on BODY after Escape \\\| opener hidden/.test(body) && /synthetic \(headless\), not a real-browser observation/.test(body));
  safe("the names-computed-by label, the axe-core version line and the forced-colours artifact are in the section", () =>
    /names computed by Playwright \(Chromium\), not screen-reader verified/.test(body) && /axe-core 4\.13\.0 ran on the main frame/.test(body) && /Crates__80_1\.forced-colors\.png/.test(body));
  const offMd = reportToMarkdown(compare(exp, base({ behaviour: { version: 1, ran: false, why: "--behaviour off" } })));
  safe("--behaviour off → the md says 'Not run (--behaviour off)'", () => /## Behaviour and accessibility — not part of the verdict[\s\S]*Not run \(--behaviour off\)\./.test(offMd));
  const noAxeMd = reportToMarkdown(compare(exp, base({ behaviour: ran([], { axe: { ran: false, why: "axe-core not installed in the project (optional)" } }) })));
  safe("axe not run → 'axe-core: not run — <why>'", () => /axe-core: not run — axe-core not installed in the project \(optional\)\./.test(noAxeMd));
}

// ---------------------------------------------------------------- page text is escaped in the md; a "+N more" row counts N
console.log("page-derived text escaped; a '+N more' row counts the elements it stands for:");
{
  const PAGE = ran([
    row("dialog.focus-return", "fail", "focus went to <body> | not `x`\nafter Escape & close", { nodeId: "80:12", target: "main > <button> \"Edit `Crate`\"", variant: "esc|ape" }),
  ], { axe: { ran: false, why: "axe threw <TypeError> | `boom`" }, artifacts: ["design/verify/a<b>.png"] });
  const md = reportToMarkdown(compare(exp, base({ behaviour: PAGE })));
  const sec = md.slice(md.indexOf("## Behaviour and accessibility"), md.indexOf("## How nodes were matched"));
  const tableRow = sec.split("\n").find((l) => l.startsWith("| fail |")) ?? "";
  safe("<, >, &, backticks and newlines from the page are escaped in the bullets, the table, the axe line and the artifacts", () =>
    sec.length > 0 && !/<body>|<button>|<TypeError>|<b>/.test(sec) && /focus went to &lt;body&gt;/.test(sec) && /&amp; close/.test(sec) && /main &gt; &lt;button&gt;/.test(sec)
    && /\\`x\\`/.test(sec) && /axe threw &lt;TypeError&gt; \\\| \\`boom\\`/.test(sec) && /a&lt;b&gt;\.png/.test(sec) && !/\nafter Escape/.test(sec));
  safe("…the table row stays one row of 5 cells (every | from the page escaped)", () => tableRow.replace(/\\\|/g, "").split("|").length === 7 && /after Escape/.test(tableRow));
  const fails = sec.split("\n").find((l) => l.startsWith("- **dialog.focus-return**")) ?? "";
  safe("…the fails-first bullet is escaped too", () => /&lt;body&gt;/.test(fails) && /\[esc\\\|ape\]/.test(fails));

  const MORE = ran([
    row("a11y.name", "fail", "button with no name", { target: "td > button" }),
    row("a11y.name", "fail", "+24 more fail — the first 20 are listed", { evidence: { count: 24 } }),
    row("a11y.name", "pass", "40 of 65 focusables named", { evidence: { count: 40, of: 65 } }),
    row("a11y.landmarks", "warn", "2 region landmarks named nothing", { evidence: { count: 2 } }),
    row("keyboard.focus-visible", "not-run", "+5 more not-run — the first 20 are listed", { evidence: { count: 5 } }),
  ]);
  const b = behaviourOf(compare(exp, base({ behaviour: MORE })));
  safe("a '+24 more' fail row counts 24; the aggregate '40 of 65' pass row counts 1; a warn row with evidence.count but no '+N more' counts 1; '+5 more not-run' counts 5", () =>
    !!b && JSON.stringify(b.summary) === JSON.stringify({ pass: 1, fail: 25, warn: 1, notRun: 5, unsupported: 0 }));
  const FLAG = ran([
    row("a11y.name", "fail", "seven further unnamed buttons", { evidence: { count: 7, more: true } }),
    row("a11y.name", "fail", "+3 more fail — the first 20 are listed", { evidence: { count: 3, more: false } }),
    row("a11y.name", "warn", "+4 more warn — a reworded probe", { evidence: { count: 9 } }),
  ]);
  const fb = behaviourOf(compare(exp, base({ behaviour: FLAG })));
  safe("evidence.more true counts evidence.count whatever the wording; more:false counts 1 despite a '+N more' detail; an unflagged row counts N only on the exact legacy '+N more ' detail", () =>
    !!fb && fb.summary.fail === 8 && fb.summary.warn === 1);
  safe("…the headline says 25 fail", () => !!b && b.headline.startsWith("BEHAVIOUR/A11Y (not the fidelity verdict) — 25 fail · 1 warn · 1 pass · 5 not run ·"));
}

// ---------------------------------------------------------------- the guard
console.log("measured.behaviour guard — lenient, a malformed block is dropped with a note:");
{
  const okRan = ran([row("future.check", "warn", "kept")]);
  safe("isMeasuredBehaviour: a ran block (unknown id kept) and {version:1, ran:false, why} pass", () => guard(okRan) && guard({ version: 1, ran: false, why: "--behaviour off" }));
  safe("…version 2, a non-boolean ran, ran:false without why, a row with a bad status or no detail → rejected", () =>
    !guard({ version: 2, ran: false, why: "x" }) && !guard({ version: 1, ran: "yes", why: "x" }) && !guard({ version: 1, ran: false })
    && !guard({ ...okRan, checks: [{ id: "a11y.name", status: "broken", detail: "x" }] }) && !guard({ ...okRan, checks: [{ id: "a11y.name", status: "fail" }] }));
  const bad = { ...base(), behaviour: { summary: {} } };
  safe("isVerifyMeasured refuses a file with a malformed behaviour block (readableMeasured is the way in)", () => !isVerifyMeasured(bad) && isVerifyMeasured({ nodes: [], behaviour: okRan }));
  const rm = readableMeasured(bad);
  safe("readableMeasured drops it with an inputNote ('measured.behaviour is not a behaviour block …; ignored')", () =>
    !!rm && rm.doc.behaviour === undefined && rm.notes.some((n) => /^measured\.behaviour is not a behaviour block .*; ignored$/.test(n)));
  // (guarded: a readableMeasured without `dropped` fails these checks cleanly instead of crashing the file)
  const r = (() => { try { return rm ? compare(exp, rm.doc, { inputNotes: rm.notes, behaviourMalformed: rm.dropped.includes("behaviour") }) : null; } catch { return null; } })();
  safe("…and compare still runs: the note in probe.inputNotes, the verdict that of a file without the block", () =>
    !!r && behaviourOf(r)?.ran === false && (r.probe.inputNotes || []).some((n) => /measured\.behaviour is not/.test(n)) && r.verdict === compare(exp, base()).verdict);
  safe("…report.behaviour says the block is MALFORMED (readableMeasured lists it in dropped) — never 'no behaviour checks / older probe'", () =>
    !!rm && rm.dropped.includes("behaviour") && !!r && /the measured file's behaviour block is malformed/.test(behaviourOf(r)?.why ?? "") && !/predates the behaviour checks/.test(behaviourOf(r)?.why ?? ""));
  const direct = compare(exp, malformed<VerifyMeasured>({ ...base(), behaviour: { version: 1, ran: true, checks: "none" } }));
  safe("compare handed a malformed block directly (no readableMeasured) → ran:false 'malformed', never a throw", () =>
    behaviourOf(direct)?.ran === false && /behaviour block is malformed/.test(behaviourOf(direct)?.why ?? ""));
}

// ---------------------------------------------------------------- the CLI
console.log("--compare CLI — the second headline after the probe line:");
{
  const CLI = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "verify-behaviour-"));
  const put = (rel: string, v: unknown): string => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(v, null, 2)); return rel; };
  const e = put("design/verify/Crates__80_1.expected.json", exp);
  const m = put("design/verify/Crates__80_1.measured.json", base({ behaviour: MIXED }));
  const r = spawnSync(process.execPath, [CLI, "--compare", e, m], { encoding: "utf8", cwd });
  const rep = readJsonOrNull(path.join(cwd, "design/verify/Crates__80_1.report.json"), isVerifyReport);
  const errLines = r.stderr.split("\n");
  const pl = rep ? errLines.indexOf(probeLine(rep)) : -1;
  safe("stderr: fidelity headline, probe line, then the BEHAVIOUR/A11Y line", () =>
    !!rep && pl > 0 && errLines[pl - 1] === rep.headline && errLines[pl + 1] === rep.behaviour?.headline && /^BEHAVIOUR\/A11Y \(not the fidelity verdict\) — 2 fail/.test(errLines[pl + 1] ?? ""));
  safe("…report.json carries behaviour; report.md the section", () =>
    rep?.behaviour?.summary.fail === 2 && /## Behaviour and accessibility — not part of the verdict/.test(fs.readFileSync(path.join(cwd, "design/verify/Crates__80_1.report.md"), "utf8")));
  const m2 = put("design/verify/Old__80_1.measured.json", { ...base(), behaviour: { checks: [] } });
  const r2 = spawnSync(process.execPath, [CLI, "--compare", e, m2, "--out", "design/verify/Old__80_1"], { encoding: "utf8", cwd });
  const rep2 = readJsonOrNull(path.join(cwd, "design/verify/Old__80_1.report.json"), isVerifyReport);
  safe("a malformed behaviour block: a note, the compare still runs (exit 0/1, never 2), report.behaviour ran:false", () =>
    (r2.status === 0 || r2.status === 1) && /note .*measured\.behaviour is not a behaviour block/.test(r2.stderr) && rep2?.behaviour?.ran === false);
  safe("…through the CLI the report says 'malformed', and the headline 'not run (the measured file's behaviour block is malformed …)'", () =>
    /behaviour block is malformed/.test(rep2?.behaviour?.why ?? "") && /not run \(the measured file's behaviour block is malformed/.test(rep2?.behaviour?.headline ?? ""));
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
