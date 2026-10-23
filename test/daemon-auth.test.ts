// The daemon socket's mutual handshake (bridge/src/daemon-auth.ts), with no socket at all: the two sides'
// handlers are wired to each other in memory, so every check here runs the same on every OS. The daemon
// driving it over a real socket (and, on Windows, a real pipe) is daemon-sock.test.ts's.
import { AUTH_MAX_BYTES, AUTH_PROTO, clientHandshake, ipcKey, macEqual, pipeName, proof, serverHandshake } from "../bridge/src/daemon-auth.ts";
import type { IpcAuth } from "../bridge/src/daemon-auth.ts";
import { check, report } from "./assert.ts";

const T = "a".repeat(48);
const OTHER = "b".repeat(48);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const authFor = (token: string, name = pipeName(T, 8787)): IpcAuth => ({ key: ipcKey(token), name });

// ---- known answers: the derivation is a wire format two builds must agree on, so it is pinned, not just
// round-tripped. ipcKey checked against `openssl dgst -sha256 -hmac <token>` over "dtwin-daemon-ipc/v1".
check("ipcKey: HMAC-SHA256(token, \"dtwin-daemon-ipc/v1\") — the known answer",
  ipcKey(T).toString("hex") === "03cddb4c31f7d15a5bad22f2ebc41ce4bd5571419e21f42e29915ca8636bee04");
check("pipeName: \\\\.\\pipe\\designtwin-<port>-<32 hex> — the known answer",
  pipeName(T, 8787) === "\\\\.\\pipe\\designtwin-8787-a43521dcb7a6b9d6e355a76f572a35d4");
check("…a different port or token is a different name", pipeName(T, 8788) !== pipeName(T, 8787) && pipeName(OTHER, 8787) !== pipeName(T, 8787));
check("…and the name never carries the token", !pipeName(T, 8787).includes(T) && !pipeName(T, 8787).includes(ipcKey(T).toString("hex")));
{
  const a = authFor(T);
  const ns = "1".repeat(64), nc = "2".repeat(64);
  check("proof: the known answers for both roles",
    proof(a, "client", ns, nc) === "18bc94ca2e62774265efe07a3c36c4308d1e460f6f79db684a09a2acfcf5e9ad"
    && proof(a, "server", ns, nc) === "eac55b7f61503e1c79119b81a30db4107432559ddd9bf98ed368243b47b44166");
  check("…the roles differ over the same nonces (no reflection)", proof(a, "client", ns, nc) !== proof(a, "server", ns, nc));
  check("…the address is bound in (a proof for one daemon is none for another)", proof(authFor(T, "x"), "client", ns, nc) !== proof(a, "client", ns, nc));
  check("…and both nonces are", proof(a, "client", nc, ns) !== proof(a, "client", ns, nc));
}
check("macEqual: equal hex is equal", macEqual("ab".repeat(32), "ab".repeat(32)));
check("macEqual: a different, a short, an uppercase, a non-hex and a non-string MAC are not",
  !macEqual("ac".repeat(32), "ab".repeat(32)) && !macEqual("ab".repeat(31), "ab".repeat(32)) && !macEqual("AB".repeat(32), "ab".repeat(32))
  && !macEqual("zz".repeat(32), "ab".repeat(32)) && !macEqual(42, "ab".repeat(32)) && !macEqual(null, "ab".repeat(32)));

// ---- one in-memory connection: each side's writes are the other's data, on a later tick (as a socket's are).
interface Side { wrote: string[]; got: string[]; failed: string | null; ready: boolean; data: (c: string) => void; stop: () => void }
function pair(serverAuth: IpcAuth, clientAuth: IpcAuth, opts: { timeoutMs?: number } = {}): { s: Side; c: Side } {
  const s: Side = { wrote: [], got: [], failed: null, ready: false, data: () => {}, stop: () => {} };
  const c: Side = { wrote: [], got: [], failed: null, ready: false, data: () => {}, stop: () => {} };
  const to = (side: Side) => (line: string) => { queueMicrotask(() => side.data(line + "\n")); };
  // Client first, so its handler exists when the server's hello is delivered.
  const ch = clientHandshake(clientAuth, {
    write: (l) => { c.wrote.push(l); to(s)(l); }, sink: (x) => c.got.push(x), fail: (w) => { c.failed = w; },
    ready: () => { c.ready = true; }, ...opts,
  });
  c.data = ch.data; c.stop = ch.stop;
  const sh = serverHandshake(serverAuth, { write: (l) => { s.wrote.push(l); to(c)(l); }, sink: (x) => s.got.push(x), fail: (w) => { s.failed = w; }, ...opts });
  s.data = sh.data; s.stop = sh.stop;
  return { s, c };
}

