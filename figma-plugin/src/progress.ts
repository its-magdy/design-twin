// Export PROGRESS + CANCEL. The one plane shared by BOTH ways an export starts — a designer clicking
// a button in ui.html, and a CLI/MCP request arriving over the bridge — because the designer needs the
// same two things either way: to see that their file is being walked (and by whom), and to be able to
// stop it. A whole-file `allPages` pull measured 10+ minutes on a real design system (see the note on
// collect.ts's cheap structural index) and a static "Exporting…" for all of it would leave the designer guessing.
//
// What it tracks — who asked, the cancel flag, the page, the throttle clock — lives on the run (run.ts), so a new
// run starts with none of it set. This module is the half that talks to the iframe and the one entry point for a
// stop request, which is the only run state written from OUTSIDE the run (the UI's Cancel click lands on the main
// thread while the walk is mid-await). A directly-driven collector (no scheduler) has no RunInfo, so it posts
// nothing and no cancel reaches it.
import { ifDefined } from "../../bridge/src/json-util.ts";
import { activeRun } from "./run";

// ---------------------------------------------------------------- what this module posts to the UI
// The posts' types are the UI <-> main-thread contract's (messages.ts), where the window's relay reads them too.
import type { Phase, ProgressCounters, ProgressPost, RunSource } from "./messages.ts";
export type { Phase, ProgressCounters, ProgressPage, ProgressPost, QueuedMsg, RunBeginMsg, RunEndMsg, ProgressMsg, StartMsg } from "./messages.ts";

// ---------------------------------------------------------------- the cancellation error
/** The message a cancelled run fails with. The BRIDGE sees this string VERBATIM: main.ts turns a
 *  thrown error into the `error` field of `bridge-result`, which the iframe forwards to the socket, so
 *  the CLI/MCP prints exactly this. It is therefore written for someone reading a terminal — it has to
 *  say a human stopped the export, not look like a plugin crash they should retry or report. */
export const CANCELLED_MESSAGE = "export cancelled by the designer in Figma";

/** The message a run fails with when the BRIDGE gave up on the request that asked for it (the caller's
 *  stall check or timeout fired, or its process/socket went away). Deliberately not CANCELLED_MESSAGE:
 *  no designer pressed anything, and saying so would send someone looking for a click that never
 *  happened. Usually nobody is left to read it, but a caller or log that is must be told the truth. */
export const ABANDONED_MESSAGE =
  "export cancelled: the bridge request that asked for it was abandoned (its caller timed out, stalled out, or disconnected)";

// A marker PROPERTY rather than `class CancelledError extends Error`. The bundle is downlevelled to
// es2019 by esbuild and its errors cross the main-thread/iframe boundary and the VM-harness realm
// boundary; `instanceof` is the classic thing that silently stops matching across either. A property
// survives both, and errMsg() already carries the message through unchanged.
const CANCELLED = "__designTwinCancelled";
// A second marker, on the abandonment error only, so bracket (state.ts) can tell the window WHY a run
// ended without string-matching. An abandonment carries BOTH markers: it is a cancellation.
const ABANDONED = "__designTwinAbandoned";

interface CancelledMarked {
  [CANCELLED]?: boolean;
  [ABANDONED]?: boolean;
}

export function cancelledError(): Error {
  const e: Error & CancelledMarked = new Error(CANCELLED_MESSAGE);
  e[CANCELLED] = true;
  return e;
}

export function abandonedError(): Error {
  const e: Error & CancelledMarked = new Error(ABANDONED_MESSAGE);
  e[CANCELLED] = true;
  e[ABANDONED] = true;
  return e;
}

/** Is this thrown value a BRIDGE-initiated cancellation (ABANDONED_MESSAGE)? */
export function isAbandonment(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledMarked)[ABANDONED] === true;
}

// ---------------------------------------------------------------- the run being tracked
/** Who asked for this run. `source` is what lets the plugin window say "a CLI/MCP pull is walking your
 *  file right now" instead of leaving the designer to guess why Figma went busy; `label` names the
 *  command/scope so two bridge clients aren't indistinguishable. */
export interface RunInfo {
  source: RunSource;
  label: string;
  /** The id of the bridge frame that asked for this run — present only on bridge runs whose frame
   *  carried one. A `{ type: "cancel", id }` frame from the bridge is matched on it. */
  requestId?: string;
}

// Throttle floor for the ticks INSIDE a page. postMessage crosses the main-thread -> iframe boundary,
// and the per-asset checkpoint fires once per exported icon/image — thousands of times on a real file.
// At ~250ms the bar still reads as live while the walk pays essentially nothing. Page boundaries and
// phase changes bypass this (see `force`): they are the transitions a designer is actually watching for,
// and dropping one would leave the status line naming a page the walk already finished.
const MIN_INTERVAL_MS = 250;

