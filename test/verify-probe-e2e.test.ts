// End-to-end tests for the shipped web probe (group 7): the BUILT claude-plugin/scripts/verify-probe.js,
// run in a real chromium against static pages served by node:http, measuring an expectation written by the
// real `verify-screen --expect` from a real-shaped screen export (test/fixtures/probe, invented names).
//
// D3: this needs the repo's own devDependency `playwright` and its chromium. Locally, when the renderer is
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
import { liveStatusFile, stageDirOf } from "../design-to-code/verify-run.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { MeasuredNode, VerifyMeasured } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

const ROOT = path.join(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "claude-plugin", "scripts", "verify-probe.js");
const FIX = path.join(import.meta.dirname, "fixtures", "probe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dt-probe-e2e-"));
fs.writeFileSync(path.join(tmp, "asset.js"), "window.__plotsBuild = 1;\n");

// ---- a static server on an ephemeral port (no dev server: nothing here reloads unless the page asks to)
// (group 10: asset.js is served from the temp dir so a test can change the build; /@vite/client stands in for a
// dev server; every page request records what the run's LIVE status said at that moment, and the state of the
// project tree outside node_modules — F-91/H1: nothing may be written there while the page is connected)
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
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  if (pathname === "/asset.js" || pathname === "/@vite/client") {
    const body = pathname === "/asset.js" && fs.existsSync(path.join(tmp, "asset.js")) ? fs.readFileSync(path.join(tmp, "asset.js")) : "/* vite client stand-in */";
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(body);
    return;
  }
  const name = path.basename(pathname);
  if (onPage !== null) { const f = onPage; onPage = null; f(); }
  if (statusWatch !== null) pageSeen.push({ status: fs.existsSync(statusWatch.live) ? fs.readFileSync(statusWatch.live, "utf8") : null, tree: treeState(statusWatch.project) });
  const file = path.join(FIX, name);
  if (!name.endsWith(".html") || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address();
const port = addr !== null && typeof addr === "object" ? (addr satisfies AddressInfo).port : 0;
const url = (mode?: string): string => `http://127.0.0.1:${port}/staff-directory.html${mode ? `?mode=${mode}` : ""}`;

// async spawn: the server above lives in THIS process, so a spawnSync would block it from answering
interface Run { status: number | null; stdout: string; stderr: string }
const probe = (args: string[]): Promise<Run> => new Promise((resolve) => {
  const p = spawn(process.execPath, [BUNDLE, ...args], { cwd: tmp });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("close", (status) => resolve({ status, stdout, stderr }));
});
const finish = (): void => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };

// ---- the expectation, from the real --expect
const exp = spawnSync(process.execPath, [path.join(ROOT, "design-to-code", "verify-screen.ts"), "--expect", path.join(FIX, "staff-directory.json"), "--out", path.join(tmp, "Staff")], { encoding: "utf8" });
const expected = path.join(tmp, "Staff.expected.json");
if (exp.status !== 0 || !fs.existsSync(expected)) { check("verify-screen --expect wrote the expectation", false); finish(); report(); }

console.log("verify-probe e2e — the built bundle in a real chromium:");
const pre = await probe(["--check", "--project", ROOT]);
if (pre.status === 3) {
  const reason = pre.stderr.split("\n")[0] || "renderer unavailable";
  if (process.env.CI !== "true") { console.log(`SKIPPED (no playwright: ${reason})`); finish(); process.exit(0); }
  check(`the renderer is available in CI (D3) — ${reason}`, false);
  finish();
  report();
}
check("--check resolves the repo's playwright and launches chromium (exit 0)", pre.status === 0 && /^ok {2}playwright /.test(pre.stdout));

const read = (base: string): VerifyMeasured | null => readJsonOrNull(base + ".measured.json", isVerifyMeasured);
const node = (m: VerifyMeasured | null, id: string): MeasuredNode | undefined => (m?.nodes || []).find((n) => n.nodeId === id);
const styleOf = (n: MeasuredNode | undefined, k: string): unknown => (n && n.styles ? n.styles[k] : undefined);

// ---- the main page: F-57, F-63, F-71/F-120, DT-23, D16, identity
const base = path.join(tmp, "run1", "Staff");
const r1 = await probe(["--expected", expected, "--url", url(), "--out", base, "--project", ROOT]);
const m1 = read(base);
check("a clean page → exit 0, measured.json (a valid VerifyMeasured) and the screenshot written", r1.status === 0 && m1 !== null && fs.existsSync(base + ".png"));
if (r1.status !== 0) console.log(r1.stderr);

