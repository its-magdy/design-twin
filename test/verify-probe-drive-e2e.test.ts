// End-to-end tests for the probe half of the drive: the BUILT claude-plugin/scripts/verify-probe.js (and the built
// verify-screen.js for --expect / --status / --compare), run in a real chromium from a TEMP consumer project
// (design/export + design/plan + node_modules/ of its own — never the repo root, so no untracked design/ leaks in).
//
// The fixture "Plot Ledger" (test/fixtures/probe/plot-ledger.*, invented names) is a single-page app whose sections are
// picked by state, not by the URL: the Beds screen (root 70:1) exists only after its sidebar button (70:30) is clicked
// (--steps). On it, overlay openers built every way the probe must tell apart: a row action that
// shows only on row hover opening a native <dialog> (showModal, no role) holding the destination frame's tag; a
// role=dialog aria-modal div; an UNTAGGED dialog; a dead button; a button that reloads the page; a button under a
// transparent layer; a panel that is only the destination tag; and a plan-only opener (plan.interactions). ?mode=wide
// adds a 1700px strip to the Beds section only; ?mode=reload-on-first-hover reloads once on the hovered row.
// plot-ledger-edge.html holds the edge-case repros, one ?mode= each: a reload while settling into a half-loaded document,
// a reload after a step's in-place click, a link step, driving pages whose reach never answers (budget), a
// destination wrapper already on screen + disabled / submitting openers, an absolute strip escaping a
// static clipping wrapper; a click step that navigates late or reloads the same URL (exit 4),
// a step's navigation into a half-loaded document, a document replaced right after settling, tagged wrappers
// around a submitting button, a re-mounted destination wrapper, containing-block creators; a click that reloads the
// same URL at once or 100 ms later, a step's navigation into a document that never finishes
// loading, a tagged wrapper taller than the viewport; a link to the URL the page shows
// (a refresh step), late / first / goto navigations into documents that never finish loading or load late, a reload into
// one after an in-place click, a load note gone stale, documents without a token, an inline wrapper's first-line click point.
// Also: a DOM that never goes quiet, a late / never --ready, a slow image (the probe's own load waited for up
// to --timeout), the measured-anyway document's own late load, same-URL links handled in place (+ a reload / a late
// navigation away), a target=_top refresh link, the real "kept navigating" duration.
// Also: a page going on to a server that never answers before its load, a client redirect's late own load.
// Own-content detection: own content the earlier check missed (a reveal-on-scroll label, escaping positioned labels, an empty
// ::before logo or status dot, a mask icon, a swatch, a label 8000 elements deep), cell chrome it must not count (a hover tint,
// a filled wrapper, an off-document sr-only label), controls under a focusable glyph, <object> / <embed>, a smooth app shell.
// Own content by pixels: hover-revealed Deletes, dots / swatches / bands / tiles / form widgets
// drawn by pseudos, borders, shadows and fills, an out-of-flow reveal, overflow-clip-margin, a selection stripe, a tall card in a
// scrolled app shell, the plain cells that stay driven, and a page that reads the scroll it painted (&painted=1).
// Also: clip-path / background-clip fills, a shadow host's dot, the container's own marker, a hug
// wrapper's shadow ring, a layered !important, a control mounted on hover, a foreign ticker, transition:all under a strict CSP.
//
// Concurrency (test/pool.ts): every independent probe / verify-screen run is queued up front (P, the longest first) and runs
// poolSize() at a time (DT_E2E_POOL overrides; 2 under CI) — each still its own `node verify-probe.js` + chromium with its
// own --out; the checks stay in file order, each awaiting its run. An ordered chain (--status --new-run → probe --run → --status
// done → --compare; a run → its --compare) is one queued task. The serial tail (T) holds the cases with POSITIVE timing
// assertions — a --max-time budget that must be honoured, a reload / navigation / replaceState N ms after a load or a click, a
// load answered just past the 10 s cap or the --timeout, the token-switch poll spacing, the scroll-restore cap: they run one at a
// time once the pool has drained, so concurrent chromiums' CPU cannot flip them; their checks print after the pool's. The
// gotoSteps and wide runs stay pooled: their --max-time caps (25 s, 30 s) leave wide margins over a run that takes a few seconds
// under load. A write is charged to the run whose page made it (the POST's Referer query, when it is a launched --url's); any
// other write (no Referer, an <object> / <embed> subframe's own URL) is charged to every run's check, and a final check wants
// none across every run.
//
// needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI
// (CI=true) that is a failure.  Run with:  node test/verify-probe-drive-e2e.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { InteractionEvidence, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { limit, poolSize } from "./pool.ts";

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
stepFile("steps-goto-hang.json", [{ goto: "/plot-ledger-edge.html?mode=hang-first" }, { click: "[data-dt-node=\"70:30\"]" }]);
stepFile("steps-late.json", [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "#late" }]);
stepFile("steps-slow-stay.json", [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "#later" }]);
stepFile("steps-redir-slow.json", [{ waitFor: "#go" }, { click: "#go" }]);
stepFile("steps-goto-churn.json", [{ goto: "/plot-ledger-edge.html?mode=churn-dom&via=goto" }]);
stepFile("steps-no-token.json", [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "#next" }, { click: "#next" }]);
const READY = "[data-dt-node=\"70:1\"]";
// the steps' sha: canonical JSON (sorted keys) — for one-key string steps that is JSON.stringify of the list
const stepsSha = crypto.createHash("sha256").update(JSON.stringify(STEPS)).digest("hex");


// ---- a static server on an ephemeral port (the fixtures under any query string). The edge page's extras: a script
// answered 2.5 s late (a half-loaded document), POST /mutate (a write an opener's handler made — charged to the run whose
// page made it: writesOf), and ?mode=slow-reach answered at once the first time per URL, never again (the driving pages' reach hangs)
/** every write the server received (the /mutate query), and the same charged per run: the key is the full query string of the
 *  page that made it (its Referer) when that page is a fixture page at a query some run passed to --url, else "?" — charged to
 *  every run (no Referer, a subframe's own URL such as click-hidden-2's <object> / <embed> page, a page a step navigated to) */
