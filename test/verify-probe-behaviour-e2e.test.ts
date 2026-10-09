// End-to-end tests for the behaviour/a11y checks: the BUILT claude-plugin/scripts/verify-probe.js (and the built
// verify-screen.js for --expect / --compare) in a real chromium, from TEMP consumer projects (design/export + node_modules of
// their own — never the repo root): one with axe-core in node_modules (symlinked from the repo's devDependency), one without.
//
// The fixture "Seed Shelf" (test/fixtures/probe/seed-shelf.*, invented names): the Crates screen (80:1) with eight overlay
// openers (each opens a dialog holding the destination frame's tag 80:60 — overlay center, closeOnClickOutside, #00000066), a
// mask icon, a focus-ring utility pair, a Seed Trays region and a tall tail. No ?mode= is the correct twin; ?mode=broken
// breaks one thing per check (hidden-opener, leaky-listbox, div-modal, relative-dialog, backdrop-ignored, outline-hidden,
// mask-bare, nested-regions, two-main, unnamed-icon, div-button, hover-only); ?mode=fixed-table and ?mode=spin-on-tab stand alone. The
// server sends `Content-Security-Policy: script-src 'self'` on every page (the app script is served from /seed-shelf.js), so
// axe-core runs under a CSP (it is injected by page.evaluate). The server counts every write — any method but GET/HEAD/OPTIONS
// at any path (POST /graphql excepted: the fixture's read-by-POST endpoint) and every WebSocket message the page sends:
// the probe must never make one. It also serves a SharedWorker API client (/seed-api-worker.js) and a service worker
// (/seed-sw.js) that write when asked, and answers every load after the first of a ?mode=later-empty URL as an empty state.
//
// needs the repo's devDependencies playwright (+ chromium) and axe-core. Locally an unavailable renderer prints SKIPPED;
// in CI (CI=true) that is a failure.  Run with:  node test/verify-probe-behaviour-e2e.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { isVerifyExpectation, isVerifyMeasured, isVerifyReport } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { BehaviourCheck, VerifyMeasured, VerifyReport } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { limit } from "./pool.ts";

const ROOT = path.join(import.meta.dirname, "..");
const PROBE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const VS = path.join(ROOT, "claude-plugin", "scripts", "verify-screen.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-behaviour-e2e-"));

