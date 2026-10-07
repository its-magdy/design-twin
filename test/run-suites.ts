// The test runner behind `npm test` (group 16, H-1a / D103).
//   node test/run-suites.ts                run both lints, then every suite, in order
//   node test/run-suites.ts bridge verify-probe-e2e    only the named suites (exact name, else substring), in order
//   node test/run-suites.ts --list         print the order and exit (the coverage guard still runs)
//   node test/run-suites.ts --fast         everything except the three slow probe e2e suites (`npm run test:fast`, ~3 min vs ~20)
//   node test/run-suites.ts --fast --list  what --fast would run
//
// --fast: the name filters (if any) pick the suites first, then FAST_SKIP is dropped from that pick. The dropped suites
// stay in the SUMMARY as `not run` (why `--fast`) and do NOT make the exit code 1 — `not run` otherwise means an
// interruption, which does — but the run ends with a loud line saying it was not the full suite (CI uses plain `npm test`;
// under CI=true --fast is still allowed and still prints it). A FAST_SKIP name that is not in SUITES exits 1, so a rename
// cannot silently drop a suite from the skip list.
//
// It replaced a 40-link `a && b && c` chain: the first non-zero exit skipped every later suite, there was no
// summary and no timing, and a suite that exited 0 without printing its `N/N checks passed` line went unnoticed.
// Here every suite runs even after a failure, strictly one at a time (the e2e suites drive a real browser and
// several suites bind ports; two at once starve each other — and a spawn can fail with EAGAIN when too many
// children are alive), its output is forwarded live, and the end prints one row per suite.
//
// A suite FAILS when it exits non-zero or by signal, prints `p/t checks passed` with p < t, runs past the cap
// (DT_SUITE_TIMEOUT_MS, default 30 min — the slowest suite, the drive e2e, takes ~12), exits 0 WITHOUT a checks
// line (it ended before its summary) or with `0/0` (it asserted nothing). It is never re-run: the only retry is for a spawn that never ran
// (EAGAIN/ENOMEM), once, after DT_SPAWN_RETRY_MS (default 5 s). A suite that prints `SKIPPED (no playwright…)`
// and exits 0 is `skipped`: a warning locally, a FAILURE under CI=true (D103 — the browser suites already exit
// non-zero in CI; this is belt and braces over their own rule).
//
// SIGINT / SIGTERM / SIGHUP to the runner stop the running suite's process group (TERM, then KILL after the grace)
// and mark the rest `not run`; the summary still prints and the exit is 130.
//
// Every test/*.test.ts (+ harness.ts) on disk must be in SUITES and every SUITES file must exist, else the runner
// exits 1 naming it — a new suite cannot be forgotten.
//
// Test seams (test/run-suites.test.ts): DT_RUN_SUITES_LIST=<json file> replaces SUITES with an array of
// `{ name, file, kind? }` (file absolute; coverage guard off); DT_RUN_SUITES_DIR=<dir> is the directory the guard
// scans and the suites are resolved in (default: this directory); DT_KILL_GRACE_MS (default 10 s) is the wait
// between SIGTERM and SIGKILL for a timed-out or interrupted suite; DT_DRAIN_MS (default 2 s) is how long the runner
// still reads a suite's pipes after it EXITED (a grandchild that inherited them can hold them open for good).
// `command()` is exported for the self-test (the runner itself only runs when executed directly).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Kind = "lint" | "node";
interface Suite { name: string; kind: Kind; file: string }
type Status = "pass" | "FAIL" | "skipped" | "not run";
interface Result { name: string; kind: Kind; file: string; status: Status; pass: number | null; total: number | null; ms: number; why: string; skipReason: string; fast?: boolean }
interface Outcome { code: number | null; signal: NodeJS.Signals | null; spawnError: NodeJS.ErrnoException | null; timedOut: boolean; pass: number | null; total: number | null; skipped: string | null; ms: number }

