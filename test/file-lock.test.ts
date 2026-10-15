// The shared lock file (bridge/src/file-lock.ts) and the locked JSON update over it (bridge/src/json-file.ts
// updateJsonLike): held and released, released on a throw, a live holder waited for then LockBusy (however long a
// same-host one holds), a stale lock (another host's too old, a dead pid, never written) broken, a fresh one never
// removed by a waiter or a releaser that lost it, a lost lock caught before the write, a wait that ends when the lock
// cannot be broken or read, breakers taking turns (a guard judged like a lock), a lock or guard changing between the
// steps of a take or a break, Windows' transient create refusals, and real node processes contending for one counter and racing to
// break dead holders' locks. Temp dirs only; binds no port.
// Run with:  node test/file-lock.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { LockBusy, LockLost, PID_NS, acquireFileLock, breakGuardOf, breakStale, lockFileOf, processState, thisProcess, withFileLock } from "../bridge/src/file-lock.ts";
import { updateJsonLike } from "../bridge/src/json-file.ts";

const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};
const roots: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-lock-")); roots.push(d); return d; };
// ns: this process's pid namespace on Linux (as file-lock.ts stamps it), so a same-host holder is probed by its pid
const holder = (pid: number, at: number, host = os.hostname()): string => JSON.stringify({ pid, host, at, token: "feedfacefeedface", ns: PID_NS });
/** A pid that existed and has exited (a finished child). */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return typeof r.pid === "number" ? r.pid : 999_999;
};
const caught = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const CHILD = path.join(import.meta.dirname, "lock-child.ts");

console.log("withFileLock — held, then released:");
{
  const d = mk();
  const lock = lockFileOf(path.join(d, "plan.json"));
  let seen: unknown = null;
  const out = withFileLock(lock, () => { const v: unknown = JSON.parse(fs.readFileSync(lock, "utf8")); seen = v; return 42; });
  t("the lock is <file>.lock and holds {pid, host, at, token} while fn runs; fn's value is returned", () =>
    lock === path.join(d, "plan.json.lock") && out === 42 && typeof seen === "object" && seen !== null && "pid" in seen && seen.pid === process.pid
    && "host" in seen && seen.host === os.hostname() && "at" in seen && typeof seen.at === "number" && "token" in seen && typeof seen.token === "string");
  t("…and is removed once fn returns", () => !fs.existsSync(lock));
  const e = caught(() => withFileLock(lock, () => { throw new Error("boom"); }));
  t("a throw in fn is thrown as it is, and the lock is released", () => e instanceof Error && e.message === "boom" && !fs.existsSync(lock));
  const deep = path.join(d, "a", "b", "x.json.lock");
  t("a missing directory is created for the lock", () => withFileLock(deep, () => fs.existsSync(deep)) && !fs.existsSync(deep));
  t("two locks in a row (released between) both succeed", () => withFileLock(lock, () => 1) + withFileLock(lock, () => 1) === 2);
}

