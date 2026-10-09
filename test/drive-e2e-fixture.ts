// The fixture shared by the two probe drive e2e suites (test/verify-probe-drive-e2e.test.ts, the pooled cases, and
// test/verify-probe-drive-tail-e2e.test.ts, the serial tail): the BUILT claude-plugin/scripts/verify-probe.js (and the built
// verify-screen.js for --expect / --status / --compare), run in a real chromium from a TEMP consumer project
// (design/export + design/plan + node_modules/ of its own — never the repo root, so no untracked design/ leaks in).
// Each suite calls startDriveFixture() once: its own temp project, its own server, its own write accounting, torn down by finish().
//
//   const fx = await startDriveFixture("dt-probe-drive-e2e-", "verify-probe drive e2e — …:");
//   const r = await fx.probe(["--expected", fx.EXPECTED, "--url", fx.url(), "--out", out("Beds"), …]);
//
// The fixture "Plot Ledger" (test/fixtures/probe/plot-ledger.*, invented names) is a single-page app whose sections are
// picked by state, not by the URL: the Beds screen (root 70:1) exists only after its sidebar button (70:30) is clicked
// (--steps). On it, overlay openers built every way the probe must tell apart: a row action that
// shows only on row hover opening a native <dialog> (showModal, no role) holding the destination frame's tag; a
// role=dialog aria-modal div; an UNTAGGED dialog; a dead button; a button that reloads the page; a button under a
// transparent layer; a panel that is only the destination tag; and a plan-only opener (plan.interactions). ?mode=wide
// adds a 1700px strip to the Beds section only; ?mode=reload-on-first-hover reloads once on the hovered row.
// plot-ledger-edge.html holds the edge-case repros, one ?mode= each.
//
// A write is charged to the run whose page made it (the POST's Referer query, when it is a launched --url's); any other write
// (no Referer, an <object> / <embed> subframe's own URL) is charged to every run's check, and each suite's final check wants
// none across every one of its runs.
//
// needs the repo's devDependency `playwright` + chromium. Locally an unavailable renderer prints SKIPPED; in CI
// (CI=true) that is a failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AddressInfo } from "node:net";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import type { InteractionEvidence, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROBE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const VS = path.join(ROOT, "claude-plugin", "scripts", "verify-screen.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");

export const STEPS = [{ click: "[data-dt-node=\"70:30\"]" }, { waitFor: "[data-dt-node=\"70:1\"]" }];
export const READY = "[data-dt-node=\"70:1\"]";
// the steps' sha: canonical JSON (sorted keys) — for one-key string steps that is JSON.stringify of the list
export const stepsSha = crypto.createHash("sha256").update(JSON.stringify(STEPS)).digest("hex");

// ms: spawn → close (never the time a run waited in a pool's queue); a spawn that fails (EAGAIN under load, a synchronous
// throw) resolves as status null — a run never rejects, never hangs the suite
export interface Run { status: number | null; stdout: string; stderr: string; ms: number }
export const out = (name: string): string => path.join("design", "verify", name);
export const ix = (m: VerifyMeasured | null, id: string): InteractionEvidence | undefined => (m?.interactions || []).find((i) => i.nodeId === id);
/** the "had not finished loading after 10s" note of a document whose load timed out */
export const loadNote = (m: VerifyMeasured | null): boolean => (m?.notes || []).some((n) => /the document had not finished loading after 10s/.test(n));

export interface DriveFixture {
  url: (mode?: string) => string;
  edge: (mode: string) => string;
  probe: (args: string[]) => Promise<Run>;
  vs: (args: string[]) => Promise<Run>;
  read: (base: string) => VerifyMeasured | null;
  readReport: (base: string) => VerifyReport | null;
  written: (base: string) => boolean;
  /** every write the server received (the /mutate query) */
  writes: string[];
  /** the writes charged to the runs on these --url values, plus the unattributed ones */
  writesOf: (...urls: string[]) => string[];
  /** the expectation from the real --expect, and the same without interactions (nothing to drive) */
  EXPECTED: string;
  QUIET: string;
  finish: () => void;
}

/** The temp project, the server, the renderer pre-check (SKIPPED locally, a failure under CI) and the --expect run. Prints
 *  `title` first; exits the process (after finish()) when the renderer is unavailable or --expect fails. */
export async function startDriveFixture(tmpPrefix: string, title: string): Promise<DriveFixture> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
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

  // async spawn: the server lives in THIS process, so a spawnSync would block it from answering
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
  const read = (base: string): VerifyMeasured | null => readJsonOrNull(path.join(proj, base + ".measured.json"), isVerifyMeasured);
  const readReport = (base: string): VerifyReport | null => readJsonOrNull(path.join(proj, base + ".report.json"), isVerifyReport);
  const written = (base: string): boolean => fs.existsSync(path.join(proj, base + ".measured.json")) || fs.existsSync(path.join(proj, base + ".png"));

  console.log(title);
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

  return { url, edge, probe, vs, read, readReport, written, writes, writesOf, EXPECTED, QUIET, finish };
}
