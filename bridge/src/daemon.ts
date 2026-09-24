// daemon.ts — hold the bridge open across many CLI invocations.
//
// WHY this shape. A one-shot `figma-pull` pays a full plugin reconnect every run, and only one
// process can hold port 8787 (server-core.ts exits on EADDRINUSE), so back-to-back pulls are both
// slow and mutually exclusive. The obvious fix — "a flag that opens the connection and leaves it
// open" — does NOT work on its own: a long-running CLI has no way to receive further commands, so it
// would occupy the port while being unreachable, blocking the MCP server and every other CLI call.
//
// So: ONE long-lived process owns the bridge (`--serve`), and every other invocation becomes a thin
// client that forwards its request over a unix socket and exits. Existing commands route through the
// daemon automatically when one is running, and fall back to opening their own bridge when it isn't —
// so nothing about the current usage changes, it just gets faster when a daemon is up.
//
// A unix socket, not a second TCP port: it gets filesystem permissions for free (no verifyClient
// equivalent to write), and it cannot be reached from a browser tab the way a loopback port can.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { errMsg } from "./errmsg.ts";
import { NAMED_CLIENT_WAIT_MS } from "./timeouts.ts";
import { isCmd, replyShapeError } from "./commands.ts";
import type { Cmd, Commands } from "./commands.ts";
import type { ClientRow, ConnectionInfo } from "./server-core.ts";

// ---- the daemon socket protocol (newline-delimited JSON, one request -> one reply per connection)

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
  };
}[C];

/** One of the daemon's own commands — answered here, never forwarded. */
export interface DaemonControlRequest {
  id?: string;
  cmd: "__ping" | "__status" | "__shutdown";
}

/** A request frame: a bridge command to forward, or one of the daemon's own `__ping`/`__status`/`__shutdown`. */
export type DaemonRequest = DaemonCommandRequest | DaemonControlRequest;

const CONTROL = new Set<string>(["__ping", "__status", "__shutdown"]);
const isControl = (m: DaemonRequest): m is DaemonControlRequest => CONTROL.has(m.cmd);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** A client row as relayed over the socket: the one field routing needs (`connId`) is checked, the rest
 *  is read as the bridge's own describe() wrote it. */
function isClientRow(x: unknown): x is ClientRow {
  return isRecord(x) && typeof x.connId === "string";
}

/** Why `x` is not a well-formed request frame, or null when it is one. A `{}` frame used to be forwarded
 *  with `cmd: undefined`; `timeoutMs: "x"` reached setTimeout as NaN. Both are refused here instead. */
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
  return null;
}

export function isDaemonRequest(x: unknown): x is DaemonRequest {
  return daemonRequestError(x) === null;
}

/** A reply frame. `client` (on a forwarded command's success) is the connected file the bridge used —
 *  absent from a daemon older than this field. */
type DaemonReply =
  | { ok: true; id?: string; result: unknown; client?: ClientRow }
  | { ok: false; id?: string; error: string };

function parseDaemonReply(x: unknown): DaemonReply | null {
  if (!isRecord(x)) return null;
  if (x.ok === true) return { ok: true, result: x.result, client: isClientRow(x.client) ? x.client : undefined };
  if (x.ok === false) return { ok: false, error: typeof x.error === "string" ? x.error : "daemon error" };
  return null;
}

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

/** What status() hands back: `daemon: true` is the one field every daemon has sent; a daemon from an
 *  OLDER bridge may omit the newer ones (see staleness.ts daemonRowStalenessNote), so the rest is Partial. */
export type DaemonStatusView = Partial<DaemonStatus> & { daemon: true };

function isDaemonStatus(x: unknown): x is DaemonStatusView {
  return isRecord(x) && x.daemon === true;
}

/** What serve() drives: the bridge shape (server-core's createBridge() result, or the test suite's fake). */
export interface DaemonBridge {
  port: number;
  isConnected(): boolean;
  waitForConnection(timeoutMs: number): Promise<void>;
  request(cmd: Cmd, args: Commands[Cmd]["args"] | undefined, timeoutMs: number | undefined, target: string | null | undefined): Promise<unknown>;
  /** The same, also naming the client the command went to (server-core has it; a fake may not). */
  requestWithClient?(cmd: Cmd, args: Commands[Cmd]["args"] | undefined, timeoutMs: number | undefined, target: string | null | undefined): Promise<{ reply: unknown; client: ClientRow }>;
  /** Waits (bounded) for a named target to match a live client; never throws (server-core has it; a fake may not). */
  waitForClient?(target: string, timeoutMs: number): Promise<void>;
  close(): void;
  listClients?: () => ClientRow[];
  connectionInfo?: () => ConnectionInfo;
}

