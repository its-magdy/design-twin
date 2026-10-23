// probe-session.ts — what the probe's browser phases share, once: the time plan, a fresh context reached like the
// measurement pass, a unit raced against its share of the budget and torn down, and the browser's capped teardown.
//
// Order in verify-probe: launch (recordLaunchPid) → the measurement pass (its own context, contextOptions) → openSession →
// the interaction drive → the visual capture → the behaviour checks → endBrowser. Each phase after the measurement takes
// its share of what --max-time leaves (session.budget) and runs its work as units (session.unit): every unit on a fresh
// page in a fresh context, reached like the measurement pass, raced against its share, its context closed after it — and
// when the share runs out, closed under it (whatever the unit waits on in it then ends), with a short settle window that
// tells a browser that stopped answering (a cut that did not settle) from a slow one. A phase supplies only its own work
// (act), what to make of a screen not reached (unreached) or of a throw (failed), and what its context needs before the
// page exists (prepare — the behaviour units' WebSocket route) or before the screen is reached (onPage).
//
// The teardown reserve: what the probe may still need after the last phase's budget ends — a cut unit's settle
// (CUT_SETTLE_MS), the capped close of a wedged browser (two CLOSE_STEP_CAP_MS steps, then its kill within KILL_STEP_CAP_MS:
// a short wait for the browser to go on its own, then at most one capped command — pgrep, ps or taskkill — or none) and
// writing the files (WRITE_MARGIN_MS) — all inside --max-time, so a measurement that finished is never lost to the watchdog.
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { firstLine } from "../bridge/src/errmsg.ts";
import { PROC_HOST, killChildTree, parentPid, taskkillCapped, type ProcHost } from "./kill-tree.ts";

/** A --steps step that failed while the screen was reached (the probe's reach throws it). */
export class StepError extends Error {}

// ---------------------------------------------------------------- the time plan
/** What a cut unit may still take to settle after its context is closed. */
export const CUT_SETTLE_MS = 5_000;
export const CLOSE_STEP_CAP_MS = 5_000, KILL_STEP_CAP_MS = 3_000, WRITE_MARGIN_MS = 2_000;
/** The teardown reserve (module header): a cut unit's settle + the capped close + the kill + writing the files. */
export const TEARDOWN_RESERVE_MS = CUT_SETTLE_MS + 2 * CLOSE_STEP_CAP_MS + KILL_STEP_CAP_MS + WRITE_MARGIN_MS;
export type Phase = "drive" | "visual" | "behaviour";
/** Each phase's share: min(capMs, what is left of --max-time less reserveMs) — never < 0. The drive keeps 15 s for writing
 *  up and closing; the visual capture and behaviour keep the teardown reserve. The visual capture runs before behaviour (one
 *  capped load) and behaviour's share is taken afterwards from what is left. */
export const PHASE_PLAN: Readonly<Record<Phase, { capMs: number; reserveMs: number }>> = {
  drive: { capMs: 60_000, reserveMs: 15_000 },
  visual: { capMs: 30_000, reserveMs: TEARDOWN_RESERVE_MS },
  behaviour: { capMs: 90_000, reserveMs: TEARDOWN_RESERVE_MS },
};
/** The phase's share of what is left between `now` and the run's `deadline` (PHASE_PLAN), in ms — never < 0. */
export function phaseBudget(phase: Phase, now: number, deadline: number): number {
  const { capMs, reserveMs } = PHASE_PLAN[phase];
  return Math.max(0, Math.min(capMs, deadline - now - reserveMs));
}
/** A battery unit's own time: an even share of what is left (`unitsLeft` battery units, this one included), never less than
 *  15 s and never more than what is left — one page that freezes (a hang on Enter) cannot eat the rows after it. */
export const UNIT_FLOOR_MS = 15_000;
export function unitCap(leftMs: number, unitsLeft: number, floorMs = UNIT_FLOOR_MS): number {
  return Math.max(0, Math.min(leftMs, Math.max(floorMs, leftMs / Math.max(1, unitsLeft))));
}

// ---------------------------------------------------------------- the context
/** Every probe context's options — the measurement pass's and each unit's: the viewport, a device scale factor (1 but for
 *  the visual capture, which renders at the reference's own scale), reduced motion. No hasTouch / isMobile. */
export function contextOptions(viewport: { w: number; h: number }, dsf = 1): { viewport: { width: number; height: number }; deviceScaleFactor: number; reducedMotion: "reduce" } {
  return { viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: dsf, reducedMotion: "reduce" };
}

// ---------------------------------------------------------------- the race
/** What a raced unit returned: its value, or a cut — `settled` false when the settle window ran out before the context
 *  closed and the unit wound down, i.e. the browser stopped answering. */
