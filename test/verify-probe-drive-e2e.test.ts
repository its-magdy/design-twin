// End-to-end tests for group 12a's probe half: the BUILT claude-plugin/scripts/verify-probe.js (and the built
// verify-screen.js for --expect / --status / --compare), run in a real chromium from a TEMP consumer project
// (design/export + design/plan + node_modules/ of its own — never the repo root, so no untracked design/ leaks in).
//
// The fixture "Plot Ledger" (test/fixtures/probe/plot-ledger.*, invented names) is a single-page app whose sections are
// picked by state, not by the URL: the Beds screen (root 70:1) exists only after its sidebar button (70:30) is clicked
// (L-1: --steps). On it, overlay openers built every way the probe must tell apart (F-70/F-95/F-117): a row action that
// shows only on row hover opening a native <dialog> (showModal, no role) holding the destination frame's tag; a
// role=dialog aria-modal div; an UNTAGGED dialog; a dead button; a button that reloads the page; a button under a
// transparent layer; a panel that is only the destination tag; and a plan-only opener (plan.interactions). ?mode=wide
// adds a 1700px strip to the Beds section only (D43); ?mode=reload-on-first-hover reloads once on the hovered row (D19).
// plot-ledger-edge.html holds the review's repros, one ?mode= each: a reload while settling into a half-loaded document
// (H1), a reload after a step's in-place click (H1), a link step, driving pages whose reach never answers (M1, budget), a
// destination wrapper already on screen + disabled / submitting openers (M2, B3, L3), an absolute strip escaping a
// static clipping wrapper (L7); and review 2's: a click step that navigates late (H-a) or reloads the same URL (H-a exit 4),
// a step's navigation into a half-loaded document (M-a), a document replaced right after settling (L-a), tagged wrappers
// around a submitting button (L-c), a re-mounted destination wrapper (L-b), containing-block creators (L-d); and review 3's:
// a click that reloads the same URL at once or 100 ms later (M-2), a step's navigation into a document that never finishes
// loading (M-1), a tagged wrapper taller than the viewport (L-2).
//
// D3: needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI
// (CI=true) that is a failure.  Run with:  node test/verify-probe-drive-e2e.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { InteractionEvidence, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROBE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const VS = path.join(ROOT, "claude-plugin", "scripts", "verify-screen.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-drive-e2e-"));
const proj = path.join(tmp, "plot-ledger");

// ---- the temp consumer project: the screen export, the destination frame's export, the index, the plan
const pagesDir = path.join(proj, "design", "export", "pages", "Plots");
fs.mkdirSync(pagesDir, { recursive: true });
fs.mkdirSync(path.join(proj, "design", "plan"), { recursive: true });
fs.mkdirSync(path.join(proj, "design", "verify"), { recursive: true });
fs.mkdirSync(path.join(proj, "node_modules"));
fs.writeFileSync(path.join(proj, "package.json"), "{\"name\":\"plot-ledger\",\"private\":true}\n");
fs.copyFileSync(path.join(FIX, "plot-ledger.json"), path.join(pagesDir, "Beds__70_1.json"));
fs.copyFileSync(path.join(FIX, "plot-ledger-bed-form.json"), path.join(pagesDir, "Bed_Form__70_60.json"));
fs.copyFileSync(path.join(FIX, "plot-ledger.plan.json"), path.join(proj, "design", "plan", "Beds__70_1.json"));
const row = (name: string, id: string, file: string): Record<string, string> => ({ name, id, type: "FRAME", page: "Plots", pageId: "70:0", file: `pages/Plots/${file}` });
const layers = [row("Beds", "70:1", "Beds__70_1.json"), row("Bed Form", "70:60", "Bed_Form__70_60.json")];
fs.writeFileSync(path.join(proj, "design", "export", "pages", "index.json"), JSON.stringify({ pageDirs: [{ page: "Plots", pageId: "70:0", dir: "Plots", index: "pages/Plots/index.json", layers: 2 }], layers }, null, 2));
fs.writeFileSync(path.join(pagesDir, "index.json"), JSON.stringify({ page: "Plots", pageId: "70:0", layers }, null, 2));

const STEPS = [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "[data-dt-node=\"70:1\"]" }];
const stepFile = (name: string, steps: unknown): string => { fs.writeFileSync(path.join(proj, name), JSON.stringify(steps, null, 2)); return name; };
stepFile("steps.json", STEPS);
stepFile("steps-goto.json", [{ goto: "/plot-ledger.html?from=goto" }, ...STEPS]);
stepFile("steps-ambiguous.json", [{ click: ".nav-btn" }]);
stepFile("steps-submit.json", [{ click: ".find button" }]);
stepFile("steps-fill.json", [{ fill: ".find input" }]);
stepFile("steps-waitfor-many.json", [STEPS[0], { waitFor: ".actions button" }]);
stepFile("steps-goto-reload.json", [{ goto: "/plot-ledger-edge.html?mode=reload-after-goto&after=goto" }, { waitFor: "[data-dt-node=\"70:1\"]" }]);
stepFile("steps-click-only.json", [{ click: "[data-dt-node=\"70:30\"]" }]);
stepFile("steps-reload-step.json", [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "[data-dt-node=\"70:1\"]" }]);
const READY = "[data-dt-node=\"70:1\"]";
// the steps' sha: canonical JSON (sorted keys) — for one-key string steps that is JSON.stringify of the list
const stepsSha = crypto.createHash("sha256").update(JSON.stringify(STEPS)).digest("hex");

