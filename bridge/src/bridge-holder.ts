// bridge-holder.ts — find the bridge's owner, or take the bridge and share it: one module for the three ways a
// process reaches the plugin.
//
// Port 8787 has one owner. Every front-end used to work out for itself whether a daemon already held it, when to
// open a bridge of its own, whether to publish that bridge on the daemon socket, and how to let go — three times,
// with three startup orders and teardowns (the CLI's one-shot session, `dtwin serve`, and the MCP server, whose
// version kept five module globals, an in-flight memo against a double bind, and read the daemon's frame counters
// across the seam to decide whether it could exit). Here it is once. A front-end picks a LIFETIME and supplies its
// events; the holder hides probe-or-bind, publishing on the daemon socket, whether others used it, the idle
// window, and releasing exactly once.
//
//   one-shot  a CLI command: the running daemon when there is one, else a bridge of its own for this command only
//             (never shared — a process that finds the port held exits on it, as it always did). release() closes it.
//   serve     `dtwin serve`: must be the owner (a live daemon is refused, naming --stop), publishes its bridge on the
//             daemon socket with the settings' idle window, and owns the process's signals (daemon.ts serve).
//   session   the MCP server: lives as long as its MCP client. Re-resolves the owner whenever it does not hold the
//             bridge itself (a daemon it routed through may have gone — that session closed, `dtwin stop`), so it
//             takes the bridge over when the owner goes. Holding it, it publishes it with no idle window; when the
//             client leaves (clientLeft) it releases at once unless OTHER processes have used the socket, and then
//             keeps serving them with the settings' idle window. A held port is the caller's error, never an exit:
//             the process is the user's stdio session.
//
// What the front-ends keep: their own events (the CLI's command finishing, the MCP server's stdin / stdout errors
// / signals) turned into release() or clientLeft(), and what to do once `released` settles (exit).
import { daemonUpstream, ownUpstream, servedBridge } from "./route.ts";
import type { HeldBridge, Upstream } from "./route.ts";
import type { DaemonBridge, DaemonConnection, DaemonStatusView, ServeHandle } from "./daemon.ts";
import * as daemon from "./daemon.ts";
import { daemonPlace, humanMs } from "./settings.ts";
import type { BridgeSettings } from "./settings.ts";
import type { Bridge, BridgeOptions } from "./server-core.ts";
import { errMsg } from "./errmsg.ts";

export type Lifetime = "one-shot" | "serve" | "session";

/** What the holder needs of a bridge it opens: what the route's adapters use (HeldBridge), when it is bound, the
 *  token a daemon serving it is keyed on, and the token it ended up using (a minted one, now saved). server-core's
 *  createBridge result is one; a suite passes a fake. */
export type OwnBridge = HeldBridge & Pick<Bridge, "listening" | "savedToken" | "tokenInUse">;
export type BridgeFactory = (settings: BridgeSettings, opts: BridgeOptions) => OwnBridge;

/** What the holder needs of the daemon socket, bound to a port and token (daemonSide). */
export interface DaemonSide {
  /** the live daemon's connection, or null */
  connect(): Promise<DaemonConnection | null>;
  status(): Promise<DaemonStatusView | null>;
  /** throws when a live daemon (or a foreign holder) already has the socket */
  assertNoDaemon(): Promise<string>;
  serve(bridge: DaemonBridge, o: { idleMs: number; signals: boolean; log: (m: string) => void; token: string | null }): Promise<ServeHandle>;
}

/** The daemon module, bound to `settings`' port and token (settings.ts daemonPlace). */
export function daemonSide(settings: BridgeSettings): DaemonSide {
  const { port, place } = daemonPlace(settings);
  return {
    connect: () => daemon.connect(port, place),
    status: () => daemon.status(port, place),
    assertNoDaemon: () => daemon.assertNoDaemon(port, place),
    serve: (bridge, o) => daemon.serve(bridge, { port, ...o }),
  };
}

export interface HolderDeps {
  settings: BridgeSettings;
  createBridge: BridgeFactory;
  /** the daemon side for the settings as they are NOW (daemonSide): a token this process mints and saves keys every
   *  later lookup, so a first-run session still finds the daemon a later `dtwin serve` names from that token */
  daemon: (settings: BridgeSettings) => DaemonSide;
  /** the front-end's log line (stderr) */
  log: (m: string) => void;
}

/** Where this process is in relation to the bridge, for a status line. */
export type Held =
  | { kind: "none" }
  | { kind: "daemon"; sock: string }
  | { kind: "own"; port: number; sock: string | null };

