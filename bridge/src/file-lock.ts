// One writer at a time for a shared file (a run's live status, a plan): an exclusive lock file beside it, held only
// for a short synchronous read-check-write. Shared by bridge/ and design-to-code/ (the layer may import bridge/src;
// bridge cannot import the layer).
//
// The lock is `<file>.lock`, created with open(2)'s O_CREAT|O_EXCL (fs flag "wx": "fails if the path exists"; on
// Windows the same flags map to CreateFileW's CREATE_NEW), so exactly one process creates it. It holds
// {pid, host, at, token}. A lock is stale — its holder was killed mid-write — when it is older than `staleMs`, or its
// holder (same host) no longer exists: process.kill(pid, 0) throws for a pid that does not exist and is "a platform
// independent way to test for the existence of a process"; EPERM means it exists under another user. A stale lock
// is moved aside under a unique name and removed only when it is still the one judged stale — a waiter that took a
// fresh lock between the read and the move gets it back (link(2) fails when yet another lock exists by then). A
// waiter polls every POLL_MS with Atomics.wait on a private SharedArrayBuffer (a synchronous sleep: these writes are
// synchronous, and Node lets the main thread block) and gives up after `waitMs` with LockBusy. The lock is
// removed on release only when it still holds this holder's token.
// Not re-entrant: a nested lock of the same file in one process waits for itself until LockBusy. The exclusive
// flag might not work on a network filesystem (Node's fs docs) — there the lock narrows the window, not closes it.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errCode } from "./errmsg.ts";
import { tmpSuffix } from "./atomic-write.ts";

export interface FileLockOpts {
  /** a lock older than this is a dead holder's (default 30 s — every locked section is a few small file writes) */
  staleMs?: number;
  /** how long to wait for a live holder before LockBusy (default 10 s) */
  waitMs?: number;
}
const STALE_MS = 30_000, WAIT_MS = 10_000, POLL_MS = 25;

/** The lock of `file`: `<file>.lock` beside it. */
export const lockFileOf = (file: string): string => file + ".lock";

/** The lock stayed held by a live holder for the whole wait. */
export class LockBusy extends Error {
  readonly lockFile: string;
  constructor(lockFile: string, holder: string, waitedMs: number) {
    super(`${lockFile} is held by ${holder} — another write was still in progress after ${Math.round(waitedMs / 100) / 10}s; retry once it is done`);
    this.name = "LockBusy";
    this.lockFile = lockFile;
  }
}

interface Holder { pid: number; host: string; at: number; token: string }
function holderOf(text: string): Holder | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || !("pid" in v) || !("host" in v) || !("at" in v) || !("token" in v)) return null;
    const { pid, host, at, token } = v;
    // a pid of 0 or below names a process GROUP to process.kill — never probed
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof host === "string" && typeof at === "number" && typeof token === "string" ? { pid, host, at, token } : null;
  } catch { return null; }
}
/** process.kill(pid, 0): no throw → it exists; EPERM → it exists, owned by another user; anything else (ESRCH) → gone. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return errCode(e) === "EPERM"; }
}
const read = (file: string): string | null => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
const describeHolder = (text: string | null): string => {
  const h = text === null ? null : holderOf(text);
  return h ? `process ${h.pid}${h.host !== os.hostname() ? ` on ${h.host}` : ""} since ${new Date(h.at).toISOString()}` : "another process";
};

/** Whether the lock whose bytes are `text` is a dead holder's. A lock with no readable holder yet (created, not yet
 *  written) is judged by its mtime; a holder on another host by its age only (its pid means nothing here). */
function isStale(lockFile: string, text: string, staleMs: number): boolean {
  const h = holderOf(text);
  let at: number;
  if (h) at = h.at;
  else { try { at = fs.statSync(lockFile).mtimeMs; } catch { return false; } } // gone: the next open takes it
  // either way past staleMs: a clock that jumped back must not keep a dead lock forever
  if (Math.abs(Date.now() - at) > staleMs) return true;
  return h !== null && h.host === os.hostname() && !pidAlive(h.pid);
}
/** Move the stale lock (bytes `seen`) aside and remove it — or put it back when it is no longer the one judged stale.
 *  Exported for its test (the interleaving it guards cannot be produced from outside). */
export function breakStale(lockFile: string, seen: string): void {
  const aside = lockFile + ".stale" + tmpSuffix();
  try { fs.renameSync(lockFile, aside); } catch { return; } // gone or busy: the next open decides
  if (read(aside) === seen) { fs.rmSync(aside, { force: true }); return; }
  // a fresh lock was taken between the read and the move: restore it (fails when yet another one exists by now)
  try { fs.linkSync(aside, lockFile); } catch { /* that newer lock stands */ }
  fs.rmSync(aside, { force: true });
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => { Atomics.wait(sleeper, 0, 0, ms); };

/** Take the lock `lockFile` (its directory is created when missing) and return its release. Throws LockBusy when a
 *  live holder keeps it for `waitMs`; any other error creating it (EACCES, EROFS…) is thrown as it is. */
export function acquireFileLock(lockFile: string, opts: FileLockOpts = {}): () => void {
  const staleMs = opts.staleMs ?? STALE_MS, waitMs = opts.waitMs ?? WAIT_MS;
  const token = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(path.dirname(path.resolve(lockFile)), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    let fd: number | null = null;
    try { fd = fs.openSync(lockFile, "wx"); } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
    if (fd !== null) {
      // `at` is the moment it was taken (not when the wait began): the age a waiter compares with staleMs
      const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token });
      try { fs.writeSync(fd, mine); } catch (e) {
        fs.closeSync(fd);
        fs.rmSync(lockFile, { force: true }); // never leave a lock that names no holder
        throw e;
      }
      fs.closeSync(fd);
      return () => {
        // only our own lock: one broken as stale and taken by another holder is theirs now
        if (read(lockFile) === mine) try { fs.rmSync(lockFile, { force: true }); } catch { /* left: stale once this process is gone */ }
      };
    }
    const text = read(lockFile);
    if (text === null) continue; // released between the open and the read
    if (isStale(lockFile, text, staleMs)) { breakStale(lockFile, text); continue; }
    const waited = Date.now() - t0;
    if (waited >= waitMs) throw new LockBusy(lockFile, describeHolder(text), waited);
    sleepSync(Math.min(POLL_MS, waitMs - waited));
  }
}

/** Run `fn` (synchronous) holding the lock `lockFile`; the lock is released however `fn` ends. */
export function withFileLock<T>(lockFile: string, fn: () => T, opts: FileLockOpts = {}): T {
  const release = acquireFileLock(lockFile, opts);
  try { return fn(); } finally { release(); }
}