export interface ServeOptions {
  port?: number;
  log?: (m: string) => void;
  idleMin?: number;
  signals?: boolean;
  /** Install installCrashHandlers for this process. Defaults to `signals`: a serve() that owns the
   *  process's signals owns its lifetime too (`dtwin serve`); a host with its own lifetime (the MCP
   *  server passes signals:false) installs its own, and an in-process test passes false. */
  crashHandlers?: boolean;
}

/** connect()'s answer when a daemon is live: its socket, and request functions bound to it. */
export interface DaemonConnection {
  sock: string;
  request<C extends Cmd>(msg: DaemonCommandRequest<C>, timeoutMs?: number): Promise<Commands[C]["reply"]>;
  /** As request(), plus the connected file the daemon's bridge used (null from an older daemon). */
  requestWithClient<C extends Cmd>(msg: DaemonCommandRequest<C>, timeoutMs?: number): Promise<{ reply: Commands[C]["reply"]; client: ClientRow | null }>;
}

// Keyed by PORT so two bridges on different ports get two daemons rather than fighting over one
// socket. Under the user's own tmpdir, which is already 0700 on the platforms this runs on.
export function sockPath(port?: number): string {
  return path.join(os.tmpdir(), `designtwin-${port || process.env.FIGMA_BRIDGE_PORT || 8787}.sock`);
}

// Newline-delimited JSON. JSON.stringify escapes literal newlines, so a bare "\n" is an unambiguous
// frame terminator even for a 24MB export — but the frame can arrive in many chunks, so callers must
// buffer until they see one. Both sides use this to avoid two subtly different reassembly loops.
export function framer(onFrame: (line: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onFrame(line);
    }
  };
}

// ---------------------------------------------------------------- server

/** The refusal `--serve` gives when a daemon already holds this socket. ONE spelling: figma-pull.ts
 *  asks before it opens a bridge of its own, and serve() asks again right before listening. */
export function alreadyRunning(sock: string): Error {
  return new Error(`a dtwin daemon is already running on ${sock} — stop it with --stop`);
}

/** The socket path for `port` — or a throw if a LIVE daemon already answers on it. */
export async function assertNoDaemon(port?: number): Promise<string> {
  const sock = sockPath(port);
  // A socket file left by a crashed daemon is NOT a running daemon. Probing it first (rather than
  // unlinking unconditionally) is what keeps `--serve` from silently stealing a live daemon's socket.
  if (await probe(sock)) throw alreadyRunning(sock);
  return sock;
}

// The `exit` hook that removes the socket file when a `signals: false` host (the MCP server) goes
// away. Registered ONCE per process, over a set of live socket paths: figma-mcp re-serves after every
// `dtwin stop`, and a listener per serve() call would pile up (and warn) over a long session.
const exitUnlink = new Set<string>();
let exitHooked = false;
function unlinkOnExit(sock: string): () => void {
  exitUnlink.add(sock);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => { for (const s of exitUnlink) { try { fs.unlinkSync(s); } catch { /* already gone */ } } });
  }
  return () => { exitUnlink.delete(sock); };
}

// Last-resort handlers for the LONG-LIVED processes only (the `dtwin serve` daemon, the MCP server) —
// never a one-shot CLI run, where Node's default (print the stack, exit non-zero) is already right.
// Both log ONE line through errMsg, so the cause reaches stderr the process's own log format.
//  - uncaughtException: log, run `cleanup` (synchronous only), then exit 1. The Node docs are explicit
//    that carrying on is unsafe: "The correct use of 'uncaughtException' is to perform synchronous
//    cleanup of allocated resources (e.g. file descriptors, handles, etc) before shutting down the
//    process. It is not safe to resume normal operation after 'uncaughtException'."
//  - unhandledRejection: log only. A stray rejected promise (a tool whose caller went away, a late
//    socket write) must not take down the user's whole stdio MCP session or a daemon mid-export with it.
// Installed at most once per process: figma-mcp re-serves after every `dtwin stop`.
let crashHandlersInstalled = false;
export function installCrashHandlers(log: (m: string) => void, cleanup?: () => void): void {
  if (crashHandlersInstalled) return;
  crashHandlersInstalled = true;
  process.on("unhandledRejection", (reason) => {
    log("unhandled promise rejection (continuing): " + errMsg(reason));
  });
  process.on("uncaughtException", (e) => {
    log("uncaught exception — exiting: " + errMsg(e));
    if (cleanup) { try { cleanup(); } catch { /* exiting anyway */ } }
    process.exit(1);
  });
}