export interface Holder {
  /** Where requests go now: a daemon's socket, or the bridge this process holds — resolved as the lifetime says.
   *  Concurrent calls share one resolution (two first calls never both bind). */
  upstream(): Promise<Upstream>;
  /** session: the client has gone. Releases now unless other processes have used the shared socket; then serves
   *  them on, and releases after the settings' idle window without one. Once only; a no-op for other lifetimes. */
  clientLeft(how: string): void;
  /** Let go of everything this process holds, exactly once: the served socket (its forwarded requests aborted, its
   *  file unlinked) and the bridge (a cancel frame for every request still in flight). `why` is logged when given. */
  release(why?: string): void;
  /** Settles with the reason once the holder has let go — release(), clientLeft, `dtwin stop`, the idle shutdown. */
  readonly released: Promise<string>;
  held(): Held;
}

const RELEASED = "the bridge has been released";

export function bridgeHolder(lifetime: Lifetime, deps: HolderDeps): Holder {
  const { log } = deps;
  // The settings, updated once a bridge of ours has started: a token it minted is saved from then on, and every later
  // bridge and daemon lookup uses it as saved — a rebind must not write it over a file rotated since, nor print it again.
  let settings = deps.settings;
  const side = (): DaemonSide => deps.daemon(settings);
  // The bridge this process holds, its adapter, and the socket it is published on (null until serve() bound it).
  let own: { bridge: OwnBridge; up: Upstream; close: () => void } | null = null;
  let served: ServeHandle | null = null;
  let resolving: Promise<Upstream> | null = null;
  let viaDaemon: string | null = null;
  let gone = false; // session: the client has left
  let done = false;
  let settle: (why: string) => void = () => {};
  const released = new Promise<string>((r) => { settle = r; });
  const finish = (why: string): void => {
    if (done) return;
    done = true;
    settle(why);
  };

  // Open a bridge of our own. `survive`: a held port is this call's error (session), not an exit (one-shot, serve
  // — server-core prints the fix and exits 1 when no onListenError is given).
  async function bind(survive: boolean): Promise<OwnBridge> {
    const b = await bound(survive);
    if (settings.token.ok) settings = { ...settings, token: { ok: true, resolved: b.tokenInUse() } };
    // Released while it was binding (the command finished, a signal, the client left): nobody is left to use it.
    if (done) { b.close(); throw new Error(RELEASED); }
    return b;
  }
  async function bound(survive: boolean): Promise<OwnBridge> {
    if (!survive) {
      const b = deps.createBridge(settings, {});
      await b.listening;
      return b;
    }
    let failed: (e: Error) => void = () => {};
    const bindFailed = new Promise<never>((_, reject) => { failed = reject; });
    const b = deps.createBridge(settings, { onListenError: (e) => failed(e) });
    try {
      await Promise.race([b.listening, bindFailed]);
    } catch (e) {
      b.close();
      throw e;
    }
    return b;
  }

  // Hold `b`: its adapter, and a close that forgets it — so a session re-resolves instead of talking to a closed
  // server. Closed from outside (`dtwin stop`, the idle shutdown) after the client has gone, nothing is left to do.
  function hold(b: OwnBridge): NonNullable<typeof own> {
    const up = ownUpstream(b);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      own = null;
      served = null;
      resolving = null;
      b.close();
      if (lifetime === "serve") finish("the daemon shut down");
      else if (gone) release("the shared bridge was stopped after the MCP client went away — exiting");
    };
    own = { bridge: b, up, close };
    return own;
  }

  // Publish the held bridge on the daemon socket. `idleMs` 0 for a session while its client is here.
  function publish(b: OwnBridge, close: () => void, idleMs: number, signals: boolean): Promise<ServeHandle> {
    return side().serve(servedBridge(b, close), { idleMs, signals, log, token: b.savedToken() });
  }

  // A daemon found: its adapter (listings from its status, at the place it was found).
  async function viaDaemonOr(): Promise<Upstream | null> {
    const d = side();
    const via = await d.connect();
    if (done) throw new Error(RELEASED);
    if (!via) { viaDaemon = null; return null; }
    viaDaemon = via.sock;
    return daemonUpstream(via, () => d.status());
  }

  async function resolveSession(): Promise<Upstream> {
    if (own) return own.up;
    const via = await viaDaemonOr();
    if (via) return via;
    let b: OwnBridge;
    try {
      b = await bind(true);
    } catch (e) {
      throw gone && errMsg(e) === RELEASED ? new Error("the MCP client went away before the bridge was up") : e;
    }
    const mine = hold(b);
    publish(b, mine.close, 0, false).then(
      (h) => {
        // Gone (or this bridge stopped) while the socket was binding: take it down again at once.
        if (own !== mine || done) { h.shutdown(); return; }
        served = h;
      },
      (e) => log("not sharing the bridge with other sessions: " + errMsg(e)),
    );
    return mine.up;
  }

  async function resolveOneShot(): Promise<Upstream> {
    return (await viaDaemonOr()) ?? hold(await bind(false)).up;
  }

  async function resolveServe(): Promise<Upstream> {
    // The already-running probe FIRST: binding with a daemon already up is an EADDRINUSE exit naming "another dtwin
    // bridge" — the right answer is the daemon's own refusal, which names --stop. serve() probes again right before
    // listening (the race is handled there). No saved token yet (Windows, first run): nothing can be serving a pipe
    // named from a token nobody saved, and the bridge saves the one it mints — the socket is then named from it.
    try { await side().assertNoDaemon(); } catch (e) { if (errMsg(e) !== daemon.NO_DAEMON_TOKEN) throw e; }
    if (done) throw new Error(RELEASED);
    const b = await bind(false);
    const mine = hold(b);
    let h: ServeHandle;
    try {
      h = await publish(b, mine.close, settings.idleMs, true);
    } catch (e) {
      // Another daemon won the race to the socket: this bridge serves nobody. Let it go without "the daemon shut down".
      own = null;
      b.close();
      throw e;
    }
    // Released while the socket was binding: release() closed the bridge (hold()'s close); take the socket down too.
    if (done) { h.shutdown(); throw new Error(RELEASED); }
    served = h;
    return mine.up;
  }

  const resolveFor = { "one-shot": resolveOneShot, serve: resolveServe, session: resolveSession }[lifetime];

  function release(why?: string): void {
    if (done) return;
    if (why) log(why);
    // finish() first: the shutdown below closes the bridge through hold()'s close, which must not log a second reason.
    finish(why ?? "released");
    const s = served;
    served = null;
    const o = own;
    if (s) s.shutdown(); // aborts its forwarded requests, unlinks the socket, closes the bridge (hold()'s close)
    if (o) o.close();
  }

  function clientLeft(how: string): void {
    if (lifetime !== "session" || gone || done) return;
    gone = true;
    const s = served;
    if (!own || !s) return release(`the MCP client went away (${how}) — exiting`);
    const a = s.activity();
    if (a.frames === 0) return release(`the MCP client went away (${how}) and no other dtwin command or session used the shared bridge — closing it and exiting`);
    const ms = settings.idleMs;
    // Already quiet for the whole window (and nothing in flight): idleOut's check-at-once would shut it down right
    // away, so say that instead of "still serving".
    if (ms && a.inFlight === 0 && Date.now() - a.lastActivity >= ms) {
      return release(`the MCP client went away (${how}); other dtwin commands/sessions used this shared bridge (${a.frames} request(s)), but none in the last ${humanMs(ms)} (FIGMA_DAEMON_IDLE_MIN) — closing it and exiting`);
    }
    const used = `other dtwin commands/sessions use this shared bridge (${a.frames} request(s) so far)`;
    log(ms
      ? `the MCP client went away (${how}); ${used} — still serving it, shutting down after ${humanMs(ms)} without one (FIGMA_DAEMON_IDLE_MIN)`
      : `the MCP client went away (${how}); ${used} — still serving it, and it never shuts down on its own (${idleOffWhy(settings.idleRaw)}) — stop it with dtwin stop`);
    // Its shutdown closes the bridge through hold()'s close, which releases.
    s.idleOut(ms);
  }

  return {
    upstream() {
      if (done) return Promise.reject(new Error(RELEASED));
      // One resolution shared by every caller while it is in flight, so concurrent first calls never both bind.
      // one-shot and serve keep it for good. A session keeps it only while it holds the bridge (hold()'s close drops
      // it): a daemon route or a failure is re-resolved on the next call — that owner may have gone since.
      if (lifetime !== "session") return (resolving ??= resolveFor());
      if (own) return Promise.resolve(own.up);
      return (resolving ??= resolveFor().finally(() => { if (!own) resolving = null; }));
    },
    clientLeft,
    release,
    released,
    held(): Held {
      if (own) return { kind: "own", port: own.bridge.port, sock: served?.sock ?? null };
      return viaDaemon ? { kind: "daemon", sock: viaDaemon } : { kind: "none" };
    },
  };
}

// Why the idle window is 0: the variable says 0, or it is not a usable number of minutes (idleMsFromEnv turns an
// unparsable or negative value into 0 = off, as it always has) — name which, with the raw value.
function idleOffWhy(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v !== "" && Number(v) === 0
    ? `FIGMA_DAEMON_IDLE_MIN=${v}`
    : `FIGMA_DAEMON_IDLE_MIN=${JSON.stringify(raw ?? "")} is not a number of minutes above 0, which turns the idle shutdown off`;
}
