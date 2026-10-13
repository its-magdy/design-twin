// pw-errors.ts — what a Playwright error means to the probe: the one classifier verify-probe, probe-drive,
// probe-visual and probe-behaviour share, so a crash, a closed page, a reload and a timeout read the same everywhere.
//
// The project's own Playwright is loaded at run time (resolvePlaywright), never imported here, so `instanceof
// errors.TimeoutError` has no class to compare against; the error's `name` and message are what every version carries.
// Facts this relies on (Playwright 1.63 client, read in playwright-core's bundle and seen from a real chromium):
//   - a timeout is a TimeoutError whose name is "TimeoutError" and whose message reads "<api>: Timeout 100ms exceeded."
//     (https://playwright.dev/docs/api/class-timeouterror);
//   - a closed page, context or browser throws "<api>: Target page, context or browser has been closed" — the client's
//     TargetClosedError keeps the name "Error" (only the server-side class is named "TargetClosedError"), so the
//     message decides; older releases said "Target closed" / "Browser has been closed";
//   - a crashed page leaves page.isClosed() false and throws "<api>: Target crashed", "Page crashed" or
//     "Navigation failed because page crashed!" — the page cannot be driven again, so a crash is "gone" too;
//   - a document replaced under a call throws "Execution context was destroyed…", "frame was detached", "Cannot find
//     context with specified id" or a goto "interrupted by another navigation";
//   - each of these is on the message's first line; the call log after it is never read.
import { firstLine } from "../bridge/src/errmsg.ts";

/** A Playwright error's first line for a message to the user, without the trailing space of a crash's "Target crashed "
 *  (Playwright appends the browser log after a space, and it is empty here). */
export const pwFirstLine = (e: unknown): string => firstLine(e).trimEnd();

/** The page, its context or the browser closed or crashed. */
const CLOSED = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target crashed|Page crashed/i;
/** The document the call ran in was replaced (a reload, a navigation). */
const NAVIGATED = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
/** A Playwright timeout's message, for an error whose name was lost (a wrapper that copied the message only). */
const TIMED_OUT = /Timeout \d+\s*ms exceeded/i;

export type PwErrorKind = "timeout" | "gone" | "navigated" | "other";

/**
 * What a thrown Playwright value means: "gone" (the page, context or browser closed or crashed — also whenever `page`
 * says it is closed), "timeout" (a TimeoutError), "navigated" (the document was replaced) or "other". The order is the
 * precedence: a dead page outranks everything; an error NAMED TimeoutError is a timeout whatever its call log mentions;
 * the message's wording decides the rest.
 */
export function pwErrorKind(e: unknown, page?: { isClosed(): boolean }): PwErrorKind {
  const name = e instanceof Error ? e.name : "";
  // the first line only: the call log after it echoes selectors and URLs, which must not decide the kind
  const m = firstLine(e);
  if ((page !== undefined && page.isClosed()) || name === "TargetClosedError" || CLOSED.test(m)) return "gone";
  if (name === "TimeoutError") return "timeout";
  if (NAVIGATED.test(m)) return "navigated";
  return TIMED_OUT.test(m) ? "timeout" : "other";
}
