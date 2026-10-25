// clock.ts — the one seam every timed rule in the bridge runs on: what time it is, and "call me in ms".
//
// The rules themselves (a request's budget and stall check, pending-requests.ts; the daemon client's silence guard,
// daemon.ts) take a Clock instead of reaching for setTimeout and Date.now, so the suites drive them with a fake one
// (test/fake-clock.ts) and step time by hand instead of sleeping on the wall clock. systemClock is the adapter every
// running process uses. No load-time effects.

/** What a timed rule reads and arms. `now` is monotonic ms (only differences mean anything). `after` runs `fn` once,
 *  `ms` from now, and answers the function that cancels it — a no-op once it has run, or when called twice. `unref`:
 *  the timer must never be what keeps the process alive (an idle check); without it a pending timer holds the loop
 *  open, as a plain setTimeout does. */
export interface Clock {
  now(): number;
  after(ms: number, fn: () => void, o?: { unref?: boolean }): () => void;
}

/** The real timers: performance.now() (a wall-clock step can neither end nor stretch a wait) and setTimeout. */
export const systemClock: Clock = {
  now: () => performance.now(),
  after(ms, fn, o) {
    const t = setTimeout(fn, ms);
    if (o?.unref) t.unref();
    return () => { clearTimeout(t); };
  },
};

/** A deadline `ms` after it was (re)armed. `rearm` starts the whole window over from now — whether it was still
 *  armed or not; `cancel` disarms it for good (until a rearm). It expires at most once per arming. */
export interface Deadline {
  rearm(): void;
  cancel(): void;
  readonly armed: boolean;
}

/** Arms a deadline on `clock` now: `onExpire` runs `ms` from now unless it is cancelled or re-armed first. */
export function deadline(clock: Clock, ms: number, onExpire: () => void): Deadline {
  let stop: (() => void) | null = null;
  const cancel = (): void => { if (stop) { stop(); stop = null; } };
  const rearm = (): void => {
    cancel();
    stop = clock.after(ms, () => { stop = null; onExpire(); });
  };
  rearm();
  return { rearm, cancel, get armed() { return stop !== null; } };
}
