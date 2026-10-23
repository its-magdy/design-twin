// daemon-auth.ts — the daemon socket's mutual handshake: each side proves it holds the bridge token
// before either says anything else.
//
// WHY. On POSIX the daemon socket sits in a directory only this user can enter (daemon.ts), so whoever
// answers on it is us. Windows has no such directory for a named pipe: the runtime (libuv, under Bun's
// node:net) creates it with the DEFAULT security descriptor — full control for SYSTEM, Administrators and
// the creating user, READ for Everyone and Anonymous — and offers no way to narrow it, nor for a client to
// ask who created the server end. So another local user could create the pipe name first (a squatter) and
// answer our CLI with forged replies, or simply connect and ask the daemon to export. What both sides do
// share, and nobody else has, is the bridge token (token-store.ts: %APPDATA% is per-user by ACL). This
// file turns it into proof, in both directions, before a single request or reply crosses the pipe.
//
// THE EXCHANGE (newline-delimited JSON, the daemon socket's own framing; every field hex):
//   server → client  {"dtwin":"auth/1","ns":<32 random bytes>}
//   client → server  {"nc":<32 random bytes>,"mac":HMAC(k, "client\0" + name + "\0" + ns + "\0" + nc)}
//   server → client  {"mac":HMAC(k, "server\0" + name + "\0" + ns + "\0" + nc)}
// then the ordinary request/reply frames. k = HMAC-SHA256(token, "dtwin-daemon-ipc/v1"): a key of its own,
// so nothing computed here is ever a MAC under the token the plugin's WebSocket presents. `name` is the
// pipe (or socket path) itself, so a proof made for one daemon's address — another port's — is no proof
// on another's.
//
// What each part buys:
//  - Fresh nonces from BOTH sides, and both bound into both MACs: a recorded exchange replays nowhere (the
//    real server always picks a new `ns`), and a squatter learns only MACs over nonces of its own choosing.
//  - Role labels ("client" / "server"): a server cannot reflect a client's proof back as its own.
//  - Before the proof: at most AUTH_MAX_BYTES read, AUTH_TIMEOUT_MS to finish, and any failure destroys
//    the connection with NO error text — an unauthenticated peer learns nothing but "closed". (The hello
//    itself is public: Everyone can read the pipe, so `ns` is written to be seen.)
//  - Compared in constant time (timingSafeEqual) on fixed 32-byte digests, after a shape check.
// Authenticating once, at connect, is enough: a connected pipe or Unix socket is a kernel object a third
// process cannot splice into, so there is no per-message MAC.
//
// What it does NOT stop: a squatter that holds the name can still refuse service (our `serve` cannot bind
// it, and every command then opens its own bridge — the same fallback as a refused socket directory on
// POSIX). And another process running as THIS user can read the token file, as everywhere (token-store.ts).
import crypto from "node:crypto";
import { isRecord } from "./json-util.ts";

/** The protocol tag the server's hello carries — what a client checks before it answers. */
export const AUTH_PROTO = "auth/1";
/** The most an unauthenticated peer may send before it has proved the key (the client's proof is ~200
 *  bytes; the server's hello and proof less). Past it the connection is dropped, not buffered. */
export const AUTH_MAX_BYTES = 1024;
/** How long the whole exchange may take, from either side. A peer that stalls is dropped. */
export const AUTH_TIMEOUT_MS = 5000;

/** What both sides key the handshake on: the key derived from the token, and the address it is bound to. */
export interface IpcAuth {
  key: Buffer;
  name: string;
}

const hmac = (key: crypto.BinaryLike, msg: string): Buffer => crypto.createHmac("sha256", key).update(msg).digest();

/** The handshake key for `token` — never the token itself. */
export function ipcKey(token: string): Buffer {
  return hmac(token, "dtwin-daemon-ipc/v1");
}

/** The Windows pipe the daemon for `port` listens on when the bridge token is `token`. Derived, so it is
 *  not guessable before a daemon first runs (anyone can LIST pipe names after that: the name is a speed
 *  bump for a squatter, never the protection — the handshake is). Keyed by port, as the POSIX socket is. */
export function pipeName(token: string, port: number): string {
  return `\\\\.\\pipe\\designtwin-${port}-${hmac(ipcKey(token), "pipe-name|" + port).toString("hex").slice(0, 32)}`;
}

