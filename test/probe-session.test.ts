// probe-session (design-to-code/probe-session.ts): what the probe's browser phases (the drive, the visual capture, the
// behaviour units) share — the time plan, a fresh context reached like the measurement pass, a unit raced against its share
// of the budget and torn down, a wedged browser told from a slow one. All through a fake browser: no chromium, no port.
// The phases' own work on a real page is the browser e2e suites' (verify-probe-drive-e2e, verify-probe-visual-e2e,
// verify-probe-behaviour-e2e); the browser's capped close is verify-probe.test.ts's.
// Run with:  bun test/probe-session.test.ts
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { check, report } from "./assert.ts";
import {
  CLOSE_STEP_CAP_MS, CUT_SETTLE_MS, KILL_STEP_CAP_MS, PHASE_PLAN, StepError, TEARDOWN_RESERVE_MS, UNIT_FLOOR_MS, WRITE_MARGIN_MS,
  contextOptions, openSession, phaseBudget, unitCap,
} from "../design-to-code/probe-session.ts";
import type { ReachFailure, SessionOptions, UnitSpec } from "../design-to-code/probe-session.ts";

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

// ---------------------------------------------------------------- a fake browser
// Every call is logged in order. A context's close resolves `closed` (what a page op waiting in it sees end), unless
// closeNever (a wedged browser). newContext can answer late (a loaded browser), never, or throw.
interface FakeOpts { contextAfterMs?: number; contextNever?: boolean; newContextThrows?: Error; closeNever?: boolean; closeAfterMs?: number }
interface Fake { browser: Pick<Browser, "newContext">; log: string[]; opts: BrowserContextOptions[]; closes: number; closed: Promise<void>; load(): void }
const isPage = (x: unknown): x is Page => typeof x === "object" && x !== null && "setDefaultTimeout" in x && "addInitScript" in x && "on" in x;
const isContext = (x: unknown): x is BrowserContext => typeof x === "object" && x !== null && "close" in x && "newPage" in x;
function fakeBrowser(o: FakeOpts = {}): Fake {
  let closedNow: () => void = () => undefined;
  const closed = new Promise<void>((r) => { closedNow = r; });
  const loads: Array<() => void> = [];
  const f: Fake = {
    log: [], opts: [], closes: 0, closed, load: () => { for (const cb of loads) cb(); },
    browser: {
      newContext: async (opts?: BrowserContextOptions): Promise<BrowserContext> => {
        f.log.push("newContext");
        if (opts) f.opts.push(opts);
        if (o.newContextThrows) throw o.newContextThrows;
        if (o.contextNever) await never();
        if (o.contextAfterMs !== undefined) await sleep(o.contextAfterMs);
        const page = {
          setDefaultTimeout: (ms: number): void => { f.log.push(`timeout ${ms}`); },
          addInitScript: async (s: { content: string }): Promise<void> => { f.log.push(`init ${s.content}`); },
          on: (ev: string, cb: () => void): unknown => { f.log.push(`on ${ev}`); if (ev === "load") loads.push(cb); return page; },
        };
        const ctx = {
          newPage: async (): Promise<Page> => { f.log.push("newPage"); if (!isPage(page)) throw new Error("fake page"); return page; },
          close: async (): Promise<void> => {
            f.closes++;
            f.log.push("close");
            if (o.closeNever) return never();
            if (o.closeAfterMs !== undefined) await sleep(o.closeAfterMs);
            closedNow();
          },
        };
        if (!isContext(ctx)) throw new Error("fake context");
        return ctx;
      },
    },
  };
  return f;
}
const VIEWPORT = { w: 390, h: 844 };
const sessionOf = (f: Fake, extra: Partial<SessionOptions> = {}) => openSession(f.browser, {
  viewport: VIEWPORT, timeout: 1234, initScript: "INIT", deadline: 180_000, now: () => 0,
  reach: async () => { f.log.push("reach"); }, ...extra,
});
/** A unit that logs what the session called, around the given act. */
function spec<T>(f: Fake, act: UnitSpec<T>["act"], fallback: T, extra: Partial<UnitSpec<T>> = {}): UnitSpec<T> & { unreachedWith: ReachFailure[]; failedWith: unknown[] } {
  const s: UnitSpec<T> & { unreachedWith: ReachFailure[]; failedWith: unknown[] } = {
    ms: 1_000, act, unreachedWith: [], failedWith: [],
    unreached: (r) => { f.log.push("unreached"); s.unreachedWith.push(r); return fallback; },
    failed: (e) => { f.log.push(`failed (after ${f.closes} close)`); s.failedWith.push(e); return fallback; },
    ...extra,
  };
  return s;
}

