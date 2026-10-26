// The test runner behind `bun run test`.
//   bun test/run-suites.ts                run both lints, then every suite, in order
//   bun test/run-suites.ts bridge verify-probe-e2e    only the named suites (exact name, else substring), in order
//   bun test/run-suites.ts --list         print the order and exit (the coverage guard still runs)
//   bun test/run-suites.ts --fast         everything except the four slow probe e2e suites (`bun run test:fast`, ~3 min vs ~20)
//   bun test/run-suites.ts --fast --list  what --fast would run
// (Not a bare `bun test`: that is Bun's own jest-style runner, which would take every test/*.test.ts for a bun:test file —
// bunfig.toml's [test] root points it at test/spawn-stress/, the only bun:test files, instead.)
//
// --fast: the name filters (if any) pick the suites first, then FAST_SKIP is dropped from that pick. The dropped suites
// stay in the SUMMARY as `not run` (why `--fast`) and do NOT make the exit code 1 — `not run` otherwise means an
// interruption, which does — but the run ends with a loud line saying it was not the full suite (CI runs it as one
// leg of a matrix whose other legs name the skipped suites; under CI --fast is still allowed and still prints it).
// If --fast drops EVERY picked suite (e.g. only a slow one was named) nothing runs: that is exit 2, not a green 0.
// A FAST_SKIP name that is not in SUITES exits 1, so a rename cannot silently drop a suite from the skip list.
//
// It replaced a 40-link `a && b && c` chain: the first non-zero exit skipped every later suite, there was no
// summary and no timing, and a suite that exited 0 without printing its `N/N checks passed` line went unnoticed.
// Here every suite runs even after a failure, strictly one at a time (the e2e suites drive a real browser and
// several suites bind ports; two at once starve each other — and a spawn can fail with EAGAIN when too many
// children are alive), its output is forwarded live, and the end prints one row per suite.
//
// A suite is `bun <file>` and a lint `bun run --silent <script>`, both with the running bun (process.execPath). Each gets
// BUN_OPTIONS with --no-install and --no-env-file added to any the caller set: Bun would otherwise auto-install a package a
// test resolves from a dir with no node_modules (fetching from npm mid-test), and load a `.env` from a suite's cwd into
// process.env — the two flags every user-facing invocation carries (the plugin's hooks, .mcp.json, the bin shebang).
// BUN_OPTIONS is in the environment, so it also reaches every bun the suites start in turn.
//
// A suite FAILS when it exits non-zero or by signal, prints `p/t checks passed` with p < t, runs past the cap
// (DT_SUITE_TIMEOUT_MS, default 30 min — the slowest suites, the two drive e2e halves, take ~3–4 each), exits 0 WITHOUT a checks
// line (it ended before its summary) or with `0/0` (it asserted nothing), or its exit is lost (below). It is never re-run: the only retry is for a spawn that never ran
// (EAGAIN/ENOMEM), once, after DT_SPAWN_RETRY_MS (default 5 s). A suite that prints `SKIPPED (no playwright…)`
// and exits 0 is `skipped`: a warning locally, a FAILURE under CI (any CI value but "", "0" or "false"; the browser suites already exit
// non-zero in CI; this is belt and braces over their own rule).
//
// The verdict is the suite's exit, taken the first way it arrives: the exit event; an exit Bun already recorded inside
// spawn(), before any listener existed (oven-sh/bun #45483, seen on macOS); or, when the runtime never reports it at all
// (#45365, a child never reaped), a liveness poll (every 250 ms) that finds the pid gone or a zombie with no exit event
// for 2 s — that suite FAILS as `exit lost` there and then instead of sitting out the 30 min cap.
//
// The runner's own lines go through the stdout stream's queue (installQueuedConsole: Bun's console.* writes the fd
// directly and drops what meets a full pipe, and can overtake the suites' output forwarded through the stream) and it
// ends with process.exitCode, never process.exit(): exit() drops what is still queued (the SUMMARY) under a slow reader.
//
// SIGINT / SIGTERM / SIGHUP to the runner stop the running suite's process group (TERM, then KILL after the grace)
// and mark the rest `not run`; the summary still prints and the exit is 130.
//
// Every test/*.test.ts (+ harness.ts) on disk must be in SUITES and every SUITES file must exist, else the runner
// exits 1 naming it — a new suite cannot be forgotten.
//
// Test seams (test/run-suites.test.ts): DT_RUN_SUITES_LIST=<json file> replaces SUITES with an array of
// `{ name, file, kind? }` (kind "suite" — the default — or "lint"; file absolute; coverage guard off); DT_RUN_SUITES_DIR=<dir>
// is the directory the guard scans and the suites are resolved in (default: this directory); DT_KILL_GRACE_MS (default
// 10 s) is the wait between SIGTERM and SIGKILL for a timed-out or interrupted suite; DT_DRAIN_MS (default 2 s) is how
// long the runner still reads a suite's pipes after it EXITED (a grandchild that inherited them can hold them open for good);
// DT_RUNNER_DROP_EXIT=1 makes the runner ignore every exit/close event (Bun #45365's shape), so only the liveness poll can end a suite.
// `command()` and `bunOptions()` are exported for the self-test (the runner itself only runs when executed directly).
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isCI } from "./pool.ts";
import { goneOrZombie, installQueuedConsole } from "../design-to-code/proc.ts";
import { setTimeout as sleep } from "node:timers/promises";

