// The helpers shared by the browser e2e suites (verify-probe-e2e, -drive-e2e, -drive-tail-e2e, -behaviour-e2e, -visual-e2e):
// the concurrency pool and runNode, the async spawn of one probe / verify-screen process, and verifyCase, a run's own
// verify dir.
//
//   const q = limit(poolSize());          // a queue running at most n of its tasks at once
//   const P = { a: q(() => probe(…)), … }; // queued up front, awaited where their checks are
//
// Each task is still its own `bun verify-probe.ts` process with its own chromium (process isolation is what the suites
// test); this only bounds how many are alive at once.
import { runAsync } from "../design-to-code/proc.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KILL_HOST, killPidTree, type KillHost } from "../design-to-code/kill-tree.ts";
import { runCacheDir } from "../design-to-code/run-cache.ts";
import { setNameOfFile } from "../design-to-code/verify-sets.ts";

export { killPidTree, type KillHost };

/** A queue running at most `n` of its tasks at once, in the order they were queued. A task that throws synchronously rejects
 *  its own promise and still releases its slot (the call goes through `Promise.resolve().then(fn)`). */
export const limit = (n: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const go = (): void => { active++; Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; waiting.shift()?.(); }); };
    if (active < n) go(); else waiting.push(go);
  });
};

export const POOL_MAX = 8;
/** CI is set: a CI value other than "", "0" or "false" (CI=true on GitHub; other runners set CI=1). */
export const isCI = (env: NodeJS.ProcessEnv = process.env): boolean => env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false";
/** How many probe processes a suite runs at once: DT_E2E_POOL when set (an integer, clamped to 1–8 with a warning on stderr; a
 *  non-integer warns and falls back to the default); else 2 when CI is set (any value but "", "0" or "false" — Playwright's CI guide
 *  advises few workers there, and the 4-vCPU hosted runners have no core to spare for a 4th chromium); else half the logical
 *  cores (Playwright's own local default), clamped to 2–4. The drive e2e's cases whose outcome rides on a few seconds of
 *  wall-clock are not pooled: they are a suite of their own (verify-probe-drive-tail-e2e) that runs one probe at a time, so
 *  concurrent chromiums cannot flip them. */
export const poolSize = (env: NodeJS.ProcessEnv = process.env, cores: number = os.availableParallelism(), warn: (msg: string) => void = (m) => { console.error(m); }): number => {
  const raw = env.DT_E2E_POOL;
  if (raw !== undefined && raw !== "") {
    const v = Number(raw);
    if (!Number.isInteger(v)) warn(`DT_E2E_POOL=${JSON.stringify(raw)} is not an integer — ignored`);
    else if (v < 1 || v > POOL_MAX) { const c = Math.min(POOL_MAX, Math.max(1, v)); warn(`DT_E2E_POOL=${v} is outside 1–${POOL_MAX} — using ${c}`); return c; }
    else return v;
  }
  if (isCI(env)) return 2;
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
};

/** What runNode resolves with: the exit status (null when the process was killed by a signal or never started), the captured
 *  output, spawn → close in ms (never the time a run waited in a pool queue), whether killAfterMs fired, and whether that kill
 *  ended the run's whole process tree (killTree's result: false when it fell back to the child alone, or the run was not killed). */
export interface Run { status: number | null; stdout: string; stderr: string; ms: number; killed: boolean; treeKilled: boolean }

/** Ends `p` and its descendants (killPidTree) and returns true, else kills `p` alone and returns false: SIGKILL to the child
 *  when it has no pid or the tree kill failed. */
export const killTree = (p: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }, host: KillHost = KILL_HOST): boolean => {
  if (p.pid !== undefined && killPidTree(p.pid, host)) return true;
  p.kill("SIGKILL");
  return false;
};

