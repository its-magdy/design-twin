// pending-requests.ts — every command the bridge has sent to a plugin and not yet settled, and the one rule for how each
// settles: a reply from the connection it went to, its budget running out, the stall check, its caller giving up, its
// connection going away, or the bridge closing.
//
// A module of its own, driven only by events and a Clock (clock.ts), so the rules are tested step by step against a
// fake clock (test/pending-requests.test.ts) instead of through a real port and wall-clock sleeps. server-core's socket
// handlers feed it what they hear (heard / progress / reply / lost); request() opens an entry and sends the frame; the
// one thing it does on the wire itself goes through the injected `sendCancel`.
//
// The rules, each owned here:
//   BUDGET  armed at open (= send) for `budgetMs`. It bounds a wait in the plugin's queue behind an earlier run in that
//           file (figma-plugin state.ts scheduleRun — the one queue on every path, so the wait is not otherwise bounded),
//           and is re-armed IN FULL when the plugin says this request's run has begun (its own `start` frame: a progress
//           frame naming this request's id, on this request's connection — an id-less `start` could be anyone's): a run
//           that began late is not cut short by the time it spent waiting.
//   STALL   opt-in (`stall`): a separate, shorter wait for ANY frame from this request's connection after the send. It
//           disarms itself on the first one and never re-arms: a working export goes legitimately quiet for minutes
//           (measured live 2026-09-25: 14–24 s after one large top-level frame, 116–135 s between the last page tick and
//           the reply), so "quiet for the window at any point" would abort working exports. What it catches is a
//           connection that never shows life for the request at all; the budget bounds everything after. Only frames
//           heard AFTER open count, by event order rather than by timestamp, so a connect or a frame in the same
//           millisecond as the send can neither pass for life since the send nor be missed.
//   CANCEL  whenever this side gives up on a request it has sent — the budget, the stall check, the caller's signal,
//           close() — the plugin is told (`sendCancel`), or it keeps walking the export for nobody and queues every later
//           command behind it. Not when the connection is gone (a socket that closes is itself a cancel on the plugin
//           side) and not for a send that never left.
//   REPLY   settles a request only from the connection it was SENT to. With per-bridge ids a reply carrying this id on
//           another socket can only be a coincidence or a confused peer, and letting it through would resolve one file's
//           request with another file's work.
//   LOST    a connection that closes fails ITS pending requests at once, and only those: another file's export runs on.
//
// Settling clears every timer and removes the signal listener, whichever way it happens, so a settled request leaves
// nothing armed (a one-shot CLI exits on its own) and a long-lived signal shared by many requests accumulates nothing.

import { abortReason } from "./abort-reason.ts";
import { deadline } from "./clock.ts";
import type { Clock, Deadline } from "./clock.ts";

/** The connection a request went to, as this module needs it: its id (what events are keyed on). The bridge passes its
 *  registry entry, so `sendCancel` reaches that exact socket. */
export interface PendingConn { connId: string }

/** One request to track, opened as it is sent. */
export interface PendingSpec<C extends PendingConn, T> {
  id: string;
  conn: C;
  /** the per-command budget, ms, and the error it rejects with when it runs out */
  budgetMs: number;
  timedOut: () => Error;
  /** the stall check (see STALL above): absent = none */
  stall?: { ms: number; error: () => Error } | undefined;
  /** the caller giving up: aborted while pending → cancel, then reject with abortReason(signal, "request aborted by the
   *  caller"). Already aborted at open → rejects "request aborted before it was sent" at once, with no cancel and no
   *  entry (`has(id)` is false), so the caller sends nothing. */
  signal?: AbortSignal | undefined;
  /** every progress tick this request's connection sends while it is pending (see `progress`) */
  onProgress?: ((tick: T) => void) | undefined;
}

/** What a reply frame said: the plugin's result, or its error. */
export type ReplyOutcome = { ok: true; result: unknown } | { ok: false; error: Error };

