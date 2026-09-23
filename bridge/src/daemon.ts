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
import type { ClientRow, ConnectionInfo, RequestArgs } from "./server-core.ts";

// ---- the daemon socket protocol (newline-delimited JSON, one request -> one reply per connection)

/** A request frame: a bridge command to forward, or one of the daemon's own `__ping`/`__status`/`__shutdown`. */
export interface DaemonRequest {
  cmd: string;
  args?: RequestArgs;
  timeoutMs?: number;
  /** routing target, forwarded verbatim to the bridge (connId / fileKey / file-name substring) */
  client?: string | null;
  /** ms to wait for a plugin to connect before sending */
  waitForConnection?: number;
}

/** A reply frame. */
interface DaemonReply {
  ok: boolean;
  result?: unknown;
  error?: string;
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

/** What serve() drives: the bridge shape (server-core's createBridge() result, or the test suite's fake). */
export interface DaemonBridge {
  port: number;
  isConnected(): boolean;
  waitForConnection(timeoutMs: number): Promise<void>;
  request(cmd: string, args: RequestArgs | undefined, timeoutMs: number | undefined, target: string | null | undefined): Promise<unknown>;
  close(): void;
  listClients?: () => ClientRow[];
  connectionInfo?: () => ConnectionInfo;
}

export interface ServeOptions {
  port?: number;
  log?: (m: string) => void;
  idleMin?: number;
  signals?: boolean;
}

/** connect()'s answer when a daemon is live: its socket, and a request function bound to it. */
export interface DaemonConnection {
  sock: string;
  request: (msg: DaemonRequest, timeoutMs?: number) => Promise<unknown>;
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

// Requests are SERIALIZED, not multiplexed. server-core's `pending` map is id-keyed and would happily
// interleave them, but the plugin is single-threaded and its heavy commands mutate shared per-run
// state (serializeRun in bridge.ts) — two concurrent exports interleave badly. One queue here means
// the daemon behaves exactly like a sequence of one-shot CLI runs, which is the behaviour every
// existing caller was written against.
export function serve(bridge: DaemonBridge, { port, log, idleMin, signals = true }: ServeOptions = {}): Promise<{ sock: string; shutdown: () => void }> {
  const sock = sockPath(port);
  // A socket file left by a crashed daemon is NOT a running daemon. Probing it first (rather than
  // unlinking unconditionally) is what keeps `--serve` from silently stealing a live daemon's socket.
  return probe(sock).then((alive) => {
    if (alive) throw new Error(`a dtwin daemon is already running on ${sock} — stop it with --stop`);
    try { fs.unlinkSync(sock); } catch (e) { /* nothing to clean up */ }

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
      conn.on("data", framer(async (line) => {
        touch(); // any client contact counts as activity, including the probe
        let msg: DaemonRequest;
        try { msg = JSON.parse(line) as DaemonRequest; } catch (e) { return reply(conn, { ok: false, error: "bad request frame: " + errMsg(e) }); }
        if (msg.cmd === "__ping") return reply(conn, { ok: true, result: { daemon: true, pid: process.pid, port: bridge.port } });
        if (msg.cmd === "__status") {
          return reply(conn, {
            ok: true,
            result: {
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
            },
          });
        }
        if (msg.cmd === "__shutdown") {
          reply(conn, { ok: true, result: { stopped: true } });
          return shutdown();
        }
        // Chain onto the queue so requests run one at a time, in arrival order.
        inFlight++; // counted OUTSIDE the queue: work that is queued but not yet started still
                    // counts as activity, so a backlog can't be reaped as idleness.
        queue = queue.then(async () => {
          try {
            if (msg.waitForConnection && !bridge.isConnected()) await bridge.waitForConnection(msg.waitForConnection);
            // msg.client is the routing target (connId / fileKey / file-name substring). Forwarded
            // verbatim: the bridge owns the matching rules, so the daemon never has to know them.
            const result = await bridge.request(msg.cmd, msg.args, msg.timeoutMs, msg.client);
            reply(conn, { ok: true, result });
          } catch (e) {
            reply(conn, { ok: false, error: errMsg(e) });
          } finally {
            inFlight--;
            touch(); // the idle clock starts when work FINISHES, not when it was requested
          }
        });
      }));
    });

    function shutdown() {
      if (idleTimer) clearInterval(idleTimer);
      try { server.close(); } catch (e) {}
      try { fs.unlinkSync(sock); } catch (e) {}
      bridge.close();
      if (log) log("daemon stopped.");
    }
    // Ctrl-C / kill must remove the socket file, or the next --serve refuses to start against a
    // socket nobody is listening on.
    if (signals) for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { shutdown(); process.exit(0); });
    // A host that exits some other way (the MCP server ends when its stdio closes) still must not
    // leave the socket file behind for the next probe to trip over.
    else process.on("exit", () => { try { fs.unlinkSync(sock); } catch (e) {} });

