// The Figma plugin as the bridge sees it — its UI iframe's WebSocket — for every suite that plays the plugin.
//
//   const p = fakePlugin(port, {
//     token: TOKEN,
//     hello: { instanceId: "fig-1", file: "Sample App" },          // false: connect without identifying
//     on: { ping: () => ({ pong: true, page: "Home", file: "Sample App" }),
//           exportNode: (args, ctx) => (hang ? HANG : screenReply({ … })) },
//   });
//   await p.opened;                       // dialled, and the hello sent
//   p.commands("exportNode"); p.cancels; // what the bridge sent it
//
// Between its socket and its handlers sits the plugin's REAL relay (figma-plugin/src/relay.ts, what ui.html runs):
// a command frame reaches a handler as the main thread's `bridge` message, the handler's answer goes back out as a
// `bridge-result` the relay turns into the reply frame, a cancel frame arrives as the main thread's cancel, and the
// hello is the relay's answer to the socket opening (the identity the main thread would report). So a field renamed in
// the wire frames (bridge/src/plugin-frames.ts) or the main-thread messages fails these suites, not only Figma.
// A fake reply is checked against the real reply type of its command (commands.ts); a reply that is deliberately not
// one goes through fixtures.ts `malformed()`. Progress ticks go straight onto the socket as ProgressFrames: the suites
// send phases and counters the plugin's own progress posts do not model, to test the bridge's reading of them. Misbehaviour is a value, not a separate client:
// HANG never answers, fail() answers ok:false, `ctx.send` / `p.send` put any frame on the wire (a malformed one
// included), `raw: true` is the dead peer that never pongs (ws-client.ts), `redial` keeps dialling until the bridge
// listens and after it drops the socket. It adds no waits of its own: a suite's timing is its own.
import type { Cmd, Commands, WhoamiReply } from "../bridge/src/commands.ts";
import type { BridgeFrame, CancelFrame, CommandFrame, HelloFrame, PluginWireFrame, ProgressFrame } from "../bridge/src/server-core.ts";
import { createRelay, type Relay } from "../figma-plugin/src/relay.ts";
import type { UIToMain } from "../figma-plugin/src/messages.ts";
import { WsClient, type HandshakeRefusal, type RawData } from "./ws-client.ts";

/** A handler's answer that never answers: the command hangs until the bridge gives up on it. */
export const HANG: unique symbol = Symbol("hang");
/** A handler's answer that is a failure: `{ id, ok: false, error }`. */
export interface Failure { readonly failure: string }
export const fail = (error: string): Failure => ({ failure: error });

export interface CommandCtx {
  /** the request id the bridge gave this command */
  readonly id: string;
  /** an unsolicited progress tick (the plugin sends one per page/asset batch while it works) */
  progress(tick: Omit<ProgressFrame, "type">): void;
  /** any frame at all, malformed included */
  send(frame: unknown): void;
}
type Answer<C extends Cmd> = Commands[C]["reply"] | Failure | typeof HANG;
export type Handler<C extends Cmd> = (args: Commands[C]["args"], ctx: CommandCtx) => Answer<C> | Promise<Answer<C>>;
export type Handlers = { [C in Cmd]?: Handler<C> };

export interface FakePluginOptions {
  token: string;
  /** the Origin header; the plugin's iframe sends "null" (the default). `null`: no Origin header. */
  origin?: string | null;
  /** extra request headers (a `host` replaces the Host header) */
  headers?: Record<string, string>;
  /** the raw client (ws-client.ts): never answers a ping, and reports a refused handshake's status */
  raw?: boolean;
  /** sent once the socket opens (on every redial too); `false` connects without identifying */
  hello?: Omit<HelloFrame, "type"> | false;
  /** the commands it answers; any other command is answered ok:false "fake plugin has no <cmd>" */
  on?: Handlers;
  /** what an unhandled command gets: the ok:false answer (the default), or HANG */
  unhandled?: "fail" | typeof HANG;
  /** dial after `startAfterMs`, and again `everyMs` after every close until stop() (a CLI that is still starting) */
  redial?: { startAfterMs?: number; everyMs: number };
}

