// Export PROGRESS + CANCEL. The one plane shared by BOTH ways an export starts — a designer clicking
// a button in ui.html, and a CLI/MCP request arriving over the bridge — because the designer needs the
// same two things either way: to see that their file is being walked (and by whom), and to be able to
// stop it. A whole-file `allPages` pull measured 10+ minutes on a real design system (see the note on
// collect.ts's cheap structural index) and until now the UI showed a static "Exporting…" for all of it.
//
// Why a module rather than fields on state.ts: this is the only extractor state that is written from
// OUTSIDE the run (the UI's Cancel click lands on the main thread while the walk is mid-await), and
// the only one whose whole job is to talk to the iframe. state.ts imports it — never the reverse — so
// there is no cycle, and a collector can be unit-driven with no run bracketing it at all (see `running`).
import { ifDefined } from "../../bridge/src/json-util.ts";

// ---------------------------------------------------------------- what this module posts to the UI
/** The page the walk is on: 1-based `index` of `of` pages walked. `pageId` is the identity (page names
 *  are not unique); absent only when a caller had no id to give. */
export interface ProgressPage { index: number; of: number; name: string; pageId?: string }
/** The running counters a progress frame carries (each phase reports the ones it has). */
export interface ProgressCounters { nodes?: number; assets?: number; components?: number }
export interface RunBeginMsg { type: "run-begin"; source: RunInfo["source"]; label: string }
/** `abandoned` is present (and `true`) only when the run THREW because the bridge request that asked
 *  for it was abandoned — the one case where the window has no other way to learn why a run ended (a
 *  bridge run's error goes to the socket, never to the window). Absent otherwise, so the designer's
 *  Cancel and every normal run still post exactly `{ type: "run-end" }`. */
export interface RunEndMsg { type: "run-end"; abandoned?: true }
export interface ProgressMsg extends ProgressCounters {
  type: "progress";
  phase: Phase;
  source: RunInfo["source"];
  label: string;
  page?: ProgressPage;
}
export type ProgressPost = RunBeginMsg | RunEndMsg | ProgressMsg;

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

/** Is this thrown value a BRIDGE-initiated cancellation (ABANDONED_MESSAGE)? Such a value is always
 *  also isCancellation(). */
export function isAbandonment(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledMarked)[ABANDONED] === true;
}

/** Is this thrown value a cancellation rather than a real failure? Exported so a caller can tell
 *  "the designer stopped it" from "the export broke" without string-matching the message. */
export function isCancellation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CancelledMarked)[CANCELLED] === true;
}

// ---------------------------------------------------------------- the run being tracked
/** Who asked for this run. `source` is what lets the plugin window say "a CLI/MCP pull is walking your
 *  file right now" instead of leaving the designer to guess why Figma went busy; `label` names the
 *  command/scope so two bridge clients aren't indistinguishable. */
export interface RunInfo {
  source: "ui" | "bridge";
  label: string;
  /** The id of the bridge frame that asked for this run — present only on bridge runs whose frame
   *  carried one. A `{ type: "cancel", id }` frame from the bridge is matched on it. */
  requestId?: string;
}

// `null` whenever no run is bracketed by beginRun/endRun — which is also how a directly-driven
// collector (the test harness, a future internal caller) stays completely silent instead of posting
// progress nobody asked for.
let running: RunInfo | null = null;
// Who asked the executing run to stop, if anyone: the designer's Cancel button, or the bridge giving up
// on the request (requestAbandon). One field rather than two flags so the run fails with exactly one,
// truthful message. A designer's click overrides an earlier abandonment (a human did ask); an
// abandonment never overrides a click.
let cancelRequested: "designer" | "abandoned" | null = null;
let lastPost = 0;
// The page the walk is currently on, remembered here so the phases that are NOT page-boundaries (the
// per-asset ticks below) can still say WHERE they are without every caller threading it through.
// Carries `pageId` next to `name` for the usual reason: Figma allows duplicate page names, so the name
// is a display label and the id is the identity (see collect.ts resolvePages).
let page: ProgressPage | undefined;

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

/** Bracket the start of a run. Called from serializeRun (state.ts) — i.e. at the moment the run really
 *  begins, not when it was queued — so the two can never disagree about what is executing. */
export function beginRun(info: RunInfo): void {
  running = info;
  // Requirement: the flag resets at the START of every run, not only at the end. A cancel that landed
  // while nothing was running, or after the run it was meant for had already finished, must not kill
  // the NEXT export — that is a failure with no visible cause, which is the worst kind.
  cancelRequested = null;
  page = undefined;
  lastPost = 0;
  post({ type: "run-begin", source: info.source, label: info.label });
}

/** Bracket the end of a run — success, failure or cancellation alike. `abandoned` is true only when the
 *  run actually THREW the abandonment error: a flag that landed too late to reach a safe point changed
 *  nothing, and the window must not claim otherwise. */
export function endRun(abandoned?: boolean): void {
  running = null;
  cancelRequested = null;
  page = undefined;
  post(abandoned ? { type: "run-end", abandoned: true } : { type: "run-end" });
}

/** The UI's Cancel click. Returns the run it applies to, or null when nothing is running — the caller
 *  reports that back so a click on a stale button is visibly a no-op rather than a silently armed flag. */
export function requestCancel(): RunInfo | null {
  if (!running) return null;
  cancelRequested = "designer";
  return running;
}

/** The bridge gave up on a request. If the EXECUTING run matches, arm the flag exactly as the Cancel
 *  button does (the run aborts at its next safe point), but so that it fails with ABANDONED_MESSAGE.
 *  Returns the run it hit, or null when nothing running matches. Queued runs are state.ts's business
 *  (serializeRun owns the queue) — this module only ever knows the one run that is executing. */
export function requestAbandon(matches: (run: RunInfo) => boolean): RunInfo | null {
  if (!running || !matches(running)) return null;
  if (cancelRequested === null) cancelRequested = "abandoned";
  return running;
}

/** Throw if the designer pressed Cancel (CANCELLED_MESSAGE) or the bridge abandoned the request that
 *  asked for this run (ABANDONED_MESSAGE). Call this ONLY where the walk already awaits (between pages,
 *  between top-level frames, at the per-node asset export) — those are the points where the extractor
 *  holds no half-built structure. There is no way to interrupt an in-flight exportAsync, and a partial
 *  export must NEVER be delivered as a complete one, so aborting by throwing is the whole mechanism:
 *  every caller's error path already refuses to emit a doc. */
export function checkCancelled(): void {
  if (cancelRequested === "designer") throw cancelledError();
  if (cancelRequested === "abandoned") throw abandonedError();
}

// ---------------------------------------------------------------- emission
export type Phase = "pages" | "assets" | "design-system";

/** Emit a throttled progress frame for the current phase. `extra` carries the running counters
 *  (`nodes`, `assets`) the UI renders next to the page name. */
export function progress(phase: Phase, extra?: ProgressCounters, force?: boolean): void {
  if (!running) return;
  const now = Date.now();
  if (!force && now - lastPost < MIN_INTERVAL_MS) return;
  lastPost = now;
  post({ type: "progress", phase, source: running.source, label: running.label, ...ifDefined("page", page), ...extra });
}

/** Cross a page boundary: remember the page and emit an UNTHROTTLED frame for it. `index` is 1-based
 *  so the UI can render it as "page 3 of 25" without doing arithmetic on the wire format. */
export function enterPage(phase: Phase, index: number, of: number, name: string, pageId?: string, extra?: ProgressCounters): void {
  page = { index, of, name, ...ifDefined("pageId", pageId) };
  progress(phase, extra, true);
}