    return new Promise<{ sock: string; shutdown: () => void }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sock, () => {
        if (log) log(`daemon listening on ${sock} (pid ${process.pid}) — stop it with: dtwin --stop`);
        resolve({ sock, shutdown });
      });
    });
  });
}

function reply(conn: net.Socket, obj: DaemonReply): void {
  try { conn.write(JSON.stringify(obj) + "\n"); } catch (e) { /* client went away mid-reply */ }
}

// ---------------------------------------------------------------- client

// Is there a LIVE daemon? A stale socket file (crashed daemon) answers ECONNREFUSED, and must read as
// "no daemon" rather than hanging or erroring — otherwise one crash makes every later CLI run fail.
export function probe(sock: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    let c: net.Socket;
    try { c = net.createConnection(sock); } catch (e) { return finish(false); }
    const t = setTimeout(() => { try { c.destroy(); } catch (e) {} finish(false); }, timeoutMs);
    c.on("error", () => { clearTimeout(t); finish(false); });
    c.setEncoding("utf8");
    c.on("data", framer(() => { clearTimeout(t); try { c.end(); } catch (e) {} finish(true); }));
    c.on("connect", () => { try { c.write(JSON.stringify({ cmd: "__ping" }) + "\n"); } catch (e) { finish(false); } });
  });
}

// One request through a running daemon. Rejects (rather than falling back) once connected: a daemon
// that answered __ping and then failed is a real error the caller should see, not a reason to
// silently open a second bridge that would then hit EADDRINUSE against the daemon itself.
function request(sock: string, msg: DaemonRequest, timeoutMs?: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const c = net.createConnection(sock);
    c.setEncoding("utf8");
    let settled = false;
    const done = <V>(fn: (v: V) => void, v: V) => { if (!settled) { settled = true; try { c.end(); } catch (e) {} fn(v); } };
    // The daemon's own per-command budget still applies; this is the outer guard for a daemon that
    // stopped answering entirely. Generous by design — an --all-pages export legitimately runs long.
    const t = timeoutMs ? setTimeout(() => done(reject, new Error("daemon did not respond within " + Math.round(timeoutMs / 1000) + "s")), timeoutMs) : null;
    c.on("error", (e) => { if (t) clearTimeout(t); done(reject, e); });
    c.on("close", () => { if (t) clearTimeout(t); done(reject, new Error("daemon closed the connection before replying")); });
    c.on("data", framer((line) => {
      if (t) clearTimeout(t);
      let r: DaemonReply;
      try { r = JSON.parse(line) as DaemonReply; } catch (e) { return done(reject, new Error("bad reply frame: " + errMsg(e))); }
      if (r.ok) done(resolve, r.result);
      else done(reject, new Error(r.error));
    }));
    c.on("connect", () => c.write(JSON.stringify(msg) + "\n"));
  });
}

// The routing decision every CLI command makes: use the daemon if one is live, otherwise report that
// there isn't one and let the caller open its own bridge exactly as before.
export async function connect(port?: number): Promise<DaemonConnection | null> {
  const sock = sockPath(port);
  return (await probe(sock)) ? { sock, request: (msg, timeoutMs) => request(sock, msg, timeoutMs) } : null;
}

export async function stop(port?: number): Promise<boolean> {
  const sock = sockPath(port);
  if (!(await probe(sock))) return false;
  await request(sock, { cmd: "__shutdown" }, 5000);
  return true;
}

export async function status(port?: number): Promise<DaemonStatus | null> {
  const sock = sockPath(port);
  if (!(await probe(sock))) return null;
  // The daemon's own __status reply, taken as the shape above (a daemon from an OLDER bridge may omit
  // newer row fields — see staleness.ts daemonRowStalenessNote).
  return (await request(sock, { cmd: "__status" }, 5000)) as DaemonStatus;
}

