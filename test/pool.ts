// The concurrency helpers shared by the browser e2e suites (verify-probe-drive-e2e, -behaviour-e2e, -visual-e2e).
//
//   const q = limit(poolSize());          // a queue running at most n of its tasks at once
//   const P = { a: q(() => probe(…)), … }; // queued up front, awaited where their checks are
//
// Each task is still its own `node verify-probe.js` process with its own chromium (process isolation is what the suites
// test); this only bounds how many are alive at once.
import os from "node:os";

/** A queue running at most `n` of its tasks at once, in the order they were queued. */
export const limit = (n: number) => {
  let active = 0;
  const waiting: Array<() => void> = [];
  return <T>(fn: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const go = (): void => { active++; fn().then(resolve, reject).finally(() => { active--; waiting.shift()?.(); }); };
    if (active < n) go(); else waiting.push(go);
  });
};

/** How many probe processes a suite runs at once: DT_E2E_POOL when set (≥ 1); else 2 under CI=true (Playwright's CI guide
 *  advises few workers there — the 4-vCPU hosted runners have no core to spare for a 4th chromium); else half the logical
 *  cores (Playwright's own local default), clamped to 2–4. Cases whose outcome rides on wall-clock windows do not use the
 *  pool: each suite runs them one at a time after it (its serial tail). */
export const poolSize = (env: NodeJS.ProcessEnv = process.env, cores: number = os.availableParallelism()): number => {
  const v = Number(env.DT_E2E_POOL);
  if (env.DT_E2E_POOL !== undefined && env.DT_E2E_POOL !== "" && Number.isInteger(v) && v >= 1) return v;
  if (env.CI === "true") return 2;
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
};
