// server-core's client registry and its one wait for a Figma client (awaitClient): every front-end
// (figma-pull's own bridge, the daemon, the MCP server) waits for a target through it before a request.
// Driven with plain objects in place of sockets — binds no port.
// Run with:  bun test/await-client.test.ts
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
// A registry with no settle window unless a test is about it (the sections below that are pass their own).
const reg = (settleMs = 0): Registry => core.createRegistry<FakeSock>({ settleMs });

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
// Bun's global clearTimeout also takes its own Timer type; this suite only ever arms NodeJS.Timeout ones
// (trackingSetTimeout above), so anything else is passed straight through untracked.
globalThis.clearTimeout = ((t?: NodeJS.Timeout | string | number): void => {
  if (t !== undefined && typeof t === "object") armed.delete(t);
  realClearTimeout(t);
}) as typeof realClearTimeout;
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
  const r = reg();
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
  const r = reg();
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
  const r = reg();
  const e = connect(r);
  e.connectedMono = performance.now() - (core.IDENTIFY_GRACE_MS - 120); // connected just under the grace ago (the monotonic clock the grace runs on)
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
  const r = reg();
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
  const r = reg();
  realSetTimeout(() => connect(r, "Other File"), 250);
  const a = await timed(r, () => r.awaitClient("Target File", 300, undefined, 300));
  ok("[named] the name cap starts when the first plugin connects (~250 + 300 ms), not at the call (300 ms)", a.ms >= 500 && a.ms < 900 && clean(a));
}

// ------------------------------------------------------------------ connId target
console.log("\nawaitClient — a connection id:");
{
  const r = reg();
  connect(r, "Late File");
  const a = await timed(r, () => r.awaitClient("c9", 5000));
  ok("[connId] an absent connId does not wait for that id — an identified client is enough", a.ms < 20 && clean(a));
  let caught = "";
  try { r.resolveClient("c9"); } catch (e) { caught = e instanceof Error ? e.message : String(e); }
  ok("[connId] …and the request then fails fast, listing the connected file", /^no connected Figma file matches 'c9'/.test(caught) && /Late File/.test(caught));
  const r2 = reg();
  realSetTimeout(() => connect(r2, "Some File"), 80);
  const b = await timed(r2, () => r2.awaitClient("c1", 5000));
  ok("[connId] with nothing connected it waits for a first identified client (the connect window)", b.ms >= 70 && b.ms < 600 && clean(b));
}

// ------------------------------------------------------------------ disconnects, aborts, close
console.log("\nawaitClient — a client leaves, the caller gives up, the bridge closes:");
{
  const r = reg();
  const other = connect(r, "Other File");
  realSetTimeout(() => disconnect(r, other), 60);
  realSetTimeout(() => connect(r, "Target File"), 160);
  const a = await timed(r, () => r.awaitClient("Target", 5000, undefined, 2000));
  ok("[leave] a client leaving does not end a named wait; the target arriving afterwards does", a.ms >= 150 && a.ms < 800 && clean(a));
  const r2 = reg();
  const only = connect(r2, "Other File");
  realSetTimeout(() => disconnect(r2, only), 50);
  const b = await timed(r2, () => r2.awaitClient("Target", 5000, undefined, 250));
  ok("[leave] …and with nothing arriving it still ends at the name cap (from when the first plugin was live)", b.ms >= 240 && b.ms < 600 && clean(b));
  const r3 = reg();
  const gone = connect(r3);
  realSetTimeout(() => disconnect(r3, gone), 40);
  realSetTimeout(() => connect(r3, "Back Again"), 120);
  const c = await timed(r3, () => r3.awaitClient(null, 5000));
  ok("[leave] no target: an unidentified client that leaves is waited past, to the one that comes back", c.ms >= 110 && c.ms < 800 && clean(c));
}
{
  const r = reg();
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
  const r = reg();
  realSetTimeout(() => r.clear(), 60);
  const a = await timed(r, () => r.awaitClient("Target", 5000));
  ok("[close] clearing the registry (the bridge closing) ends every wait at once", a.ms >= 50 && a.ms < 400 && clean(a));
  const b = await timed(r, () => r.awaitClient(null, 5000));
  ok("[close] …and a wait started after it does not wait", b.ms < 20 && clean(b));
}