const HERE = process.env.DT_RUN_SUITES_DIR ? path.resolve(process.env.DT_RUN_SUITES_DIR) : import.meta.dirname;
const ROOT = path.resolve(import.meta.dirname, "..");
const num = (v: string | undefined, d: number): number => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
const TIMEOUT_MS = num(process.env.DT_SUITE_TIMEOUT_MS, 30 * 60_000);
const RETRY_MS = num(process.env.DT_SPAWN_RETRY_MS, 5_000);
const KILL_GRACE_MS = num(process.env.DT_KILL_GRACE_MS, 10_000);
const DRAIN_MS = num(process.env.DT_DRAIN_MS, 2_000);
const CI = process.env.CI === "true";
// The suites spawn hundreds of short `node` children; Node's module compile cache (NODE_COMPILE_CACHE, stable in Node 24.15,
// covers TypeScript modules; https://nodejs.org/docs/latest-v24.x/api/module.html#module-compile-cache) cuts a spawn-heavy
// suite's time by about a third (cli-help 3.5 s -> 1.7 s). A user-set NODE_COMPILE_CACHE wins; NODE_DISABLE_COMPILE_CACHE=1 still disables it.
const SUITE_ENV: NodeJS.ProcessEnv = process.env.NODE_COMPILE_CACHE === undefined ? { ...process.env, NODE_COMPILE_CACHE: path.join(os.tmpdir(), "designtwin-node-compile-cache") } : process.env;

// The exact order the old `npm test` chain ran in (the lints first, then the plugin extractor, the bridge, the rest).
const NODE_SUITES: readonly string[] = [
  // group 16: the real-name guard, right after the lints (fast, repo-wide)
  "real-names.test.ts",
  "harness.ts", "bridge.test.ts", "cli-help.test.ts", "cli-pull.test.ts", "asset-compare.test.ts", "asset-index.test.ts",
  "quick-keys.test.ts", "design-to-code.test.ts", "tokens-cli.test.ts", "g14-step0.test.ts", "cli-exit.test.ts",
  "audit.test.ts", "build-screen-docs.test.ts", "verify-build.test.ts", "plan-record.test.ts", "verify-screen.test.ts", "verify-accuracy.test.ts", "verify-values.test.ts",
  "verify-waivers.test.ts", "verify-node-rules.test.ts", "verify-run.test.ts", "verify-behaviour.test.ts",
  "verify-integrity.test.ts", "verify-probe.test.ts", "verify-probe-e2e.test.ts", "verify-drive.test.ts",
  "verify-probe-drive-e2e.test.ts", "verify-own-pixels.test.ts", "verify-probe-behaviour-e2e.test.ts",
  "visual-diff.test.ts", "verify-visual.test.ts", "verify-probe-visual-e2e.test.ts", "cross-check.test.ts",
  "design-diff.test.ts", "identity.test.ts", "plan-skeleton.test.ts", "resolve-screen.test.ts", "ui.test.ts",
  "mcp-share.test.ts", "mcp-smoke.test.ts",
  // group 16: this runner's own self-test (fast, so early)
  "run-suites.test.ts",
];
// The slow browser suites `--fast` leaves out (~17 of the ~19 min); everything else is quick.
const FAST_SKIP: readonly string[] = ["verify-probe-e2e", "verify-probe-drive-e2e", "verify-probe-behaviour-e2e"];
const USAGE = "usage: node test/run-suites.ts [--list] [--fast] [suite-name…]";
const baseName = (f: string): string => f.replace(/\.test\.ts$/, "").replace(/\.ts$/, "");
const SUITES: readonly Suite[] = [
  { name: "lint:any", kind: "lint", file: "lint:any" },
  { name: "lint:types", kind: "lint", file: "lint:types" },
  ...NODE_SUITES.map((f): Suite => ({ name: baseName(f), kind: "node", file: f })),
];

// ---- the suite list (real, or a test's)
function loadSuites(): { suites: readonly Suite[]; custom: boolean } {
  const listFile = process.env.DT_RUN_SUITES_LIST;
  if (!listFile) return { suites: SUITES.map((s) => (s.kind === "node" ? { ...s, file: path.join(HERE, s.file) } : s)), custom: false };
  const raw = JSON.parse(fs.readFileSync(listFile, "utf8")) as { name: string; file: string; kind?: Kind }[];
  return { suites: raw.map((e): Suite => ({ name: e.name, kind: e.kind ?? "node", file: e.file })), custom: true };
}