// Requests are SERIALIZED, not multiplexed. server-core's `pending` map is id-keyed and would happily
// interleave them, but the plugin is single-threaded and its heavy commands mutate shared per-run
// state (serializeRun in bridge.ts) — two concurrent exports interleave badly. One queue here means
// the daemon behaves exactly like a sequence of one-shot CLI runs, which is the behaviour every
// existing caller was written against.
export function serve(bridge: DaemonBridge, { port, log, idleMin, signals = true, crashHandlers = signals }: ServeOptions = {}): Promise<{ sock: string; shutdown: () => void }> {
  return assertNoDaemon(port).then((sock) => {
    try { fs.unlinkSync(sock); } catch { /* nothing to clean up */ }

    // Idle shutdown. A daemon outlives the terminal that started it, so without this an orphan holds
    // port 8787 until someone remembers --stop — and the next thing to want the bridge (a pull, or
    // the MCP server) fails with EADDRINUSE pointing at a process the user forgot about.
    //
    // Deliberately generous: this exists to reap ABANDONED daemons, not to punish thinking time. The
    // clock resets on every request, and a request in flight holds it off entirely (a 15-minute
    // --all-pages export must never be shot in the back by its own daemon). 0 disables it.
    // `idleMin` lets a host that has its OWN lifetime (the MCP server lives as long as its Claude
    // session) serve the socket without being reaped from under that session.
    const idleMs = Math.max(0, Number(idleMin ?? process.env.FIGMA_DAEMON_IDLE_MIN ?? 120)) * 60000;
    let lastActivity = Date.now();
    let inFlight = 0;
    const touch = () => { lastActivity = Date.now(); };
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    if (idleMs) {
      // Checked on an interval rather than a rearmed timeout: one timer, and `inFlight` is consulted
      // at fire time instead of having to cancel/rearm around every request.
      idleTimer = setInterval(() => {
        if (inFlight === 0 && Date.now() - lastActivity >= idleMs) {
          const forHuman = idleMs >= 60000 ? `${Math.round(idleMs / 60000)} min` : `${Math.round(idleMs / 1000)}s`;
          if (log) log(`idle for ${forHuman} — shutting down (set FIGMA_DAEMON_IDLE_MIN=0 to disable).`);
          shutdown();
        }
      }, 30000);
      // unref: the idle CHECK must not be the thing keeping the process alive — the socket server and
      // the WS server are. Otherwise a daemon whose servers closed would linger for the interval.
      if (idleTimer.unref) idleTimer.unref();
    }

    let queue: Promise<void> = Promise.resolve();
    const server = net.createServer((conn) => {
      conn.setEncoding("utf8");
      // A client that dies mid-export must not take the daemon with it: the write below would emit
      // EPIPE on a dead socket, which is an unhandled 'error' event => process exit.
      conn.on("error", () => {});
      conn.on("data", framer((line) => {
        touch(); // any client contact counts as activity, including the probe
        let parsed: unknown;
        try { parsed = JSON.parse(line) as unknown; } catch (e) { return reply(conn, { ok: false, error: "bad request frame: " + errMsg(e) }); }
        // The frame is checked BEFORE anything reads it: a `{}` used to forward `cmd: undefined` to
        // the bridge, and a `timeoutMs: "x"` reached setTimeout as NaN.
        const bad = daemonRequestError(parsed);
        if (bad !== null || !isDaemonRequest(parsed)) return reply(conn, { ok: false, error: "bad request frame: " + (bad ?? "malformed") });
        const msg = parsed;
        if (isControl(msg)) return control(conn, msg);
        // Chain onto the queue so requests run one at a time, in arrival order.
        inFlight++; // counted OUTSIDE the queue: work that is queued but not yet started still
                    // counts as activity, so a backlog can't be reaped as idleness.
        queue = queue.then(async () => {
          try {
            if (msg.waitForConnection && !bridge.isConnected()) await bridge.waitForConnection(msg.waitForConnection);
            // A named client (not a c<N> connId) whose window has not redialled yet: same bounded wait
            // as the CLI's own bridge path (figma-pull.ts), so `--client <name>` under a daemon does
            // not fail on the first file that happened to reconnect after a Figma restart.
            if (msg.waitForConnection && typeof msg.client === "string" && msg.client && !/^c\d+$/.test(msg.client) && bridge.waitForClient) {
              await bridge.waitForClient(msg.client, Math.min(msg.waitForConnection, NAMED_CLIENT_WAIT_MS));
            }
            // msg.client is the routing target (connId / fileKey / file-name substring). Forwarded
            // verbatim: the bridge owns the matching rules, so the daemon never has to know them.
            // The client the bridge picked rides back on the reply (a fake bridge without
            // requestWithClient simply doesn't say).
            if (typeof bridge.requestWithClient === "function") {
              const o = await bridge.requestWithClient(msg.cmd, msg.args, msg.timeoutMs, msg.client);
              reply(conn, { ok: true, id: msg.id, result: o.reply, client: o.client });
            } else {
              const result = await bridge.request(msg.cmd, msg.args, msg.timeoutMs, msg.client);
              reply(conn, { ok: true, id: msg.id, result });
            }
          } catch (e) {
            reply(conn, { ok: false, id: msg.id, error: errMsg(e) });
          } finally {
            inFlight--;
            touch(); // the idle clock starts when work FINISHES, not when it was requested
          }
        });
      }));
    });

    // The daemon's own three commands — answered here, never forwarded to the bridge.
    function control(conn: net.Socket, msg: DaemonControlRequest): void {
      if (msg.cmd === "__ping") return reply(conn, { ok: true, id: msg.id, result: { daemon: true, pid: process.pid, port: bridge.port } });
      if (msg.cmd === "__status") {
        const result: DaemonStatus = {
          daemon: true, pid: process.pid, port: bridge.port, pluginConnected: bridge.isConnected(),
          // The daemon owns the bridge, so it is the only side that can see WHICH files are
          // connected — a CLI process routing through it has no socket of its own to ask.
          // Guarded because `bridge` here is any object with the bridge shape (the test suite
          // passes a minimal fake): a status call must never be the thing that kills the daemon.
          clients: typeof bridge.listClients === "function" ? bridge.listClients() : [],
          // The socket stats too. `dtwin whoami` documents "socket uptime, and how many times a
          // new connection displaced an earlier one" and then told the reader to go and run a
          // different command, because with a daemon in front the CLI has no bridge of its own
          // (live finding 14). The daemon does. One extra field and the documented output is real.
          connection: typeof bridge.connectionInfo === "function" ? bridge.connectionInfo() : null,
          // Reported in ms, not rounded minutes: a sub-minute window (used by the tests, and a
          // legitimate choice) rounded to "0" reads as "disabled", which is the opposite of true.
          idleMs: idleMs || null,
          idleForMs: Date.now() - lastActivity,
        };
        return reply(conn, { ok: true, id: msg.id, result });
      }
      // "__shutdown"
      reply(conn, { ok: true, id: msg.id, result: { stopped: true } });
      shutdown();
    }

    let forgetExit: (() => void) | null = null;
    function shutdown() {
      if (idleTimer) clearInterval(idleTimer);
      try { server.close(); } catch { /* already closed */ }
      try { fs.unlinkSync(sock); } catch { /* already gone */ }
      if (forgetExit) { forgetExit(); forgetExit = null; }
      bridge.close();
      if (log) log("daemon stopped.");
    }
    // Ctrl-C / kill must remove the socket file, or the next --serve refuses to start against a
    // socket nobody is listening on. `as const`: process.on's overload wants NodeJS.Signals, not string.
    if (signals) for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { shutdown(); process.exit(0); });
    // A host that exits some other way (the MCP server ends when its stdio closes) still must not
    // leave the socket file behind for the next probe to trip over. One process-level hook, and this
    // socket is forgotten again on shutdown (the MCP server re-serves after every `dtwin stop`).
    else forgetExit = unlinkOnExit(sock);
    // shutdown() is synchronous (closes the servers, unlinks the socket file), so it is exactly the
    // "synchronous cleanup" the Node docs allow an uncaughtException handler before it exits.
    if (crashHandlers) installCrashHandlers(log ?? ((m) => console.error("[dtwin] " + m)), shutdown);

    return new Promise<{ sock: string; shutdown: () => void }>((resolve, reject) => {
      const onListening = () => {
        if (log) log(`daemon listening on ${sock} (pid ${process.pid}) — stop it with: dtwin --stop`);
        resolve({ sock, shutdown });
      };
      // The probe-then-unlink-then-listen window is a race: another `--serve` can bind between our
      // probe and our listen. EADDRINUSE from listen() is that case — re-probe, and either refuse
      // (it is alive) or take over the stale file it left (it is not), exactly once.
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRINUSE") return reject(e);
        probe(sock).then((alive) => {
          if (alive) return reject(alreadyRunning(sock));
          try { fs.unlinkSync(sock); } catch { /* gone already */ }
          server.once("error", reject);
          server.listen(sock, onListening);
        }, reject);
      });
      server.listen(sock, onListening);
    });
  });
}

