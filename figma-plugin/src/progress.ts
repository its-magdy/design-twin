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
import { Obj } from "./util";

// ---------------------------------------------------------------- the cancellation error
/** The message a cancelled run fails with. The BRIDGE sees this string VERBATIM: main.ts turns a
 *  thrown error into the `error` field of `bridge-result`, which the iframe forwards to the socket, so
 *  the CLI/MCP prints exactly this. It is therefore written for someone reading a terminal — it has to
 *  say a human stopped the export, not look like a plugin crash they should retry or report. */
export const CANCELLED_MESSAGE = "export cancelled by the designer in Figma";

// A marker PROPERTY rather than `class CancelledError extends Error`. The bundle is downlevelled to
// es2019 by esbuild and its errors cross the main-thread/iframe boundary and the VM-harness realm
// boundary; `instanceof` is the classic thing that silently stops matching across either. A property
// survives both, and errMsg() already carries the message through unchanged.
const CANCELLED = "__designTwinCancelled";

export function cancelledError(): Error {
  const e = new Error(CANCELLED_MESSAGE);
  (e as any)[CANCELLED] = true;
  return e;
}

/** Is this thrown value a cancellation rather than a real failure? Exported so a caller can tell
 *  "the designer stopped it" from "the export broke" without string-matching the message. */
export function isCancellation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as any)[CANCELLED] === true;
}

// ---------------------------------------------------------------- the run being tracked
/** Who asked for this run. `source` is what lets the plugin window say "a CLI/MCP pull is walking your
 *  file right now" instead of leaving the designer to guess why Figma went busy; `label` names the
 *  command/scope so two bridge clients aren't indistinguishable. */
export interface RunInfo {
  source: "ui" | "bridge";
  label: string;
}

// `null` whenever no run is bracketed by beginRun/endRun — which is also how a directly-driven
// collector (the test harness, a future internal caller) stays completely silent instead of posting
// progress nobody asked for.
let running: RunInfo | null = null;
let cancelRequested = false;
let lastPost = 0;
// The page the walk is currently on, remembered here so the phases that are NOT page-boundaries (the
// per-asset ticks below) can still say WHERE they are without every caller threading it through.
// Carries `pageId` next to `name` for the usual reason: Figma allows duplicate page names, so the name
// is a display label and the id is the identity (see collect.ts resolvePages).
let page: { index: number; of: number; name: string; pageId?: string } | undefined;

// Throttle floor for the ticks INSIDE a page. postMessage crosses the main-thread -> iframe boundary,
// and the per-asset checkpoint fires once per exported icon/image — thousands of times on a real file.
// At ~250ms the bar still reads as live while the walk pays essentially nothing. Page boundaries and
// phase changes bypass this (see `force`): they are the transitions a designer is actually watching for,
// and dropping one would leave the status line naming a page the walk already finished.
const MIN_INTERVAL_MS = 250;

function post(m: Obj): void {
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
  cancelRequested = false;
  page = undefined;
  lastPost = 0;
  post({ type: "run-begin", source: info.source, label: info.label });
}

/** Bracket the end of a run — success, failure or cancellation alike. */
export function endRun(): void {
  running = null;
  cancelRequested = false;
  page = undefined;
  post({ type: "run-end" });
}

/** The UI's Cancel click. Returns the run it applies to, or null when nothing is running — the caller
 *  reports that back so a click on a stale button is visibly a no-op rather than a silently armed flag. */
export function requestCancel(): RunInfo | null {
  if (!running) return null;
  cancelRequested = true;
  return running;
}

/** Throw if the designer pressed Cancel. Call this ONLY where the walk already awaits (between pages,
 *  between top-level frames, at the per-node asset export) — those are the points where the extractor
 *  holds no half-built structure. There is no way to interrupt an in-flight exportAsync, and a partial
 *  export must NEVER be delivered as a complete one, so aborting by throwing is the whole mechanism:
 *  every caller's error path already refuses to emit a doc. */
export function checkCancelled(): void {
  if (cancelRequested) throw cancelledError();
}

// ---------------------------------------------------------------- emission
export type Phase = "pages" | "assets" | "design-system";

/** Emit a throttled progress frame for the current phase. `extra` carries the running counters
 *  (`nodes`, `assets`) the UI renders next to the page name. */
export function progress(phase: Phase, extra?: Obj, force?: boolean): void {
  if (!running) return;
  const now = Date.now();
  if (!force && now - lastPost < MIN_INTERVAL_MS) return;
  lastPost = now;
  post({ type: "progress", phase, source: running.source, label: running.label, page, ...extra });
}

/** Cross a page boundary: remember the page and emit an UNTHROTTLED frame for it. `index` is 1-based
 *  so the UI can render it as "page 3 of 25" without doing arithmetic on the wire format. */
export function enterPage(phase: Phase, index: number, of: number, name: string, pageId?: string, extra?: Obj): void {
  page = { index, of, name, pageId };
  progress(phase, extra, true);
}
