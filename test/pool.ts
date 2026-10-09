// The helpers shared by the browser e2e suites (verify-probe-e2e, -drive-e2e, -behaviour-e2e, -visual-e2e): the concurrency
// pool and runNode, the async spawn of one probe / verify-screen process.
//
//   const q = limit(poolSize());          // a queue running at most n of its tasks at once
//   const P = { a: q(() => probe(…)), … }; // queued up front, awaited where their checks are
//
// Each task is still its own `node verify-probe.js` process with its own chromium (process isolation is what the suites
// test); this only bounds how many are alive at once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

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
 *  cores (Playwright's own local default), clamped to 2–4. Only the drive e2e has a serial tail: its cases whose outcome rides
 *  on a few seconds of wall-clock run one at a time after the pool has drained, so concurrent chromiums cannot flip them. */
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
 *  output, spawn → close in ms (never the time a run waited in a pool queue), and whether killAfterMs fired. */
export interface Run { status: number | null; stdout: string; stderr: string; ms: number; killed: boolean }

/** Runs `node <script> ...args` in `cwd` asynchronously (a suite's server lives in the test's own process, so a spawnSync
 *  would stop it answering). Never rejects and never hangs on a failed start: a spawn that throws synchronously or emits
 *  "error" (EAGAIN under load) resolves with status null and "spawn failed: <message>" appended to stderr.
 *  killAfterMs > 0: a run that has not closed by then is SIGKILLed (by its pid) and reported killed — a hung process fails the
 *  test instead of hanging it. `node` is the running binary (process.execPath), so a script path or `-e` source both work. */
export const runNode = (cwd: string, script: string, args: string[], killAfterMs = 0): Promise<Run> => new Promise((resolve) => {
  const t0 = Date.now();
  let p: ChildProcessWithoutNullStreams;
  try { p = spawn(process.execPath, [script, ...args], { cwd }); }
  catch (e) { resolve({ status: null, stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}\n`, ms: Date.now() - t0, killed: false }); return; }
  let stdout = "", stderr = "", killed = false;
  const timer = killAfterMs > 0 ? setTimeout(() => { killed = true; p.kill("SIGKILL"); }, killAfterMs) : undefined;
  p.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  p.on("error", (e) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}spawn failed: ${e.message}\n`, ms: Date.now() - t0, killed }); });
  p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, ms: Date.now() - t0, killed }); });
});
