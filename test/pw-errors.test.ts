// pwErrorKind (design-to-code/pw-errors.ts): what a Playwright error means to the probe — a table of the errors
// Playwright throws (real Error objects, the name set the way playwright-core sets it), then the same calls failing in a
// real chromium (no server, no port: setContent, a data: URL, chromium's chrome://crash URL). Locally the chromium half is
// skipped when no browser is installed; in CI (CI=true) it must run. What it learns about Playwright's own internals (the
// closed error's name, whether a crashed page reports itself closed) is printed, never failed on: a Playwright upgrade
// that changes them must not fail the suite while the classifier still answers right.
// Run with:  node test/pw-errors.test.ts
import { pwErrorKind, pwFirstLine } from "../design-to-code/pw-errors.ts";
import type { PwErrorKind } from "../design-to-code/pw-errors.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { check, report } from "./assert.ts";

const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });
const open = { isClosed: (): boolean => false };
const closed = { isClosed: (): boolean => true };
const is = (label: string, e: unknown, want: PwErrorKind, page?: { isClosed(): boolean }): boolean => {
  const got = pwErrorKind(e, page);
  return check(`${label} → ${want}${got === want ? "" : ` (got ${got})`}`, got === want);
};

console.log("pwErrorKind — the table:");
// timeouts: the name decides; the message is the fallback for a value that lost it
is("a TimeoutError (name) with Playwright's message", named("TimeoutError", "locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#x')"), "timeout");
is("a TimeoutError (name) whose message says nothing of a timeout", named("TimeoutError", "the operation timed out"), "timeout");
is("a TimeoutError (name) whose first line mentions a detached frame (invented) — the name wins over the wording", named("TimeoutError", "frame.waitForSelector: Timeout 2000ms exceeded while the frame was detached"), "timeout");
// only the first line is read: a call log echoing a selector or URL never decides the kind
is("a TimeoutError whose call log echoes 'Target closed' in a selector", named("TimeoutError", "locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('text=Target closed')"), "timeout");
is("a plain error whose call log echoes 'frame was detached' in a URL", new Error("locator.click: Element is not visible\nCall log:\n  - navigated to \"http://x/frame was detached\""), "other");
is("the same with the timeout's name dropped: the first line still says timeout", new Error("locator.click: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('text=Page crashed')"), "timeout");
check("pwFirstLine: the first line without a crash's trailing space", pwFirstLine(new Error("page.evaluate: Target crashed \nBrowser logs: none")) === "page.evaluate: Target crashed"
  && pwFirstLine("a  b ") === "a  b");