interface Entry<C extends PendingConn, T> {
  conn: C;
  budget: Deadline;
  stall: Deadline | null;
  onProgress: ((tick: T) => void) | undefined;
  unlisten: () => void;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface PendingRequestsOptions<C extends PendingConn> {
  clock: Clock;
  /** tell the plugin on `conn` to stop request `id` — best-effort, never awaited; it must not throw */
  sendCancel: (conn: C, id: string) => void;
}

export function createPendingRequests<C extends PendingConn, T = unknown>({ clock, sendCancel }: PendingRequestsOptions<C>) {
  const table = new Map<string, Entry<C, T>>();

  // The one way out of the table: forget the entry, clear its timers and listener, and answer it — or null, when it
  // has already settled (a timer and a reply can race).
  function take(id: string): Entry<C, T> | null {
    const p = table.get(id);
    if (!p) return null;
    table.delete(id);
    p.budget.cancel();
    p.stall?.cancel();
    p.unlisten();
    return p;
  }

  // Gave up on a request the plugin has: forget it, tell the plugin, then reject.
  function giveUp(id: string, why: () => Error): void {
    const p = take(id);
    if (!p) return;
    sendCancel(p.conn, id);
    p.reject(why());
  }

  /** Track request `spec.id` from now (call it as the command is sent). The promise settles with the plugin's raw
   *  result; checking its shape is the caller's. */
  function open(spec: PendingSpec<C, T>): Promise<unknown> {
    const { id, conn, signal } = spec;
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) return reject(abortReason(signal, "request aborted before it was sent"));
      let onAbort: (() => void) | null = null;
      const entry: Entry<C, T> = {
        conn,
        budget: deadline(clock, spec.budgetMs, () => giveUp(id, spec.timedOut)),
        stall: null,
        onProgress: spec.onProgress,
        unlisten: () => { if (signal && onAbort) signal.removeEventListener("abort", onAbort); onAbort = null; },
        resolve,
        reject,
      };
      const stall = spec.stall;
      if (stall && stall.ms > 0) entry.stall = deadline(clock, stall.ms, () => giveUp(id, stall.error));
      table.set(id, entry);
      if (signal) {
        const sig = signal;
        onAbort = () => giveUp(id, () => abortReason(sig, "request aborted by the caller"));
        sig.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Any parsed frame from `connId` — hello, progress, a reply, even one for an id nobody here knows: life on that
   *  connection, which disarms the stall check of every request pending on it. Call it before the frame's own event. */
  function heard(connId: string): void {
    for (const p of table.values()) {
      if (p.conn.connId === connId && p.stall) { p.stall.cancel(); p.stall = null; }
    }
  }

  /** A progress tick from `connId`. `requestId` names the one request it is for (the plugin's `start` / `queued` for one
   *  run) — only that request hears it, and a `start` (`start: true`) re-arms that request's budget in full; an id-less
   *  tick (page ticks, an older plugin) reaches every request pending on the connection and re-arms nothing. A tick
   *  naming a request this connection does not have feeds nothing. A listener's throw is its own. */
  function progress(connId: string, requestId: string | null, tick: T, start: boolean): void {
    if (requestId !== null && start) {
      const own = table.get(requestId);
      if (own && own.conn.connId === connId) own.budget.rearm();
    }
    for (const [id, p] of table) {
      if (p.conn.connId !== connId || !p.onProgress || (requestId !== null && id !== requestId)) continue;
      try { p.onProgress(tick); } catch { /* a listener's failure is its own; the request goes on */ }
    }
  }

  /** The plugin on `connId` answered request `id`. Settles it only when `connId` is where it was sent. */
  function reply(connId: string, id: string, outcome: ReplyOutcome): void {
    const p = table.get(id);
    if (!p || p.conn.connId !== connId) return;
    take(id);
    if (outcome.ok) p.resolve(outcome.result);
    else p.reject(outcome.error);
  }

  /** The command frame for `id` never left (a dropped send): reject now, with no cancel — the plugin never heard of it. */
  function fail(id: string, err: Error): void {
    take(id)?.reject(err);
  }

  /** Connection `connId` closed: every request pending on it rejects with an error of `why`'s, with no cancel; no other
   *  is touched. (`why` makes one per request, so no two callers share an Error.) */
  function lost(connId: string, why: () => Error): void {
    for (const [id, p] of [...table]) if (p.conn.connId === connId) { take(id); p.reject(why()); }
  }

  /** The bridge is closing: a cancel for EVERY pending request first, while the sockets are still open, then every one
   *  rejects with an error of `why`'s. */
  function close(why: () => Error): void {
    const all = [...table];
    for (const [id, p] of all) sendCancel(p.conn, id);
    for (const [id, p] of all) { take(id); p.reject(why()); }
  }

  return {
    open, heard, progress, reply, fail, lost, close,
    has: (id: string): boolean => table.has(id),
    size: (): number => table.size,
  };
}

export type PendingRequests<C extends PendingConn, T = unknown> = ReturnType<typeof createPendingRequests<C, T>>;