/** The MAC `role` sends over the two nonces, hex. */
export function proof(auth: IpcAuth, role: "client" | "server", ns: string, nc: string): string {
  return hmac(auth.key, `${role}\0${auth.name}\0${ns}\0${nc}`).toString("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;
const nonce = (): string => crypto.randomBytes(32).toString("hex");

/** Is `got` the MAC `want` (both hex) — shape-checked, then compared in constant time on the 32 bytes. */
export function macEqual(got: unknown, want: string): boolean {
  if (typeof got !== "string" || !HEX64.test(got) || !HEX64.test(want)) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}

/** One side's wiring: `write` sends a line (the newline is added here), `sink` receives every chunk once
 *  the peer has proved the key (starting with whatever followed the last handshake line), `fail` is called
 *  at most once, on any failure — the caller destroys the connection and says nothing to the peer. */
export interface HandshakeIo {
  write: (line: string) => void;
  sink: (chunk: string) => void;
  fail: (why: string) => void;
  timeoutMs?: number;
  /** Fixed nonce, for the tests' known-answer vectors only. */
  nonce?: string;
}

/** The connection's data handler for one side, already armed (its timeout runs from this call). Until the
 *  peer has proved the key every byte is the handshake's — capped, line by line; after it, chunks go
 *  straight to `sink`. `onLine` handles one handshake line and returns true when the handshake is done. */
function gate(io: HandshakeIo, onLine: (line: string) => boolean | "fail"): { data: (chunk: string) => void; stop: () => void } {
  let buf = "";
  let state: "auth" | "open" | "failed" = "auth";
  // The failure waits one more turn of the loop (setImmediate): a daemon whose loop was blocked (serializing a
  // big export) wakes with this timer due AND the peer's proof already waiting to be read — the timers run
  // first, and the read must get its chance before an honest peer is dropped for the daemon's own stall.
  const t = setTimeout(() => setImmediate(() => fail("timed out")), io.timeoutMs ?? AUTH_TIMEOUT_MS);
  // unref: a half-open handshake must never be what keeps a process alive.
  t.unref?.();
  function fail(why: string): void {
    if (state !== "auth") return;
    state = "failed";
    clearTimeout(t);
    io.fail(why);
  }
  return {
    stop: () => { if (state === "auth") { state = "failed"; clearTimeout(t); } },
    data: (chunk: string) => {
      if (state === "open") return io.sink(chunk);
      if (state === "failed") return;
      buf += chunk;
      // The cap counts what is buffered, so a peer cannot stream megabytes by never sending a newline.
      if (buf.length > AUTH_MAX_BYTES) return fail("too much data before the handshake finished");
      let i;
      while (state === "auth" && (i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const r = onLine(line);
        if (r === "fail") return fail("bad handshake");
        if (r) {
          state = "open";
          clearTimeout(t);
          const rest = buf;
          buf = "";
          if (rest) io.sink(rest);
        }
      }
    },
  };
}

const parse = (line: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(line) as unknown; return isRecord(v) ? v : null; } catch { return null; }
};

/** The server's side: writes the hello at once, then waits for the client's proof, answers with its own,
 *  and opens. Returns the connection's data handler, and `stop` (the connection closed: drop the timer). */
export function serverHandshake(auth: IpcAuth, io: HandshakeIo): { data: (chunk: string) => void; stop: () => void } {
  const ns = io.nonce ?? nonce();
  const g = gate(io, (line) => {
    const m = parse(line);
    if (!m || typeof m.nc !== "string" || !HEX64.test(m.nc)) return "fail";
    if (!macEqual(m.mac, proof(auth, "client", ns, m.nc))) return "fail";
    io.write(JSON.stringify({ mac: proof(auth, "server", ns, m.nc) }));
    return true;
  });
  io.write(JSON.stringify({ dtwin: AUTH_PROTO, ns }));
  return g;
}

/** The client's side, plus `ready`: called once the server has proved the key — the moment the caller may
 *  send its request. Nothing is written before the server's hello arrives. */
export function clientHandshake(auth: IpcAuth, io: HandshakeIo & { ready: () => void }): { data: (chunk: string) => void; stop: () => void } {
  const nc = io.nonce ?? nonce();
  let ns: string | null = null;
  return gate(io, (line) => {
    const m = parse(line);
    if (!m) return "fail";
    if (ns === null) {
      if (m.dtwin !== AUTH_PROTO || typeof m.ns !== "string" || !HEX64.test(m.ns)) return "fail";
      ns = m.ns;
      io.write(JSON.stringify({ nc, mac: proof(auth, "client", ns, nc) }));
      return false;
    }
    if (!macEqual(m.mac, proof(auth, "server", ns, nc))) return "fail";
    io.ready();
    return true;
  });
}
