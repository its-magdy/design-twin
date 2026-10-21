// The queued console and the exit helpers every CLI entry point ends through — the dtwin CLI, the MCP server and the
// daemon here, and every design-to-code CLI (design-to-code/proc.ts re-exports this module; bridge/src never imports
// design-to-code, and the published `designtwin` package ships bridge/src alone, so it lives on this side).
//
// Bun (1.4.2, Linux too): console.* writes straight to the fd and DROPS what meets a full non-blocking pipe (a slow
// reader: CI log shipper, `| less`, Claude Code reading a hook's output), and exit() drops whatever is still queued on a
// pipe. So: console goes through the streams' queue, and a CLI ends on process.exitCode (the process exits once the queue
// has drained) — or, when something still holds the loop, through exitFlushed. Never a bare process.exit after output.
import { format } from "node:util";

/** console.* through process.stdout/stderr.write: Bun's console writes straight to the fd and DROPS what meets a full
 *  non-blocking pipe, while stream.write() queues it in order. End with process.exitCode (the process then exits once the
 *  queue has drained), or after flushStdio() — never a bare exit, which drops the queue. Also counts the streams' writes
 *  in flight, which flushStdio waits on. Idempotent. */
export function installQueuedConsole(o: { logTo?: "stdout" | "stderr" } = {}): void {
  trackWrites(process.stdout);
  trackWrites(process.stderr);
  const line = (s: NodeJS.WriteStream) => (...a: unknown[]): void => { s.write(format(...a) + "\n"); };
  // logTo "stderr": console.log/info/debug go to stderr too — the MCP server, whose stdout carries nothing but the
  // JSON-RPC its transport writes (a stray console.log there would corrupt the protocol stream).
  console.log = console.info = console.debug = line(o.logTo === "stderr" ? process.stderr : process.stdout);
  console.warn = console.error = line(process.stderr);
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
  cliDepth++;
  try {
    const r = main(argv);
    if (typeof r === "number") done(r); else r.then(done, fail);
  } catch (e) { fail(e); }
}
/** Exit with `code` once everything written to stdout and stderr is out (flushStdio) — or after `capMs` when a reader never
 *  drains them. For a process that has to end while something still holds the loop (a hung step's watchdog, a browser that
 *  will not go). Needs installQueuedConsole (runCli calls it) to know what is in flight. */
export function exitFlushed(code: number, capMs = 2_000): void {
  const exit = (): never => process.exit(code);
  setTimeout(exit, capMs).unref(); // a pending write keeps the loop up, so this still fires
  void flushStdio().then(exit);
}