const nav3 = node(m1, "50:3");
check("[F-57] 'Shift Planner' (also a page <h1> and a closed dialog's <h2>) → the sidebar <button>, matchedBy text", nav3?.matchedBy === "text" && styleOf(nav3, "tag") === "button" && styleOf(nav3, "fontSize") === 12 && /button:nth-child\(1\)$/.test(nav3.selector || ""));
check("[F-57] an untagged container with no text → notMeasured 'tag it', not a guess", (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === "50:2" && typeof n.why === "string" && /tag it/.test(n.why)));

check("[F-63] transparent <body>, painted #root > div → frame.via size-and-fill on that div", m1?.frame?.via === "size-and-fill" && m1.frame.selector === "html > body:nth-child(2) > div:nth-child(2) > div:nth-child(1)");
check("[F-63] the frame's own spec is measured on it (matchedBy frame, its paint, x/y 0)", node(m1, "50:1")?.matchedBy === "frame" && styleOf(node(m1, "50:1"), "backgroundColor") === "rgb(29, 29, 31)" && styleOf(node(m1, "50:1"), "x") === 0);

const btn = node(m1, "50:4");
const tb = styleOf(btn, "textBox");
check("[F-71/F-120] TEXT id on a 188×32 weight-500 <button> → typography from the inner <span> (textFrom span, fontWeight 400)", btn?.textFrom === "span" && styleOf(btn, "fontWeight") === 400 && styleOf(btn, "width") === 188 && btn.textFromMixed === undefined);
check("[F-71] textBox {x, w} is the text run's, frame-relative", isJsonObject(tb) && typeof tb.x === "number" && typeof tb.w === "number" && tb.w > 30 && tb.w < 188);

const everyKey = (m1?.nodes || []).every((n) => STYLE_KEYS.every((k) => n.styles !== undefined && k in n.styles && (n.styles[k] !== null || typeof (n.unmeasured || {})[k] === "string")));
check("[DT-23] every STYLE_KEY on every node; every null has a reason", (m1?.nodes || []).length > 0 && everyKey);
check("[DT-23] inline SVG path fill read (fillSource svg)", styleOf(node(m1, "50:5"), "fill") === "rgb(255, 136, 0)" && node(m1, "50:5")?.fillSource === "svg");
check("[DT-23] <img> spec → fill null, fillSource img, with the reason", styleOf(node(m1, "50:6"), "fill") === null && node(m1, "50:6")?.fillSource === "img" && /<img>/.test((node(m1, "50:6")?.unmeasured || {}).fill || ""));

const row = node(m1, "50:7");
const hov = row?.states?.hover;
const hovStyles = hov && isJsonObject(hov) && isJsonObject(hov.styles) ? hov.styles : null;
check("[D16] a spec drawn hovered → states.hover measured with the hover paint; rest keeps the resting paint", styleOf(row, "backgroundColor") === "rgb(18, 19, 25)" && hovStyles?.backgroundColor === "rgb(70, 70, 79)");

const edit = node(m1, "50:11");
const editHover = edit?.states?.hover;
const editHov = editHover && isJsonObject(editHover) && isJsonObject(editHover.styles) ? editHover.styles : null;
check("[D16/M2] hover-only content that is display:none at rest → matched by tag, revealed by hovering its tagged row, measured in states.hover", edit?.matchedBy === "tag"
  && styleOf(edit, "width") === 0 && editHov?.width === 40 && editHov.backgroundColor === "rgb(10, 132, 255)");
const search = node(m1, "50:12");
const foc = search?.states?.focus;
const focStyles = foc && isJsonObject(foc) && isJsonObject(foc.styles) ? foc.styles : null;
check("[D16/M1] a focus spec on a focusable <input> → focused from the keyboard (focusVia keyboard), :focus-visible paint in states.focus", search?.focusVia === "keyboard"
  && styleOf(search, "backgroundColor") === "rgb(18, 19, 25)" && focStyles?.backgroundColor === "rgb(44, 44, 52)");
const card = node(m1, "50:13");
check("[D16/M1] a focus spec on a non-focusable <div> → no states.focus (its resting styles are not recorded as focus), a note says why", card !== undefined && card.states === undefined && /not focusable/.test(card.note || ""));
check("[H1] the same date designed in two tagged rows, built only in the first → the first row's date is its spec's; the second is notMeasured 'not inside', never the first row's cell",
  node(m1, "50:15")?.matchedBy === "text" && node(m1, "50:17") === undefined
  && (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === "50:17" && typeof n.why === "string" && /not inside data-dt-node="50:16"/.test(n.why)));