// ---------------------------------------------------------------- the time plan
console.log("the time plan:");
check("the teardown reserve covers the worst teardown: a cut unit's settle + both capped close steps + the kill + a write margin (≥ 2 s)",
  WRITE_MARGIN_MS >= 2_000 && TEARDOWN_RESERVE_MS >= CUT_SETTLE_MS + 2 * CLOSE_STEP_CAP_MS + KILL_STEP_CAP_MS + WRITE_MARGIN_MS && TEARDOWN_RESERVE_MS === 20_000);
check("the plan: the drive min(60 s, left − 15 s), the visual capture min(30 s, left − the teardown reserve), behaviour min(90 s, left − the teardown reserve)",
  PHASE_PLAN.drive.capMs === 60_000 && PHASE_PLAN.drive.reserveMs === 15_000
  && PHASE_PLAN.visual.capMs === 30_000 && PHASE_PLAN.visual.reserveMs === TEARDOWN_RESERVE_MS
  && PHASE_PLAN.behaviour.capMs === 90_000 && PHASE_PLAN.behaviour.reserveMs === TEARDOWN_RESERVE_MS);
check("phaseBudget(drive): plenty of time → the cap; little → what is left less 15 s; none → 0, never negative",
  phaseBudget("drive", 0, 180_000) === 60_000 && phaseBudget("drive", 130_000, 180_000) === 35_000 && phaseBudget("drive", 0, 16_000) === 1_000 && phaseBudget("drive", 10_000, 16_000) === 0);
check("phaseBudget(visual): the cap; what is left less the teardown reserve; 0, never negative",
  phaseBudget("visual", 0, 180_000) === 30_000 && phaseBudget("visual", 1_000, 1_000 + TEARDOWN_RESERVE_MS + 7_000) === 7_000
  && phaseBudget("visual", 0, TEARDOWN_RESERVE_MS - 1) === 0 && phaseBudget("visual", 0, 5_000) === 0);
check("phaseBudget(behaviour): min(90 s, deadline − now − 20 s), never < 0",
  phaseBudget("behaviour", 0, 180_000) === 90_000 && phaseBudget("behaviour", 0, 50_000) === 30_000 && phaseBudget("behaviour", 0, 15_000) === 0 && phaseBudget("behaviour", 1000, 1000) === 0
  && phaseBudget("behaviour", 0, 60_000) === 60_000 - TEARDOWN_RESERVE_MS);
check("unitCap: an even share of what is left, never under 15 s, never over what is left",
  UNIT_FLOOR_MS === 15_000 && unitCap(60_000, 16) === 15_000 && unitCap(160_000, 4) === 40_000 && unitCap(10_000, 3) === 10_000 && unitCap(90_000, 1) === 90_000 && unitCap(0, 5) === 0);
{
  let now = 0;
  const s = sessionOf(fakeBrowser(), { deadline: 100_000, now: () => now });
  const early = [s.budget("drive"), s.budget("visual"), s.budget("behaviour")];
  now = 70_000;
  const late = [s.budget("drive"), s.budget("visual"), s.budget("behaviour")];
  check(`session.budget: the phase's share of what the run's deadline leaves, read at the time it is asked (saw ${JSON.stringify([early, late])})`,
    JSON.stringify(early) === JSON.stringify([60_000, 30_000, 80_000]) && JSON.stringify(late) === JSON.stringify([15_000, 10_000, 10_000]));
}

// ---------------------------------------------------------------- one context's options, everywhere
console.log("the context:");
check("contextOptions: the viewport, device scale factor 1 by default, reduced motion",
  JSON.stringify(contextOptions(VIEWPORT)) === JSON.stringify({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: "reduce" })
  && contextOptions(VIEWPORT, 2.5).deviceScaleFactor === 2.5);