function reply(conn: net.Socket, obj: DaemonReply): void {
  try { conn.write(JSON.stringify(obj) + "\n"); } catch { /* client went away mid-reply */ }
}

// ---------------------------------------------------------------- client

// Is there a LIVE daemon? A stale socket file (crashed daemon) answers ECONNREFUSED, and must read as
// "no daemon" rather than hanging or erroring — otherwise one crash makes every later CLI run fail.
export function probe(sock: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    let c: net.Socket;
    try { c = net.createConnection(sock); } catch { return finish(false); }
    const t = setTimeout(() => { try { c.destroy(); } catch { /* already gone */ } finish(false); }, timeoutMs);
    c.on("error", () => { clearTimeout(t); finish(false); });
    c.setEncoding("utf8");
    c.on("data", framer(() => { clearTimeout(t); try { c.end(); } catch { /* already gone */ } finish(true); }));
    c.on("connect", () => { try { c.write(JSON.stringify({ cmd: "__ping" }) + "\n"); } catch { finish(false); } });
  });
}

// One request through a running daemon. Rejects (rather than falling back) once connected: a daemon
// that answered __ping and then failed is a real error the caller should see, not a reason to
// silently open a second bridge that would then hit EADDRINUSE against the daemon itself.
function request<C extends Cmd>(sock: string, msg: DaemonCommandRequest<C> | DaemonControlRequest, timeoutMs?: number): Promise<{ result: unknown; client: ClientRow | null }> {
  return new Promise<{ result: unknown; client: ClientRow | null }>((resolve, reject) => {
    const c = net.createConnection(sock);
    c.setEncoding("utf8");
    let settled = false;
    const done = <V>(fn: (v: V) => void, v: V) => { if (!settled) { settled = true; try { c.end(); } catch { /* already gone */ } fn(v); } };
    // The daemon's own per-command budget still applies; this is the outer guard for a daemon that
    // stopped answering entirely. Generous by design — an --all-pages export legitimately runs long.
    const t = timeoutMs ? setTimeout(() => done(reject, new Error("daemon did not respond within " + Math.round(timeoutMs / 1000) + "s")), timeoutMs) : null;
    c.on("error", (e) => { if (t) clearTimeout(t); done(reject, e); });
    c.on("close", () => { if (t) clearTimeout(t); done(reject, new Error("daemon closed the connection before replying")); });
    c.on("data", framer((line) => {
      if (t) clearTimeout(t);
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch (e) { return done(reject, new Error("bad reply frame: " + errMsg(e))); }
      const r = parseDaemonReply(parsed);
      if (!r) return done(reject, new Error("bad reply frame: not a daemon reply"));
      if (r.ok) done(resolve, { result: r.result, client: r.client ?? null });
      else done(reject, new Error(r.error));
    }));
    c.on("connect", () => c.write(JSON.stringify(msg) + "\n"));
  });
}

