// served-session.ts — the daemon's served session, apart from its socket: what a frame from a client is, what the
// daemon answers, and the session's own lifetime around the bridge it serves (DaemonBridge).
//
// daemon.ts serve() is the adapter around it: the net.Server, the listen race and takeover of a stale socket file, the
// handshake (daemon-auth.ts) and the process's signals and crash hooks. Each accepted connection becomes one
// `connect(write)` here, fed the connection's lines; everything after that is this module's, on a Clock (clock.ts), so
// the suites drive it with a fake one (test/served-session.test.ts) instead of sockets and wall-clock sleeps:
//
//   FRAMES    every line from a client is activity, and counted (`activity().frames`: a host reads it to decide whether
//             OTHER processes use the socket — bridge-holder.ts). A line that is not a well-formed request frame is
//             answered "bad request frame: …", never forwarded.
//   CONTROL   `__ping` / `__status` / `__shutdown` are answered here, never forwarded.
//   FORWARD   every other request goes to the bridge AS IT ARRIVES (the note above createServedSession), with progress
//             frames ahead of the reply for a client that asked.
//   IDLE      a daemon outlives the terminal that started it, so a quiet one shuts itself down (see armIdle).
//   CANCEL    a client that leaves before its reply aborts its own requests' signals — a sent one gets the plugin a
//             cancel frame (server-core), a waiting one is never sent — and shutdown() aborts every one.
//   SHUTDOWN  once, in order: the transport lets go (`release`), the requests are aborted, the bridge closes. A frame
//             after it is refused.

import { errMsg } from "./errmsg.ts";
import { ifDefined, isRecord } from "./json-util.ts";
import { isCmd } from "./commands.ts";
import type { Cmd, Commands } from "./commands.ts";
import { humanMs } from "./human-ms.ts";
import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import type { ClientRow, ConnectionInfo, ProgressTick } from "./server-core.ts";
import type { Sent, UpstreamRequest } from "./route.ts";

// ---- the daemon socket protocol (newline-delimited JSON, one request -> one reply per connection)
//
// Progress (opt-in). A command frame that carries `progress: true` may be answered with any number of
// PROGRESS frames `{ id?, progress: ProgressTick }` before its one reply frame `{ ok, id?, … }` — the
// plugin's ticks as server-core hands them to the bridge request's `onProgress` listener. A progress
// frame has NO `ok` field, so it can never be mistaken for a reply; and it is only ever sent to a
// client that asked, because a client from before this field reads every frame as the reply and would
// reject a progress frame ("bad reply frame: not a daemon reply"). A daemon from before this field
// ignores `progress: true` and never sends one; the client (daemon.ts) copes (it simply sees the reply).
// Why: an MCP export routed through a daemon owes its caller notifications/progress (MCP spec
// 2025-06-18, basic/utilities/progress) exactly as one that holds the bridge does.

/** A bridge command to forward, typed per command from commands.ts (`switch (msg.cmd)` narrows `args`). */
export type DaemonCommandRequest<C extends Cmd = Cmd> = {
  [K in C]: {
    /** optional correlation id, echoed back on the reply */
    id?: string;
    cmd: K;
    args?: Commands[K]["args"];
    timeoutMs?: number;
    /** routing target, forwarded verbatim to the bridge (connId / fileKey / file-name substring) */
    client?: string | null;
    /** ms to wait for a plugin to connect before sending */
    waitForConnection?: number;
    /** opt in to progress frames before the reply (the protocol note above). Set by the client when
     *  the caller passes an `onProgress` listener — never needed by hand. */
    progress?: boolean;
  };
}[C];

/** One of the daemon's own commands — answered here, never forwarded. */
export interface DaemonControlRequest {
  id?: string;
  cmd: "__ping" | "__status" | "__shutdown";
}

/** A request frame: a bridge command to forward, or one of the daemon's own `__ping`/`__status`/`__shutdown`. */
export type DaemonRequest = DaemonCommandRequest | DaemonControlRequest;

/** The daemon's own command names (a client sends them without `progress`). */
export const CONTROL: ReadonlySet<string> = new Set<string>(["__ping", "__status", "__shutdown"]);
const isControl = (m: DaemonRequest): m is DaemonControlRequest => CONTROL.has(m.cmd);

/** Why `x` is not a well-formed request frame, or null when it is one. A `{}` frame would be forwarded
 *  with `cmd: undefined`, and `timeoutMs: "x"` would reach setTimeout as NaN. Both are refused here. */
