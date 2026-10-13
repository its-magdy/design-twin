// The shared lock file (bridge/src/file-lock.ts) and the locked JSON update over it (bridge/src/json-file.ts
// updateJsonLike): held and released, released on a throw, a live holder waited for then LockBusy, a stale lock
// (too old, a dead pid, never written) broken, a fresh one never removed by a waiter or a releaser that lost it, and
// real node processes contending for one counter. Temp dirs only; binds no port.
// Run with:  node test/file-lock.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { LockBusy, acquireFileLock, breakStale, lockFileOf, withFileLock } from "../bridge/src/file-lock.ts";
import { updateJsonLike } from "../bridge/src/json-file.ts";

const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};
const roots: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-lock-")); roots.push(d); return d; };
const holder = (pid: number, at: number, host = os.hostname()): string => JSON.stringify({ pid, host, at, token: "feedfacefeedface" });
/** A pid that existed and has exited (a finished child). */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return typeof r.pid === "number" ? r.pid : 999_999;
};
const caught = (fn: () => unknown): unknown => { try { fn(); return null; } catch (e) { return e; } };

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
  const releaser = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").rmSync(${JSON.stringify(lock)}, { force: true }), 200)`]);
  const t1 = Date.now();
  const got = withFileLock(lock, () => "mine", { waitMs: 5_000 });
  t("a holder that releases while we wait → the lock is taken then (not LockBusy)", () => got === "mine" && Date.now() - t1 >= 100);
  releaser.kill();
}

console.log("a stale lock — broken and taken:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  fs.writeFileSync(lock, holder(process.pid, Date.now() - 60_000));
  t("older than staleMs (a live pid, 60 s old, staleMs 30 s) → broken, fn runs, released after", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }) && !fs.existsSync(lock));
  fs.writeFileSync(lock, holder(process.pid, Date.now() + 60_000));
  t("a time far in the future (a clock that jumped back) → stale too", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }));
  fs.writeFileSync(lock, holder(deadPid(), Date.now()));
  t("a fresh lock whose holder pid no longer exists (same host) → broken at once", () => withFileLock(lock, () => true, { waitMs: 100 }));
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  t("an empty lock whose mtime is older than staleMs → broken", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }));
  fs.writeFileSync(lock, "{not json");
  fs.utimesSync(lock, old, old);
  t("an unreadable holder (not JSON) with an old mtime → broken", () => withFileLock(lock, () => true, { staleMs: 30_000, waitMs: 100 }));
  t("no stale copies are left beside the lock", () => fs.readdirSync(d).length === 0);
}

console.log("breakStale never removes a fresh lock; a release never removes another holder's:");
{
  const d = mk();
  const lock = path.join(d, "s.json.lock");
  const stale = holder(deadPid(), Date.now() - 60_000);
  const fresh = holder(process.pid, Date.now());
  // judged stale from bytes read earlier, but another waiter has broken it and taken a fresh one since
  fs.writeFileSync(lock, fresh);
  breakStale(lock, stale);
  t("the lock on disk is no longer the one judged stale → put back unchanged, nothing left beside it", () => fs.readFileSync(lock, "utf8") === fresh && fs.readdirSync(d).join() === "s.json.lock");
  fs.writeFileSync(lock, stale);
  breakStale(lock, stale);
  t("…still the one judged stale → removed", () => !fs.existsSync(lock) && fs.readdirSync(d).length === 0);
  // a holder whose lock was broken (it ran past staleMs) and taken by another: its release leaves the new one
  const taken = holder(process.pid, Date.now());
  withFileLock(lock, () => { fs.writeFileSync(lock, taken); });
  t("a release whose lock was taken over by another holder leaves that holder's lock", () => fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === taken);
  fs.rmSync(lock, { force: true });
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
  const CHILD = path.join(import.meta.dirname, "lock-child.ts");
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

// ---------------------------------------------------------------- updateJsonLike
console.log("updateJsonLike — a locked read-modify-write in the file's own format:");
{
  const d = mk();
  const f = path.join(d, "plan.json");
  fs.writeFileSync(f, "﻿{\r\n    \"a\": 1\r\n}\r\n");
  let raws: Array<string | null> = [];
  const w1 = updateJsonLike(f, (raw) => { raws.push(raw); return { a: 1, b: 2 }; });
  t("fn gets the file's bytes; the new value keeps its BOM, 4-space indent and CRLF; true when written; the lock is gone", () =>
    w1 && raws.length === 1 && raws[0] === "﻿{\r\n    \"a\": 1\r\n}\r\n" && fs.readFileSync(f, "utf8") === "﻿{\r\n    \"a\": 1,\r\n    \"b\": 2\r\n}\r\n" && !fs.existsSync(lockFileOf(f)));
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
  // the lock is held: a second writer waits, then LockBusy
  fs.writeFileSync(lockFileOf(f), holder(process.pid, Date.now()));
  const eb = caught(() => updateJsonLike(f, () => ({ z: 1 }), { waitMs: 100 }));
  t("a held lock → LockBusy, the file unchanged", () => eb instanceof LockBusy && fs.readFileSync(f, "utf8") === "﻿{\r\n    \"a\": 1,\r\n    \"b\": 2\r\n}\r\n");
  fs.rmSync(lockFileOf(f));
}

// acquireFileLock: the lower-level form a caller uses to treat only the lock's own errors specially
{
  const d = mk();
  const lock = path.join(d, "x.lock");
  const release = acquireFileLock(lock);
  const held = fs.existsSync(lock);
  release();
  release(); // twice: the second finds no lock of its own and does nothing
  t("acquireFileLock returns a release; releasing twice is harmless", () => held && !fs.existsSync(lock));
}

for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
report();