// ---- two temp consumer projects: the same export, Playwright from the repo; axe-core only in the first
const project = (name: string, axe: boolean): string => {
  const proj = path.join(tmp, name);
  const pagesDir = path.join(proj, "design", "export", "pages", "Shelf");
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(path.join(proj, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(proj, "node_modules"));
  fs.writeFileSync(path.join(proj, "package.json"), `{"name":"${name}","private":true}\n`);
  fs.copyFileSync(path.join(FIX, "seed-shelf.json"), path.join(pagesDir, "Crates__80_1.json"));
  fs.copyFileSync(path.join(FIX, "seed-shelf-crate-form.json"), path.join(pagesDir, "Crate_Form__80_60.json"));
  const row = (n: string, id: string, file: string): Record<string, string> => ({ name: n, id, type: "FRAME", page: "Shelf", pageId: "80:0", file: `pages/Shelf/${file}` });
  const layers = [row("Crates", "80:1", "Crates__80_1.json"), row("Crate Form", "80:60", "Crate_Form__80_60.json")];
  fs.writeFileSync(path.join(proj, "design", "export", "pages", "index.json"), JSON.stringify({ pageDirs: [{ page: "Shelf", pageId: "80:0", dir: "Shelf", index: "pages/Shelf/index.json", layers: 2 }], layers }, null, 2));
  fs.writeFileSync(path.join(pagesDir, "index.json"), JSON.stringify({ page: "Shelf", pageId: "80:0", layers }, null, 2));
  for (const pkg of ["playwright", "playwright-core", ...(axe ? ["axe-core"] : [])]) {
    const from = path.join(ROOT, "node_modules", pkg);
    if (fs.existsSync(from)) fs.symlinkSync(from, path.join(proj, "node_modules", pkg), "dir");
  }
  return proj;
};
const projAxe = project("seed-shelf", true);
const projBare = project("seed-shelf-bare", false);
// a project whose axe-core never answers (axe.run's promise never settles) — the a11y unit must not wait on it
const projSlowAxe = project("seed-shelf-slow-axe", false);
fs.mkdirSync(path.join(projSlowAxe, "node_modules", "axe-core"));
fs.writeFileSync(path.join(projSlowAxe, "node_modules", "axe-core", "package.json"), "{\"name\":\"axe-core\",\"version\":\"0.0.0-hang\",\"main\":\"index.js\"}\n");
fs.writeFileSync(path.join(projSlowAxe, "node_modules", "axe-core", "index.js"), "module.exports = { version: \"0.0.0-hang\", source: \"window.axe = { version: '0.0.0-hang', run: () => new Promise(() => {}) };\" };\n");

// ---- the server: the fixture under any query, CSP on every page, the app script from the page's text/plain block
// every write the server receives (method + path + query), and the WebSocket messages pages sent
let mutations = 0, cspPages = 0, graphqlReads = 0;
const writes: string[] = [];
/** every write charged to the run whose page made it — the page URL's query (`?mode=…`, "" for none): a fetch's
 *  Referer, the `from` parameter the fixture's WebSockets carry. A write no page URL names (a worker's own request) is charged to
 *  every run ("?"). So one run's write never fails another run's "0 writes" check; a final check still wants 0 in all. */
const writesBy = new Map<string, string[]>();
const charge = (run: string | null, what: string): void => { mutations++; writes.push(what); const k = run ?? "?"; writesBy.set(k, [...(writesBy.get(k) ?? []), what]); };
const runOfPage = (href: string | null | undefined): string | null => { try { const u = new URL(href ?? ""); return u.pathname === "/seed-shelf.html" ? u.search : null; } catch { return null; } };
/** the writes of the runs on these modes (undefined: the page without ?mode=), plus the unattributed ones */
const writesOf = (...modes: Array<string | undefined>): string[] => [...modes.flatMap((m) => writesBy.get(m === undefined ? "" : `?mode=${m}`) ?? []), ...(writesBy.get("?") ?? [])];
const html = fs.readFileSync(path.join(FIX, "seed-shelf.html"), "utf8");
const appJs = /<script type="text\/plain" id="seed-shelf-app">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const js = (res: http.ServerResponse, body: string): void => { res.writeHead(200, { "content-type": "text/javascript" }); res.end(body); };
const loads = new Map<string, number>();
const server = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "POST" && u.pathname === "/graphql") { graphqlReads++; res.writeHead(200, { "content-type": "application/json" }); res.end("{\"data\":{\"crates\":[{\"name\":\"Oak crate\"}]}}"); return; }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") { charge(runOfPage(req.headers.referer), `${method} ${u.pathname}${u.search}`); res.writeHead(204); res.end(); return; }
  if (u.pathname === "/seed-shelf.js") { js(res, appJs); return; }
  if (u.pathname === "/seed-api-worker.js") { js(res, "onconnect = (e) => { const p = e.ports[0]; p.onmessage = (m) => fetch(\"/mutate?\" + m.data, { method: \"DELETE\" }); };"); return; }
  if (u.pathname === "/seed-sw.js") { js(res, "self.addEventListener(\"message\", (e) => fetch(\"/mutate?\" + e.data, { method: \"POST\" })); self.addEventListener(\"activate\", (e) => e.waitUntil(clients.claim()));"); return; }
  if (u.pathname !== "/seed-shelf.html") { res.writeHead(404); res.end(); return; }
  cspPages++;
  const n = (loads.get(u.search) ?? 0) + 1;
  loads.set(u.search, n);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'" });
  res.end(/later-empty/.test(u.search) && n > 1 ? html.replace("<html lang=\"en\">", "<html lang=\"en\" data-later>") : html);
});
// a WebSocket endpoint (/ws): the handshake, then every text/binary frame a page sends is a write
const sockets: Duplex[] = [];
/** every WebSocket handshake URL the server received */
const handshakes: string[] = [];
server.on("upgrade", (req, sock: Duplex) => {
  sockets.push(sock);
  handshakes.push(req.url ?? "");
  const acc = crypto.createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const from = new URL(req.url ?? "/", "http://x").searchParams.get("from");
  sock.on("data", (d: Buffer) => { const op = (d[0] ?? 0) & 0x0f; if (op === 1 || op === 2) charge(from, `WebSocket message ${req.url ?? ""}`); });
  sock.on("error", () => undefined);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/seed-shelf.html${mode ? `?mode=${mode}` : ""}`;

interface Run { status: number | null; stdout: string; stderr: string; ms: number }
const run = (cwd: string, script: string, args: string[]): Promise<Run> => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, [script, ...args], { cwd });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (status) => resolve({ status, stdout, stderr, ms: Date.now() - t0 }));
});
const probe = (proj: string, args: string[]): Promise<Run> => run(proj, PROBE, [...args, "--project", proj]);
const vs = (proj: string, args: string[]): Promise<Run> => run(proj, VS, args);
const finish = (): void => { for (const s of sockets) s.destroy(); server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
const out = (name: string): string => path.join("design", "verify", name);
const read = (proj: string, base: string): VerifyMeasured | null => readJsonOrNull(path.join(proj, base + ".measured.json"), isVerifyMeasured);
const readReport = (proj: string, base: string): VerifyReport | null => readJsonOrNull(path.join(proj, base + ".report.json"), isVerifyReport);
/** the behaviour rows (none when the block is absent or did not run) */
const rows = (m: VerifyMeasured | null): BehaviourCheck[] => {
  const b = m?.behaviour;
  return b && b.ran && Array.isArray(b.checks) ? b.checks : [];
};
const row = (m: VerifyMeasured | null, id: string, nodeId?: string, variant?: string): BehaviourCheck | undefined =>
  rows(m).find((c) => c.id === id && (nodeId === undefined || c.nodeId === nodeId) && (variant === undefined || c.variant === variant));
const statusOf = (m: VerifyMeasured | null, id: string, nodeId?: string, variant?: string): string => row(m, id, nodeId, variant)?.status ?? "absent";
const DIALOG = ["dialog.focus-on-open", "dialog.focus-trap", "dialog.escape-closes", "dialog.focus-return", "dialog.nested-escape", "dialog.scroll-open", "dialog.scrim", "dialog.click-outside"];
const show = (m: VerifyMeasured | null, re: RegExp): void => { for (const c of rows(m)) if (re.test(c.status)) console.log(`      ${c.status} ${c.id} ${c.nodeId ?? ""} ${c.variant ?? ""} ${c.detail.slice(0, 160)}`); };

console.log("verify-probe behaviour e2e — the built bundles in a real chromium, from temp projects:");
const pre = await probe(projBare, ["--check"]);
if (pre.status === 3) {
  const reason = pre.stderr.split("\n")[0] || "renderer unavailable";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); finish(); process.exit(0); }
  check(`the renderer is available in CI — ${reason}`, false);
  finish();
  report();
}
const axePkg = readJsonOrNull(path.join(ROOT, "node_modules", "axe-core", "package.json"), isJsonObject);
const axeVersion = axePkg && typeof axePkg.version === "string" ? axePkg.version : null;
if (axeVersion === null) check("the repo's devDependency axe-core is installed (CI runs the real axe)", process.env.CI !== "true");

// ---- the expectations, from the real --expect
for (const proj of [projAxe, projBare, projSlowAxe]) {
  const e = await vs(proj, ["--expect", "design/export/pages/Shelf/Crates__80_1.json", "--out", out("Crates")]);
  if (e.status !== 0) { console.log(e.stderr); check("verify-screen --expect wrote the expectation", false); finish(); report(); }
  // the same expectation without interactions (page checks only — fast)
  const full = readJsonOrNull(path.join(proj, out("Crates") + ".expected.json"), isVerifyExpectation);
  if (full !== null) { const { interactions: _drop, ...quiet } = full; fs.writeFileSync(path.join(proj, out("Quiet") + ".expected.json"), JSON.stringify(quiet, null, 2) + "\n"); }
}
const EXP = out("Crates") + ".expected.json", QUIET = out("Quiet") + ".expected.json";

// ---- the independent probe runs, queued up front and run 3 at a time (each has its own --out); awaited where their checks are
// (a fixed 3, not poolSize(): the budget-sensitive checks were validated at 3 on a 4-vCPU CI runner)
const q = limit(3);
// correct builds the probe must not misjudge or touch
const E1 = "enter-submit,row-enter,headless-ui,closed-menu,anim-in,scroll-lock";
const E2 = "cycle-date,cycle-shadow,cycle-iframe,names,cancel-link,fab,div-modal,trap-cap,fv-reveal,waapi-spin,lab-scrim,role-link-close";
const E3 = "card-delete,enter-confirm,keydown-open,doc-enter";
const E4 = "hui-wrap,tag-inner,cell-opener";
const E5 = "cdk-overlay,toast-portal";
const E6 = "nested-modal,card-own,ws-late-open";
// writes through a SharedWorker, a prototype-registered service worker and a WebSocket + a page
// container under a missing scrim; reads by POST + an MSW-style service worker + an oklab() transparent wrapper; a
// deferred write, an autosave 300 ms after the last close + an open 0-px modal root around the screen
const E7 = "shared-api,sw-proto,ws-delete,deco-bg";
const E8 = "graphql-load,msw-like,hui-wrap,oklab-wrap";
const E9 = "undo-delay,hui-outer,close-autosave";
// cells beside text that shows nothing — an opacity-0 hover tooltip (80:18), a clip-path-only
// sr-only label (80:23) — next to the plain cell (80:22)
const E10 = "cell-opener,cell-quiet";
// cards with an in-flow opacity-0 label (80:18) or a CSS-mask icon (80:23) around their
// centred Delete, a cell under a hover tint (80:22)
const E11 = "own-r6";
// cards whose only content of their own is painted — a <progress> (80:18), the card's own
// ::before status dot (80:23) — around a centred Delete, and a cell whose button sits in a filled wrapper (80:22)
const E12 = "own-r7";
const P = {
  // the first Enter freezes the page for good — its unit is cut at its own cap, the next unit still runs (the longest run: first)
  rFz: q(() => probe(projBare, ["--expected", EXP, "--url", url("freeze-enter"), "--out", out("FreezeEnter"), "--max-time", "70000"])),
  r1: q(() => probe(projAxe, ["--expected", EXP, "--url", url(), "--out", out("Ok")])),
  r2: q(() => probe(projBare, ["--expected", EXP, "--url", url("broken"), "--out", out("Broken")])),
  rE1: q(() => probe(projBare, ["--expected", EXP, "--url", url(E1), "--out", out("Edge1")])),
  rE2: q(() => probe(projBare, ["--expected", EXP, "--url", url(E2), "--out", out("Edge2")])),
  rE3: q(() => probe(projBare, ["--expected", EXP, "--url", url(E3), "--out", out("Edge3")])),
  rE4: q(() => probe(projBare, ["--expected", EXP, "--url", url(E4), "--out", out("Edge4")])),
  rE5: q(() => probe(projBare, ["--expected", EXP, "--url", url(E5), "--out", out("Edge5")])),
  rE6: q(() => probe(projBare, ["--expected", EXP, "--url", url(E6), "--out", out("Edge6")])),
  rE7: q(() => probe(projBare, ["--expected", EXP, "--url", url(E7), "--out", out("Edge7")])),
  rE8: q(() => probe(projBare, ["--expected", EXP, "--url", url(E8), "--out", out("Edge8")])),
  rE9: q(() => probe(projBare, ["--expected", EXP, "--url", url(E9), "--out", out("Edge9")])),
  rE10: q(() => probe(projBare, ["--expected", EXP, "--url", url(E10), "--out", out("Edge10")])),
  rE11: q(() => probe(projBare, ["--expected", EXP, "--url", url(E11), "--out", out("Edge11")])),
  rE12: q(() => probe(projBare, ["--expected", EXP, "--url", url(E12), "--out", out("Edge12")])),
  // every load after the measurement pass's is an empty state (page checks only)
  rFp: q(() => probe(projBare, ["--expected", QUIET, "--url", url("later-empty"), "--out", out("LaterEmpty")])),
  r3: q(() => probe(projAxe, ["--expected", EXP, "--url", url(), "--out", out("Off"), "--behaviour", "off"])),
  r4: q(() => probe(projBare, ["--expected", QUIET, "--url", url("fixed-table"), "--out", out("Fixed")])),
  r5: q(() => probe(projBare, ["--expected", QUIET, "--url", url(), "--out", out("QuietOk"), "--behaviour", "off"])),
  rAx: q(() => probe(projSlowAxe, ["--expected", QUIET, "--url", url(), "--out", out("SlowAxe")])),
  r6: q(() => probe(projBare, ["--expected", QUIET, "--url", url("spin-on-tab"), "--out", out("Spin"), "--max-time", "40000"])),
};

// ================================================================ the correct twin (axe-core in the project)
const r1 = await P.r1;
const m1 = read(projAxe, out("Ok"));
if (r1.status !== 0) console.log(r1.stderr);
const b1 = m1?.behaviour;
check("ok: exit 0, measured.behaviour version 1, ran, chromium, budget ≤ 90 s, not cut", r1.status === 0 && b1?.version === 1 && b1.ran === true && b1.browser.name === "chromium" && b1.budgetMs <= 90_000 && b1.budgetMs > 0 && !b1.cut);
const bad1 = rows(m1).filter((c) => c.status === "fail" || c.status === "warn");
if (bad1.length) show(m1, /fail|warn/);
check("ok: the correct twin has no fail and no warn", rows(m1).length > 0 && bad1.length === 0);
check("ok (opacity-0 opener revealed on hover AND focus-within): dialog.focus-return 80:12 escape + close pass, keyboard.reachable has no 80:12 row (passes in the aggregate)",
  statusOf(m1, "dialog.focus-return", "80:12", "escape") === "pass" && statusOf(m1, "dialog.focus-return", "80:12", "close") === "pass"
  && row(m1, "keyboard.reachable", "80:12") === undefined && /^8 of 8/.test(row(m1, "keyboard.reachable")?.detail ?? ""));
check("ok: the listbox's Escape is its own → nested-escape 80:15 pass; the trapped div modal → focus-trap 80:16 pass",
  statusOf(m1, "dialog.nested-escape", "80:15") === "pass" && statusOf(m1, "dialog.focus-trap", "80:16") === "pass");
check("the safe close is × (aria-label Close), never Delete/Save: focus-return 80:15 close pass, and no write ever reached POST /mutate",
  statusOf(m1, "dialog.focus-return", "80:15", "close") === "pass" && writesOf().length === 0);
check("ok (top-layer dialog): scroll-open 80:17 y=150 and y=max pass (y=max opened by focus({preventScroll})+Enter)",
  statusOf(m1, "dialog.scroll-open", "80:17", "y=150") === "pass" && statusOf(m1, "dialog.scroll-open", "80:17", "y=max") === "pass" && /preventScroll/.test(row(m1, "dialog.scroll-open", "80:17", "y=max")?.detail ?? ""));
check("ok: dialog.scrim + dialog.click-outside 80:18 pass (#00000066 = rgba(0, 0, 0, 0.4); a click outside closes it)",
  statusOf(m1, "dialog.scrim", "80:18") === "pass" && statusOf(m1, "dialog.click-outside", "80:18") === "pass");
check("ok: outline-hidden + focus-visible:outline-2 + outline-solid, and a ring-2 utility → no focus-visible row for 80:19 / 80:25, aggregate pass",
  row(m1, "keyboard.focus-visible", "80:19") === undefined && row(m1, "keyboard.focus-visible", "80:25") === undefined && statusOf(m1, "keyboard.focus-visible") === "pass");
check("ok (a system colour under forced colours): forced-colors.visible pass", statusOf(m1, "forced-colors.visible") === "pass" && row(m1, "forced-colors.visible", "80:20") === undefined);
check("ok: a11y.landmarks pass (one main, region \"Seed Trays\" with an unnamed list inside); behaviour.landmarks inventory",
  statusOf(m1, "a11y.landmarks") === "pass" && b1?.ran === true && (b1.landmarks || []).filter((l) => l.role === "main").length === 1 && (b1.landmarks || []).some((l) => l.role === "region" && l.name === "Seed Trays"));
check("ok: every Tab stop has a role and a name → a11y.name aggregate pass, no fail", statusOf(m1, "a11y.name") === "pass" && !rows(m1).some((c) => c.id === "a11y.name" && c.status === "fail"));
check("a dialog with only a native <select> → nested-escape 80:22 not-run, synthetic:true, 'synthetic (headless)'",
  statusOf(m1, "dialog.nested-escape", "80:22") === "not-run" && row(m1, "dialog.nested-escape", "80:22")?.synthetic === true && /synthetic \(headless\)/.test(row(m1, "dialog.nested-escape", "80:22")?.detail ?? ""));
check("ok (fluid layout): layout.subpixel pass at design/1024/320, overflow.mid + overflow.narrow pass; widths design/mid/narrow recorded",
  statusOf(m1, "layout.subpixel", undefined, "design") === "pass" && statusOf(m1, "layout.subpixel", undefined, "1024x800") === "pass" && statusOf(m1, "layout.subpixel", undefined, "320x800") === "pass"
  && statusOf(m1, "overflow.mid") === "pass" && statusOf(m1, "overflow.narrow") === "pass" && b1?.ran === true && b1.widths.map((w) => w.role).join() === "design,mid,narrow");
check("ok (<button>): keyboard.activation 80:23 pass", statusOf(m1, "keyboard.activation", "80:23") === "pass");
const ix = (m: VerifyMeasured | null, id: string): NonNullable<VerifyMeasured["interactions"]>[number] | undefined => (m?.interactions || []).find((i) => i.nodeId === id);
check("an opener under a transparent layer (synthetic drive row, ok:null) is never used for the battery: every dialog.* 80:24 not-run 'synthetic'",
  ix(m1, "80:24")?.ok === null && ix(m1, "80:24")?.activation === "synthetic"
  && rows(m1).filter((c) => c.nodeId === "80:24").length === 8 && rows(m1).filter((c) => c.nodeId === "80:24").every((c) => c.status === "not-run" && /synthetic/.test(c.detail)));
check("[axe] axe-core from the PROJECT: ran, version = the repo's devDependency, 0 violations → a11y.axe pass — under the page's CSP script-src 'self'",
  b1?.ran === true && b1.axe.ran === true && b1.axe.version === axeVersion && b1.axe.violations.length === 0 && statusOf(m1, "a11y.axe") === "pass" && cspPages > 0 && m1?.frame?.via === "tag");
const fc1 = path.join(projAxe, out("Ok") + ".forced-colors.png");
check("<S>.forced-colors.png written and listed in behaviour.artifacts, never in measured.artifacts",
  fs.existsSync(fc1) && b1?.ran === true && b1.artifacts.some((a) => a.endsWith("Ok.forced-colors.png")) && !(m1?.artifacts || []).some((a) => /forced-colors/.test(String(a))));
check("names are labelled: behaviour.namesComputedBy says 'not screen-reader verified'", b1?.ran === true && /not screen-reader verified/.test(b1.namesComputedBy));
check("the probe prints one behaviour line (not the verdict), with axe-core's version", /^behaviour \(not the fidelity verdict\) 0 fail · 0 warn · \d+ pass/m.test(r1.stderr) && /axe-core \d+\.\d+/.test(r1.stderr));

// ================================================================ the broken twin (no axe-core in the project)
const r2 = await P.r2;
const m2 = read(projBare, out("Broken"));
if (r2.status !== 0) console.log(r2.stderr);
check("broken: exit 0 with failing behaviour checks (never exit 4), measured.json written", r2.status === 0 && m2 !== null && rows(m2).some((c) => c.status === "fail"));
check("a visibility:hidden opener shown only on row hover: focus-return 80:12 escape AND close fail (focus on <body> with the pointer away)",
  statusOf(m2, "dialog.focus-return", "80:12", "escape") === "fail" && statusOf(m2, "dialog.focus-return", "80:12", "close") === "fail" && /<body>|hidden/.test(row(m2, "dialog.focus-return", "80:12", "escape")?.detail ?? ""));
check("… and keyboard.reachable 80:12 fail, naming the computed visibility", statusOf(m2, "keyboard.reachable", "80:12") === "fail" && /visibility hidden/.test(row(m2, "keyboard.reachable", "80:12")?.detail ?? ""));
check("the opener Tab cannot reach → keyboard.activation 80:12 not-run (keyboard.reachable owns it)", statusOf(m2, "keyboard.activation", "80:12") === "not-run");
check("a listbox whose Escape also closes the dialog → nested-escape 80:15 fail", statusOf(m2, "dialog.nested-escape", "80:15") === "fail" && /closed the whole dialog/.test(row(m2, "dialog.nested-escape", "80:15")?.detail ?? ""));
check("a role=dialog aria-modal div without a trap → focus-trap 80:16 fail", statusOf(m2, "dialog.focus-trap", "80:16") === "fail");
check("a dialog positioned against the document → scroll-open 80:17 y=150 fail (not centred)", statusOf(m2, "dialog.scroll-open", "80:17", "y=150") === "fail" && /not centred/.test(row(m2, "dialog.scroll-open", "80:17", "y=150")?.detail ?? ""));
check("a native dialog ignoring backdrop clicks with a transparent ::backdrop → click-outside 80:18 WARN (never fail), scrim 80:18 warn",
  statusOf(m2, "dialog.click-outside", "80:18") === "warn" && statusOf(m2, "dialog.scrim", "80:18") === "warn");
check("outline-hidden + focus-visible:outline-2 without outline-solid → keyboard.focus-visible 80:19 fail; the ring-2 twin 80:25 still passes",
  statusOf(m2, "keyboard.focus-visible", "80:19") === "fail" && row(m2, "keyboard.focus-visible", "80:25") === undefined);
check("a CSS-mask icon painted with currentColor → forced-colors.visible fail naming 80:20; the forced-colours PNG written + listed",
  statusOf(m2, "forced-colors.visible", "80:20") === "fail" && /data-dt-node="80:20"/.test(row(m2, "forced-colors.visible", "80:20")?.detail ?? "")
  && fs.existsSync(path.join(projBare, out("Broken") + ".forced-colors.png")) && m2?.behaviour?.ran === true && m2.behaviour.artifacts.length === 1);
check("two <main> → a11y.landmarks fail; region \"Seed Trays list\" inside \"Seed Trays\" → warn",
  rows(m2).some((c) => c.id === "a11y.landmarks" && c.status === "fail" && /2 main/.test(c.detail)) && rows(m2).some((c) => c.id === "a11y.landmarks" && c.status === "warn" && /Seed Trays list/.test(c.detail)));
check("an icon-only button without a name → a11y.name 80:21 fail, labelled 'not screen-reader verified'",
  statusOf(m2, "a11y.name", "80:21") === "fail" && /not screen-reader verified/.test(row(m2, "a11y.name", "80:21")?.detail ?? ""));
check("broken run too: nested-escape 80:22 not-run synthetic", row(m2, "dialog.nested-escape", "80:22")?.synthetic === true);
check("a hover-only (opacity) opener opened by mouse: focus-return 80:23 escape + close WARN (focus is back, but it is invisible with the pointer parked); keyboard.reachable 80:23 warn",
  statusOf(m2, "dialog.focus-return", "80:23", "escape") === "warn" && statusOf(m2, "dialog.focus-return", "80:23", "close") === "warn" && /opacity 0/.test(row(m2, "dialog.focus-return", "80:23", "escape")?.detail ?? "")
  && statusOf(m2, "keyboard.reachable", "80:23") === "warn");
check("a div role=button tabindex=0 with only a click handler → keyboard.activation 80:23 fail (the drive's mouse row stays ok:true)",
  statusOf(m2, "keyboard.activation", "80:23") === "fail" && ix(m2, "80:23")?.ok === true);
check("[axe] 12 no axe-core in the project → a11y.axe not-run 'axe-core not installed in the project (optional)', behaviour.axe.ran false",
  statusOf(m2, "a11y.axe") === "not-run" && /axe-core not installed in the project \(optional\)/.test(row(m2, "a11y.axe")?.detail ?? "") && m2?.behaviour?.ran === true && m2.behaviour.axe.ran === false);
check("never destructive: no POST /mutate after both battery runs (Delete crate never pressed, Save never clicked)", writesOf(undefined, "broken").length === 0);

// ================================================================ correct builds the probe must not misjudge or touch
// a readonly picker field in a POST form, a focusable row around a div opener, Headless UI's 0-px dialog root,
// a closed disclosure menu, a WAAPI entrance + a position:fixed scroll lock on one dialog
const rE1 = await P.rE1;
const mE1 = read(projBare, out("Edge1"));
if (rE1.status !== 0) console.log(rE1.stderr);
if (rows(mE1).some((c) => c.status === "fail" || c.status === "warn")) show(mE1, /fail|warn/);
check("exit 0, the correct shapes give no fail and no warn", rE1.status === 0 && rows(mE1).length > 0 && !rows(mE1).some((c) => c.status === "fail" || c.status === "warn"));
check("a readonly picker field in a POST form and a focusable row around the opener: NO write (0 POSTs) — Enter is never pressed in a form field or on an ancestor", writesOf(E1).length === 0);
check("keyboard.activation 80:18 (a readonly input inside the tagged span) not-run 'not the opener itself … a container'; 80:12 (a div inside <tr tabindex>) not-run '… an ancestor'",
  statusOf(mE1, "keyboard.activation", "80:18") === "not-run" && /not the opener itself \(the opener is a container; its focusable child <input/.test(row(mE1, "keyboard.activation", "80:18")?.detail ?? "")
  && statusOf(mE1, "keyboard.activation", "80:12") === "not-run" && /not the opener itself \(<tr tabindex="0">, an ancestor/.test(row(mE1, "keyboard.activation", "80:12")?.detail ?? ""));
check("Headless UI's 0-px role=dialog aria-modal root: the battery runs on 80:16 — focus-trap, escape-closes, focus-return escape+close, scroll-open y=150, click-outside all pass",
  ["dialog.focus-trap", "dialog.escape-closes", "dialog.click-outside"].every((id) => statusOf(mE1, id, "80:16") === "pass")
  && statusOf(mE1, "dialog.focus-return", "80:16", "escape") === "pass" && statusOf(mE1, "dialog.focus-return", "80:16", "close") === "pass" && statusOf(mE1, "dialog.scroll-open", "80:16", "y=150") === "pass");
check("an opener inside a closed disclosure menu (aria-expanded=false controls it) → keyboard.reachable 80:22 not-run 'inside a closed container', never fail",
  statusOf(mE1, "keyboard.reachable", "80:22") === "not-run" && /inside a closed container/.test(row(mE1, "keyboard.reachable", "80:22")?.detail ?? ""));
const so17 = (v: string): BehaviourCheck | undefined => row(mE1, "dialog.scroll-open", "80:17", v);
check("a WAAPI entrance + a position:fixed body scroll lock on 80:17: scroll-open y=150 and y=max PASS (the animation awaited: evidence.animations ≥ 1; the lock's top:-y read as the scroll)",
  so17("y=150")?.status === "pass" && so17("y=max")?.status === "pass" && Number(so17("y=150")?.evidence?.animations ?? 0) >= 1);
// a date input / shadow-DOM pager / titled iframe before the openers, a <summary> + an unnamed group, a router-link
// Close, a scrimless modal with a JS control in the corner, a 40-field untrapped modal, a row action revealed on its
// own :focus-visible, a WAAPI spinner in a button with no focus indicator, a lab() scrim
const rE2 = await P.rE2;
const mE2 = read(projBare, out("Edge2"));
if (rE2.status !== 0) console.log(rE2.stderr);
check("exit 0 and NO write — the JS help toggle in the corner of a scrimless modal is never clicked (0 POSTs)", rE2.status === 0 && mE2 !== null && writesOf(E2).length === 0);
check("a date input, a shadow-DOM pager and an iframe before the openers do not end the Tab walk: keyboard.reachable 8 of 8, no 'Tab walk' row; the openers after them get keyboard.activation pass (80:15, 80:16, 80:17)",
  rows(mE2).some((c) => c.id === "keyboard.reachable" && c.status === "pass" && /^8 of 8/.test(c.detail)) && !rows(mE2).some((c) => c.id === "keyboard.reachable" && /Tab walk/.test(c.detail))
  && ["80:15", "80:16", "80:17"].every((id) => statusOf(mE2, "keyboard.activation", id) === "pass"));
check("a11y.name: the titled iframe, the <summary> and the unnamed role=group pass (no a11y.name fail or warn)", statusOf(mE2, "a11y.name") === "pass" && !rows(mE2).some((c) => c.id === "a11y.name" && c.status !== "pass"));
check("click-outside 80:16 (no scrim, no native backdrop) → not-run 'no backdrop to click'", statusOf(mE2, "dialog.click-outside", "80:16") === "not-run" && /no backdrop to click/.test(row(mE2, "dialog.click-outside", "80:16")?.detail ?? ""));
check("a Close that is a router link is never a safe close: focus-return 80:18 close not-run (no button), never a fail after following it",
  statusOf(mE2, "dialog.focus-return", "80:18", "close") === "not-run" && /no visible Cancel .* button/.test(row(mE2, "dialog.focus-return", "80:18", "close")?.detail ?? "")
  && statusOf(mE2, "dialog.focus-return", "80:18", "escape") === "pass");
check("an <a role=\"button\" href> Cancel is a link by its href: never a safe close — focus-return 80:22 close not-run 'no visible … button'",
  statusOf(mE2, "dialog.focus-return", "80:22", "close") === "not-run" && /no visible Cancel .* button/.test(row(mE2, "dialog.focus-return", "80:22", "close")?.detail ?? ""));
check("an untrapped modal with 40+ tabbables → focus-trap 80:16 not-run 'too many tabbables to prove a trap', never pass", statusOf(mE2, "dialog.focus-trap", "80:16") === "not-run" && /too many tabbables/.test(row(mE2, "dialog.focus-trap", "80:16")?.detail ?? ""));
check("[known miss] a row action revealed on its own :focus-visible: focus-return 80:12 close WARNs — the safe close is a mouse click again (an Enter would fire a dialog's own Enter=confirm handler); the escape variant passes",
  statusOf(mE2, "dialog.focus-return", "80:12", "close") === "warn" && statusOf(mE2, "dialog.focus-return", "80:12", "escape") === "pass");
check("a lab() ::backdrop colour the probe does not convert → dialog.scrim 80:18 not-run (never a false warn)", statusOf(mE2, "dialog.scrim", "80:18") === "not-run" && /colour space/.test(row(mE2, "dialog.scrim", "80:18")?.detail ?? ""));
check("a button with no focus indicator holding a running WAAPI spinner → keyboard.focus-visible FAIL (only animations:\"disabled\" freezes the spinner between the two shots)",
  rows(mE2).some((c) => c.id === "keyboard.focus-visible" && c.status === "fail" && /button:nth-child\(3\)$/.test(c.target ?? "")));

// ================================================================ the write block, the opener control, the backdrop stack
// a clickable card opener with its own Delete, a dialog that confirms on Enter, a keydown-opened dialog that focuses
// Delete in the same task, a global Enter hotkey that writes
const rE3 = await P.rE3;
const mE3 = read(projBare, out("Edge3"));
if (rE3.status !== 0) console.log(rE3.stderr);
check("[write block] E3 (card with Delete, Enter=confirm dialog, keydown-open + focus Delete, a global Enter hotkey): the server receives 0 POSTs", rE3.status === 0 && mE3 !== null && writesOf(E3).length === 0);
check("keyboard.reachable counts only the opener's own control: the card's inline Delete is reached, the card (80:16) is not known to be — not-run 'the opener is a container; Tab reaches <button aria-label=\"Delete crate\"> inside it' (was: counted as reached)",
  statusOf(mE3, "keyboard.reachable", "80:16") === "not-run" && /the opener is a container; Tab reaches <button aria-label="Delete crate"> inside it/.test(row(mE3, "keyboard.reachable", "80:16")?.detail ?? ""));
check("the card opener's inline Delete is never pressed: keyboard.activation 80:16 not-run 'the opener is a container; its focusable child … is not pressed'",
  statusOf(mE3, "keyboard.activation", "80:16") === "not-run" && /the opener is a container; its focusable child <button[^>]*aria-label="Delete crate"/.test(row(mE3, "keyboard.activation", "80:16")?.detail ?? ""));
const wrote = (m: VerifyMeasured | null, id: string, nodeId: string): boolean => statusOf(m, id, nodeId) === "not-run" && /the page tried to write \(POST \/mutate/.test(row(m, id, nodeId)?.detail ?? "");
check("[write block] the keydown-opened dialog's Delete clicked by Enter's keypress, and the global Enter hotkey: keyboard.activation 80:15 and 80:12 not-run 'the page tried to write (POST /mutate…) — blocked; not judged' (never pass, never fail)",
  wrote(mE3, "keyboard.activation", "80:15") && wrote(mE3, "keyboard.activation", "80:12"));
// (E3's global Enter hotkey writes on the activation Enter, so that write is charged to every later check of the unit:
// the close is judged before the taint — evidence.was — and evidence.closedBy names the button the mouse clicked)
const fr17 = row(mE3, "dialog.focus-return", "80:17", "close");
check("the Enter=confirm dialog is closed by a mouse click on Cancel: focus-return 80:17 close judged (evidence.was), closedBy \"Cancel\"",
  fr17?.evidence?.closedBy === "Cancel" && ["pass", "warn", "fail"].includes(String(fr17.status === "not-run" ? fr17.evidence.was : fr17.status)));
// Headless UI's documented Tailwind layout (a transparent fixed centring wrapper over the backdrop) + a tag on the label
// inside the opener's <button>
const rE4 = await P.rE4;
const mE4 = read(projBare, out("Edge4"));
if (rE4.status !== 0) console.log(rE4.stderr);
check("Headless UI's centring wrapper: dialog.scrim 80:16 pass (the backdrop below the transparent wrapper) and click-outside 80:16 pass",
  statusOf(mE4, "dialog.scrim", "80:16") === "pass" && statusOf(mE4, "dialog.click-outside", "80:16") === "pass");
check("a tag on the label inside the opener's <button>: keyboard.activation 80:17 pass, scroll-open y=max pass (opened by the button's key)",
  statusOf(mE4, "keyboard.activation", "80:17") === "pass" && statusOf(mE4, "dialog.scroll-open", "80:17", "y=max") === "pass");
check("a cell whose ONLY focusable is its centred icon button: keyboard.activation 80:22 pass (that button is pressed)",
  statusOf(mE4, "keyboard.activation", "80:22") === "pass");
// (the interaction drive does not click that cell's centre — its Sort button is not the cell's own control while Clear
// sits beside it — so the battery skips the row; markOpener / keyTarget refusing a 2nd focusable is unit-tested on a fake DOM)
check("a cell whose centred button has a 2nd focusable (Clear) beside it: the drive does not click it (ok:null 'the opener's click point is another control inside it (<button type=\"button\" aria-label=\"Sort crates\">)'), every dialog.* 80:15 not-run, 0 writes",
  ix(mE4, "80:15")?.ok === null && /^the opener's click point is another control inside it \(<button type="button" aria-label="Sort crates">\)/.test(ix(mE4, "80:15")?.detail ?? "")
  && DIALOG.every((id) => statusOf(mE4, id, "80:15") === "not-run") && writesOf(E4).length === 0);
// an Angular CDK overlay (pointer-events:none container + backdrop + wrapper), a clickable toast in the corner of a
// full-viewport pointer-events:none region
const rE5 = await P.rE5;
const mE5 = read(projBare, out("Edge5"));
if (rE5.status !== 0) console.log(rE5.stderr);
check("Angular CDK's overlay: dialog.scrim 80:16 pass and click-outside 80:16 pass", statusOf(mE5, "dialog.scrim", "80:16") === "pass" && statusOf(mE5, "dialog.click-outside", "80:16") === "pass");
check("the toast in the corner is never clicked (0 POSTs): click-outside picks another backdrop point (80:12, 80:16 pass)",
  rE5.status === 0 && writesOf(E5).length === 0 && statusOf(mE5, "dialog.click-outside", "80:12") === "pass");
const triedTo = (m: VerifyMeasured | null, id: string, nodeId: string, what: RegExp): boolean => statusOf(m, id, nodeId) === "not-run" && what.test(row(m, id, nodeId)?.detail ?? "");
// a non-modal picker (role=dialog, no aria-modal) opened inside an already-open aria-modal sheet
const rE6 = await P.rE6;
const mE6 = read(projBare, out("Edge6"));
if (rE6.status !== 0) console.log(rE6.stderr);
check("a non-modal picker inside an open modal sheet is not this row's modal: every dialog.* 80:16 not-run 'not a modal dialog' (no escape-closes fail)",
  ["dialog.escape-closes", "dialog.focus-trap", "dialog.scrim"].every((id) => statusOf(mE6, id, "80:16") === "not-run" && /not a modal dialog/.test(row(mE6, id, "80:16")?.detail ?? "")));
// E6 also: a card with its own label around its only, centred control (80:18); a WebSocket opened by the
// opener's click (80:15, ?op=late-open)
check("a card with its own label whose ONLY control is a centred Unstack button (80:18): the drive does not click it (ok:null naming <button type=\"button\" aria-label=\"Unstack crate\">), every dialog.* 80:18 not-run, no DELETE reaches the server",
  ix(mE6, "80:18")?.ok === null && /^the opener's click point is another control inside it \(<button type="button" aria-label="Unstack crate">\)/.test(ix(mE6, "80:18")?.detail ?? "")
  && DIALOG.every((id) => statusOf(mE6, id, "80:18") === "not-run") && !writes.some((w) => /card-own-unstack/.test(w)));
check("keyboard.reachable 80:18: Tab reaching the Unstack button is not the card reached — not-run 'the opener is a container; Tab reaches <button … Unstack crate> inside it' (was: counted as reached)",
  statusOf(mE6, "keyboard.reachable", "80:18") === "not-run" && /the opener is a container; Tab reaches <button[^>]*Unstack crate[^>]*> inside it/.test(row(mE6, "keyboard.reachable", "80:18")?.detail ?? ""));
const lateOpens = handshakes.filter((h) => /op=late-open/.test(h)).length;
check(`a WebSocket the page opens after the unit armed never reaches the server: exactly 1 handshake ?op=late-open (the drive's click, unblocked), none from the battery (saw ${lateOpens}); keyboard.activation 80:15 not-run 'the page tried to write (WebSocket /ws…)'`,
  rE6.status === 0 && lateOpens === 1 && triedTo(mE6, "keyboard.activation", "80:15", /the page tried to write \(WebSocket \/ws/));
check(`E6 sends no WebSocket message: the drive's mouse click opens the socket without sending, the battery's keyboard press (which would send) never reaches the server (saw: ${writesOf(E6).join(", ") || "none"})`,
  rE6.status === 0 && writesOf(E6).length === 0);

// ================================================================ the write block's reach, attribution, the backdrop stack
// three writes that never pass through the page's own network stack, and a transparent app container under no scrim
const rE7 = await P.rE7;
const mE7 = read(projBare, out("Edge7"));
if (rE7.status !== 0) console.log(rE7.stderr);
check(`E7 (a SharedWorker's DELETE, a prototype-registered service worker's POST, a WebSocket message): the server receives NO write of any method at any path and no WebSocket message (saw: ${writesOf(E7).join(", ") || "none"})`,
  rE7.status === 0 && mE7 !== null && writesOf(E7).length === 0);
check("the SharedWorker's DELETE is blocked and charged to the Enter that caused it: keyboard.activation 80:15 not-run 'the page tried to write (DELETE /mutate…)' (was: pass)",
  triedTo(mE7, "keyboard.activation", "80:15", /the page tried to write \(DELETE \/mutate/));
check("the prototype-registered service worker's POST: keyboard.activation 80:17 not-run 'the page tried to write (POST /mutate…)' (was: pass)",
  triedTo(mE7, "keyboard.activation", "80:17", /the page tried to write \(POST \/mutate/));
check("a WebSocket message the page sends is dropped and recorded: keyboard.activation 80:18 not-run 'the page tried to write (WebSocket /ws…)' (was: pass, the message sent)",
  triedTo(mE7, "keyboard.activation", "80:18", /the page tried to write \(WebSocket \/ws/));
check("a transparent static app container over a decorative fixed layer is page content, never a wrapper: click-outside 80:16 not-run 'no backdrop to click' (never a click on the page), and the scrim read is none (not the decorative layer)",
  triedTo(mE7, "dialog.click-outside", "80:16", /no backdrop to click/) && statusOf(mE7, "dialog.scrim", "80:16") === "warn" && /the scrim is none/.test(row(mE7, "dialog.scrim", "80:16")?.detail ?? ""));
// the battery's reach may write (a read by POST /graphql) and service workers run (MSW)
const rE8 = await P.rE8;
const mE8 = read(projBare, out("Edge8"));
if (rE8.status !== 0) console.log(rE8.stderr);
const differs = (m: VerifyMeasured | null): boolean => rows(m).some((c) => /differs from the measured page/.test(c.detail));
check(`E8 (the action bar shows after POST /graphql answers and after an MSW-style service worker is ready): the battery runs on the measured page — keyboard.reachable 8 of 8, keyboard.activation 80:23 pass, no 'display:none at rest', no fingerprint mismatch (graphql reads answered: ${graphqlReads})`,
  rE8.status === 0 && rows(mE8).some((c) => c.id === "keyboard.reachable" && c.status === "pass" && /^8 of 8/.test(c.detail)) && statusOf(mE8, "keyboard.activation", "80:23") === "pass"
  && !rows(mE8).some((c) => /display:none at rest/.test(c.detail)) && !differs(mE8) && graphqlReads >= 4);
check("a covering wrapper whose background computes to oklab(0 0 0 / 0) is transparent: dialog.scrim 80:16 pass (the backdrop under it) and click-outside 80:16 pass",
  statusOf(mE8, "dialog.scrim", "80:16") === "pass" && statusOf(mE8, "dialog.click-outside", "80:16") === "pass");
// a write 300 ms after the Enter that clicked Delete; an open 0-px modal root around the whole screen
const rE9 = await P.rE9;
const mE9 = read(projBare, out("Edge9"));
if (rE9.status !== 0) console.log(rE9.stderr);
check("a write deferred 300 ms after the Enter that clicked Delete taints that Enter's check and every later one of the unit: keyboard.activation 80:15 and dialog.focus-on-open 80:15 not-run 'the page tried to write (POST /mutate…)' (was: activation pass)",
  rE9.status === 0 && writesOf(E9).length === 0 && triedTo(mE9, "keyboard.activation", "80:15", /the page tried to write \(POST \/mutate/) && triedTo(mE9, "dialog.focus-on-open", "80:15", /the page tried to write/));
check("a write 300 ms after the unit's LAST action (an autosave after the safe close of 80:22) is still seen — the page stays open 0.5 s after it: focus-return 80:22 close not-run 'the page tried to write (POST /mutate…)' (was: pass, the write never sent)",
  row(mE9, "dialog.focus-return", "80:22", "close")?.status === "not-run" && /the page tried to write \(POST \/mutate/.test(row(mE9, "dialog.focus-return", "80:22", "close")?.detail ?? ""));
check("a non-dialog popup opened inside an open modal root with a 0-px box is not this row's modal: dialog.focus-trap / escape-closes / scrim / click-outside 80:16 not-run 'not a modal dialog' (was: the battery on the outer root)",
  ["dialog.focus-trap", "dialog.escape-closes", "dialog.scrim", "dialog.click-outside"].every((id) => triedTo(mE9, id, "80:16", /not a modal dialog/)));
// a cell's text that shows nothing never makes its sole centred button another control — driven by the drive,
// pressed and reached by the keyboard battery exactly as the plain cell (80:22) in the same run
const rE10 = await P.rE10;
const mE10 = read(projBare, out("Edge10"));
if (rE10.status !== 0) console.log(rE10.stderr);
const asPlainCell = (id: string): boolean => ["keyboard.reachable", "keyboard.activation"].every((c) => statusOf(mE10, c, id) === statusOf(mE10, c, "80:22"));
check("cells whose sole centred icon button sits beside an opacity-0 hover tooltip (80:18) or a clip-path-only sr-only label (80:23): the drive clicks them (ok:true, mouse) as the plain cell 80:22 (was: ok:null 'another control')",
  rE10.status === 0 && ["80:18", "80:23", "80:22"].every((id) => ix(mE10, id)?.ok === true && ix(mE10, id)?.activation === "mouse"));
check(`keyboard.reachable / keyboard.activation for 80:18 and 80:23 are what the plain cell 80:22 gets (activation ${statusOf(mE10, "keyboard.activation", "80:22")}, reachable ${statusOf(mE10, "keyboard.reachable", "80:22")}: no 'the opener is a container' not-run)`,
  statusOf(mE10, "keyboard.activation", "80:22") === "pass" && asPlainCell("80:18") && asPlainCell("80:23")
  && !["80:18", "80:23"].some((id) => /the opener is a container/.test(row(mE10, "keyboard.reachable", id)?.detail ?? "")));
check(`E10 sends no write (saw: ${writesOf(E10).join(", ") || "none"})`, writesOf(E10).length === 0);
// a card's label at opacity 0 in flow (an entrance not yet played) and a CSS-mask icon are the
// card's own content — its centred Delete is never its control, in the interaction drive and in the keyboard battery alike; a hover tint
// over a cell is its chrome
const rE11 = await P.rE11;
const mE11 = read(projBare, out("Edge11"));
if (rE11.status !== 0) console.log(rE11.stderr);
const notOwn = (id: string, ctl: string): boolean => ix(mE11, id)?.ok === null && (ix(mE11, id)?.detail ?? "").startsWith(`the opener's click point is another control inside it (<button type="button" aria-label="${ctl}">)`)
  && statusOf(mE11, "keyboard.reachable", id) === "not-run" && new RegExp(`the opener is a container; Tab reaches <button[^>]*${ctl}[^>]*> inside it`).test(row(mE11, "keyboard.reachable", id)?.detail ?? "");
check("a card whose label is opacity 0 in flow (80:18) and a card with a CSS-mask icon (80:23), each around its centred Delete: the drive does not click it (ok:null naming the Delete), keyboard.reachable not-run 'the opener is a container' (was: the Delete taken as the card's control)",
  rE11.status === 0 && notOwn("80:18", "Unstack crate") && notOwn("80:23", "Unship crate"));
check(`a cell under a pointer-events:none hover tint over the whole cell (80:22): driven ok:true by mouse, keyboard.activation ${statusOf(mE11, "keyboard.activation", "80:22")} (pass)`,
  ix(mE11, "80:22")?.ok === true && ix(mE11, "80:22")?.activation === "mouse" && statusOf(mE11, "keyboard.activation", "80:22") === "pass");
check(`E11 sends no write (saw: ${writesOf(E11).join(", ") || "none"})`, writesOf(E11).length === 0);
// E12: the keyboard battery's control is judged by the SAME pixel check as the interaction drive's (only the
// control hidden vs all the container's content hidden) — a card whose only content of its own is a <progress> (80:18) or its own
// ::before status dot (80:23): the drive refuses its Delete by the pixels and Tab reaching the Delete is not the card reached (the
// battery's markOpener takes no control there, so no key is ever pressed on it); a cell whose sole button sits in a filled wrapper (80:22): driven, Enter opens it
const rE12 = await P.rE12;
const mE12 = read(projBare, out("Edge12"));
if (rE12.status !== 0) console.log(rE12.stderr);
// a <progress> is counted by the DOM's media rule first (no pixel shot), the dot by the pixels
const notOwnPx = (id: string, ctl: string, byPx: boolean): boolean => ix(mE12, id)?.ok === null && (ix(mE12, id)?.detail ?? "").startsWith(`the opener's click point is another control inside it (<button type="button" aria-label="${ctl}">)`)
  && /paints something of its own beside it/.test(ix(mE12, id)?.detail ?? "") === byPx
  && statusOf(mE12, "keyboard.reachable", id) === "not-run" && new RegExp(`the opener is a container; Tab reaches <button[^>]*${ctl}[^>]*> inside it`).test(row(mE12, "keyboard.reachable", id)?.detail ?? "");
check(`a card with a <progress> (80:18: by the DOM's media rule) or its own ::before status dot (80:23: by the pixels) around its centred Delete: the drive refuses it, keyboard.reachable not-run 'the opener is a container; Tab reaches <button …> inside it' (saw: ${statusOf(mE12, "keyboard.reachable", "80:18")} / ${statusOf(mE12, "keyboard.reachable", "80:23")}; was: pass, the Delete taken for the card's control)`,
  rE12.status === 0 && notOwnPx("80:18", "Unstack crate", false) && notOwnPx("80:23", "Unship crate", true));
check(`a cell whose sole button sits in a filled wrapper (80:22): driven ok:true by mouse, keyboard.activation ${statusOf(mE12, "keyboard.activation", "80:22")} (pass)`,
  ix(mE12, "80:22")?.ok === true && ix(mE12, "80:22")?.activation === "mouse" && statusOf(mE12, "keyboard.activation", "80:22") === "pass");
check(`E12 sends no write (saw: ${writesOf(E12).join(", ") || "none"})`, writesOf(E12).length === 0);
// a refusal of a container's sole control names its reason — the DOM rule's (E11 80:18, its opacity-0
// label in flow) and the pixels' (E12 80:23, its own ::before dot) — in the drive's row and in keyboard.reachable
check(`the refusal names its reason: 80:18 drive row '… — not driven (its own content: text "…")' and keyboard.reachable '… not the opener's own control — its own content: text …'; 80:23 drive row '(the opener paints something of its own …)' and keyboard.reachable '… not the opener's own control — the opener paints something of its own …' (saw: ${row(mE11, "keyboard.reachable", "80:18")?.detail ?? "none"} | ${row(mE12, "keyboard.reachable", "80:23")?.detail ?? "none"})`,
  /— not driven \(its own content: text "/.test(ix(mE11, "80:18")?.detail ?? "") && /not the opener's own control — its own content: text "/.test(row(mE11, "keyboard.reachable", "80:18")?.detail ?? "")
  && /— not driven \(the opener paints something of its own/.test(ix(mE12, "80:23")?.detail ?? "") && /not the opener's own control — the opener paints something of its own/.test(row(mE12, "keyboard.reachable", "80:23")?.detail ?? ""));
// the fingerprint: the battery's pages answered as an empty state
const rFp = await P.rFp;
const mFp = read(projBare, out("LaterEmpty"));
if (rFp.status !== 0) console.log(rFp.stderr);
check("every page the behaviour checks reach differs from the measured one (an empty state): every check not-run 'the page reached for this check differs from the measured page (… 80:30 …)' — never judged on another screen",
  rFp.status === 0 && (mFp?.nodes || []).length > 0 && rows(mFp).length > 0 && rows(mFp).every((c) => c.status === "not-run" && /the page reached for this check differs from the measured page \(.*80:30/.test(c.detail)));
check("no fingerprint mismatch on any other run (hover-only openers, animations and opened dialogs never trip it)",
  [m1, m2, mE1, mE2, mE3, mE4, mE5, mE6, mE7, mE8, mE9, mE10, mE11].every((m) => rows(m).length > 0 && !differs(m)));
check("behaviour.writeBlock states the block's scope in one line (what is blocked, what is not)",
  b1?.ran === true && typeof b1.writeBlock === "string" && /GET\/HEAD\/OPTIONS/.test(b1.writeBlock) && /WebSocket/.test(b1.writeBlock) && !b1.writeBlock.includes("\n"));
// a page frozen by the first Enter
const rFz = await P.rFz;
const mFz = read(projBare, out("FreezeEnter"));
if (rFz.status !== 0) console.log(rFz.stderr);
const judgedBattery = rows(mFz).filter((c) => (c.id === "keyboard.activation" || c.id.startsWith("dialog.")) && ["pass", "warn", "fail"].includes(c.status));
check(`a page frozen for good by the first Enter (the first battery row's): that unit is cut at its own cap ('time budget'), a later unit still runs (${judgedBattery.length} judged battery check(s)), exit 0 within --max-time 70 s (exit ${String(rFz.status)} in ${rFz.ms} ms; 80:12 activation: ${(row(mFz, "keyboard.activation", "80:12")?.detail ?? "no row").slice(0, 60)})`,
  rFz.status === 0 && rFz.ms < 70_000 && mFz?.behaviour?.ran === true && /time budget/.test(row(mFz, "keyboard.activation", "80:12")?.detail ?? "") && judgedBattery.length > 0);

// ================================================================ --behaviour off, the interactions unchanged
const r3 = await P.r3;
const m3 = read(projAxe, out("Off"));
if (r3.status !== 0) console.log(r3.stderr);
const off = m3?.behaviour;
check("--behaviour off → exit 0, measured.behaviour {version:1, ran:false, why:'--behaviour off'}, no forced-colours PNG, the line says so",
  r3.status === 0 && off !== undefined && off.version === 1 && off.ran === false && off.why === "--behaviour off" && !fs.existsSync(path.join(projAxe, out("Off") + ".forced-colors.png")) && /behaviour not run \(--behaviour off\)/.test(r3.stderr));
check("measured.interactions are identical with behaviour on and off (the battery never touches the drive evidence)",
  (m1?.interactions || []).length === 8 && JSON.stringify(m1?.interactions) === JSON.stringify(m3?.interactions));
const c1 = await vs(projAxe, ["--compare", EXP, out("Ok") + ".measured.json", "--out", out("Ok")]);
const c3 = await vs(projAxe, ["--compare", EXP, out("Off") + ".measured.json", "--out", out("Off")]);
const rep1 = readReport(projAxe, out("Ok")), rep3 = readReport(projAxe, out("Off"));
if (rep1 === null || rep3 === null) console.log(c1.stderr, c3.stderr);
check("--compare: verdict and why are the same with behaviour on and off", rep1 !== null && rep3 !== null && rep1.verdict === rep3.verdict && JSON.stringify(rep1.why) === JSON.stringify(rep3.why));
const bogus = await probe(projAxe, ["--expected", EXP, "--url", url(), "--out", out("Bogus"), "--behaviour", "maybe"]);
check("--behaviour takes on|off only (exit 2, nothing written)", bogus.status === 2 && /--behaviour must be on or off/.test(bogus.stderr) && read(projAxe, out("Bogus")) === null);
const help = await run(projAxe, PROBE, ["--help"]);
check("the usage text lists --behaviour on|off", /\[--behaviour on\|off\]/.test(help.stdout));

// ================================================================ a collapsing table (page checks only)
const r4 = await P.r4;
const m4 = read(projBare, out("Fixed"));
if (r4.status !== 0) console.log(r4.stderr);
check("a 0-px column at design width → layout.subpixel warn (design)", rows(m4).some((c) => c.id === "layout.subpixel" && c.variant === "design" && c.status === "warn" && /<td> "x" renders 0px/.test(c.detail)));
check("the auto last column collapses at 1024 → layout.subpixel warn (1024x800)", rows(m4).some((c) => c.id === "layout.subpixel" && c.variant === "1024x800" && c.status === "warn" && /Notes for the crate/.test(c.detail)));
check("the fixed table overflows at 320 → overflow.narrow warn, '2-D content exception may apply'",
  statusOf(m4, "overflow.narrow") === "warn" && /2-D content exception may apply/.test(row(m4, "overflow.narrow")?.detail ?? "") && m4?.behaviour?.ran === true && (m4.behaviour.widths.find((w) => w.role === "narrow")?.overflow.scrollable ?? false));
const r5 = await P.r5;
const c4 = await vs(projBare, ["--compare", QUIET, out("Fixed") + ".measured.json", "--out", out("Fixed")]);
const c5 = await vs(projBare, ["--compare", QUIET, out("QuietOk") + ".measured.json", "--out", out("QuietOk")]);
const rep4 = readReport(projBare, out("Fixed")), rep5 = readReport(projBare, out("QuietOk"));
if (rep4 === null || rep5 === null) console.log(r5.stderr, c4.stderr, c5.stderr);
check("--compare: the fixed-table run's verdict and why equal the correct twin's (sub-pixel cells are behaviour warnings, never fidelity deltas)",
  rep4 !== null && rep5 !== null && rep4.verdict === rep5.verdict && JSON.stringify(rep4.why) === JSON.stringify(rep5.why));

// an axe.run that never answers → a11y.axe not-run "axe timed out" after its own bound (≤ 20 s); the walk's checks still run
const rAx = await P.rAx;
const mAx = read(projSlowAxe, out("SlowAxe"));
if (rAx.status !== 0) console.log(rAx.stderr);
check("a hanging axe-core → a11y.axe not-run 'axe timed out', and the a11y unit goes on (keyboard.reachable / a11y.name not cut)",
  rAx.status === 0 && statusOf(mAx, "a11y.axe") === "not-run" && /axe timed out/.test(row(mAx, "a11y.axe")?.detail ?? "") && statusOf(mAx, "a11y.name") === "pass" && mAx?.behaviour?.ran === true && !mAx.behaviour.cut);

// a later run that takes no forced-colours screenshot removes the earlier one at that exact path
const r4off = await probe(projBare, ["--expected", QUIET, "--url", url("fixed-table"), "--out", out("Fixed"), "--behaviour", "off"]);
check("the same --out re-run with --behaviour off → the earlier <S>.forced-colors.png is gone, measured.json + PNG written",
  r4off.status === 0 && !fs.existsSync(path.join(projBare, out("Fixed") + ".forced-colors.png")) && fs.existsSync(path.join(projBare, out("Fixed") + ".png")) && read(projBare, out("Fixed"))?.behaviour?.ran === false);

// ================================================================ the browser wedges (SIGSTOP) during the behaviour units
if (process.platform !== "win32") {
  const frozen: number[] = [];
  const t0 = Date.now();
  // the trigger is the behaviour phase actually starting: the probe's debug line for its first (a11y) unit — never a fixed delay
  const pFrz = spawn(process.execPath, [PROBE, "--expected", EXP, "--url", url(), "--out", out("Frozen"), "--max-time", "40000", "--project", projBare], { cwd: projBare, env: { ...process.env, DT_BEHAVIOUR_DEBUG: "1" } });
  let errFrz = "";
  const exited = new Promise<number | null>((r) => pFrz.on("close", (c) => r(c)));
  pFrz.stderr.on("data", (d: Buffer) => {
    errFrz += d.toString();
    if (frozen.length || !/\[behaviour\] a11y/.test(errFrz)) return;
    const kids = String(spawnSync("pgrep", ["-P", String(pFrz.pid ?? 0)], { encoding: "utf8" }).stdout || "").split("\n").map(Number).filter((n) => n > 0);
    for (const k of kids) { try { process.kill(k, "SIGSTOP"); frozen.push(k); } catch { /* gone */ } }
  });
  const code = await exited;
  const ms = Date.now() - t0;
  for (const k of frozen) { try { process.kill(k, "SIGKILL"); } catch { /* the probe killed it */ } }
  const mFrz = read(projBare, out("Frozen"));
  if (code !== 0) console.log(errFrz.slice(-600));
  check(`the browser SIGSTOPped once the behaviour units run (after the a11y unit), --max-time 40 s → exit 0 in < 40 s with measured.json + PNG written (nodes measured, behaviour cut) — ${Math.round(ms / 1000)} s`,
    frozen.length > 0 && code === 0 && ms < 40_000 && mFrz !== null && (mFrz.nodes || []).length > 0 && fs.existsSync(path.join(projBare, out("Frozen") + ".png")) && mFrz.behaviour?.ran === true && mFrz.behaviour.cut);
}

// ================================================================ never exit 4 (a page whose Tab handler never yields)
const r6 = await P.r6;
const m6 = read(projBare, out("Spin"));
if (r6.status !== 0) console.log(r6.stderr);
check("a Tab handler that never yields, --max-time 40 s → exit 0 within the bound, measured.json written, behaviour.cut, the walk's checks not-run 'time budget'",
  r6.status === 0 && r6.ms < 40_000 && m6?.behaviour?.ran === true && m6.behaviour.cut && statusOf(m6, "keyboard.reachable") === "not-run" && /time budget/.test(row(m6, "keyboard.reachable")?.detail ?? ""));

// per run above; and no run wrote at all — the battery adds 0 (and no fixture has a write the unblocked drive could make)
check(`across every run the server received no write and no WebSocket message (saw: ${writes.join(", ") || "none"})`, mutations === 0 && writes.length === 0);

finish();
report();