// ---------------------------------------------------------------- a unit: fresh context → reach → act → close
console.log("a unit:");
{
  const f = fakeBrowser();
  const s = sessionOf(f);
  let loadsSeen = -1;
  const u = spec(f, async (r) => { f.load(); f.load(); loadsSeen = r.loads(); f.log.push("act"); return 7; }, -1, {
    dsf: 2,
    prepare: async (c) => { f.log.push(`prepare ${isContext(c)}`); },
    onPage: (p) => { f.log.push(`onPage ${isPage(p)}`); },
    beforeClose: async () => { f.log.push("beforeClose"); },
  });
  const r = await s.unit(u);
  const want = ["newContext", "prepare true", "newPage", "timeout 1234", "init INIT", "on load", "onPage true", "reach", "act", "beforeClose", "close"];
  check(`a unit opens a fresh context, prepares it before the page exists, sets the timeout, the init script, the load counter and onPage before reach, acts, then closes (saw ${JSON.stringify(f.log)})`,
    JSON.stringify(f.log) === JSON.stringify(want));
  check("…and returns its value, uncut, with the context's options (the unit's own scale)", !r.cut && r.value === 7
    && JSON.stringify(f.opts[0]) === JSON.stringify(contextOptions(VIEWPORT, 2)));
  check("…and loads() counts the documents loaded since the page existed", loadsSeen === 2);
}
{
  const f = fakeBrowser();
  const r = await sessionOf(f).unit(spec(f, async () => "cut", "x"));
  check("a unit whose value is the string 'cut' returns it as its value, not a cut", !r.cut && r.value === "cut");
}
{
  const f = fakeBrowser();
  const s = sessionOf(f, { reach: async () => { f.log.push("reach"); throw new StepError("click Open: no element"); } });
  let acted = false;
  const u = spec(f, async () => { acted = true; return 1; }, 0, { beforeClose: async () => { f.log.push("beforeClose"); } });
  const r = await s.unit(u);
  check(`a step that fails while reaching: unreached with the step's message, the context closed, no act and no beforeClose (saw ${JSON.stringify([f.log, u.unreachedWith])})`,
    !r.cut && r.value === 0 && !acted && JSON.stringify(u.unreachedWith) === JSON.stringify([{ why: "the steps failed — click Open: no element", steps: "click Open: no element" }])
    && JSON.stringify(f.log.slice(-2)) === JSON.stringify(["close", "unreached"]) && !f.log.includes("beforeClose"));
}
{
  const f = fakeBrowser();
  const s = sessionOf(f, { reach: async () => { throw new Error("page.goto: net::ERR_CONNECTION_REFUSED\nCall log: …"); } });
  const u = spec(f, async () => 1, 0);
  await s.unit(u);
  const g = fakeBrowser({ newContextThrows: new Error("browser.newContext: Browser has been closed") });
  const v = spec(g, async () => 1, 0);
  await sessionOf(g).unit(v);
  check(`any other reach failure: "could not reach the screen — <its first line>", the context closed; a newContext that throws is one too, with nothing to close (saw ${JSON.stringify([u.unreachedWith, f.closes, v.unreachedWith, g.closes])})`,
    JSON.stringify(u.unreachedWith) === JSON.stringify([{ why: "could not reach the screen — page.goto: net::ERR_CONNECTION_REFUSED" }]) && f.closes === 1
    && JSON.stringify(v.unreachedWith) === JSON.stringify([{ why: "could not reach the screen — browser.newContext: Browser has been closed" }]) && g.closes === 0);
}
{
  const f = fakeBrowser();
  const s = sessionOf(f);
  const boom = new Error("page.evaluate: Target crashed");
  const u = spec(f, async () => { f.log.push("act"); throw boom; }, -1, { beforeClose: async () => { f.log.push("beforeClose"); } });
  const r = await s.unit(u);
  check(`an act that throws: beforeClose, the close, then failed(e) — the context is closed by the time it is asked (saw ${JSON.stringify(f.log)})`,
    !r.cut && r.value === -1 && u.failedWith[0] === boom && JSON.stringify(f.log.slice(-4)) === JSON.stringify(["act", "beforeClose", "close", "failed (after 1 close)"]));
}
{
  const f = fakeBrowser();
  const hookBoom = new Error("cleanup failed");
  const u = spec(f, async () => 1, -1, { beforeClose: async () => { throw hookBoom; } });
  const r = await sessionOf(f).unit(u);
  check(`a beforeClose that throws still closes the context, then failed(its error) (saw ${JSON.stringify(f.log.slice(-2))})`,
    !r.cut && r.value === -1 && u.failedWith[0] === hookBoom && JSON.stringify(f.log.slice(-2)) === JSON.stringify(["close", "failed (after 1 close)"]));
}
{
  const f = fakeBrowser();
  let acted = false;
  const u = spec(f, async () => { acted = true; return 1; }, 0, { prepare: async () => { f.log.push("prepare"); throw new Error("routeWebSocket: Target closed"); } });
  const r = await sessionOf(f).unit(u);
  check(`a prepare that throws: unreached, the context closed, no page and no act (saw ${JSON.stringify([f.log, u.unreachedWith])})`,
    !r.cut && r.value === 0 && !acted && !f.log.includes("newPage") && f.closes === 1
    && JSON.stringify(u.unreachedWith) === JSON.stringify([{ why: "could not reach the screen — routeWebSocket: Target closed" }]));
}