type Kind = "lint" | "suite";
interface Suite { name: string; kind: Kind; file: string }
type Status = "pass" | "FAIL" | "skipped" | "not run";
interface Result { name: string; kind: Kind; file: string; status: Status; pass: number | null; total: number | null; ms: number; why: string; skipReason: string; fast?: boolean }
interface Outcome { code: number | null; signal: NodeJS.Signals | null; spawnError: NodeJS.ErrnoException | null; timedOut: boolean; lostExit: string | null; pass: number | null; total: number | null; skipped: string | null; ms: number }

const HERE = process.env.DT_RUN_SUITES_DIR ? path.resolve(process.env.DT_RUN_SUITES_DIR) : import.meta.dirname;
const ROOT = path.resolve(import.meta.dirname, "..");
const num = (v: string | undefined, d: number): number => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
const TIMEOUT_MS = num(process.env.DT_SUITE_TIMEOUT_MS, 30 * 60_000);
const RETRY_MS = num(process.env.DT_SPAWN_RETRY_MS, 5_000);
const KILL_GRACE_MS = num(process.env.DT_KILL_GRACE_MS, 10_000);
const DRAIN_MS = num(process.env.DT_DRAIN_MS, 2_000);
const POLL_MS = 250, LOST_AFTER = 8; // the liveness poll: 8 strikes × 250 ms with the pid gone and no exit event
const DROP_EXIT = process.env.DT_RUNNER_DROP_EXIT === "1"; // test seam: never listen for exit/close (as if the runtime lost them)
const CI = isCI(process.env); // the same rule as the probe pool (test/pool.ts)
// BUN_OPTIONS for every suite and lint (see the header): the caller's own options first, each of ours added once.
const BUN_FLAGS: readonly string[] = ["--no-install", "--no-env-file"];
export const bunOptions = (have: string | undefined): string => {
  const own = (have ?? "").split(/\s+/).filter(Boolean);
  return [...own, ...BUN_FLAGS.filter((f) => !own.includes(f))].join(" ");
};
const SUITE_ENV: NodeJS.ProcessEnv = { ...process.env, BUN_OPTIONS: bunOptions(process.env.BUN_OPTIONS) };

