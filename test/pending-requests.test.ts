// bridge/src/pending-requests.ts — the one lifecycle of a command the bridge has sent and not yet settled — driven
// through its own interface with a fake clock (test/fake-clock.ts): every budget / stall / abort / reply / lost / close
// rule, stepped by hand, with no port and no sleep. bridge.test.ts keeps the few socket checks that the bridge's
// handlers feed it (wiring); the rules themselves are pinned here.
// Run with:  bun test/pending-requests.test.ts
import { getEventListeners } from "node:events";
import { ok, report } from "./assert.ts";
import { fakeClock } from "./fake-clock.ts";
import type { FakeClock } from "./fake-clock.ts";
import { createPendingRequests } from "../bridge/src/pending-requests.ts";
import type { PendingSpec } from "../bridge/src/pending-requests.ts";
import { deadline, systemClock } from "../bridge/src/clock.ts";

interface Conn { connId: string }
type Tick = { phase: string };
const c1: Conn = { connId: "c1" }, c2: Conn = { connId: "c2" };

/** One table on a fresh fake clock, with every cancel it sends recorded as `<connId>:<id>`. */
function world() {
  const clock = fakeClock();
  const cancels: string[] = [];
  const t = createPendingRequests<Conn, Tick>({ clock, sendCancel: (conn, id) => { cancels.push(conn.connId + ":" + id); } });
  return { clock, cancels, t };
}

/** A request's outcome, readable synchronously after the microtasks a step leaves (see `flush`). */
interface Watch { state: "pending" | "resolved" | "rejected"; value: unknown; error: Error | null; at: number | null }
function watch(clock: FakeClock, p: Promise<unknown>): Watch {
  const w: Watch = { state: "pending", value: undefined, error: null, at: null };
  p.then((v) => { w.state = "resolved"; w.value = v; w.at = clock.now(); }, (e: unknown) => { w.state = "rejected"; w.error = e instanceof Error ? e : new Error(String(e)); w.at = clock.now(); });
  return w;
}
const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });

const TIMED_OUT = "budget ran out";
const STALLED = "stalled";
const spec = (id: string, over: Partial<PendingSpec<Conn, Tick>> = {}): PendingSpec<Conn, Tick> =>
  ({ id, conn: c1, budgetMs: 400, timedOut: () => new Error(TIMED_OUT), ...over });
const stall = (ms: number) => ({ ms, error: () => new Error(STALLED) });

