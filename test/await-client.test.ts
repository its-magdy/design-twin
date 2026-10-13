// server-core's client registry and its one wait for a Figma client (awaitClient): every front-end
// (figma-pull's own bridge, the daemon, the MCP server) waits for a target through it before a request.
// Driven with plain objects in place of sockets — binds no port.
// Run with:  node test/await-client.test.ts
import { getEventListeners } from "node:events";
import { ok, report } from "./assert.ts";

// server-core resolves the bridge token when it loads; a fixed one keeps this suite off the user's token file.
process.env.FIGMA_BRIDGE_TOKEN = "await-client-test-token";
delete process.env.FIGMA_BRIDGE_TOKEN_FILE;
const core = await import("../bridge/src/server-core.ts");

const OPEN = 1, CLOSED = 3; // WebSocket readyState values (ws: WebSocket.OPEN / WebSocket.CLOSED)
interface FakeSock { readyState: number }
type Registry = ReturnType<typeof core.createRegistry<FakeSock>>;
type Entry = ReturnType<Registry["add"]>;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const hello = (file: string | null, fileKey: string | null = null, instanceId: string | null = "i-" + String(file)) =>
  ({ type: "hello" as const, instanceId, file, fileKey, page: null, pluginVersion: "9.9.9" });
const connect = (r: Registry, file?: string, fileKey?: string): Entry => {
  const e = r.add({ readyState: OPEN });
  if (file !== undefined) r.identify(e, hello(file, fileKey ?? null));
  return e;
};
const disconnect = (r: Registry, e: Entry): void => { e.ws.readyState = CLOSED; r.remove(e); };

// Every timer created while a wait runs is tracked: none may keep the process alive (unref'd), and none
// may still be armed once the wait has settled (cleared, or fired). The suite holds the event loop open
// itself (keepAlive below), because an unref'd timer alone would not.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let tracking = false;
const armed = new Set<NodeJS.Timeout>();
const created: NodeJS.Timeout[] = [];
const trackingSetTimeout = (fn: () => void, ms?: number): NodeJS.Timeout => {
  const t: NodeJS.Timeout = realSetTimeout(() => { armed.delete(t); fn(); }, ms);
  if (tracking) { armed.add(t); created.push(t); }
  return t;
};
globalThis.setTimeout = Object.assign(trackingSetTimeout, { __promisify__: realSetTimeout.__promisify__ });
globalThis.clearTimeout = (t?: NodeJS.Timeout | string | number): void => {
  if (t !== undefined && typeof t === "object") armed.delete(t);
  realClearTimeout(t);
};
const keepAlive = setInterval(() => {}, 1000);

/** Runs one wait with timer tracking on; reports how long it took and what it left behind. */
async function timed(r: Registry, p: () => Promise<void>): Promise<{ ms: number; leftListeners: number; leftTimers: number; refd: number; made: number }> {
  armed.clear();
  created.length = 0;
  tracking = true;
  const t0 = Date.now();
  await p();
  const ms = Date.now() - t0;
  tracking = false;
  return { ms, leftListeners: r.waiting(), leftTimers: armed.size, refd: created.filter((t) => t.hasRef()).length, made: created.length };
}
const clean = (o: { leftListeners: number; leftTimers: number; refd: number }): boolean => o.leftListeners === 0 && o.leftTimers === 0 && o.refd === 0;

// ------------------------------------------------------------------ isConnId
console.log("isConnId — the one connection-id test:");
ok("[connId] c1 and c12 are connection ids", core.isConnId("c1") && core.isConnId("c12"));
ok("[connId] a file name, an upper-case C, a suffix, a bare c and the empty string are not",
  !core.isConnId("C1") && !core.isConnId("c1x") && !core.isConnId("c") && !core.isConnId("") && !core.isConnId("App c1"));

// ------------------------------------------------------------------ nothing connected
console.log("\nawaitClient — nothing connected:");
{
  const r = core.createRegistry<FakeSock>();
  const a = await timed(r, () => r.awaitClient(null, 150));
  ok("[none] no target: resolves at its window, not before and not long after", a.ms >= 140 && a.ms < 400);
  ok("[none] …and leaves no listener, no armed timer, and never held the event loop", clean(a));
  const b = await timed(r, () => r.awaitClient("Design System", 150));
  ok("[none] a named target with nothing connected: the connect window, not the name cap on top of it", b.ms >= 140 && b.ms < 400 && clean(b));
  let caught = "";
  try { r.resolveClient(null); } catch (e) { caught = e instanceof Error ? e.message : String(e); }
  ok("[none] the request's resolveClient then says what to do (text unchanged)",
    caught === "Figma plugin not connected. Open the file in Figma and run the plugin.");
  const z = await timed(r, () => r.awaitClient(null, 0));
  const n = await timed(r, () => r.awaitClient("x", Number.NaN));
  ok("[none] a zero or non-numeric window does not wait", z.ms < 20 && n.ms < 20 && clean(z) && clean(n));
}