// Every test/*.test.ts + harness.ts must be listed; every listed node suite must exist. Returns the problems.
function coverageProblems(suites: readonly Suite[]): string[] {
  const onDisk = fs.readdirSync(HERE).filter((f) => f.endsWith(".test.ts") || f === "harness.ts");
  const listed = new Set(suites.filter((s) => s.kind === "node").map((s) => path.basename(s.file)));
  const out: string[] = [];
  for (const f of onDisk) if (!listed.has(f)) out.push(`test/${f} exists but is not in SUITES (test/run-suites.ts) — add it`);
  for (const s of suites) if (s.kind === "node" && !fs.existsSync(s.file)) out.push(`SUITES lists ${path.basename(s.file)} but ${s.file} does not exist`);
  return out;
}

// ---- running one suite
const fmt = (ms: number): string => {
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// `detached` puts the suite in its own process group (one kill reaches its children). Not on Windows: there it
// opens a console window per suite, and the group kill does not exist anyway.
export function command(s: Suite, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; detached: boolean; windowsVerbatimArguments?: boolean } {
  const detached = platform !== "win32";
  if (s.kind === "node") return { cmd: process.execPath, args: [s.file], detached };
  // lint: the package.json script is the single source of the command line
  const ep = env.npm_execpath;
  if (ep && /\.[cm]?js$/.test(ep)) return { cmd: process.execPath, args: [ep, "run", "-s", s.file], detached };
  // Windows: npm is npm.cmd, and spawning a .cmd without a shell throws EINVAL (Node >= 18.20.2 / 20.12) — go
  // through cmd.exe exactly as Node's own `shell: true` does
  if (platform === "win32") return { cmd: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${ep ? `"${ep}"` : "npm"} run -s ${s.file}"`], detached, windowsVerbatimArguments: true };
  return { cmd: ep ?? "npm", args: ["run", "-s", s.file], detached };
}

let current: ChildProcess | null = null;
// a group sent TERM gets KILL when its leader is done: a member that ignores TERM (or is slow) must not outlive the run
const termed = new WeakSet<ChildProcess>();
const killGroup = (c: ChildProcess, sig: NodeJS.Signals): void => {
  if (sig === "SIGTERM") termed.add(c);
  try { if (c.pid !== undefined) process.kill(-c.pid, sig); else c.kill(sig); } catch { try { c.kill(sig); } catch { /* already gone */ } }
};

function runOnce(s: Suite): Promise<Outcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out: Outcome = { code: null, signal: null, spawnError: null, timedOut: false, pass: null, total: null, skipped: null, ms: 0 };
    const { cmd, args, detached, windowsVerbatimArguments } = command(s);
    let child: ChildProcess;
    try { child = spawn(cmd, args, { cwd: ROOT, env: SUITE_ENV, stdio: ["ignore", "pipe", "pipe"], detached, ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}) }); }
    catch (e) { out.spawnError = e as NodeJS.ErrnoException; out.ms = Date.now() - t0; resolve(out); return; }
    current = child;
    let done = false;
    let graceTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true; if (termed.has(child)) killGroup(child, "SIGKILL"); clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(drainTimer); current = null; out.ms = Date.now() - t0; resolve(out);
    };
    // line-wise scan of both streams (the checks line / SKIPPED line can arrive split across chunks)
    const scan = (line: string): void => {
      const m = /^(\d+)\/(\d+) checks passed$/.exec(line.trim());
      if (m) { out.pass = Number(m[1]); out.total = Number(m[2]); }
      const k = /SKIPPED \(no playwright[^\n]*/.exec(line);
      if (k) out.skipped = k[0];
    };
    const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream): void => {
      let buf = "";
      stream?.on("data", (d: Buffer) => {
        sink.write(d);
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) scan(l);
        if (buf.length > 64 * 1024) buf = buf.slice(-4096); // a runaway unterminated line
      });
      stream?.on("end", () => { if (buf) scan(buf); });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    const timer = setTimeout(() => {
      out.timedOut = true;
      killGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => { killGroup(child, "SIGKILL"); graceTimer = setTimeout(finish, 5_000); graceTimer.unref(); }, KILL_GRACE_MS);
      graceTimer.unref();
    }, TIMEOUT_MS);
    child.on("error", (e: NodeJS.ErrnoException) => { out.spawnError = e; finish(); });
    // The verdict is the suite's own exit. `close` (every pipe closed) normally follows at once, but a grandchild that
    // inherited the pipes (a daemon a suite started) can hold them open for good: read on for DRAIN_MS, then drop them.
    child.on("exit", (code, signal) => {
      out.code = code; out.signal = signal;
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, DRAIN_MS);
      drainTimer.unref();
    });
    child.on("close", (code, signal) => { out.code = code; out.signal = signal; finish(); });
  });
}