// ---- a static server on an ephemeral port (the fixtures under any query string). The edge page's extras: a script
// answered 2.5 s late (a half-loaded document), POST /mutate (a write an opener's handler made — counted per query), and
// ?mode=slow-reach answered at once the first time per URL, never again (the driving pages' reach hangs)
const mutations: string[] = [];
const seen = new Map<string, number>();
const SLOW_JS = "document.body.insertAdjacentHTML(\"beforeend\", '<div class=\"app\" data-dt-node=\"70:1\"><h1 data-dt-node=\"70:2\">Beds</h1></div>');";
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const name = path.basename(u.pathname);
  if (req.method === "POST" && name === "mutate") { mutations.push(u.search.slice(1)); res.writeHead(204); res.end(); return; }
  if (name === "plot-ledger-hang.png") return; // M-1: an image that never loads (held until finish())
  if (name === "plot-ledger-slow.js") {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(SLOW_JS); }, 2500).unref();
    return;
  }
  const file = path.join(FIX, name);
  if ((name !== "plot-ledger.html" && name !== "plot-ledger-edge.html") || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const n = (seen.get(req.url || "") ?? 0) + 1;
  seen.set(req.url || "", n);
  if (u.searchParams.get("mode") === "slow-reach" && n > 1) return; // held until the probe gives up (closed by finish())
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/plot-ledger.html${mode ? `?mode=${mode}` : ""}`;
const edge = (mode: string): string => `http://127.0.0.1:${port}/plot-ledger-edge.html?mode=${mode}`;

// async spawn: the server lives in THIS process, so a spawnSync would block it from answering
interface Run { status: number | null; stdout: string; stderr: string }
const run = (script: string, args: string[]): Promise<Run> => new Promise((resolve) => {
  const p = spawn(process.execPath, [script, ...args], { cwd: proj });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});
const probe = (args: string[]): Promise<Run> => run(PROBE, [...args, "--project", ROOT]);
const vs = (args: string[]): Promise<Run> => run(VS, args);
const finish = (): void => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
const out = (name: string): string => path.join("design", "verify", name);
const read = (base: string): VerifyMeasured | null => readJsonOrNull(path.join(proj, base + ".measured.json"), isVerifyMeasured);
const readReport = (base: string): VerifyReport | null => readJsonOrNull(path.join(proj, base + ".report.json"), isVerifyReport);
const written = (base: string): boolean => fs.existsSync(path.join(proj, base + ".measured.json")) || fs.existsSync(path.join(proj, base + ".png"));
const ix = (m: VerifyMeasured | null, id: string): InteractionEvidence | undefined => (m?.interactions || []).find((i) => i.nodeId === id);
const res = (r: VerifyReport | null, id: string): NonNullable<VerifyReport["interactions"]>[number] | undefined => (r?.interactions || []).find((i) => i.nodeId === id);

console.log("verify-probe drive e2e — the built bundles in a real chromium, from a temp project:");
const pre = await probe(["--check"]);
if (pre.status === 3) {
  const reason = pre.stderr.split("\n")[0] || "renderer unavailable";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); finish(); process.exit(0); }
  check(`the renderer is available in CI (D3) — ${reason}`, false);
  finish();
  report();
}

// ---- the expectation, from the real --expect (auto-discovers design/plan/Beds__70_1.json: F-95)
const exp = await vs(["--expect", "design/export/pages/Plots/Beds__70_1.json", "--out", out("Beds")]);
const EXPECTED = out("Beds") + ".expected.json";
if (exp.status !== 0 || !fs.existsSync(path.join(proj, EXPECTED))) { console.log(exp.stderr); check("verify-screen --expect wrote the expectation", false); finish(); report(); }
// the same expectation without interactions: for the runs that check only reaching + measuring (nothing to drive)
const QUIET = out("Quiet") + ".expected.json";
const full = readJsonOrNull(path.join(proj, EXPECTED), isVerifyExpectation);
if (full !== null) { const { interactions: _drop, ...quiet } = full; fs.writeFileSync(path.join(proj, QUIET), JSON.stringify(quiet, null, 2) + "\n"); }