console.log("a live holder — waited for, then LockBusy:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const live = holder(process.pid, Date.now());
  fs.writeFileSync(lock, live);
  const t0 = Date.now();
  let ran = false;
  const e = caught(() => withFileLock(lock, () => { ran = true; }, { waitMs: 300 }));
  const waited = Date.now() - t0;
  t("a fresh lock of a live pid → LockBusy after waitMs (≈300 ms), fn never runs", () => e instanceof LockBusy && waited >= 280 && waited < 5_000 && !ran);
  t("…its message names the lock and the holder's pid; the holder's lock is untouched", () => e instanceof LockBusy && e.message.includes(lock) && e.message.includes(`process ${process.pid}`) && fs.readFileSync(lock, "utf8") === live);
  // a holder on another host: its pid means nothing here, only its age counts
  const remote = holder(deadPid(), Date.now(), "another-host.invalid");
  fs.writeFileSync(lock, remote);
  t("a fresh lock from another host whose pid is not running here → still busy (the pid is not probed)", () => caught(() => withFileLock(lock, () => 0, { waitMs: 100 })) instanceof LockBusy && fs.readFileSync(lock, "utf8") === remote);
  // a holder that runs as another user: process.kill(pid, 0) throws EPERM — it exists
  if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
    const otherUser = holder(1, Date.now());
    fs.writeFileSync(lock, otherUser);
    t("a fresh lock held by another user's process (pid 1: EPERM) → busy, never broken", () => caught(() => withFileLock(lock, () => 0, { waitMs: 100 })) instanceof LockBusy && fs.readFileSync(lock, "utf8") === otherUser);
  } else console.log("  (skipped: another user's pid — pid 1 answers EPERM only on POSIX, as a non-root user)");
  // created, not yet written (the instant between open and write): judged by its mtime
  fs.writeFileSync(lock, "");
  t("an empty (not yet written) fresh lock → busy, not broken", () => caught(() => withFileLock(lock, () => 0, { waitMs: 100 })) instanceof LockBusy && fs.existsSync(lock));
  // released by its holder while we wait → taken
  fs.writeFileSync(lock, holder(process.pid, Date.now()));
  // a timer here cannot fire while the main thread blocks in Atomics.wait: a child releases it instead
  const releaser = spawn(process.execPath, ["-e", 'setTimeout(() => require("fs").rmSync(process.argv[1], { force: true }), 200)', lock]);
  const t1 = Date.now();
  const got = withFileLock(lock, () => "mine", { waitMs: 5_000 });
  t("a holder that releases while we wait → the lock is taken then (not LockBusy)", () => got === "mine" && Date.now() - t1 >= 100);
  releaser.kill();
}

console.log("a stale lock — broken and taken:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const remote = (at: number): string => holder(deadPid(), at, "another-host.invalid");
  fs.writeFileSync(lock, remote(Date.now() - 60_000));
  t("another host's lock older than staleMs (60 s old, staleMs 30 s) → broken, fn runs, released after", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }) && !fs.existsSync(lock));
  fs.writeFileSync(lock, remote(Date.now() + 60_000));
  t("…a time far in the future (a clock that jumped back) → stale too", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }));
  fs.writeFileSync(lock, holder(deadPid(), Date.now()));
  t("a fresh lock whose holder pid no longer exists (same host) → broken at once", () => withFileLock(lock, () => true, { waitMs: 100 }));
  fs.writeFileSync(lock, holder(process.pid, Date.now() - 3 * 60_000));
  t("a same-host lock whose pid is alive but 3 min old (past the 2 min backstop: a dead holder's pid reused) → broken", () => withFileLock(lock, () => true, { waitMs: 100 }));
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 3_000);
  fs.utimesSync(lock, old, old);
  t("an empty lock (killed between its create and its write) 3 s old → broken, with staleMs at its 30 s default", () => withFileLock(lock, () => true, { waitMs: 100 }));
  fs.writeFileSync(lock, "{not json");
  fs.utimesSync(lock, old, old);
  t("an unreadable holder (not JSON) 3 s old → broken", () => withFileLock(lock, () => true, { waitMs: 100 }));
  t("no stale copies and no break guard are left beside the lock", () => fs.readdirSync(d).length === 0);
}

console.log("a live same-host holder is never broken by age:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const live = holder(process.pid, Date.now() - 60_000);
  fs.writeFileSync(lock, live);
  t("a live pid on this host, 60 s old, staleMs 30 s → busy (LockBusy), the lock untouched", () => caught(() => withFileLock(lock, () => 0, { staleMs: 30_000, waitMs: 100 })) instanceof LockBusy && fs.readFileSync(lock, "utf8") === live);
  const older = holder(process.pid, Date.now() - 110_000);
  fs.writeFileSync(lock, older);
  t("…110 s old (inside the 2 min backstop) → still busy, untouched", () => caught(() => withFileLock(lock, () => 0, { staleMs: 30_000, waitMs: 100 })) instanceof LockBusy && fs.readFileSync(lock, "utf8") === older);
  fs.rmSync(lock, { force: true });
  // another process holds the lock past the waiter's staleMs (300 ms) while the waiter waits
  const ready = path.join(d, "ready");
  const p = spawn(process.execPath, [CHILD, "hold", lock, ready, "1200"]);
  const closed = new Promise<void>((resolve) => p.on("close", () => resolve()));
  for (const t0 = Date.now(); !fs.existsSync(ready) && Date.now() - t0 < 10_000;) await sleep(10);
  const t1 = Date.now();
  let releasedFirst = false;
  const got = caught(() => withFileLock(lock, () => { releasedFirst = fs.existsSync(ready + ".done"); }, { staleMs: 300, waitMs: 8_000 }));
  const waited = Date.now() - t1;
  await closed;
  t("a holder in another process that keeps the lock 1.2 s (past staleMs 300 ms) → waited for: taken only once it released", () => got === null && releasedFirst && waited >= 900);
}