export interface FakePlugin {
  /** settles when the first socket opens (and its hello is sent); rejects on a dial error when not redialling */
  readonly opened: Promise<void>;
  /** the current socket */
  readonly ws: WsClient;
  /** every frame the bridge sent, in order, with when it arrived */
  readonly frames: Array<{ frame: BridgeFrame; at: number }>;
  /** the commands the bridge sent (all, or the ones named `cmd`) */
  commands(cmd?: Cmd): CommandFrame[];
  /** the request ids the bridge cancelled */
  readonly cancels: string[];
  /** send a hello now (a plugin whose identity arrives late) */
  hello(h: Omit<HelloFrame, "type">): void;
  progress(tick: Omit<ProgressFrame, "type">): void;
  /** any frame at all, malformed included */
  send(frame: PluginWireFrame | unknown): void;
  close(code?: number, reason?: string): void;
  /** drop the socket with no closing handshake */
  terminate(): void;
  /** stop redialling and drop the socket */
  stop(): void;
}

const isFailure = (a: unknown): a is Failure => typeof a === "object" && a !== null && "failure" in a && typeof a.failure === "string";
function isBridgeFrame(v: unknown): v is BridgeFrame {
  if (typeof v !== "object" || v === null || !("id" in v) || typeof v.id !== "string") return false;
  return ("type" in v && v.type === "cancel") || ("cmd" in v && typeof v.cmd === "string");
}
const isCancel = (f: BridgeFrame): f is CancelFrame => "type" in f && f.type === "cancel";
/** What the main thread's whoami read would report for a plugin announcing `h` (the relay turns it into the hello;
 *  an empty string goes out as null, as it does from the real plugin). */
const identityOf = (h: Omit<HelloFrame, "type">): WhoamiReply => ({
  instanceId: h.instanceId ?? "", startedAt: 0, uptimeMs: 0, file: h.file ?? "", page: h.page ?? "", pageId: "",
  editorType: "figma", pluginVersion: h.pluginVersion ?? "", fileKey: h.fileKey ?? null, fileKeyAvailable: typeof h.fileKey === "string",
});

