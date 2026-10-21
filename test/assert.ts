// The assertion runner shared by all three suites (harness.ts, bridge.test.ts, design-to-code.test.ts).
// One collector + report loop for all of them, instead of three that differ in exit convention and
// output format for counts the project's docs quote as if they were one thing.
//
//   import { ok, report } from "./assert.ts";
//   ok("name", cond);
//   report();          // prints the summary, then exits 0 (all passed) or 1 (any failed)
//
// `check` is the strict form (cond: boolean); `ok` is its loose twin, kept only until its last
// non-boolean callers are converted (see below).
//
// Results print as they are asserted rather than being held to the end: a suite that throws
// mid-run then still shows how far it got.
//
// `cond` is a boolean, not "anything truthy": `ok("x", obj.list)` passes on an EMPTY array and on a
// "0"-ish string alike, so a condition says what it checks (`.length > 0`, `!== undefined`, `===`).
//
// Fixtures: build them with test/fixtures.ts (typed builders that fill what the producer always writes)
// or check them with `satisfies`. Do NOT add `as unknown as <T>` to force a fixture into a type — that
// is exactly how fixtures drifted from the IR (a missing `tier`, a map entry with no `figma.name`) while
// the types said otherwise. A deliberately MALFORMED input goes through fixtures.ts `malformed()`, which
// says so at the call site. `bun run lint:any` (test/lint-any.ts rule 4) fails on any that comes back.
//
// ---- the suite's own output: in order, nothing lost, then exit
// A suite's verdict is the `N/N checks passed` line test/run-suites.ts reads off its piped stdout. Under Bun (1.4.x; Linux
// and macOS alike) fd 1 and 2 turn non-blocking as soon as process.stdout exists, and then:
//   - console.* writes straight to the fd, past the stream's queue: what meets a full pipe (the runner busy forwarding a
//     400 KB burst, a CI log shipper) is DROPPED, and what fits can overtake earlier process.stdout.write data;
//   - process.stdout.write queues in order, but process.exit() drops whatever is still queued;
//   - there is no flush primitive: write("", cb) calls back at once, with the queue still full (only a non-empty
//     write's callback, or process.exitCode and a natural exit, waits for it).
// And report() must not return: suites call it mid-flow to stop (`finish(); report();` after a failed precondition, then
// the rest of the module would run a whole e2e), so it cannot just set process.exitCode and wait for the queue.
// So when a stream is NOT a terminal, importing this module makes it synchronous: process.stdout/stderr.write hand every
// byte to the fd before returning (blocking on a full pipe, as Node does for files and TTYs — the reader is the runner,
// which always reads), and console.log/info/debug and warn/error go through them. Every line then lands in the order it
// was written, none is dropped, and nothing is ever queued, so report() can set process.exitCode and exit at once.
// A terminal is left alone (a person reads it, and on Windows the console's own write path does the encoding).
// A reader that went away (EPIPE: `bun test/x.test.ts | head`) ends the output, not the suite.
import fs from "node:fs";
import { format } from "node:util";

const pause = new Int32Array(new SharedArrayBuffer(4));
const closed = new Set<number>();
function writeAllFd(fd: number, buf: Buffer): void {
  while (buf.length > 0 && !closed.has(fd)) {
    try { buf = buf.subarray(fs.writeSync(fd, buf)); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") Atomics.wait(pause, 0, 0, 2); // a full non-blocking pipe: wait for the reader
      else if (code === "EPIPE") closed.add(fd);
      else throw e;
    }
  }
}
type WriteCb = (err?: Error | null) => void;
const syncWrite = (fd: number) => (chunk: string | Uint8Array, encOrCb?: BufferEncoding | WriteCb, cb?: WriteCb): boolean => {
  const enc = typeof encOrCb === "string" ? encOrCb : "utf8";
  const done = typeof encOrCb === "function" ? encOrCb : cb;
  writeAllFd(fd, typeof chunk === "string" ? Buffer.from(chunk, enc) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  if (done) process.nextTick(done, null);
  return true;
};
/** Exported for test/run-suites.test.ts; applied once at import. Idempotent. */
export function installSyncStdio(): void {
  const line = (s: NodeJS.WriteStream) => (...a: unknown[]): void => { s.write(format(...a) + "\n"); };
  if (!process.stdout.isTTY) {
    process.stdout.write = syncWrite(1);
    console.log = console.info = console.debug = line(process.stdout);
  }
  if (!process.stderr.isTTY) {
    process.stderr.write = syncWrite(2);
    console.warn = console.error = line(process.stderr);
  }
}
installSyncStdio();

let pass = 0;
let total = 0;

export function check(name: string, cond: boolean): boolean {
  total++;
  if (cond) { pass++; process.stdout.write("  ✓ " + name + "\n"); }
  else process.stdout.write("  ✗ FAIL " + name + "\n");
  return cond;
}

// `ok` is now just an alias of `check`, kept so the ~91 existing call sites in test/harness.ts,
// test/bridge.test.ts and test/identity.test.ts (and the name itself, which reads better in some
// places) didn't all need renaming once every call site was made to pass a real boolean.
export function ok(name: string, cond: boolean): boolean {
  return check(name, cond);
}

// Exit non-zero if anything failed. Returns the counts so a caller can use them instead of exiting.
// The exit is immediate (the summary is already in the pipe, see above) and never returns; process.exitCode is set first,
// so a `process.on("exit")` handler, and a caller with { exit: false }, see the verdict.
export function report({ exit = true }: { exit?: boolean } = {}): { pass: number; total: number } {
  process.stdout.write(`\n${pass}/${total} checks passed\n`);
  process.exitCode = pass === total ? 0 : 1;
  if (exit) process.exit(process.exitCode);
  return { pass, total };
}
