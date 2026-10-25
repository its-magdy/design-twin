// The run scheduler: which run executes when, and the bracket that gives each executing run its own context
// (run.ts) and releases it when the run settles. Plus the one blanket document load (loadAllPages).

import { errMsg } from "./util";
import { abandonedError, isAbandonment, postQueued, postRunBegin, postRunEnd, postStarted, requestAbandon, type RunInfo } from "./progress";
import { closeRun, openRun } from "./run";
import type { RunKind } from "../../bridge/src/commands.ts";

// Serialize every state-mutating run. A run's context is ambient (run.ts — the one run in progress), and the
// document toggles a walk sets (figma.skipInvisibleInstanceChildren) are global, so two overlapping runs — a
// double-click, or a bridge pull arriving mid manual export — would read each other's context and emit
// corrupted/truncated output. Route each run through this tail-promise chain so they execute one at a time. fn is always
// invoked with no args (the prior run's result must never leak in as an argument), and a failed run
// still lets the next one proceed.
//
// This is ALSO where a run is bracketed — its context opened, run-begin/run-end posted — because it is
// the one place that knows a run is actually EXECUTING rather than merely queued — bracketing at the
// dispatch sites instead would have a bridge pull queued behind a manual export announce itself as
// in-progress for however long it waits, and would let two overlapping brackets clobber each other.
//
// It is also the one place that knows which runs are QUEUED (accepted, not yet started), which is what
// lets the bridge cancel one before it ever executes (cancelBridgeRequest / cancelBridgeRuns below).
// Each serializeRun call gets its own ticket object, tracked by identity — never by `run`, which a
// caller is free to reuse — so two queued runs can never be confused with each other.
interface QueuedRun { run: RunInfo; abandoned: boolean }
const queuedRuns = new Set<QueuedRun>();
let runChain: Promise<unknown> = Promise.resolve();
// Runs accepted and not yet finished (queued or executing). Above 0 when a new run arrives = it will
// wait, which a BRIDGE caller is told at once (postQueued): its stall check reads any frame as life,
// and a run queued behind a long export is busy, not stalled. Counted down when the run itself settles
// (not on a later tick of the chain), so a run that arrives just after the last one ended is not
// reported as queued.
let inChain = 0;
export function serializeRun<T>(fn: () => Promise<T>, run: RunInfo): Promise<T> {
  return enqueue(fn, run, true);
}

/**
 * THE run scheduler: every bridge command goes through here with its `RunKind` (bridge/src/commands.ts
 * runKind), so which commands may run alongside which is decided once, from the contract, for every caller —
 * a CLI or MCP request through any bridge or daemon, and (through serializeRun) the window's own buttons.
 *   - exclusive: serializeRun — alone, in arrival order, bracketed.
 *   - scene: the same chain, so it never overlaps an exclusive run (nor another scene read: listLibraries
 *     toggles skipInvisibleInstanceChildren itself), but unbracketed — no run-begin/run-end, no asset release.
 *     It is still a ticket while it waits: told `queued`, dropped unexecuted if the bridge cancels it, and told
 *     `start` when it begins after waiting (the bridge restarts its budget there, as on a bracketed run's run-begin).
 *   - identity: now, whatever is running.
 * A bridge-side caller therefore needs no queue of its own: the next run starts when this chain says the one
 * ahead has ENDED — not when someone sent it a cancel.
 */
export function scheduleRun<T>(kind: RunKind, fn: () => Promise<T>, run: RunInfo): Promise<T> {
  if (kind === "identity") return fn();
  return enqueue(fn, run, kind === "exclusive");
}