console.log("a lock lost to another writer — stillMine / assertMine:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const held = acquireFileLock(lock);
  const fresh = held.stillMine();
  const other = holder(process.pid, Date.now());
  fs.writeFileSync(lock, other); // broken and taken by another holder
  const lost = caught(() => held.assertMine());
  t("stillMine is true while held; once another holder has the lock → false, and assertMine throws LockLost (a LockBusy) naming the lock", () =>
    fresh && !held.stillMine() && lost instanceof LockLost && lost instanceof LockBusy && lost.message.includes(lock));
  held.release();
  t("…its release leaves the other holder's lock", () => fs.readFileSync(lock, "utf8") === other);
  fs.rmSync(lock, { force: true });
  const f = path.join(d, "plan.json");
  fs.writeFileSync(f, "{\n  \"a\": 1\n}\n");
  const e = caught(() => updateJsonLike(f, () => { fs.writeFileSync(lockFileOf(f), other); return { a: 2 }; }));
  t("updateJsonLike whose lock is taken while fn runs → LockLost, the file not written", () => e instanceof LockLost && fs.readFileSync(f, "utf8") === "{\n  \"a\": 1\n}\n");
  fs.rmSync(lockFileOf(f));
}

console.log("a holder from another pid namespace (same hostname) is judged by age only:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  // a pid that does not exist here, in a namespace this process is not in: it may be alive there
  const other = JSON.stringify({ pid: deadPid(), host: os.hostname(), at: Date.now(), token: "feedfacefeedface", ns: "pid:[1]" });
  fs.writeFileSync(lock, other);
  t("a fresh lock naming another pid namespace → busy, not broken for its pid", () => caught(() => withFileLock(lock, () => 0, { waitMs: 100 })) instanceof LockBusy && fs.readFileSync(lock, "utf8") === other);
  const otherOld = JSON.stringify({ pid: deadPid(), host: os.hostname(), at: Date.now() - 60_000, token: "feedfacefeedface", ns: "pid:[1]" });
  fs.writeFileSync(lock, otherOld);
  t("…older than staleMs → broken", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }));
}