// The exact order the old `npm test` chain ran in (the lints first, then the plugin extractor, the bridge, the rest).
const SUITE_FILES: readonly string[] = [
  // the real-name guard, right after the lints (fast, repo-wide)
  "real-names.test.ts",
  "harness.ts", "bridge.test.ts", "pending-requests.test.ts", "served-session.test.ts", "await-client.test.ts", "bridge-route.test.ts", "bridge-holder.test.ts", "settings.test.ts", "daemon-framing.test.ts", "cli-help.test.ts", "figma-pull-args.test.ts", "read-plan.test.ts", "ports.test.ts", "cli-pull.test.ts", "read-plan-e2e.test.ts", "asset-compare.test.ts", "asset-index.test.ts", "asset-key-cache.test.ts", "write-out-bookkeeping.test.ts", "quick-keys.test.ts", "design-to-code.test.ts", "tokens-cli.test.ts", "g14-step0.test.ts", "cli-exit.test.ts", "atomic-write.test.ts", "file-lock.test.ts",
  "audit.test.ts", "build-screen-docs.test.ts", "verify-build.test.ts", "verifier-guard.test.ts", "plugin-hooks.test.ts", "plan-record.test.ts", "verify-screen.test.ts", "verify-migrate.test.ts", "verify-accuracy.test.ts", "verify-values.test.ts",
  "verify-waivers.test.ts", "verify-node-rules.test.ts", "verify-run.test.ts", "verify-behaviour.test.ts",
  "verify-integrity.test.ts", "verify-probe.test.ts", "pw-errors.test.ts", "probe-session.test.ts", "verify-probe-e2e.test.ts", "verify-drive.test.ts",
  "verify-probe-drive-e2e.test.ts", "verify-probe-drive-tail-e2e.test.ts", "verify-own-pixels.test.ts", "verify-probe-behaviour-e2e.test.ts",
  "visual-diff.test.ts", "verify-visual.test.ts", "verify-probe-visual-e2e.test.ts", "cross-check.test.ts", "visible-tree.test.ts",
  "design-diff.test.ts", "identity.test.ts", "plan-skeleton.test.ts", "resolve-screen.test.ts", "export-reader.test.ts", "screen-inputs.test.ts", "node-artefacts.test.ts", "audit-gate.test.ts", "report-freshness.test.ts", "plan-binding.test.ts", "session-claim.test.ts", "verification-evidence.test.ts", "plan-status.test.ts", "verify-sets.test.ts", "token-naming.test.ts", "variable-resolve.test.ts", "drift-lint-run.test.ts", "code-scanner.test.ts", "screen-key.test.ts", "ui.test.ts", "plugin-es2019.test.ts",
  "daemon-auth.test.ts", "daemon-sock.test.ts", "mcp-share.test.ts", "mcp-smoke.test.ts", "mcp-lifecycle.test.ts", "mcp-delivery.test.ts", "json-size.test.ts",
  // this runner's own self-test (fast, so early)
  "run-suites.test.ts",
];
// The slow browser suites `--fast` leaves out (~17 of the ~19 min); everything else is quick.
const FAST_SKIP: readonly string[] = ["verify-probe-e2e", "verify-probe-drive-e2e", "verify-probe-drive-tail-e2e", "verify-probe-behaviour-e2e"];
const USAGE = "usage: bun test/run-suites.ts [--list] [--fast] [suite-name…]";
const baseName = (f: string): string => f.replace(/\.test\.ts$/, "").replace(/\.ts$/, "");
const SUITES: readonly Suite[] = [
  { name: "lint:any", kind: "lint", file: "lint:any" },
  { name: "lint:types", kind: "lint", file: "lint:types" },
  ...SUITE_FILES.map((f): Suite => ({ name: baseName(f), kind: "suite", file: f })),
];

// ---- the suite list (real, or a test's)
function loadSuites(): { suites: readonly Suite[]; custom: boolean } {
  const listFile = process.env.DT_RUN_SUITES_LIST;
  if (!listFile) return { suites: SUITES.map((s) => (s.kind === "suite" ? { ...s, file: path.join(HERE, s.file) } : s)), custom: false };
  const raw = JSON.parse(fs.readFileSync(listFile, "utf8")) as { name: string; file: string; kind?: Kind }[];
  return { suites: raw.map((e): Suite => ({ name: e.name, kind: e.kind ?? "suite", file: e.file })), custom: true };
}

