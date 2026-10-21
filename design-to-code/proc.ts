// One place every suite (and the few production callers) spawns a child, hardened against the runtime bug classes seen
// in Bun on macOS (oven-sh/bun #45483 exit/close emitted inside spawn(); #45365 a child never reaped; #46142 spawnSync
// returns empty stdout with status 0; #41782 a piped stream loses its head under load) — and harmless on Node.
//
//   const r = runSync(process.execPath, [CLI, "--help"], { expect: /usage:/ });   // file-backed capture, validated
//   const { child, done } = runAsync(process.execPath, [CLI, "serve"], { timeoutMs: 30_000 });
//   const r = await done;                                                           // never hangs, never loses the exit
//
// Sync capture goes through temp files, not pipes (#46142 / #41782 never reproduce with a file fd). Async settles on the
// FIRST of: 'close'; 'exit' + the pipes' end (or drainMs); an exit already recorded when spawn() returned (#45483); the
// pid found dead or a zombie by a liveness poll (#45365 — the result then says `lost`); the hard timeout (tree kill).
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProcResult {
  status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number;
  error?: Error; timedOut: boolean; attempts: number;
  /** Set when the result was recovered without the runtime's own exit report — say why (a test should fail on it). */
  lost?: string;
  /** runSync: the child's pid (it has exited — e.g. a pid known to be dead). */
  pid?: number;
  /** runSync with `binary`: stdout's exact bytes (`stdout` is then their UTF-8 reading). */
  stdoutBytes?: Buffer;
}
interface Common { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
export interface SyncOpts extends Common {
  input?: string | Buffer;
  /** What a valid run looks like; a run that fails it with status 0 is re-run once (idempotent commands only). */
  expect?: RegExp | "stdout" | ((r: ProcResult) => boolean);
  /** "pipe" keeps the runtime's own capture (for a test of exactly that); default "file". */
  capture?: "file" | "pipe";
  /** Also return stdout as bytes (`stdoutBytes`): a blob from `git show`, not text. */
  binary?: boolean;
}
export interface AsyncOpts extends Common {
  stdin?: "pipe" | "ignore"; detached?: boolean;
  /** After 'exit', how long to wait for 'close' (a grandchild may hold the pipes) before settling. */
  drainMs?: number;
  /** Liveness poll period once spawned; 0 disables. */
  pollMs?: number;
  /** How the timeout ends the child (default: SIGKILL to its group when detached, else to it); returns whether the tree went. */
  kill?: (child: ChildProcess) => boolean;
  /** Tests of this helper only: a stand-in for child_process.spawn. */
  spawnImpl?: typeof spawn;
}

// The capture files live in a fresh private directory per run (mkdtemp: mode 0700, a name nobody could guess and plant a
// symlink at in a shared /tmp), removed with them once read.
const readBytes = (f: string): Buffer => { try { return fs.readFileSync(f); } catch { return Buffer.alloc(0); } };

function syncOnce(cmd: string, args: readonly string[], o: SyncOpts, attempt: number): ProcResult {
  const t0 = Date.now();
  const opts = { cwd: o.cwd, env: o.env, input: o.input, timeout: o.timeoutMs, windowsHide: true, killSignal: "SIGKILL" as const, maxBuffer: 256 * 1024 * 1024 };
  const stdin = o.input !== undefined ? "pipe" : "ignore";
  const done = (s: ReturnType<typeof spawnSync>, stdout: string, stderr: string): ProcResult => ({
    status: s.status, signal: s.signal, stdout, stderr, ms: Date.now() - t0, ...(s.error ? { error: s.error } : {}), ...(s.pid ? { pid: s.pid } : {}),
    timedOut: (s.error !== undefined && "code" in s.error && s.error.code === "ETIMEDOUT"), attempts: attempt });
  let dir: string | null = null;
  if (o.capture !== "pipe") try { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-spawn-")); } catch { /* no writable temp dir: the pipes, below */ }
  if (dir === null) {
    const s = spawnSync(cmd, args, { ...opts, stdio: [stdin, "pipe", "pipe"] });
    const bytes = Buffer.isBuffer(s.stdout) ? s.stdout : Buffer.from(String(s.stdout ?? ""));
    return { ...done(s, bytes.toString("utf8"), String(s.stderr ?? "")), ...(o.binary ? { stdoutBytes: bytes } : {}) };
  }
  const outF = path.join(dir, "out"), errF = path.join(dir, "err");
  try {
    const out = fs.openSync(outF, "wx+"), err = fs.openSync(errF, "wx+");
    let s: ReturnType<typeof spawnSync>;
    try { s = spawnSync(cmd, args, { ...opts, stdio: [stdin, out, err] }); } finally { fs.closeSync(out); fs.closeSync(err); }
    const bytes = readBytes(outF);
    return { ...done(s, bytes.toString("utf8"), readBytes(errF).toString("utf8")), ...(o.binary ? { stdoutBytes: bytes } : {}) };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS temp dir is cleaned anyway */ } }
}

/** spawnSync with file-backed capture and an optional validity check, re-run once when an exit-0 run fails it. Never throws. */
export function runSync(cmd: string, args: readonly string[], o: SyncOpts = {}): ProcResult {
  const valid = (r: ProcResult): boolean => o.expect === undefined ? true
    : o.expect === "stdout" ? r.stdout.length > 0
    : o.expect instanceof RegExp ? o.expect.test(r.stdout) || o.expect.test(r.stderr) : o.expect(r);
  let r = syncOnce(cmd, args, o, 1);
  if (!valid(r) && r.status === 0 && !r.error) {
    process.stderr.write(`[spawn-helper] ${path.basename(cmd)} ${args.slice(0, 2).join(" ")}: exit 0 but its output failed the check (stdout ${r.stdout.length} B) — re-running once\n`);
    r = syncOnce(cmd, args, o, 2);
  }
  if (!valid(r)) r.lost = `output failed its check after ${r.attempts} run(s) (stdout ${r.stdout.length} B, status ${r.status})`;
  return r;
}

/** Linux: /proc says Z or nothing; elsewhere kill(pid,0) (a zombie still answers, so `ps` decides once the pipes are done). */
export function goneOrZombie(pid: number, pipesDone: boolean): boolean {
  if (process.platform === "linux") {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3) === "Z"; }
    catch { return true; }
  }
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  if (!pipesDone || process.platform === "win32") return false;
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  return ps.status === 0 && /^\s*Z/.test(ps.stdout ?? "");
}

