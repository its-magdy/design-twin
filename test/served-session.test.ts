// bridge/src/served-session.ts — the daemon's served session, apart from its socket — driven through its own interface:
// clients are `connect(write)` handles fed lines, the bridge is a fake that answers when told, and the idle clock is a
// fake one (test/fake-clock.ts). Frames and activity, control commands, forwarding and progress, the idle decision,
// cancel when a client leaves, and shutdown's order — no socket, no sleep. The socket itself (listen, takeover,
// handshake) stays with the suites that open one (mcp-lifecycle, daemon-sock, bridge.test.ts).
// Run with:  bun test/served-session.test.ts
import { ok, report } from "./assert.ts";
import { fakeClock } from "./fake-clock.ts";
import { malformed } from "./fixtures.ts";
import { createServedSession } from "../bridge/src/served-session.ts";
import type { DaemonBridge, SessionFrame } from "../bridge/src/served-session.ts";
import type { Cmd, Commands } from "../bridge/src/commands.ts";
import type { Sent, UpstreamRequest } from "../bridge/src/route.ts";
import type { ClientRow, ProgressTick } from "../bridge/src/server-core.ts";

const flush = (): Promise<void> => new Promise((r) => { setImmediate(r); });
const ROW: ClientRow = { connId: "c1", file: "Sample App", fileKey: null, page: "Home", instanceId: "i1", connectedAt: 1, uptimeMs: 1, identified: true, pluginVersion: null, pluginStale: null };
const TICK: ProgressTick = { phase: "pages", page: { index: 1, of: 2, name: "P1" }, nodes: 3, assets: null };

/** A bridge whose every request waits until the test answers it (`answer` / `fail`), recording what it was asked. */
function fakeBridge() {
  interface Asked { cmd: Cmd; args: unknown; o: UpstreamRequest; answer(reply: unknown, client?: ClientRow | null): void; fail(e: Error): void }
  const asked: Asked[] = [];
  const events: string[] = [];
  let tap: (e: string) => void = () => {};
  const push = (e: string): void => { events.push(e); tap(e); };
  const b: DaemonBridge = {
    port: 8787,
    isConnected: () => true,
    request<C extends Cmd>(cmd: C, args: Commands[C]["args"] | undefined, o: UpstreamRequest): Promise<Sent<C>> {
      return new Promise<Sent<C>>((resolve, reject) => {
        o.signal?.addEventListener("abort", () => { push(`abort ${cmd}: ${o.signal?.reason instanceof Error ? o.signal.reason.message : ""}`); }, { once: true });
        asked.push({ cmd, args, o, answer: (reply, client = ROW) => resolve({ reply: malformed<Commands[C]["reply"]>(reply), client }), fail: reject });
      });
    },
    close: () => { push("bridge closed"); },
    listClients: () => [ROW],
  };
  return { b, asked, events, onEvent: (fn: (e: string) => void): void => { tap = fn; } };
}

/** One session on a fake clock, and a way to open clients whose written frames are recorded. */
function world(idleMs = 0) {
  const clock = fakeClock();
  const f = fakeBridge();
  const logs: string[] = [];
  // `order`: every write, release, abort, bridge close and log line, in the order they happened — what an ordering check reads.
  const order: string[] = [];
  const at = (e: string): void => { order.push(e); };
  const s = createServedSession(f.b, { idleMs, clock, pid: 4242, log: (m) => { logs.push(m); at("log " + m); }, release: () => { f.events.push("released"); at("released"); } });
  f.onEvent(at);
  const client = () => {
    const out: SessionFrame[] = [];
    const c = s.connect((fr) => { out.push(fr); at("write " + JSON.stringify(fr)); });
    const send = (frame: unknown): void => { c.line(typeof frame === "string" ? frame : JSON.stringify(frame)); };
    return { c, out, send };
  };
  return { clock, s, client, logs, order, ...f };
}
const last = (out: SessionFrame[]): Record<string, unknown> => out.at(-1) ?? {};

// ---------------------------------------------------------------- frames and activity
console.log("served-session — frames, activity and the request frame check:");
{
  const { clock, s, client, asked } = world();
  const a = client();
  ok("[frames] nothing seen yet: 0 frames, 0 in flight", s.activity().frames === 0 && s.activity().inFlight === 0);
  a.send("{not json");
  ok("[frames] a line that is not JSON is answered \"bad request frame\" (no id), and still counts as a frame",
    last(a.out).ok === false && /^bad request frame: /.test(String(last(a.out).error)) && s.activity().frames === 1);
  for (const [frame, why] of [[{}, "`cmd` is missing"], [{ cmd: "nope" }, "unknown cmd 'nope'"], [{ cmd: "ping", timeoutMs: "x" }, "`timeoutMs` is not a positive number"], [{ cmd: "ping", progress: 1 }, "`progress` is not a boolean"]] as const) {
    a.send(frame);
    ok(`[frames] ${JSON.stringify(frame)} is refused before anything reads it: ${why}`, last(a.out).error === "bad request frame: " + why);
  }
  ok("[frames] …and none of them reached the bridge", asked.length === 0 && s.activity().frames === 5);
  clock.advance(1234);
  ok("[frames] idleForMs counts from the last frame", s.activity().idleForMs === 1234);
  a.send({ cmd: "__ping", id: "p" });
  ok("[frames] a control frame counts too, and resets the idle clock", s.activity().frames === 6 && s.activity().idleForMs === 0);
}

