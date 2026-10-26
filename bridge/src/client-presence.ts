// client-presence.ts — when the MCP server's client has gone, and what the process does about it.
//
// The MCP server lives as long as its client (Claude Code), which it hears only through stdio and signals: stdin
// ending or closing, a write to stdout finding the client's read end closed, or SIGTERM / SIGINT / SIGHUP. Whichever
// of those comes first decides; the rest change nothing. WHAT the process does once the client has gone — exit now,
// or keep serving other sessions that share its bridge and idle out — is the bridge holder's decision
// (bridge-holder.ts clientLeft); this module turns those events into the holder's calls, aborts every tool call in
// flight, and times the exit once the holder has let go.
//
// Its ports are the process's streams, its signals and its exit, so a suite drives it in process with fake streams
// (test/client-presence.test.ts); figma-mcp.ts wires it to the real ones (processIO).
import { exitFlushed } from "./stdio.ts";

/** What the presence needs of the bridge holder (bridge-holder.ts Holder). */
export interface PresenceHolder {
  clientLeft(how: string): void;
  release(why?: string): void;
  readonly released: Promise<string>;
}

/** A timer the presence arms (setTimeout's handle: an unref'd one never holds the event loop open). */
export interface PresenceTimer { unref(): void }

/** The process, as the presence uses it. */
export interface PresenceIO {
  stdin: { once(event: "end" | "close", fn: () => void): unknown };
  stdout: { on(event: "error", fn: (e: Error) => void): unknown };
  stderr: { on(event: "error", fn: (e: Error) => void): unknown };
  onSignal(sig: NodeJS.Signals, fn: () => void): void;
  setTimer(fn: () => void, ms: number): PresenceTimer;
  setExitCode(code: number): void;
  /** exit once stderr has drained, waiting at most `capMs` (stdio.ts exitFlushed) */
  exit(code: number, capMs: number): void;
}

/** The real process (figma-mcp.ts). */
export function processIO(): PresenceIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    onSignal: (sig, fn) => { process.on(sig, fn); },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    setExitCode: (code) => { process.exitCode = code; },
    exit: (code, capMs) => exitFlushed(code, capMs),
  };
}

export const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

// Claude Code ends a stdio server with SIGINT, then SIGTERM ~100 ms later, then SIGKILL ~400 ms after that
// (secondary source): a signal cancels and unlinks synchronously, gives the cancel frames SIGNAL_GRACE_MS to reach
// the plugin, and exits 0 waiting at most SIGNAL_FLUSH_CAP_MS for stderr — well inside that window.
export const SIGNAL_GRACE_MS = 150;
export const SIGNAL_FLUSH_CAP_MS = 200;
// Once the holder has let go, the loop drains to exit 0 on its own; this backstop (unref'd: it never holds the loop,
// but fires if something else does) exits after RELEASED_BACKSTOP_MS, waiting at most RELEASED_FLUSH_CAP_MS for stderr.
export const RELEASED_BACKSTOP_MS = 3000;
export const RELEASED_FLUSH_CAP_MS = 1000;

export interface ClientPresence {
  /** Aborted when the client goes or a signal arrives: every tool call's signal includes it, so a client that exits
   *  mid-export does not leave the plugin walking for nobody (the SDK aborts a call's own signal on
   *  notifications/cancelled, but its stdio transport never notices stdin ENDING). */
  readonly gone: AbortSignal;
  /** At startup, before anything writes to stdout: the stdout / stderr guards, the signal handlers, and the exit once
   *  the holder has let go. Once only. */
  start(): void;
  /** Once the transport is reading stdin: its end or close is the client going away. */
  watchStdin(): void;
}

/** The presence of the MCP client, over `io`, deciding through the holder `holder()` returns (made on first use). */
export function clientPresence(io: PresenceIO, holder: () => PresenceHolder): ClientPresence {
  const gone = new AbortController();
  const abandon = (why: string): void => { if (!gone.signal.aborted) gone.abort(new Error(`${why} — request abandoned`)); };

  // The client has gone: stdin ended/closed, or a write to stdout found the client's read end closed. When the client
  // is killed both pipes break at once, and a progress tick can reach stdout before stdin's 'end' is handled —
  // whichever is seen first decides; the rest are no-ops (the holder's clientLeft runs once).
  //
  // What happens then is the holder's: exit now unless other processes use the bridge this one shares, in which case
  // it keeps serving them and idles out like `dtwin serve` (FIGMA_DAEMON_IDLE_MIN). This deliberately departs from
  // the MCP stdio binding's "Servers SHOULD exit promptly when their standard input is closed" (spec revision
  // 2026-07-28, the stdio transport): the process is by then the shared daemon other sessions and commands route
  // through, and exiting would cut them off mid-use. The window is how it still goes away on its own once they stop.
  function wentAway(how: string): void {
    guard(); // installed at start(); the belt for any path that runs earlier
    abandon(`the MCP client went away (${how})`);
    holder().clientLeft(how);
  }

  // Once the client has gone, its end of our stdout (and maybe stderr) is closed, and the next write — the result of
  // a call the abort just settled, a progress notification — raises EPIPE as an 'error' event. The SDK's
  // StdioServerTransport has no stdout 'error' listener, so that event is an uncaught exception and would kill the
  // process that may now be serving other sessions. Installed at STARTUP, not when the client is seen to go: a killed
  // client breaks both pipes at once, and a progress tick written before stdin's 'end' is handled must not be the
  // thing that kills the orphan. A stdout error IS the client going away (EPIPE: its read end is closed;
  // ERR_STREAM_DESTROYED: a write after that); a stderr one is swallowed — there is nobody left to tell.
  let guarded = false;
  function guard(): void {
    if (guarded) return;
    guarded = true;
    io.stdout.on("error", (e: Error) => {
      const code = "code" in e ? e.code : undefined;
      wentAway(code === "EPIPE" || code === "ERR_STREAM_DESTROYED" ? "stdout closed" : `stdout failed: ${String(code ?? e.message)}`);
    });
    io.stderr.on("error", () => { /* the client is gone */ });
  }

  // SIGTERM / SIGINT / SIGHUP end this process — even while it serves other sessions (a signal is an explicit
  // request). The runtime's default handler would kill it outright: no 'exit' event (so the daemon socket file stays
  // behind) and no cancel frame for a read in flight. Once only: Claude Code's SIGINT is followed by a SIGTERM.
  let signalled = false;
  function onSignal(sig: NodeJS.Signals): void {
    if (signalled) return;
    signalled = true;
    guard();
    abandon(sig);
    // The holder lets go of what this process holds: cancel frames go to the plugin for every request still in
    // flight (server-core's close() sends them before it closes the sockets). It releases once: stdin EOF, a signal
    // and the idle shutdown can race.
    holder().release(`${sig} — closing the bridge and exiting`);
    io.setTimer(() => io.exit(0, SIGNAL_FLUSH_CAP_MS), SIGNAL_GRACE_MS);
  }

  let started = false;
  return {
    gone: gone.signal,
    start() {
      if (started) return;
      started = true;
      const onReleased = (): void => {
        io.setExitCode(0);
        io.setTimer(() => io.exit(0, RELEASED_FLUSH_CAP_MS), RELEASED_BACKSTOP_MS).unref();
      };
      holder().released.then(onReleased, onReleased);
      guard();
      for (const sig of SIGNALS) io.onSignal(sig, () => onSignal(sig));
    },
    watchStdin() {
      io.stdin.once("end", () => wentAway("stdin closed"));
      io.stdin.once("close", () => wentAway("stdin closed"));
    },
  };
}