function enqueue<T>(fn: () => Promise<T>, run: RunInfo, bracketed: boolean): Promise<T> {
  const ticket: QueuedRun = { run, abandoned: false };
  queuedRuns.add(ticket);
  const waits = inChain > 0;
  if (waits) postQueued(run);
  inChain++;
  const go = (): Promise<T> => {
    queuedRuns.delete(ticket);
    // Abandoned while it waited: fail at once, WITHOUT calling fn and without bracketing — it never
    // executed, so the window must never see a run-begin/run-end for it. The chain proceeds as it
    // does after any failed run.
    if (ticket.abandoned) { inChain--; return Promise.reject(abandonedError()); }
    // `fn` is called inside a promise chain, so a synchronous throw is a rejection like any other. A bracketed run
    // announces itself (run-begin, which the window relays as `start`); an unbracketed one that waited says `start`
    // itself, so the bridge restarts its budget there too — one that did not wait began when it was sent.
    if (!bracketed && waits) postStarted(run);
    const ran = bracketed ? bracket(fn, run) : Promise.resolve().then(fn);
    return ran.finally(() => { inChain--; });
  };
  const next = runChain.then(go, go);
  runChain = next.then(() => {}, () => {});
  return next;
}

/** The bridge gave up on request `id`: abandon the QUEUED run it asked for (it will fail without
 *  executing when its turn comes), or — if it is the one executing — arm the cancel flag so it aborts
 *  at its next safe point. Returns the run it hit, or null for an id nobody knows (a no-op). */
export function cancelBridgeRequest(id: string): RunInfo | null {
  for (const t of queuedRuns) {
    if (t.run.source === "bridge" && t.run.requestId === id) {
      t.abandoned = true;
      return t.run;
    }
  }
  return requestAbandon((r) => r.source === "bridge" && r.requestId === id);
}

/** The socket that asked for work is gone: abandon EVERY bridge-sourced run — the executing one (if
 *  it is a bridge run) and all currently queued ones. UI-sourced runs are untouched, and a run queued
 *  after this call runs normally. Returns how many runs were hit. */
export function cancelBridgeRuns(): number {
  let hit = 0;
  for (const t of queuedRuns) {
    if (t.run.source === "bridge" && !t.abandoned) {
      t.abandoned = true;
      hit++;
    }
  }
  if (requestAbandon((r) => r.source === "bridge")) hit++;
  return hit;
}

// `run` is required, not optional: every caller genuinely knows who asked (the UI button, or the
// bridge command name), and a default would quietly make new call sites invisible in the plugin window
// — which is the exact gap progress exists to close.
async function bracket<T>(fn: () => Promise<T>, run: RunInfo): Promise<T> {
  const ctx = openRun(run);
  postRunBegin(run);
  let abandoned = false;
  try {
    return await fn();
  } catch (e) {
    abandoned = isAbandonment(e);
    throw e;
  } finally {
    // The run's context goes the moment it settles, its asset payloads (tens of MB of base64 PNG/SVG) with it: a
    // successful collector has already returned its own assets.slice(), and a run that THREW — cancelled or crashed
    // — hands them to nobody. Its cancel flag goes with it, so a flag that never reached a safe point cannot stop
    // the next run. (The other per-run toggle a cancel could strand — figma.skipInvisibleInstanceChildren, set by
    // the component-catalog and library walks — is restored by their own `finally` blocks, which a thrown
    // cancellation runs exactly like any other error.)
    closeRun(ctx);
    // `abandoned` tells the window this run died because its bridge caller went away — the only way it
    // can learn that, since a bridge run's error goes to the socket, not to the window.
    postRunEnd(abandoned);
  }
}

// The blanket document load, with its one guard. Three callers need it (the all-pages export walk, the
// component catalog, which spans every page by definition, and the library instance scan); sharing one
// feature-check + try/catch, which differs only in the consequence named, keeps the dynamic-page
// loading POLICY one edit rather than three — which matters because collect.ts argues for replacing
// this blanket load with per-page loadAsync, a change that would otherwise land on one caller only.
// `sink` is where the failure is said: the run's warnings, or a scene read's own list.
export async function loadAllPages(consequence: string, sink: (m: string) => void): Promise<void> {
  if (!figma.loadAllPagesAsync) return;
  try {
    await figma.loadAllPagesAsync();
  } catch (e) {
    sink("loadAllPagesAsync failed (" + consequence + "): " + errMsg(e));
  }
}
