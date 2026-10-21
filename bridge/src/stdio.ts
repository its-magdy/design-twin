// The queued console and the exit helpers every CLI entry point ends through — the dtwin CLI, the MCP server and the
// daemon here, and every design-to-code CLI (design-to-code/proc.ts re-exports this module; bridge/src never imports
// design-to-code, and the published `designtwin` package ships bridge/src alone, so it lives on this side).
//
// Bun (1.4.2, Linux too): console.* writes straight to the fd and DROPS what meets a full non-blocking pipe (a slow
// reader: CI log shipper, `| less`, Claude Code reading a hook's output), and exit() drops whatever is still queued on a
// pipe. So: console goes through the streams' queue, and a CLI ends on process.exitCode (the process exits once the queue
// has drained) — or, when something still holds the loop, through exitFlushed. Never a bare process.exit after output.
import { format, inspect } from "node:util";
import type { InspectOptions } from "node:util";

/** console.* through process.stdout/stderr.write: Bun's console writes straight to the fd and DROPS what meets a full
 *  non-blocking pipe, while stream.write() queues it in order. End with process.exitCode (the process then exits once the
 *  queue has drained), or after flushStdio() — never a bare exit, which drops the queue. Also counts the streams' writes
 *  in flight, which flushStdio waits on. Idempotent. */
export function installQueuedConsole(o: { logTo?: "stdout" | "stderr" } = {}): void {
  trackWrites(process.stdout);
  trackWrites(process.stderr);
  // logTo "stderr": everything console prints goes to stderr — the MCP server, whose stdout carries nothing but the
  // JSON-RPC its transport writes (a stray console.log there would corrupt the protocol stream).
  const out = o.logTo === "stderr" ? process.stderr : process.stdout;
  const err = process.stderr;
  // console.group indentation, as the built-in console keeps it (two spaces per open group, on every line printed).
  let indent = "";
  const write = (s: NodeJS.WriteStream, text: string): void => { s.write((indent ? text.replace(/^/gm, indent) : text) + "\n"); };
  const line = (s: NodeJS.WriteStream) => (...a: unknown[]): void => { write(s, format(...a)); };
  console.log = console.info = console.debug = line(out);
  console.warn = console.error = line(err);
  // EVERY other console method that prints, so none of them reaches the fd past the queue — or the MCP server's stdout
  // (test/cli-exit.test.ts holds this list to every method the runtime's console has).
  // The text is close to the built-in's (inspect for dir, `Trace: …` + a stack for trace, `label: n` for count,
  // `label: n.nnnms` for the timers), on the stream the built-in uses (stdout, or stderr for trace / assert / a timer
  // warning); console.table prints its data inspected, not as a grid — nothing here tabulates, and a stray call must
  // still never reach the fd past the queue, or the MCP server's stdout.
  console.dir = (item?: unknown, options?: InspectOptions): void => { write(out, inspect(item, { customInspect: false, ...options })); };
  console.dirxml = line(out);
  console.table = (data?: unknown): void => { write(out, inspect(data)); };
  // Bun's own: console.write(...data) is raw bytes to stdout, no newline, no format — returns the byte count.
  console.write = (...data: Array<string | ArrayBufferView | ArrayBuffer>): number => {
    let n = 0;
    for (const d of data) {
      const b = typeof d === "string" ? Buffer.from(d) : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength);
      if (b.length) { out.write(b); n += b.length; }
    }
    return n;
  };
  // Only a terminal is cleared (as the built-in does); never a pipe — least of all the MCP server's.
  console.clear = (): void => { if (out.isTTY) out.write("\u001b[1;1H\u001b[0J"); };
  console.trace = (...a: unknown[]): void => {
    const e = new Error(format(...a));
    e.name = "Trace"; // before the capture: the stack's first line is `Trace: <message>`, as the built-in prints
    Error.captureStackTrace(e, console.trace);
    write(err, e.stack ?? `Trace: ${e.message}`);
  };
  console.assert = (cond?: unknown, ...a: unknown[]): void => { if (!cond) write(err, a.length ? "Assertion failed: " + format(...a) : "Assertion failed"); };
  console.group = console.groupCollapsed = (...a: unknown[]): void => { if (a.length) write(out, format(...a)); indent += "  "; };
  console.groupEnd = (): void => { indent = indent.slice(0, -2); };
  const counts = new Map<string, number>();
  console.count = (label = "default"): void => { const n = (counts.get(label) ?? 0) + 1; counts.set(label, n); write(out, `${label}: ${n}`); };
  console.countReset = (label = "default"): void => { counts.delete(label); };
  const timers = new Map<string, number>();
  const elapsed = (label: string): string | null => { const t = timers.get(label); return t === undefined ? null : `${label}: ${(performance.now() - t).toFixed(3)}ms`; };
  console.time = (label = "default"): void => { timers.set(label, performance.now()); };
  console.timeLog = (label = "default", ...a: unknown[]): void => { const e = elapsed(label); if (e === null) write(err, `Warning: No such label '${label}' for console.timeLog()`); else write(out, [e, ...a.map((x) => format(x))].join(" ")); };
  console.timeEnd = (label = "default"): void => { const e = elapsed(label); timers.delete(label); write(e === null ? err : out, e ?? `Warning: No such label '${label}' for console.timeEnd()`); };
}
// How many non-empty writes each stream has not yet handed to the OS, and who waits for that to reach 0. Bun (1.4.2) keeps
// no usable writableLength (0 while 400 KB are queued) and calls back an EMPTY write at once, before what was queued ahead of
// it is out; a non-empty write's callback does come once its bytes are written, in order. So every write is counted (the
// stream's write wrapped once) and the count says when the queue is empty.
const inFlight = new Map<NodeJS.WriteStream, { n: number; idle: Array<() => void> }>();
function trackWrites(s: NodeJS.WriteStream): void {
  if (inFlight.has(s)) return;
  const st = { n: 0, idle: [] as Array<() => void> };
  inFlight.set(s, st);
  const write = s.write.bind(s) as (chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => boolean;
  const settle = (): void => { if (--st.n === 0) for (const r of st.idle.splice(0)) r(); };
  s.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
    const done = typeof encoding === "function" ? encoding : cb;
    const enc = typeof encoding === "function" ? undefined : encoding;
    if (chunk.length === 0) return write(chunk, enc, done);
    st.n++;
    let called = false;
    return write(chunk, enc, (err?: Error | null) => { if (!called) { called = true; settle(); } done?.(err); });
  };
}
/** Resolves once every write made through installQueuedConsole's streams has been handed to the OS (at once when there is
 *  none in flight, or the streams are not tracked). */