const ph = node(m1, "50:18");
check("[H1/LOW] an input placeholder shares the tagged <input> with the field's spec; its null textBox says 'input placeholder', not 'not a TEXT node'", ph?.matchedBy === "text"
  && styleOf(ph, "placeholderText") === "Find staff" && styleOf(ph, "placeholderColor") === "rgb(138, 138, 138)" && /input placeholder/.test((ph.unmeasured || {}).textBox || ""));
const rowHov = row?.states?.hover;
check("[LOW] states.hover keeps nulls with their reasons (a value not read in the state is not the resting one)", isJsonObject(rowHov) && isJsonObject(rowHov.styles) && rowHov.styles.fill === null
  && isJsonObject(rowHov.unmeasured) && typeof rowHov.unmeasured.fill === "string");
const notePh = node(m1, "50:23");
check("[RR-M1] a placeholder nested under its tagged field frame is measured on that field's <input> (its own tag counts as inside)", notePh?.matchedBy === "text" && styleOf(notePh, "placeholderText") === "Add a note");
const lbl = node(m1, "50:25");
check("[RR-M2] a label written straight into its tagged <button> shares it: typography from the button, box null with the reason", lbl?.matchedBy === "text" && lbl.textFrom === "button"
  && styleOf(lbl, "fontSize") === 13 && styleOf(lbl, "width") === null && /shares the element of data-dt-node="50:24"/.test((lbl.unmeasured || {}).width || "") && node(m1, "50:24")?.matchedBy === "tag");
const refTb = styleOf(node(m1, "50:27"), "textBox");
const textOnlyWidth = isJsonObject(refTb) && typeof refTb.w === "number" ? refTb.w : -100;
const ltb = styleOf(lbl, "textBox");
check("[RR2-M] the shared label's textBox covers its own text node, not the icon beside it (w within 1px of the text's own width, x after the icon)",
  isJsonObject(ltb) && typeof ltb.w === "number" && typeof ltb.x === "number" && Math.abs(ltb.w - textOnlyWidth) <= 1 && ltb.x > 12);
const glyph = node(m1, "50:26");
const gf = glyph?.states?.focus;
check("[RR-LOW] a focus spec on a non-focusable <span> inside a <button> focuses the button (closest), from the keyboard", glyph?.focusVia === "keyboard"
  && isJsonObject(gf) && isJsonObject(gf.styles) && gf.styles.backgroundColor === "rgb(255, 204, 0)");
const twin = (id: string): boolean => (m1?.notMeasured || []).some((n) => isJsonObject(n) && n.nodeId === id && typeof n.why === "string" && /matched for 2 specs/.test(n.why));
check("[RR-LOW/H1c] 'Open shifts' and 'open shifts' both land on the one <p> (exact / case-insensitive): claimOnce keeps it from both", twin("50:20") && twin("50:21"));
const paths = (m1?.nodes || []).filter((n) => !["50:18", "50:23", "50:25"].includes(n.nodeId)).map((n) => n.selector);
check("[H1] no element is claimed by two specs", new Set(paths).size === paths.length);

const sha = crypto.createHash("sha256").update(fs.readFileSync(BUNDLE)).digest("hex");
const pwVersion = readJsonOrNull(path.join(ROOT, "node_modules", "playwright", "package.json"), isJsonObject)?.version;
const pluginVersion = readJsonOrNull(path.join(ROOT, "claude-plugin", ".claude-plugin", "plugin.json"), isJsonObject)?.version;
check("[F-101] probe identity: sha256 of the bundle bytes, plugin version, the installed playwright, the browser version", m1?.probe?.sha256 === sha && m1.probe.version === pluginVersion
  && m1.probe.playwright.package === "playwright" && m1.probe.playwright.version === pwVersion && m1.probe.browser.name === "chromium" && m1.probe.browser.version.length > 0);
const c = m1?.matchedByCensus || {};
check("[F-101] matchedByCensus counts every spec once (tag + text + frame + notMeasured = specs)", (c.tag ?? 0) + (c.sharedPath ?? 0) + (c.text ?? 0) + (c.textOrdinal ?? 0) + (c.position ?? 0) + (c.frame ?? 0) + (c.notMeasured ?? 0) === 25 && c.notMeasured === 4);
check("[DT-39] a quiet page: no navigation after the initial load, no re-run", m1?.navigation?.afterInitialLoad === 0 && m1.navigation.reruns === 0);