export function daemonRequestError(x: unknown): string | null {
  if (!isRecord(x)) return "not an object";
  if (typeof x.cmd !== "string") return "`cmd` is missing";
  if (x.id !== undefined && typeof x.id !== "string") return "`id` is not a string";
  if (CONTROL.has(x.cmd)) return null;
  if (!isCmd(x.cmd)) return `unknown cmd '${x.cmd}'`;
  if (x.args !== undefined && !isRecord(x.args)) return "`args` is not an object";
  if (x.timeoutMs !== undefined && !(typeof x.timeoutMs === "number" && Number.isFinite(x.timeoutMs) && x.timeoutMs > 0)) return "`timeoutMs` is not a positive number";
  if (x.client !== undefined && x.client !== null && typeof x.client !== "string") return "`client` is not a string";
  if (x.waitForConnection !== undefined && !(typeof x.waitForConnection === "number" && Number.isFinite(x.waitForConnection) && x.waitForConnection >= 0)) return "`waitForConnection` is not a number";
  if (x.progress !== undefined && typeof x.progress !== "boolean") return "`progress` is not a boolean";
  return null;
}

export function isDaemonRequest(x: unknown): x is DaemonRequest {
  return daemonRequestError(x) === null;
}

/** A reply frame. `client` (on a forwarded command's success) is the connected file the bridge used —
 *  absent from a daemon older than this field. */
export type DaemonReply =
  | { ok: true; id?: string; result: unknown; client?: ClientRow }
  | { ok: false; id?: string; error: string };

/** A progress frame: one plugin tick, relayed while request `id` is in flight (opt-in, see above). */
export type DaemonProgressFrame = { id?: string; progress: ProgressTick };

/** What the session writes to one client: replies, and progress frames ahead of a reply. */
export type SessionFrame = DaemonReply | DaemonProgressFrame;

/** `__status`'s result — what `dtwin --daemon-status`, doctor and `list clients` read. */
export interface DaemonStatus {
  daemon: true;
  pid: number;
  port: number;
  pluginConnected: boolean;
  clients: ClientRow[];
  connection: ConnectionInfo | null;
  idleMs: number | null;
  idleForMs: number;
}

/** What a session serves: a bridge this process holds (route.ts servedBridge builds one from server-core's
 *  createBridge() result; the test suites pass fakes). `request` is the own adapter's (route.ts Upstream):
 *  the frame's fields as they arrived — `target` its `client`, `waitMs` its `waitForConnection` (the bridge
 *  waits that long for the target first, server-core awaitClient), `onProgress` receives every tick the
 *  chosen connection sends while the request is in flight (the source of progress frames), and `signal` is
 *  aborted when the session's client leaves (or the session shuts down) before the reply — server-core
 *  then sends the plugin a cancel frame for the request. It answers WHICH client the command went to (null
 *  when a fake does not say). The session never passes `stallMs`. `isConnected`, `listClients` and
 *  `connectionInfo` are read synchronously, for `__status`. */
export interface DaemonBridge {
  port: number;
  isConnected(): boolean;
  // Method syntax, and `args` as the frame carries it (absent is forwarded as absent, as it always was).
  request<C extends Cmd>(cmd: C, args: Commands[C]["args"] | undefined, o: UpstreamRequest): Promise<Sent<C>>;
  close(): void;
  listClients?: () => ClientRow[];
  connectionInfo?: () => ConnectionInfo;
}

/** What the session has seen so far — read by a host that has to decide whether OTHER processes use it
 *  (bridge-holder.ts, after its own client went away). `frames` counts every frame received since the session
 *  started, control frames (`__ping`/`__status`) included; `inFlight` is forwarded requests not yet answered;
 *  `idleForMs` is how long since the last frame or finished request. */
export interface DaemonActivity { frames: number; inFlight: number; idleForMs: number }

/** One client connection, as the session sees it: the lines it sent, one at a time, and its leaving (close, end or
 *  error — any of them, any number of times). */
export interface SessionClient {
  line(text: string): void;
  leave(): void;
}

export interface ServedSessionOptions {
  /** the idle window in ms (0 = none); `idleOut` changes it later */
  idleMs: number;
  /** what the idle clock and its check run on (systemClock when absent) */
  clock?: Clock;
  log?: (m: string) => void;
  /** the process id `__ping` / `__status` report (process.pid when absent) */
  pid?: number;
  /** the transport letting go, run FIRST by shutdown(): stop listening, remove the socket file, drop the process hooks */
  release?: () => void;
}

// Requests are FORWARDED AS THEY ARRIVE, never ordered here. Which commands may run alongside which is a
// property of the command (commands.ts runKind), and the plugin's run scheduler enforces it for every caller
// (figma-plugin/src/state.ts scheduleRun) — this socket's clients, the MCP server that holds the bridge, and
// the plugin window's own buttons alike. A queue here could only see this socket's share of a file's runs, held
// one file's reads behind another file's export, and moved to the next request when an abandoned one's cancel
// was SENT, while the plugin was still unwinding it. The plugin's own chain moves when the run has ENDED.