export type Raced<T> = { cut: false; value: T } | { cut: true; settled: boolean };
const CUT = Symbol("cut");
const UNSETTLED = Symbol("unsettled");
/** What a raced unit holds for its race: the context it opened (once it exists), and whether the cut has come. */
interface Held { ctx?: { close(): Promise<unknown> }; cut?: boolean }
/** Store the unit's context so a cut can close it — and when the cut came while the context was still being created,
 *  close it at once, so whatever the unit goes on to wait on in it ends instead of running past the settle window. */
function holdContext(held: Held, c: { close(): Promise<unknown> }): void {
  held.ctx = c;
  if (held.cut) void c.close().catch(() => undefined);
}
/**
 * Race `work` against a `ms` deadline. Returns its value, or a cut when the deadline came first — after `onCut` (called at
 * once, before anything is awaited), then closing the context `held` captured (that ends whatever `work` is waiting on; one
 * still being created is closed as it arrives, see holdContext) and giving the close and `work` at most CUT_SETTLE_MS
 * between them. A close that is slow but returns inside that window settles; one that never returns (a wedged browser)
 * does not. `work` never rejects (session.unit maps every throw); the deadline timer is cleared however the race ends.
 */
async function raceBudget<T>(work: Promise<T>, ms: number, held: Held, onCut?: () => void): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let r: T | typeof CUT;
  try {
    r = await Promise.race([work, new Promise<typeof CUT>((resolve) => { timer = setTimeout(() => resolve(CUT), ms); })]);
  } finally {
    clearTimeout(timer);
  }
  if (r !== CUT) return { cut: false, value: r };
  onCut?.();
  // marked first: a context that arrives after this is closed by holdContext as it arrives
  held.cut = true;
  const ctx = held.ctx;
  const wound = (async (): Promise<void> => { if (ctx) await ctx.close().catch(() => undefined); await work; })();
  const s = await Promise.race([wound, sleep(CUT_SETTLE_MS, UNSETTLED, { ref: false })]);
  return { cut: true, settled: s !== UNSETTLED };
}

// ---------------------------------------------------------------- the session
/** The reached page a unit acts on. `loads` counts main-frame document loads from the moment the page exists. */
export interface Reached { page: Page; loads(): number }
/** Why the screen was not reached: a failed --steps step (`steps`, its message) or anything else, as one line. */
export interface ReachFailure { why: string; steps?: string }
export interface UnitSpec<T> {
  /** the unit's share, in ms from now (> 0: a phase with no time left does not start the unit) */
  ms: number;
  /** the context's device scale factor (contextOptions; 1 by default) */
  dsf?: number;
  /** set up the context before its page exists; a throw is a screen not reached */
  prepare?(context: BrowserContext): Promise<void>;
  /** the page exists (its timeout, init script and load counter set) and the screen is not reached yet */
  onPage?(page: Page): void;
  /** the unit's work on the reached screen; the session closes the context after it */
  act(r: Reached): Promise<T>;
  /** after act returned or threw, before the context closes (bounded by the caller: the race does not wait for it) */
  beforeClose?(): Promise<void>;
  /** the screen was not reached (the context is closed by then) */
  unreached(why: ReachFailure): T;
  /** act threw (the context is closed by then: the error alone says what happened) */
  failed(e: unknown): T;
  /** the unit's share ran out — called at once, before its context is closed */
  onCut?(): void;
}
export interface SessionOptions {
  viewport: { w: number; h: number };
  /** per-action timeout (the probe's --timeout) */
  timeout: number;
  /** the probe's init script (no transitions/animations; the per-document token window.__dtProbeDoc) */
  initScript: string;
  /** goto → settle → steps → settle(--ready) on a fresh page, as the measurement pass; throws StepError when a step fails */
  reach(page: Page): Promise<void>;
  /** the run's --max-time deadline (epoch ms) */
  deadline: number;
  /** the clock (Date.now; the tests' own) */
  now?: () => number;
}
export interface ProbeSession<B> {
  readonly browser: B;
  readonly viewport: { w: number; h: number };
  readonly timeout: number;
  /** the phase's share of what the run's deadline leaves now (phaseBudget) */
  budget(phase: Phase): number;
  /** One unit: a fresh context and page, the screen reached, act, the context closed — raced against spec.ms. Never
   *  rejects: a screen not reached is spec.unreached, a throw spec.failed, the share running out a cut. Returns by about
   *  spec.ms + CUT_SETTLE_MS even when the browser stops answering. */
  unit<T>(spec: UnitSpec<T>): Promise<Raced<T>>;
}

/** Open the browser phases' session on a launched browser. It holds no browser resource of its own: each unit opens and
 *  closes its context; the browser itself is ended by endBrowser. */