// Every test/*.test.ts + harness.ts must be listed; every listed suite file must exist. Returns the problems.
function coverageProblems(suites: readonly Suite[]): string[] {
  const onDisk = fs.readdirSync(HERE).filter((f) => f.endsWith(".test.ts") || f === "harness.ts");
  const listed = new Set(suites.filter((s) => s.kind === "suite").map((s) => path.basename(s.file)));
  const out: string[] = [];
  for (const f of onDisk) if (!listed.has(f)) out.push(`test/${f} exists but is not in SUITES (test/run-suites.ts) — add it`);
  for (const s of suites) if (s.kind === "suite" && !fs.existsSync(s.file)) out.push(`SUITES lists ${path.basename(s.file)} but ${s.file} does not exist`);
  return out;
}

// ---- running one suite
const fmt = (ms: number): string => {
  if (ms < 60_000) return (ms / 1000).toFixed(1) + "s";
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

// `detached` puts the suite in its own process group (one kill reaches its children). Not on Windows: there it
// opens a console window per suite, and the group kill does not exist anyway.
// Both kinds run the running bun (process.execPath: a real executable on every OS, so Windows needs no cmd.exe shim, as
// npm.cmd did). A lint is `bun run --silent <script>`: the package.json script is the single source of its command line
// (`bun run` rejects npm's `-s`; an npm_execpath is not consulted — whatever started the runner, the lints run under bun).
export function command(s: Suite, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; detached: boolean } {
  const detached = platform !== "win32";
  if (s.kind === "suite") return { cmd: process.execPath, args: [s.file], detached };
  return { cmd: process.execPath, args: ["run", "--silent", s.file], detached };
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
    const out: Outcome = { code: null, signal: null, spawnError: null, timedOut: false, lostExit: null, pass: null, total: null, skipped: null, ms: 0 };
    const { cmd, args, detached } = command(s);
    let child: ChildProcess;
    try { child = spawn(cmd, args, { cwd: ROOT, env: SUITE_ENV, stdio: ["ignore", "pipe", "pipe"], detached }); }
    catch (e) { out.spawnError = e as NodeJS.ErrnoException; out.ms = Date.now() - t0; resolve(out); return; }
    current = child;
    let done = false, exited = false, outEnded = false, errEnded = false;
    let graceTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined, live: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (done) return;
      done = true; if (termed.has(child)) killGroup(child, "SIGKILL"); clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(drainTimer); clearInterval(live); current = null; out.ms = Date.now() - t0; resolve(out);
    };
    // line-wise scan of both streams (the checks line / SKIPPED line can arrive split across chunks)
    const scan = (line: string): void => {
      const m = /^(\d+)\/(\d+) checks passed$/.exec(line.trim());
      if (m) { out.pass = Number(m[1]); out.total = Number(m[2]); }
      const k = /SKIPPED \(no playwright[^\n]*/.exec(line);
      if (k) out.skipped = k[0];
    };
    // The verdict is the suite's own exit. Its pipes normally end at once after it, but a grandchild that inherited them
    // (a daemon a suite started) can hold them open for good: read on for DRAIN_MS, then drop them.
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exited) return;
      exited = true; out.code = code; out.signal = signal;
      if (outEnded && errEnded) { finish(); return; }
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, DRAIN_MS);
      drainTimer.unref();
    };
    const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream, ended: () => void): void => {
      let buf = "";
      stream?.on("data", (d: Buffer) => {
        sink.write(d);
        buf += d.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) scan(l);
        if (buf.length > 64 * 1024) buf = buf.slice(-4096); // a runaway unterminated line
      });
      stream?.on("end", () => { if (buf) scan(buf); buf = ""; ended(); if (exited && outEnded && errEnded) finish(); });
    };
    pipe(child.stdout, process.stdout, () => { outEnded = true; });
    pipe(child.stderr, process.stderr, () => { errEnded = true; });
    const timer = setTimeout(() => {
      out.timedOut = true;
      killGroup(child, "SIGTERM");
      graceTimer = setTimeout(() => { killGroup(child, "SIGKILL"); graceTimer = setTimeout(finish, 5_000); graceTimer.unref(); }, KILL_GRACE_MS);
      graceTimer.unref();
    }, TIMEOUT_MS);
    child.on("error", (e: NodeJS.ErrnoException) => { out.spawnError = e; finish(); });
    if (!DROP_EXIT) {
      child.on("exit", onExit);
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => { onExit(code, signal); finish(); });
      // #45483: the exit may already have been emitted inside spawn(), before these listeners — the child still recorded it
      if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
    }
    // #45365 / any lost event: a pid that is gone (or a zombie) with no exit event ends the suite here, flagged, not at the cap
    let strikes = 0;
    live = setInterval(() => {
      if (done || exited || child.pid === undefined) return;
      if (!goneOrZombie(child.pid, outEnded && errEnded)) { strikes = 0; return; }
      if (++strikes < LOST_AFTER) return;
      out.lostExit = `pid ${child.pid} ended but no exit event arrived in ${fmt(strikes * POLL_MS)} (the runtime lost it)`;
      if (outEnded && errEnded) { finish(); return; }
      exited = true;
      drainTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, DRAIN_MS);
      drainTimer.unref();
    }, POLL_MS);
    live.unref();
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
  else if (o.lostExit !== null) { status = "FAIL"; why = `exit lost: ${o.lostExit}`; }
  else if (o.signal) { status = "FAIL"; why = `killed by ${o.signal}`; }
  else if (o.code !== 0) { status = "FAIL"; why = `exit ${o.code}`; }
  else if (o.pass !== null && o.total !== null && o.pass < o.total) { status = "FAIL"; why = `${o.pass}/${o.total} checks passed`; }
  else if (s.kind === "suite" && o.skipped !== null) {
    if (CI) { status = "FAIL"; why = "SKIPPED under CI (CI runs these)"; } else status = "skipped";
  }
  else if (s.kind === "suite" && o.total === null) { status = "FAIL"; why = "exit 0 but it ended without its `N/N checks passed` line"; }
  else if (s.kind === "suite" && o.total === 0) { status = "FAIL"; why = "0/0 checks: it asserted nothing"; }
  const r: Result = { ...base, status, why };
  console.log(`[runner] ${s.name}: ${status}${why ? " — " + why : ""}${o.total !== null ? ` (${o.pass}/${o.total} checks)` : ""} in ${fmt(o.ms)}`);
  return r;
}

