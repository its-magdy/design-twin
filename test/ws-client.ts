// A test stand-in for the Figma plugin's WebSocket: the bridge (bridge/src/server-core.ts) is the server,
// and every suite that plays the plugin dials it through this.
//
// The default is Bun's own WebSocket client — a real, independent client implementation, which is as close
// as a test gets to the plugin's browser socket — behind the small event API the suites were written
// against (the `ws` package's: on("open" | "message" | "close" | "error" | "ping"), terminate(), an Origin
// option). The `ws` package is gone (under Bun it is Bun's shim, which ignores `origin` and `autoPong`).
//
// Two things a well-behaved client cannot do, so `raw: true` is a hand-rolled RFC 6455 client over a TCP
// socket instead:
//   - be a DEAD peer: it never answers a ping (the heartbeat's "lid closed" client; Bun's client always
//     pongs, and has no switch to stop);
//   - see a refused handshake's HTTP status: it emits `unexpected-response` with the status and body, where
//     a WebSocket only ever sees "Expected 101 status code".
// It sends text frames, masks them, and reads server frames (text, binary, ping, pong, close; fragmented or
// not) — enough to play the plugin, not a general client.
import { EventEmitter } from "node:events";
import net from "node:net";
import crypto from "node:crypto";

/** A message payload: a string for a text frame, a Buffer for a binary one. Both answer `.toString()`. */
export type RawData = string | Buffer;

export interface ClientOptions {
  /** The Origin header (the plugin's iframe sends "null"). Absent: no Origin header at all. */
  origin?: string;
  /** Extra request headers — a `host` here replaces the Host header (a non-loopback Host is refused). */
  headers?: Record<string, string>;
  /** The raw client (see the header): never pongs, and reports a refused handshake's HTTP status. */
  raw?: boolean;
}

/** What `unexpected-response` carries: the refused handshake's HTTP status and body. */
export interface HandshakeRefusal {
  statusCode: number;
  body: string;
}

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

export class WsClient extends EventEmitter {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;
  readonly #impl: Impl;

  constructor(url: string, opts: ClientOptions = {}) {
    super();
    const headers: Record<string, string> = { ...(opts.origin !== undefined ? { Origin: opts.origin } : {}), ...(opts.headers ?? {}) };
    this.#impl = opts.raw ? rawClient(this, url, headers) : bunClient(this, url, headers);
  }

  get readyState(): number { return this.#impl.readyState(); }
  send(data: string): void { this.#impl.send(data); }
  close(code?: number, reason?: string): void { this.#impl.close(code, reason); }
  /** Drop the connection at once, with no closing handshake. */
  terminate(): void { this.#impl.terminate(); }
}

interface Impl {
  readyState(): number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

// ---- Bun's WebSocket, re-emitted as events on `ev`.
function bunClient(ev: EventEmitter, url: string, headers: Record<string, string>): Impl {
  // `headers` (with Origin and Host) is Bun's extension to the WHATWG constructor.
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "nodebuffer";
  ws.addEventListener("open", () => ev.emit("open"));
  ws.addEventListener("message", (e: MessageEvent) => ev.emit("message", e.data as RawData, typeof e.data !== "string"));
  // Bun's client answers every ping itself and also reports it as an event.
  ws.addEventListener("ping" as "message", (e: MessageEvent) => ev.emit("ping", e.data));
  ws.addEventListener("error", (e: Event) => ev.emit("error", new Error((e as ErrorEvent).message || "WebSocket error")));
  ws.addEventListener("close", (e: CloseEvent) => ev.emit("close", e.code, e.reason));
  return {
    readyState: () => ws.readyState,
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
}

// ---- the raw client
function rawClient(ev: EventEmitter, url: string, headers: Record<string, string>): Impl {
  const u = new URL(url);
  const key = crypto.randomBytes(16).toString("base64");
  const expectAccept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  let state = CONNECTING;
  let closeEmitted = false;
  let closeSent = false;
  // Received bytes not yet consumed, as a chunk list: a frame is joined once, when all of it is here
  // (re-concatenating the whole buffer per chunk is quadratic on a large frame).
  const chunks: Buffer[] = [];
  let have = 0;
  let handshakeDone = false;
  let fragments: Buffer[] = [];
  let fragOpcode = 0;
  let closeCode = 1006, closeReason = "";

  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const sock = net.connect(Number(u.port || 80), u.hostname);
  const emitClose = (): void => {
    if (closeEmitted) return;
    closeEmitted = true;
    state = CLOSED;
    ev.emit("close", closeCode, closeReason);
  };
  sock.on("error", (e) => { if (state === CONNECTING && ev.listenerCount("error")) ev.emit("error", e); });
  sock.on("close", emitClose);
  sock.on("connect", () => {
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${lower.host ?? u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).filter(([k]) => k.toLowerCase() !== "host").map(([k, v]) => `${k}: ${v}`),
    ];
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });

  // The unconsumed bytes, joined into one Buffer only when a read needs more than the first chunk holds.
  const first = (): Buffer => chunks[0] ?? Buffer.alloc(0);
  const join = (): Buffer => {
    if (chunks.length > 1) { const all = Buffer.concat(chunks, have); chunks.length = 0; chunks.push(all); }
    return first();
  };
  const peek = (n: number): Buffer | null => (have < n ? null : (first().length >= n ? first() : join()).subarray(0, n));
  const take = (n: number): Buffer => {
    const all = join();
    chunks.length = 0;
    if (all.length > n) chunks.push(all.subarray(n));
    have -= n;
    return all.subarray(0, n);
  };
  const unmask = (b: Buffer, m: Buffer): void => { for (let i = 0; i < b.length; i++) b[i] = b.readUInt8(i) ^ m.readUInt8(i & 3); };

  const frame = (opcode: number, payload: Buffer): Buffer => {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    const body = Buffer.from(payload);
    unmask(body, mask);
    return Buffer.concat([head, mask, body]);
  };
  const sendClose = (code: number | undefined, reason: string): void => {
    if (closeSent || sock.destroyed) return;
    closeSent = true;
    const payload = code === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)]);
    sock.write(frame(8, payload));
  };

  function onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 9) { ev.emit("ping", payload); return; } // never answered: this client is the dead peer
    if (opcode === 10) { ev.emit("pong", payload); return; }
    if (opcode === 8) {
      closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      closeReason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      sendClose(payload.length >= 2 ? closeCode : undefined, "");
      state = CLOSING;
      sock.end();
      return;
    }
    if (opcode !== 0) { fragOpcode = opcode; fragments = []; }
    fragments.push(payload);
    if (!fin) return;
    const data = Buffer.concat(fragments);
    fragments = [];
    if (fragOpcode === 1) ev.emit("message", data.toString("utf8"), false);
    else ev.emit("message", data, true);
  }

