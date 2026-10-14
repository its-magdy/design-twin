// One writer at a time for a shared file (a run's live status, a plan): an exclusive lock file, held only for a
// short synchronous read-check-write. Shared by bridge/ and design-to-code/ (the layer may import bridge/src; bridge
// cannot import the layer).
//
// The lock (`<file>.lock` beside it, or a path the caller names) is created with open(2)'s O_CREAT|O_EXCL (fs flag
// "wx": "fails if the path exists"; on Windows the same flags map to CreateFileW's CREATE_NEW), so exactly one process
// creates it. It holds {pid, host, at, token} (+ ns on Linux: the holder's pid namespace). A waiter polls every POLL_MS
// with Atomics.wait on a private SharedArrayBuffer (a synchronous sleep: these writes are synchronous, and Node lets
// the main thread block) and gives up after `waitMs` with LockBusy. Every turn of that loop that takes nothing sleeps
// and counts against `waitMs` — only a turn that removed a dead holder's lock tries again at once.
//
// When a lock is a dead holder's:
//   - same machine (host, and on Linux the pid namespace): its pid no longer exists — process.kill(pid, 0) throws
//     for a pid that does not exist and is "a platform independent way to test for the existence of a process";
//     EPERM means it exists under another user. A live holder is waited for however long it holds, up to
//     LIVE_STALE_MS (a dead holder's pid taken by an unrelated process);
//   - another machine (its pid means nothing here): older than `staleMs`;
//   - no readable holder (killed between the create and the write, which are microseconds apart): the file's mtime
//     older than UNWRITTEN_STALE_MS.
// Breaking one: waiters that judged the same lock dead take turns under a second exclusive file, `<lock>.break`;
// under it the lock is read again and removed only when its bytes are still the ones judged dead. Nothing can take the
// lock while those bytes are there, and only a breaker removes them, so no breaker ever removes a lock another waiter
// has taken since. A breaker killed inside its turn (a read and an unlink) leaves the guard; one older than
// GUARD_STALE_MS is cleared. A holder whose lock was nevertheless taken (it stalled past the stale age, or a holder on
// another host past `staleMs`) finds out with stillMine() before its write; its release never removes the new
// holder's lock.
// Not re-entrant: a nested lock of the same file in one process waits for itself until LockBusy. The exclusive
// flag might not work on a network filesystem (Node's fs docs) — there the lock narrows the window, not closes it.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errCode } from "./errmsg.ts";

export interface FileLockOpts {
  /** a lock from another host older than this is a dead holder's (default 30 s — every locked section is a few small
   *  file writes) */
  staleMs?: number;
  /** how long to wait for a live holder before LockBusy (default 10 s) */
  waitMs?: number;
}
const STALE_MS = 30_000, WAIT_MS = 10_000, POLL_MS = 25;
/** A same-machine holder whose pid is alive is waited for up to this age; past it the pid is taken for a reused one. */
const LIVE_STALE_MS = 10 * 60_000;
/** A lock with no readable holder past this age was left by a process killed between its create and its write. */
const UNWRITTEN_STALE_MS = 2_000;
/** A break guard past this age was left by a breaker killed inside its turn (a read and an unlink). */
const GUARD_STALE_MS = 5_000;
/** How long a Windows create refusal that can be transient (a lock still delete-pending, an antivirus scan) is retried. */
const TRANSIENT_MS = 2_000;
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** The lock of `file`: `<file>.lock` beside it. */
export const lockFileOf = (file: string): string => file + ".lock";
/** The guard breakers of `lockFile` take turns under. */
export const breakGuardOf = (lockFile: string): string => lockFile + ".break";

/** The lock stayed held by a live holder for the whole wait — or was taken from this holder (LockLost). */
export class LockBusy extends Error {
  readonly lockFile: string;
  constructor(lockFile: string, message: string) {
    super(message);
    this.name = "LockBusy";
    this.lockFile = lockFile;
  }
}
/** The lock was broken and taken by another writer while this one held it (it held past the stale age). */
export class LockLost extends LockBusy {
  constructor(lockFile: string) {
    super(lockFile, `${lockFile} was taken over by another writer while this one held it — nothing more written; retry`);
    this.name = "LockLost";
  }
}

/** A taken lock. */
export interface HeldLock {
  /** remove the lock — only while it is still this holder's */
  release(): void;
  /** whether the lock on disk is still this holder's */
  stillMine(): boolean;
  /** throws LockLost when it is not — called right before a write the lock guards */
  assertMine(): void;
}

/** The pid namespace of this process on Linux (`pid:[<inode>]`), "" elsewhere: two processes with the same hostname
 *  in different namespaces (a container on the host's network) cannot see each other's pids. */
const PID_NS = ((): string => {
  if (process.platform !== "linux") return "";
  try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return ""; }
})();

interface Holder { pid: number; host: string; at: number; token: string; ns: string }
function holderOf(text: string): Holder | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || !("pid" in v) || !("host" in v) || !("at" in v) || !("token" in v)) return null;
    const { pid, host, at, token } = v;
    const ns = "ns" in v ? v.ns : "";
    // a pid of 0 or below names a process GROUP to process.kill — never probed
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof host === "string" && typeof at === "number" && typeof token === "string" && typeof ns === "string"
      ? { pid, host, at, token, ns } : null;
  } catch { return null; }
}
/** process.kill(pid, 0): no throw → it exists; EPERM → it exists, owned by another user; anything else (ESRCH) → gone. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) === "EPERM"; }
}
/** Whether this process can probe the holder's pid: same host, same pid namespace. */
const sameMachine = (h: Holder): boolean => h.host === os.hostname() && h.ns === PID_NS;
const read = (file: string): string | null => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
/** How far `t` (ms since the epoch) is from now, either way: a clock that jumped back must not keep a dead lock forever. */
const ageOf = (t: number): number => Math.abs(Date.now() - t);
const describeHolder = (text: string | null): string => {
  const h = text === null ? null : holderOf(text);
  return h ? `process ${h.pid}${h.host !== os.hostname() ? ` on ${h.host}` : ""} since ${new Date(h.at).toISOString()}` : "another process";
};

