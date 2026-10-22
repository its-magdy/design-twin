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
// It speaks the wire frames server-core.ts declares (CommandFrame / CancelFrame in, HelloFrame / ProgressFrame /
// ReplyFrame out), so a fake reply is checked against the real reply type of its command (commands.ts); a reply that
// is deliberately not one goes through fixtures.ts `malformed()`. Misbehaviour is a value, not a separate client:
// HANG never answers, fail() answers ok:false, `ctx.send` / `p.send` put any frame on the wire (a malformed one
// included), `raw: true` is the dead peer that never pongs (ws-client.ts), `redial` keeps dialling until the bridge
// listens and after it drops the socket. It adds no waits of its own: a suite's timing is its own.
import type { Cmd, Commands } from "../bridge/src/commands.ts";
import type { BridgeFrame, CancelFrame, CommandFrame, HelloFrame, PluginWireFrame, ProgressFrame } from "../bridge/src/server-core.ts";
import { WsClient, type RawData } from "./ws-client.ts";

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
  // A redialling plugin keeps retrying; a dial error is "not listening yet", never a failure.
  if (opts.redial) opened.catch(() => {});

  const sendOn = (c: WsClient, frame: unknown): void => { c.send(JSON.stringify(frame)); };
  const reply = (c: WsClient, id: string, a: Answer<Cmd>): void => {
    if (a === HANG) return;
    if (isFailure(a)) sendOn(c, { id, ok: false, error: a.failure });
    else sendOn(c, { id, ok: true, result: a });
  };
  const answer = (c: WsClient, cmd: CommandFrame): void => {
    const ctx: CommandCtx = {
      id: cmd.id,
      progress: (tick) => sendOn(c, { type: "progress", ...tick } satisfies ProgressFrame),
      send: (frame) => sendOn(c, frame),
    };
    // handlers[cmd.cmd] is the handler OF cmd.cmd, but TS cannot correlate the key with its args/reply types.
    const h = handlers[cmd.cmd] as Handler<Cmd> | undefined;
    if (!h) {
      if (opts.unhandled !== HANG) sendOn(c, { id: cmd.id, ok: false, error: `fake plugin has no ${cmd.cmd}` });
      return;
    }
    const a = h(cmd.args, ctx);
    // A plain answer goes out in the same tick the command arrived in, as a hand-written fake's did.
    if (a instanceof Promise) void a.then((v) => reply(c, cmd.id, v));
    else reply(c, cmd.id, a);
  };

  const dial = (): WsClient => {
    const c = new WsClient(url, { ...(origin !== null ? { origin } : {}), ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.raw ? { raw: true } : {}) });
    c.on("error", (e: unknown) => { if (!opts.redial) rejectOpened(e); });
    c.on("open", () => {
      if (opts.hello !== false && opts.hello !== undefined) sendOn(c, { type: "hello", ...opts.hello } satisfies HelloFrame);
      resolveOpened();
    });
    c.on("message", (raw: RawData) => {
      let v: unknown;
      try { v = JSON.parse(String(raw)) as unknown; } catch { return; }
      if (!isBridgeFrame(v)) return;
      frames.push({ frame: v, at: Date.now() });
      if (isCancel(v)) { cancels.push(v.id); return; }
      answer(c, v);
    });
    if (opts.redial) {
      const { everyMs } = opts.redial;
      c.on("close", () => { if (!stopped) setTimeout(() => { if (!stopped) ws = dial(); }, everyMs); });
    }
    return c;
  };

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
    hello: (h) => sendOn(current(), { type: "hello", ...h } satisfies HelloFrame),
    progress: (tick) => sendOn(current(), { type: "progress", ...tick } satisfies ProgressFrame),
    send: (frame) => sendOn(current(), frame),
    close: (code, reason) => current().close(code, reason),
    terminate: () => current().terminate(),
    stop: () => { stopped = true; ws?.terminate(); },
  };
}
