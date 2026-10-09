// End-to-end tests for the shipped web probe: the BUILT claude-plugin/scripts/verify-probe.js,
// run in a real chromium against static pages served by node:http, measuring an expectation written by the
// real `verify-screen --expect` from a real-shaped screen export (test/fixtures/probe, invented names).
//
// this needs the repo's own devDependency `playwright` and its chromium. Locally, when the renderer is
// unavailable (the probe exits 3), the suite prints SKIPPED and passes; in CI (CI=true) that is a failure.
// Run with:  node test/verify-probe-e2e.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { isVerifyMeasured } from "../design-to-code/doc-guards.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { STYLE_KEYS } from "../design-to-code/verify-screen.ts";
import { liveStatusFile, stageDirOf, writeStatus } from "../design-to-code/verify-run.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { freeHoverPoint } from "../design-to-code/probe-page.ts";
import type { MeasuredNode, VerifyMeasured, VerifySpec } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const ROOT = path.join(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-e2e-"));
fs.writeFileSync(path.join(tmp, "asset.js"), "window.__plotsBuild = 1;\n");

// ---- a static server on an ephemeral port (no dev server: nothing here reloads unless the page asks to)
// (asset.js is served from the temp dir so a test can change the build; /@vite/client stands in for a
// dev server; every page request records what the run's LIVE status said at that moment, and the state of the
// project tree outside node_modules — nothing may be written there while the page is connected)
const pageSeen: Array<{ status: string | null; tree: string }> = [];
let statusWatch: { live: string; project: string } | null = null;
// M-a: runs once when the next page is requested (the probe's `measuring` write is done by then)
let onPage: (() => void) | null = null;
function treeState(root: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); out.push(`${path.relative(root, f)} ${st.mtimeMs} ${st.size}`); }
    }
  };
  walk(root);
  return out.sort().join("\n");
}
// with ?hold=1 the SECOND request of a URL (the page's own reload) gets everything but </body> at once and the rest
// 3 s later — the re-run's goto cuts that load short, and its response body never settles in Playwright
const holdSeen = new Map<string, number>();
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  if (pathname === "/asset.js" || pathname === "/@vite/client") {
    const body = pathname === "/asset.js" && fs.existsSync(path.join(tmp, "asset.js")) ? fs.readFileSync(path.join(tmp, "asset.js")) : "/* vite client stand-in */";
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
    return;
  }
  // a document whose body never ends; it moves on by itself after 300 ms (closed by finish())
  if (pathname === "/held-page.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.write("<!doctype html><p>loading</p><script>setTimeout(() => location.replace(\"/staff-directory.html?mode=held-doc-done\"), 300)</script>");
    return;
  }
  // a page that renders, then sends itself to a server that never answers and cancels that with
  // window.stop() (an image that never loads keeps its load from firing); a 204; a download
  if (pathname === "/hang.png" || pathname === "/hangdoc") return; // never answered (closed by finish())
  if (pathname === "/abort-self.html") {
    const html = fs.readFileSync(path.join(FIX, "staff-directory.html"), "utf8");
    const extra = "<img src=\"/hang.png\" alt=\"\"><script>setTimeout(() => { location.href = \"/hangdoc\"; setTimeout(() => window.stop(), 300); }, 300)</script>";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html.replace("</body>", extra + "</body>"));
    return;
  }
  if (pathname === "/no-content") { res.writeHead(204); res.end(); return; }
  if (pathname === "/download") { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=x.bin" }); res.end("x"); return; }
  const name = path.basename(pathname);
  if (onPage !== null) { const f = onPage; onPage = null; f(); }
  if (statusWatch !== null) pageSeen.push({ status: fs.existsSync(statusWatch.live) ? fs.readFileSync(statusWatch.live, "utf8") : null, tree: treeState(statusWatch.project) });
  const file = path.join(FIX, name);
  if (!name.endsWith(".html") || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  const html = fs.readFileSync(file, "utf8");
  const n = (holdSeen.get(req.url || "") ?? 0) + 1;
  holdSeen.set(req.url || "", n);
  const cut = html.indexOf("</body>");
  if (new URL(req.url || "/", "http://x").searchParams.get("hold") === "1" && n === 2 && cut > 0) {
    res.write(html.slice(0, cut));
    setTimeout(() => res.end(html.slice(cut)), 3000).unref();
    return;
  }
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/staff-directory.html${mode ? `?mode=${mode}` : ""}`;

// async spawn: the server above lives in THIS process, so a spawnSync would block it from answering
interface Run { status: number | null; stdout: string; stderr: string }
// These runs check measuring, not behaviour — `--behaviour off` keeps them fast (test/verify-probe-behaviour-e2e.test.ts
// runs the behaviour checks)
const behaviourOff = (args: string[]): string[] => (args.includes("--check") || args.includes("--behaviour") ? args : [...args, "--behaviour", "off"]);
const probe = (args: string[]): Promise<Run> => new Promise((resolve) => {
  const p = spawn(process.execPath, [BUNDLE, ...behaviourOff(args)], { cwd: tmp });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});
const finish = (): void => { server.closeAllConnections(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };

// ---- the expectation, from the real --expect
const exp = spawnSync(process.execPath, [path.join(ROOT, "design-to-code", "verify-screen.ts"), "--expect", path.join(FIX, "staff-directory.json"), "--out", path.join(tmp, "Staff")], { encoding: "utf8" });
const expected = path.join(tmp, "Staff.expected.json");
if (exp.status !== 0 || !fs.existsSync(expected)) { check("verify-screen --expect wrote the expectation", false); finish(); report(); }

console.log("verify-probe e2e — the built bundle in a real chromium:");
const pre = await probe(["--check", "--project", ROOT]);
if (pre.status === 3) {
  const reason = pre.stderr.split("\n")[0] || "renderer unavailable";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); finish(); process.exit(0); }
  check(`the renderer is available in CI — ${reason}`, false);
  finish();
  report();
}
check("--check resolves the repo's playwright and launches chromium (exit 0)", pre.status === 0 && /^ok {2}playwright /.test(pre.stdout));

const read = (base: string): VerifyMeasured | null => readJsonOrNull(base + ".measured.json", isVerifyMeasured);
const node = (m: VerifyMeasured | null, id: string): MeasuredNode | undefined => (m?.nodes || []).find((n) => n.nodeId === id);
const styleOf = (n: MeasuredNode | undefined, k: string): unknown => (n && n.styles ? n.styles[k] : undefined);

// ---- the main page: measuring, identity
const base = path.join(tmp, "run1", "Staff");
const r1 = await probe(["--expected", expected, "--url", url(), "--out", base, "--project", ROOT]);
const m1 = read(base);
check("a clean page → exit 0, measured.json (a valid VerifyMeasured) and the screenshot written", r1.status === 0 && m1 !== null && fs.existsSync(base + ".png"));
if (r1.status !== 0) console.log(r1.stderr);

const nav3 = node(m1, "50:3");
check("'Shift Planner' (also a page <h1> and a closed dialog's <h2>) → the sidebar <button>, matchedBy text", nav3?.matchedBy === "text" && styleOf(nav3, "tag") === "button" && styleOf(nav3, "fontSize") === 12 && /button:nth-child\(1\)$/.test(nav3.selector || ""));
check("an untagged container with no text → notMeasured 'tag it', not a guess", (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === "50:2" && typeof n.why === "string" && /tag it/.test(n.why)));

check("transparent <body>, painted #root > div → frame.via size-and-fill on that div", m1?.frame?.via === "size-and-fill" && m1.frame.selector === "html > body:nth-child(2) > div:nth-child(2) > div:nth-child(1)");
check("the frame's own spec is measured on it (matchedBy frame, its paint, x/y 0)", node(m1, "50:1")?.matchedBy === "frame" && styleOf(node(m1, "50:1"), "backgroundColor") === "rgb(29, 29, 31)" && styleOf(node(m1, "50:1"), "x") === 0);

const btn = node(m1, "50:4");
const tb = styleOf(btn, "textBox");
check("TEXT id on a 188×32 weight-500 <button> → typography from the inner <span> (textFrom span, fontWeight 400)", btn?.textFrom === "span" && styleOf(btn, "fontWeight") === 400 && styleOf(btn, "width") === 188 && btn.textFromMixed === undefined);
check("textBox {x, w} is the text run's, frame-relative", isJsonObject(tb) && typeof tb.x === "number" && typeof tb.w === "number" && tb.w > 30 && tb.w < 188);

const everyKey = (m1?.nodes || []).every((n) => STYLE_KEYS.every((k) => n.styles !== undefined && k in n.styles && (n.styles[k] !== null || typeof (n.unmeasured || {})[k] === "string")));
check("every STYLE_KEY on every node; every null has a reason", (m1?.nodes || []).length > 0 && everyKey);
check("inline SVG path fill read (fillSource svg)", styleOf(node(m1, "50:5"), "fill") === "rgb(255, 136, 0)" && node(m1, "50:5")?.fillSource === "svg");
check("<img> spec → fill null, fillSource img, with the reason", styleOf(node(m1, "50:6"), "fill") === null && node(m1, "50:6")?.fillSource === "img" && /<img>/.test((node(m1, "50:6")?.unmeasured || {}).fill || ""));

const row = node(m1, "50:7");
const hov = row?.states?.hover;
const hovStyles = hov && isJsonObject(hov) && isJsonObject(hov.styles) ? hov.styles : null;
check("a spec drawn hovered → states.hover measured with the hover paint; rest keeps the resting paint", styleOf(row, "backgroundColor") === "rgb(18, 19, 25)" && hovStyles?.backgroundColor === "rgb(70, 70, 79)");

const edit = node(m1, "50:11");
const editHover = edit?.states?.hover;
const editHov = editHover && isJsonObject(editHover) && isJsonObject(editHover.styles) ? editHover.styles : null;
check("hover-only content that is display:none at rest → matched by tag, revealed by hovering its tagged row, measured in states.hover", edit?.matchedBy === "tag"
  && styleOf(edit, "width") === 0 && editHov?.width === 40 && editHov.backgroundColor === "rgb(10, 132, 255)");
const search = node(m1, "50:12");
const foc = search?.states?.focus;
const focStyles = foc && isJsonObject(foc) && isJsonObject(foc.styles) ? foc.styles : null;
check("a focus spec on a focusable <input> → focused from the keyboard (focusVia keyboard), :focus-visible paint in states.focus", search?.focusVia === "keyboard"
  && styleOf(search, "backgroundColor") === "rgb(18, 19, 25)" && focStyles?.backgroundColor === "rgb(44, 44, 52)");
const card = node(m1, "50:13");
check("a focus spec on a non-focusable <div> → no states.focus (its resting styles are not recorded as focus), a note says why", card !== undefined && card.states === undefined && /not focusable/.test(card.note || ""));
check("the same date designed in two tagged rows, built only in the first → the first row's date is its spec's; the second is notMeasured 'not inside', never the first row's cell",
  node(m1, "50:15")?.matchedBy === "text" && node(m1, "50:17") === undefined
  && (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === "50:17" && typeof n.why === "string" && /not inside data-dt-node="50:16"/.test(n.why)));
const ph = node(m1, "50:18");
check("an input placeholder shares the tagged <input> with the field's spec; its null textBox says 'input placeholder', not 'not a TEXT node'", ph?.matchedBy === "text"
  && styleOf(ph, "placeholderText") === "Find staff" && styleOf(ph, "placeholderColor") === "rgb(138, 138, 138)" && /input placeholder/.test((ph.unmeasured || {}).textBox || ""));
const rowHov = row?.states?.hover;
check("states.hover keeps nulls with their reasons (a value not read in the state is not the resting one)", isJsonObject(rowHov) && isJsonObject(rowHov.styles) && rowHov.styles.fill === null
  && isJsonObject(rowHov.unmeasured) && typeof rowHov.unmeasured.fill === "string");
const notePh = node(m1, "50:23");
check("a placeholder nested under its tagged field frame is measured on that field's <input> (its own tag counts as inside)", notePh?.matchedBy === "text" && styleOf(notePh, "placeholderText") === "Add a note");
const lbl = node(m1, "50:25");
check("a label written straight into its tagged <button> shares it: typography from the button, box null with the reason", lbl?.matchedBy === "text" && lbl.textFrom === "button"
  && styleOf(lbl, "fontSize") === 13 && styleOf(lbl, "width") === null && /shares the element of data-dt-node="50:24"/.test((lbl.unmeasured || {}).width || "") && node(m1, "50:24")?.matchedBy === "tag");
const refTb = styleOf(node(m1, "50:27"), "textBox");
const textOnlyWidth = isJsonObject(refTb) && typeof refTb.w === "number" ? refTb.w : -100;
const ltb = styleOf(lbl, "textBox");
check("the shared label's textBox covers its own text node, not the icon beside it (w within 1px of the text's own width, x after the icon)",
  isJsonObject(ltb) && typeof ltb.w === "number" && typeof ltb.x === "number" && Math.abs(ltb.w - textOnlyWidth) <= 1 && ltb.x > 12);
const glyph = node(m1, "50:26");
const gf = glyph?.states?.focus;
check("a focus spec on a non-focusable <span> inside a <button> focuses the button (closest), from the keyboard", glyph?.focusVia === "keyboard"
  && isJsonObject(gf) && isJsonObject(gf.styles) && gf.styles.backgroundColor === "rgb(255, 204, 0)");
const twin = (id: string): boolean => (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === id && typeof n.why === "string" && /matched for 2 specs/.test(n.why));
check("'Open shifts' and 'open shifts' both land on the one <p> (exact / case-insensitive): claimOnce keeps it from both", twin("50:20") && twin("50:21"));
const paths = (m1?.nodes || []).filter((n) => !["50:18", "50:23", "50:25"].includes(n.nodeId)).map((n) => n.selector);
check("no element is claimed by two specs", new Set(paths).size === paths.length);

const sha = crypto.createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
const pwVersion = readJsonOrNull(path.join(ROOT, "node_modules", "playwright", "package.json"), isJsonObject)?.version;
const pluginVersion = readJsonOrNull(path.join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"), isJsonObject)?.version;
check("probe identity: sha256 of the bundle bytes, plugin version, the installed playwright, the browser version", m1?.probe?.sha256 === sha && m1.probe.version === pluginVersion
  && m1.probe.playwright.package === "playwright" && m1.probe.playwright.version === pwVersion && m1.probe.browser.name === "chromium" && m1.probe.browser.version.length > 0);
const c = m1?.matchedByCensus || {};
check("matchedByCensus counts every spec once (tag + text + frame + notMeasured = specs)", (c.tag ?? 0) + (c.sharedPath ?? 0) + (c.text ?? 0) + (c.textOrdinal ?? 0) + (c.position ?? 0) + (c.frame ?? 0) + (c.notMeasured ?? 0) === 25 && c.notMeasured === 4);
check("a quiet page: no navigation after the initial load, no re-run", m1?.navigation?.afterInitialLoad === 0 && m1.navigation.reruns === 0);

// ---- reloads
const allTagged = (m: VerifyMeasured | null): boolean => ["50:4", "50:5", "50:6", "50:7", "50:12", "50:14"].every((id) => node(m, id)?.matchedBy === "tag");
const b2 = path.join(tmp, "run2", "Staff");
const r2 = await probe(["--expected", expected, "--url", url("reload-once"), "--out", b2, "--project", ROOT]);
const m2 = read(b2);
check("the page reloads once 200ms after load → absorbed by the readiness wait: exit 0, afterInitialLoad 1, every tagged spec resolved", r2.status === 0 && m2?.navigation?.afterInitialLoad === 1 && m2.navigation.reruns === 0 && allTagged(m2));

const b3 = path.join(tmp, "run3", "Staff");
const r3 = await probe(["--expected", expected, "--url", url("reload-on-first-hover"), "--out", b3, "--project", ROOT]);
const m3 = read(b3);
// (this check is timing-sensitive — print what the probe said when it fails)
if (!(r3.status === 0 && m3?.navigation?.reruns === 1 && allTagged(m3))) console.log(`first-hover reload run: exit ${r3.status}, reruns ${m3?.navigation?.reruns ?? "-"}\n${r3.stderr}`);
check("a reload DURING measurement (first hover) → one full re-run: exit 0, reruns 1, every tagged spec resolved", r3.status === 0 && m3?.navigation?.reruns === 1 && allTagged(m3));

// the same, but the reload's response holds its last bytes for 3 s — the re-run's goto aborts it mid-body. The probe
// waits only for its current pass's bodies, and at most 2 s: exit 0 well inside --max-time (not the --max-time exit 4)
const b3h = path.join(tmp, "run3h", "Staff");
const t3h = Date.now();
const r3h = await probe(["--expected", expected, "--url", `${url("reload-on-first-hover")}&hold=1`, "--out", b3h, "--project", ROOT, "--max-time", "30000"]);
const took3h = Date.now() - t3h;
const m3h = read(b3h);
if (r3h.status !== 0) console.log(`held-reload run: exit ${r3h.status} after ${took3h} ms\n${r3h.stderr}`);
check(`a reload during measurement whose response body never completes (aborted by the re-run's goto) → exit 0 in ${Math.round(took3h / 1000)} s (< 20 s, --max-time 30 s), reruns 1, every tagged spec resolved`,
  r3h.status === 0 && took3h < 20_000 && m3h?.navigation?.reruns === 1 && allTagged(m3h));

// a document response cut short by the page's own next navigation IN the measured pass — its body never settles;
// the wait for the pass's bodies is bounded (2 s) and the unread one is named in a note (no hang until --max-time, exit 4)
const b3s = path.join(tmp, "run3s", "Staff");
const t3s = Date.now();
const r3s = await probe(["--expected", expected, "--url", url("held-doc"), "--out", b3s, "--project", ROOT, "--max-time", "30000"]);
const took3s = Date.now() - t3s;
const m3s = read(b3s);
if (r3s.status !== 0) console.log(`held-document run: exit ${r3s.status} after ${took3s} ms ${JSON.stringify(m3s?.navigation)} ${JSON.stringify(m3s?.notes)}\n${r3s.stderr}`);
check(`a same-pass document load cut short by the next navigation → exit 0 in ${Math.round(took3s / 1000)} s (< 20 s), re-runs 0, the page it moved on to measured, a note naming the unread document`,
  r3s.status === 0 && took3s < 20_000 && m3s?.navigation?.reruns === 0 && allTagged(m3s)
  && (m3s.notes || []).some((n) => /^build identity: 1 same-origin response body\(ies\) not hashed — \/held-page\.html \(not received within 2 s/.test(n)));

const b4 = path.join(tmp, "run4", "Staff");
const r4 = await probe(["--expected", expected, "--url", url("reload-on-every-hover"), "--out", b4, "--project", ROOT]);
check("reloaded during measurement twice → exit 4, nothing written, the watch-tree hint and the navigation log printed", r4.status === 4 && !fs.existsSync(b4 + ".measured.json") && !fs.existsSync(b4 + ".png")
  && /watch tree/.test(r4.stderr) && /navigation log/.test(r4.stderr));

const b5 = path.join(tmp, "run5", "Staff");
const r5 = await probe(["--expected", expected, "--url", url("reload-forever"), "--out", b5, "--project", ROOT, "--timeout", "2500"]);
check("a page that keeps reloading after load → exit 4, nothing written", r5.status === 4 && !fs.existsSync(b5 + ".measured.json") && /kept navigating/.test(r5.stderr));

const b6 = path.join(tmp, "run6", "Staff");
const r6 = await probe(["--expected", expected, "--url", `http://127.0.0.1:${port}/missing.html`, "--out", b6, "--project", ROOT, "--ready", "#never", "--timeout", "1500"]);
check("--ready never visible → exit 4, nothing written", r6.status === 4 && !fs.existsSync(b6 + ".measured.json"));

// ---- watchdog, --run status, build identity
const b7 = path.join(tmp, "run7", "Staff");
const t7 = Date.now();
const r7 = await probe(["--expected", expected, "--url", url("busy"), "--out", b7, "--project", ROOT, "--max-time", "4000"]);
const took7 = Date.now() - t7;
check(`a page whose script never yields + --max-time 4000 → exit 4 within ~8 s (took ${took7} ms), nothing written, says --max-time`,
  r7.status === 4 && took7 < 12_000 && !fs.existsSync(b7 + ".measured.json") && !fs.existsSync(b7 + ".png") && /--max-time/.test(r7.stderr) && /nothing written/.test(r7.stderr));
if (r7.status !== 4) console.log(r7.stderr);
check("--max-time must be a positive number → exit 2", (await probe(["--expected", expected, "--url", url(), "--max-time", "0"])).status === 2);

// --run: the status of the expectation's verify dir, written LIVE in the run cache (a consumer project: package.json +
// node_modules beside design/verify); --out elsewhere (a staging dir) holds the files
const projDir = path.join(tmp, "app");
const vdir = path.join(projDir, "design", "verify");
fs.mkdirSync(vdir, { recursive: true });
fs.mkdirSync(path.join(projDir, "node_modules"));
fs.writeFileSync(path.join(projDir, "package.json"), "{\"name\":\"staff-app\",\"private\":true}\n");
fs.copyFileSync(expected, path.join(vdir, "Staff.expected.json"));
const liveFile = liveStatusFile(path.join(vdir, "Staff"));
const stage = path.join(tmp, "stage", "Staff");
const treeBefore = treeState(projDir);
statusWatch = { live: liveFile, project: projDir };
const r8 = await probe(["--expected", path.join(vdir, "Staff.expected.json"), "--url", url(), "--out", stage, "--project", ROOT, "--run", "run-e2e-1"]);
statusWatch = null;
const readStatus = (f: string): { phase?: unknown; rev?: unknown; runId?: unknown; measuredSha256?: unknown; by?: unknown } | null => readJsonOrNull(f, isJsonObject);
const seenStatus = pageSeen.map((p) => (p.status === null ? null : ((): unknown => { try { const v: unknown = JSON.parse(p.status); return v; } catch { return null; } })()));
check("with --run, every page request saw the live status the probe wrote BEFORE launch (measuring, rev 1) in node_modules/.cache/designtwin-verify/",
  r8.status === 0 && pageSeen.length > 0 && liveFile.includes(path.join("node_modules", ".cache", "designtwin-verify")) && seenStatus.every((v) => isJsonObject(v) && v.phase === "measuring" && v.rev === 1 && v.runId === "run-e2e-1"));
check("while the page was connected, nothing in the project tree (outside node_modules) was created or modified",
  pageSeen.length > 0 && pageSeen.every((p) => p.tree === treeBefore) && !fs.existsSync(path.join(vdir, "Staff.status.json")));
const st8 = readStatus(liveFile);
const m8 = read(stage);
check("after close: status `measured` rev 2 by verify-probe, measuredSha256 = sha256 of the measured file; measured.runId = the run",
  st8?.phase === "measured" && st8.rev === 2 && st8.by === "verify-probe" && st8.runId === "run-e2e-1" && fs.existsSync(stage + ".measured.json")
  && st8.measuredSha256 === crypto.createHash("sha256").update(fs.readFileSync(stage + ".measured.json")).digest("hex") && m8?.runId === "run-e2e-1");
check("the status is the verify dir's (live, run cache), not in the --out staging dir, and not in design/verify until done; no tmp files left", !fs.existsSync(stage + ".status.json") && treeState(projDir) === treeBefore && fs.existsSync(path.dirname(stage)) && !fs.readdirSync(path.dirname(stage)).some((f) => f.includes(".tmp-")));

// M-a: the run cache turns read-only while the page is measured — the `measured` status write is refused: the
// measured file stays, exit 0, and a warning names the --status command that records it
const cache10 = path.dirname(liveFile);
const stage10 = path.join(tmp, "stage10", "Staff");
onPage = () => fs.chmodSync(cache10, 0o555);
const r10 = await probe(["--expected", path.join(vdir, "Staff.expected.json"), "--url", url(), "--out", stage10, "--project", ROOT, "--run", "run-e2e-10"]);
onPage = null;
fs.chmodSync(cache10, 0o755);
const st10 = readStatus(liveFile);
check("a refused post-measure status write → exit 0, the measured file stays, a warning naming the cache and `--status Staff --phase measured --run run-e2e-10`, no stack",
  r10.status === 0 && fs.existsSync(stage10 + ".measured.json") && /warning {2}run cache \S+ is not writable \(sandbox write scope\?\)/.test(r10.stderr)
  && /--status Staff --phase measured --run run-e2e-10 --dir /.test(r10.stderr) && !/\n\s+at /.test(r10.stderr) && st10?.phase === "measuring" && st10.runId === "run-e2e-10");
if (r10.status !== 0) console.log(r10.stderr);
check("…the warning says which write was refused and that the live status still says measuring (compare: incomplete)",
  /the run cache refused the probe's `measured` status write for run run-e2e-10 — the live status still says measuring/.test(r10.stderr));

// the orchestrator ends the run while the page is measured → the probe writes no files, exits 2,
// and the ended status stays (no measured.json or PNG written, no exit 0, no "next --compare")
const stageA1 = path.join(tmp, "stageA1", "Staff");
onPage = () => writeStatus(path.join(vdir, "Staff"), { runId: "run-e2e-12", phase: "failed", by: "agent", detail: "gave up" });
const rA1 = await probe(["--expected", path.join(vdir, "Staff.expected.json"), "--url", url(), "--out", stageA1, "--project", ROOT, "--run", "run-e2e-12"]);
onPage = null;
const stA1 = readStatus(liveFile);
check("a run ended while the page is measured → exit 2, no measured file or screenshot, the failed status unchanged, no next step",
  rA1.status === 2 && !fs.existsSync(stageA1 + ".measured.json") && !fs.existsSync(stageA1 + ".png") && stA1?.phase === "failed" && stA1.runId === "run-e2e-12"
  && rA1.stderr.includes("run run-e2e-12 already ended at failed (gave up)") && !/^next /m.test(rA1.stderr));
if (rA1.status !== 2) console.log(rA1.stderr);

// a project whose path holds a space, and a run cache refusing every status write of the run (measuring
// too): the warning says no live status exists (compare: unrecorded); its recovery command and the `next` line
// run as printed; the recovery records the measured file's sha
const spaced = path.join(tmp, "staff app");
const svdir = path.join(spaced, "design", "verify");
fs.mkdirSync(svdir, { recursive: true });
fs.mkdirSync(path.join(spaced, "node_modules"));
fs.writeFileSync(path.join(spaced, "package.json"), "{\"name\":\"staff-app\",\"private\":true}\n");
fs.copyFileSync(expected, path.join(svdir, "Staff.expected.json"));
const sBase = path.join(svdir, "Staff");
const sLive = liveStatusFile(sBase);
const sStage = stageDirOf(sBase, "run-e2e-11");
fs.mkdirSync(sStage, { recursive: true });
fs.chmodSync(path.dirname(sLive), 0o555);
const r11 = await probe(["--expected", path.join(svdir, "Staff.expected.json"), "--url", url(), "--out", path.join(sStage, "Staff"), "--project", ROOT, "--run", "run-e2e-11"]);
fs.chmodSync(path.dirname(sLive), 0o755);
const recovery = /with: (node .*--phase measured --run run-e2e-11 --dir .*)$/m.exec(r11.stderr)?.[1] ?? "";
check("every status write refused → exit 0, the warning says no live status exists and --compare will report the run as unrecorded",
  r11.status === 0 && !fs.existsSync(sLive) && /no live status of the run exists, so --compare will report the run as unrecorded/.test(r11.stderr) && recovery !== "");
if (r11.status !== 0) console.log(r11.stderr);
const next11 = /^next {2}(.+)$/m.exec(r11.stderr)?.[1] ?? "";
const c11 = spawnSync("/bin/sh", ["-c", next11], { cwd: os.tmpdir(), encoding: "utf8" });
check("the printed `next` --compare runs as printed from another directory (paths with a space) → incomplete: 'no status of that run records it'",
  c11.status === 1 && /no status of that run records it/.test(fs.existsSync(path.join(sStage, "Staff.report.json")) ? fs.readFileSync(path.join(sStage, "Staff.report.json"), "utf8") : ""));
const rec11 = spawnSync("/bin/sh", ["-c", recovery], { cwd: os.tmpdir(), encoding: "utf8" });
const st11 = readStatus(sLive);
check("the printed recovery runs as printed → status measured, measuredSha256 = the staged measured file",
  rec11.status === 0 && st11?.phase === "measured" && st11.runId === "run-e2e-11" && st11.measuredSha256 === crypto.createHash("sha256").update(fs.readFileSync(path.join(sStage, "Staff.measured.json"))).digest("hex"));
if (rec11.status !== 0) console.log(rec11.stderr);

const bd = m1?.build;
check("measured.build: the url, mode static, same-origin assets hashed (document + asset.js), git state of the project", bd !== undefined && bd.url === url() && bd.mode === "static" && bd.assets === 2
  && /^[0-9a-f]{64}$/.test(bd.assetsSha256) && (bd.gitHead === null || /^[0-9a-f]{40}$/.test(bd.gitHead)) && (bd.gitDirty === null || typeof bd.gitDirty === "boolean"));
check("the same build served again → the same assetsSha256", m8?.build?.assetsSha256 !== undefined && m8.build.assetsSha256 === bd?.assetsSha256);
fs.writeFileSync(path.join(tmp, "asset.js"), "window.__plotsBuild = 2;\n");
const b9 = path.join(tmp, "run9", "Staff");
const r9 = await probe(["--expected", expected, "--url", url("vite"), "--out", b9, "--project", ROOT]);
const m9 = read(b9);
check("the fixture's JS changed → a different assetsSha256; /@vite/client served → mode vite-dev", r9.status === 0 && m9?.build !== undefined && m9.build.assetsSha256 !== bd?.assetsSha256 && m9.build.mode === "vite-dev");

// ---- a shared shell tagged with another screen's ids, foreign tags, display, rings
// (the expectation is written here: its `aliases` are what --expect derives from sibling exports of the same file)
const g11Nodes: VerifySpec[] = [
  { nodeId: "60:1", name: "Rota Settings", type: "FRAME" },
  { nodeId: "I60:5;8:1", name: "Top Bar", type: "INSTANCE", aliases: ["I71:9;3:4"] },
  { nodeId: "I60:5;8:2", name: "Twin", type: "FRAME", aliases: ["I71:9;3:5", "I72:1;3:5"] },
  { nodeId: "60:20", name: "Caption", type: "TEXT" },
  { nodeId: "60:21", name: "Caption Word", type: "TEXT" },
  { nodeId: "60:30", name: "Inset Ring", type: "FRAME" },
  { nodeId: "60:31", name: "Outer Ring", type: "FRAME" },
  { nodeId: "60:32", name: "Inside Outline", type: "FRAME" },
  { nodeId: "60:33", name: "Focus Rest", type: "FRAME" },
  { nodeId: "60:34", name: "Bordered", type: "FRAME" },
  { nodeId: "60:35", name: "Offset Ring", type: "FRAME" },
  { nodeId: "60:36", name: "Raised Card", type: "FRAME" },
  { nodeId: "60:37", name: "Ringed Card", type: "FRAME" },
  { nodeId: "60:38", name: "Glow", type: "FRAME" },
  { nodeId: "60:39", name: "Soft Card", type: "FRAME" },
  { nodeId: "60:40", name: "Hard Shadow", type: "FRAME" },
];
const g11Exp = path.join(tmp, "Rota.expected.json");
fs.writeFileSync(g11Exp, JSON.stringify({ frame: { nodeId: "60:1", name: "Rota Settings", w: 800, h: 600 }, nodes: g11Nodes }));
const b12 = path.join(tmp, "run12", "Rota");
const r12 = await probe(["--expected", g11Exp, "--url", `http://127.0.0.1:${port}/shell-rings.html`, "--out", b12, "--project", ROOT]);
const m12 = read(b12);
if (r12.status !== 0) console.log(r12.stderr);
const shellNode = node(m12, "I60:5;8:1");
check("a shell tagged with another screen's id for this node → matchedBy tag-alias on that <nav>, census tagAlias 1",
  r12.status === 0 && shellNode?.matchedBy === "tag-alias" && shellNode.selector === '[data-dt-node="I71:9;3:4"]' && styleOf(shellNode, "tag") === "nav" && styleOf(shellNode, "height") === 48
  && m12?.matchedByCensus?.tagAlias === 1);
check("two visible elements carry a spec's aliases → notMeasured 'ambiguous', not a guess", node(m12, "I60:5;8:2") === undefined
  && (m12?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === "I60:5;8:2" && typeof n.why === "string" && /^ambiguous: 2 visible elements/.test(n.why)));
check("tagsNotInExpectation: every visible foreign tag (alias, stale prefix, a tag on 2 elements), sorted; hidden and frame ids left out",
  JSON.stringify(m12?.tagsNotInExpectation) === JSON.stringify({ count: 5, ids: [{ id: "88:2", elements: 2 }, { id: "I71:9;3:4", elements: 1 }, { id: "I71:9;3:5", elements: 1 }, { id: "I72:1;3:5", elements: 1 }, { id: "I99:9;7:7", elements: 1 }] }));
check("… and the probe says so on stderr", /note {2}5 data-dt-node value\(s\) on visible elements are not in the expectation \(e\.g\. 88:2, I71:9;3:4/.test(r12.stderr));
check("display on every node: <p> block, its inner <span> inline, the shell <nav> flex",
  styleOf(node(m12, "60:20"), "display") === "block" && styleOf(node(m12, "60:21"), "display") === "inline" && styleOf(shellNode, "display") === "flex"
  && (m12?.nodes || []).every((n) => typeof styleOf(n, "display") === "string"));
const ring30 = node(m12, "60:30"), ring31 = node(m12, "60:31"), out32 = node(m12, "60:32"), rest33 = node(m12, "60:33"), bord34 = node(m12, "60:34");
const greyCol = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(String(styleOf(ring30, "borderColor")));
check("Tailwind `ring-1 ring-inset` (oklch colour, the 4th of five shadows) → borderWidth 1, rgb grey, strokeFrom box-shadow, inside",
  styleOf(ring30, "borderWidth") === 1 && greyCol !== null && greyCol[1] === greyCol[2] && greyCol[2] === greyCol[3] && Number(greyCol[1]) > 150 && styleOf(ring30, "strokeFrom") === "box-shadow" && styleOf(ring30, "strokeAlign") === "inside");
check("`ring-2` without inset → borderWidth 2, its colour, outside", styleOf(ring31, "borderWidth") === 2 && styleOf(ring31, "borderColor") === "rgb(10, 132, 255)" && styleOf(ring31, "strokeAlign") === "outside");
check("`outline 1px` at offset -1px → borderWidth 1, outline colour, strokeFrom outline, inside",
  styleOf(out32, "borderWidth") === 1 && styleOf(out32, "borderColor") === "rgb(118, 118, 128)" && styleOf(out32, "strokeFrom") === "outline" && styleOf(out32, "strokeAlign") === "inside");
check("a transparent resting focus outline (offset 2px) is no stroke: borderWidth 0, borderColor null, no strokeFrom",
  styleOf(rest33, "borderWidth") === 0 && styleOf(rest33, "borderColor") === null && styleOf(rest33, "strokeFrom") === undefined);
const noStroke = (n: MeasuredNode | undefined): boolean => n !== undefined && styleOf(n, "borderWidth") === 0 && styleOf(n, "borderColor") === null && styleOf(n, "strokeFrom") === undefined;
check("two OUTER rings (`ring-2 ring-offset-2`: a white offset ring + the ring) → ambiguous, nothing read", noStroke(node(m12, "60:35")));
check("a decorative shadow (`shadow-md`: offsets, blur, negative spread) is no stroke", noStroke(node(m12, "60:36")));
check("a glow (`0 0 8px 2px`: no offset, blur > 0, spread > 0) is no stroke", noStroke(node(m12, "60:38")));
check("a single decorative shadow (`shadow-xs`: one entry, offset + blur) is no stroke", noStroke(node(m12, "60:39")));
check("a hard offset shadow (`4px 4px 0 1px`: blur 0, spread > 0, offset) is no stroke", noStroke(node(m12, "60:40")));
const ringed = node(m12, "60:37");
check("`ring-1` + `shadow-md` together → the ring is read (1, its colour, outside), the shadows ignored",
  styleOf(ringed, "borderWidth") === 1 && styleOf(ringed, "borderColor") === "rgb(10, 132, 255)" && styleOf(ringed, "strokeFrom") === "box-shadow" && styleOf(ringed, "strokeAlign") === "outside");
check("a real border beside a ring → the border (strokeFrom border, no strokeAlign)",
  styleOf(bord34, "borderWidth") === 1 && styleOf(bord34, "borderColor") === "rgb(5, 5, 5)" && styleOf(bord34, "strokeFrom") === "border" && styleOf(bord34, "strokeAlign") === undefined);

// ---- whose drawn state is hovered and who paints, text-transform, --browser-path
// The expectation is written here (drawnStateFrom: the node whose state a spec inherits, as --expect writes it).
const g17Nodes: VerifySpec[] = [
  { nodeId: "70:1", name: "Loom Queue", type: "FRAME", backgroundColor: "#121319ff" },
  { nodeId: "70:3", name: "Spool Row", type: "FRAME", backgroundColor: "#46464fff", drawnState: "hover", ancestorIds: ["70:2"] },
  // own state: a transparent <td>, the row paints it under tr:hover
  { nodeId: "70:4", name: "Spool Cell", type: "FRAME", backgroundColor: "#46464fff", drawnState: "hover", ancestorIds: ["70:3", "70:2"] },
  { nodeId: "70:5", name: "Action Cell", type: "FRAME", backgroundColor: "#46464fff", drawnState: "hover", drawnStateFrom: "70:3", ancestorIds: ["70:3", "70:2"] },
  { nodeId: "70:6", name: "Remove", type: "INSTANCE", backgroundColor: "#292931ff", drawnState: "hover", drawnStateFrom: "70:3", ancestorIds: ["70:5", "70:3", "70:2"] },
  // an expectation written before drawnStateFrom: the control is hovered itself, as before
  { nodeId: "70:21", name: "Remove", type: "INSTANCE", backgroundColor: "#292931ff", drawnState: "hover", ancestorIds: ["70:20", "70:2"] },
  { nodeId: "70:8", name: "Swatch", type: "FRAME", backgroundColor: "#2c2c34ff" },
  { nodeId: "70:11", name: "Queue Button", type: "INSTANCE", backgroundColor: "#292931ff", drawnState: "hover", drawnStateFrom: "70:10", ancestorIds: ["70:10"] },
  // the owner (70:99) is not built/tagged: the tagged ancestor below it (the card) is hovered
  { nodeId: "70:13", name: "Open Link", type: "TEXT", text: "Open", color: "#c8c8c8ff", drawnState: "hover", drawnStateFrom: "70:99", ancestorIds: ["70:12", "70:99"] },
  { nodeId: "70:30", name: "Order Label", type: "TEXT", text: "spool order", textCase: "title" },
  { nodeId: "70:31", name: "Count Label", type: "TEXT", text: "bobbin count", drawnState: "hover", drawnStateFrom: "70:98", ancestorIds: ["70:98"] },
  // the owner (70:40) is untagged; the nearest tagged ancestor is a same-box <span> (no free point),
  // the next (the strip) has room
  { nodeId: "70:44", name: "Run", type: "INSTANCE", backgroundColor: "#292931ff", drawnState: "hover", drawnStateFrom: "70:40", ancestorIds: ["70:43", "70:42", "70:40"] },
  // an ARIA-grid row whose cells carry tabindex="-1"
  { nodeId: "70:51", name: "Remove", type: "INSTANCE", backgroundColor: "#292931ff", drawnState: "hover", drawnStateFrom: "70:50", ancestorIds: ["70:50"] },
  // a transparent box its own two children paint all over
  { nodeId: "70:80", name: "Split Swatch", type: "FRAME", backgroundColor: "#3c3c3cff" },
];
const g17Exp = path.join(tmp, "Loom.expected.json");
fs.writeFileSync(g17Exp, JSON.stringify({ frame: { nodeId: "70:1", name: "Loom Queue", w: 800, h: 600 }, nodes: g17Nodes }));
// an executable to name — Playwright's own chromium when it is installed, else the headless shell of the same revision
// in the same cache (a machine may hold only that). Never downloaded; none found → the --browser-path checks are skipped (printed).
const pwChromium = await import("playwright").then((m) => m.chromium, () => null);
function cachedBrowser(): string | null {
  if (!pwChromium) return null;
  const full = pwChromium.executablePath();
  if (fs.existsSync(full)) return full;
  let d = full;
  while (d !== path.dirname(d) && !/^chromium-\d+$/.test(path.basename(d))) d = path.dirname(d);
  const shell = path.join(path.dirname(d), path.basename(d).replace(/^chromium-/, "chromium_headless_shell-"));
  if (!/^chromium-\d+$/.test(path.basename(d)) || !fs.existsSync(shell)) return null;
  for (const plat of fs.readdirSync(shell)) {
    for (const bin of ["chrome-headless-shell", "headless_shell", "chrome-headless-shell.exe"]) {
      const p = path.join(shell, plat, bin);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}
const exe = cachedBrowser();
if (exe === null) console.log("SKIPPED the --browser-path checks: no installed chromium or headless shell found in Playwright's cache");
const b17 = path.join(tmp, "run17", "Loom");
const r17 = await probe(["--expected", g17Exp, "--url", `http://127.0.0.1:${port}/loom-queue-owner-hover.html`, "--out", b17, "--project", ROOT, ...(exe !== null ? ["--browser-path", exe] : [])]);
const m17 = read(b17);
if (r17.status !== 0) console.log(r17.stderr);
const stateStyles = (n: MeasuredNode | undefined, s: string): Record<string, unknown> | null => { const v = n?.states?.[s]; return v && isJsonObject(v) && isJsonObject(v.styles) ? v.styles : null; };
const hoverVia = (n: MeasuredNode | undefined): string => (n && typeof n.hoverVia === "string" ? n.hoverVia : "");
const ROW1 = /> tr:nth-child\(1\)$/;
const cell4 = node(m17, "70:4"), cell5 = node(m17, "70:5"), remove = node(m17, "70:6"), oldRemove = node(m17, "70:21");
check("own hover on a transparent <td>: its own background stays transparent, states.hover.styles.paintedBy = the hovered row (tr, depth 1, its tag)",
  r17.status === 0 && stateStyles(cell4, "hover")?.backgroundColor === "rgba(0, 0, 0, 0)"
  && JSON.stringify(stateStyles(cell4, "hover")?.paintedBy) === JSON.stringify({ backgroundColor: "rgb(70, 70, 79)", via: "ancestor", tag: "tr", depth: 1, dt: "70:3" }));
check("…at rest the same cell is painted by the frame root (its nearest painting ancestor)",
  JSON.stringify(styleOf(cell4, "paintedBy")) === JSON.stringify({ backgroundColor: "rgb(18, 19, 25)", via: "ancestor", tag: "div", depth: 4, dt: "70:1" }));
check("a control inside the row drawn hovered (drawnStateFrom = the row) → the ROW is hovered at a free point (hoverVia = the row), the control's own :hover stays off (not red)",
  ROW1.test(hoverVia(remove)) && stateStyles(remove, "hover")?.backgroundColor === "rgb(41, 41, 49)" && remove?.note === undefined);
check("…a cell inherited from the row: hovered through the row (hoverVia), painted by it in the state",
  ROW1.test(hoverVia(cell5)) && isJsonObject(stateStyles(cell5, "hover")?.paintedBy) && JSON.stringify(stateStyles(cell5, "hover")?.paintedBy) === JSON.stringify({ backgroundColor: "rgb(70, 70, 79)", via: "ancestor", tag: "tr", depth: 1, dt: "70:3" }));
check("an old expectation (no drawnStateFrom) hovers the control itself, as before (its own :hover, red; no hoverVia)",
  stateStyles(oldRemove, "hover")?.backgroundColor === "rgb(255, 0, 0)" && oldRemove?.hoverVia === undefined);
const queue = node(m17, "70:11");
check("a control covering its whole drawn-hovered container → no free point: the element itself is hovered, with the note",
  stateStyles(queue, "hover")?.backgroundColor === "rgb(255, 0, 0)" && queue?.hoverVia === undefined && /hovered the element itself: no free point on its drawn-hovered container 70:10/.test(queue?.note ?? ""));
const link = node(m17, "70:13");
check("an untagged owner → the nearest visible tagged ancestor below it is hovered (the card), the link's own :hover stays off",
  /> div:nth-child\(4\)$/.test(hoverVia(link)) && stateStyles(link, "hover")?.color === "rgb(200, 200, 200)");
check("no tagged owner nor ancestor below it → the element itself, with a note naming the owner",
  /hovered the element itself: its drawn-hovered container 70:98 has no visible tagged element/.test(node(m17, "70:31")?.note ?? "") && node(m17, "70:31")?.hoverVia === undefined);
const run44 = node(m17, "70:44"), grid51 = node(m17, "70:51");
check(`the nearest tagged candidate is a same-box <span> (no free point) → the next one (the strip) is hovered; the control's own :hover stays off (got hoverVia ${JSON.stringify(hoverVia(run44))}, note ${JSON.stringify(run44?.note)})`,
  /> div:nth-child\(7\)$/.test(hoverVia(run44)) && stateStyles(run44, "hover")?.backgroundColor === "rgb(41, 41, 49)" && run44?.note === undefined);
check(`an ARIA-grid row whose cells carry tabindex="-1" has free points (a roving-focus cell is not a control): the row is hovered, the button's own :hover stays off (got ${JSON.stringify(grid51?.note)})`,
  /> div:nth-child\(8\) > div:nth-child\(1\)$/.test(hoverVia(grid51)) && stateStyles(grid51, "hover")?.backgroundColor === "rgb(41, 41, 49)" && grid51?.note === undefined);
check(`a transparent box its own children paint all over → no painter (no ancestor answer), compared as transparent (got ${JSON.stringify(styleOf(node(m17, "70:80"), "paintedBy"))})`,
  styleOf(node(m17, "70:80"), "backgroundColor") === "rgba(0, 0, 0, 0)" && styleOf(node(m17, "70:80"), "paintedBy") === undefined);
check("a transparent wrapper whose only same-box child paints → paintedBy via child (depth 1, no tag of its own)",
  styleOf(node(m17, "70:8"), "backgroundColor") === "rgba(0, 0, 0, 0)" && JSON.stringify(styleOf(node(m17, "70:8"), "paintedBy")) === JSON.stringify({ backgroundColor: "rgb(44, 44, 52)", via: "child", tag: "div", depth: 1 }));
check("paintedBy only where it says something: absent on an element that paints itself and on a spec stating no background",
  styleOf(remove, "paintedBy") === undefined && styleOf(node(m17, "70:30"), "paintedBy") === undefined);
check("TEXT nodes carry the computed text-transform of the text's owner (capitalize inherited by the <span>; none), `text` stays the DOM string",
  styleOf(node(m17, "70:30"), "textTransform") === "capitalize" && styleOf(node(m17, "70:30"), "text") === "spool order" && styleOf(node(m17, "70:31"), "textTransform") === "none"
  && styleOf(cell5, "textTransform") === undefined);
if (exe !== null) {
  const raw17 = fs.existsSync(b17 + ".measured.json") ? fs.readFileSync(b17 + ".measured.json", "utf8") : "";
  check("--browser-path <a cached chromium> → exit 0, measured.probe.browser.executable \"custom\" with its version, the path in no written file (stderr only)",
    r17.status === 0 && m17?.probe?.browser.executable === "custom" && (m17.probe.browser.version || "").length > 0 && raw17 !== "" && !raw17.includes(exe) && !raw17.includes("ms-playwright")
    && r17.stderr.includes(`(--browser-path ${exe})`));
  const chk = await probe(["--check", "--project", ROOT, "--browser-path", exe]);
  check("--check honours --browser-path (exit 0, the ok line names it)", chk.status === 0 && chk.stdout.includes(`(--browser-path ${exe})`));
}
// freeHoverPoint's two guards, in the page itself: a point over an interactive descendant (the checkbox in the
// row's first corner) and a point inside the measured element's box that elementFromPoint attributes to an overlay
const fhpBrowser = pwChromium ? await pwChromium.launch(exe !== null ? { executablePath: exe } : {}).catch(() => null) : null;
if (fhpBrowser === null) console.log("SKIPPED the in-page freeHoverPoint checks: no launchable chromium");
else {
  const pg = await fhpBrowser.newPage({ viewport: { width: 800, height: 600 } });
  await pg.goto(`http://127.0.0.1:${port}/loom-queue-owner-hover.html`);
  const at = async (owner: string, avoid: string): Promise<{ hit: string; inAvoid: boolean } | null> => {
    const pt = await pg.evaluate(freeHoverPoint, { owner, avoid });
    if (pt === null) return null;
    const ob = await pg.locator(owner).boundingBox(), ab = await pg.locator(avoid).boundingBox();
    if (!ob || !ab) return null;
    const px = ob.x + pt.x, py = ob.y + pt.y; // (no borders on these owners: padding box = border box)
    const tag: unknown = await pg.evaluate(`document.elementFromPoint(${px}, ${py})?.tagName.toLowerCase() ?? ""`);
    return { hit: typeof tag === "string" ? tag : "", inAvoid: px >= ab.x && px <= ab.x + ab.width && py >= ab.y && py <= ab.y + ab.height };
  };
  const crow = await at('[data-dt-node="70:60"]', '[data-dt-node="70:61"]');
  check(`[guard] a row whose first corner is a checkbox → the free point is not over it (another control's own :hover) (got ${JSON.stringify(crow)})`,
    crow !== null && crow.hit !== "input" && !crow.inAvoid);
  const tile = await at('[data-dt-node="70:70"]', '[data-dt-node="70:71"]');
  check(`[guard] the measured element's box is skipped even where an overlay is what elementFromPoint returns (got ${JSON.stringify(tile)})`,
    tile !== null && tile.hit === "i" && !tile.inAvoid);
  await fhpBrowser.close();
}
const chkBad = await probe(["--check", "--project", ROOT, "--browser-path", path.join(tmp, "no-such-browser")]);
check("--check --browser-path <missing> → exit 3, one line, no stack", chkBad.status === 3 && chkBad.stderr.trim().split("\n").length === 1 && /is not an executable file/.test(chkBad.stderr));
check("without --browser-path the identity names no executable", m1?.probe?.browser.executable === undefined);

// ---- an aborted navigation
// the page renders, then its own next navigation is cancelled (window.stop()) before any response — the page is
// still there: measured (not "could not load … Timeout"). The goto gives up on its load (the note is set), but window.stop()
// also ends the document's own load (readyState "complete"), so the settle drops the note again: measured fully loaded
const origin = `http://127.0.0.1:${port}`;
const bAb = path.join(tmp, "abort", "Self");
const rAb = await probe(["--expected", expected, "--url", `${origin}/abort-self.html`, "--out", bAb, "--timeout", "3000", "--project", ROOT]);
const mAb = read(bAb);
if (rAb.status !== 0) console.log(rAb.stderr);
check(`a page that renders, then cancels its own next navigation (window.stop) → exit 0, the root measured, not 'could not load' (exit ${String(rAb.status)})`,
  rAb.status === 0 && node(mAb, "50:1")?.matchedBy === "frame" && !/could not load/.test(rAb.stderr));
fs.writeFileSync(path.join(tmp, "steps-abort.json"), JSON.stringify([{ goto: "/abort-self.html" }]));
const bAbS = path.join(tmp, "abort", "Step");
const rAbS = await probe(["--expected", expected, "--url", url(), "--steps", path.join(tmp, "steps-abort.json"), "--out", bAbS, "--timeout", "3000", "--project", ROOT]);
const mAbS = read(bAbS);
if (rAbS.status !== 0) console.log(rAbS.stderr);
check(`the same page as a goto step's target → measured (exit ${String(rAbS.status)})`,
  rAbS.status === 0 && node(mAbS, "50:1")?.matchedBy === "frame" && !/could not load/.test(rAbS.stderr));
// a URL with no document → exit 4 "could not load" in plain words, not Playwright's raw text
const r204 = await probe(["--expected", expected, "--url", `${origin}/no-content`, "--out", path.join(tmp, "abort", "NoContent"), "--timeout", "3000", "--project", ROOT]);
check(`a 204 → exit 4, 'could not load … no document (e.g. 204 No Content)' (got ${String(r204.status)}: ${r204.stderr.split("\n")[0] ?? ""})`,
  r204.status === 4 && /could not load .*no document \(e\.g\. 204/.test(r204.stderr));
const rDl = await probe(["--expected", expected, "--url", `${origin}/download`, "--out", path.join(tmp, "abort", "Download"), "--timeout", "3000", "--project", ROOT]);
check(`a download → exit 4, 'could not load … started a file download, not a page' (got ${String(rDl.status)}: ${rDl.stderr.split("\n")[0] ?? ""})`,
  rDl.status === 4 && /could not load .*started a file download, not a page/.test(rDl.stderr));

finish();
report();
