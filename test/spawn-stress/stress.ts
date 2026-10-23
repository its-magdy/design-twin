// Stress the runtime's child-process bug classes on this host, raw next to the hardened helper (design-to-code/proc.ts,
// which the suites import directly). Not a suite (run-suites does not run it, it prints no checks line): a CI job
// runs it on a loaded box, where these bugs show (.github/workflows/spawn-stress.yml).
//   bun test/spawn-stress/stress.ts <mode> [N=300] [concurrency=8]
// Prints one line `bun <version>  <mode>  N=… C=…  fail=<n>  <s>  <ms/run>` and up to five failures. Exit: 1 when a GATED mode
// (helper-* and fake-*: what the suites and production rely on) failed any run; raw-* and bun-spawn only report (they
// measure the runtime itself, and fail exactly where the helper exists for), exit 0. 2 for an unknown mode.
//
// The bug classes (oven-sh/bun): #45483 the exit/close emitted inside spawn(), before any listener (macOS, under bun test);
// #45365 a child never reaped, so no exit event at all; #46142 spawnSync returning status 0 with an empty stdout under load;
// #41782 a piped stream that loses its head under load.
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { runAsync, runSync, type ProcResult } from "../../design-to-code/proc.ts";

const MODES = ["raw-async", "raw-async-late", "helper-async", "bun-spawn", "raw-sync-pipe", "raw-sync-cat", "helper-sync",
  "big-stderr-pipe", "big-stderr-sync-pipe", "helper-big-stderr", "fake-early-exit", "fake-lost-exit"] as const;
type Mode = typeof MODES[number];
const isMode = (m: string): m is Mode => (MODES as readonly string[]).includes(m);

const [modeArg = "raw-async", nS = "300", cS = "8"] = process.argv.slice(2);
const N = Number(nS), C = Number(cS);
const EXE = process.execPath;
const BIG = 170_000;

async function pool(n: number, c: number, task: (i: number) => Promise<string | null>): Promise<string[]> {
  const fails: string[] = []; let next = 0;
  await Promise.all(Array.from({ length: c }, async () => { while (next < n) { const i = next++; const f = await task(i); if (f) fails.push(f); } }));
  return fails;
}
// The timer is cleared once `p` settles: thousands of runs would otherwise leave as many 10–15 s timers behind, holding
// the process open well past its last result line (and skewing the timing it prints).
const withTimeout = <T, F>(p: Promise<T>, ms: number, v: F): Promise<T | F> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<F>((r) => { t = setTimeout(() => r(v), ms); })]).finally(() => clearTimeout(t));
};
const brief = (r: ProcResult | null): string => JSON.stringify(r && { status: r.status, out: r.stdout.slice(0, 40), lost: r.lost, timedOut: r.timedOut });

// a stand-in ChildProcess whose exit was already recorded and whose pipes already ended when spawn() returned (#45483)
const earlyExited = (pid: number): ChildProcess => {
  const c = new ChildProcess();
  const pipe = (): PassThrough => { const s = new PassThrough(); s.resume(); s.end(); return s; };
  for (const [k, value] of Object.entries({ pid, exitCode: 2, signalCode: null, stdout: pipe(), stderr: pipe() })) Object.defineProperty(c, k, { value, configurable: true });
  return c;
};
// a real child whose exit and close events the runtime drops, and never records (#45365)
const droppingSpawn = ((cmd: string, args: readonly string[], o: object): ChildProcess => {
  const c = spawn(cmd, args, o);
  const emit = c.emit.bind(c);
  c.emit = ((ev: string | symbol, ...a: unknown[]): boolean => (ev === "exit" || ev === "close" ? false : emit(ev, ...a))) as typeof c.emit;
  for (const k of ["exitCode", "signalCode"]) Object.defineProperty(c, k, { get: () => null, set: () => {}, configurable: true });
  return c;
}) as typeof spawn;