// in a child with a timeout: a wait that never ends would hang this suite (a synchronous spin cannot be timed out here)
const tryLock = (lock: string, waitMs: number): { ms: number; name: string; code: string } | "hung" => {
  const r = spawnSync(process.execPath, [CHILD, "try", lock, String(waitMs)], { encoding: "utf8", timeout: 10_000 });
  if (r.signal !== null) return "hung";
  try {
    const v: unknown = JSON.parse(r.stdout);
    return v !== null && typeof v === "object" && "ms" in v && "name" in v && "code" in v && typeof v.ms === "number" && typeof v.name === "string" && typeof v.code === "string" ? { ms: v.ms, name: v.name, code: v.code } : "hung";
  } catch { return "hung"; }
};
console.log("a lock that cannot be broken or read — the wait still ends:");
{
  const d = mk();
  if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
    // a dead holder's lock in a directory this process may not write: the break fails on every turn
    const ro = path.join(d, "ro");
    fs.mkdirSync(ro);
    const lock = path.join(ro, "s.json.lock");
    fs.writeFileSync(lock, holder(deadPid(), Date.now()));
    fs.chmodSync(ro, 0o555);
    const r = tryLock(lock, 300);
    fs.chmodSync(ro, 0o755);
    if (r === "hung") console.log("    the acquire never returned (killed after 10 s)");
    t("a dead holder's lock in a read-only directory → after waitMs (≈300 ms), what breaking it threw (EACCES), never a spin", () =>
      r !== "hung" && r.code === "EACCES" && r.ms >= 280 && r.ms < 5_000 && fs.existsSync(lock));
  } else console.log("  (skipped: a read-only directory — mode bits refuse nothing on Windows / as root)");
  // a lock path that exists but cannot be read as a file (a directory): EEXIST on create, EISDIR on read
  const dirLock = path.join(d, "dir.lock");
  fs.mkdirSync(dirLock);
  const r2 = tryLock(dirLock, 300);
  if (r2 === "hung") console.log("    the acquire never returned (killed after 10 s)");
  t("an unreadable lock (a directory) → LockBusy after waitMs, never a spin", () => r2 !== "hung" && r2.name === "LockBusy" && r2.ms >= 280 && r2.ms < 5_000);
}

console.log("breakStale never removes a fresh lock; breakers take turns; a release never removes another holder's:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const stale = holder(deadPid(), Date.now() - 60_000);
  const fresh = holder(process.pid, Date.now());
  // judged stale from bytes read earlier, but another waiter has broken it and taken a fresh one since
  fs.writeFileSync(lock, fresh);
  const b1 = breakStale(lock, stale);
  t("the lock on disk is no longer the one judged stale → false, left unchanged, nothing left beside it", () => !b1 && fs.readFileSync(lock, "utf8") === fresh && fs.readdirSync(d).join() === "s.json.lock");
  fs.writeFileSync(lock, stale);
  const b2 = breakStale(lock, stale);
  t("…still the one judged stale → true, removed, the guard gone", () => b2 && !fs.existsSync(lock) && fs.readdirSync(d).length === 0);
  // another breaker is inside its turn (its guard is fresh): this one waits its turn, the lock is left to it
  const guard = breakGuardOf(lock);
  fs.writeFileSync(lock, stale);
  fs.writeFileSync(guard, "");
  t("a guard held by another breaker → false, the lock left", () => !breakStale(lock, stale) && fs.readFileSync(lock, "utf8") === stale);
  const e = caught(() => withFileLock(lock, () => 0, { waitMs: 150 }));
  t("…and a waiter never breaks the lock while that guard is held (LockBusy after waitMs)", () => e instanceof LockBusy && fs.readFileSync(lock, "utf8") === stale);
  // a guard is judged like a lock: a live breaker keeps its turn however long it is descheduled
  const minuteAgo = new Date(Date.now() - 60_000);
  const liveBreaker = holder(process.pid, Date.now() - 60_000);
  fs.writeFileSync(guard, liveBreaker);
  fs.utimesSync(guard, minuteAgo, minuteAgo);
  const eLive = caught(() => withFileLock(lock, () => 0, { waitMs: 150 }));
  t("a guard a live breaker on this host wrote a minute ago (stalled inside its turn) → kept, the lock left, LockBusy", () =>
    eLive instanceof LockBusy && fs.readFileSync(guard, "utf8") === liveBreaker && fs.readFileSync(lock, "utf8") === stale);
  const remoteBreaker = holder(deadPid(), Date.now(), "another-host.invalid");
  fs.writeFileSync(guard, remoteBreaker);
  t("a fresh guard from another host → kept (its pid means nothing here)", () => !breakStale(lock, stale) && fs.readFileSync(guard, "utf8") === remoteBreaker);
  // a breaker killed inside its turn leaves the guard: its dead pid clears it, and the next turn breaks the lock
  fs.writeFileSync(guard, holder(deadPid(), Date.now()));
  t("a fresh guard whose breaker pid is gone (same host) → cleared; the next waiter breaks the lock and takes it", () => withFileLock(lock, () => true, { waitMs: 500 }) && fs.readdirSync(d).length === 0);
  fs.writeFileSync(lock, stale);
  fs.writeFileSync(guard, holder(deadPid(), Date.now() - 60_000, "another-host.invalid"));
  t("a guard from another host older than staleMs → cleared; the lock broken and taken", () => withFileLock(lock, () => true, { waitMs: 500 }) && fs.readdirSync(d).length === 0);
  const old = new Date(Date.now() - 3_000);
  fs.writeFileSync(lock, stale);
  fs.writeFileSync(guard, "");
  fs.utimesSync(guard, old, old);
  t("an empty guard 3 s old (its breaker killed before writing it) → cleared; the lock broken and taken", () => withFileLock(lock, () => true, { waitMs: 500 }) && fs.readdirSync(d).length === 0);
  // a holder whose lock was broken (it ran past staleMs) and taken by another: its release leaves the new one
  const taken = holder(process.pid, Date.now());
  withFileLock(lock, () => { fs.writeFileSync(lock, taken); });
  t("a release whose lock was taken over by another holder leaves that holder's lock", () => fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === taken);
  fs.rmSync(lock, { force: true });
}