// ------------------------------------------------------------------ a plugin connects during the wait
console.log("\nawaitClient — a plugin connects and identifies while waiting:");
{
  const r = core.createRegistry<FakeSock>();
  let helloAt = 0;
  realSetTimeout(() => { const e = connect(r); realSetTimeout(() => { helloAt = Date.now(); r.identify(e, hello("App — Base")); }, 60); }, 60);
  const wait = r.awaitClient(null, 5000);
  ok("[connect] one listener while waiting", r.waiting() === 1);
  const a = await timed(r, () => wait);
  const late = Date.now() - helloAt;
  ok("[connect] no target: waits past the bare socket for its hello, and resolves on it (event-driven, not a poll)",
    a.ms >= 100 && a.ms < 1000 && late < 15);
  ok("[connect] …leaving nothing behind", clean(a));
}
{
  // A client that never says hello (a bundle that predates it) is taken once its grace has passed.
  const r = core.createRegistry<FakeSock>();
  const e = connect(r);
  e.connectedAt = Date.now() - (core.IDENTIFY_GRACE_MS - 120); // connected just under the grace ago
  const a = await timed(r, () => r.awaitClient(null, 10000));
  ok("[grace] an unidentified client holds an unaddressed wait only until its identification grace", a.ms >= 100 && a.ms < 600 && clean(a));
  const b = await timed(r, () => r.awaitClient(null, 10000));
  ok("[grace] …after which it is taken at once", b.ms < 20 && clean(b));
  const c = await timed(r, () => r.awaitClient("App", 150));
  ok("[grace] a NAMED target is never satisfied by an unidentified client (it has no name to match)", c.ms >= 140 && clean(c));
}

// ------------------------------------------------------------------ named target
console.log("\nawaitClient — a named target:");
{
  const r = core.createRegistry<FakeSock>();
  connect(r, "App — Base", "KEYBASE");
  const now = await timed(r, () => r.awaitClient("app", 5000));
  ok("[named] already connected (case-insensitive substring): resolves at once", now.ms < 20 && clean(now));
  const byKey = await timed(r, () => r.awaitClient("KEYBASE", 5000));
  ok("[named] by fileKey too", byKey.ms < 20 && clean(byKey));

  let helloAt = 0;
  realSetTimeout(() => { const e = connect(r); realSetTimeout(() => { helloAt = Date.now(); r.identify(e, hello("Acme Library")); }, 40); }, 80);
  const late = await timed(r, () => r.awaitClient("Library", 5000));
  ok("[named] arrives late (its window redials after the other file): resolves on its hello, not at the window",
    late.ms >= 110 && late.ms < 1000 && Date.now() - helloAt < 15 && clean(late));

  const never = await timed(r, () => r.awaitClient("Nobody Has This", 60000, undefined, 200));
  ok("[named] never arrives while another file is connected: resolves at the name cap, not the connect window", never.ms >= 190 && never.ms < 500 && clean(never));
  const shorter = await timed(r, () => r.awaitClient("Nobody Has This", 150, undefined, 5000));
  ok("[named] …or at the connect window when that is the shorter", shorter.ms >= 140 && shorter.ms < 400 && clean(shorter));
  let caught = "";
  try { r.resolveClient("Nobody Has This"); } catch (e) { caught = e instanceof Error ? e.message : String(e); }
  ok("[named] the request's resolveClient then lists what IS connected (text unchanged)",
    caught.startsWith("no connected Figma file matches 'Nobody Has This'. Connected:\n  c1  \"App — Base\"  fileKey KEYBASE"));

  connect(r, "Untitled A");
  connect(r, "Untitled B");
  const amb = await timed(r, () => r.awaitClient("Untitled", 5000));
  ok("[named] an ambiguous name resolves the wait at once — the ambiguity is resolveClient's to report", amb.ms < 20 && clean(amb));
}
{
  // The name cap counts from the first live client, not from the start: a plugin that takes most of the
  // connect window to land still gives the name its full cap after it (the CLI's cold reconnect).
  const r = core.createRegistry<FakeSock>();
  realSetTimeout(() => connect(r, "Other File"), 250);
  const a = await timed(r, () => r.awaitClient("Target File", 300, undefined, 300));
  ok("[named] the name cap starts when the first plugin connects (~250 + 300 ms), not at the call (300 ms)", a.ms >= 500 && a.ms < 900 && clean(a));
}

// ------------------------------------------------------------------ connId target
console.log("\nawaitClient — a connection id:");
{
  const r = core.createRegistry<FakeSock>();
  connect(r, "Late File");
  const a = await timed(r, () => r.awaitClient("c9", 5000));
  ok("[connId] an absent connId does not wait for that id — an identified client is enough", a.ms < 20 && clean(a));
  let caught = "";
  try { r.resolveClient("c9"); } catch (e) { caught = e instanceof Error ? e.message : String(e); }
  ok("[connId] …and the request then fails fast, listing the connected file", /^no connected Figma file matches 'c9'/.test(caught) && /Late File/.test(caught));
  const r2 = core.createRegistry<FakeSock>();
  realSetTimeout(() => connect(r2, "Some File"), 80);
  const b = await timed(r2, () => r2.awaitClient("c1", 5000));
  ok("[connId] with nothing connected it waits for a first identified client (the connect window)", b.ms >= 70 && b.ms < 600 && clean(b));
}