export function openSession<B extends Pick<Browser, "newContext">>(browser: B, o: SessionOptions): ProbeSession<B> {
  const now = o.now ?? Date.now;
  /** a fresh context + page, reached; the context is held BEFORE the screen is reached, so a cut can close it while reach is
   *  still waiting */
  const open = async <T>(spec: UnitSpec<T>, held: Held): Promise<{ context: BrowserContext; reached: Reached }> => {
    const context = await browser.newContext(contextOptions(o.viewport, spec.dsf));
    holdContext(held, context);
    let loads = 0;
    try {
      if (spec.prepare) await spec.prepare(context);
      const page = await context.newPage();
      page.setDefaultTimeout(o.timeout);
      await page.addInitScript({ content: o.initScript });
      page.on("load", () => { loads++; });
      if (spec.onPage) spec.onPage(page);
      await o.reach(page);
      return { context, reached: { page, loads: () => loads } };
    } catch (e) {
      await context.close().catch(() => undefined);
      throw e;
    }
  };
  return {
    browser, viewport: o.viewport, timeout: o.timeout,
    budget: (phase) => phaseBudget(phase, now(), o.deadline),
    unit: async <T>(spec: UnitSpec<T>): Promise<Raced<T>> => {
      const held: Held = {};
      const work = (async (): Promise<T> => {
        let opened: Awaited<ReturnType<typeof open>>;
        try {
          opened = await open(spec, held);
        } catch (e) {
          return spec.unreached(e instanceof StepError ? { why: `the steps failed — ${e.message}`, steps: e.message } : { why: `could not reach the screen — ${firstLine(e)}` });
        }
        try {
          return await spec.act(opened.reached);
        } finally {
          // the context closes even when beforeClose throws (its throw then goes to spec.failed)
          try { if (spec.beforeClose) await spec.beforeClose(); } finally { await opened.context.close().catch(() => undefined); }
        }
      })().catch((e: unknown) => spec.failed(e));
      return raceBudget(work, spec.ms, held, spec.onCut);
    },
  };
}

// ---------------------------------------------------------------- the browser's teardown
/** The pid of each browser this process launched — what closeCapped ends when the browser does not go. */
const launchPids = new WeakMap<object, number>();
/** Records the launched browser's pid (launchPid) for closeCapped. Called once the browser is held where the --max-time
 *  watchdog closes it, so a watchdog firing during this ≤ LAUNCH_PID_CAP_MS wait still closes the browser (its pid then
 *  unknown: closeCapped ends this process's direct children). */
export async function recordLaunchPid(browser: Browser): Promise<void> {
  const pid = await launchPid(browser);
  if (pid !== undefined) launchPids.set(browser, pid);
}
/** What launchPid asks of a browser CDP session (a Playwright CDPSession is one). */
interface ProcessInfoSession {
  send(method: "SystemInfo.getProcessInfo"): Promise<{ processInfo: Array<{ type: string; id: number }> }>;
  detach(): Promise<void>;
}
/** How long launchPid waits for the browser's answer. */
const LAUNCH_PID_CAP_MS = 2_000;
/** How long the kill waits for the browser to go on its own before it is killed. */
const KILL_GRACE_MS = 1_000;
/** The cap on the kill's one command: the wait and the command together fit in KILL_STEP_CAP_MS. */
const KILL_CMD_CAP_MS = KILL_STEP_CAP_MS - KILL_GRACE_MS;
/** The host the probe's kill runs on: the real one, its taskkill capped like its pgrep/ps. */
const PROBE_HOST: ProcHost = { ...PROC_HOST, taskkill: taskkillCapped(KILL_CMD_CAP_MS) };
/** The browser's own pid, as it reports it (CDP SystemInfo.getProcessInfo, the entry of type "browser" — the process
 *  Playwright launched; an experimental domain), or undefined when it does not answer within capMs (closeCapped then ends
 *  this process's direct children instead). On Linux the reported pid must be a child of this process (/proc/<pid>/stat):
 *  a --browser-path wrapper that runs the browser in its own pid namespace reports a pid from that namespace, which here
 *  names another process — so a pid whose parent is not this process, or cannot be read, counts as unknown. `host` is for
 *  the tests. Never throws. */
export async function launchPid(b: { newBrowserCDPSession(): Promise<ProcessInfoSession> }, capMs = LAUNCH_PID_CAP_MS,
  host: Pick<ProcHost, "platform" | "self" | "readFile"> = PROBE_HOST): Promise<number | undefined> {
  const ask = (async (): Promise<number | undefined> => {
    const cdp = await b.newBrowserCDPSession();
    try {
      const id = (await cdp.send("SystemInfo.getProcessInfo")).processInfo.find((p) => p.type === "browser")?.id;
      if (id === undefined || !Number.isInteger(id) || id <= 1) return undefined;
      return host.platform !== "linux" || parentPid(id, host) === host.self ? id : undefined;
    } finally { cdp.detach().catch(() => undefined); }
  })().catch(() => undefined);
  return Promise.race([ask, sleep(capMs, undefined, { ref: false })]);
}