// The instants between steps, made to happen: fs's own functions wrapped for one call (file-lock.ts calls them through
// the same `fs` object), restored at once.
console.log("a lock or guard that changes between the steps of a take or a break:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const other = holder(process.pid, Date.now());
  // created, then removed as an unwritten dead lock and created again by another process before this one writes it
  const writeSync = fs.writeSync;
  let armed = true;
  fs.writeSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (armed) { armed = false; fs.rmSync(lock); fs.writeFileSync(lock, other); }
    return Reflect.apply(writeSync, fs, args);
  }) as typeof fs.writeSync;
  let e: unknown;
  try { e = caught(() => withFileLock(lock, () => 0, { waitMs: 150 })); } finally { fs.writeSync = writeSync; }
  t("a lock removed while still empty and taken by another process → never taken for its own: LockBusy, the other's lock untouched", () =>
    e instanceof LockBusy && !(e instanceof LockLost) && fs.readFileSync(lock, "utf8") === other);
  fs.rmSync(lock);
  // a breaker that judged an empty lock dead: by its turn the lock is a new one, still empty
  fs.writeFileSync(lock, "");
  t("breakStale of an empty lock that is fresh again under the guard (just created by another process) → false, left", () => !breakStale(lock, "") && fs.existsSync(lock) && !fs.existsSync(breakGuardOf(lock)));
  fs.rmSync(lock);
  // a breaker whose guard was cleared and claimed by another breaker while it read the lock
  const stale = holder(deadPid(), Date.now());
  const theirs = holder(process.pid, Date.now());
  fs.writeFileSync(lock, stale);
  const readFileSync = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === lock && ++reads === 1) fs.writeFileSync(breakGuardOf(lock), theirs);
    return Reflect.apply(readFileSync, fs, args);
  }) as typeof fs.readFileSync;
  let broke = true;
  try { broke = breakStale(lock, stale); } finally { fs.readFileSync = readFileSync; }
  t("a breaker whose guard became another breaker's inside its turn → false: the lock left, the other's guard left", () =>
    !broke && fs.readFileSync(lock, "utf8") === stale && fs.readFileSync(breakGuardOf(lock), "utf8") === theirs);
}

