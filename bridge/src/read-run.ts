// read-run.ts — one read, executed once: a read plan (read-plan.ts) sent through a route (route.ts), its progress
// relayed, cancellable, timed, and its reply stamped with WHICH connected Figma file answered (source-stamp.ts) before
// anything can write it out.
//
// Both front-ends ran this sequence themselves — the MCP server's pull() and the CLI's timed send plus timedWrite —
// each with its own clock, its own reading of the plugin's progress ticks, and its own `stampSource(...)` call that
// nothing made it remember. What is left to them is delivery: the CLI prints and writes (figma-pull.ts), the MCP server
// decides inline / written / refused (delivery.ts) and turns ticks into progress notifications.
//
// The rules it owns:
//   - the plan is sent as planned: its command, arguments and budget, to the target the caller names.
//   - progress: every tick reaches the caller's onProgress and the meter; the first `queued` tick (the run waits behind
//     another in that file) is said once through onQueued; tickMessage words a tick (MCP's progress message).
//     A run that asks for none of these asks the route for no ticks at all.
//   - the clock: durationMs().request is the time inside the request (the meter's sent/replied included), writeMs the time
//     inside write(), and total the run so far. A tally, when given, adds both to the caller's running totals
//     (the CLI's `done in …` line and its DTWIN_TIMINGS record).
//   - the stamp: the reply a run hands out is already stamped — write() hands it to the writer, so a writer never
//     sees an unstamped reply.
import { stampSource } from "./source-stamp.ts";
import type { Commands, Cmd } from "./commands.ts";
import type { PlanOf, ReadCmd } from "./read-plan.ts";
import type { Route, Sent } from "./route.ts";
import type { ProgressTick } from "./server-core.ts";
import type { Stamped } from "./write-out.ts";

/** What hears a run's request, reply and ticks (timings.ts StageClock is one). */
export interface ReadMeter {
  sent(): void;
  replied(reply: unknown): void;
  tick(phase: string | null): void;
}

/** Running totals a run adds its time to. */
export interface ReadTally { exportMs: number; writeMs: number }

/** How a request is measured: the meter that hears it, the totals it adds to, the clock. */
export interface Metering {
  meter?: ReadMeter | null | undefined;
  tally?: ReadTally | undefined;
  now?: (() => number) | undefined;
}

export interface ReadRunOptions extends Metering {
  /** which connected file (route.ts resolves it) */
  target?: string | null | undefined;
  signal?: AbortSignal | undefined;
  /** every progress tick, as it arrives */
  onProgress?: ((tick: ProgressTick) => void) | undefined;
  /** once, at the first `queued` tick */
  onQueued?: (() => void) | undefined;
}

/** One read, answered: its reply stamped with its source, and its clock. */
export interface ReadRun<C extends ReadCmd> {
  readonly reply: Stamped<Commands[C]["reply"]>;
  /** Runs the write-out on the stamped reply, timed. */
  write<W>(out: (reply: Stamped<Commands[C]["reply"]>) => W): W;
  /** total since the run started, the request, the write (0 until written) */
  durationMs(): { total: number; request: number; write: number };
}

/** One request, measured: the meter hears it sent and answered, and its time is added to the tally's exportMs —
 *  a read's or any other command's (the CLI's index commands count toward the same line). */
export async function meteredRequest<C extends Cmd>(request: () => Promise<Sent<C>>, m: Metering = {}): Promise<{ sent: Sent<C>; ms: number }> {
  const now = m.now ?? Date.now;
  const t = now();
  m.meter?.sent();
  let ms: number | undefined;
  try {
    const sent = await request();
    m.meter?.replied(sent.reply);
    ms = now() - t;
    return { sent, ms };
  } finally {
    // a request that fails counts too, up to its failure
    if (m.tally) m.tally.exportMs += ms ?? now() - t;
  }
}

/** A tick, said: its phase, then where the walk is ("pages, page 2 of 3 (Home), 120 nodes, 4 assets"). */
export function tickMessage(t: ProgressTick): string {
  const parts = [t.phase ?? "export"];
  if (t.page) parts.push(`page ${t.page.index} of ${t.page.of}${t.page.name ? ` (${t.page.name})` : ""}`);
  if (t.nodes !== null) parts.push(`${t.nodes} nodes`);
  if (t.assets !== null) parts.push(`${t.assets} assets`);
  return parts.join(", ");
}

/** Runs `plan` through `route`. Rejects as the request does (a refusal, a timeout, a cancel). */
export async function runRead<C extends ReadCmd>(route: Pick<Route, "request">, plan: PlanOf<C>, o: ReadRunOptions = {}): Promise<ReadRun<C>> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const { meter, onProgress, onQueued } = o;
  let queued = false;
  const onTick = meter || onProgress || onQueued
    ? (tick: ProgressTick): void => {
      meter?.tick(tick.phase);
      if (tick.phase === "queued" && !queued) { queued = true; onQueued?.(); }
      onProgress?.(tick);
    }
    : undefined;
  const { sent, ms: requestMs } = await meteredRequest(
    () => route.request(plan.cmd, plan.args, { timeoutMs: plan.timeout, target: o.target, onProgress: onTick, signal: o.signal }), o);
  const reply = stampSource(sent);
  let writeMs = 0;
  return {
    reply,
    write(out) {
      const t = now();
      try { return out(reply); } finally {
        const ms = now() - t;
        writeMs += ms;
        if (o.tally) o.tally.writeMs += ms;
      }
    },
    durationMs: () => ({ total: now() - t0, request: requestMs, write: writeMs }),
  };
}