// ------------------------------------------------------------------ the settle window
// A fresh bridge's windows redial on their own clocks: whichever file lands first must not be taken for a
// command that does not name one file exactly while a second is a redial behind (a silent wrong-file export).
console.log("\nawaitClient — a fresh bridge settles before it routes a vague target:");
const SETTLE = 600; // stands in for SETTLE_MS (3.5 s): the rule, not the constant, is under test here
const errOf = (fn: () => unknown): string => { try { fn(); return "routed"; } catch (e) { return e instanceof Error ? e.message.split("\n")[0] ?? "" : String(e); } };
const errOfFull = (fn: () => unknown): string => { try { fn(); return "routed"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
{
  const r = reg(SETTLE);
  realSetTimeout(() => connect(r, "File A"), 50);
  realSetTimeout(() => connect(r, "File B"), 250);
  const a = await timed(r, () => r.awaitClient(null, 5000));
  ok("[settle] no target, a second file a moment behind: the wait lasts until it lands (not the first hello)", a.ms >= 240 && a.ms < SETTLE && clean(a));
  ok("[settle] …so the request is refused as ambiguous instead of going to the first file", errOf(() => r.resolveClient(null)) === "2 Figma files are connected to the bridge — say which one to use.");
}
for (const [first, second] of [["App Base", "App Docs"], ["App Docs", "App Base"]]) {
  const r = reg(SETTLE);
  realSetTimeout(() => connect(r, first), 50);
  realSetTimeout(() => connect(r, second), 250);
  const a = await timed(r, () => r.awaitClient("App", 5000));
  ok(`[settle] a partial name matching both (${first} first): the wait lasts until the second lands`, a.ms >= 240 && a.ms < SETTLE && clean(a));
  ok(`[settle] …and the request is refused as ambiguous (${first} first)`, errOf(() => r.resolveClient("App")) === "'App' matches 2 connected files — be more specific, or use the connId.");
}
{
  const r = reg(SETTLE);
  realSetTimeout(() => connect(r, "App Base"), 50);
  const a = await timed(r, () => r.awaitClient("Base", 5000));
  ok("[settle] a partial name with one match on a fresh bridge resolves at the settle, not on the hello", a.ms >= SETTLE + 30 && a.ms < SETTLE + 400 && clean(a));
  const r2 = reg(SETTLE);
  realSetTimeout(() => connect(r2, "Only File"), 50);
  const b = await timed(r2, () => r2.awaitClient(null, 5000));
  ok("[settle] no target with one file: the same (the one-shot cost)", b.ms >= SETTLE + 30 && b.ms < SETTLE + 400 && clean(b));
}
{
  const r = reg(SETTLE);
  realSetTimeout(() => connect(r, "App Base", "KEYBASE"), 50);
  const byKey = await timed(r, () => r.awaitClient("KEYBASE", 5000));
  const byId = await timed(r, () => r.awaitClient("c1", 5000));
  ok("[settle] a fileKey or connId is routed at once on a fresh bridge", byKey.ms >= 40 && byKey.ms < 150 && byId.ms < 20 && clean(byKey) && clean(byId));
  ok("[settle] settleLeft says how much of the window is left", r.settleLeft() > SETTLE - 200 && r.settleLeft() <= SETTLE);
  const byName = await timed(r, () => r.awaitClient("App Base", 5000));
  ok("[settle] …but a WHOLE file name is not exact (names repeat): it sits out the settle like a partial one", byName.ms >= SETTLE - 150 && byName.ms < SETTLE + 400 && clean(byName));
}
for (const [label, first, second] of [["a whole name that two files share", "Untitled", "Untitled"], ["a whole name that is the start of another", "App", "App (Copy)"]] as const) {
  const r = reg(SETTLE);
  realSetTimeout(() => connect(r, first), 50);
  realSetTimeout(() => connect(r, second), 250);
  const a = await timed(r, () => r.awaitClient(first, 5000));
  ok(`[settle] ${label}: the wait lasts until the second file lands`, a.ms >= 240 && a.ms < SETTLE && clean(a));
  ok(`[settle] …and the request is refused as ambiguous (${label})`, errOf(() => r.resolveClient(first)) === `'${first}' matches 2 connected files — be more specific, or use the connId.`);
}
{
  const r = reg(SETTLE);
  ok("[settle] nothing connected: nothing to settle", r.settleLeft() === 0);
  connect(r, "Long Lived");
  await sleep(SETTLE + 20);
  connect(r, "Joined Later");
  const a = await timed(r, () => r.awaitClient("Lived", 5000));
  const b = await timed(r, () => r.awaitClient(null, 5000));
  ok("[settle] a bridge connected longer than the window (a daemon) pays nothing — a client joining does not restart it",
    a.ms < 20 && b.ms < 20 && r.settleLeft() === 0 && clean(a) && clean(b));
  for (const e of [...r.clients.values()]) disconnect(r, e);
  connect(r, "Back After Restart");
  ok("[settle] …but once every plugin has gone, the next one to connect starts a new window", r.settleLeft() > SETTLE - 100);
  const c = await timed(r, () => r.awaitClient(null, 5000));
  ok("[settle] …which the next unaddressed wait sits out", c.ms >= SETTLE - 100 && clean(c));
}
{
  // A connect window that ends inside the settle is stretched to it: routing at the window would take
  // the first file to land (the daemon asks once, the CLI's --timeout can be short).
  const r = reg(SETTLE);
  connect(r, "Only File");
  const a = await timed(r, () => r.awaitClient(null, 150));
  ok("[settle] a window shorter than the settle is stretched to the settle", a.ms >= SETTLE - 100 && a.ms < SETTLE + 400 && clean(a));
  const r2 = reg(SETTLE);
  realSetTimeout(() => connect(r2, "File A"), 100);
  realSetTimeout(() => connect(r2, "File B"), 450);
  const b = await timed(r2, () => r2.awaitClient(null, 300));
  ok("[settle] no target, a 300 ms window, the second file landing after it: the wait still sees it", b.ms >= 440 && b.ms < SETTLE + 400 && clean(b));
  ok("[settle] …so the request is refused as ambiguous, not sent to the first file", errOf(() => r2.resolveClient(null)) === "2 Figma files are connected to the bridge — say which one to use.");
  const r3 = reg(SETTLE);
  realSetTimeout(() => connect(r3, "Design App"), 50);
  realSetTimeout(() => connect(r3, "Design System"), 400);
  const c = await timed(r3, () => r3.awaitClient("Design", 200));
  ok("[settle] a partial name with a short window: the same", c.ms >= 390 && clean(c) && errOf(() => r3.resolveClient("Design")) === "'Design' matches 2 connected files — be more specific, or use the connId.");
  const r4 = reg(SETTLE);
  connect(r4, "Only File");
  const d = await timed(r4, () => r4.awaitClient("Nobody Has This", 150));
  ok("[settle] a name that matches nothing is stretched too (a later file may be the one), then fails with the list", d.ms >= SETTLE - 100 && d.ms < SETTLE + 400 && clean(d));
  const e = await timed(r4, () => r4.awaitClient("c9", 150));
  ok("[settle] a connId is not stretched — it names one socket", e.ms < 20 && clean(e));
  const z = await timed(r4, () => r4.awaitClient(null, 0));
  ok("[settle] no window at all does not wait (the caller asked for none)", z.ms < 20 && clean(z));
}

// A plugin that leaves while others stay is probably redialling: the remaining clients are not the whole
// picture until the settle has passed again.
console.log("\nawaitClient — a window leaves and comes back:");
{
  const r = reg(SETTLE);
  connect(r, "File A");
  const leaver = connect(r, "File B");
  await sleep(SETTLE + 20);
  ok("[leave-settle] a settled bridge pays nothing", r.settleLeft() === 0);
  disconnect(r, leaver);
  ok("[leave-settle] a client leaving while another stays restarts the settle", r.settleLeft() > SETTLE - 100);
  realSetTimeout(() => connect(r, "File B"), 150);
  const a = await timed(r, () => r.awaitClient(null, 5000));
  ok("[leave-settle] no target: the wait covers the redial gap, so the returning file is seen", a.ms >= 140 && a.ms < SETTLE + 300 && clean(a));
  ok("[leave-settle] …and the request is refused as ambiguous, not sent to the file that stayed", errOf(() => r.resolveClient(null)) === "2 Figma files are connected to the bridge — say which one to use.");
  await sleep(SETTLE + 20);
  r.remove(leaver); // already gone: a late close of a dropped socket restarts nothing
  ok("[leave-settle] …and a late remove of an entry that is already gone leaves the settle alone", r.settleLeft() === 0);
  const r2 = reg(SETTLE);
  const only = connect(r2, "Only File");
  disconnect(r2, only);
  ok("[leave-settle] the last client leaving starts no window (nothing is connected to hold)", r2.settleLeft() === 0);
}

// ------------------------------------------------------------------ a second window still identifying
console.log("\nawaitClient — a partial name while another window has not said hello:");
{
  // A settled bridge: one file identified, another socket open whose hello has not arrived. The name may
  // belong to that second window too, so the single match is not routed yet.
  const r = reg();
  connect(r, "Design App", "KEYDESIGN");
  const b = connect(r);
  realSetTimeout(() => r.identify(b, hello("Design System")), 150);
  const a = await timed(r, () => r.awaitClient("Design", 5000));
  ok("[identifying] a single partial match waits for the other open socket's hello", a.ms >= 140 && a.ms < 800 && clean(a));
  ok("[identifying] …and the request is refused as ambiguous", errOf(() => r.resolveClient("Design")) === "'Design' matches 2 connected files — be more specific, or use the connId.");
  const r2 = reg();
  connect(r2, "Design App", "KEYDESIGN");
  const quiet = connect(r2);
  quiet.connectedMono = performance.now() - (core.IDENTIFY_GRACE_MS - 150);
  const g = await timed(r2, () => r2.awaitClient("Design", 5000));
  ok("[identifying] a socket that never says hello holds it only for its identification grace", g.ms >= 100 && g.ms < 700 && g.made <= 3 && clean(g));
  const k = await timed(r2, () => r2.awaitClient("KEYDESIGN", 5000));
  ok("[identifying] …and a fileKey, which names one file, never waits for it", k.ms < 20 && clean(k));
  const r3 = reg();
  connect(r3, "Design App");
  connect(r3);
  const none = await timed(r3, () => r3.awaitClient("Nobody Has This", 200));
  ok("[identifying] a name with no match ends at the window", none.ms >= 190 && none.ms < 500 && clean(none));
}

// ------------------------------------------------------------------ listings name a window that just opened
// --list-clients and every refusal list what is connected; a socket that opened a moment ago is a hello
// away from its file name, so the wait holds for it (bounded by its identification grace).
console.log("\nawaitClient — a listing or refusal waits for a just-opened window's hello:");
{
  const names = (r: Registry): string => r.live().map((e) => r.describe(e).file ?? "(unidentified)").join(", ");
  const r = reg();
  connect(r, "File A");
  const b = connect(r);
  realSetTimeout(() => r.identify(b, hello("File B")), 50);
  const a = await timed(r, () => r.awaitClient(null, 5000));
  ok("[listing] no target, two files, the second's hello 50 ms away: the wait ends on that hello", a.ms >= 40 && a.ms < 400 && clean(a));
  ok("[listing] …so the listing names both files", names(r) === "File A, File B");
  ok("[listing] …and so does the ambiguity refusal", /"File B"/.test(errOfFull(() => r.resolveClient(null))) && !/unidentified/.test(errOfFull(() => r.resolveClient(null))));

  const r2 = reg();
  connect(r2, "File A");
  const quiet = connect(r2);
  quiet.connectedMono = performance.now() - (core.IDENTIFY_GRACE_MS - 150); // never says hello; its grace ends in 150 ms
  const g = await timed(r2, () => r2.awaitClient(null, 60000));
  ok("[listing] a socket that never says hello holds the listing only until its grace (bounded, not the window)", g.ms >= 100 && g.ms < 700 && clean(g));
  ok("[listing] …and is then listed as unidentified", names(r2) === "File A, (unidentified)");

  const r3 = reg();
  connect(r3, "File A");
  const c = connect(r3);
  realSetTimeout(() => r3.identify(c, hello("File C")), 50);
  const id = await timed(r3, () => r3.awaitClient("c9", 5000));
  ok("[listing] an absent connId waits for the hello too, so its 'no match' list names every file",
    id.ms >= 40 && id.ms < 400 && /"File C"/.test(errOfFull(() => r3.resolveClient("c9"))) && clean(id));

  const r4 = reg();
  connect(r4, "Untitled A");
  connect(r4, "Untitled B");
  const d = connect(r4);
  realSetTimeout(() => r4.identify(d, hello("Other")), 50);
  const amb = await timed(r4, () => r4.awaitClient("Untitled", 5000));
  ok("[listing] an ambiguous name waits for the hello too, so the refusal lists it by name",
    amb.ms >= 40 && amb.ms < 400 && names(r4) === "Untitled A, Untitled B, Other" && clean(amb));

  const r5 = reg();
  connect(r5, "File A");
  connect(r5); // c2, no hello yet
  const live = await timed(r5, () => r5.awaitClient("c2", 5000));
  ok("[listing] a live connId still routes at once, hello or not", live.ms < 20 && clean(live));
}

// ------------------------------------------------------------------ a socket flapping without a hello
// Every leave restarts the settle and every new socket brings a fresh grace: a socket that opens and closes
// without a hello faster than the settle must not hold a wait past the cap (window or settle, plus one grace,
// from the moment a client went live).
console.log("\nawaitClient — a silent socket flapping faster than the settle is cut off at the cap:");
{
  const settle = 300;
  const r = reg(settle);
  connect(r, "File A");
  await sleep(settle + 20); // settled, File A identified
  let flapping = true;
  const flap = async (): Promise<void> => {
    while (flapping) {
      const f = connect(r);
      await sleep(100);
      disconnect(r, f);
      await sleep(150);
    }
  };
  const flapper = flap();
  await sleep(20);
  // The cap: max(min(window, name cap), settle) + IDENTIFY_GRACE_MS from when File A was already live (the call).
  const capMs = Math.max(200, settle) + core.IDENTIFY_GRACE_MS;
  const t0 = Date.now();
  // a wait the cap does not end would hold the suite for good: past capMs + 3 s it reads as Infinity and fails
  const at = (p: Promise<void>): Promise<number> =>
    Promise.race([p.then(() => Date.now() - t0), sleep(capMs + 3000).then(() => Number.POSITIVE_INFINITY)]);
  const [noTarget, byName, listing] = await Promise.all([
    at(r.awaitClient(null, 200)),
    at(r.awaitClient("File", 200)),
    at(r.awaitClient(null, 60000, undefined, 200)), // --list-clients: a long connect window, the name cap bounds it
  ]);
  flapping = false;
  await flapper;
  ok(`[flap] no target: ends at the cap (~${capMs} ms), not held by the restarted settle (${noTarget} ms)`, noTarget >= capMs - 100 && noTarget < capMs + 600);
  ok(`[flap] a file name: the same (${byName} ms)`, byName >= capMs - 100 && byName < capMs + 600);
  ok(`[flap] a listing with a long window: bounded by the cap too (${listing} ms)`, listing >= capMs - 100 && listing < capMs + 600);
  ok("[flap] …and no wait is left listening", r.waiting() === 0);
  ok("[flap] the request then routes File A (one identified file, the flapper gone)", errOf(() => r.resolveClient("File")) === "routed");
}

// ------------------------------------------------------------------ a connId on a settling bridge
console.log("\nawaitClient — a connId is ready as soon as that connection is live:");
{
  const r = reg(3500);
  connect(r); // c1, not identified, and the settle has 3.5 s to run
  const a = await timed(r, () => r.awaitClient("c1", r.settleLeft()));
  ok("[connId-live] a live, unidentified connId does not wait for any hello, a grace or the settle", a.ms < 20 && clean(a));
  const r2 = reg(3500);
  connect(r2);
  connect(r2, "Other File");
  const b = await timed(r2, () => r2.awaitClient("c1", 5000));
  ok("[connId-live] …nor for another client's", b.ms < 20 && clean(b));
}

// ------------------------------------------------------------------ odd windows
console.log("\nawaitClient — Infinity and non-numeric bounds:");
{
  const r = reg();
  const ac = new AbortController();
  realSetTimeout(() => ac.abort(), 200);
  const a = await timed(r, () => r.awaitClient(null, Number.POSITIVE_INFINITY, ac.signal));
  ok("[odd] an Infinity window waits (until the abort here), with one clamped timer, not one per millisecond", a.ms >= 190 && a.made <= 2 && clean(a));
  const r2 = reg();
  realSetTimeout(() => connect(r2, "Late"), 100);
  const b = await timed(r2, () => r2.awaitClient(null, Number.POSITIVE_INFINITY));
  ok("[odd] …and ends on the client it waited for", b.ms >= 90 && b.ms < 600 && clean(b));
  connect(r2, "Other");
  const c = await timed(r2, () => r2.awaitClient("Missing", 300, undefined, Number.NaN));
  ok("[odd] a NaN name cap falls back to NAMED_CLIENT_WAIT_MS (here the 300 ms window is shorter) without spinning", c.ms >= 290 && c.ms < 700 && c.made <= 2 && clean(c));
}
{
  // Deadlines run on the monotonic clock: a wall-clock step (NTP, a resumed laptop) neither ends a wait
  // early nor stretches it.
  const r = reg();
  const realNow = Date.now;
  const t0 = performance.now();
  realSetTimeout(() => { Date.now = (): number => realNow() + 3600_000; }, 50);
  try {
    await r.awaitClient(null, 300);
  } finally { Date.now = realNow; }
  const ms = performance.now() - t0;
  ok("[mono] a wall clock that jumps an hour forward mid-wait does not cut a 300 ms wait short", ms >= 290 && ms < 700);
  const r2 = reg();
  Date.now = (): number => realNow() - 3600_000;
  const t1 = performance.now();
  try {
    await r2.awaitClient(null, 200);
  } finally { Date.now = realNow; }
  ok("[mono] …nor does one that jumps back stretch a 200 ms wait", performance.now() - t1 < 600);
}

// ------------------------------------------------------------------ many waits, long windows
console.log("\nawaitClient — many waits at once, and a window past setTimeout's limit:");
{
  const r = reg();
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
  // The bound is a tripwire, not a ceiling: far more concurrent waits than any caller makes still warns.
  const leaky: string[] = [];
  const onLeak = (w: Error): void => { leaky.push(w.name); };
  process.on("warning", onLeak);
  const ac = new AbortController();
  const many = Array.from({ length: 70 }, () => r.awaitClient("Nobody", 5000, ac.signal));
  await sleep(10);
  ac.abort();
  await Promise.all(many);
  await sleep(10);
  process.off("warning", onLeak);
  ok("[many] 70 concurrent waits do trip the MaxListenersExceededWarning (the leak tripwire stays armed)", leaky.includes("MaxListenersExceededWarning") && r.waiting() === 0);
}
{
  // Above 2147483647 ms setTimeout fires after 1 ms; unclamped, a long wait would re-arm every millisecond.
  const r = reg();
  const ac = new AbortController();
  realSetTimeout(() => ac.abort(), 100);
  const a = await timed(r, () => r.awaitClient(null, 3e9, ac.signal));
  ok("[long] a window longer than setTimeout's limit does not spin (one timer, not one per millisecond)", a.made <= 2 && clean(a));
}

// ------------------------------------------------------------------ the guard on a daemon-routed request
console.log("\ndaemonGuardMs — the client-side guard outlasts every wait the daemon may spend:");
{
  const { daemonGuardMs, NAMED_CLIENT_WAIT_MS, SETTLE_MS } = await import("../bridge/src/timeouts.ts");
  // The most the daemon's bridge can spend before sending: the connect window, then the name cap after
  // the first plugin, and the settle (inside those windows, or on its own with no window at all).
  const worst = (w: number): number => w + Math.min(w, NAMED_CLIENT_WAIT_MS) + SETTLE_MS;
  ok("[guard] the MCP's named client (a 15 s window): more than the command timeout plus the worst wait, with margin",
    daemonGuardMs(120000, NAMED_CLIENT_WAIT_MS) - 120000 >= worst(NAMED_CLIENT_WAIT_MS) + 20000);
  const { MAX_TIMER_MS } = await import("../bridge/src/timeouts.ts");
  ok("[guard] never more than one setTimeout holds (a --timeout at its ceiling would otherwise fire the guard at once)",
    daemonGuardMs(MAX_TIMER_MS, MAX_TIMER_MS) === MAX_TIMER_MS && daemonGuardMs(2147483000, 2147483000) === MAX_TIMER_MS);
  ok("[guard] the CLI's 90 s window, and no window at all: the same", daemonGuardMs(300000, 90000) - 300000 >= worst(90000) + 20000 && daemonGuardMs(120000) - 120000 >= worst(0) + 20000);
  // A request may wait in the plugin's queue for up to one budget (server-core's timer armed at send) and then run for
  // up to one more (re-armed on its `start`, which a request without progress never relays to the guard): the guard
  // outlasts both, plus the worst connect wait, with margin.
  ok("[guard] a full queue wait plus a full run, plus the worst connect wait, with margin",
    daemonGuardMs(300000) >= 2 * 300000 + worst(0) + 20000 && daemonGuardMs(120000, NAMED_CLIENT_WAIT_MS) >= 2 * 120000 + worst(NAMED_CLIENT_WAIT_MS) + 20000);
  const { PLUGIN_REDIAL_MS } = await import("../bridge/src/timeouts.ts");
  const { ALLOWED_PORTS } = await import("../bridge/src/ports.ts");
  ok("[settle-ms] the settle outlasts one walk of every allowed port at the plugin's redial (3.5 s at 1 s per port)",
    SETTLE_MS > ALLOWED_PORTS.length * PLUGIN_REDIAL_MS && SETTLE_MS === 3500);
}

// ------------------------------------------------------------------ the abort text
console.log("\nabortReason — what a caller that gave up is told:");
{
  const { abortReason } = await import("../bridge/src/abort-reason.ts");
  const own = new Error("the caller left");
  const a = new AbortController();
  a.abort(own);
  ok("[abort-text] an Error of the caller's own is passed through", abortReason(a.signal, "fallback") === own);
  const bare = new AbortController();
  bare.abort();
  ok("[abort-text] a bare abort() (a DOMException AbortError) gets the fixed text", abortReason(bare.signal, "request aborted before it was sent").message === "request aborted before it was sent");
  const str = new AbortController();
  str.abort("because");
  ok("[abort-text] a non-Error reason gets the fixed text too", abortReason(str.signal, "fixed").message === "fixed");
}

clearInterval(keepAlive);
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
report();