const tasks: Record<Mode, (i: number) => Promise<string | null>> = {
  // listeners attached synchronously after spawn(), the usual pattern
  "raw-async": async (i) => {
    const c = spawn(EXE, ["-e", "process.exit(2)"]);
    c.stdout.resume();
    const ex = new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
    const cl = new Promise<number | null>((r) => c.on("close", (code) => r(code)));
    const [e, k] = await Promise.all([withTimeout(ex, 10_000, -99), withTimeout(cl, 10_000, -99)]);
    return e === 2 && k === 2 ? null : `#${i}: exit=${e} close=${k}`;
  },
  // listeners attached one macrotask late (the pattern #45483 punishes even harder)
  "raw-async-late": async (i) => {
    const c = spawn(EXE, ["-e", "process.exit(2)"]);
    await new Promise((r) => setImmediate(r));
    if (c.exitCode !== null) return null; // already recorded: fine
    const e = await withTimeout(new Promise<number | null>((r) => c.on("exit", (code) => r(code))), 10_000, -99);
    return e === 2 ? null : `#${i}: exit=${e} exitCode=${c.exitCode}`;
  },
  "helper-async": async (i) => {
    const r = await runAsync(EXE, ["-e", "process.stdout.write('ok'); process.exit(2)"], { timeoutMs: 15_000 }).done;
    return r.status === 2 && r.stdout === "ok" && !r.lost ? null : `#${i}: ${brief(r)}`;
  },
  "bun-spawn": async (i) => {
    const p = Bun.spawn([EXE, "-e", "process.exit(2)"], { stdout: "pipe" });
    const e = await withTimeout(p.exited, 10_000, -99);
    return e === 2 ? null : `#${i}: exited=${e}`;
  },
  // #46142's shape: spawnSync capture through a pipe must hold the whole payload
  "raw-sync-pipe": async (i) => {
    const r = spawnSync(EXE, ["-e", "process.stdout.write('x'.repeat(4096) + 'END')"], { encoding: "utf8" });
    await null;
    return r.status === 0 && r.stdout.length === 4099 && r.stdout.endsWith("END") ? null : `#${i}: status=${r.status} len=${r.stdout.length}`;
  },
  "raw-sync-cat": async (i) => {
    const r = spawnSync("cat", [import.meta.filename], { encoding: "utf8" }); // this file: there on every OS (Windows: Git's cat)
    await null;
    return r.status === 0 && r.stdout.length > 0 ? null : `#${i}: status=${r.status} len=${r.stdout.length}`;
  },
  "helper-sync": async (i) => {
    const r = runSync(EXE, ["-e", "process.stdout.write('x'.repeat(4096) + 'END')"], { expect: /END$/ });
    await null;
    return r.status === 0 && r.stdout.length === 4099 && !r.lost && r.attempts === 1 ? null : `#${i}: status=${r.status} len=${r.stdout.length} attempts=${r.attempts} lost=${r.lost}`;
  },
  // #41782's shape: a child writes ~170 KB to a piped stderr and exits; nothing may be lost
  "big-stderr-pipe": async (i) => {
    const c = spawn(EXE, ["-e", `process.stderr.write('H' + 'y'.repeat(${BIG}) + 'T'); process.exitCode = 1`]);
    let err = "";
    c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const k = await withTimeout(new Promise<number | null>((r) => c.on("close", (code) => r(code))), 15_000, -99);
    return k === 1 && err.length === BIG + 2 && err[0] === "H" ? null : `#${i}: close=${k} len=${err.length} head=${JSON.stringify(err.slice(0, 1))}`;
  },
  "big-stderr-sync-pipe": async (i) => {
    const r = spawnSync(EXE, ["-e", `process.stderr.write('H' + 'y'.repeat(${BIG}) + 'T'); process.exitCode = 1`], { encoding: "utf8" });
    await null;
    return r.status === 1 && r.stderr.length === BIG + 2 && r.stderr[0] === "H" ? null : `#${i}: status=${r.status} len=${r.stderr.length}`;
  },
  "helper-big-stderr": async (i) => {
    const r = runSync(EXE, ["-e", `process.stderr.write('H' + 'y'.repeat(${BIG}) + 'T'); process.exitCode = 1`]);
    await null;
    return r.status === 1 && r.stderr.length === BIG + 2 && r.stderr[0] === "H" ? null : `#${i}: status=${r.status} len=${r.stderr.length}`;
  },
  // simulated #45483: exit already recorded and the pipes already ended inside spawn() — the helper must settle with it
  "fake-early-exit": async (i) => {
    const fake = ((): ChildProcess => earlyExited(99_999_000 + i)) as typeof spawn;
    const r = await withTimeout(runAsync("x", [], { spawnImpl: fake, pollMs: 0, drainMs: 500 }).done, 5_000, null);
    return r && r.status === 2 ? null : `#${i}: ${brief(r)}`;
  },
  // simulated #45365: a real child whose exit/close events never come — the liveness poll must settle it, flagged, fast
  "fake-lost-exit": async (i) => {
    const t0 = Date.now();
    const r = await withTimeout(runAsync(EXE, ["-e", "process.exit(3)"], { spawnImpl: droppingSpawn, pollMs: 100 }).done, 8_000, null);
    return r && r.lost && Date.now() - t0 < 3_000 ? null : `#${i}: ${brief(r)} in ${Date.now() - t0} ms`;
  },
};

if (!isMode(modeArg)) { process.stderr.write(`unknown mode ${modeArg} (one of: ${MODES.join(", ")})\n`); process.exitCode = 2; }
else {
  const t0 = Date.now();
  const fails = await pool(N, C, tasks[modeArg]);
  const s = (Date.now() - t0) / 1000;
  process.stdout.write(`${`bun ${Bun.version}`.padEnd(12)} ${modeArg.padEnd(22)} N=${N} C=${C}  fail=${fails.length}  ${s.toFixed(1)}s  ${((s * 1000) / N).toFixed(1)} ms/run\n`);
  for (const f of fails.slice(0, 5)) process.stdout.write("   " + f + "\n");
  process.exitCode = fails.length > 0 && /^(helper|fake)-/.test(modeArg) ? 1 : 0;
}