// The routing decision every CLI command makes: use the daemon if one is live, otherwise report that
// there isn't one and let the caller open its own bridge exactly as before.
export async function connect(port?: number): Promise<DaemonConnection | null> {
  const sock = sockPath(port);
  if (!(await probe(sock))) return null;
  // The daemon's reply to a forwarded command is the plugin's own reply. The daemon's bridge already
  // checked it against commands.ts on arrival, but that was another process (and possibly an older
  // build), so it is checked again here — which is what makes the typed reply below honest rather
  // than a guess about what came over the socket.
  const requestWithClient = async <C extends Cmd>(msg: DaemonCommandRequest<C>, timeoutMs?: number) => {
    const r = await request(sock, msg, timeoutMs);
    const bad = replyShapeError(msg.cmd, r.result);
    if (bad) throw new Error(`the daemon relayed an unexpected shape for ${msg.cmd}: ${bad}`);
    return { reply: r.result as Commands[C]["reply"], client: r.client };
  };
  return {
    sock,
    requestWithClient,
    request: async (msg, timeoutMs) => (await requestWithClient(msg, timeoutMs)).reply,
  };
}

export async function stop(port?: number): Promise<boolean> {
  const sock = sockPath(port);
  if (!(await probe(sock))) return false;
  await request(sock, { cmd: "__shutdown" }, 5000);
  return true;
}

export async function status(port?: number): Promise<DaemonStatusView | null> {
  const sock = sockPath(port);
  if (!(await probe(sock))) return null;
  // The daemon's own __status reply: `daemon: true` is checked, the rest is read as optional (a daemon
  // from an OLDER bridge may omit newer fields — see staleness.ts daemonRowStalenessNote).
  const { result } = await request(sock, { cmd: "__status" }, 5000);
  if (!isDaemonStatus(result)) throw new Error("the daemon answered __status with an unexpected shape");
  return result;
}