export function fakePlugin(port: number, opts: FakePluginOptions): FakePlugin {
  const url = `ws://127.0.0.1:${port}/?token=${opts.token}`;
  const origin = opts.origin === undefined ? "null" : opts.origin;
  const handlers: Handlers = opts.on ?? {};
  const frames: Array<{ frame: BridgeFrame; at: number }> = [];
  const cancels: string[] = [];
  let stopped = false;
  let resolveOpened: () => void = () => {};
  let rejectOpened: (e: unknown) => void = () => {};
  const opened = new Promise<void>((res, rej) => { resolveOpened = res; rejectOpened = rej; });
  // A plugin meant to be refused need not await `opened`: its rejection must not crash the suite as an unhandled one.
  // A caller that does await it still sees the rejection. (A redialling plugin never rejects it: a dial error there is
  // "not listening yet".)
  opened.catch(() => {});

  const sendOn = (c: WsClient, frame: unknown): void => { c.send(JSON.stringify(frame)); };
  // The main thread's answers go back through the relay, as main.ts posts them to ui.html.
  const reply = (relay: Relay, id: string | undefined, a: Answer<Cmd>): void => {
    if (a === HANG) return;
    if (isFailure(a)) relay.fromMain({ type: "bridge-result", ...(id !== undefined ? { id } : {}), ok: false, result: undefined, error: a.failure });
    else relay.fromMain({ type: "bridge-result", ...(id !== undefined ? { id } : {}), ok: true, result: a });
  };
  const answer = (c: WsClient, relay: Relay, cmd: string, args: unknown, id: string | undefined): void => {
    const ctx: CommandCtx = {
      id: id ?? "",
      progress: (tick) => sendOn(c, { type: "progress", ...tick } satisfies ProgressFrame),
      send: (frame) => sendOn(c, frame),
    };
    const failed = (e: unknown): void => reply(relay, id, fail(e instanceof Error ? e.message : String(e)));
    // handlers[cmd] is the handler OF cmd, but TS cannot correlate the key with its args/reply types (nor is a
    // wire `cmd` known to be a Cmd: one that is not has no handler).
    const h = Object.prototype.hasOwnProperty.call(handlers, cmd) ? (handlers[cmd as Cmd] as Handler<Cmd> | undefined) : undefined;
    if (!h) {
      if (opts.unhandled !== HANG) failed(`fake plugin has no ${cmd}`);
      return;
    }
    // A handler that throws answers ok:false with its message, as the real plugin answers a collector that throws.
    let a: ReturnType<Handler<Cmd>>;
    // The handler reads the args the bridge sent: a CommandFrame's, typed by its command (commands.ts).
    try { a = h(args as Commands[Cmd]["args"], ctx); } catch (e) { failed(e); return; }
    // A plain answer goes out in the same tick the command arrived in, as a hand-written fake's did.
    if (a instanceof Promise) a.then((v) => reply(relay, id, v), failed);
    else reply(relay, id, a);
  };
  // The main thread, as far as the bridge can tell: who it is, the commands it answers, the cancels it is sent.
  const hello = opts.hello;
  const mainThread = (c: WsClient, relay: Relay, m: UIToMain): void => {
    if (m.type === "get-identity") { if (hello !== false && hello !== undefined) relay.fromMain({ type: "identity", identity: identityOf(hello) }); }
    else if (m.type === "bridge") answer(c, relay, m.cmd, m.args, m.id);
    else if (m.type === "cancel" && m.id !== undefined) cancels.push(m.id);
  };

  const dial = (): WsClient => {
    const c = new WsClient(url, { ...(origin !== null ? { origin } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.raw ? { raw: true } : {}) });
    const relay: Relay = createRelay({ toSocket: (f) => sendOn(c, f), toMain: (m) => mainThread(c, relay, m) });
    relays.set(c, relay);
    // Without redial, a socket that never opens settles `opened`: a dial error, a refused handshake (the raw client
    // reports it as `unexpected-response`, then closes, with no `error`), or any close before open.
    let wasOpen = false;
    c.on("error", (e: unknown) => { if (!opts.redial) rejectOpened(e); });
    c.on("unexpected-response", (r: HandshakeRefusal) => { if (!opts.redial) rejectOpened(new Error(`handshake refused: HTTP ${r.statusCode} ${r.body}`)); });
    c.on("close", (code: number) => { if (!opts.redial && !wasOpen) rejectOpened(new Error(`closed before it opened (code ${code})`)); });
    c.on("open", () => {
      wasOpen = true;
      relay.socketOpened(); // the main thread answers get-identity: the hello
      resolveOpened();
    });
    c.on("close", () => relay.socketClosed());
    c.on("message", (raw: RawData) => {
      const text = String(raw);
      let v: unknown;
      try { v = JSON.parse(text) as unknown; } catch { v = undefined; }
      if (isBridgeFrame(v)) frames.push({ frame: v, at: Date.now() });
      relay.fromSocket(text);
    });
    if (opts.redial) {
      const { everyMs } = opts.redial;
      c.on("close", () => { if (!stopped) setTimeout(() => { if (!stopped) ws = dial(); }, everyMs); });
    }
    return c;
  };

  const relays = new WeakMap<WsClient, Relay>();
  // null until the first dial (a redialling plugin may start late)
  let ws: WsClient | null = null;
  if (opts.redial?.startAfterMs) setTimeout(() => { if (!stopped) ws = dial(); }, opts.redial.startAfterMs);
  else ws = dial();
  const current = (): WsClient => {
    if (!ws) throw new Error("fake plugin has not dialled yet (redial.startAfterMs): await `opened` first");
    return ws;
  };

  return {
    opened,
    get ws() { return current(); },
    frames,
    commands: (cmd) => frames.map((f) => f.frame).filter((f): f is CommandFrame => !isCancel(f) && (cmd === undefined || f.cmd === cmd)),
    cancels,
    // A later identity is announced the way the plugin announces any: the main thread's identity, through the relay.
    hello: (h) => { relays.get(current())?.fromMain({ type: "identity", identity: identityOf(h) }); },
    progress: (tick) => sendOn(current(), { type: "progress", ...tick } satisfies ProgressFrame),
    send: (frame) => sendOn(current(), frame),
    close: (code, reason) => current().close(code, reason),
    terminate: () => current().terminate(),
    stop: () => { stopped = true; ws?.terminate(); },
  };
}