/** Close the browser even when a page never yields: browser.close() closes each page first, and a page whose script never
 *  yields does not close — so ask the browser PROCESS to quit (CDP Browser.close, Chromium), then close the handle; each
 *  step capped at CLOSE_STEP_CAP_MS (unref'd caps: a pending cap must not keep the process alive once the browser is gone).
 *  Then the browser is ended with what it started if it is still running (killBrowser) — a wedged one (it answers nothing,
 *  still connected), and on POSIX one that is merely slow to go: after Browser.close the handle is disconnected at once, but
 *  under load the process can take seconds to minutes to exit, and this process waits on its pipes past --max-time. The probe
 *  launched it and the browser was told to quit, so no page can be live after that and measured.json may be written.
 *  On Windows `exited` (killBrowser) is: the close resolved, or the browser reads disconnected (its CDP pipe has closed). Then
 *  no taskkill runs here: the exit has happened, so the pid may already be another process's and taskkill /T would end that
 *  one's tree, or the pid is still held by this process and the browser is only slow to go, which is left to Playwright's own
 *  kill (exitWhenDone ends the process, and Playwright's exit hook runs taskkill for a browser it has not seen close). Neither
 *  a resolved close nor a disconnect proves the process exited (the pipe can close first; a close after the dispatcher is
 *  gone resolves on the disconnect alone). A close that hits its cap can follow an exit (Playwright's cleanup after the
 *  process closes, e.g. a profile directory it cannot remove, takes seconds): the disconnect covers it. A wedged browser stays
 *  connected and keeps its taskkill; so does one whose close rejects while connected. What remains is a still-connected
 *  browser that exits between that check and the taskkill.
 *  `pid` is the browser's (launchPid, recorded at launch); `host` is for the tests. */
export async function closeCapped(b: Pick<Browser, "newBrowserCDPSession" | "close" | "isConnected">, capMs = CLOSE_STEP_CAP_MS, pid: number | undefined = launchPids.get(b),
  host: ProcHost = PROBE_HOST): Promise<void> {
  const cap = (): Promise<false> => sleep(capMs, false, { ref: false });
  await Promise.race([b.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => undefined), cap()]);
  const closed = await Promise.race([b.close().then(() => true, () => false), cap()]);
  await killBrowser(pid, host, KILL_GRACE_MS, closed || !b.isConnected());
}
/** End the browser after the phases. A browser that stopped answering (a cut that did not settle) is killed at once, with
 *  no grace and no capped close steps to wait for, then its handle gets a 1 s close; any other goes through closeCapped
 *  (the behaviour units run arbitrary page code: a page that never yields does not close). */
export async function endBrowser(b: Pick<Browser, "newBrowserCDPSession" | "close" | "isConnected">, o: { wedged: boolean }): Promise<void> {
  if (!o.wedged) { await closeCapped(b); return; }
  await killBrowser(launchPids.get(b), PROBE_HOST, 0);
  await Promise.race([b.close().catch(() => undefined), sleep(1000, undefined, { ref: false })]);
}
/** End the browser this process launched and what it started — the last step of closeCapped, best-effort, never throws, by
 *  pid only (never by name: never the user's own browser). It first waits up to `graceMs` (KILL_GRACE_MS; 0 for a browser
 *  that stopped answering) for the browser to go on its own. The browser's pid known (launchPid): POSIX SIGKILLs its process
 *  group (Playwright spawns it detached, so it leads one; that also reaches descendants the browser left after it exited),
 *  no command run; Windows runs `taskkill /T /F /PID` (hidden) while that pid exists, and not at all when `exited` (the
 *  close resolved or the browser is disconnected: it may have exited and its pid be another process's by now — see
 *  killChildTree). Unknown: each direct
 *  child of this process is ended — its only children are its browsers (its other commands are synchronous) — found by a
 *  /proc scan (Linux) or `pgrep -P` (else `ps` when pgrep is missing); Windows then leaves the browser to Playwright's exit
 *  hook (exitWhenDone). The wait and at most one command (pgrep, ps or taskkill, capped at KILL_CMD_CAP_MS) fit in
 *  KILL_STEP_CAP_MS, which the teardown reserve includes. */
async function killBrowser(pid: number | undefined, host: ProcHost = PROBE_HOST, graceMs = KILL_GRACE_MS, exited = false): Promise<void> {
  await killChildTree(pid, host, { capMs: KILL_CMD_CAP_MS, graceMs, exited }).catch(() => undefined);
}