/** Async spawn that always settles. `child` is live for the caller (stdin, kill, progressive stdout via `on('data')`). */
export function runAsync(cmd: string, args: readonly string[], o: AsyncOpts = {}): { child: ChildProcess | null; done: Promise<ProcResult> } {
  const t0 = Date.now();
  const detached = o.detached ?? process.platform !== "win32";
  let child: ChildProcess;
  try {
    child = (o.spawnImpl ?? spawn)(cmd, args, { cwd: o.cwd, env: o.env, detached, windowsHide: true, stdio: [o.stdin ?? "ignore", "pipe", "pipe"] as StdioOptions });
  } catch (e) {
    return { child: null, done: Promise.resolve({ status: null, signal: null, stdout: "", stderr: "", ms: 0, error: e as Error, timedOut: false, attempts: 1 }) };
  }
  let stdout = "", stderr = "", outEnded = false, errEnded = false, timedOut = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const done = new Promise<ProcResult>((resolve) => {
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const finish = (extra: Partial<ProcResult> = {}): void => {
      if (settled) return; settled = true;
      for (const t of timers) clearTimeout(t), clearInterval(t);
      resolve({ status: exit?.code ?? child.exitCode, signal: exit?.signal ?? child.signalCode, stdout, stderr, ms: Date.now() - t0, timedOut, attempts: 1, ...extra });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exit) return; exit = { code, signal };
      if (outEnded && errEnded) return finish();
      timers.push(setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, o.drainMs ?? 2_000));
    };
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const ended = (): void => { if (exit && outEnded && errEnded) finish(); };
    child.stdout?.on("end", () => { outEnded = true; ended(); });
    child.stderr?.on("end", () => { errEnded = true; ended(); });
    child.on("error", (e) => { if (child.pid === undefined || exit) finish({ error: e }); });
    child.on("exit", onExit);
    child.on("close", (code, signal) => { onExit(code, signal); finish(); });
    // #45483: the exit may already have been emitted inside spawn() — the ChildProcess still recorded it.
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
    // #45365 / any lost event: a pid that is gone (or a zombie) with no exit event settles anyway, flagged.
    const pollMs = o.pollMs ?? 250;
    if (pollMs > 0 && child.pid !== undefined) {
      let strikes = 0;
      const pid = child.pid;
      timers.push(setInterval(() => {
        if (exit || settled) return;
        if (!goneOrZombie(pid, outEnded && errEnded)) { strikes = 0; return; }
        if (++strikes < 4) return; // a real exit event normally follows within a tick or two: give it ~4 polls
        finish({ lost: `pid ${pid} is gone or a zombie but no exit/close event arrived after ${strikes * pollMs} ms` });
      }, pollMs));
    }
    if (o.timeoutMs) timers.push(setTimeout(() => {
      timedOut = true;
      if (o.kill) o.kill(child);
      else try { if (detached && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
      timers.push(setTimeout(() => finish({ lost: "killed at timeout; no exit event after SIGKILL" }), 3_000));
    }, o.timeoutMs));
  });
  return { child, done };
}

// ---- writing our own stdout / stderr without loss
// Bun (1.4.2, Linux too): once process.stdout exists the fd is non-blocking, and console.* / write() data that meets a
// full pipe (a slow reader: CI log shipper, `| less`, the runner forwarding) is DROPPED, not queued (cf. oven-sh/bun
// #41782). Node queues it but exit() drops the queue. writeAll blocks until every byte is in the pipe.
const pause = new Int32Array(new SharedArrayBuffer(4));
export function writeAll(fd: number, data: string | Uint8Array): void {
  let buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  while (buf.length > 0) {
    try { const n = fs.writeSync(fd, buf); buf = buf.subarray(n); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EAGAIN") Atomics.wait(pause, 0, 0, 2); else throw e; }
  }
}

// ---- the queued console and the exit helpers: bridge/src/stdio.ts (shared with the dtwin CLI, the MCP server and the
// daemon, which cannot import design-to-code), re-exported so every design-to-code caller keeps importing proc.ts.
export { installQueuedConsole, flushStdio, CliExit, exitCli, runCli, exitFlushed } from "../bridge/src/stdio.ts";
export type { RunCliOpts } from "../bridge/src/stdio.ts";