// Windows refusals that can be transient (a lock still delete-pending after its release), in a child that reports as
// win32 and refuses the create on cue — the timing is the point, so the four run side by side
console.log("possibly transient create refusals (Windows) — retried from the first refusal:");
{
  const d = mk();
  const run = (name: string, args: string[]): Promise<{ name: string; r: { ms: number; name: string; code: string } | null }> => new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, "transient", path.join(d, `${name}.lock`), ...args]);
    let out = "";
    p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    p.on("close", () => {
      try {
        const v: unknown = JSON.parse(out);
        resolve({ name, r: v !== null && typeof v === "object" && "ms" in v && "name" in v && "code" in v && typeof v.ms === "number" && typeof v.name === "string" && typeof v.code === "string" ? { ms: v.ms, name: v.name, code: v.code } : null });
      } catch { resolve({ name, r: null }); }
    });
  });
  // args: waitMs, how long the lock stays held (live), how long creating it is refused after (-1: always), lock|guard
  const [late, endless, short, guardEarly] = await Promise.all([
    run("late", ["6000", "2500", "300", "lock"]),
    run("endless", ["6000", "500", "-1", "lock"]),
    run("short", ["1000", "300", "-1", "lock"]),
    run("guard", ["1000", "0", "-1", "guard"]),
  ]);
  const show = (x: { name: string; r: unknown }): string => `${x.name} ${JSON.stringify(x.r)}`;
  t("a waiter 2.5 s in whose create is refused (EPERM) for 300 ms after the release → retried, the lock taken", () => late.r !== null && late.r.name === "acquired" && late.r.ms >= 2_700);
  t("…refused for good → EPERM thrown once the refusals have lasted 2 s (≈2.5 s), not before", () => endless.r !== null && endless.r.code === "EPERM" && endless.r.ms >= 2_400 && endless.r.ms < 5_000);
  t("…the wait (1 s) ends while the refusals are under 2 s old → LockBusy, not EPERM", () => short.r !== null && short.r.name === "LockBusy" && short.r.ms >= 900 && short.r.ms < 2_000);
  t("a dead holder's lock whose break guard cannot be created (EPERM) for the whole 1 s wait → LockBusy, not EPERM", () => guardEarly.r !== null && guardEarly.r.name === "LockBusy" && guardEarly.r.ms >= 900 && guardEarly.r.ms < 2_000);
  for (const x of [late, endless, short, guardEarly]) console.log(`    ${show(x)}`);
}

console.log("errors other than a held lock are thrown as they are:");
{
  const d = mk();
  const notDir = path.join(d, "file");
  fs.writeFileSync(notDir, "x");
  const e = caught(() => withFileLock(path.join(notDir, "x.lock"), () => 0));
  t("a lock under a path that is a file → that error (ENOTDIR / EEXIST), not LockBusy", () => e instanceof Error && !(e instanceof LockBusy));
  if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
    const ro = path.join(d, "ro");
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    const r = caught(() => withFileLock(path.join(ro, "x.lock"), () => 0));
    fs.chmodSync(ro, 0o755);
    t("a read-only directory → EACCES thrown at once (the caller maps it), not a wait", () => r instanceof Error && "code" in r && r.code === "EACCES");
  } else console.log("  (skipped: a read-only directory — mode bits refuse nothing on Windows / as root)");
}

// ---------------------------------------------------------------- real processes contending
console.log("real node processes contending for one counter:");
{
  const d = mk();
  const counter = path.join(d, "counter.txt");
  fs.writeFileSync(counter, "0");
  const N = 6, K = 25;
  const runs = Array.from({ length: N }, () => new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn(process.execPath, [CHILD, "counter", lockFileOf(counter), counter, String(K)]);
    let err = "";
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("close", (code) => resolve({ code, err }));
  }));
  const results = await Promise.all(runs);
  const final = Number(fs.readFileSync(counter, "utf8"));
  t(`${N} processes × ${K} locked read-nap-write increments → the counter is exactly ${N * K} (no lost update), every child exits 0`, () =>
    final === N * K && results.every((r) => r.code === 0));
  if (final !== N * K || results.some((r) => r.code !== 0)) console.log(`    counter ${final}; ${results.map((r) => `${r.code}${r.err ? `: ${r.err.split("\n")[0]}` : ""}`).join(" | ")}`);
  t("…and the lock is gone afterwards", () => !fs.existsSync(lockFileOf(counter)));
}