is("a plain Error carrying only the timeout message", new Error("page.goto: Timeout 30000ms exceeded."), "timeout");
is("the message as a string", "page.waitForFunction: Timeout 100ms exceeded.", "timeout");
// gone: closed, disconnected, crashed — or a page that says it is closed
is("Target page, context or browser has been closed", new Error("page.evaluate: Target page, context or browser has been closed"), "gone");
is("an older release's 'Target closed'", new Error("Protocol error (Runtime.callFunctionOn): Target closed."), "gone");
is("Browser has been closed", new Error("browser.newContext: Browser has been closed"), "gone");
is("browser has disconnected", new Error("browserContext.close: browser has disconnected"), "gone");
is("a crashed page: Target crashed", new Error("page.evaluate: Target crashed "), "gone");
is("a crashed page: Page crashed", new Error("page.goto: Page crashed"), "gone");
is("Navigation failed because page crashed! (a crash, not a reload)", new Error("page.waitForNavigation: Navigation failed because page crashed!"), "gone");
is("a value named TargetClosedError (playwright-core's server-side class)", named("TargetClosedError", "the page went away"), "gone");
is("any error once the page reports itself closed", new Error("locator.click: something else"), "gone", closed);
is("a TimeoutError on a closed page — a dead page outranks the timeout", named("TimeoutError", "locator.click: Timeout 2000ms exceeded."), "gone", closed);
is("a closed message outranks a navigation message", new Error("Execution context was destroyed; Target page, context or browser has been closed"), "gone");
// navigated: the document was replaced
is("Execution context was destroyed", new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation."), "navigated");
is("Cannot find context with specified id", new Error("Protocol error (Runtime.callFunctionOn): Cannot find context with specified id"), "navigated");
is("frame was detached", new Error("locator.evaluate: frame was detached"), "navigated");
is("a goto interrupted by another navigation", new Error('page.goto: Navigation to "http://x/b" is interrupted by another navigation to "http://x/c"'), "navigated");
is("Execution context was destroyed on an open page", new Error("page.evaluate: Execution context was destroyed"), "navigated", open);
// other
is("an unrelated message that merely says 'navigation'", new Error("locator.click: the navigation menu is not visible"), "other");
is("an element detached from the DOM (not a frame)", new Error("locator.click: Element is not attached to the DOM"), "other");
is("a 'Timeout' that is not Playwright's", new Error("Timeout while reading the config"), "other");
is("a strict-mode violation", new Error("locator.click: Error: strict mode violation: locator('button') resolved to 2 elements"), "other");
is("a non-Error value", { reason: 42 }, "other");
is("undefined", undefined, "other");

// ---------------------------------------------------------------- the same errors from a real chromium
console.log("pwErrorKind — errors a real chromium throws:");
{
  const CI = process.env.CI === "true";
  const pw = await import("playwright").catch(() => null); // not installed → skipped (locally)
  const browser = pw ? await pw.chromium.launch().catch(() => null) : null;
  if (!browser) {
    // the runner's marker (test/run-suites.ts): a local run lists this suite as skipped, not as a plain pass
    if (!CI) console.log("SKIPPED (no playwright: chromium unavailable — the real-error checks did not run)");
    check(`[chromium] chromium unavailable — ${CI ? "CI must run this" : "SKIPPED locally"}`, !CI);
  } else {
    // what the call threw (null: it resolved); a call still pending after 15 s reads as a hang, never a stuck suite
    const caught = async (p: Promise<unknown>): Promise<unknown> => {
      try { return await Promise.race([p.then(() => null), sleep(15_000, "the call neither resolved nor threw within 15 s", { ref: false })]); } catch (e) { return e; }
    };
    /** a call left pending in the page, given a frame to be in flight before `then` runs */
    const pending = async (page: Page, then: () => Promise<unknown>): Promise<unknown> => {
      const p = caught(page.evaluate("new Promise(() => {})"));
      await page.evaluate("1");
      await then();
      return p;
    };
    try {
      {
        const page = await browser.newPage();
        await page.setContent("<p>x</p>");
        const e = await caught(page.locator("#none").click({ timeout: 100 }));
        is("locator.click past its timeout (a real TimeoutError)", e, "timeout", page);
        check("…its name is TimeoutError", e instanceof Error && e.name === "TimeoutError");
        is("…its message alone, copied into a plain Error", new Error(e instanceof Error ? e.message : ""), "timeout");
        is("a destroyed context: a pending evaluate when the page navigates", await pending(page, () => page.goto("data:text/html,<p>y</p>")), "navigated", page);
        await page.close();
      }
      {
        const page = await browser.newPage();
        await page.setContent("<p>x</p>");
        const e = await pending(page, () => page.close());
        is("a pending evaluate when the page closes (the page not asked)", e, "gone");
        console.log(`  · (info) the closed error's name: ${e instanceof Error ? e.name : typeof e} (Playwright 1.63: "Error" — the message decides)`);
        is("an evaluate on the closed page (asked)", await caught(page.evaluate("1")), "gone", page);
      }
      {
        const page = await browser.newPage();
        await page.setContent("<p>x</p>");
        // chromium's crash URL kills the renderer; the goto itself never settles cleanly, so it is not awaited
        const e = await pending(page, () => { void page.goto("chrome://crash").catch(() => undefined); return Promise.resolve(); });
        is("a pending evaluate when the page crashes", e, "gone", page);
        is("…the same, the page not asked (the message alone)", e, "gone");
        check("…its user-facing line has no trailing space", (() => { const l = pwFirstLine(e); return l.length > 0 && l === l.trimEnd(); })());
        console.log(`  · (info) the crashed page reports itself closed: ${String(page.isClosed())} (Playwright 1.63: false — only the message tells)`);
        is("an evaluate on the crashed page", await caught(page.evaluate("1")), "gone", page);
      }
      {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent("<p>x</p>");
        is("a pending evaluate when its context closes", await pending(page, () => context.close()), "gone");
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

report();
