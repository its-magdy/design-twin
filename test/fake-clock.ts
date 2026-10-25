// The fake adapter of bridge/src/clock.ts's Clock: time moves only when a test says so (`advance`), and every timer
// due by then runs, in due order (same due time: in the order armed), including one armed by an earlier timer within
// the same advance. `armed()` is how many timers are still waiting — 0 once every rule under test has settled.
import type { Clock } from "../bridge/src/clock.ts";

export interface FakeClock extends Clock {
  /** move time forward by `ms`, running every timer that comes due on the way */
  advance(ms: number): void;
  /** timers armed and neither run nor cancelled */
  armed(): number;
}

export function fakeClock(start = 0): FakeClock {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const next = (): [number, { at: number; fn: () => void }] | undefined => {
    let best: [number, { at: number; fn: () => void }] | undefined;
    for (const e of timers) if (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0])) best = e;
    return best;
  };
  return {
    now: () => now,
    after(ms, fn) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return () => { timers.delete(id); };
    },
    advance(ms) {
      const until = now + ms;
      for (let e = next(); e && e[1].at <= until; e = next()) {
        timers.delete(e[0]);
        now = e[1].at;
        e[1].fn();
      }
      now = until;
    },
    armed: () => timers.size,
  };
}