// ---------------------------------------------------------------- control commands
console.log("\nserved-session — __ping, __status, __shutdown:");
{
  const { clock, s, client, asked, events, order } = world(300);
  const a = client();
  a.send({ cmd: "__ping", id: "p1" });
  ok("[control] __ping answers who this daemon is, with the id", JSON.stringify(last(a.out)) === JSON.stringify({ ok: true, id: "p1", result: { daemon: true, pid: 4242, port: 8787 } }));
  clock.advance(120);
  const before = s.status();
  a.send({ cmd: "__status" });
  const st = last(a.out).result as Record<string, unknown>;
  ok("[control] __status is the session's snapshot: the bridge's port, connection and clients, the idle window and how long it has been quiet",
    st.daemon === true && st.pid === 4242 && st.port === 8787 && st.pluginConnected === true && JSON.stringify(st.clients) === JSON.stringify([ROW]) &&
    st.connection === null && st.idleMs === 300 && before.idleForMs === 120 && st.idleForMs === 0);
  const mark = order.length;
  a.send({ cmd: "__shutdown", id: "s1" });
  ok("[control] __shutdown answers first, then shuts down (release, bridge close, the log line — in that order)",
    order.slice(mark).join("|") === `write ${JSON.stringify({ ok: true, id: "s1", result: { stopped: true } })}|released|bridge closed|log daemon stopped.` &&
    s.stopped && events.join("|") === "released|bridge closed");
  ok("[control] none of them was forwarded", asked.length === 0);
}
{
  const { s } = world(0);
  ok("[control] idle window 0 → __status idleMs null (disabled, not \"0 min\")", s.status().idleMs === null);
}

// ---------------------------------------------------------------- forwarding
console.log("\nserved-session — forwarding to the bridge:");
{
  const { s, client, asked } = world();
  const a = client();
  a.send({ id: "r1", cmd: "exportNode", args: { nodeId: "1:2" }, timeoutMs: 5000, client: "Sample", waitForConnection: 4000 });
  const q = asked[0];
  ok("[forward] a request reaches the bridge at once, with the frame's budget, target and connect window, a signal, and no progress listener unasked",
    q?.cmd === "exportNode" && JSON.stringify(q.args) === JSON.stringify({ nodeId: "1:2" }) && q.o.timeoutMs === 5000 && q.o.target === "Sample" &&
    q.o.waitMs === 4000 && q.o.signal instanceof AbortSignal && q.o.onProgress === undefined && s.activity().inFlight === 1);
  a.send({ cmd: "listPages" });
  ok("[forward] another arrives while the first is in flight: forwarded too (the plugin orders runs, not the daemon)", asked.length === 2 && s.activity().inFlight === 2);
  q?.answer({ pong: true });
  await flush();
  ok("[forward] the reply carries the id, the bridge's result and the client it used", JSON.stringify(last(a.out)) === JSON.stringify({ ok: true, id: "r1", result: { pong: true }, client: ROW }));
  asked[1]?.fail(new Error("Figma plugin not connected."));
  await flush();
  ok("[forward] a bridge failure is the reply's error (no id when the frame had none), and nothing is left in flight",
    JSON.stringify(last(a.out)) === JSON.stringify({ ok: false, error: "Figma plugin not connected." }) && s.activity().inFlight === 0);
  a.send({ cmd: "ping" });
  asked[2]?.answer({ pong: true }, null);
  await flush();
  ok("[forward] a bridge that does not say which client answered adds no `client`", JSON.stringify(last(a.out)) === JSON.stringify({ ok: true, result: { pong: true } }));
}
{
  const { client, asked } = world();
  const a = client();
  a.send({ id: "y1", cmd: "ping", progress: true });
  const q = asked[0];
  q?.o.onProgress?.(TICK);
  q?.o.onProgress?.(TICK);
  q?.answer({ pong: true });
  await flush();
  const b = client();
  b.send({ cmd: "ping", progress: true });
  asked[1]?.o.onProgress?.(TICK);
  ok("[progress] a client that opted in gets each tick as a progress frame with its id, in order, before its reply",
    a.out.length === 3 && JSON.stringify(a.out[0]) === JSON.stringify({ id: "y1", progress: TICK }) && JSON.stringify(a.out[1]) === JSON.stringify({ id: "y1", progress: TICK }) && last(a.out).ok === true);
  ok("[progress] …and a frame without an id gets its ticks without one", JSON.stringify(b.out[0]) === JSON.stringify({ progress: TICK }));
}