// Waiters racing to break dead holders' locks: a "crasher" keeps leaving a dead pid's lock behind whenever the lock is
// free, and every worker marks its locked section with an O_EXCL marker file — an EEXIST there is two holders at once.
console.log("waiters racing to break dead holders' locks:");
{
  const d = mk();
  const lock = path.join(d, "x.lock"), marker = path.join(d, "inside");
  const until = String(Date.now() + 4_000);
  const dead = String(deadPid());
  const run = (args: string[]): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const p = spawn(process.execPath, [CHILD, ...args]);
    let out = "";
    p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    p.on("close", (code) => resolve({ code, out }));
  });
  const [crasher, ...workers] = await Promise.all([run(["crasher", lock, until, dead]), ...Array.from({ length: 6 }, () => run(["worker", lock, marker, until]))]);
  let rounds = 0, overlaps = 0;
  for (const w of workers) {
    try { const v: unknown = JSON.parse(w.out); if (v && typeof v === "object" && "rounds" in v && "overlaps" in v && typeof v.rounds === "number" && typeof v.overlaps === "number") { rounds += v.rounds; overlaps += v.overlaps; } } catch { overlaps += 1_000; }
  }
  t(`6 workers × 4 s against a crasher → ${rounds} locked sections, never two holders at once (${overlaps} overlaps), every child exits 0`, () =>
    overlaps === 0 && rounds > 20 && crasher?.code === 0 && workers.every((w) => w.code === 0));
  t("…no break guard is left behind", () => !fs.existsSync(breakGuardOf(lock)));
}

// ---------------------------------------------------------------- updateJsonLike
console.log("updateJsonLike — a locked read-modify-write in the file's own format:");
{
  const d = mk();
  const f = path.join(d, "plan.json");
  fs.writeFileSync(f, "\ufeff{\r\n    \"a\": 1\r\n}\r\n");
  let raws: Array<string | null> = [];
  const w1 = updateJsonLike(f, (raw) => { raws.push(raw); return { a: 1, b: 2 }; });
  t("fn gets the file's bytes; the new value keeps its BOM, 4-space indent and CRLF; true when written; the lock is gone", () =>
    w1 && raws.length === 1 && raws[0] === "\ufeff{\r\n    \"a\": 1\r\n}\r\n" && fs.readFileSync(f, "utf8") === "\ufeff{\r\n    \"a\": 1,\r\n    \"b\": 2\r\n}\r\n" && !fs.existsSync(lockFileOf(f)));
  const before = fs.statSync(f).mtimeMs;
  t("the same value again → false, the file untouched", () => !updateJsonLike(f, () => ({ a: 1, b: 2 })) && fs.statSync(f).mtimeMs === before);
  const g = path.join(d, "new", "plan.json");
  raws = [];
  t("no file yet → fn gets null; written with 2 spaces and a final newline", () => updateJsonLike(g, (raw) => { raws.push(raw); return { x: 1 }; }) && raws[0] === null && fs.readFileSync(g, "utf8") === "{\n  \"x\": 1\n}\n");
  // a writer that takes no lock (an agent's Edit) lands while fn runs: the update starts over from its bytes
  const h = path.join(d, "edited.json");
  fs.writeFileSync(h, "{\n  \"n\": 1\n}\n");
  let calls = 0;
  const wh = updateJsonLike(h, (raw) => {
    calls++;
    const doc: unknown = JSON.parse(raw ?? "{}");
    if (calls === 1) fs.writeFileSync(h, "{\n  \"n\": 1,\n  \"edit\": \"by hand\"\n}\n");
    return typeof doc === "object" && doc !== null ? { ...doc, tool: true } : doc;
  });
  t("an edit made while fn ran (no lock) → fn runs again on the edited bytes; both the edit and the update are kept", () =>
    wh && calls === 2 && fs.readFileSync(h, "utf8") === "{\n  \"n\": 1,\n  \"edit\": \"by hand\",\n  \"tool\": true\n}\n");
  let spins = 0;
  const e = caught(() => updateJsonLike(h, () => { spins++; fs.writeFileSync(h, `{"spin": ${spins}}\n`); return { mine: true }; }));
  t("a file that changes on every try → throws after 3 tries; the last outside edit stays, the lock is gone", () =>
    e instanceof Error && /kept changing .*3 tries/.test(e.message) && spins === 3 && fs.readFileSync(h, "utf8") === "{\"spin\": 3}\n" && !fs.existsSync(lockFileOf(h)));
  // an existing file that cannot be read is never taken for an absent one
  const dir = path.join(d, "is-a-dir.json");
  fs.mkdirSync(dir);
  const ed = caught(() => updateJsonLike(dir, () => ({ x: 1 })));
  t("an unreadable target (a directory) → its read error is thrown, nothing written", () => ed instanceof Error && "code" in ed && ed.code === "EISDIR" && fs.statSync(dir).isDirectory());
  if (process.platform !== "win32" && !(typeof process.getuid === "function" && process.getuid() === 0)) {
    const locked = path.join(d, "no-read.json");
    fs.writeFileSync(locked, "{\"keep\": true}\n");
    fs.chmodSync(locked, 0o000);
    const ea = caught(() => updateJsonLike(locked, () => ({ x: 1 })));
    fs.chmodSync(locked, 0o644);
    t("a file this process may not read → EACCES thrown, the file never replaced as if absent", () => ea instanceof Error && "code" in ea && ea.code === "EACCES" && fs.readFileSync(locked, "utf8") === "{\"keep\": true}\n");
  } else console.log("  (skipped: an unreadable file — mode bits refuse nothing on Windows / as root)");
  // a lock file the caller names, and a step that runs right after the write, under the lock, only when written
  const named = path.join(d, "locks", "named.lock");
  const seen: string[] = [];
  const wn = updateJsonLike(g, () => ({ x: 2 }), { lockFile: named, afterWrite: () => { seen.push(`${fs.existsSync(named) ? "locked" : "unlocked"}:${fs.readFileSync(g, "utf8").includes("2") ? "written" : "old"}`); } });
  const wn2 = updateJsonLike(g, () => ({ x: 2 }), { lockFile: named, afterWrite: () => { seen.push("unchanged"); } });
  t("opts.lockFile is the lock held (none beside the file); afterWrite runs after the write, under that lock, and not when nothing changed", () =>
    wn && !wn2 && seen.join(" ") === "locked:written" && !fs.existsSync(lockFileOf(g)) && !fs.existsSync(named));
  // the lock is held: a second writer waits, then LockBusy
  fs.writeFileSync(lockFileOf(f), holder(process.pid, Date.now()));
  const eb = caught(() => updateJsonLike(f, () => ({ z: 1 }), { waitMs: 100 }));
  t("a held lock → LockBusy, the file unchanged", () => eb instanceof LockBusy && fs.readFileSync(f, "utf8") === "\ufeff{\r\n    \"a\": 1,\r\n    \"b\": 2\r\n}\r\n");
  fs.rmSync(lockFileOf(f));
}