const writes: string[] = [];
const writesBy = new Map<string, string[]>();
/** the query strings of every --url a probe run was given (registered before the run is spawned) */
const launched = new Set<string>();
const searchOf = (href: string): string => new URL(href).search;
const runOfPage = (href: string | undefined): string => {
  try {
    const u = new URL(href ?? "");
    return (u.pathname === "/plot-ledger.html" || u.pathname === "/plot-ledger-edge.html") && launched.has(u.search) ? u.search : "?";
  } catch { return "?"; }
};
/** the writes charged to the runs on these --url values, plus the unattributed ones */
const writesOf = (...urls: string[]): string[] => [...[...new Set(urls.map(searchOf))].flatMap((s) => writesBy.get(s) ?? []), ...(writesBy.get("?") ?? [])];
const seen = new Map<string, number>();
const SLOW_JS = "document.body.insertAdjacentHTML(\"beforeend\", '<div class=\"app\" data-dt-node=\"70:1\"><h1 data-dt-node=\"70:2\">Beds</h1></div>');";
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const name = path.basename(u.pathname);
  if (req.method === "POST" && name === "mutate") {
    const what = u.search.slice(1), k = runOfPage(req.headers.referer);
    writes.push(what);
    writesBy.set(k, [...(writesBy.get(k) ?? []), what]);
    res.writeHead(204); res.end(); return;
  }
  if (name === "plot-ledger-hang.png" || name === "plot-ledger-hangdoc") return; // an image that never loads (held until finish())
  if (name === "plot-ledger-slow.png") { setTimeout(() => { res.writeHead(404); res.end(); }, Number(u.searchParams.get("d") || 2500)).unref(); return; }
  if (name === "plot-ledger-late.png") { setTimeout(() => { res.writeHead(404); res.end(); }, 12_000).unref(); return; }
  if (name === "plot-ledger-slow.js") {
    setTimeout(() => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(SLOW_JS); }, Number(u.searchParams.get("d") || 2500)).unref();
    return;
  }
  const file = path.join(FIX, name);
  if ((name !== "plot-ledger.html" && name !== "plot-ledger-edge.html") || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const n = (seen.get(req.url || "") ?? 0) + 1;
  seen.set(req.url || "", n);
  if (u.searchParams.get("mode") === "slow-reach" && n > 1) return; // held until the probe gives up (closed by finish())
  // &csp=1 → a strict style CSP (an injected <style> without the page's nonce is blocked)
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(u.searchParams.get("csp") ? { "content-security-policy": "style-src 'nonce-dtcsp'" } : {}) });
  res.end(fs.readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/plot-ledger.html${mode ? `?mode=${mode}` : ""}`;
const edge = (mode: string): string => `http://127.0.0.1:${port}/plot-ledger-edge.html?mode=${mode}`;

// async spawn: the server lives in THIS process, so a spawnSync would block it from answering. ms: spawn → close (never the
// time a run waited in the pool's queue); a spawn that fails (EAGAIN under load, a synchronous throw) resolves as status null — run never rejects, never hangs the suite
interface Run { status: number | null; stdout: string; stderr: string; ms: number }
const run = (script: string, args: string[]): Promise<Run> => new Promise((resolve) => {
  const t0 = Date.now();
  let p: ChildProcessWithoutNullStreams;
  try { p = spawn(process.execPath, [script, ...args], { cwd: proj }); }
  catch (e) { resolve({ status: null, stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}\n`, ms: Date.now() - t0 }); return; }
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("error", (e) => resolve({ status: null, stdout, stderr: `${stderr}spawn failed: ${e.message}\n`, ms: Date.now() - t0 }));
  p.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
});
// These runs check reaching, measuring and driving — `--behaviour off` keeps them fast, except where a run says
// `--behaviour on` (test/verify-probe-behaviour-e2e.test.ts runs the behaviour checks themselves)
const probe = (args: string[]): Promise<Run> => {
  const at = args.indexOf("--url"), u = at >= 0 ? args[at + 1] : undefined;
  if (u !== undefined) launched.add(searchOf(u));
  return run(PROBE, [...args, ...(args.includes("--check") || args.includes("--behaviour") ? [] : ["--behaviour", "off"]), "--project", ROOT]);
};
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
  check(`the renderer is available in CI — ${reason}`, false);
  finish();
  report();
}

// ---- the expectation, from the real --expect (auto-discovers design/plan/Beds__70_1.json)
const exp = await vs(["--expect", "design/export/pages/Plots/Beds__70_1.json", "--out", out("Beds")]);
const EXPECTED = out("Beds") + ".expected.json";
if (exp.status !== 0 || !fs.existsSync(path.join(proj, EXPECTED))) { console.log(exp.stderr); check("verify-screen --expect wrote the expectation", false); finish(); report(); }
// the same expectation without interactions: for the runs that check only reaching + measuring (nothing to drive)
const QUIET = out("Quiet") + ".expected.json";
const full = readJsonOrNull(path.join(proj, EXPECTED), isVerifyExpectation);
if (full !== null) { const { interactions: _drop, ...quiet } = full; fs.writeFileSync(path.join(proj, QUIET), JSON.stringify(quiet, null, 2) + "\n"); }

// ---- the runs. P: the independent ones, queued now (the longest first) and run poolSize() at a time, each awaited where its
// checks are. T: the serial tail (wall-clock windows, see the header) — started one at a time only once P has drained.
const POOL = poolSize();
const q = limit(POOL);
const SLOW_NAV = [0, 120, 160, 200, 400, 1500] as const;
const ownPxOut = (mode: string): string => out(`OwnPixels-${mode.replace(/[^\w-]/g, "_")}`);
const ownPxRun = (mode: string): Promise<Run> => probe(["--expected", EXPECTED, "--url", edge(mode), "--out", ownPxOut(mode), "--max-time", "90000"]);
const T = {
  budget25000: () => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Budget25000"), "--steps", "steps.json", "--ready", READY, "--max-time", "25000"]),
  budget30000: () => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Budget30000"), "--steps", "steps.json", "--ready", READY, "--max-time", "30000"]),
  replace: () => probe(["--expected", QUIET, "--url", url("replace-state"), "--out", out("Replace"), "--max-time", "60000"]),
  reloadSettle: () => probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", out("ReloadSettle"), "--ready", READY, "--max-time", "60000"]),
  reloadSettleNoReady: () => probe(["--expected", QUIET, "--url", edge("reload-settle"), "--out", out("ReloadSettleNoReady"), "--max-time", "60000"]),
  reloadStep: () => probe(["--expected", QUIET, "--url", edge("reload-step"), "--out", out("ReloadStep"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"]),
  gotoReload: () => probe(["--expected", QUIET, "--url", edge("reload-after-goto"), "--out", out("GotoReload"), "--steps", "steps-goto-reload.json", "--ready", READY, "--max-time", "60000"]),
  reloadLate: () => probe(["--expected", QUIET, "--url", edge("reload-late"), "--out", out("ReloadLate"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  slowReach: () => probe(["--expected", EXPECTED, "--url", edge("slow-reach"), "--out", out("SlowReach"), "--timeout", "30000", "--max-time", "22000"]),
  smoothShell: () => probe(["--expected", EXPECTED, "--url", edge("smooth-shell"), "--out", out("SmoothShell"), "--max-time", "60000"]),
  smoothShellImportant: () => probe(["--expected", EXPECTED, "--url", `${edge("smooth-shell")}&important=1`, "--out", out("SmoothShellImportant"), "--max-time", "60000"]),
  smoothShellPainted: () => probe(["--expected", EXPECTED, "--url", `${edge("smooth-shell")}&important=1&painted=1`, "--out", out("SmoothShellPainted"), "--max-time", "60000"]),
  clickReloads: () => probe(["--expected", QUIET, "--url", edge("click-reloads"), "--out", out("ClickReloads"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  tokenSwitch: () => probe(["--expected", QUIET, "--url", edge("token-switch"), "--out", out("TokenSwitch"), "--max-time", "60000"]),
  clickReloadsSync: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync`, "--out", out("ClickReloadsSync"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  clickReloads100: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=100`, "--out", out("ClickReloads100"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  clickReloadsOnce: () => probe(["--expected", QUIET, "--url", `${edge("click-reloads")}&delay=sync&once=1`, "--out", out("ClickReloadsOnce"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  hangImg: () => probe(["--expected", QUIET, "--url", edge("hang-img"), "--out", out("HangImg"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "22000"]),
  lateSlow: () => probe(["--expected", QUIET, "--url", edge("late-slow"), "--out", out("LateSlow"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  reloadHang: () => probe(["--expected", QUIET, "--url", edge("reload-hang"), "--out", out("ReloadHang"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"]),
  lateLoad: () => probe(["--expected", QUIET, "--url", edge("late-load"), "--out", out("LateLoad"), "--steps", "steps-late.json", "--ready", READY, "--max-time", "60000"]),
  slowStay: () => probe(["--expected", QUIET, "--url", `${edge("slow-stay")}&d=7000`, "--out", out("SlowStay"), "--steps", "steps-slow-stay.json", "--ready", READY, "--timeout", "5000", "--max-time", "60000"]),
  linkInplaceReload: () => probe(["--expected", QUIET, "--url", `${edge("link-inplace-reload")}&d=300`, "--out", out("LinkInplaceReload"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  linkEmptyReload: () => probe(["--expected", QUIET, "--url", `${edge("link-empty-reload")}&d=300`, "--out", out("LinkEmptyReload"), "--steps", "steps-click-only.json", "--max-time", "60000"]),
  // (--ready on an element that never comes keeps the settle on the page while it navigates)
  slowChurn: () => probe(["--expected", QUIET, "--url", edge("slow-churn"), "--out", out("SlowChurn"), "--ready", "#never-drawn", "--timeout", "12000", "--max-time", "60000"]),
  bounceHang: () => probe(["--expected", QUIET, "--url", edge("bounce-hang"), "--out", out("BounceHang"), "--timeout", "12000", "--max-time", "40000"]),
  redirSlow: () => probe(["--expected", QUIET, "--url", edge("redir-slow"), "--out", out("RedirSlow"), "--steps", "steps-redir-slow.json", "--ready", READY, "--timeout", "30000", "--max-time", "90000"]),
};
console.log(`pool ${POOL} (DT_E2E_POOL to override), serial tail ${Object.keys(T).length} runs`);
const P = {
  // the main run again with the behaviour battery on (the longest run: first) — its check compares with main's
  bedsOn: q(() => probe(["--expected", EXPECTED, "--url", url(), "--steps", "steps.json", "--ready", READY, "--out", out("BedsOn"), "--behaviour", "on"])),
  // the main run, bound to a verify run: --status --new-run → probe --run → --status done → --compare, in that order
  main: q(async () => {
    const st = await vs(["--status", "Beds", "--phase", "starting", "--new-run", "--dir", "design/verify"]);
    const runId = /^run (\S+) rev 1$/m.exec(st.stdout)?.[1] ?? "";
    const r2 = await probe(["--expected", EXPECTED, "--url", url(), "--steps", "steps.json", "--ready", READY, ...(runId ? ["--run", runId] : [])]);
    const done = await vs(["--status", "Beds", "--phase", "done", "--run", runId, "--dir", "design/verify"]);
    const c2 = await vs(["--compare", EXPECTED, out("Beds") + ".measured.json", "--out", out("Beds")]);
    return { runId, r2, done, c2 };
  }),
  noToken: q(() => probe(["--expected", QUIET, "--url", edge("no-token"), "--out", out("NoToken"), "--steps", "steps-no-token.json", "--max-time", "60000"])),
  churnDomGoto: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("ChurnDomGoto"), "--steps", "steps-goto-churn.json", "--max-time", "60000"])),
  gotoHang: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("GotoHang"), "--steps", "steps-goto-hang.json", "--ready", READY, "--timeout", "15000", "--max-time", "60000"])),
  hangFirst: q(() => probe(["--expected", QUIET, "--url", edge("hang-first"), "--out", out("HangFirst"), "--steps", "steps-click-only.json", "--ready", READY, "--timeout", "15000", "--max-time", "60000"])),
  ownContent3: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content-3"), "--out", out("OwnContent3"), "--max-time", "90000"])),
  // the run, then its --compare
  wide: q(async () => {
    const r5 = await probe(["--expected", EXPECTED, "--url", url("wide"), "--out", out("Wide"), "--steps", "steps.json", "--ready", READY, "--max-time", "30000"]);
    const c5 = await vs(["--compare", EXPECTED, out("Wide") + ".measured.json", "--out", out("Wide")]);
    return { r5, c5 };
  }),
  slowImg: q(() => probe(["--expected", QUIET, "--url", `${edge("slow-img")}&d=13000`, "--out", out("SlowImg"), "--timeout", "30000", "--max-time", "60000"])),
  lateReady: q(() => probe(["--expected", QUIET, "--url", edge("late-ready"), "--out", out("LateReady"), "--ready", READY, "--timeout", "30000", "--max-time", "60000"])),
  readyNever: q(() => probe(["--expected", QUIET, "--url", `${edge("late-ready")}&d=99999999`, "--out", out("ReadyNever"), "--ready", READY, "--timeout", "12000", "--max-time", "60000"])),
  hangLate: q(() => probe(["--expected", QUIET, "--url", edge("hang-late"), "--out", out("HangLate"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  churnDom: q(() => probe(["--expected", QUIET, "--url", edge("churn-dom"), "--out", out("ChurnDom"), "--max-time", "60000"])),
  gotoSteps: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("GotoSteps"), "--steps", "steps-goto.json", "--ready", READY, "--max-time", "25000"])),
  ownContent2: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content-2"), "--out", out("OwnContent2"), "--max-time", "90000"])),
  px1: q(() => ownPxRun("own-pixels-1")),
  ownContent: q(() => probe(["--expected", EXPECTED, "--url", edge("own-content"), "--out", out("OwnContent"), "--max-time", "90000"])),
  px2: q(() => ownPxRun("own-pixels-2")),
  coveredTall: q(() => probe(["--expected", EXPECTED, "--url", edge("covered-tall"), "--out", out("CoveredTall"), "--max-time", "60000"])),
  px4: q(() => ownPxRun("own-pixels-4")),
  px3: q(() => ownPxRun("own-pixels-3")),
  clickHidden: q(() => probe(["--expected", EXPECTED, "--url", edge("click-hidden"), "--out", out("ClickHidden"), "--max-time", "90000"])),
  clickHidden2: q(() => probe(["--expected", EXPECTED, "--url", edge("click-hidden-2"), "--out", out("ClickHidden2"), "--max-time", "90000"])),
  pxTall: q(() => ownPxRun("tall-shell")),
  ancestor: q(() => probe(["--expected", EXPECTED, "--url", edge("ancestor"), "--out", out("Ancestor"), "--max-time", "90000"])),
  pxCsp: q(() => ownPxRun("own-pixels-csp&csp=1")),
  cardCentre: q(() => probe(["--expected", EXPECTED, "--url", edge("card-centre"), "--out", out("CardCentre"), "--max-time", "90000"])),
  remount: q(() => probe(["--expected", EXPECTED, "--url", edge("remount"), "--out", out("Remount"), "--max-time", "90000"])),
  wrapperOpener: q(() => probe(["--expected", EXPECTED, "--url", edge("wrapper-submit"), "--out", out("WrapperSubmitOpener"), "--max-time", "90000"])),
  reload: q(() => probe(["--expected", QUIET, "--url", url("reload-on-first-hover"), "--out", out("Reload"), "--steps", "design/plan/Beds__70_1.json", "--ready", READY, "--max-time", "60000"])),
  ambiguous: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Ambiguous"), "--steps", "steps-ambiguous.json"])),
  clickNavSlow: q(() => probe(["--expected", QUIET, "--url", edge("clicknav-slow"), "--out", out("ClickNavSlow"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  noSteps: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("NoSteps"), "--ready", READY, "--timeout", "3000"])),
  waitMany: q(() => probe(["--expected", QUIET, "--url", url(), "--out", out("WaitMany"), "--steps", "steps-waitfor-many.json"])),
  linkLateAway: q(() => probe(["--expected", QUIET, "--url", edge("link-inplace-late-away"), "--out", out("LinkLateAway"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  linkStep: q(() => probe(["--expected", QUIET, "--url", edge("link-step"), "--out", out("LinkStep"), "--steps", "steps-reload-step.json", "--ready", READY, "--max-time", "60000"])),
  sameLink: q(() => probe(["--expected", QUIET, "--url", `${edge("same-link")}&section=beds`, "--out", out("SameLink"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  sameLinkTop: q(() => probe(["--expected", QUIET, "--url", `${edge("same-link")}&section=beds&target=_top`, "--out", out("SameLinkTop"), "--steps", "steps-click-only.json", "--ready", READY, "--max-time", "60000"])),
  absEscape: q(() => probe(["--expected", QUIET, "--url", edge("abs-escape"), "--out", out("AbsEscape"), "--max-time", "60000"])),
  cbCreators: q(() => probe(["--expected", QUIET, "--url", edge("cb-creators"), "--out", out("CbCreators"), "--max-time", "60000"])),
  wrapperStep: q(() => probe(["--expected", QUIET, "--url", edge("wrapper-submit"), "--out", out("WrapperSubmitStep"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  tallWrapper: q(() => probe(["--expected", QUIET, "--url", edge("tall-wrapper"), "--out", out("TallWrapper"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  submit: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Submit"), "--steps", "steps-submit.json"])),
  inlineWrap: q(() => probe(["--expected", QUIET, "--url", edge("inline-wrap"), "--out", out("InlineWrap"), "--steps", "steps-click-only.json", "--max-time", "60000"])),
  fill: q(() => probe(["--expected", EXPECTED, "--url", url(), "--out", out("Fill"), "--steps", "steps-fill.json"])),
};
// a click step navigating to another URL `delay` ms after the click (its ownership does not ride on the timing)
const slowNav = SLOW_NAV.map((delay) => ({ delay, run: q(() => probe(["--expected", QUIET, "--url", `${edge("slow-nav")}&delay=${delay}`, "--out", out(`SlowNav${delay}`), "--steps", "steps-reload-step.json", "--max-time", "60000"])) }));

// ---- the screen behind a click
const r1 = await P.noSteps;
check("1 no --steps + --ready on the section's root (only there after a click) → exit 4, nothing written", r1.status === 4 && !written(out("NoSteps")));

// the main run, bound to a verify run: --status --new-run → probe --run → --status done → --compare (one queued task: P.main)
const { runId, r2, done, c2 } = await P.main;
const m2 = read(out("Beds"));
if (r2.status !== 0) console.log(r2.stderr);
check("2 --steps (click the sidebar button, waitFor the root) → exit 0, measured.json written", r2.status === 0 && m2 !== null);
check("2 measured.reach: 2 steps, sha256 of their canonical JSON, source '--steps steps.json', the url after the steps",
  m2?.reach?.steps.length === 2 && m2.reach.sha256 === stepsSha && m2.reach.source === "--steps steps.json" && /plot-ledger\.html#beds$/.test(m2.reach.url));
check("2 the steps' pushState is no navigation: afterInitialLoad 0, re-runs 0", m2?.navigation?.afterInitialLoad === 0 && m2.navigation.reruns === 0);
check("2 the Beds section's specs are measured (the frame root by tag, its heading by tag)", m2?.frame?.nodeId === "70:1" && m2.frame.via === "tag"
  && (m2.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag"));

// what the probe drove
const e6 = ix(m2, "70:44");
check("6 a hover-revealed row action (visibility:hidden until its tagged <tr> is hovered) opening a native <dialog> via showModal → ok:true, dialog-opened, detectedBy :modal, mouse, revealedBy the row, destination inside, navEvents 0",
  e6?.ok === true && e6.outcome === "dialog-opened" && e6.detectedBy === ":modal" && e6.activation === "mouse" && e6.revealedBy === "[data-dt-node=\"70:41\"]"
  && e6.destination?.nodeId === "70:60" && e6.destination.inside && e6.navEvents === 0 && e6.selectorCount === 1 && e6.selector === "[data-dt-node=\"70:44\"]");
check("[seam] 6 opened recorded raw: modal true, position fixed, a rect", e6?.opened?.modal === true && e6.opened.position === "fixed" && e6.opened.rect.w > 0);
const e7 = ix(m2, "70:45");
check("7 a div role=dialog aria-modal → ok:true, detectedBy [role=dialog]", e7?.ok === true && e7.outcome === "dialog-opened" && e7.detectedBy === "[role=dialog]" && e7.destination?.inside === true);
const e8 = ix(m2, "70:46");
check("8 a dialog without the destination tag → ok:null, destination.inside false, the detail says to tag it", e8?.ok === null && e8.detectedBy === ":modal" && e8.destination?.inside === false && /tag the dialog's root/.test(e8.detail || ""));
const e9 = ix(m2, "70:47");
check("9 a dead button → ok:null, outcome none (never ok:false)", e9?.ok === null && e9.outcome === "none" && e9.activation === "mouse");
check("the probe never writes ok:false", (m2?.interactions || []).length === 8 && (m2?.interactions || []).every((i) => i.ok !== false));
const e10 = ix(m2, "70:48");
check("10 a click that reloads the page → navEvents 1, ok:null", e10?.ok === null && e10.navEvents === 1);
const e11 = ix(m2, "70:49");
check("11 an opener under a transparent layer → synthetic click, ok:null 'not a user activation' (the dialog did open)", e11?.ok === null && e11.activation === "synthetic"
  && e11.detectedBy === ":modal" && /not a user activation/.test(e11.detail || "") && /intercepts pointer events/.test(e11.detail || ""));
const e12 = ix(m2, "70:50");
check("12 a plan-only opener (plan.interactions expect dialog) → driven: ok:true, dialog-opened, the dialog itself carries the tag", e12?.ok === true && e12.detectedBy === ":modal" && e12.destination?.inside === true);
const e13 = ix(m2, "70:53");
check("[planner default 1] a panel that is only the destination tag (no dialog contract) → ok:true, selector-appeared, detectedBy destination-tag", e13?.ok === true && e13.outcome === "selector-appeared" && e13.detectedBy === "destination-tag");
check("14 measured.page at the design width: scrollWidth = clientWidth = 1024, not scrollable, no offenders, standards mode",
  m2?.page?.scrollWidth === 1024 && m2.page.clientWidth === 1024 && m2.page.viewport.w === 1024 && !m2.page.scrollable && m2.page.offenders.length === 0 && m2.page.overflowX === "visible" && m2.page.compatMode === "CSS1Compat");

if (done.status !== 0) console.log(done.stderr);
const rep2 = readReport(out("Beds"));
if (rep2 === null) console.log(c2.stderr);
check("6 --compare: the hover-revealed overlay passes (was not-probed: nothing drove it)", res(rep2, "70:44")?.result === "pass");
check("12 --compare: the plan row is graded (source plan) and passes", res(rep2, "70:50")?.result === "pass" && res(rep2, "70:50")?.source === "plan");
check("8 --compare: the untagged dialog is not-probed, never pass", res(rep2, "70:46")?.result === "not-probed");
check("9/10/11 --compare: dead, reloading and covered openers are not-probed, never fail", ["70:47", "70:48", "70:49"].every((id) => res(rep2, id)?.result === "not-probed"));
check("15 run-bound (--run, done, compare without --interactions) → the probe's rows are graded as the probe's (evidenceFrom probe)",
  runId !== "" && done.status === 0 && res(rep2, "70:44")?.evidenceFrom === "probe" && (rep2?.coverage?.interactionsByProbe ?? 0) >= 4);
check("14 --compare at the design width: pageOverflow ok, no overflowX delta", rep2?.coverage?.pageOverflow === "ok" && !(rep2.deltas || []).some((d) => d.field === "overflowX"));
check("--compare: inputs.reach (2 steps, matches the plan's navigate)", rep2?.inputs?.reach?.steps === 2 && rep2.inputs.reach.matchesPlan === true);

// the behaviour battery runs AFTER the drive, in its own pages — the same run with behaviour on records the same
// interaction evidence (hover-revealed, role=dialog, untagged, dead, reloading, covered, plan-only, panel openers)
const bOn = out("BedsOn");
const rOn = await P.bedsOn;
const mOn = read(bOn);
if (rOn.status !== 0) console.log(rOn.stderr);
check("13 --behaviour on: exit 0, measured.behaviour ran, and measured.interactions identical to the --behaviour off run's",
  rOn.status === 0 && mOn?.behaviour?.ran === true && (m2?.interactions || []).length === 8 && JSON.stringify(mOn.interactions) === JSON.stringify(m2?.interactions)
  && m2?.behaviour?.ran === false);

// a step that loads a page (goto) is the probe's own navigation; a small --max-time leaves no driving budget
const b3 = out("GotoSteps");
const r3 = await P.gotoSteps;
const m3 = read(b3);
if (r3.status !== 0) console.log(r3.stderr);
check("2b a goto step (a document load) → exit 0, reach 3 steps, afterInitialLoad 0 (the step's load is the probe's own)", r3.status === 0 && m3?.reach?.steps.length === 3 && m3.navigation?.afterInitialLoad === 0);
const cut3 = (m3?.interactions || []).filter((i) => i.cut === "budget");
check("budget: --max-time 25 s leaves ≤ 10 s of driving → rows cut: ok:null, cut budget, 'not-run: time budget'; the measured file still written",
  cut3.length > 0 && cut3.every((i) => i.ok === null && i.detail === "not-run: time budget"));
// (Budget25000 / Budget30000 and the replaceState run: the serial tail)

// a reload during measurement → one full re-run, which replays the steps (the plan's navigate as --steps)
const b4 = out("Reload");
const r4 = await P.reload;
const m4 = read(b4);
if (r4.status !== 0) console.log(r4.stderr);
check("3 a reload on the first hover → exit 0, re-runs 1, the steps replayed (the root measured by tag), a note on the kept storage",
  r4.status === 0 && m4?.navigation?.reruns === 1 && m4.frame?.via === "tag" && m4.frame.nodeId === "70:1" && (m4.notes || []).some((n) => /replayed the steps in the same browser context/.test(n)));
check("--steps <plan>: the plan's navigate list, source names the plan file, the same sha", m4?.reach?.source === "--steps design/plan/Beds__70_1.json" && m4.reach.sha256 === stepsSha);

// a sideways overflow only in the section the steps reach
const b5 = out("Wide");
const { r5, c5 } = await P.wide;
const m5 = read(b5);
if (r5.status !== 0) console.log(r5.stderr);
check("13 a 1700px strip in the Beds section → page.scrollWidth ≥ 1600, scrollable, the strip named among the offenders",
  r5.status === 0 && (m5?.page?.scrollWidth ?? 0) >= 1600 && m5?.page?.scrollable === true && m5.page.offenders.some((o) => o.dt === "70:57"));
const rep5 = readReport(b5);
if (rep5 === null) console.log(c5.stderr);
const ov = (rep5?.deltas || []).find((d) => d.field === "overflowX");
check("13 --compare: one HIGH overflowX delta on the root frame (expected clientWidth, actual scrollWidth)", ov?.severity === "high" && ov.nodeId === "70:1" && ov.expected === 1024 && typeof ov.actual === "number" && ov.actual >= 1600);

// steps that must fail: ambiguous, a submit, a step outside the vocabulary
const r6 = await P.ambiguous;
check("4 a step matching 2 visible elements → exit 4 'matched 2', the step and the navigation log printed, nothing written",
  r6.status === 4 && /step 1 \{click: "\.nav-btn"\} matched 2 visible element/.test(r6.stderr) && /navigation log/.test(r6.stderr) && !written(out("Ambiguous")));
const r7 = await P.submit;
check("5 a step clicking a form's typeless button → exit 4 'never submit', nothing written", r7.status === 4 && /never submit/.test(r7.stderr) && !written(out("Submit")));
const r8 = await P.fill;
check("a {fill} step → exit 2 naming it (the vocabulary is click / waitFor / goto)", r8.status === 2 && /\{fill: …\} is not a step/.test(r8.stderr) && !written(out("Fill")));

// a waitFor is met by one or more visible matches (a click still needs exactly one: check 4 above)
const b10 = out("WaitMany");
const r10 = await P.waitMany;
if (r10.status !== 0) console.log(r10.stderr);
check("a waitFor step matching 7 visible elements → met (exit 0, reach 2 steps)", r10.status === 0 && read(b10)?.reach?.steps.length === 2);

// ---- edge-page repros (plot-ledger-edge.html)
// (ReloadSettle, ReloadSettleNoReady, ReloadStep, GotoReload, ReloadLate: the serial tail)
const b13 = out("LinkStep");
const r13 = await P.linkStep;
const m13 = read(b13);
if (r13.status !== 0) console.log(r13.stderr);
check("a step whose click follows a link → that load is the step's own: afterInitialLoad 0, re-runs 0, the root by tag",
  r13.status === 0 && m13?.navigation?.afterInitialLoad === 0 && m13.navigation.reruns === 0 && m13.frame?.via === "tag" && /section=beds/.test(m13.reach?.url ?? ""));
// (SlowReach: the serial tail)

// an ancestor-tagged opener, with no write made
const b15 = out("Ancestor");
const r15 = await P.ancestor;
const m15 = read(b15);
if (r15.status !== 0) console.log(r15.stderr);
const e47 = ix(m15, "70:47"), e49 = ix(m15, "70:49");
check("an unrelated dialog opening inside a destination-tagged wrapper that was already on screen → destination NOT inside, ok:null",
  e47?.ok === null && e47.detectedBy === "[role=dialog]" && e47.destination?.inside === false && /not inside the opened element/.test(e47.detail || ""));
check("a destination-tagged wrapper that appears with its dialog (an ancestor, newly visible) → inside, ok:true",
  e49?.ok === true && e49.detectedBy === "[role=dialog]" && e49.destination?.inside === true);
check("disabled openers (aria-disabled on it / on an ancestor, [disabled]) → ok:null 'opener is disabled — not driven', no activation",
  ["70:44", "70:45", "70:46"].every((id) => { const e = ix(m15, id); return e?.ok === null && e.detail === "opener is disabled — not driven" && e.activation === undefined; }));
check("a typeless <button> in a <form> as the opener → ok:null 'opener would submit a form', not clicked",
  ix(m15, "70:48")?.ok === null && /^opener would submit a form/.test(ix(m15, "70:48")?.detail || "") && ix(m15, "70:48")?.activation === undefined);
const w15 = writesOf(edge("ancestor"));
check(`no opener's handler ran a write (server saw: ${w15.join(", ") || "nothing"})`, r15.status === 0 && w15.length === 0);

// the drive's click point (the opener's centre) is another control inside the opener → never clicked
const bCC = out("CardCentre");
const rCC = await P.cardCentre;
const mCC = read(bCC);
if (rCC.status !== 0) console.log(rCC.stderr);
check("a card opener whose centre is its own Delete button (a 2nd control beside it) → not driven: ok:null 'the opener's click point is another control inside it (<button aria-label=\"Delete bed\">) — tag that control or the opener's own clickable element', no activation",
  ix(mCC, "70:47")?.ok === null && /^the opener's click point is another control inside it \(<button aria-label="Delete bed">\) — tag that control or the opener's own clickable element/.test(ix(mCC, "70:47")?.detail || "") && ix(mCC, "70:47")?.activation === undefined);
check("a cell whose ONLY focusable is its centred icon button → that button is the opener: driven, ok:true", ix(mCC, "70:49")?.ok === true && ix(mCC, "70:49")?.activation === "mouse");
const refused = (id: string): boolean => ix(mCC, id)?.ok === null && /^the opener's click point is another control inside it \(<button aria-label="Delete bed">\) — tag that control or the opener's own clickable element/.test(ix(mCC, id)?.detail || "") && ix(mCC, id)?.activation === undefined;
check("a card with its own label whose ONLY control is its centred Delete → not the card's own control: not driven, ok:null naming <button aria-label=\"Delete bed\">, no activation", refused("70:45"));
check("a cell whose only other content is an sr-only label → its centred button is the opener: driven, ok:true", ix(mCC, "70:53")?.ok === true && ix(mCC, "70:53")?.activation === "mouse");
check("a FOCUSABLE card (role=button tabindex=0) and an <a href> card, each with a centred Delete → not driven, ok:null naming the Delete, no activation", refused("70:46") && refused("70:48"));
const wCC = writesOf(edge("card-centre"));
check(`the drive pressed no Delete (server saw: ${wCC.join(", ") || "nothing"})`, rCC.status === 0 && wCC.length === 0);

// what the centre click would press beyond a plain focusable inside the card — a label's checkbox, a role=button
// span without tabindex, a shadow-DOM button (also through slotted text), an iframe — never clicked; a plain cell is still driven
const notDrivenFor = (m: VerifyMeasured | null, id: string, ctl: string): boolean => ix(m, id)?.ok === null && ix(m, id)?.activation === undefined
  && (ix(m, id)?.detail || "").startsWith(`the opener's click point is another control inside it (${ctl}) — tag that control or the opener's own clickable element`);
const bCH = out("ClickHidden");
const rCH = await P.clickHidden;
const mCH = read(bCH);
if (rCH.status !== 0) console.log(rCH.stderr);
check("a <label for> its checkbox at the card's centre (70:44) and a label wrapping its checkbox (70:45) → not driven, ok:null naming the checkbox (the label's control)",
  notDrivenFor(mCH, "70:44", "<input type=\"checkbox\" aria-label=\"Packed\">") && notDrivenFor(mCH, "70:45", "<input type=\"checkbox\" aria-label=\"Done\">"));
check("a centred span role=button WITHOUT tabindex (70:46) → not driven, ok:null naming it", notDrivenFor(mCH, "70:46", "<span role=\"button\" aria-label=\"Delete bed\">"));
check("a web component's shadow <button> at the centre (70:47), and text slotted into a shadow <button> (70:50) → not driven, ok:null naming the shadow button",
  notDrivenFor(mCH, "70:47", "<button aria-label=\"Delete\">") && notDrivenFor(mCH, "70:50", "<button aria-label=\"Remove\">"));
check("an iframe at the card's centre (70:48) → not driven, ok:null naming <iframe>", notDrivenFor(mCH, "70:48", "<iframe>"));
check("a cell whose ONLY focusable is its centred icon button (70:49) → still driven, ok:true, mouse", ix(mCH, "70:49")?.ok === true && ix(mCH, "70:49")?.activation === "mouse");
const wCH = writesOf(edge("click-hidden"));
check(`the drive toggled no checkbox and pressed no Delete (server saw: ${wCH.join(", ") || "nothing"})`, rCH.status === 0 && wCH.length === 0);

// a card's own content the check must see (display:contents text, shadow text, a ::before label, a
// background-image logo) → its centred Delete is never clicked; a cell's text that shows nothing (an opacity-0 tooltip, a
// clip-path-only sr-only label, an opacity-0 wrapper, an aria-hidden scale(0) tooltip) → its button is the opener's: driven
const bOC = out("OwnContent");
const rOC = await P.ownContent;
const mOC = read(bOC);
if (rOC.status !== 0) console.log(rOC.stderr);
check("cards whose own label is text in display:contents wrappers (70:44), a shadow-root title (70:45), a ::before label (70:46) or a background-image logo (70:47) → not driven, ok:null naming the centred Delete",
  ["70:44", "70:45", "70:46", "70:47"].every((id) => notDrivenFor(mOC, id, "<button aria-label=\"Delete bed\">")));
check("cells whose sole centred button sits beside an opacity-0 tooltip (70:48), a clip-path-only sr-only label (70:49), an opacity-0 wrapper's tooltip (70:50) or an aria-hidden scale(0) tooltip (70:53) → driven, ok:true, mouse (was: refused)",
  ["70:48", "70:49", "70:50", "70:53"].every((id) => ix(mOC, id)?.ok === true && ix(mOC, id)?.activation === "mouse"));
const wOC = writesOf(edge("own-content"));
check(`the drive pressed no Delete (server saw: ${wOC.join(", ") || "nothing"})`, rOC.status === 0 && wOC.length === 0);

// a covered opener's synthetic click starts from the drive's own scroll — its evidence never depends on how many
// Playwright click retries (each scrolling with another alignment) fitted into the 2 s
const bCT = out("CoveredTall");
const rCT = await P.coveredTall;
const eCT = ix(read(bCT), "70:49");
if (rCT.status !== 0) console.log(rCT.stderr);
check(`a covered opener in view on a tall page → synthetic click from the drive's scroll: opened.scrollY 0 (saw ${String(eCT?.opened?.scrollY)}), the dialog detected`,
  rCT.status === 0 && eCT?.activation === "synthetic" && eCT.opened?.scrollY === 0 && eCT.detectedBy === "[role=dialog]");

// own content the check missed or misread — an in-flow opacity-0 label fading in once scrolled into
// view, labels escaping a 1 × 1 overflow:hidden wrapper (absolute, fixed), an empty ::before logo on a background-image, a CSS-mask
// icon, a colour swatch → the centred Delete is never clicked; a hover tint over a whole cell and a filled wrapper around its sole
// button are the cell's own chrome → driven
const bO2 = out("OwnContent2");
const rO2 = await P.ownContent2;
const mO2 = read(bO2);
if (rO2.status !== 0) console.log(rO2.stderr);
check("a card below the fold whose label is opacity 0 in flow until it is scrolled into view (reveal-on-scroll, 70:44) → not driven, ok:null naming the centred Delete (was: pressed)",
  notDrivenFor(mO2, "70:44", "<button aria-label=\"Delete bed\">"));
check("a label absolutely (70:45) or fixed (70:46) positioned inside a 1 × 1 overflow:hidden static wrapper → not driven, ok:null naming the centred Delete",
  notDrivenFor(mO2, "70:45", "<button aria-label=\"Delete bed\">") && notDrivenFor(mO2, "70:46", "<button aria-label=\"Delete bed\">"));
check("an empty ::before logo on a background-image (70:47), a CSS-mask icon (70:48), a colour swatch (70:49) → not driven, ok:null naming the centred Delete",
  ["70:47", "70:48", "70:49"].every((id) => notDrivenFor(mO2, id, "<button aria-label=\"Delete bed\">")));
check("a cell under a pointer-events:none hover tint over the whole cell (70:50), a cell whose sole button sits in a filled wrapper (70:53) → driven, ok:true, mouse",
  ["70:50", "70:53"].every((id) => ix(mO2, id)?.ok === true && ix(mO2, id)?.activation === "mouse"));
const wO2 = writesOf(edge("own-content-2"));
check(`the drive pressed no Delete (server saw: ${wO2.join(", ") || "nothing"})`, rO2.status === 0 && mO2 !== null && wO2.length === 0);

// an sr-only label off the document's start edge shows nothing; an empty ::before status dot on a
// background colour is content, an empty ::after tint over the whole cell and an out-of-flow opacity-0 ::after tooltip are not;
// a label 8000 elements deep is found without a stack overflow
const bO3 = out("OwnContent3");
const rO3 = await P.ownContent3;
const mO3 = read(bO3);
if (rO3.status !== 0) console.log(rO3.stderr);
check("a cell whose sr-only label is at left:-9999px (off the document's start edge) → driven, ok:true, mouse (was: refused)",
  ix(mO3, "70:44")?.ok === true && ix(mO3, "70:44")?.activation === "mouse");
check("a card's status dot drawn by an empty ::before on a background colour beside its centred Delete (70:45) → not driven, ok:null naming the Delete",
  notDrivenFor(mO3, "70:45", "<button aria-label=\"Delete bed\">"));
check("a cell with an out-of-flow opacity-0 ::after tooltip (70:47), the plain cell (70:49) → driven, ok:true, mouse",
  ["70:47", "70:49"].every((id) => ix(mO3, id)?.ok === true && ix(mO3, id)?.activation === "mouse"));
// the container's OWN ::before / ::after are hidden in the all-content shot — a tint the cell paints with its
// own ::after over the whole cell is a painted pseudo of its own: its sole button is not taken for the opener's
check("a cell painting a tint with its own empty ::after over the whole cell (70:46) → not driven by the pixels, ok:null naming its button",
  notDrivenFor(mO3, "70:46", "<button aria-label=\"Open bed\">") && /paints something of its own beside it/.test(ix(mO3, "70:46")?.detail ?? ""));
check(`a card whose label is 8000 elements deep (70:48) → a clean refusal naming the Delete, no 'driving failed' (saw: ${ix(mO3, "70:48")?.detail ?? "no row"})`,
  notDrivenFor(mO3, "70:48", "<button aria-label=\"Delete bed\">"));
const wO3 = writesOf(edge("own-content-3"));
check(`the drive pressed no Delete (server saw: ${wO3.join(", ") || "nothing"})`, rO3.status === 0 && mO3 !== null && wO3.length === 0);

// an activating control anywhere on the click point's path wins over a merely focusable element below it; an
// <object> / <embed> is a nested browsing context → never clicked (a write from inside them carries the subframe's own URL:
// charged to every run)
const bR6c = out("ClickHidden2");
const rR6c = await P.clickHidden2;
const mR6c = read(bR6c);
if (rR6c.status !== 0) console.log(rR6c.stderr);
check("a centred <button> Delete whose glyph is a tabindex=-1 span (70:44) → not driven, ok:null naming the button (was: pressed)",
  notDrivenFor(mR6c, "70:44", "<button aria-label=\"Delete bed\">"));
check("a span role=button Delete with a tabindex=-1 glyph (70:45) or a contenteditable label (70:46) → not driven, ok:null naming the span role=button",
  notDrivenFor(mR6c, "70:45", "<span role=\"button\" aria-label=\"Delete bed\">") && notDrivenFor(mR6c, "70:46", "<span role=\"button\" aria-label=\"Delete bed\">"));
check("an <object> (70:47) and an <embed> (70:48) at the card's centre showing a page whose Delete fills them → not driven, ok:null naming <object> / <embed>",
  notDrivenFor(mR6c, "70:47", "<object type=\"text/html\">") && notDrivenFor(mR6c, "70:48", "<embed type=\"text/html\">"));
check("the plain cell (70:49) → still driven, ok:true, mouse", ix(mR6c, "70:49")?.ok === true && ix(mR6c, "70:49")?.activation === "mouse");
const wR6c = writesOf(edge("click-hidden-2"));
check(`the drive pressed no Delete inside the openers (server saw: ${wR6c.join(", ") || "nothing"})`, rR6c.status === 0 && mR6c !== null && wR6c.length === 0);
// (SmoothShell, SmoothShellImportant, SmoothShellPainted: the serial tail)

// a container's sole centred control is its own only when the container paints nothing of its
// own beside it — decided by pixels (only that control hidden vs all its content hidden), as a union with the DOM check; the
// opener is hovered first, so a hover-revealed Delete is at the click point. Every Delete here writes; none may be pressed
const ownPx = async (mode: string, pending: Promise<Run>): Promise<{ m: VerifyMeasured | null; status: number | null; writes: string[] }> => {
  const r = await pending;
  if (r.status !== 0) console.log(r.stderr);
  return { m: read(ownPxOut(mode)), status: r.status, writes: writesOf(edge(mode)) };
};
const DEL = "<button aria-label=\"Delete bed\">";
const byPixels = (m: VerifyMeasured | null, id: string): boolean => notDrivenFor(m, id, DEL) && /paints something of its own beside it/.test(ix(m, id)?.detail ?? "");
const drivenOk = (m: VerifyMeasured | null, ids: string[]): boolean => ids.every((id) => ix(m, id)?.ok === true && ix(m, id)?.activation === "mouse");
const p1 = await ownPx("own-pixels-1", P.px1);
check("a labelled card whose centred Delete shows only on :hover — by visibility (70:44), display (70:45), opacity + pointer-events (70:46) → not driven, ok:null naming the Delete (was: pressed)",
  ["70:44", "70:45", "70:46"].every((id) => notDrivenFor(p1.m, id, DEL)));
check("a status dot drawn by the card's own empty ::before (70:47), by an empty ::before of a wrapper holding the Delete (70:48), a swatch drawn by the card's own ::after (70:49) → not driven by the pixels, naming the Delete (was: pressed)",
  ["70:47", "70:48", "70:49"].every((id) => byPixels(p1.m, id)));
check("a cell under a hover tint over the whole cell (70:53), a cell whose sole button sits in a filled wrapper (70:50) → still driven, ok:true, mouse",
  drivenOk(p1.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p1.writes.join(", ") || "nothing"})`, p1.status === 0 && p1.m !== null && p1.writes.length === 0);
const p2 = await ownPx("own-pixels-2", P.px2);
check("a dot drawn by a border (70:46), a swatch drawn by a box-shadow (70:47), a band across the centre (70:48), a colour tile holding the Delete (70:49) → not driven by the pixels, naming the Delete (was: pressed)",
  ["70:46", "70:47", "70:48", "70:49"].every((id) => byPixels(p2.m, id)));
check("a <progress> (70:44), a <meter> (70:45) → not driven, naming the Delete — now by the DOM's media rule, before the pixels (was: pressed)",
  ["70:44", "70:45"].every((id) => notDrivenFor(p2.m, id, DEL) && !/paints something of its own beside it/.test(ix(p2.m, id)?.detail ?? "")));
check("a cell with a Tailwind sr-only label (70:53), a cell with a transform:scale(0) aria-hidden tooltip (70:50) → still driven, ok:true, mouse",
  drivenOk(p2.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p2.writes.join(", ") || "nothing"})`, p2.status === 0 && p2.m !== null && p2.writes.length === 0);
const p3 = await ownPx("own-pixels-3", P.px3);
check("a card below the fold whose out-of-flow label fades in once scrolled into view (70:44) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(p3.m, "70:44", DEL));
check("a label painted past its 1 × 1 overflow:clip box by overflow-clip-margin (70:45) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(p3.m, "70:45", DEL));
check("a cell with a 3-px selection stripe beside its icon button (70:46) → not driven, naming the button: a painted stripe is the cell's own content",
  notDrivenFor(p3.m, "70:46", "<button aria-label=\"Open bed\">"));
check("a cell with an icon inside its button (70:47), a clip-path sr-only label (70:48), an opacity-0 tooltip (70:49), a left:-9999px sr-only label (70:53), the plain cell (70:50) → still driven, ok:true, mouse",
  drivenOk(p3.m, ["70:47", "70:48", "70:49", "70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p3.writes.join(", ") || "nothing"})`, p3.status === 0 && p3.m !== null && p3.writes.length === 0);
// under a strict style CSP: the probe hides by its own constructed sheet (CSSOM), which a CSP never blocks
const pC = await ownPx("own-pixels-csp&csp=1", P.pxCsp);
check("[CSP] under style-src 'nonce-…' a card's own ::before status dot beside its sole centred Delete (70:44) → not driven by the pixels, naming the Delete; the plain cell (70:53) → driven",
  byPixels(pC.m, "70:44") && drivenOk(pC.m, ["70:53"]));
check("under the same CSP a cell whose button has transition:all (70:50) → driven, ok:true, mouse (was: refused 'could not hide its control' — the init CSS <style> was blocked)",
  drivenOk(pC.m, ["70:50"]));
check(`[CSP] the drive pressed no Delete (server saw: ${pC.writes.join(", ") || "nothing"})`, pC.status === 0 && pC.m !== null && pC.writes.length === 0);
// the boxes kept as decoration only when their pixels are plain, a shadow host's own content,
// the container's own ::marker, a layered !important, everything outside the container hidden in both shots (a foreign ticker),
// a control unmounted when the pointer leaves
const p4 = await ownPx("own-pixels-4", P.px4);
const isD53 = (m: VerifyMeasured | null, id: string, re: RegExp): boolean => notDrivenFor(m, id, DEL) && re.test(ix(m, id)?.detail ?? "");
check("an inset:0 fill clipped to a corner flag by clip-path (70:44), one painted only in a 4-px content box by background-clip (70:45) → never kept as decoration: not driven by the pixels, naming the Delete (was: pressed)",
  byPixels(p4.m, "70:44") && byPixels(p4.m, "70:45"));
check("a web-component card whose shadow root holds a status dot beside its slotted sole Delete (70:46) → not driven by the pixels, naming the Delete (was: pressed)",
  byPixels(p4.m, "70:46"));
check("a card that is a list item with its own '1.' marker (70:47) → not driven, naming the Delete (was: pressed)", notDrivenFor(p4.m, "70:47", DEL));
check("a wrapper hugging the Delete whose box-shadow paints a ring (70:48) → not a plain fill: not driven, naming the Delete (was: pressed)",
  isD53(p4.m, "70:48", /not a plain fill/));
check("a status dot forced visible by an !important inside a cascade layer (70:49) → the probe's rule did not take: not driven, naming the Delete (was: pressed)",
  isD53(p4.m, "70:49", /kept <span> inside the opener showing/));
check("a cell whose button is mounted on hover and unmounted when the pointer leaves (70:53), a cell under a foreign ticker repainting every 10 ms (70:50) → driven, ok:true, mouse",
  drivenOk(p4.m, ["70:53", "70:50"]));
check(`the drive pressed no Delete (server saw: ${p4.writes.join(", ") || "nothing"})`, p4.status === 0 && p4.m !== null && p4.writes.length === 0);
// in an app shell scrolled so a tall card's label lies above the shell's top, the label is still the card's own
// (scrolling the shell reaches it): its Delete is never clicked; a plain cell in the same shell is driven
const pT = await ownPx("tall-shell", P.pxTall);
check("a 900-px card in a scrolled app shell, its label above the shell's top, its Delete under the click point (70:44) → not driven, naming the Delete (was: pressed)",
  notDrivenFor(pT.m, "70:44", DEL));
check("a cell in the same shell (70:53) → driven, ok:true, mouse", drivenOk(pT.m, ["70:53"]));
check(`the drive pressed no Delete (server saw: ${pT.writes.join(", ") || "nothing"})`, pT.status === 0 && pT.m !== null && pT.writes.length === 0);

// an absolute strip escaping a static overflow:hidden wrapper widens the page and is named; a clipped one is not
const b16 = out("AbsEscape");
const r16 = await P.absEscape;
const m16 = read(b16);
if (r16.status !== 0) console.log(r16.stderr);
check("an absolute element inside a static overflow:hidden wrapper → page scrolls sideways and it is named among the offenders; one clipped by a positioned wrapper is not",
  r16.status === 0 && m16?.page?.scrollable === true && (m16.page.scrollWidth ?? 0) >= 1500 && m16.page.offenders.some((o) => o.dt === "70:57") && !m16.page.offenders.some((o) => o.dt === "70:58"));

// ---- late-navigation repros (plot-ledger-edge.html)
// a click step whose page navigates to ANOTHER URL only later (an app that awaits a request first) — that navigation
// is the step's own however late it starts: no re-run, not after the initial load. 0 and 120 ms are guards.
for (const { delay, run: pending } of slowNav) {
  const b = out(`SlowNav${delay}`);
  const r = await pending;
  const m = read(b);
  if (r.status !== 0) console.log(r.stderr);
  check(`${delay <= 120 ? "[guard] " : ""}a click step navigating ${delay} ms after the click → the step's own: exit 0, the root by tag, afterInitialLoad 0, re-runs 0, reach url section=beds`,
    r.status === 0 && m?.frame?.via === "tag" && m.frame.nodeId === "70:1" && m.navigation?.afterInitialLoad === 0 && m.navigation.reruns === 0 && /section=beds/.test(m.reach?.url ?? ""));
}
// the click's navigation commits at once into a document that stays half-loaded (quiet) for 2.5 s — waited for
const bM = out("ClickNavSlow");
const rM = await P.clickNavSlow;
const mM = read(bM);
if (rM.status !== 0) console.log(rM.stderr);
check("a step's navigation into a half-loaded document (no --ready) → its load is waited for: the root by tag, its heading measured, afterInitialLoad 0",
  rM.status === 0 && mM?.frame?.via === "tag" && (mM.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag") && mM.navigation?.afterInitialLoad === 0);
// (ClickReloads and TokenSwitch: the serial tail)
// a tagged wrapper whose click point is a typeless <button> in a <form> — as a step, and as an opener
const bC = out("WrapperSubmitStep");
const rC = await P.wrapperStep;
check("a step clicking a tagged wrapper whose click point is a form's typeless button → exit 4 'never submit' (at its click point), nothing written",
  rC.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\) — a step must navigate, never submit/.test(rC.stderr) && !written(bC));
const bC2 = out("WrapperSubmitOpener");
const rC2 = await P.wrapperOpener;
const eC2 = ix(read(bC2), "70:47");
check("an opener that is a tagged wrapper around a form's typeless button → ok:null 'opener would submit a form (… at its click point)', not clicked",
  rC2.status === 0 && eC2?.ok === null && /^opener would submit a form \(.*at its click point\)/.test(eC2.detail || "") && eC2.activation === undefined);
const wC = writesOf(edge("wrapper-submit"));
check(`no form was submitted (server saw: ${wC.join(", ") || "nothing"})`, wC.length === 0);
// a destination wrapper the app re-mounts in place around an unrelated dialog is not newly visible → not inside
const bB = out("Remount");
const rB = await P.remount;
const eB = ix(read(bB), "70:47");
check("an unrelated dialog inside a destination wrapper re-mounted in the same place → destination NOT inside, ok:null",
  rB.status === 0 && eB?.ok === null && eB.detectedBy === "[role=dialog]" && eB.destination?.inside === false);
// containing-block creators beyond transform
const bD = out("CbCreators");
const rD = await P.cbCreators;
const mD = read(bD);
if (rD.status !== 0) console.log(rD.stderr);
check("position:fixed under a transformed ancestor widens the page and is named; absolute under a filtered overflow:hidden wrapper or a contain:layout one is not",
  rD.status === 0 && mD?.page?.scrollable === true && mD.page.offenders.some((o) => o.dt === "70:57") && !mD.page.offenders.some((o) => o.dt === "70:58" || o.dt === "70:59"));

// ---- same-URL reload repros (plot-ledger-edge.html)
// a same-URL navigation is never a click's own, even one its handler starts at once or 100 ms later — after the
// click's in-place change it loses the steps' state: one re-run, then (every time) the step-specific exit 4
const stepLost = (r: Run): boolean => r.status === 4 && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(r.stderr)
  && /on the first pass and again on the re-run/.test(r.stderr) && !/watch tree/.test(r.stderr);
// (ClickReloadsSync / ClickReloads100 / ClickReloadsOnce and HangImg: the serial tail)
// a tagged wrapper taller than the viewport — Playwright clicks the middle of what shows, where a form's typeless
// button is (the middle of the whole box is empty) → refused as a step
const bT = out("TallWrapper");
const rT = await P.tallWrapper;
const wT = writesOf(edge("tall-wrapper"));
check(`a step clicking a wrapper taller than the viewport whose on-screen middle is a form's typeless button → exit 4 'never submit' (at its click point), nothing written, nothing submitted (server saw: ${wT.join(", ") || "nothing"})`,
  rT.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\)/.test(rT.stderr) && !written(bT) && wT.length === 0);

// ---- link and late-navigation steps
const loadNote = (m: VerifyMeasured | null): boolean => (m?.notes || []).some((n) => /the document had not finished loading after 10s/.test(n));
const loadNoteAfter = (m: VerifyMeasured | null, sec: number): boolean => (m?.notes || []).some((n) => n.includes(`the page had not finished loading when the goto gave up after ${sec}s`));
// a click on a link to the URL the page already shows (here a URL tab, the tag on a span inside the <a>) is a refresh
// step — its load is the step's own (not a lost state, a re-run, or exit 4 "changed it in place")
const bSL = out("SameLink");
const rSL = await P.sameLink;
const mSL = read(bSL);
if (rSL.status !== 0) console.log(rSL.stderr);
check("a step clicking a link to the URL the page shows (a URL tab) → its load is the step's own: exit 0, afterInitialLoad 0, re-runs 0, the root by tag (was: exit 4 'changed it in place')",
  rSL.status === 0 && mSL?.navigation?.afterInitialLoad === 0 && mSL.navigation.reruns === 0 && mSL.frame?.via === "tag" && mSL.frame.nodeId === "70:1");
// a late click navigation into a document that never finishes loading → its own 10 s, then measured with the note
const bHL = out("HangLate");
const rHL = await P.hangLate;
const sHL = rHL.ms;
const mHL = read(bHL);
if (rHL.status !== 0) console.log(rHL.stderr);
check(`a click navigating 400 ms later into a document that never finishes loading → exit 0 in ${Math.round(sHL / 1000)} s, the root by tag, the 'had not finished loading' note (was: exit 4 'kept navigating' + the dev-server hint)`,
  rHL.status === 0 && mHL?.frame?.via === "tag" && mHL.frame.nodeId === "70:1" && loadNote(mHL) && mHL.navigation?.afterInitialLoad === 0);
// (LateSlow and the ReloadHang guard: the serial tail)
// the probe's own load (--url, a goto step) of a document that never finishes loading is waited for up
// to --timeout, then (it committed) measured with the note — not "could not load"
const bHF = out("HangFirst");
const rHF = await P.hangFirst;
const mHF = read(bHF);
if (rHF.status !== 0) console.log(rHF.stderr);
check("--url a document that never finishes loading (--timeout 15 s) → its load waited for up to --timeout, then exit 0, the root by tag, the note 'after 15s' (was: 'could not load', then a note after 10 s)",
  rHF.status === 0 && mHF?.frame?.via === "tag" && mHF.frame.nodeId === "70:1" && loadNoteAfter(mHF, 15));
const bGH = out("GotoHang");
const rGH = await P.gotoHang;
const mGH = read(bGH);
if (rGH.status !== 0) console.log(rGH.stderr);
check("a goto step to a document that never finishes loading → waited for up to --timeout, then exit 0, afterInitialLoad 0, the root by tag, the note 'after 15s'",
  rGH.status === 0 && mGH?.navigation?.afterInitialLoad === 0 && mGH.frame?.via === "tag" && mGH.frame.nodeId === "70:1" && loadNoteAfter(mGH, 15));
// (LateLoad: the serial tail)
// with no per-document token ("" on every document) a timed-out document's note is never shared with the next one
const bNT = out("NoToken");
const rNT = await P.noToken;
const mNT = read(bNT);
if (rNT.status !== 0) console.log(rNT.stderr);
check("no token on any document: after one document's load timed out, the next step's half-loaded document is still waited for (not skipped as that known timed-out one) → exit 0, the root by tag, its heading measured",
  rNT.status === 0 && mNT?.frame?.via === "tag" && mNT.frame.nodeId === "70:1" && (mNT.nodes || []).some((n) => n.nodeId === "70:2"));
// Playwright clicks the middle of the FIRST content quad (a wrapping inline element's first line), not of its box
const bIW = out("InlineWrap");
const rIW = await P.inlineWrap;
const wIW = writesOf(edge("inline-wrap"));
check(`a step clicking an inline span whose first line is a form's typeless button (its box's middle is not) → exit 4 'never submit' at its click point, nothing written, nothing submitted (server saw: ${wIW.join(", ") || "nothing"})`,
  rIW.status === 4 && /would submit a form \(a <button> without a type inside a <form> \(it submits\) at its click point\)/.test(rIW.stderr) && !written(bIW) && wIW.length === 0);

// ---- slow, churning and same-URL documents
const notes = (m: VerifyMeasured | null): string[] => m?.notes || [];
// the probe's own load never reads as "moved" — a DOM that never goes quiet is measured with the no-navigation note
const bCD = out("ChurnDom");
const rCD = await P.churnDom;
const mCD = read(bCD);
if (rCD.status !== 0) console.log(rCD.stderr);
check("a DOM that never goes quiet on the --url page (no navigation) → exit 0, the root by tag, 'the DOM was still changing after 10s (no navigation)' (was: exit 4 'kept navigating')",
  rCD.status === 0 && mCD?.frame?.via === "tag" && notes(mCD).some((n) => /the DOM was still changing after 10s \(no navigation\)/.test(n)));
const bCG = out("ChurnDomGoto");
const rCG = await P.churnDomGoto;
const mCG = read(bCG);
if (rCG.status !== 0) console.log(rCG.stderr);
check("the same after a goto step → exit 0, afterInitialLoad 0, the still-changing note (was: exit 4 'kept navigating')",
  rCG.status === 0 && mCG?.navigation?.afterInitialLoad === 0 && notes(mCG).some((n) => /the DOM was still changing after 10s \(no navigation\)/.test(n)));
// --ready on the --url page keeps the full --timeout (the screen appears at 12 s)
const bLR = out("LateReady");
const rLR = await P.lateReady;
const mLR = read(bLR);
if (rLR.status !== 0) console.log(rLR.stderr);
check("--ready that appears 12 s after load with --timeout 30000 → exit 0, the root by tag (was: exit 4 'kept navigating' at 10 s)",
  rLR.status === 0 && mLR?.frame?.via === "tag" && mLR.frame.nodeId === "70:1");
const bRN = out("ReadyNever");
const rRN = await P.readyNever;
check("a --ready that never appears → exit 4 \"--ready … never became visible\" at --timeout, not 'kept navigating', nothing written",
  rRN.status === 4 && /--ready '\[data-dt-node="70:1"\]' never became visible/.test(rRN.stderr) && !/kept navigating/.test(rRN.stderr) && !written(bRN));
// a slow-but-finishing page (an image answered at 13 s, --timeout 30000) is measured fully loaded, with no note
const bSI = out("SlowImg");
const rSI = await P.slowImg;
const mSI = read(bSI);
if (rSI.status !== 0) console.log(rSI.stderr);
check("an image finishing 13 s after the --url load (--timeout 30000) → its load waited for: exit 0, no 'had not finished loading' note (was: measured half-loaded at 10 s)",
  rSI.status === 0 && mSI?.frame?.via === "tag" && !notes(mSI).some((n) => /had not finished loading/.test(n)));
// (SlowStay and LinkInplaceReload / LinkEmptyReload: the serial tail)
// a same-URL link handled in place whose app navigates AWAY 1.2 s later — still the step's own navigation
const bLA = out("LinkLateAway");
const rLA = await P.linkLateAway;
const mLA = read(bLA);
if (rLA.status !== 0) console.log(rLA.stderr);
check("a same-URL link handled in place, then a navigation to another URL 1.2 s later → the step's own: exit 0, afterInitialLoad 0, re-runs 0, the root by tag (was: exit 4 'reloaded … again')",
  rLA.status === 0 && mLA?.navigation?.afterInitialLoad === 0 && mLA.navigation.reruns === 0 && mLA.frame?.via === "tag");
// target=_top is the same tab — a refresh link
const bTT = out("SameLinkTop");
const rTT = await P.sameLinkTop;
const mTT = read(bTT);
if (rTT.status !== 0) console.log(rTT.stderr);
check("a refresh link with target=_top → its load is the step's own: exit 0, afterInitialLoad 0, re-runs 0 (was: exit 4 'changed it in place')",
  rTT.status === 0 && mTT?.navigation?.afterInitialLoad === 0 && mTT.navigation.reruns === 0 && mTT.frame?.via === "tag");
// (SlowChurn, BounceHang and RedirSlow: the serial tail)

// ================================================================ the serial tail: one run at a time, once the pool has drained
await Promise.all([...Object.values(P), ...slowNav.map((s) => s.run)]);

// the drive keeps its own budget (min(60 s, --max-time left − 15 s)) whatever the behaviour battery reserves after it — at a
// small --max-time the first rows are still driven (--behaviour off: no behaviour work at all)
for (const [mt, ids] of [["25000", ["70:44"]], ["30000", ["70:44", "70:45"]]] as const) {
  const bm = out(`Budget${mt}`);
  const rm = await T[`budget${mt}`]();
  const mm = read(bm);
  if (rm.status !== 0) console.log(rm.stderr);
  check(`--max-time ${Number(mt) / 1000} s, --behaviour off: ${ids.join(" and ")} driven ok:true as the drive alone drives them (its budget never shrinks for the behaviour battery)`,
    rm.status === 0 && ids.every((id) => ix(mm, id)?.ok === true && ix(mm, id)?.cut === undefined));
}

// a same-document URL rewrite after load (replaceState) is no navigation — only a document load is
const b9 = out("Replace");
const r9 = await T.replace();
const m9 = read(b9);
if (r9.status !== 0) console.log(r9.stderr);
check("a replaceState 100 ms after load (no --steps) → afterInitialLoad 0 (framenavigated logged, never counted)",
  r9.status === 0 && m9?.navigation?.afterInitialLoad === 0 && (m9.navigation.events || []).some((e) => e.type === "framenavigated" && /tab=harvest/.test(e.url)));

// a reload 300 ms after load into a document that stays half-loaded for 2.5 s — the probe must wait for it
const b11 = out("ReloadSettle");
const r11 = await T.reloadSettle();
const m11 = read(b11);
if (r11.status !== 0) console.log(r11.stderr);
check("a reload while settling into a half-loaded document → waited for: the root by tag, its heading measured, afterInitialLoad 1 (the reload's load), re-runs 0",
  r11.status === 0 && m11?.frame?.via === "tag" && m11.frame.nodeId === "70:1" && (m11.nodes || []).some((n) => n.nodeId === "70:2" && n.matchedBy === "tag")
  && m11.navigation?.afterInitialLoad === 1 && m11.navigation.reruns === 0);
const b11b = out("ReloadSettleNoReady");
const r11b = await T.reloadSettleNoReady();
const m11b = read(b11b);
check("the same without --ready (nothing to wait for but the quiet window) → still the reloaded document, measured once it loaded",
  r11b.status === 0 && m11b?.frame?.via === "tag" && m11b.navigation?.afterInitialLoad === 1);

// (steps) a load the step did not start is not the probe's own — it counts, and (the click's state is gone) the
// pass is re-run once with the steps replayed
const b12 = out("ReloadStep");
const r12 = await T.reloadStep();
const m12 = read(b12);
if (r12.status !== 0) console.log(r12.stderr);
check("a reload 300 ms after a step's in-place click → not absorbed by the step: afterInitialLoad 1, re-runs 1 (steps replayed), the root by tag",
  r12.status === 0 && m12?.navigation?.afterInitialLoad === 1 && m12.navigation.reruns === 1 && m12.frame?.via === "tag");
const b12b = out("GotoReload");
const r12b = await T.gotoReload();
const m12b = read(b12b);
if (r12b.status !== 0) console.log(r12b.stderr);
check("a goto step whose page then reloads by itself → the goto's load is absorbed, the reload's is not: afterInitialLoad 1, re-runs 0",
  r12b.status === 0 && m12b?.navigation?.afterInitialLoad === 1 && m12b.navigation.reruns === 0 && m12b.frame?.via === "tag");
const b12c = out("ReloadLate");
const r12c = await T.reloadLate();
const m12c = read(b12c);
if (r12c.status !== 0) console.log(r12c.stderr);
check("a reload 1 s after an in-place click (while waiting for --ready, the section lost) → re-run with the steps replayed: exit 0, re-runs 1, the root by tag",
  r12c.status === 0 && m12c?.navigation?.reruns === 1 && m12c.navigation.afterInitialLoad === 1 && m12c.frame?.via === "tag");

// every driving page's reach hangs (the server never answers again); --timeout 30 s, --max-time 22 s → about 6 s of
// driving: the cut closes the row's context mid-reach, so the run ends inside --max-time with the measured file written
const b14 = out("SlowReach");
const r14 = await T.slowReach();
const s14 = r14.ms;
const m14 = read(b14);
if (r14.status !== 0) console.log(r14.stderr);
check(`a driving reach that never answers is cut by the budget mid-reach → exit 0 in ${Math.round(s14 / 1000)} s (< 22 s), measured written, every row ok:null cut budget`,
  r14.status === 0 && s14 < 22_000 && m14 !== null && (m14.interactions || []).length === 8 && (m14.interactions || []).every((i) => i.ok === null && i.cut === "budget"));

// a covered opener in a scroll-behavior:smooth app-shell scroller — the drive's scroll is restored at once,
// so the synthetic click lands on the shell as the drive had it; nothing the page itself scrolls animates either (the probe's
// init CSS); with the page's own !important ID rule beating the init CSS, the restore is still instant
const bR6s = out("SmoothShell");
const rR6s = await T.smoothShell();
const mR6s = read(bR6s), eR6s = ix(mR6s, "70:49"), jR6s = ix(mR6s, "70:50");
if (rR6s.status !== 0) console.log(rR6s.stderr);
check(`a covered opener in a smooth-scrolling app shell → synthetic click with the shell back at its scroll: the popover anchored at click time is at y 100 (saw ${String(eR6s?.opened?.rect.y)}), the dialog detected`,
  rR6s.status === 0 && eR6s?.activation === "synthetic" && eR6s.opened?.rect.y === 100 && eR6s.detectedBy === "[role=dialog]");
check(`the page's own scroll in a smooth shell (scrollTo 300 on click, 70:50) is instant under the probe: its popover is at y 400 (saw ${String(jR6s?.opened?.rect.y)})`,
  jR6s?.activation === "mouse" && jR6s.opened?.rect.y === 400);
const bR6i = out("SmoothShellImportant");
const rR6i = await T.smoothShellImportant();
const eR6i = ix(read(bR6i), "70:49");
if (rR6i.status !== 0) console.log(rR6i.stderr);
check(`the same shell forced smooth by the page's !important ID rule → the drive's restore is still instant: y 100 (saw ${String(eR6i?.opened?.rect.y)})`,
  rR6i.status === 0 && eR6i?.activation === "synthetic" && eR6i.opened?.rect.y === 100);
// the same !important-smooth shell, where the page reads the scroll in requestAnimationFrame —
// its popover is anchored at the shell's scroll in the last frame PAINTED before the click: 100 only when the drive's restore held
// for frames before its synthetic click (restore, two frames, look again — twice in a row), deterministic under any load (a single
// restore right before the click could still be moved by a smooth scroll Playwright's retry started)
const bR6p = out("SmoothShellPainted");
const rR6p = await T.smoothShellPainted();
const eR6p = ix(read(bR6p), "70:49");
if (rR6p.status !== 0) console.log(rR6p.stderr);
check(`the !important-smooth shell, popover anchored at the last painted frame's scroll → the restored scroll held before the synthetic click: y 100 (saw ${String(eR6p?.opened?.rect.y)})`,
  rR6p.status === 0 && eR6p?.activation === "synthetic" && eR6p.opened?.rect.y === 100);

// a click that reloads the SAME URL after changing the page in place, every time → exit 4 naming the step, not the watch-tree hint
const bR = out("ClickReloads");
const rR = await T.clickReloads();
check("a click that reloads the same URL after its in-place change, on the pass and the re-run → exit 4, nothing written, the step named, 'not a navigation step', no watch-tree hint",
  rR.status === 4 && !written(bR) && /after step 1 \{click: "\[data-dt-node=\\?"70:30\\?"\]"\} had changed it in place/.test(rR.stderr)
  && /on the first pass and again on the re-run/.test(rR.stderr) && /not a\s+navigation step/.test(rR.stderr) && !/watch tree/.test(rR.stderr) && /navigation log/.test(rR.stderr));
// the document replaced right after settling (simulated by a token that changes at the first plain read after the
// settle polls) → the pass compares against the token settle saw quiet → one re-run
const bA = out("TokenSwitch");
const rA = await T.tokenSwitch();
const mA = read(bA);
if (rA.status !== 0) console.log(rA.stderr);
check("a document replaced between settling and measuring → caught (the settled token is compared): exit 0, re-runs 1",
  rA.status === 0 && mA?.navigation?.reruns === 1 && mA.frame?.via === "tag");

// a same-URL reload at once / 100 ms after the click's in-place change, every time or once
const bS = out("ClickReloadsSync");
const rS = await T.clickReloadsSync();
if (!stepLost(rS)) console.log(rS.stderr);
check("`draw(); location.reload()` in the click handler, every time (no --ready) → the reload is not the click's: one re-run, then exit 4 naming the step, nothing written (was: exit 0 measuring the default section)",
  stepLost(rS) && !written(bS));
const bH = out("ClickReloads100");
const rH = await T.clickReloads100();
if (!stepLost(rH)) console.log(rH.stderr);
check("a reload 100 ms after the click's in-place change, every time (--ready) → exit 4 naming the step (was: the generic '--ready never visible')",
  stepLost(rH) && !written(bH) && !/never became visible/.test(rH.stderr));
const bO = out("ClickReloadsOnce");
const rO = await T.clickReloadsOnce();
const mO = read(bO);
if (rO.status !== 0) console.log(rO.stderr);
check("the same sync reload on the first click only → re-run with the steps replayed: exit 0, re-runs 1, afterInitialLoad 1, the root by tag",
  rO.status === 0 && mO?.navigation?.reruns === 1 && mO.navigation.afterInitialLoad === 1 && mO.frame?.via === "tag" && mO.frame.nodeId === "70:1");
// the click's navigation lands on a document whose image never loads — the load wait is per document: the click's
// settle waits its 10 s, the waitFor step's and the --ready settle do not wait again (10 s each would pass --max-time)
const bG = out("HangImg");
const rG = await T.hangImg();
const sG = rG.ms;
const mG = read(bG);
if (rG.status !== 0) console.log(rG.stderr);
check(`a step's navigation into a document that never finishes loading + a waitFor step + --ready → exit 0 in ${Math.round(sG / 1000)} s (< 22 s: one 10 s load wait, not three), the root by tag, the 'had not finished loading' note`,
  rG.status === 0 && sG < 22_000 && mG?.frame?.via === "tag" && (mG.notes || []).some((n) => /the document had not finished loading after 10s/.test(n)));

// a document a late navigation brings in gets its own 10 s for its load (per document), not the rest of the settle's
const bLS = out("LateSlow");
const rLS = await T.lateSlow();
const mLS = read(bLS);
if (rLS.status !== 0) console.log(rLS.stderr);
check("a click navigating 7 s later into a document that loads 5 s after (--ready its root) → settled on, not 'kept navigating': exit 0, the root by tag, its heading measured, a quiet window of its own (no load / still-changing note)",
  rLS.status === 0 && mLS?.frame?.via === "tag" && mLS.frame.nodeId === "70:1" && (mLS.nodes || []).some((n) => n.nodeId === "70:2")
  && !(mLS.notes || []).some((n) => /had not finished loading|still changing/.test(n)));
// guard: no load wait decides a lost state — a reload after an in-place click into a document that never
// finishes loading still loses the steps' state (at its commit): one re-run, then the step-specific exit 4
const bRH = out("ReloadHang");
const rRH = await T.reloadHang();
if (!stepLost(rRH)) console.log(rRH.stderr);
check("a reload after the click's in-place change into a document that never finishes loading, every time → exit 4 naming the step, nothing written (was: 'kept navigating' + the dev-server hint)",
  stepLost(rRH) && !written(bRH));
// a document whose load timed out in one settle and completed before a later one carries no stale note
const bLL = out("LateLoad");
const rLL = await T.lateLoad();
const mLL = read(bLL);
if (rLL.status !== 0) console.log(rLL.stderr);
check("a document whose load timed out in the click's settle and completed before the next ones → exit 0, the root by tag, no 'had not finished loading' note",
  rLL.status === 0 && mLL?.frame?.via === "tag" && mLL !== null && !loadNote(mLL));

// the measured-anyway --url document's own late load (after a click changed it in place) is no reload
const bSS = out("SlowStay");
const rSS = await T.slowStay();
const mSS = read(bSS);
if (rSS.status !== 0) console.log(rSS.stderr);
check("the --url document taken after --timeout 5 s (its load given up) loads at 7 s, after the click changed it in place (while a waitFor step waits) → its own late load: exit 0, re-runs 0, the root by tag (was: 'the page reloaded … after step 1', exit 4)",
  rSS.status === 0 && mSS?.navigation?.reruns === 0 && mSS.frame?.via === "tag" && mSS.frame.nodeId === "70:1");
// a link to the current URL that the app handles in place, then a reload 300 ms later — a genuine reload (a re-run)
for (const [mode, label] of [["link-inplace-reload", "a link to the URL"], ["link-empty-reload", "an <a href=\"\">"]] as const) {
  const b = out(mode === "link-inplace-reload" ? "LinkInplaceReload" : "LinkEmptyReload");
  const r = await (mode === "link-inplace-reload" ? T.linkInplaceReload() : T.linkEmptyReload());
  const m = read(b);
  if (r.status !== 0) console.log(r.stderr);
  check(`${label} handled in place, the page reloading 300 ms later (once) → not the link's load: afterInitialLoad 1, re-runs 1, the root by tag (was: swallowed, the other section measured)`,
    r.status === 0 && m?.navigation?.afterInitialLoad === 1 && m.navigation.reruns === 1 && m.frame?.via === "tag" && m.frame.nodeId === "70:1");
}
// "kept navigating for Ns" states the real duration (a first new document at 8 s has its own window; the next one ends it)
const bKN = out("SlowChurn");
const rKN = await T.slowChurn();
if (!/kept navigating/.test(rKN.stderr)) console.log(rKN.stderr);
const kn = /kept navigating for (\d+)s/.exec(rKN.stderr);
check(`a reload at 8 s into a never-loading document that reloads again 6 s later → exit 4 'kept navigating for ${kn?.[1] ?? "?"}s' (the real duration, > 10 s; not a fixed 10s)`,
  rKN.status === 4 && kn !== null && Number(kn[1]) > 11 && !written(bKN));

// ---- pages going on to a server that never answers
// a page that arrives and goes on (before its load) to a server that never answers → "could not load" at --timeout
const bBH = out("BounceHang");
const rBH = await T.bounceHang();
const sBH = rBH.ms;
if (!/could not load/.test(rBH.stderr)) console.log(rBH.stderr);
check(`the --url page goes on, before its load, to a server that never answers → exit 4 'could not load' at --timeout (${Math.round(sBH / 1000)} s < 30 s), nothing written (was: a hang until --max-time)`,
  rBH.status === 4 && /could not load/.test(rBH.stderr) && sBH < 30_000 && !written(bBH));
// a document the page redirected to itself, measured "anyway" at 10 s, whose load comes after an in-place click
const bRS = out("RedirSlow");
const rRS = await T.redirSlow();
const mRS = read(bRS);
if (rRS.status !== 0) console.log(rRS.stderr);
check("a client redirect to a document whose load comes at 11 s (past the 10 s cap), after a click changed it in place → its own late load: exit 0, re-runs 0, the root by tag (was: 'the page reloaded … after step 2', exit 4)",
  rRS.status === 0 && mRS?.navigation?.reruns === 0 && mRS.frame?.via === "tag" && mRS.frame.nodeId === "70:1");

// what --compare wrote reads as a report at all (guards against a half-written run)
check("the bound compare wrote a v2 report", rep2 !== null && isJsonObject(rep2.inputs));
// Per run above, and no run made a write at all — no fixture has a write the drive or a step may make
check(`across every run the server received no write (saw: ${writes.join(", ") || "none"})`, writes.length === 0);

finish();
report();