// ------------------------------------------------------------------ disconnects, aborts, close
console.log("\nawaitClient — a client leaves, the caller gives up, the bridge closes:");
{
  const r = core.createRegistry<FakeSock>();
  const other = connect(r, "Other File");
  realSetTimeout(() => disconnect(r, other), 60);
  realSetTimeout(() => connect(r, "Target File"), 160);
  const a = await timed(r, () => r.awaitClient("Target", 5000, undefined, 2000));
  ok("[leave] a client leaving does not end a named wait; the target arriving afterwards does", a.ms >= 150 && a.ms < 800 && clean(a));
  const r2 = core.createRegistry<FakeSock>();
  const only = connect(r2, "Other File");
  realSetTimeout(() => disconnect(r2, only), 50);
  const b = await timed(r2, () => r2.awaitClient("Target", 5000, undefined, 250));
  ok("[leave] …and with nothing arriving it still ends at the name cap (from when the first plugin was live)", b.ms >= 240 && b.ms < 600 && clean(b));
  const r3 = core.createRegistry<FakeSock>();
  const gone = connect(r3);
  realSetTimeout(() => disconnect(r3, gone), 40);
  realSetTimeout(() => connect(r3, "Back Again"), 120);
  const c = await timed(r3, () => r3.awaitClient(null, 5000));
  ok("[leave] no target: an unidentified client that leaves is waited past, to the one that comes back", c.ms >= 110 && c.ms < 800 && clean(c));
}
{
  const r = core.createRegistry<FakeSock>();
  connect(r, "Other File");
  const ac = new AbortController();
  realSetTimeout(() => ac.abort(new Error("the caller left")), 80);
  const a = await timed(r, () => r.awaitClient("Target", 5000, ac.signal));
  ok("[abort] the caller's signal ends the wait at once", a.ms >= 70 && a.ms < 400 && clean(a));
  ok("[abort] …and its abort listener is gone", getEventListeners(ac.signal, "abort").length === 0);
  const ac2 = new AbortController();
  const b = await timed(r, () => r.awaitClient("Other", 5000, ac2.signal));
  ok("[abort] a wait that ends on a match removes its abort listener too", b.ms < 20 && clean(b) && getEventListeners(ac2.signal, "abort").length === 0);
  const ac3 = new AbortController();
  const c = await timed(r, () => r.awaitClient("Target", 150, ac3.signal));
  ok("[abort] …and so does one that ends at its window", c.ms >= 140 && clean(c) && getEventListeners(ac3.signal, "abort").length === 0);
  const pre = new AbortController();
  pre.abort();
  const d = await timed(r, () => r.awaitClient("Target", 5000, pre.signal));
  ok("[abort] an already-aborted signal does not wait", d.ms < 20 && clean(d) && getEventListeners(pre.signal, "abort").length === 0);
}
{
  const r = core.createRegistry<FakeSock>();
  realSetTimeout(() => r.clear(), 60);
  const a = await timed(r, () => r.awaitClient("Target", 5000));
  ok("[close] clearing the registry (the bridge closing) ends every wait at once", a.ms >= 50 && a.ms < 400 && clean(a));
  const b = await timed(r, () => r.awaitClient(null, 5000));
  ok("[close] …and a wait started after it does not wait", b.ms < 20 && clean(b));
}

// ------------------------------------------------------------------ many waits, long windows
console.log("\nawaitClient — many waits at once, and a window past setTimeout's limit:");
{
  const r = core.createRegistry<FakeSock>();
  const warnings: string[] = [];
  const onWarning = (w: Error): void => { warnings.push(w.name); };
  process.on("warning", onWarning);
  const waits = Array.from({ length: 25 }, (_, i) => r.awaitClient("Target", 5000, undefined, 4000 + i));
  ok("[many] 25 concurrent waits each listen once", r.waiting() === 25);
  realSetTimeout(() => connect(r, "Target File"), 50);
  const a = await timed(r, () => Promise.all(waits).then(() => {}));
  await sleep(10); // a MaxListenersExceededWarning is emitted on the next tick
  process.off("warning", onWarning);
  ok("[many] …all resolve on the one hello, leave no listener behind, and raise no MaxListenersExceededWarning",
    a.ms < 400 && r.waiting() === 0 && !warnings.includes("MaxListenersExceededWarning"));
}
{
  // Above 2147483647 ms setTimeout fires after 1 ms; unclamped, a long wait would re-arm every millisecond.
  const r = core.createRegistry<FakeSock>();
  const ac = new AbortController();
  realSetTimeout(() => ac.abort(), 100);
  const a = await timed(r, () => r.awaitClient(null, 3e9, ac.signal));
  ok("[long] a window longer than setTimeout's limit does not spin (one timer, not one per millisecond)", a.made <= 2 && clean(a));
}

clearInterval(keepAlive);
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
report();