  function pump(): void {
    if (!handshakeDone) {
      const all = peek(have);
      if (!all) return;
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = take(end + 4).toString("latin1");
      const [statusLine = "", ...hdrs] = head.split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      if (status !== 101) {
        // The refusal's body follows (Content-Length); collect it, then report.
        const len = Number(/^content-length:\s*(\d+)/im.exec(hdrs.join("\n"))?.[1] ?? 0);
        const finish = (): void => {
          if (have < len) return;
          const body = take(len).toString("utf8");
          sock.removeListener("data", onBody);
          ev.emit("unexpected-response", { statusCode: status, body } satisfies HandshakeRefusal);
          sock.destroy();
        };
        const onBody = (): void => finish();
        handshakeDone = true; // no frames will follow; pump() is done with this socket
        sock.removeListener("data", onData);
        sock.on("data", (c: Buffer) => { chunks.push(c); have += c.length; onBody(); });
        finish();
        return;
      }
      const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(hdrs.join("\n"))?.[1];
      if (accept !== expectAccept) { sock.destroy(); return; }
      handshakeDone = true;
      state = OPEN;
      ev.emit("open");
    }
    for (;;) {
      const h = peek(2);
      if (!h) return;
      const b0 = h.readUInt8(0), b1 = h.readUInt8(1);
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { const e = peek(4); if (!e) return; len = e.readUInt16BE(2); off = 4; }
      else if (len === 127) { const e = peek(10); if (!e) return; len = Number(e.readBigUInt64BE(2)); off = 10; }
      const total = off + (masked ? 4 : 0) + len;
      if (have < total) return;
      const f = take(total);
      const payload = Buffer.from(f.subarray(total - len));
      if (masked) unmask(payload, f.subarray(off, off + 4));
      onFrame(fin, opcode, payload);
      if (state !== OPEN) return;
    }
  }
  const onData = (c: Buffer): void => { chunks.push(c); have += c.length; pump(); };
  sock.on("data", onData);

  return {
    readyState: () => state,
    send: (d) => { if (state === OPEN) sock.write(frame(1, Buffer.from(d, "utf8"))); },
    close: (code, reason = "") => {
      if (state !== OPEN) return;
      state = CLOSING;
      sendClose(code, reason);
      if (code !== undefined) { closeCode = code; closeReason = reason; }
      // The server answers with its own close frame and ends the connection (onFrame above).
    },
    terminate: () => { closeCode = 1006; closeReason = ""; sock.destroy(); },
  };
}