// ---------------------------------------------------------------- the race: cut, settle, wedge
console.log("the race:");
{
  // the cut closes the context; whatever the act waits on in it ends; onCut runs first
  const f = fakeBrowser();
  const s = sessionOf(f);
  const order: string[] = [];
  const u = spec(f, async () => { await f.closed; order.push("act ended"); throw new Error("Target page, context or browser has been closed"); }, "failed", {
    ms: 30, onCut: () => { order.push(`onCut (closes ${f.closes})`); },
  });
  const t0 = Date.now();
  const r = await s.unit(u);
  check(`past its share the unit is cut: onCut first, then the context closed, the act winds down — a settled cut, well under CUT_SETTLE_MS (saw ${JSON.stringify([order, r, Date.now() - t0])})`,
    r.cut && r.settled && JSON.stringify(order) === JSON.stringify(["onCut (closes 0)", "act ended"]) && f.closes >= 1 && Date.now() - t0 < CUT_SETTLE_MS);
}
{
  // the slow paths run side by side: one CUT_SETTLE_MS wait for all
  const keepAlive = setInterval(() => undefined, 1000); // the settle wait is unref'd: this stands in for the browser's pipes
  const tw = Date.now();
  const SLOW_CLOSE_MS = 2_000;
  // a context created after the cut (a loaded browser's slow newContext): closed as it arrives, the reach waiting in it ends
  const late = fakeBrowser({ contextAfterMs: 200 });
  const lateS = sessionOf(late, { reach: async () => { await late.closed; throw new Error("Target page, context or browser has been closed"); } });
  // a wedged browser: the act never ends and the close never returns
  const wedged = fakeBrowser({ closeNever: true });
  // a slow but alive close: it returns inside the settle window
  const alive = fakeBrowser({ closeAfterMs: SLOW_CLOSE_MS });
  // a browser that never answers newContext: nothing to close, nothing ends
  const silent = fakeBrowser({ contextNever: true });
  // the act finished, but its context's close never returns: the unit's own close holds it past its share
  const closeHung = fakeBrowser({ closeNever: true });
  let closeHungActed = false;
  const [lateR, wedgedR, aliveR, silentR, closeHungR] = await Promise.all([
    lateS.unit(spec(late, async () => 1, 0, { ms: 50 })).then((r) => ({ ...r, ms: Date.now() - tw })),
    sessionOf(wedged).unit(spec(wedged, () => never<number>(), 0, { ms: 20 })).then((r) => ({ ...r, ms: Date.now() - tw })),
    sessionOf(alive).unit(spec(alive, async () => { await alive.closed; return 1; }, 0, { ms: 20 })).then((r) => ({ ...r, ms: Date.now() - tw })),
    sessionOf(silent).unit(spec(silent, async () => 1, 0, { ms: 20 })).then((r) => ({ ...r, ms: Date.now() - tw })),
    sessionOf(closeHung).unit(spec(closeHung, async () => { closeHungActed = true; return 1; }, 0, { ms: 50 })).then((r) => ({ ...r, ms: Date.now() - tw })),
  ]);
  clearInterval(keepAlive);
  check(`a context that arrives after the cut is closed as it arrives, so the cut settles well inside CUT_SETTLE_MS (saw ${JSON.stringify(lateR)})`,
    lateR.cut && lateR.settled && late.closes >= 1 && lateR.ms < CUT_SETTLE_MS);
  check(`a hung act and a hung close → a cut that did not settle (the browser stopped answering), returned at CUT_SETTLE_MS, not later (saw ${JSON.stringify(wedgedR)})`,
    wedgedR.cut && !wedgedR.settled && wedged.closes === 1 && wedgedR.ms >= CUT_SETTLE_MS && wedgedR.ms < CUT_SETTLE_MS + 3_000);
  check(`a slow close that returns inside CUT_SETTLE_MS → a settled cut, not a wedge (saw ${JSON.stringify(aliveR)})`,
    aliveR.cut && aliveR.settled && aliveR.ms >= SLOW_CLOSE_MS && aliveR.ms < CUT_SETTLE_MS);
  check(`a newContext that never answers → a cut that did not settle (saw ${JSON.stringify(silentR)})`, silentR.cut && !silentR.settled && silent.closes === 0);
  check(`an act that finished but whose context close never returns → a cut that did not settle (a wedge), at CUT_SETTLE_MS (saw ${JSON.stringify(closeHungR)})`,
    closeHungActed && closeHungR.cut && !closeHungR.settled && closeHungR.ms >= CUT_SETTLE_MS && closeHungR.ms < CUT_SETTLE_MS + 3_000);
}
{
  // a finished unit leaves no ref'd timer behind (its deadline is cleared however the race ends)
  const refTimers = (): number => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;
  const before = refTimers();
  const f = fakeBrowser();
  await sessionOf(f).unit(spec(f, async () => 1, 0, { ms: 60_000 }));
  await sessionOf(f).unit(spec(f, async () => { throw new Error("x"); }, 0, { ms: 60_000 }));
  check("a unit that finishes (or fails) inside its share leaves no ref'd deadline timer behind", refTimers() === before);
}

report();