// ---- the summary
const rerun = (r: Result): string => r.kind === "lint" ? `bun run ${r.file}` : `bun ${r.file.startsWith(ROOT) ? path.relative(ROOT, r.file) : r.file}`;
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
    for (const r of failed) console.log(`  rerun: ${rerun(r)}`);
  }
  if (skipped.length) {
    console.log(`SKIPPED (no playwright): ${skipped.map((r) => r.name).join(", ")}`);
    console.log("  warning: CI runs these — install a browser to run them here: bunx --bun playwright install chromium");
  }
  if (fast) console.log(`\n--fast: skipped ${fastSkipped.length} of the probe e2e suites (${fastSkipped.map((r) => r.name).join(", ") || "none picked"}) — this is NOT the full suite: run \`bun run test\` before committing; CI's other matrix legs run them`);
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
  // checked for the real list always (a rename fails `bun run test` too), for a test's fake list only under --fast
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
    for (const s of picked.filter((x) => !dropped(x))) console.log(s.kind === "lint" ? `${s.name}  (bun run ${s.file})` : `${s.name}  ${custom ? s.file : "test/" + path.basename(s.file)}`);
    return 0;
  }

  if (fast && picked.length > 0 && picked.every(dropped)) { console.error("run-suites: nothing to run — every picked suite is a --fast skip"); return 2; }

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

// process.exitCode, not process.exit(): a piped stdout is async and exit() drops what is still queued (the SUMMARY)
if (import.meta.main) { installQueuedConsole(); process.exitCode = await main(); }