// acquireFileLock: the lower-level form a caller uses to treat only the lock's own errors specially
{
  const d = mk();
  const lock = path.join(d, "x.lock");
  const lock1 = acquireFileLock(lock);
  const held = fs.existsSync(lock);
  lock1.release();
  lock1.release(); // twice: the second finds no lock of its own and does nothing
  t("acquireFileLock returns a release; releasing twice is harmless", () => held && !fs.existsSync(lock));
}

// processState: a record that outlives a lock (a probe's own run) judged the way a lock holder is
console.log("processState — the holder judgement for a stamped process:");
{
  const me = thisProcess();
  t("thisProcess: this pid and host (and the pid namespace on Linux)", () => me.pid === process.pid && me.host === os.hostname() && (me.ns ?? "") === PID_NS);
  t("this process → alive; a finished child on this host → gone", () => processState(me) === "alive" && processState({ ...me, pid: deadPid() }) === "gone");
  t("another host, another pid namespace, or no usable pid → unknown (nothing to probe), never gone", () =>
    processState({ ...me, pid: deadPid(), host: "another-host.invalid" }) === "unknown" && processState({ ...me, pid: deadPid(), ns: "pid:[1]" }) === "unknown"
    && processState({ ...me, pid: 0 }) === "unknown" && processState({ ...me, pid: -1 }) === "unknown");
}
for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
report();