// ---- L-1: the screen behind a click
const r1 = await probe(["--expected", EXPECTED, "--url", url(), "--out", out("NoSteps"), "--ready", READY, "--timeout", "3000"]);
check("[L-1] 1 no --steps + --ready on the section's root (only there after a click) → exit 4, nothing written", r1.status === 4 && !written(out("NoSteps")));

// the main run, bound to a verify run (D41): --status --new-run → probe --run → --status done → --compare
const st = await vs(["--status", "Beds", "--phase", "starting", "--new-run", "--dir", "design/verify"]);
const runId = /^run (\S+) rev 1$/m.exec(st.stdout)?.[1] ?? "";
const r2 = await probe(["--expected", EXPECTED, "--url", url(), "--steps", "steps.json", "--ready", READY, ...(runId ? ["--run", runId] : [])]);
const m2 = read(out("Beds"));
if (r2.status !== 0) console.log(r2.stderr);
check("[L-1] 2 --steps (click the sidebar button, waitFor the root) → exit 0, measured.json written", r2.status === 0 && m2 !== null);
check("[L-1] 2 measured.reach: 2 steps, sha256 of their canonical JSON, source '--steps steps.json', the url after the steps",
  m2?.reach?.steps.length === 2 && m2.reach.sha256 === stepsSha && m2.reach.source === "--steps steps.json" && /plot-ledger\.html#beds$/.test(m2.reach.url));
check("[L-1/facts §1] 2 the steps' pushState is no navigation: afterInitialLoad 0, re-runs 0", m2?.navigation?.afterInitialLoad === 0 && m2.navigation.reruns === 0);
check("[L-1] 2 the Beds section's specs are measured (the frame root by tag, its heading by tag)", m2?.frame?.nodeId === "70:1" && m2.frame.via === "tag"
  && (m2.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag"));

// F-70 / F-117 / F-95: what the probe drove
const e6 = ix(m2, "70:44");
check("[F-70] 6 a hover-revealed row action (visibility:hidden until its tagged <tr> is hovered) opening a native <dialog> via showModal → ok:true, dialog-opened, detectedBy :modal, mouse, revealedBy the row, destination inside, navEvents 0",
  e6?.ok === true && e6.outcome === "dialog-opened" && e6.detectedBy === ":modal" && e6.activation === "mouse" && e6.revealedBy === "[data-dt-node=\"70:41\"]"
  && e6.destination?.nodeId === "70:60" && e6.destination.inside && e6.navEvents === 0 && e6.selectorCount === 1 && e6.selector === "[data-dt-node=\"70:44\"]");
check("[12b seam] 6 opened recorded raw: modal true, position fixed, a rect", e6?.opened?.modal === true && e6.opened.position === "fixed" && e6.opened.rect.w > 0);
const e7 = ix(m2, "70:45");
check("[F-70] 7 a div role=dialog aria-modal → ok:true, detectedBy [role=dialog]", e7?.ok === true && e7.outcome === "dialog-opened" && e7.detectedBy === "[role=dialog]" && e7.destination?.inside === true);
const e8 = ix(m2, "70:46");
check("[D41] 8 a dialog without the destination tag → ok:null, destination.inside false, the detail says to tag it", e8?.ok === null && e8.detectedBy === ":modal" && e8.destination?.inside === false && /tag the dialog's root/.test(e8.detail || ""));
const e9 = ix(m2, "70:47");
check("[D40(1)] 9 a dead button → ok:null, outcome none (never ok:false)", e9?.ok === null && e9.outcome === "none" && e9.activation === "mouse");
check("[D40(1)] the probe never writes ok:false", (m2?.interactions || []).length === 8 && (m2?.interactions || []).every((i) => i.ok !== false));
const e10 = ix(m2, "70:48");
check("[D24] 10 a click that reloads the page → navEvents 1, ok:null", e10?.ok === null && e10.navEvents === 1);
const e11 = ix(m2, "70:49");
check("[F-70] 11 an opener under a transparent layer → synthetic click, ok:null 'not a user activation' (the dialog did open)", e11?.ok === null && e11.activation === "synthetic"
  && e11.detectedBy === ":modal" && /not a user activation/.test(e11.detail || "") && /intercepts pointer events/.test(e11.detail || ""));
const e12 = ix(m2, "70:50");
check("[F-95] 12 a plan-only opener (plan.interactions expect dialog) → driven: ok:true, dialog-opened, the dialog itself carries the tag", e12?.ok === true && e12.detectedBy === ":modal" && e12.destination?.inside === true);
const e13 = ix(m2, "70:53");
check("[planner default 1] a panel that is only the destination tag (no dialog contract) → ok:true, selector-appeared, detectedBy destination-tag", e13?.ok === true && e13.outcome === "selector-appeared" && e13.detectedBy === "destination-tag");
check("[D43] 14 measured.page at the design width: scrollWidth = clientWidth = 1024, not scrollable, no offenders, standards mode",
  m2?.page?.scrollWidth === 1024 && m2.page.clientWidth === 1024 && m2.page.viewport.w === 1024 && !m2.page.scrollable && m2.page.offenders.length === 0 && m2.page.overflowX === "visible" && m2.page.compatMode === "CSS1Compat");

const done = await vs(["--status", "Beds", "--phase", "done", "--run", runId, "--dir", "design/verify"]);
if (done.status !== 0) console.log(done.stderr);
const c2 = await vs(["--compare", EXPECTED, out("Beds") + ".measured.json", "--out", out("Beds")]);
const rep2 = readReport(out("Beds"));
if (rep2 === null) console.log(c2.stderr);
check("[F-70] 6 --compare: the hover-revealed overlay passes (was not-probed: nothing drove it)", res(rep2, "70:44")?.result === "pass");
check("[F-95] 12 --compare: the plan row is graded (source plan) and passes", res(rep2, "70:50")?.result === "pass" && res(rep2, "70:50")?.source === "plan");
check("[D41] 8 --compare: the untagged dialog is not-probed, never pass", res(rep2, "70:46")?.result === "not-probed");
check("[D24] 9/10/11 --compare: dead, reloading and covered openers are not-probed, never fail", ["70:47", "70:48", "70:49"].every((id) => res(rep2, id)?.result === "not-probed"));
check("[D41] 15 run-bound (--run, done, compare without --interactions) → the probe's rows are graded as the probe's (evidenceFrom probe)",
  runId !== "" && done.status === 0 && res(rep2, "70:44")?.evidenceFrom === "probe" && (rep2?.coverage?.interactionsByProbe ?? 0) >= 4);
check("[D43] 14 --compare at the design width: pageOverflow ok, no overflowX delta", rep2?.coverage?.pageOverflow === "ok" && !(rep2.deltas || []).some((d) => d.field === "overflowX"));
check("[L-1] --compare: inputs.reach (2 steps, matches the plan's navigate)", rep2?.inputs?.reach?.steps === 2 && rep2.inputs.reach.matchesPlan === true);

// a step that loads a page (goto) is the probe's own navigation; a small --max-time leaves no driving budget
const b3 = out("GotoSteps");
const r3 = await probe(["--expected", EXPECTED, "--url", url(), "--out", b3, "--steps", "steps-goto.json", "--ready", READY, "--max-time", "25000"]);
const m3 = read(b3);
if (r3.status !== 0) console.log(r3.stderr);
check("[L-1] 2b a goto step (a document load) → exit 0, reach 3 steps, afterInitialLoad 0 (the step's load is the probe's own)", r3.status === 0 && m3?.reach?.steps.length === 3 && m3.navigation?.afterInitialLoad === 0);
const cut3 = (m3?.interactions || []).filter((i) => i.cut === "budget");
check("[D41] budget: --max-time 25 s leaves ≤ 10 s of driving → rows cut: ok:null, cut budget, 'not-run: time budget'; the measured file still written",
  cut3.length > 0 && cut3.every((i) => i.ok === null && i.detail === "not-run: time budget"));

// facts-12a §1: a same-document URL rewrite after load (replaceState) is no navigation — only a document load is
const b9 = out("Replace");
const r9 = await probe(["--expected", QUIET, "--url", url("replace-state"), "--out", b9, "--max-time", "60000"]);
const m9 = read(b9);
if (r9.status !== 0) console.log(r9.stderr);
check("[D19/facts §1] a replaceState 100 ms after load (no --steps) → afterInitialLoad 0 (framenavigated logged, never counted)",
  r9.status === 0 && m9?.navigation?.afterInitialLoad === 0 && (m9.navigation.events || []).some((e) => e.type === "framenavigated" && /tab=harvest/.test(e.url)));

// D19: a reload during measurement → one full re-run, which replays the steps (the plan's navigate as --steps)
const b4 = out("Reload");
const r4 = await probe(["--expected", QUIET, "--url", url("reload-on-first-hover"), "--out", b4, "--steps", "design/plan/Beds__70_1.json", "--ready", READY, "--max-time", "60000"]);
const m4 = read(b4);
if (r4.status !== 0) console.log(r4.stderr);
check("[D19/L-1] 3 a reload on the first hover → exit 0, re-runs 1, the steps replayed (the root measured by tag), a note on the kept storage",
  r4.status === 0 && m4?.navigation?.reruns === 1 && m4.frame?.via === "tag" && m4.frame.nodeId === "70:1" && (m4.notes || []).some((n) => /replayed the steps in the same browser context/.test(n)));
check("[L-1] --steps <plan>: the plan's navigate list, source names the plan file, the same sha", m4?.reach?.source === "--steps design/plan/Beds__70_1.json" && m4.reach.sha256 === stepsSha);

// D43: a sideways overflow only in the section the steps reach
const b5 = out("Wide");
const r5 = await probe(["--expected", EXPECTED, "--url", url("wide"), "--out", b5, "--steps", "steps.json", "--ready", READY, "--max-time", "30000"]);
const m5 = read(b5);
if (r5.status !== 0) console.log(r5.stderr);
check("[D43] 13 a 1700px strip in the Beds section → page.scrollWidth ≥ 1600, scrollable, the strip named among the offenders",
  r5.status === 0 && (m5?.page?.scrollWidth ?? 0) >= 1600 && m5?.page?.scrollable === true && m5.page.offenders.some((o) => o.dt === "70:57"));
const c5 = await vs(["--compare", EXPECTED, b5 + ".measured.json", "--out", b5]);
const rep5 = readReport(b5);
if (rep5 === null) console.log(c5.stderr);
const ov = (rep5?.deltas || []).find((d) => d.field === "overflowX");
check("[D43] 13 --compare: one HIGH overflowX delta on the root frame (expected clientWidth, actual scrollWidth)", ov?.severity === "high" && ov.nodeId === "70:1" && ov.expected === 1024 && typeof ov.actual === "number" && ov.actual >= 1600);

// steps that must fail: ambiguous, a submit, a step outside the vocabulary
const r6 = await probe(["--expected", EXPECTED, "--url", url(), "--out", out("Ambiguous"), "--steps", "steps-ambiguous.json"]);
check("[L-1] 4 a step matching 2 visible elements → exit 4 'matched 2', the step and the navigation log printed, nothing written",
  r6.status === 4 && /step 1 \{click: "\.nav-btn"\} matched 2 visible element/.test(r6.stderr) && /navigation log/.test(r6.stderr) && !written(out("Ambiguous")));
const r7 = await probe(["--expected", EXPECTED, "--url", url(), "--out", out("Submit"), "--steps", "steps-submit.json"]);
check("[L-1] 5 a step clicking a form's typeless button → exit 4 'never submit', nothing written", r7.status === 4 && /never submit/.test(r7.stderr) && !written(out("Submit")));
const r8 = await probe(["--expected", EXPECTED, "--url", url(), "--out", out("Fill"), "--steps", "steps-fill.json"]);
check("[L-1] a {fill} step → exit 2 naming it (the vocabulary is click / waitFor / goto)", r8.status === 2 && /\{fill: …\} is not a step/.test(r8.stderr) && !written(out("Fill")));

// B2: a waitFor is met by one or more visible matches (a click still needs exactly one: check 4 above)
const b10 = out("WaitMany");
const r10 = await probe(["--expected", QUIET, "--url", url(), "--out", b10, "--steps", "steps-waitfor-many.json"]);
if (r10.status !== 0) console.log(r10.stderr);
check("[B2] a waitFor step matching 7 visible elements → met (exit 0, reach 2 steps)", r10.status === 0 && read(b10)?.reach?.steps.length === 2);

// ---- review 1 repros (plot-ledger-edge.html)
// H1 / D19: a reload 300 ms after load into a document that stays half-loaded for 2.5 s — the probe must wait for it
const b11 = out("ReloadSettle");
const r11 = await probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", b11, "--ready", READY, "--max-time", "60000"]);
const m11 = read(b11);
if (r11.status !== 0) console.log(r11.stderr);
check("[H1/D19] a reload while settling into a half-loaded document → waited for: the root by tag, its heading measured, afterInitialLoad 1 (the reload's load), re-runs 0",
  r11.status === 0 && m11?.frame?.via === "tag" && m11.frame.nodeId === "70:1" && (m11.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag")
  && m11.navigation?.afterInitialLoad === 1 && m11.navigation.reruns === 0);
const b11b = out("ReloadSettleNoReady");
const r11b = await probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", b11b, "--max-time", "60000"]);
const m11b = read(b11b);
check("[H1/D19] the same without --ready (nothing to wait for but the quiet window) → still the reloaded document, measured once it loaded",
  r11b.status === 0 && m11b?.frame?.via === "tag" && m11b.navigation?.afterInitialLoad === 1);

// H1 (steps): a load the step did not start is not the probe's own — it counts, and (the click's state is gone) the
// pass is re-run once with the steps replayed
const b12 = out("ReloadStep");
const r12 = await probe(["--expected", QUIET, "--url", edge("reload-step"), "--out", b12, "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"]);
const m12 = read(b12);
if (r12.status !== 0) console.log(r12.stderr);
check("[H1] a reload 300 ms after a step's in-place click → not absorbed by the step: afterInitialLoad 1, re-runs 1 (steps replayed), the root by tag",
  r12.status === 0 && m12?.navigation?.afterInitialLoad === 1 && m12.navigation.reruns === 1 && m12.frame?.via === "tag");
const b12b = out("GotoReload");
const r12b = await probe(["--expected", QUIET, "--url", edge("reload-after-goto"), "--out", b12b, "--steps", "steps-goto-reload.json", "--ready", READY, "--max-time", "60000"]);
const m12b = read(b12b);
if (r12b.status !== 0) console.log(r12b.stderr);
check("[H1] a goto step whose page then reloads by itself → the goto's load is absorbed, the reload's is not: afterInitialLoad 1, re-runs 0",
  r12b.status === 0 && m12b?.navigation?.afterInitialLoad === 1 && m12b.navigation.reruns === 0 && m12b.frame?.via === "tag");
const b12c = out("ReloadLate");
const r12c = await probe(["--expected", QUIET, "--url", edge("reload-late"), "--out", b12c, "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]);
const m12c = read(b12c);
if (r12c.status !== 0) console.log(r12c.stderr);
check("[H1] a reload 1 s after an in-place click (while waiting for --ready, the section lost) → re-run with the steps replayed: exit 0, re-runs 1, the root by tag",
  r12c.status === 0 && m12c?.navigation?.reruns === 1 && m12c.navigation.afterInitialLoad === 1 && m12c.frame?.via === "tag");
const b13 = out("LinkStep");
const r13 = await probe(["--expected", QUIET, "--url", edge("link-step"), "--out", b13, "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"]);
const m13 = read(b13);
if (r13.status !== 0) console.log(r13.stderr);
check("[H1] a step whose click follows a link → that load is the step's own: afterInitialLoad 0, re-runs 0, the root by tag",
  r13.status === 0 && m13?.navigation?.afterInitialLoad === 0 && m13.navigation.reruns === 0 && m13.frame?.via === "tag" && /section=beds/.test(m13.reach?.url ?? ""));

// M1: every driving page's reach hangs (the server never answers again); --timeout 30 s, --max-time 22 s → about 6 s of
// driving: the cut closes the row's context mid-reach, so the run ends inside --max-time with the measured file written
const b14 = out("SlowReach");
const t14 = Date.now();
const r14 = await probe(["--expected", EXPECTED, "--url", edge("slow-reach"), "--out", b14, "--timeout", "30000", "--max-time", "22000"]);
const s14 = Date.now() - t14;
const m14 = read(b14);
if (r14.status !== 0) console.log(r14.stderr);
check(`[M1] a driving reach that never answers is cut by the budget mid-reach → exit 0 in ${Math.round(s14 / 1000)} s (< 22 s), measured written, every row ok:null cut budget`,
  r14.status === 0 && s14 < 22_000 && m14 !== null && (m14.interactions || []).length === 8 && (m14.interactions || []).every((i) => i.ok === null && i.cut === "budget"));

// M2 + B3 + L3
const b15 = out("Ancestor");
mutations.length = 0;
const r15 = await probe(["--expected", EXPECTED, "--url", edge("ancestor"), "--out", b15, "--max-time", "90000"]);
const m15 = read(b15);
if (r15.status !== 0) console.log(r15.stderr);
const e47 = ix(m15, "70:47"), e49 = ix(m15, "70:49");
check("[M2] an unrelated dialog opening inside a destination-tagged wrapper that was already on screen → destination NOT inside, ok:null",
  e47?.ok === null && e47.detectedBy === "[role=dialog]" && e47.destination?.inside === false && /not inside the opened element/.test(e47.detail || ""));
check("[M2] a destination-tagged wrapper that appears with its dialog (an ancestor, newly visible) → inside, ok:true",
  e49?.ok === true && e49.detectedBy === "[role=dialog]" && e49.destination?.inside === true);
check("[B3] disabled openers (aria-disabled on it / on an ancestor, [disabled]) → ok:null 'opener is disabled — not driven', no activation",
  ["70:44", "70:45", "70:46"].every((id) => { const e = ix(m15, id); return e?.ok === null && e.detail === "opener is disabled — not driven" && e.activation === undefined; }));
check("[L3] a typeless <button> in a <form> as the opener → ok:null 'opener would submit a form', not clicked",
  ix(m15, "70:48")?.ok === null && /^opener would submit a form/.test(ix(m15, "70:48")?.detail || "") && ix(m15, "70:48")?.activation === undefined);
check(`[B3/L3] no opener's handler ran a write (server saw: ${mutations.join(", ") || "nothing"})`, r15.status === 0 && mutations.length === 0);

// L7: an absolute strip escaping a static overflow:hidden wrapper widens the page and is named; a clipped one is not
const b16 = out("AbsEscape");
const r16 = await probe(["--expected", QUIET, "--url", edge("abs-escape"), "--out", b16, "--max-time", "60000"]);
const m16 = read(b16);
if (r16.status !== 0) console.log(r16.stderr);
check("[L7] an absolute element inside a static overflow:hidden wrapper → page scrolls sideways and it is named among the offenders; one clipped by a positioned wrapper is not",
  r16.status === 0 && m16?.page?.scrollable === true && (m16.page.scrollWidth ?? 0) >= 1500 && m16.page.offenders.some((o) => o.dt === "70:57") && !m16.page.offenders.some((o) => o.dt === "70:58"));

// ---- review 2 repros (plot-ledger-edge.html)
// H-a: a click step whose page navigates to ANOTHER URL only later (an app that awaits a request first) — that navigation
// is the step's own however late it starts: no re-run, not after the initial load. 0 and 120 ms are guards (fine before).
for (const delay of [0, 120, 160, 200, 400, 1500]) {
  const b = out(`SlowNav${delay}`);
  const r = await probe(["--expected", QUIET, "--url", `${edge("slow-nav")}&delay=${delay}`, "--out", b, "--steps", "steps-reload-step.json", "--max-time", "60000"]);
  const m = read(b);
  if (r.status !== 0) console.log(r.stderr);
  check(`[H-a${delay <= 120 ? " guard" : ""}] a click step navigating ${delay} ms after the click → the step's own: exit 0, the root by tag, afterInitialLoad 0, re-runs 0, reach url section=beds`,
    r.status === 0 && m?.frame?.via === "tag" && m.frame.nodeId === "70:1" && m.navigation?.afterInitialLoad === 0 && m.navigation.reruns === 0 && /section=beds/.test(m.reach?.url ?? ""));
}
// M-a: the click's navigation commits at once into a document that stays half-loaded (quiet) for 2.5 s — waited for
const bM = out("ClickNavSlow");
const rM = await probe(["--expected", QUIET, "--url", edge("clicknav-slow"), "--out", bM, "--steps", "steps-click-only.json", "--max-time", "60000"]);
const mM = read(bM);
if (rM.status !== 0) console.log(rM.stderr);
check("[M-a] a step's navigation into a half-loaded document (no --ready) → its load is waited for: the root by tag, its heading measured, afterInitialLoad 0",
  rM.status === 0 && mM?.frame?.via === "tag" && (mM.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag") && mM.navigation?.afterInitialLoad === 0);
// H-a: a click that reloads the SAME URL after changing the page in place, every time → exit 4 naming the step, not the watch-tree hint
const bR = out("ClickReloads");
const rR = await probe(["--expected", QUIET, "--url", edge("click-reloads"), "--out", bR, "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]);
check("[H-a] a click that reloads the same URL after its in-place change, on the pass and the re-run → exit 4, nothing written, the step named, 'not a navigation step', no watch-tree hint",
  rR.status === 4 && !written(bR) && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(rR.stderr)
  && /on the first pass and again on the re-run/.test(rR.stderr) && /not a\s+navigation step/.test(rR.stderr) && !/watch tree/.test(rR.stderr) && /navigation log/.test(rR.stderr));
// L-a: the document replaced right after settling (simulated by a token that changes at the first plain read after the
// settle polls) → the pass compares against the token settle saw quiet → one re-run
const bA = out("TokenSwitch");
const rA = await probe(["--expected", QUIET, "--url", edge("token-switch"), "--out", bA, "--max-time", "60000"]);
const mA = read(bA);
if (rA.status !== 0) console.log(rA.stderr);
check("[L-a] a document replaced between settling and measuring → caught (the settled token is compared): exit 0, re-runs 1",
  rA.status === 0 && mA?.navigation?.reruns === 1 && mA.frame?.via === "tag");
// L-c: a tagged wrapper whose click point is a typeless <button> in a <form> — as a step, and as an opener
mutations.length = 0;
const bC = out("WrapperSubmitStep");
const rC = await probe(["--expected", QUIET, "--url", edge("wrapper-submit"), "--out", bC, "--steps", "steps-click-only.json", "--max-time", "60000"]);
check("[L-c] a step clicking a tagged wrapper whose click point is a form's typeless button → exit 4 'never submit' (at its click point), nothing written",
  rC.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\) — a step must navigate, never submit/.test(rC.stderr) && !written(bC));
const bC2 = out("WrapperSubmitOpener");
const rC2 = await probe(["--expected", EXPECTED, "--url", edge("wrapper-submit"), "--out", bC2, "--max-time", "90000"]);
const eC2 = ix(read(bC2), "70:47");
check("[L-c] an opener that is a tagged wrapper around a form's typeless button → ok:null 'opener would submit a form (… at its click point)', not clicked",
  rC2.status === 0 && eC2?.ok === null && /^opener would submit a form \(.*at its click point\)/.test(eC2.detail || "") && eC2.activation === undefined);
check(`[L-c] no form was submitted (server saw: ${mutations.join(", ") || "nothing"})`, mutations.length === 0);
// L-b: a destination wrapper the app re-mounts in place around an unrelated dialog is not newly visible → not inside
const bB = out("Remount");
const rB = await probe(["--expected", EXPECTED, "--url", edge("remount"), "--out", bB, "--max-time", "90000"]);
const eB = ix(read(bB), "70:47");
check("[L-b] an unrelated dialog inside a destination wrapper re-mounted in the same place → destination NOT inside, ok:null",
  rB.status === 0 && eB?.ok === null && eB.detectedBy === "[role=dialog]" && eB.destination?.inside === false);
// L-d: containing-block creators beyond transform
const bD = out("CbCreators");
const rD = await probe(["--expected", QUIET, "--url", edge("cb-creators"), "--out", bD, "--max-time", "60000"]);
const mD = read(bD);
if (rD.status !== 0) console.log(rD.stderr);
check("[L-d] position:fixed under a transformed ancestor widens the page and is named; absolute under a filtered overflow:hidden wrapper or a contain:layout one is not",
  rD.status === 0 && mD?.page?.scrollable === true && mD.page.offenders.some((o) => o.dt === "70:57") && !mD.page.offenders.some((o) => o.dt === "70:58" || o.dt === "70:59"));

// ---- review 3 repros (plot-ledger-edge.html)
// M-2: a same-URL navigation is never a click's own, even one its handler starts at once or 100 ms later — after the
// click's in-place change it loses the steps' state: one re-run, then (every time) the step-specific exit 4
const stepLost = (r: Run): boolean => r.status === 4 && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(r.stderr)
  && /on the first pass and again on the re-run/.test(r.stderr) && !/watch tree/.test(r.stderr);
const bS = out("ClickReloadsSync");
const rS = await probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync`, "--out", bS, "--steps", "steps-click-only.json", "--max-time", "60000"]);
if (!stepLost(rS)) console.log(rS.stderr);
check("[M-2] `draw(); location.reload()` in the click handler, every time (no --ready) → the reload is not the click's: one re-run, then exit 4 naming the step, nothing written (was: exit 0 measuring the default section)",
  stepLost(rS) && !written(bS));
const bH = out("ClickReloads100");
const rH = await probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=100`, "--out", bH, "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]);
if (!stepLost(rH)) console.log(rH.stderr);
check("[M-2] a reload 100 ms after the click's in-place change, every time (--ready) → exit 4 naming the step (was: the generic '--ready never visible')",
  stepLost(rH) && !written(bH) && !/never became visible/.test(rH.stderr));
const bO = out("ClickReloadsOnce");
const rO = await probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync&once=1`, "--out", bO, "--steps", "steps-click-only.json", "--max-time", "60000"]);
const mO = read(bO);
if (rO.status !== 0) console.log(rO.stderr);
check("[M-2] the same sync reload on the first click only → re-run with the steps replayed: exit 0, re-runs 1, afterInitialLoad 1, the root by tag",
  rO.status === 0 && mO?.navigation?.reruns === 1 && mO.navigation.afterInitialLoad === 1 && mO.frame?.via === "tag" && mO.frame.nodeId === "70:1");
// M-1: the click's navigation lands on a document whose image never loads — the load wait is per document: the click's
// settle waits its 10 s, the waitFor step's and the --ready settle do not wait again (was: 10 s each → past --max-time)
const bG = out("HangImg");
const tG = Date.now();
const rG = await probe(["--expected", QUIET, "--url", edge("hang-img"), "--out", bG, "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "22000"]);
const sG = Date.now() - tG;
const mG = read(bG);
if (rG.status !== 0) console.log(rG.stderr);
check(`[M-1] a step's navigation into a document that never finishes loading + a waitFor step + --ready → exit 0 in ${Math.round(sG / 1000)} s (< 22 s: one 10 s load wait, not three), the root by tag, the 'had not finished loading' note`,
  rG.status === 0 && sG < 22_000 && mG?.frame?.via === "tag" && (mG.notes || []).some((n) => /the document had not finished loading after 10s/.test(n)));
// L-2: a tagged wrapper taller than the viewport — Playwright clicks the middle of what shows, where a form's typeless
// button is (the middle of the whole box is empty) → refused as a step
mutations.length = 0;
const bT = out("TallWrapper");
const rT = await probe(["--expected", QUIET, "--url", edge("tall-wrapper"), "--out", bT, "--steps", "steps-click-only.json", "--max-time", "60000"]);
check(`[L-2] a step clicking a wrapper taller than the viewport whose on-screen middle is a form's typeless button → exit 4 'never submit' (at its click point), nothing written, nothing submitted (server saw: ${mutations.join(", ") || "nothing"})`,
  rT.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\)/.test(rT.stderr) && !written(bT) && mutations.length === 0);

// what --compare wrote reads as a report at all (guards against a half-written run)
check("the bound compare wrote a v2 report", rep2 !== null && isJsonObject(rep2.inputs));

finish();
report();