/** Whether the lock whose bytes are `text` is a dead holder's (see the header). */
function isStale(lockFile: string, text: string, staleMs: number): boolean {
  const h = holderOf(text);
  if (h === null) {
    try { return ageOf(fs.statSync(lockFile).mtimeMs) > Math.min(staleMs, UNWRITTEN_STALE_MS); } catch { return false; } // gone: the next open takes it
  }
  if (sameMachine(h)) return !pidAlive(h.pid) || ageOf(h.at) > Math.max(staleMs, LIVE_STALE_MS);
  return ageOf(h.at) > staleMs;
}

/**
 * Remove the dead holder's lock `lockFile` whose bytes were `seen` — under its break guard, and only when the bytes are
 * still `seen` then. True when it removed it; false when the guard is another breaker's (a dead breaker's is cleared
 * for the next turn) or the lock changed since (released, or taken and released again). Throws what creating the
 * guard or removing the lock throws (EACCES in a directory this process may not write). Exported for its test.
 */
export function breakStale(lockFile: string, seen: string): boolean {
  const guard = breakGuardOf(lockFile);
  let fd: number;
  try { fd = fs.openSync(guard, "wx"); } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
    try { if (ageOf(fs.statSync(guard).mtimeMs) > GUARD_STALE_MS) fs.rmSync(guard, { force: true }); } catch { /* gone, or cleared by another waiter */ }
    return false;
  }
  fs.closeSync(fd);
  try {
    if (read(lockFile) !== seen) return false;
    try { fs.unlinkSync(lockFile); } catch (e) { if (errCode(e) === "ENOENT") return false; throw e; }
    return true;
  } finally {
    try { fs.rmSync(guard, { force: true }); } catch { /* left: cleared once older than GUARD_STALE_MS */ }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => { Atomics.wait(sleeper, 0, 0, ms); };

/**
 * Take the lock `lockFile` (its directory is created when missing). Throws LockBusy when a live holder keeps it for
 * `waitMs`; when the lock was a dead holder's that could not be removed for the whole wait, what removing it threw
 * (EACCES in a read-only directory…); any other error creating it (EACCES, EROFS…) as it is — on Windows only once a
 * refusal that can be transient has lasted TRANSIENT_MS.
 */
export function acquireFileLock(lockFile: string, opts: FileLockOpts = {}): HeldLock {
  const staleMs = opts.staleMs ?? STALE_MS, waitMs = opts.waitMs ?? WAIT_MS;
  const token = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(path.dirname(path.resolve(lockFile)), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    let fd: number | null = null, text: string | null = null;
    /** why this turn took nothing other than a live holder: thrown instead of LockBusy when the wait runs out */
    let refused: unknown = null;
    try { fd = fs.openSync(lockFile, "wx"); } catch (e) {
      const code = errCode(e);
      if (code === "EEXIST") {
        text = read(lockFile); // null: released since, or unreadable — waited on like a live holder
        if (text !== null && isStale(lockFile, text, staleMs)) {
          try { if (breakStale(lockFile, text)) continue; } catch (be) { refused = be; }
        }
      } else if (process.platform === "win32" && code !== undefined && TRANSIENT_CODES.has(code) && Date.now() - t0 < Math.min(waitMs, TRANSIENT_MS)) {
        // a lock removed while another process still had it open stays delete-pending until that handle closes, and
        // creating it again meanwhile is refused (ERROR_ACCESS_DENIED → EPERM); an antivirus scan can do the same
        refused = e;
      } else throw e;
    }
    if (fd !== null) {
      // `at` is the moment it was taken (not when the wait began): the age a waiter compares with staleMs
      const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token, ...(PID_NS ? { ns: PID_NS } : {}) });
      try { fs.writeSync(fd, mine); } catch (e) {
        fs.closeSync(fd);
        fs.rmSync(lockFile, { force: true }); // never leave a lock that names no holder
        throw e;
      }
      fs.closeSync(fd);
      const stillMine = (): boolean => read(lockFile) === mine;
      return {
        // only our own lock: one broken as stale and taken by another holder is theirs now
        release: () => { if (stillMine()) try { fs.rmSync(lockFile, { force: true }); } catch { /* left: stale once this process is gone */ } },
        stillMine,
        assertMine: () => { if (!stillMine()) throw new LockLost(lockFile); },
      };
    }
    const waited = Date.now() - t0;
    if (waited >= waitMs) {
      if (refused !== null) throw refused;
      throw new LockBusy(lockFile, `${lockFile} is held by ${describeHolder(text)} — another write was still in progress after ${Math.round(waited / 100) / 10}s; retry once it is done`);
    }
    sleepSync(Math.min(POLL_MS, waitMs - waited));
  }
}

/** Run `fn` (synchronous) holding the lock `lockFile`; the lock is released however `fn` ends. `fn` gets the lock, to
 *  check it is still its own right before the write it guards. */
export function withFileLock<T>(lockFile: string, fn: (lock: HeldLock) => T, opts: FileLockOpts = {}): T {
  const lock = acquireFileLock(lockFile, opts);
  try { return fn(lock); } finally { lock.release(); }
}