// Both sides hold the token: both open, in order, and later chunks flow to the sinks.
{
  const { s, c } = pair(authFor(T), authFor(T));
  await sleep(20);
  check("same token: the client is ready and neither side failed", c.ready && s.failed === null && c.failed === null);
  const line = (x: string | undefined) => JSON.parse(x ?? "{}") as Record<string, unknown>;
  check("…the server said hello, then its proof — nothing else", s.wrote.length === 2 && line(s.wrote[0]).dtwin === AUTH_PROTO && "mac" in line(s.wrote[1]));
  check("…the client said exactly one line, its proof", c.wrote.length === 1 && "nc" in line(c.wrote[0]));
  s.data('{"cmd":"__ping"}\n');
  c.data('{"ok":true}\n');
  check("…and after it every chunk goes to the frame reader as it came", s.got.join("") === '{"cmd":"__ping"}\n' && c.got.join("") === '{"ok":true}\n');
}

// A client without the token (or a wrong one): the server drops it and never sends its own proof.
{
  const { s, c } = pair(authFor(T), authFor(OTHER), { timeoutMs: 200 });
  await sleep(20);
  check("wrong client token: the server fails it", s.failed !== null);
  check("…having written only the public hello (no proof, no reply)", s.wrote.length === 1);
  check("…and nothing reached the server's frame reader", s.got.length === 0);
  check("…the client is never ready", !c.ready);
  c.stop();
}

// A squatter: a server that does not hold the token answers. The client refuses it, and never sends a
// request (ready is the only door to that).
{
  const { s, c } = pair(authFor(OTHER), authFor(T));
  await sleep(20);
  // The squatter's server side fails the client's proof (different key) and sends no proof — so to show the
  // CLIENT refusing a bad proof, play the squatter by hand below.
  check("squatter (other token): its own side refuses the client's proof", s.failed !== null && !c.ready);
  c.stop();
}
{
  const hello = JSON.stringify({ dtwin: AUTH_PROTO, ns: "3".repeat(64) });
  const c: Side = { wrote: [], got: [], failed: null, ready: false, data: () => {}, stop: () => {} };
  const ch = clientHandshake(authFor(T), { write: (l) => c.wrote.push(l), sink: (x) => c.got.push(x), fail: (w) => { c.failed = w; }, ready: () => { c.ready = true; } });
  ch.data(hello + "\n");
  const sent = JSON.parse(c.wrote[0] ?? "{}") as { nc: string };
  // A squatter that echoes the client's own MAC back as its proof (reflection), then one that forges with its key.
  ch.data(JSON.stringify({ mac: proof(authFor(T), "client", "3".repeat(64), sent.nc) }) + "\n");
  check("a server reflecting the client's own proof back is refused, and the client never becomes ready", c.failed !== null && !c.ready);
  const c2: string[] = [];
  let failed2 = false, ready2 = false;
  const ch2 = clientHandshake(authFor(T), { write: (l) => c2.push(l), sink: () => {}, fail: () => { failed2 = true; }, ready: () => { ready2 = true; } });
  ch2.data(hello + "\n");
  const nc2 = (JSON.parse(c2[0] ?? "{}") as { nc: string }).nc;
  ch2.data(JSON.stringify({ mac: proof(authFor(OTHER), "server", "3".repeat(64), nc2) }) + "\n");
  check("a server proving a different token is refused", failed2 && !ready2);
}

// Replay: a client proof captured from one exchange is refused by the next (the server's nonce is fresh).
{
  const { s, c } = pair(authFor(T), authFor(T));
  await sleep(20);
  const captured = c.wrote[0] ?? "";
  check("fixture: the captured exchange itself succeeded", c.ready && s.failed === null);
  let failed = false;
  const got: string[] = [];
  const wrote: string[] = [];
  const s2 = serverHandshake(authFor(T), { write: (l) => wrote.push(l), sink: (x) => got.push(x), fail: () => { failed = true; } });
  s2.data(captured + "\n" + '{"cmd":"__status"}\n');
  check("a replayed client proof is refused by a new connection", failed && wrote.length === 1 && got.length === 0);
}

// Reflection the other way: a client presenting a SERVER-role MAC over the right nonces is refused.
{
  const wrote: string[] = [];
  let failed = false;
  const sh = serverHandshake(authFor(T), { write: (l) => wrote.push(l), sink: () => {}, fail: () => { failed = true; }, nonce: "4".repeat(64) });
  const nc = "5".repeat(64);
  sh.data(JSON.stringify({ nc, mac: proof(authFor(T), "server", "4".repeat(64), nc) }) + "\n");
  check("a client presenting the server-role MAC is refused", failed && wrote.length === 1);
}