// ---------------------------------------------------------------- the budget
console.log("pending-requests — the budget, armed at send and re-armed by the request's own start:");
{
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  clock.advance(399); await flush();
  ok("[budget] still pending one ms before the budget", w.state === "pending" && cancels.length === 0);
  clock.advance(1); await flush();
  ok("[budget] rejects at exactly the budget, with the request's own timeout error", w.state === "rejected" && w.error?.message === TIMED_OUT && w.at === 400);
  ok("[budget] …and the plugin is told: one cancel, for that request on its connection", cancels.join() === "c1:r1");
  ok("[budget] …and nothing is left in the table or armed on the clock", t.size() === 0 && clock.armed() === 0);
}
{
  // queued 300 ms of a 400 ms budget, then its own start: the run gets the whole budget again, counted from the start.
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  clock.advance(100);
  t.progress("c1", "r1", { phase: "queued" }, false);
  clock.advance(200);
  t.progress("c1", "r1", { phase: "start" }, true);
  clock.advance(399); await flush();
  ok("[budget] the request's own start re-arms it IN FULL: 699 ms after send (399 into its run) it is still pending", w.state === "pending");
  clock.advance(1); await flush();
  ok("[budget] …and a run that starts and never answers times out one budget after its start", w.state === "rejected" && w.error?.message === TIMED_OUT && w.at === 700 && cancels.join() === "c1:r1");
}
{
  const { clock, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  clock.advance(300);
  t.progress("c1", "r1", { phase: "queued" }, false);
  clock.advance(100); await flush();
  ok("[budget] a `queued` frame for the request re-arms nothing (only `start` does)", w.state === "rejected" && w.at === 400);
}
{
  // A start that is not this request's own: id-less, another request's id, or the right id on another connection.
  for (const [what, connId, requestId] of [["an id-less start (an older plugin, or anyone's)", "c1", null], ["another request's start", "c1", "r9"], ["its id on ANOTHER connection", "c2", "r1"]] as const) {
    const { clock, t } = world();
    const w = watch(clock, t.open(spec("r1")));
    clock.advance(300);
    t.progress(connId, requestId, { phase: "start" }, true);
    clock.advance(100); await flush();
    ok(`[budget] ${what} does not re-arm it: it still times out one budget after the send`, w.state === "rejected" && w.at === 400);
  }
}
{
  // Re-armed more than once (a plugin that relays start twice): each restarts the whole window.
  const { clock, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  clock.advance(350); t.progress("c1", "r1", { phase: "start" }, true);
  clock.advance(350); t.progress("c1", "r1", { phase: "start" }, true);
  clock.advance(399); await flush();
  const mid = w.state;
  clock.advance(1); await flush();
  ok("[budget] every own start restarts the whole window from that start", mid === "pending" && w.at === 1100);
}

// ---------------------------------------------------------------- the stall check
console.log("\npending-requests — the stall check: a frame from the connection after the send, or give up:");
{
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1", { budgetMs: 60000, stall: stall(300) })));
  clock.advance(299); await flush();
  const before = w.state;
  clock.advance(1); await flush();
  ok("[stall] a connection that sends nothing after the send stalls at exactly the stall window, not the budget",
    before === "pending" && w.state === "rejected" && w.error?.message === STALLED && w.at === 300);
  ok("[stall] …and the plugin gets the cancel, and both timers are gone", cancels.join() === "c1:r1" && clock.armed() === 0 && t.size() === 0);
}
{
  // Life heard BEFORE the request was opened is not life for it: a frame earlier on the connection, or a connect in
  // the same instant as the send, disarms nothing.
  const { clock, t } = world();
  t.heard("c1");
  const w = watch(clock, t.open(spec("r1", { budgetMs: 60000, stall: stall(300) })));
  clock.advance(300); await flush();
  ok("[stall] a frame heard before the send does not disarm it: the request still stalls", w.state === "rejected" && w.error?.message === STALLED);
}
{
  // Once the plugin has shown ANY life for the request, silence is work, not a stall — only the budget bounds it.
  const { clock, t } = world();
  const w = watch(clock, t.open(spec("r1", { budgetMs: 5000, stall: stall(300) })));
  clock.advance(100);
  t.heard("c1");
  clock.advance(4899); await flush();
  const quiet = w.state;
  clock.advance(1); await flush();
  ok("[stall] the first frame after the send disarms it for good: 4.9 s of silence after it is still pending",
    quiet === "pending");
  ok("[stall] …and the budget still bounds it, with the timeout error (not the stall's), at the budget", w.state === "rejected" && w.error?.message === TIMED_OUT && w.at === 5000);
}
{
  // Any frame counts — a hello, a reply to another request, a tick — and a frame on ANOTHER connection does not.
  const { clock, t } = world();
  const mine = watch(clock, t.open(spec("r1", { budgetMs: 60000, stall: stall(300) })));
  const theirs = watch(clock, t.open(spec("r2", { conn: c2, budgetMs: 60000, stall: stall(300) })));
  clock.advance(200);
  t.heard("c2");
  clock.advance(100); await flush();
  ok("[stall] a frame from another connection disarms only that connection's requests", mine.state === "rejected" && mine.error?.message === STALLED && theirs.state === "pending");
}
{
  // Every request pending on the connection hears the same frame: one frame disarms them all.
  const { clock, t } = world();
  const a = watch(clock, t.open(spec("r1", { budgetMs: 60000, stall: stall(300) })));
  clock.advance(100);
  const b = watch(clock, t.open(spec("r2", { budgetMs: 60000, stall: stall(300) })));
  clock.advance(100);
  t.heard("c1");
  clock.advance(1000); await flush();
  ok("[stall] one frame disarms every request pending on that connection", a.state === "pending" && b.state === "pending");
}
{
  const { clock, t } = world();
  const w = watch(clock, t.open(spec("r1", { budgetMs: 60000 })));
  const z = watch(clock, t.open(spec("r2", { budgetMs: 60000, stall: { ms: 0, error: () => new Error(STALLED) } })));
  clock.advance(59999); await flush();
  ok("[stall] no stall check without one (or with a window of 0): only the budget runs", w.state === "pending" && z.state === "pending" && clock.armed() === 2);
}

// ---------------------------------------------------------------- the caller's signal
console.log("\npending-requests — the caller giving up:");
{
  const { clock, cancels, t } = world();
  const ac = new AbortController();
  const w = watch(clock, t.open(spec("r1", { signal: ac.signal })));
  const listening = getEventListeners(ac.signal, "abort").length;
  clock.advance(50);
  ac.abort(); await flush();
  ok("[abort] aborted while pending → cancel sent, rejects \"request aborted by the caller\" at once",
    listening === 1 && w.state === "rejected" && w.error?.message === "request aborted by the caller" && w.at === 50 && cancels.join() === "c1:r1");
  ok("[abort] …and leaves no timer armed and no listener behind", clock.armed() === 0 && getEventListeners(ac.signal, "abort").length === 0);
}
{
  const { clock, t } = world();
  const ac = new AbortController();
  const w = watch(clock, t.open(spec("r1", { signal: ac.signal })));
  ac.abort(new Error("the daemon's client disconnected before the reply")); await flush();
  ok("[abort] an Error given as the reason is the rejection itself", w.error?.message === "the daemon's client disconnected before the reply");
}
{
  const { clock, cancels, t } = world();
  const ac = new AbortController();
  ac.abort();
  const w = watch(clock, t.open(spec("r1", { signal: ac.signal })));
  const why = new AbortController();
  why.abort(new Error("the caller had already left"));
  const w2 = watch(clock, t.open(spec("r2", { signal: why.signal })));
  await flush();
  ok("[abort] a signal aborted before open rejects \"request aborted before it was sent\", opens nothing and cancels nothing",
    w.error?.message === "request aborted before it was sent" && !t.has("r1") && cancels.length === 0 && clock.armed() === 0);
  ok("[abort] …or with the caller's own Error", w2.error?.message === "the caller had already left" && !t.has("r2"));
}
{
  // One long-lived signal across many requests: each settled one takes its listener with it, and an abort after they
  // settled cancels nothing.
  const { clock, cancels, t } = world();
  const ac = new AbortController();
  const a = watch(clock, t.open(spec("r1", { signal: ac.signal })));
  const b = watch(clock, t.open(spec("r2", { signal: ac.signal })));
  const both = getEventListeners(ac.signal, "abort").length;
  t.reply("c1", "r1", { ok: true, result: 1 });
  const afterReply = getEventListeners(ac.signal, "abort").length;
  clock.advance(400); await flush();
  // Counted BEFORE the abort below: an abort drops `once` listeners on its own, so it would hide one a settle leaked.
  const afterTimeout = getEventListeners(ac.signal, "abort").length;
  ac.abort(); await flush();
  ok("[abort] a shared signal: one listener per pending request, one fewer once each settles (reply, then timeout), and a late abort sends nothing more",
    both === 2 && afterReply === 1 && afterTimeout === 0 && a.state === "resolved" && b.error?.message === TIMED_OUT && cancels.join() === "c1:r2");
}

// ---------------------------------------------------------------- replies
console.log("\npending-requests — replies, only from the connection the request went to:");
{
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1", { stall: stall(300) })));
  t.reply("c2", "r1", { ok: true, result: "from-c2" });
  await flush();
  const after = w.state;
  t.reply("c1", "r1", { ok: true, result: "from-c1" });
  await flush();
  ok("[reply] a reply carrying the id on another connection is ignored; its own connection's resolves it",
    after === "pending" && w.state === "resolved" && w.value === "from-c1");
  ok("[reply] …a settled request leaves no timers (budget and stall) and sends no cancel", clock.armed() === 0 && cancels.length === 0 && t.size() === 0);
  t.reply("c1", "r1", { ok: true, result: "again" });
  t.reply("c1", "r-nobody", { ok: true, result: "?" });
  ok("[reply] a second reply, or one for an id nobody here knows, is dropped", w.value === "from-c1");
}
{
  const { clock, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  t.reply("c1", "r1", { ok: false, error: new Error("plugin error: boom") });
  await flush();
  ok("[reply] an error reply rejects with that error", w.state === "rejected" && w.error?.message === "plugin error: boom" && clock.armed() === 0);
}
{
  // A timer and a reply race: whichever comes first wins and the other is nothing.
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  clock.advance(400);
  t.reply("c1", "r1", { ok: true, result: "late" });
  await flush();
  ok("[reply] a reply after the budget ran out settles nothing (the timeout stands)", w.error?.message === TIMED_OUT && cancels.length === 1);
}

// ---------------------------------------------------------------- progress fan-out
console.log("\npending-requests — progress ticks:");
{
  const { clock, t } = world();
  const seen: Record<string, string[]> = { a: [], b: [], o: [] };
  watch(clock, t.open(spec("rA", { onProgress: (k) => seen.a?.push(k.phase) })));
  watch(clock, t.open(spec("rB", { onProgress: (k) => seen.b?.push(k.phase) })));
  watch(clock, t.open(spec("rO", { conn: c2, onProgress: (k) => seen.o?.push(k.phase) })));
  watch(clock, t.open(spec("rX", { onProgress: () => { throw new Error("listener failure"); } })));
  t.progress("c1", "rA", { phase: "start" }, true);
  t.progress("c1", "rB", { phase: "queued" }, false);
  t.progress("c1", null, { phase: "pages" }, false);
  t.progress("c1", "r-unknown", { phase: "queued" }, false);
  ok("[progress] an id-carrying tick reaches only its request; an id-less one every request on the connection; none crosses connections; a throwing listener is its own",
    seen.a?.join() === "start,pages" && seen.b?.join() === "queued,pages" && seen.o?.length === 0 && t.has("rX"));
}

// ---------------------------------------------------------------- a connection lost, a send dropped, the bridge closed
console.log("\npending-requests — a connection lost, a send that never left, the bridge closing:");
{
  const { clock, cancels, t } = world();
  const a = watch(clock, t.open(spec("r1")));
  const b = watch(clock, t.open(spec("r2", { stall: stall(300) })));
  const other = watch(clock, t.open(spec("r3", { conn: c2 })));
  t.lost("c1", () => new Error("Figma plugin disconnected before replying"));
  await flush();
  ok("[lost] a closing connection fails ITS pending requests at once, with the reason, and sends no cancel",
    a.error?.message === "Figma plugin disconnected before replying" && b.state === "rejected" && cancels.length === 0);
  ok("[lost] …another connection's request is untouched (only its own budget is still armed)", other.state === "pending" && t.size() === 1 && clock.armed() === 1);
}
{
  const { clock, cancels, t } = world();
  const w = watch(clock, t.open(spec("r1")));
  t.fail("r1", new Error("could not send"));
  await flush();
  ok("[fail] a send that never left rejects now, with no cancel and no timer left", w.error?.message === "could not send" && cancels.length === 0 && clock.armed() === 0);
}
{
  // close(): every cancel goes out BEFORE any request is rejected (the sockets are still open), then all reject.
  const clock = fakeClock();
  const events: string[] = [];
  const t = createPendingRequests<Conn, Tick>({ clock, sendCancel: (conn, id) => { events.push("cancel " + conn.connId + ":" + id); } });
  const a = t.open(spec("r1")).catch((e: unknown) => { events.push("reject r1: " + (e instanceof Error ? e.message : "")); });
  const b = t.open(spec("r2", { conn: c2 })).catch((e: unknown) => { events.push("reject r2: " + (e instanceof Error ? e.message : "")); });
  t.close(() => new Error("bridge closed"));
  await Promise.all([a, b]);
  ok("[close] a cancel for every pending request first, then every one rejects \"bridge closed\"; nothing left armed",
    events.join("|") === "cancel c1:r1|cancel c2:r2|reject r1: bridge closed|reject r2: bridge closed" && t.size() === 0 && clock.armed() === 0);
}

// ---------------------------------------------------------------- the clock seam itself
console.log("\nclock — the deadline rule and the two adapters:");
{
  const clock = fakeClock();
  let fired = 0;
  const d = deadline(clock, 100, () => { fired++; });
  clock.advance(60); d.rearm();
  clock.advance(99);
  const early = fired;
  clock.advance(1);
  clock.advance(1000);
  ok("[deadline] rearm restarts the whole window from now; it expires once per arming", early === 0 && fired === 1 && !d.armed);
  d.rearm(); d.cancel(); clock.advance(1000);
  ok("[deadline] a cancel disarms it (a rearm after it expired arms it again)", fired === 1 && !d.armed && clock.armed() === 0);
}
{
  const clock = fakeClock(1000);
  const order: string[] = [];
  clock.after(20, () => order.push("b"));
  clock.after(10, () => { order.push("a"); clock.after(5, () => order.push("a+5")); });
  clock.after(20, () => order.push("c"));
  const stop = clock.after(15, () => order.push("cancelled"));
  stop(); stop();
  clock.advance(20);
  ok("[fake clock] timers run in due order (ties in arming order), including one armed by another within the advance; a cancel is idempotent",
    order.join() === "a,a+5,b,c" && clock.now() === 1020 && clock.armed() === 0);
}
{
  // The real adapter: performance.now() and setTimeout, cancellable, and unref on request.
  const t0 = systemClock.now();
  const ran = await new Promise<boolean>((resolve) => { systemClock.after(5, () => resolve(true)); });
  let cancelledRan = false;
  const stop = systemClock.after(5, () => { cancelledRan = true; });
  stop();
  await new Promise((r) => { setTimeout(r, 30); });
  ok("[system clock] runs a timer after its delay on the monotonic clock, and a cancelled one never", ran && systemClock.now() - t0 >= 4 && !cancelledRan);
}

report();