// Set by the signal handler in main(); module scope so a signal during the EAGAIN retry sleep cancels the retry.
let interrupted = false;

async function runSuite(s: Suite): Promise<Result> {
  console.log(`\n=== ${s.name} ${"=".repeat(Math.max(3, 70 - s.name.length))}`);
  let o = await runOnce(s);
  // The only retry: the child never ran (the OS refused the spawn). A suite that ran and failed is NEVER re-run.
  if (o.spawnError && (o.spawnError.code === "EAGAIN" || o.spawnError.code === "ENOMEM") && !interrupted) {
    console.log(`[runner] ${s.name}: spawn failed (${o.spawnError.code}) — retrying once in ${fmt(RETRY_MS)}`);
    await sleep(RETRY_MS);
    if (!interrupted) o = await runOnce(s);
  }
  const base = { name: s.name, kind: s.kind, file: s.file, pass: o.pass, total: o.total, ms: o.ms, skipReason: o.skipped ?? "" };
  let status: Status = "pass";
  let why = "";
  if (o.spawnError) { status = "FAIL"; why = `could not spawn (${o.spawnError.code ?? o.spawnError.message})`; }
  else if (o.timedOut) { status = "FAIL"; why = `timed out after ${fmt(TIMEOUT_MS)}`; }
  else if (o.signal) { status = "FAIL"; why = `killed by ${o.signal}`; }
  else if (o.code !== 0) { status = "FAIL"; why = `exit ${o.code}`; }
  else if (o.pass !== null && o.total !== null && o.pass < o.total) { status = "FAIL"; why = `${o.pass}/${o.total} checks passed`; }
  else if (s.kind === "node" && o.skipped !== null) {
    if (CI) { status = "FAIL"; why = "SKIPPED under CI=true (CI runs these)"; } else status = "skipped";
  }
  else if (s.kind === "node" && o.total === null) { status = "FAIL"; why = "exit 0 but it ended without its `N/N checks passed` line"; }
  else if (s.kind === "node" && o.total === 0) { status = "FAIL"; why = "0/0 checks: it asserted nothing"; }
  const r: Result = { ...base, status, why };
  console.log(`[runner] ${s.name}: ${status}${why ? " — " + why : ""}${o.total !== null ? ` (${o.pass}/${o.total} checks)` : ""} in ${fmt(o.ms)}`);
  return r;
}

// ---- the summary
function summary(results: readonly Result[], t0: number, fast: boolean): number {
  const w = Math.max(...results.map((r) => r.name.length));
  console.log("\n" + "=".repeat(78) + "\nSUMMARY\n" + "=".repeat(78));
  for (const r of results) {
    const pt = r.total !== null ? `${r.pass}/${r.total}` : "-";
    console.log(`${r.name.padEnd(w)}  ${r.status.padEnd(7)}  ${pt.padStart(9)}  ${r.status === "not run" ? "" : fmt(r.ms).padStart(8)}${r.why ? "  " + r.why : ""}`);
  }
  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "skipped");
  const passed = results.filter((r) => r.status === "pass");
  const notRun = results.filter((r) => r.status === "not run");
  const fastSkipped = notRun.filter((r) => r.fast);
  const interruptedNotRun = notRun.filter((r) => !r.fast);
  console.log(`\n${results.length} suites: ${passed.length} passed, ${failed.length} FAILED, ${skipped.length} skipped${notRun.length ? `, ${notRun.length} not run` : ""} — total ${fmt(Date.now() - t0)}`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((r) => r.name).join(", ")}`);
    for (const r of failed) console.log(`  rerun: ${r.kind === "lint" ? "npm run " + r.file : "node " + (r.file.startsWith(ROOT) ? path.relative(ROOT, r.file) : r.file)}`);
  }
  if (skipped.length) {
    console.log(`SKIPPED (no playwright): ${skipped.map((r) => r.name).join(", ")}`);
    console.log("  warning: CI runs these (D3) — install a browser to run them here: npx playwright install chromium");
  }
  if (fast) console.log(`\n--fast: skipped the probe e2e suites (${fastSkipped.map((r) => r.name).join(", ") || "none picked"}) — this is NOT the full suite: run \`npm test\` before committing; CI runs everything`);
  return failed.length || interruptedNotRun.length ? 1 : 0;
}