export const flushStdio = (): Promise<void> => Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => {
  const st = inFlight.get(s);
  if (!st || st.n === 0) r(); else st.idle.push(r);
}))).then(() => undefined);

// ---- ending a CLI without losing its output
// Every CLI entry point (dtwin, seed-components, each design-to-code CLI) runs its main() through runCli: console goes through the queued streams, and the exit
// code is process.exitCode — the process ends once the queue has drained, never with a bare exit call that drops it
// (Bun loses what is still queued on a pipe at exit(): a 300 KB report into a slow reader arrived as its first 64 KB).
// The few library helpers that must end the CLI mid-call (cli-args.ts cliParse, catalog-input.ts's fail-loud readers)
// call exitCli(): inside runCli it throws CliExit, which unwinds to runCli and becomes the exit code; anywhere else (a
// suite calling main() in-process, the MCP server importing a module) it exits the process at once, as before.
// "Inside" is until main() SETTLES: a long-lived server is not a CLI run. `dtwin mcp` awaits the MCP server's module (so
// an exitCli while it LOADS — a bad FIGMA_BRIDGE_PORT at server-core's load — is still that CLI's exit code, its line out
// first), then returns; from there the server runs exactly as `bun figma-mcp.ts` does, where an exitCli exits at once.
// One rule for both launches — the server never depends on how it was started.
/** What exitCli throws inside runCli. Not an error: runCli turns it into the exit code, silently. */
export class CliExit extends Error {
  readonly code: number;
  constructor(code: number) { super(`exit ${code}`); this.name = "CliExit"; this.code = code; }
}
let cliDepth = 0;
/** End the CLI with `code` after what it already printed (see above). Never returns. */
export function exitCli(code: number): never {
  if (cliDepth > 0) throw new CliExit(code);
  process.exit(code);
}
export interface RunCliOpts {
  /** The prefix of an uncaught error's line on stderr (`<name>: <stack>`). */
  name: string;
  /** An uncaught error's line on stderr instead (e.g. its message without the stack). */
  errorLine?: (e: unknown) => string;
  /** An uncaught error's exit code, after its line (default 1; verifier-guard fails open: 0). */
  errorCode?: number;
  /** What to do with the exit code (default: process.exitCode = code). */
  done?: (code: number) => void;
}
/** Run a CLI's main(argv) as the process entry: queued console, exitCli honoured, an uncaught error one line + exit 1. */
export function runCli(main: (argv: string[]) => number | Promise<number>, o: RunCliOpts, argv: string[] = process.argv.slice(2)): void {
  installQueuedConsole();
  const done = o.done ?? ((code: number): void => { process.exitCode = code; });
  const fail = (e: unknown): void => {
    if (e instanceof CliExit) return done(e.code);
    console.error(o.errorLine ? o.errorLine(e) : `${o.name}: ${(e instanceof Error && e.stack) || String(e)}`);
    done(o.errorCode ?? 1);
  };
  // Inside main() — and only until it settles — exitCli throws CliExit (see above). Back to 0 once it has, so whatever
  // outlives a CLI's main (a server it started, a timer) sees exitCli as it would outside any CLI: an immediate exit.
  cliDepth++;
  let settled = false;
  const leave = (): void => { if (!settled) { settled = true; cliDepth--; } };
  try {
    const r = main(argv);
    if (typeof r === "number") { leave(); done(r); } else r.then((c) => { leave(); done(c); }, (e: unknown) => { leave(); fail(e); });
  } catch (e) { leave(); fail(e); }
}
/** Whether exitCli would throw CliExit here (inside a runCli main that has not settled) rather than exit. For the suites. */
export const insideCli = (): boolean => cliDepth > 0;
/** Exit with `code` once everything written to stdout and stderr is out (flushStdio) — or after `capMs` when a reader never
 *  drains them. For a process that has to end while something still holds the loop (a hung step's watchdog, a browser that
 *  will not go). Needs installQueuedConsole (runCli calls it) to know what is in flight.
 *  The cap bounds QUEUED writes (POSIX, where a write to a pipe is queued). On Windows Bun makes stdout/stderr on a pipe
 *  synchronous (as Node does there): a write into a full pipe blocks the thread until the reader takes it, so nothing is
 *  ever left in flight here — and a reader that never reads holds the process in that write, as it would any program. */
export function exitFlushed(code: number, capMs = 2_000): void {
  const exit = (): never => process.exit(code);
  setTimeout(exit, capMs).unref(); // a pending write keeps the loop up, so this still fires
  void flushStdio().then(exit);
}