export function createServedSession(bridge: DaemonBridge, o: ServedSessionOptions) {
  const clock = o.clock ?? systemClock;
  const log = o.log;
  const pid = o.pid ?? process.pid;
  let stopped = false;
  let idleMs = o.idleMs;
  let lastActivity = clock.now();
  let inFlight = 0;
  let frames = 0;
  const touch = (): void => { lastActivity = clock.now(); };

  // Idle shutdown. A daemon outlives the terminal that started it, so without this an orphan holds
  // port 8787 until someone remembers --stop — and the next thing to want the bridge (a pull, or
  // the MCP server) fails with EADDRINUSE pointing at a process the user forgot about.
  //
  // Deliberately generous: this exists to reap ABANDONED daemons, not to punish thinking time. The
  // clock resets on every frame and when a request finishes, and a request in flight holds it off entirely
  // (a 15-minute --all-pages export must never be shot in the back by its own daemon). 0 disables it.
  // `idleMs` 0 lets a host that has its OWN lifetime (the MCP server lives as long as its Claude
  // session) serve the socket without being reaped from under that session.
  // `idleOut` may change the window later: the bridge holder switches an MCP session's from 0
  // to the settings' window once its own client has gone and only others use the socket (bridge-holder.ts).
  let stopIdle: (() => void) | null = null;
  const check = (): void => {
    if (stopped || !idleMs) return;
    if (inFlight === 0 && clock.now() - lastActivity >= idleMs) {
      if (log) log(`idle for ${humanMs(idleMs)} — shutting down (set FIGMA_DAEMON_IDLE_MIN=0 to disable).`);
      shutdown();
    }
  };
  const armIdle = (ms: number): void => {
    if (stopIdle) stopIdle();
    stopIdle = null;
    idleMs = ms;
    if (!ms || stopped) return;
    // Checked on a fixed beat rather than a deadline re-armed around every frame: one timer, and `inFlight` is
    // consulted at check time instead of having to cancel/re-arm around every request. Never coarser than the
    // window itself, so a short window (a test's, or the MCP server's after its client left) is honoured.
    // unref: the idle CHECK must not be the thing keeping the process alive — the socket server and
    // the WS server are. Otherwise a daemon whose servers closed would linger for the beat.
    const every = Math.min(30000, ms);
    const beat = (): void => { stopIdle = clock.after(every, beat, { unref: true }); check(); };
    stopIdle = clock.after(every, beat, { unref: true });
  };
  armIdle(idleMs);

  // CANCEL: every forwarded request, waiting for its client or in flight, has an AbortController here AND in its
  // client's own set (connect below). shutdown() aborts all of them; a client that leaves, its own.
  const outstanding = new Set<AbortController>();

  /** `__status`, as of now. Guarded because `bridge` is any object with the bridge shape (the test suites pass
   *  minimal fakes): a status call must never be the thing that kills the daemon. */
  function status(): DaemonStatus {
    return {
      daemon: true, pid, port: bridge.port, pluginConnected: bridge.isConnected(),
      // The daemon owns the bridge, so it is the only side that can see WHICH files are
      // connected — a CLI process routing through it has no socket of its own to ask.
      clients: typeof bridge.listClients === "function" ? bridge.listClients() : [],
      // The socket stats too. `dtwin whoami` documents "socket uptime, and how many times a
      // new connection displaced an earlier one", but with a daemon in front the CLI has no
      // bridge of its own to read it from, so it could only tell the reader to run a different
      // command. The daemon has it. One extra field and the documented output is real.
      connection: typeof bridge.connectionInfo === "function" ? bridge.connectionInfo() : null,
      // Reported in ms, not rounded minutes: a sub-minute window (used by the tests, and a
      // legitimate choice) rounded to "0" reads as "disabled", which is the opposite of true.
      idleMs: idleMs || null,
      idleForMs: clock.now() - lastActivity,
    };
  }

  /** One client connection. `write` sends one frame to it (and must not throw: a client that went away mid-reply is
   *  the transport's to swallow). */
  function connect(write: (frame: SessionFrame) => void): SessionClient {
    const mine = new Set<AbortController>();
    const leave = (): void => {
      for (const ac of mine) ac.abort(new Error("the daemon's client disconnected before the reply"));
      mine.clear();
    };

    // The daemon's own three commands — answered here, never forwarded to the bridge.
    function control(msg: DaemonControlRequest): void {
      if (msg.cmd === "__ping") return write({ ok: true, ...ifDefined("id", msg.id), result: { daemon: true, pid, port: bridge.port } });
      if (msg.cmd === "__status") return write({ ok: true, ...ifDefined("id", msg.id), result: status() });
      // "__shutdown"
      write({ ok: true, ...ifDefined("id", msg.id), result: { stopped: true } });
      shutdown();
    }

    function forward(msg: DaemonCommandRequest): void {
      inFlight++; // work in flight counts as activity, so a long export can't be reaped as idleness.
      const ac = new AbortController();
      mine.add(ac);
      outstanding.add(ac);
      // Never throws (every path ends in a reply). An abort before the send (the client left during the
      // connect wait) is the bridge's to honour: it rejects with the signal's reason and sends nothing.
      const run = async (): Promise<void> => {
        try {
          // msg.waitForConnection is the caller's connect window (route.ts: the CLI's own window, at least
          // NAMED_CLIENT_WAIT_MS for a named client): the bridge waits for the target first, a named
          // one capped at NAMED_CLIENT_WAIT_MS once a plugin is connected (server-core awaitClient), so
          // `--client <name>` does not fail on the first file that happened to reconnect after a Figma
          // restart. A window that runs out is not the error: the request then fails in the bridge's own
          // resolveClient ("Figma plugin not connected — …") —
          // the text every other path prints. A client that leaves during the wait ends it (ac.signal).
          // msg.client is the routing target (connId / fileKey / file-name substring). Forwarded
          // verbatim: the bridge owns the matching rules, so the daemon never has to know them.
          // The client the bridge picked rides back on the reply (a fake bridge that answers null
          // simply doesn't say).
          // Progress frames only for a client that opted in (`progress: true`) — an older client
          // reads every frame as the reply. Written to the same client ahead of the reply, so it
          // sees the ticks in the order they arrived, and all of them before the reply.
          const id = msg.id;
          const onProgress = msg.progress === true
            ? (tick: ProgressTick) => { write(id === undefined ? { progress: tick } : { id, progress: tick }); }
            : undefined;
          const r = await bridge.request(msg.cmd, msg.args, { timeoutMs: msg.timeoutMs, target: msg.client, onProgress, signal: ac.signal, waitMs: msg.waitForConnection });
          write({ ok: true, ...ifDefined("id", msg.id), result: r.reply, ...(r.client ? { client: r.client } : {}) });
        } catch (e) {
          write({ ok: false, ...ifDefined("id", msg.id), error: errMsg(e) });
        } finally {
          mine.delete(ac);
          outstanding.delete(ac);
          inFlight--;
          touch(); // the idle clock starts when work FINISHES, not when it was requested
        }
      };
      void run();
    }

    function line(text: string): void {
      touch(); // any client contact counts as activity, including the probe
      frames++; // …and is counted: every frame here comes from ANOTHER process (activity())
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch (e) { return write({ ok: false, error: "bad request frame: " + errMsg(e) }); }
      // The frame is checked BEFORE anything reads it: a `{}` would forward `cmd: undefined` to
      // the bridge, and a `timeoutMs: "x"` would reach setTimeout as NaN.
      const bad = daemonRequestError(parsed);
      if (bad !== null || !isDaemonRequest(parsed)) return write({ ok: false, error: "bad request frame: " + (bad ?? "malformed") });
      const msg = parsed;
      // A frame that lands after shutdown() (an idle shutdown, `dtwin stop`, the MCP host leaving) on a
      // connection opened before it: closing the server does not end live connections, and the bridge is
      // closed — refuse it here instead of forwarding it to a closed bridge.
      if (stopped) return write({ ok: false, ...ifDefined("id", msg.id), error: "the shared bridge daemon has shut down — run the command again (it starts or finds a bridge of its own)" });
      if (isControl(msg)) return control(msg);
      // Forwarded now: the plugin orders it against every other run in its file (see the note above).
      forward(msg);
    }

    return { line, leave };
  }

  // Idempotent: the idle check, `__shutdown`, a signal and a host's own shutdown can all race.
  function shutdown(): void {
    if (stopped) return;
    stopped = true;
    if (stopIdle) stopIdle();
    stopIdle = null;
    if (o.release) o.release();
    // Abort every outstanding request BEFORE the bridge closes. This fires first: each in-flight
    // abort makes server-core send its cancel frame and drop the request from its pending table, so
    // bridge.close() below finds nothing left to cancel for it (were one sent twice, the plugin
    // ignores the second). The reason keeps the text a caller saw before: "bridge closed".
    for (const ac of outstanding) ac.abort(new Error("bridge closed"));
    outstanding.clear();
    bridge.close();
    if (log) log("daemon stopped.");
  }

  return {
    connect, status, shutdown,
    activity: (): DaemonActivity => ({ frames, inFlight, idleForMs: clock.now() - lastActivity }),
    /** (Re)arms the idle shutdown with a window of `ms` (0 disarms it), and checks once AT ONCE: a session already
     *  quiet that long (and with nothing in flight) shuts down now. */
    idleOut(ms: number): void { armIdle(Math.max(0, ms) || 0); check(); },
    get stopped(): boolean { return stopped; },
  };
}

export type ServedSession = ReturnType<typeof createServedSession>;