// ---- main
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const list = argv.includes("--list");
  const filters = argv.filter((a) => !a.startsWith("-"));
  const fast = argv.includes("--fast");
  const bad = argv.filter((a) => a.startsWith("-") && a !== "--list" && a !== "--fast");
  if (bad.length) { console.error(`run-suites: unknown option ${bad.join(" ")}\n${USAGE}`); return 2; }

  const { suites, custom } = loadSuites();
  if (!custom) {
    const problems = coverageProblems(suites);
    if (problems.length) { for (const p of problems) console.error(`run-suites: ${p}`); return 1; }
  }
  // checked for the real list always (a rename fails `npm test` too), for a test's fake list only under --fast
  const stale = !fast && custom ? [] : FAST_SKIP.filter((n) => !suites.some((s) => s.name === n));
  if (stale.length) { console.error(`run-suites: FAST_SKIP names ${stale.join(", ")} but no such suite is in SUITES — update FAST_SKIP (test/run-suites.ts)`); return 1; }
  let picked = suites;
  if (filters.length) {
    const want = new Set<string>();
    for (const f of filters) {
      const hit = suites.some((s) => s.name === f) ? suites.filter((s) => s.name === f) : suites.filter((s) => s.name.includes(f));
      if (!hit.length) { console.error(`run-suites: no suite matches "${f}" (try --list)`); return 2; }
      for (const s of hit) want.add(s.name);
    }
    picked = suites.filter((s) => want.has(s.name));
  }
  const dropped = (s: Suite): boolean => fast && FAST_SKIP.includes(s.name);
  if (list) {
    for (const s of picked.filter((x) => !dropped(x))) console.log(s.kind === "lint" ? `${s.name}  (npm run ${s.file})` : `${s.name}  ${custom ? s.file : "test/" + path.basename(s.file)}`);
    return 0;
  }

  const t0 = Date.now();
  const results: Result[] = [];
  // The suites run in their own process group (detached), so a signal to the runner never reaches them by itself:
  // forward SIGINT / SIGTERM / SIGHUP (Ctrl-C, `kill`, a closed terminal, a CI cancel) and never exit leaving one behind.
  const stop = (): void => {
    if (interrupted) { if (current) killGroup(current, "SIGKILL"); process.exit(130); }
    interrupted = true;
    const c = current;
    if (c) { killGroup(c, "SIGTERM"); setTimeout(() => killGroup(c, "SIGKILL"), KILL_GRACE_MS).unref(); }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, stop);
  process.on("exit", () => { if (current) killGroup(current, "SIGKILL"); });
  for (const s of picked) {
    if (dropped(s)) { results.push({ name: s.name, kind: s.kind, file: s.file, status: "not run", pass: null, total: null, ms: 0, why: "--fast", skipReason: "", fast: true }); continue; }
    if (interrupted) { results.push({ name: s.name, kind: s.kind, file: s.file, status: "not run", pass: null, total: null, ms: 0, why: "interrupted", skipReason: "" }); continue; }
    const r = await runSuite(s);
    results.push(interrupted && r.status !== "pass" ? { ...r, status: "FAIL", why: "interrupted" } : r);
  }
  const code = summary(results, t0, fast);
  return interrupted ? 130 : code;
}

// process.exitCode, not process.exit(): a piped stdout is async on POSIX and exit() drops what is still queued (the SUMMARY)
if (import.meta.main) process.exitCode = await main();
