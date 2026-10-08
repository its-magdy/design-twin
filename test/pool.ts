// The concurrency helpers shared by the browser e2e suites (verify-probe-drive-e2e, -behaviour-e2e, -visual-e2e).
//
//   const q = limit(poolSize());          // a queue running at most n of its tasks at once
//   const P = { a: q(() => probe(…)), … }; // queued up front, awaited where their checks are
//
// Each task is still its own `node verify-probe.js` process with its own chromium (process isolation is what the suites
// test); this only bounds how many are alive at once.
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