// ---- DT-39 / D19: reloads
const allTagged = (m: VerifyMeasured | null): boolean => ["50:4", "50:5", "50:6", "50:7", "50:12", "50:14"].every((id) => node(m, id)?.matchedBy === "tag");
const b2 = path.join(tmp, "run2", "Staff");
const r2 = await probe(["--expected", expected, "--url", url("reload-once"), "--out", b2, "--project", ROOT]);
const m2 = read(b2);
check("[DT-39] the page reloads once 200ms after load → absorbed by the readiness wait: exit 0, afterInitialLoad 1, every tagged spec resolved", r2.status === 0 && m2?.navigation?.afterInitialLoad === 1 && m2.navigation.reruns === 0 && allTagged(m2));

const b3 = path.join(tmp, "run3", "Staff");
const r3 = await probe(["--expected", expected, "--url", url("reload-on-first-hover"), "--out", b3, "--project", ROOT]);
const m3 = read(b3);
check("[DT-39] a reload DURING measurement (first hover) → one full re-run: exit 0, reruns 1, every tagged spec resolved", r3.status === 0 && m3?.navigation?.reruns === 1 && allTagged(m3));

const b4 = path.join(tmp, "run4", "Staff");
const r4 = await probe(["--expected", expected, "--url", url("reload-on-every-hover"), "--out", b4, "--project", ROOT]);
check("[D19] reloaded during measurement twice → exit 4, nothing written, the watch-tree hint and the navigation log printed", r4.status === 4 && !fs.existsSync(b4 + ".measured.json") && !fs.existsSync(b4 + ".png")
  && /watch tree/.test(r4.stderr) && /navigation log/.test(r4.stderr));

const b5 = path.join(tmp, "run5", "Staff");
const r5 = await probe(["--expected", expected, "--url", url("reload-forever"), "--out", b5, "--project", ROOT, "--timeout", "2500"]);
check("[D19] a page that keeps reloading after load → exit 4, nothing written", r5.status === 4 && !fs.existsSync(b5 + ".measured.json") && /kept navigating/.test(r5.stderr));

const b6 = path.join(tmp, "run6", "Staff");
const r6 = await probe(["--expected", expected, "--url", `http://127.0.0.1:${port}/missing.html`, "--out", b6, "--project", ROOT, "--ready", "#never", "--timeout", "1500"]);
check("[D19] --ready never visible → exit 4, nothing written", r6.status === 4 && !fs.existsSync(b6 + ".measured.json"));

// ---- group 10: F-107 watchdog, F-91/F-72 --run status, DT-81 build identity
const b7 = path.join(tmp, "run7", "Staff");
const t7 = Date.now();
const r7 = await probe(["--expected", expected, "--url", url("busy"), "--out", b7, "--project", ROOT, "--max-time", "4000"]);
const took7 = Date.now() - t7;
check(`[F-107] a page whose script never yields + --max-time 4000 → exit 4 within ~8 s (took ${took7} ms), nothing written, says --max-time`,
  r7.status === 4 && took7 < 12_000 && !fs.existsSync(b7 + ".measured.json") && !fs.existsSync(b7 + ".png") && /--max-time/.test(r7.stderr) && /nothing written/.test(r7.stderr));
if (r7.status !== 4) console.log(r7.stderr);
check("[F-107] --max-time must be a positive number → exit 2", (await probe(["--expected", expected, "--url", url(), "--max-time", "0"])).status === 2);

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
check("[F-91] with --run, every page request saw the live status the probe wrote BEFORE launch (measuring, rev 1) in node_modules/.cache/designtwin-verify/",
  r8.status === 0 && pageSeen.length > 0 && liveFile.includes(path.join("node_modules", ".cache", "designtwin-verify")) && seenStatus.every((v) => isJsonObject(v) && v.phase === "measuring" && v.rev === 1 && v.runId === "run-e2e-1"));
check("[H1] while the page was connected, nothing in the project tree (outside node_modules) was created or modified",
  pageSeen.length > 0 && pageSeen.every((p) => p.tree === treeBefore) && !fs.existsSync(path.join(vdir, "Staff.status.json")));
const st8 = readStatus(liveFile);
const m8 = read(stage);
check("[F-72] after close: status `measured` rev 2 by verify-probe, measuredSha256 = sha256 of the measured file; measured.runId = the run",
  st8?.phase === "measured" && st8.rev === 2 && st8.by === "verify-probe" && st8.runId === "run-e2e-1" && fs.existsSync(stage + ".measured.json")
  && st8.measuredSha256 === crypto.createHash("sha256").update(fs.readFileSync(stage + ".measured.json")).digest("hex") && m8?.runId === "run-e2e-1");