/** Runs `bun <script> ...args` in `cwd` asynchronously (a suite's server lives in the test's own process, so a spawnSync
 *  would stop it answering). Never rejects and never hangs on a failed start: a spawn that throws synchronously or emits
 *  "error" (EAGAIN under load) resolves with status null and "spawn failed: <message>" appended to stderr.
 *  killAfterMs > 0: a run that has not closed by then is killed with everything it started (POSIX: the child leads its own
 *  process group and the group gets SIGKILL; Windows: taskkill /T /F by pid; the child alone when that fails — treeKilled
 *  says which) and reported killed — a hung process fails the test instead of hanging it. `bun` is the running binary
 *  (process.execPath), so a script path or `-e` source both work.
 *  `env`: the child's WHOLE environment, passed to spawn as is — it replaces this process's, nothing is merged (a caller that
 *  wants to add a variable spreads process.env itself); omitted, the child inherits this process's.
 *  It goes through runAsync (design-to-code/proc.ts), so it settles on close, on exit + the pipes' end, on an exit the runtime
 *  reported before the listeners existed (Bun #45483), or on a pid its liveness poll finds gone (#45365) — a run recovered
 *  that way carries a `[spawn-helper] …` line in stderr, so a check on the output still sees something went wrong. */
export const runNode = async (cwd: string, script: string, args: string[], killAfterMs = 0, env?: NodeJS.ProcessEnv): Promise<Run> => {
  let treeKilled = false;
  const { done } = runAsync(process.execPath, [script, ...args], {
    cwd, ...(env !== undefined ? { env } : {}), detached: killAfterMs > 0 && process.platform !== "win32",
    ...(killAfterMs > 0 ? { timeoutMs: killAfterMs } : {}), kill: (c) => (treeKilled = killTree(c)),
  });
  const r = await done;
  // a killed run's status is null everywhere (Windows: a process ended by taskkill or TerminateProcess exits with code 1)
  const stderr = r.stderr + (r.error ? `spawn failed: ${r.error.message}\n` : "") + (r.lost && !r.timedOut ? `[spawn-helper] ${r.lost}\n` : "");
  return { status: r.timedOut || r.error ? null : r.status, stdout: r.stdout, stderr, ms: r.ms, killed: r.timedOut, treeKilled };
};

/** A run's own verify dir (verifyCase): the dir, the expectation's copy in it and the set's base there (`<dir>/<set>`). */
export interface VerifyCase { dir: string; expected: string; base: string }
const caseDirs: string[] = [];
/** A verify dir of one run's own, `<src's dir>/<name>/`, holding a byte-identical copy of the expectation `src` under its
 *  own file name: the same sha, the same set name. A set has ONE status base (statusBaseOf: `<its dir>/<set>`), so two
 *  probes of one set in one dir refuse each other (another run is open) — each pooled run, and each run that leaves its
 *  status open, measures from a dir of its own. Paths are relative to `proj` when `src` is. dropCaseCaches removes the
 *  dir's run cache. */
export const verifyCase = (proj: string, name: string, src: string): VerifyCase => {
  const dir = path.join(path.dirname(src), name), expected = path.join(dir, path.basename(src));
  fs.mkdirSync(path.resolve(proj, dir), { recursive: true });
  fs.copyFileSync(path.resolve(proj, src), path.resolve(proj, expected));
  caseDirs.push(path.resolve(proj, dir));
  return { dir, expected, base: path.join(dir, setNameOfFile(src)) };
};
/** Removes the run cache (live statuses, stage dirs, locks) of every dir verifyCase made — in a project without a
 *  package.json it is under the OS temp dir, never removed with the suite's temp tree. Called by a suite's finish(),
 *  before the case dirs themselves go (the cache is keyed by the dir's real path). */
export const dropCaseCaches = (): void => {
  for (const d of caseDirs.splice(0)) {
    try { fs.rmSync(runCacheDir(d), { recursive: true, force: true }); } catch { /* a cache left read-only by a failed check */ }
  }
};