// ---------------------------------------------------------------- the idle decision
console.log("\nserved-session — the idle shutdown:");
{
  const { clock, s, logs, events } = world(300);
  clock.advance(299);
  const early = s.stopped;
  clock.advance(1);
  ok("[idle] a quiet session shuts down at its window (checked every min(30 s, window))", !early && s.stopped && events.join("|") === "released|bridge closed");
  ok("[idle] …saying why, and how to turn it off", /^idle for .* — shutting down \(set FIGMA_DAEMON_IDLE_MIN=0 to disable\)\.$/.test(logs[0] ?? "") && logs[1] === "daemon stopped.");
  ok("[idle] …and leaves no timer armed", clock.armed() === 0);
}
{
  // A window over 30 s is checked every 30 s: quiet for the window is noticed at the next beat, not to the millisecond.
  const { clock, s, client } = world(60000);
  const a = client();
  clock.advance(10000);
  a.send({ cmd: "__ping" });
  clock.advance(50000); // t = 60 s: a beat, but only 50 s quiet
  const at60 = s.stopped;
  clock.advance(20000); // t = 80 s: quiet 70 s, but no beat yet
  const at80 = s.stopped;
  clock.advance(10000); // t = 90 s: the next beat
  ok("[idle] a frame resets the clock; a 60 s window is checked on a 30 s beat (still up at 60 s and 80 s, down at the 90 s beat)", !at60 && !at80 && s.stopped);
}
{
  // A request in flight holds the shutdown off however long it runs; the clock starts again when it FINISHES.
  const { clock, s, client, asked } = world(300);
  const a = client();
  a.send({ cmd: "exportFull", args: {} });
  clock.advance(60000);
  const heldOff = !s.stopped && s.activity().inFlight === 1;
  asked[0]?.answer({});
  await flush();
  clock.advance(299);
  const justAfter = s.stopped;
  clock.advance(300);
  ok("[idle] a request in flight holds it off (still up after 60 s), and the window counts from when it finished", heldOff && !justAfter && s.stopped);
}
{
  const { clock, s } = world(0);
  clock.advance(3600000);
  ok("[idle] window 0: never shuts down on its own, and arms nothing", !s.stopped && clock.armed() === 0);
  s.idleOut(500);
  ok("[idle] idleOut(ms) on a session quiet longer than ms shuts it down AT ONCE, not at the first beat", s.stopped);
}
{
  const { clock, s, client } = world(0);
  const a = client();
  clock.advance(100);
  a.send({ cmd: "__ping" });
  s.idleOut(300);
  const atOnce = s.stopped;
  clock.advance(300);
  ok("[idle] idleOut on a recently used session arms the window instead (up at once, down a window later)", !atOnce && s.stopped);
}
{
  const { clock, s } = world(300);
  s.idleOut(0);
  clock.advance(10000);
  ok("[idle] idleOut(0) disarms it", !s.stopped && clock.armed() === 0 && s.status().idleMs === null);
}

// ---------------------------------------------------------------- a client leaving
console.log("\nserved-session — a client that leaves before its reply:");
{
  const { client, asked, events, s } = world();
  const a = client(), b = client();
  a.send({ cmd: "exportFull", args: {} });
  a.send({ cmd: "listPages" });
  b.send({ cmd: "exportDesignSystem", args: {} });
  a.c.leave();
  a.c.leave(); // close, then end, then error: each may come, more than once
  ok("[leave] a client that leaves aborts ITS requests' signals (each once, with why), and no other client's",
    events.join("|") === "abort exportFull: the daemon's client disconnected before the reply|abort listPages: the daemon's client disconnected before the reply" &&
    asked[2]?.o.signal?.aborted === false);
  asked[0]?.fail(new Error("request aborted"));
  asked[1]?.fail(new Error("request aborted"));
  await flush();
  ok("[leave] …the aborted requests still settle and leave the in-flight count (the other is still in flight)", s.activity().inFlight === 1);
}

// ---------------------------------------------------------------- shutdown
console.log("\nserved-session — shutdown:");
{
  const { s, client, asked, events, order } = world(300);
  const a = client();
  a.send({ cmd: "exportFull", args: {} });
  a.send({ cmd: "ping" });
  const mark = order.length;
  s.shutdown();
  ok("[shutdown] in order: the transport lets go, every outstanding request is aborted (\"bridge closed\"), the bridge closes, then the log line",
    order.slice(mark).join("|") === "released|abort exportFull: bridge closed|abort ping: bridge closed|bridge closed|log daemon stopped.");
  const once = order.length;
  s.shutdown();
  ok("[shutdown] idempotent: a second shutdown does nothing", order.length === once && events.filter((e) => e === "bridge closed").length === 1);
  const before = asked.length;
  a.send({ id: "late", cmd: "listPages" });
  const refused = last(a.out);
  a.send({ cmd: "__ping" });
  ok("[shutdown] a frame after it — a command or a control one — is refused, never forwarded to the closed bridge",
    refused.ok === false && refused.id === "late" && /has shut down/.test(String(refused.error)) && /has shut down/.test(String(last(a.out).error)) && asked.length === before);
}

report();