check("[F-72] the status is the verify dir's (live, run cache), not in the --out staging dir, and not in design/verify until done; no tmp files left", !fs.existsSync(stage + ".status.json") && treeState(projDir) === treeBefore && fs.existsSync(path.dirname(stage)) && !fs.readdirSync(path.dirname(stage)).some((f) => f.includes(".tmp-")));

// M-a: the run cache turns read-only while the page is measured — the `measured` status write is refused: the
// measured file stays, exit 0, and a warning names the --status command that records it
const cache10 = path.dirname(liveFile);
const stage10 = path.join(tmp, "stage10", "Staff");
onPage = () => fs.chmodSync(cache10, 0o555);
const r10 = await probe(["--expected", path.join(vdir, "Staff.expected.json"), "--url", url(), "--out", stage10, "--project", ROOT, "--run", "run-e2e-10"]);
onPage = null;
fs.chmodSync(cache10, 0o755);
const st10 = readStatus(liveFile);
check("[M-a] a refused post-measure status write → exit 0, the measured file stays, a warning naming the cache and `--status Staff --phase measured --run run-e2e-10`, no stack",
  r10.status === 0 && fs.existsSync(stage10 + ".measured.json") && /warning {2}run cache \S+ is not writable \(sandbox write scope\?\)/.test(r10.stderr)
  && /--status Staff --phase measured --run run-e2e-10 --dir /.test(r10.stderr) && !/\n\s+at /.test(r10.stderr) && st10?.phase === "measuring" && st10.runId === "run-e2e-10");
if (r10.status !== 0) console.log(r10.stderr);
check("[M-1] …the warning says which write was refused and that the live status still says measuring (compare: incomplete)",
  /the run cache refused the probe's `measured` status write for run run-e2e-10 — the live status still says measuring/.test(r10.stderr));

// M-1 / L-3: a project whose path holds a space, and a run cache refusing every status write of the run (measuring
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
check("[M-1] every status write refused → exit 0, the warning says no live status exists and --compare will report the run as unrecorded",
  r11.status === 0 && !fs.existsSync(sLive) && /no live status of the run exists, so --compare will report the run as unrecorded/.test(r11.stderr) && recovery !== "");
if (r11.status !== 0) console.log(r11.stderr);
const next11 = /^next {2}(.+)$/m.exec(r11.stderr)?.[1] ?? "";
const c11 = spawnSync("/bin/sh", ["-c", next11], { cwd: os.tmpdir(), encoding: "utf8" });
check("[M-1/L-3] the printed `next` --compare runs as printed from another directory (paths with a space) → incomplete: 'no status of that run records it'",
  c11.status === 1 && /no status of that run records it/.test(fs.existsSync(path.join(sStage, "Staff.report.json")) ? fs.readFileSync(path.join(sStage, "Staff.report.json"), "utf8") : ""));
const rec11 = spawnSync("/bin/sh", ["-c", recovery], { cwd: os.tmpdir(), encoding: "utf8" });
const st11 = readStatus(sLive);
check("[M-1/L-3] the printed recovery runs as printed → status measured, measuredSha256 = the staged measured file",
  rec11.status === 0 && st11?.phase === "measured" && st11.runId === "run-e2e-11" && st11.measuredSha256 === crypto.createHash("sha256").update(fs.readFileSync(path.join(sStage, "Staff.measured.json"))).digest("hex"));
if (rec11.status !== 0) console.log(rec11.stderr);

const bd = m1?.build;
check("[DT-81] measured.build: the url, mode static, same-origin assets hashed (document + asset.js), git state of the project", bd !== undefined && bd.url === url() && bd.mode === "static" && bd.assets === 2
  && /^[0-9a-f]{64}$/.test(bd.assetsSha256) && (bd.gitHead === null || /^[0-9a-f]{40}$/.test(bd.gitHead)) && (bd.gitDirty === null || typeof bd.gitDirty === "boolean"));
check("[DT-81] the same build served again → the same assetsSha256", m8?.build?.assetsSha256 !== undefined && m8.build.assetsSha256 === bd?.assetsSha256);
fs.writeFileSync(path.join(tmp, "asset.js"), "window.__plotsBuild = 2;\n");
const b9 = path.join(tmp, "run9", "Staff");
const r9 = await probe(["--expected", expected, "--url", url("vite"), "--out", b9, "--project", ROOT]);
const m9 = read(b9);
check("[DT-81] the fixture's JS changed → a different assetsSha256; /@vite/client served → mode vite-dev", r9.status === 0 && m9?.build !== undefined && m9.build.assetsSha256 !== bd?.assetsSha256 && m9.build.mode === "vite-dev");

finish();
report();