// Shapes the server refuses before computing anything: every one fails, and nothing reaches the frame reader.
for (const [label, line] of [
  ["not JSON", "hello"],
  ["an array", "[]"],
  ["a request frame first (no handshake)", '{"cmd":"__ping"}'],
  ["no nc", JSON.stringify({ mac: "a".repeat(64) })],
  ["a short nc", JSON.stringify({ nc: "a".repeat(63), mac: "a".repeat(64) })],
  ["an uppercase nc", JSON.stringify({ nc: "A".repeat(64), mac: "a".repeat(64) })],
  ["a numeric mac", JSON.stringify({ nc: "a".repeat(64), mac: 7 })],
] as const) {
  let failed = false;
  const got: string[] = [];
  const sh = serverHandshake(authFor(T), { write: () => {}, sink: (x) => got.push(x), fail: () => { failed = true; } });
  sh.data(line + "\n");
  check(`the server refuses ${label}`, failed && got.length === 0);
}
{
  let failed = false;
  const wrote: string[] = [];
  const ch = clientHandshake(authFor(T), { write: (l) => wrote.push(l), sink: () => {}, fail: () => { failed = true; }, ready: () => {} });
  ch.data(JSON.stringify({ dtwin: "auth/0", ns: "1".repeat(64) }) + "\n");
  check("the client refuses a hello of another protocol, and answers nothing", failed && wrote.length === 0);
}

// The pre-auth cap: bytes past AUTH_MAX_BYTES without a finished handshake are not buffered.
{
  let failed = "";
  const sh = serverHandshake(authFor(T), { write: () => {}, sink: () => {}, fail: (w) => { failed = w; } });
  sh.data("x".repeat(AUTH_MAX_BYTES + 1));
  check(`more than ${AUTH_MAX_BYTES} bytes before the proof (and no newline) fails the handshake at once`, /too much data/.test(failed));
  let after = false;
  const sh2 = serverHandshake(authFor(T), { write: () => {}, sink: () => { after = true; }, fail: () => {} });
  sh2.data("x".repeat(AUTH_MAX_BYTES + 1));
  sh2.data("\n");
  check("…and nothing after the failure is read", !after);
}

// The timeout: a peer that says nothing is failed when it runs out.
{
  let failed = "";
  serverHandshake(authFor(T), { write: () => {}, sink: () => {}, fail: (w) => { failed = w; }, timeoutMs: 30 });
  await sleep(80);
  check("a silent client is failed when the handshake's time runs out", /timed out/.test(failed));
  let late = false;
  const sh = serverHandshake(authFor(T), { write: () => {}, sink: () => {}, fail: () => { late = true; }, timeoutMs: 30 });
  sh.stop();
  await sleep(80);
  check("…and stop() (the connection closed) drops the timer: no late failure", !late);
}

// Fixed nonces: the exact hello and proof bytes (what another build must produce).
{
  const wrote: string[] = [];
  serverHandshake(authFor(T), { write: (l) => wrote.push(l), sink: () => {}, fail: () => {}, nonce: "1".repeat(64) }).stop();
  check("the hello on the wire, exactly", wrote[0] === `{"dtwin":"auth/1","ns":"${"1".repeat(64)}"}`);
  const cw: string[] = [];
  const ch = clientHandshake(authFor(T), { write: (l) => cw.push(l), sink: () => {}, fail: () => {}, ready: () => {}, nonce: "2".repeat(64) });
  ch.data((wrote[0] ?? "") + "\n");
  ch.stop();
  check("the client's proof on the wire, exactly", cw[0] === `{"nc":"${"2".repeat(64)}","mac":"18bc94ca2e62774265efe07a3c36c4308d1e460f6f79db684a09a2acfcf5e9ad"}`);
}

// A proof and the first frame in ONE chunk: the frame is not lost (it reaches the reader after the proof).
{
  const nc = "6".repeat(64);
  const got: string[] = [];
  const sh = serverHandshake(authFor(T), { write: () => {}, sink: (x) => got.push(x), fail: () => {}, nonce: "7".repeat(64) });
  sh.data(JSON.stringify({ nc, mac: proof(authFor(T), "client", "7".repeat(64), nc) }) + "\n" + '{"cmd":"__ping"}\n');
  check("a frame in the same chunk as the proof reaches the frame reader", got.join("") === '{"cmd":"__ping"}\n');
}

report();
