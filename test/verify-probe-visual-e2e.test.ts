// End-to-end tests for group 12c's visual diff (F-89): the BUILT claude-plugin/scripts/verify-probe.js (and the built
// verify-screen.js for --expect / --compare) in a real chromium, from TEMP consumer projects (design/export + node_modules of
// their own — never the repo root).
//
// The fixture "Kiln Log" (test/fixtures/probe/kiln-log.*, invented names): the Firings screen 90:1, 1440×720, whose export root
// has a drop shadow (renderBox = box grown by 12 px per side), four firing cards 90:10..90:13. The reference is made IN-TEST the
// way Figma makes it: ?mode=ref renders the frame inside a transparent 1464×744 page (the shadow in the margin) at
// deviceScaleFactor 2048/1440 → assets/90_1_ref.png (2082×1058); the index row gets referenceScale = round4(png.w / 1464) and
// referenceOffset {-12, -12}, as bridge/src/write-out.ts writes them. The Kiln Ledger screen 90:50 (400×5000, generated here)
// is a tall frame whose reference scale is below 1 (2048/5000).
//
// D3: needs the repo's devDependency playwright (+ chromium). Locally an unavailable renderer prints SKIPPED; in CI (CI=true)
// that is a failure.  Run with:  node test/verify-probe-visual-e2e.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { LAUNCH_ARGS } from "../design-to-code/verify-probe.ts";
import { decodePng, encodePng, pngInfo, resampleBox } from "../design-to-code/png.ts";
import type { MeasuredVisual, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { limit } from "./pool.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROBE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const VS = path.join(ROOT, "claude-plugin", "scripts", "verify-screen.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-visual-e2e-"));
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

// ---- the server: the fixture page under any ?mode=
const html = fs.readFileSync(path.join(FIX, "kiln-log.html"), "utf8");
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  if (u.pathname !== "/kiln-log.html") { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/kiln-log.html${mode ? `?mode=${mode}` : ""}`;
const finish = (): void => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };

interface Run { status: number | null; stdout: string; stderr: string; ms: number; killed: boolean }
/** killAfterMs: a run that has not exited by then is SIGKILLed (by its pid) and reported killed — a hung probe fails, never hangs the test */
const run = (cwd: string, script: string, args: string[], killAfterMs = 0): Promise<Run> => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [script, ...args], { cwd });
  let stdout = "", stderr = "", killed = false;
  const timer = killAfterMs > 0 ? setTimeout(() => { killed = true; p.kill("SIGKILL"); }, killAfterMs) : undefined;
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, ms: Date.now() - t0, killed }); });
});

console.log("verify-probe visual e2e — the built bundles in a real chromium, from temp projects:");

// ---- the references, rendered the way Figma renders them (D3: no playwright → SKIPPED locally)
let refPng: Buffer, ledgerPng: Buffer;
try {
  const pw = await import("playwright");
  // grayscale text as Figma renders it — and as the probe launches chromium (verify-probe.ts LAUNCH_ARGS)
  const browser = await pw.chromium.launch({ args: [...LAUNCH_ARGS] });
  try {
    const shoot = async (vw: number, vh: number, dsf: number, mode: string): Promise<Buffer> => {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dsf });
      const page = await ctx.newPage();
      await page.goto(url(mode));
      await page.evaluate("document.fonts.ready.then(() => true)");
      const png = await page.screenshot({ omitBackground: true, animations: "disabled", caret: "hide", scale: "device" });
      await ctx.close();
      return png;
    };
    refPng = await shoot(1464, 744, 2048 / 1440, "ref");
    ledgerPng = await shoot(400, 5000, 2048 / 5000, "long-ref");
  } finally { await browser.close(); }
} catch (e) {
  const reason = String(e instanceof Error ? e.message : e).split("\n")[0] ?? "";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); finish(); process.exit(0); }
  check(`the renderer is available in CI (D3) — ${reason}`, false);
  finish();
  report();
  process.exit(1);
}
const refInfo = pngInfo(refPng), ledgerInfo = pngInfo(ledgerPng);
if (!refInfo || !ledgerInfo) { check("the in-test references are PNGs", false); finish(); report(); process.exit(1); }
const SCALE = round4(refInfo.w / 1464), LEDGER_SCALE = round4(ledgerInfo.w / 400);
console.log(`  (references: Firings ${refInfo.w}×${refInfo.h} → scale ${SCALE}; Kiln Ledger ${ledgerInfo.w}×${ledgerInfo.h} → scale ${LEDGER_SCALE})`);
// a discovery thumbnail (F-08): 360 px wide
const thumbPng = encodePng(resampleBox(decodePng(refPng), 360, Math.round(refInfo.h * 360 / refInfo.w)));

// ---- the temp consumer projects
interface ProjOpts { indexScale: boolean; thumb?: boolean }
const project = (name: string, o: ProjOpts): string => {
  const proj = path.join(tmp, name);
  const pagesDir = path.join(proj, "design", "export", "pages", "Kilns");
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(path.join(proj, "design", "export", "assets"), { recursive: true });
  fs.mkdirSync(path.join(proj, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(proj, "node_modules"));
  fs.writeFileSync(path.join(proj, "package.json"), `{"name":"${name}","private":true}\n`);
  for (const pkg of ["playwright", "playwright-core"]) {
    const from = path.join(ROOT, "node_modules", pkg);
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(proj, "node_modules", pkg), "dir");
  }
  // Firings 90:1 (the fixture) — its reference, or a thumbnail written under the same kind of pointer
  const refName = o.thumb ? "assets/90_1_ref-thumb.png" : "assets/90_1_ref.png";
  const firings = fs.readFileSync(path.join(FIX, "kiln-log.json"), "utf8").replace("\"assets/90_1_ref.png\"", JSON.stringify(refName));
  fs.writeFileSync(path.join(pagesDir, "Firings__90_1.json"), firings);
  fs.writeFileSync(path.join(proj, "design", "export", ...refName.split("/")), o.thumb ? thumbPng : refPng);
  // Kiln Ledger 90:50 — a 400×5000 frame (reference scale < 1), no shadow
  const rows = Array.from({ length: 40 }, (_, i) => ({ type: "FRAME", name: "Ledger Row", id: `90:${100 + i}`, box: { w: 360, h: 80, x: 3020, y: 40 + i * 120 }, radius: 8, fills: [{ type: "solid", color: "#ffffff" }] }));
  const ledger = { exportedAt: "2026-10-06T00:00:00Z", screen: "Kiln Ledger", page: "Kilns", pageId: "90:0", nodeId: "90:50", sourceFile: "Kiln Log",
    nodes: [{ type: "FRAME", name: "Kiln Ledger", id: "90:50", box: { w: 400, h: 5000, x: 3000, y: 0 }, clip: true, fills: [{ type: "solid", color: "#f7f3ee" }], children: rows, reference: "assets/90_50_ref.png" }] };
  fs.writeFileSync(path.join(pagesDir, "Kiln_Ledger__90_50.json"), JSON.stringify(ledger, null, 1) + "\n");
  fs.writeFileSync(path.join(proj, "design", "export", "assets", "90_50_ref.png"), ledgerPng);
  // the index rows write-out.ts writes (referenceScale / referenceOffset only when the pull had them — F-118)
  const scaleOf = o.thumb ? round4(360 / 1464) : SCALE;
  const row = (n: string, id: string, file: string, ref: string, w: number, h: number, scale: number, offset: { x: number; y: number }): Record<string, unknown> => ({
    name: n, id, type: "FRAME", page: "Kilns", pageId: "90:0", sourceFile: "Kiln Log", file: `pages/Kilns/${file}`, reference: ref,
    ...(o.indexScale ? { referenceScale: scale, referenceOffset: offset } : {}), w, h,
  });
  const layers = [row("Firings", "90:1", "Firings__90_1.json", refName, 1440, 720, scaleOf, { x: -12, y: -12 }), row("Kiln Ledger", "90:50", "Kiln_Ledger__90_50.json", "assets/90_50_ref.png", 400, 5000, LEDGER_SCALE, { x: 0, y: 0 })];
  fs.writeFileSync(path.join(proj, "design", "export", "pages", "index.json"), JSON.stringify({ pageDirs: [{ page: "Kilns", pageId: "90:0", dir: "Kilns", index: "pages/Kilns/index.json", layers: 2 }], layers }, null, 2));
  fs.writeFileSync(path.join(pagesDir, "index.json"), JSON.stringify({ page: "Kilns", pageId: "90:0", layers }, null, 2));
  return proj;
};
const pMain = project("kiln-log", { indexScale: true });
const pOld = project("kiln-log-old", { indexScale: false });
const pThumb = project("kiln-log-thumb", { indexScale: true, thumb: true });
const pSwap = project("kiln-log-swap", { indexScale: true });
// e12 (F-2): a monorepo — design/ at the repo root, the web app (with its own playwright) in app/
const pMono = project("kiln-log-mono", { indexScale: true });
const monoApp = path.join(pMono, "app");
fs.mkdirSync(path.join(monoApp, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(monoApp, "package.json"), "{\"name\":\"kiln-log-app\",\"private\":true}\n");
for (const pkg of ["playwright", "playwright-core"]) {
  const from = path.join(ROOT, "node_modules", pkg);
  if (fs.existsSync(from)) fs.symlinkSync(from, path.join(monoApp, "node_modules", pkg), "dir");
}

const probe = (proj: string, args: string[]): Promise<Run> => run(proj, PROBE, [...args, "--project", proj]);
const vs = (proj: string, args: string[]): Promise<Run> => run(proj, VS, args);
const out = (name: string): string => path.join("design", "verify", name);
const read = (proj: string, base: string): VerifyMeasured | null => readJsonOrNull(path.join(proj, base + ".measured.json"), isVerifyMeasured);
const readReport = (proj: string, base: string): VerifyReport | null => readJsonOrNull(path.join(proj, base + ".report.json"), isVerifyReport);
const vis = (m: VerifyMeasured | null): MeasuredVisual | null => m?.visual ?? null;
const ran = (m: VerifyMeasured | null): Extract<MeasuredVisual, { ran: true }> | null => { const v = vis(m); return v && v.ran ? v : null; };
const whyOf = (m: VerifyMeasured | null): string => { const v = vis(m); return v === null ? "(no visual block)" : v.ran ? "(ran)" : v.why; };
const brief = (m: VerifyMeasured | null): string => { const v = vis(m); return v === null ? "no visual block" : v.ran ? `ran grid ${v.grid} dsf ${v.capture.dsf} differ ${v.differingPct}% shift-tolerant ${v.shiftTolerantPct}% regions ${v.regionsTotal} ${JSON.stringify(v.regions.map((r) => r.built))} notes ${JSON.stringify(v.notes)}` : `not run: ${v.why}`; };

// ---- the expectations, from the real --expect
const FIR = "design/export/pages/Kilns/Firings__90_1.json", LED = "design/export/pages/Kilns/Kiln_Ledger__90_50.json";
for (const proj of [pMain, pOld, pThumb, pSwap, pMono]) {
  const e = await vs(proj, ["--expect", FIR, "--out", out("Firings")]);
  if (e.status !== 0) { console.log(e.stderr); check("verify-screen --expect wrote the expectation", false); finish(); report(); process.exit(1); }
}
const el = await vs(pMain, ["--expect", LED, "--out", out("Ledger")]);
if (el.status !== 0) console.log(el.stderr);
const EXP = out("Firings") + ".expected.json";
// e7: the same expectation without referenceImage (an expectation older than 12c)
const full = readJsonOrNull(path.join(pMain, EXP), isVerifyExpectation);
if (full !== null) { const { referenceImage: _drop, ...old } = full; fs.writeFileSync(path.join(pMain, out("Older") + ".expected.json"), JSON.stringify(old, null, 2) + "\n"); }
// e11 (F-1): referenceImage null (hand-edited "to turn the diff off") — once a TypeError that left chromium open forever
if (full !== null) fs.writeFileSync(path.join(pMain, out("Null") + ".expected.json"), JSON.stringify({ ...full, referenceImage: null }, null, 2) + "\n");
// e5: the reference replaced after --expect (a re-pull without re-running --expect)
fs.writeFileSync(path.join(pSwap, "design", "export", "assets", "90_1_ref.png"), encodePng(decodePng(refPng)));
// e6: the Firings section reached by --steps (JS state); a step that cannot run
fs.writeFileSync(path.join(pMain, "steps.json"), JSON.stringify([{ click: "[data-tab=firings]" }, { waitFor: "[data-dt-node=\"90:1\"]" }]));
fs.writeFileSync(path.join(pMain, "bad-steps.json"), JSON.stringify([{ click: "[data-tab=kilns]" }]));
// e8: a stale diff image from an earlier run at the --out path
fs.writeFileSync(path.join(pMain, out("Short") + ".diff.png"), thumbPng);

// ---- the probe runs, 2 at a time (each has its own --out; a fixed 2, not poolSize(): the checks were validated at 2)
const q = limit(2);
const OFF = ["--behaviour", "off"];
const P = {
  e1: q(() => probe(pMain, ["--expected", EXP, "--url", url(), "--out", out("Firings")])),
  e7a: q(() => probe(pMain, ["--expected", EXP, "--url", url(), "--out", out("Off"), ...OFF])),
  e7b: q(() => probe(pMain, ["--expected", out("Older") + ".expected.json", "--url", url(), "--out", out("Older"), ...OFF])),
  e1o: q(() => probe(pMain, ["--expected", EXP, "--url", url("offset-frame"), "--out", out("Offset"), ...OFF])),
  e2: q(() => probe(pMain, ["--expected", EXP, "--url", url("recolor"), "--out", out("Recolor"), ...OFF])),
  e3: q(() => probe(pOld, ["--expected", EXP, "--url", url(), "--out", out("Firings"), ...OFF])),
  e4: q(() => probe(pThumb, ["--expected", EXP, "--url", url(), "--out", out("Firings"), ...OFF])),
  e5: q(() => probe(pSwap, ["--expected", EXP, "--url", url(), "--out", out("Firings"), ...OFF])),
  e6: q(() => probe(pMain, ["--expected", EXP, "--url", url("tabs"), "--out", out("Tabs"), "--steps", "steps.json", ...OFF])),
  e6x: q(() => probe(pMain, ["--expected", EXP, "--url", url("tabs"), "--out", out("TabsBad"), "--steps", "bad-steps.json", ...OFF])),
  e8: q(() => probe(pMain, ["--expected", EXP, "--url", url(), "--out", out("Short"), "--max-time", "15000", ...OFF])),
  e9: q(() => probe(pMain, ["--expected", EXP, "--url", url("tall"), "--out", out("Tall"), ...OFF])),
  e10: q(() => probe(pMain, ["--expected", out("Ledger") + ".expected.json", "--url", url("long"), "--out", out("Ledger"), ...OFF])),
  e11: q(() => run(pMain, PROBE, ["--expected", out("Null") + ".expected.json", "--url", url(), "--out", out("Null"), "--project", pMain, ...OFF], 60_000)),
  e12: q(() => run(monoApp, PROBE, ["--expected", path.join("..", out("Firings") + ".expected.json"), "--url", url(), "--out", path.join("..", out("Mono")), "--project", monoApp, ...OFF], 90_000)),
};

// ---- e1: the correct twin
{
  const r = await P.e1;
  const m = read(pMain, out("Firings")), v = ran(m);
  console.log(`    e1: exit ${r.status} ${Math.round(r.ms / 1000)}s — ${brief(m)}`);
  if (r.status !== 0) console.log(r.stderr.slice(0, 2000));
  check("e1 the probe exits 0 and runs the visual diff", r.status === 0 && v !== null);
  check(`e1 the reference grid, at the index's scale (dsf ${v?.capture.dsf}, scale ${SCALE})`, v !== null && v.grid === "reference" && v.resampled === "none" && v.capture.dsf === SCALE && v.reference.from === "index" && v.reference.scale === SCALE);
  check(`e1 the reference crop skips the 12 px shadow margin (${JSON.stringify(v?.reference.crop)})`, v !== null && v.reference.crop.x === Math.round(12 * SCALE) && v.reference.crop.y === Math.round(12 * SCALE) && v.reference.offset.x === -12);
  check(`e1 a correct twin: shift-tolerant < 0.5 %, no hot region (${v?.shiftTolerantPct}%, ${v?.regionsTotal})`, v !== null && v.shiftTolerantPct < 0.5 && v.regionsTotal === 0);
  check("e1 the clip is the design window in whole CSS px at the frame's top-left", v !== null && v.capture.clip.x === 0 && v.capture.clip.y === 0 && v.capture.clip.w === 1440 && v.capture.clip.h === 720 && v.capture.frame.nodeId === "90:1" && v.capture.frame.via === "tag");
  const dp = path.join(pMain, out("Firings") + ".diff.png");
  const di = fs.existsSync(dp) ? pngInfo(fs.readFileSync(dp)) : null;
  check(`e1 <S>.diff.png exists with the compared size (${di?.w}×${di?.h} vs ${v?.compared.w}×${v?.compared.h})`, di !== null && v !== null && di.w === v.compared.w && di.h === v.compared.h && v.diff === (out("Firings") + ".diff.png").split(path.sep).join("/"));
  check("e1 the diff image is never in measured.artifacts", m !== null && !(m.artifacts ?? []).some((a) => (typeof a === "string" ? a : a.path ?? "").endsWith(".diff.png")));
  check("e1 the probe prints the visual line (informational)", /visual \(informational — never the verdict\) .*% of pixels differ/.test(r.stderr));
  check("e1 behaviour still ran after the capture", m !== null && m.behaviour !== undefined && m.behaviour.ran === true);
}
// ---- e1 (offset frame): a frame whose window reaches below the viewport is captured whole (fullPage)
{
  const r = await P.e1o;
  const m = read(pMain, out("Offset")), v = ran(m);
  console.log(`    e1 offset-frame: exit ${r.status} — ${brief(m)}`);
  check(`e1 a frame 200 px down a taller page: clip at y 200, low diff (${v?.capture.clip.y}, ${v?.shiftTolerantPct}%)`, v !== null && v.capture.clip.y === 200 && v.grid === "reference" && v.shiftTolerantPct < 0.5 && v.regionsTotal === 0);
}
// ---- e2: a recoloured card
{
  const r = await P.e2;
  const m = read(pMain, out("Recolor")), v = ran(m);
  console.log(`    e2: exit ${r.status} — ${brief(m)}`);
  const hit = v?.regions.find((g) => g.built.includes("90:12"));
  check(`e2 a region names the recoloured card 90:12 among its built nodes, shift-tolerant > 1 % (${v?.shiftTolerantPct}%)`, v !== null && hit !== undefined && v.shiftTolerantPct > 1);
  check("e2 the region also names the designed card (design geometry)", hit !== undefined && hit.designed.includes("90:12"));
  check(`e2 the region sits over the card in CSS px (${JSON.stringify(hit?.rect)})`, hit !== undefined && hit.rect.x >= 32 + 2 * 324 - 12 && hit.rect.x <= 32 + 2 * 324 + 12 && hit.rect.y >= 148 && hit.rect.y <= 172 && hit.rect.w >= 280);
}
// ---- e3: an export pulled before the index had the scale (from: "export")
{
  const r = await P.e3;
  const m = read(pOld, out("Firings")), v = ran(m);
  console.log(`    e3: exit ${r.status} — ${brief(m)}`);
  check(`e3 old export: the scale and offset recomputed from renderBox equal the index's (${v?.reference.scale}, ${JSON.stringify(v?.reference.offset)})`, v !== null && v.reference.from === "export" && v.reference.scale === SCALE && v.reference.offset.x === -12 && v.reference.offset.y === -12);
  check("e3 the same result as e1 (low diff, no region)", v !== null && v.grid === "reference" && v.shiftTolerantPct < 0.5 && v.regionsTotal === 0);
}
// ---- e7: invariance — with and without referenceImage the measurement is the same
const strip = (m: VerifyMeasured | null): string => JSON.stringify(m === null ? null : { nodes: m.nodes, notMeasured: m.notMeasured, interactions: m.interactions ?? null, page: m.page ?? null,
  navigation: m.navigation ? { ...m.navigation, events: m.navigation.events.map((ev) => ({ type: ev.type, url: ev.url })) } : null });
{
  const [ra, rb] = [await P.e7a, await P.e7b];
  const a = read(pMain, out("Off")), b = read(pMain, out("Older"));
  console.log(`    e7: exit ${ra.status}/${rb.status} — ${brief(a)} | ${brief(b)}`);
  check("e7 with --behaviour off the visual diff still runs (it is no behaviour check)", ran(a) !== null);
  check(`e7 an expectation older than 12c: not run, re-run --expect (${whyOf(b)})`, /older than 12c \(no referenceImage\) — re-run --expect/.test(whyOf(b)) && !fs.existsSync(path.join(pMain, out("Older") + ".diff.png")));
  check("e7 nodes, notMeasured, interactions, page and navigation are identical with and without the diff", a !== null && b !== null && strip(a) === strip(b));
  check("e7 the measured artifacts are the same list shape (only the screenshot)", a !== null && b !== null && (a.artifacts ?? []).length === 1 && (b.artifacts ?? []).length === 1);
}
// ---- e4: a discovery thumbnail as the reference (F-08) — and the --compare verdict does not move
{
  const r = await P.e4;
  const m = read(pThumb, out("Firings"));
  console.log(`    e4: exit ${r.status} — ${brief(m)}`);
  check(`e4 a 360 px thumbnail: not run, the F-08 why (${whyOf(m)})`, r.status === 0 && /a discovery thumbnail, F-08/.test(whyOf(m)) && !fs.existsSync(path.join(pThumb, out("Firings") + ".diff.png")));
  const c4 = await vs(pThumb, ["--compare", EXP, out("Firings") + ".measured.json", "--out", out("Firings")]);
  const c1 = await vs(pMain, ["--compare", EXP, out("Off") + ".measured.json", "--out", out("Off")]);
  const r4 = readReport(pThumb, out("Firings")), r1 = readReport(pMain, out("Off"));
  console.log(`    e4 compare: ${r4?.verdict} / ${r1?.verdict} (exit ${c4.status}/${c1.status}) — ${JSON.stringify(r4?.why ?? null).slice(0, 300)}`);
  check("e4 the --compare verdict and why equal the diffed run's (the diff is never the verdict)", r4 !== null && r1 !== null && r4.verdict === r1.verdict && JSON.stringify(r4.why ?? null) === JSON.stringify(r1.why ?? null));
}
// ---- e5: the reference changed since --expect
{
  const r = await P.e5;
  const m = read(pSwap, out("Firings"));
  console.log(`    e5: exit ${r.status} — ${brief(m)}`);
  check(`e5 a reference PNG replaced after --expect: not run (${whyOf(m)})`, r.status === 0 && /changed since --expect/.test(whyOf(m)));
}
// ---- e6: a section of the app reached by --steps (L-1 reach reused)
{
  const [r, rx] = [await P.e6, await P.e6x];
  const m = read(pMain, out("Tabs")), v = ran(m);
  console.log(`    e6: exit ${r.status} — ${brief(m)}; bad steps exit ${rx.status}`);
  check(`e6 the Firings section reached by --steps: low diff (${v?.shiftTolerantPct}%)`, r.status === 0 && v !== null && v.grid === "reference" && v.shiftTolerantPct < 0.5 && v.regionsTotal === 0);
  check("e6 a step that fails while measuring is still exit 4 with nothing written", rx.status === 4 && !fs.existsSync(path.join(pMain, out("TabsBad") + ".measured.json")) && !fs.existsSync(path.join(pMain, out("TabsBad") + ".diff.png")));
}
// ---- e8: no time left for the capture
{
  const r = await P.e8;
  const m = read(pMain, out("Short"));
  console.log(`    e8: exit ${r.status} ${Math.round(r.ms / 1000)}s — ${brief(m)}`);
  check(`e8 a small --max-time: exit 0, measured.json written, the diff not run — no time left (${whyOf(m)})`, r.status === 0 && m !== null && /no time left within --max-time/.test(whyOf(m)));
  check("e8 the stale <S>.diff.png of an earlier run is removed", !fs.existsSync(path.join(pMain, out("Short") + ".diff.png")));
  check("e8 the stderr says the diff did not run", /visual not run \(no time left/.test(r.stderr));
}
// ---- e9: the built frame is taller than the design (D48)
{
  const r = await P.e9;
  const m = read(pMain, out("Tall")), v = ran(m);
  console.log(`    e9: exit ${r.status} — ${brief(m)}`);
  check("e9 only the design window is compared, on the reference grid (no 1x fallback)", v !== null && v.grid === "reference" && v.resampled === "none" && v.capture.clip.h === 720 && v.shiftTolerantPct < 0.5);
  check("e9 a note says the built frame is taller than the design", v !== null && v.notes.some((n) => /1440×800 CSS px and the design 1440×720/.test(n)));
}
// ---- e10: a tall frame whose reference scale is below 1 (Chromium renders at a factor < 1: facts-12c "B verification")
{
  const r = await P.e10;
  const m = read(pMain, out("Ledger")), v = ran(m);
  console.log(`    e10: exit ${r.status} ${Math.round(r.ms / 1000)}s — ${brief(m)}`);
  check(`e10 a 400×5000 frame at scale ${LEDGER_SCALE}: rendered at it, on the reference grid, low diff`, v !== null && v.capture.dsf === LEDGER_SCALE && LEDGER_SCALE < 1 && v.grid === "reference" && v.shiftTolerantPct < 0.5 && v.compared.h >= 2046 && v.compared.h <= 2048);
}
// ---- e11 (F-1): a null referenceImage — ran:false with why, exit 0, the measured file written, the process exits
{
  const r = await P.e11;
  const m = read(pMain, out("Null"));
  console.log(`    e11: exit ${r.status}${r.killed ? " (KILLED — hung)" : ""} ${Math.round(r.ms / 1000)}s — ${brief(m)}`);
  if (r.status !== 0) console.log(r.stderr.slice(0, 1000));
  check("[F-1] e11 referenceImage null: the probe exits 0 on its own and writes measured.json", !r.killed && r.status === 0 && m !== null);
  check(`[F-1] e11 …visual ran:false 'malformed — re-run --expect' (${whyOf(m)})`, /referenceImage is malformed — re-run --expect/.test(whyOf(m)) && /visual not run \(the expectation's referenceImage is malformed/.test(r.stderr));
}
// ---- e12 (F-2): the monorepo — the probe in app/ (--project app), the expectation in the root's design/verify
{
  const r = await P.e12;
  const m = read(pMono, out("Mono")), v = ran(m);
  console.log(`    e12: exit ${r.status}${r.killed ? " (KILLED)" : ""} — ${brief(m)}`);
  check(`[F-2] e12 a monorepo (design/ at the root, --project app): the reference is found and diffed (${whyOf(m)})`, r.status === 0 && v !== null && v.grid === "reference" && v.shiftTolerantPct < 0.5);
}

finish();
report();