function post(m: ProgressPost): void {
  try {
    // Guarded rather than assumed: `figma.ui` exists only once showUI has run, and progress is never
    // worth failing an export over.
    if (figma && figma.ui && typeof figma.ui.postMessage === "function") figma.ui.postMessage(m);
  } catch (e) {
    /* ignore — a dropped progress frame costs nothing, a thrown one costs the export */
  }
}

/** A run has begun executing. Posted by the scheduler (state.ts bracket) — i.e. at the moment the run really
 *  begins, not when it was queued — so the two can never disagree about what is executing. */
export function postRunBegin(info: RunInfo): void {
  post({ type: "run-begin", source: info.source, label: info.label, ...ifDefined("requestId", info.requestId) });
}

/** A run has ended — success, failure or cancellation alike. `abandoned` is true only when the run actually THREW
 *  the abandonment error: a flag that landed too late to reach a safe point changed nothing, and the window must
 *  not claim otherwise. */
export function postRunEnd(abandoned?: boolean): void {
  post(abandoned ? { type: "run-end", abandoned: true } : { type: "run-end" });
}

/** Tell the window (and through it the bridge) that a bridge run is waiting behind another run.
 *  UI runs post nothing: the designer clicked, and the window already shows the run ahead. */
export function postQueued(run: RunInfo): void {
  if (run.source !== "bridge") return;
  post({ type: "progress", phase: "queued", source: "bridge", label: run.label, ...ifDefined("requestId", run.requestId) });
}

/** Tell the bridge that an unbracketed bridge run that waited has begun (StartMsg). UI runs post nothing. */
export function postStarted(run: RunInfo): void {
  if (run.source !== "bridge") return;
  post({ type: "progress", phase: "start", source: "bridge", label: run.label, ...ifDefined("requestId", run.requestId) });
}

/** The UI's Cancel click. Returns the run it applies to, or null when nothing is running — the caller
 *  reports that back so a click on a stale button is visibly a no-op rather than a silently armed flag. */
export function requestCancel(): RunInfo | null {
  const r = activeRun();
  if (!r || !r.info) return null;
  r.cancel = "designer"; // a designer's click overrides an earlier abandonment (a human did ask)
  return r.info;
}

/** The bridge gave up on a request. If the EXECUTING run matches, arm the flag exactly as the Cancel
 *  button does (the run aborts at its next safe point), but so that it fails with ABANDONED_MESSAGE.
 *  Returns the run it hit, or null when nothing running matches. Queued runs are state.ts's business
 *  (the scheduler owns the queue) — this module only ever knows the one run that is executing. */
export function requestAbandon(matches: (run: RunInfo) => boolean): RunInfo | null {
  const r = activeRun();
  if (!r || !r.info || !matches(r.info)) return null;
  if (r.cancel === null) r.cancel = "abandoned"; // an abandonment never overrides a click
  return r.info;
}

/** Throw if the designer pressed Cancel (CANCELLED_MESSAGE) or the bridge abandoned the request that
 *  asked for this run (ABANDONED_MESSAGE). Call this ONLY where a throw cannot strand anything: between
 *  pages, between top-level frames, at the per-node asset export, and at the start of each node's
 *  serialize (serialize.ts — a throw there unwinds through partial trees nobody keeps). There is no way
 *  to interrupt an in-flight exportAsync, and a partial export must NEVER be delivered as a complete
 *  one, so aborting by throwing is the whole mechanism: every caller's error path already refuses to
 *  emit a doc, and the per-run toggles are restored in `finally` blocks. A catch that swallows errors
 *  around one of these points must be followed by another check (see collect.ts's catalog backstop). */
export function checkCancelled(): void {
  const r = activeRun();
  if (!r) return;
  if (r.cancel === "designer") throw cancelledError();
  if (r.cancel === "abandoned") throw abandonedError();
}

// ---------------------------------------------------------------- emission

/** Emit a throttled progress frame for the current phase. `extra` carries the running counters
 *  (`nodes`, `assets`) the UI renders next to the page name. */
export function progress(phase: Phase, extra?: ProgressCounters, force?: boolean): void {
  const r = activeRun();
  if (!r || !r.info) return;
  const now = Date.now();
  if (!force && now - r.lastPost < MIN_INTERVAL_MS) return;
  r.lastPost = now;
  post({ type: "progress", phase, source: r.info.source, label: r.info.label, ...ifDefined("page", r.page), ...extra });
}

/** Cross a page boundary: remember the page on the run (Figma allows duplicate page names, so it carries `pageId`
 *  as the identity — see collect.ts resolvePages) and emit an UNTHROTTLED frame for it. `index` is 1-based so the
 *  UI can render it as "page 3 of 25" without doing arithmetic on the wire format. */
export function enterPage(phase: Phase, index: number, of: number, name: string, pageId?: string, extra?: ProgressCounters): void {
  const r = activeRun();
  if (!r) return;
  r.page = { index, of, name, ...ifDefined("pageId", pageId) };
  progress(phase, extra, true);
}
