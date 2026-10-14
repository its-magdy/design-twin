// A separate process for the lock tests (file-lock, verify-run, plan-record): another writer contending for the same
// lock, the way a second tool run would. Not a suite. Usage:
//   node test/lock-child.ts counter <lockFile> <counterFile> <iterations>   locked read → nap 1 ms → write +1
//   node test/lock-child.ts status <base> <who> <iterations>                 writeStatus(base) of run-cc; prints the revs
//   node test/lock-child.ts end-run <base> <readyFile> <goFile>              holds base's status lock (then writes readyFile);
//                                                                           on goFile, ends the run (failed, "gave up") and releases
//   node test/lock-child.ts waive <plan> <who> <iterations>                  updatePlan(plan) adding one waiver row each time
//   node test/lock-child.ts hold <lockFile> <readyFile> <ms>                takes the lock (staleMs 300), writes readyFile, holds
//                                                                           it <ms>, writes <readyFile>.done, then releases
//   node test/lock-child.ts try <lockFile> <waitMs>                         one acquire; prints {"ms", "name", "code"} of how it ended
//   node test/lock-child.ts crasher <lockFile> <untilMs> <deadPid>          until untilMs, every 2 ms: when the lock is free, takes
//                                                                           it as a holder that died at once (deadPid)
//   node test/lock-child.ts worker <lockFile> <markerFile> <untilMs>        until untilMs: lock → create markerFile O_EXCL (EEXIST:
//                                                                           another holder is inside) → nap 1 ms → remove → release;
//                                                                           prints {"rounds", "overlaps"}
//   node test/lock-child.ts transient <lockFile> <waitMs> <busyMs> <refuseMs> lock|guard
//                                                                           reports as win32; "lock": a live lock (this pid)
//                                                                           held busyMs, then released, and creating it refused
//                                                                           (EPERM) refuseMs (-1: always); "guard": a dead
//                                                                           holder's lock whose break guard is always refused;
//                                                                           one acquire, printed like "try"
import fs from "node:fs";
import os from "node:os";
import { PID_NS, acquireFileLock, withFileLock } from "../bridge/src/file-lock.ts";
import type { HeldLock } from "../bridge/src/file-lock.ts";
import { lockFileOfStatus, liveStatusFile, isVerifyStatusV2, writeStatus } from "../design-to-code/verify-run.ts";
import { parsePlanText, updatePlan } from "../design-to-code/plan-record.ts";

const nap = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => { Atomics.wait(nap, 0, 0, ms); };
const [mode, a = "", b = "", c = ""] = process.argv.slice(2);

if (mode === "counter") {
  for (let i = 0; i < Number(c); i++) withFileLock(a, () => {
    const n = Number(fs.readFileSync(b, "utf8"));
    sleepSync(1); // a wide read-to-write window: without the lock, two children read the same n
    fs.writeFileSync(b, String(n + 1));
  }, { waitMs: 60_000 });
} else if (mode === "status") {
  const revs: number[] = [];
  for (let i = 0; i < Number(c); i++) revs.push(writeStatus(a, { runId: "run-cc", phase: "driving", by: "agent", detail: `${b} ${i}` }).rev);
  process.stdout.write(revs.join(","));
} else if (mode === "end-run") {
  const live = liveStatusFile(a);
  const lock = acquireFileLock(lockFileOfStatus(a));
  fs.writeFileSync(b, "");
  for (const t0 = Date.now(); !fs.existsSync(c) && Date.now() - t0 < 20_000;) sleepSync(20);
  const prev: unknown = JSON.parse(fs.readFileSync(live, "utf8"));
  if (!isVerifyStatusV2(prev)) throw new Error(`${live} is not a status v2`);
  fs.writeFileSync(live, JSON.stringify({ ...prev, rev: prev.rev + 1, phase: "failed", detail: "gave up", by: "orchestrator" }, null, 2) + "\n");
  lock.release();
} else if (mode === "waive") {
  for (let i = 0; i < Number(c); i++) updatePlan(a, (raw) => {
    if (raw === null) throw new Error(`${a} does not exist`);
    const p = parsePlanText(raw, a);
    sleepSync(2);
    p.waivers = [...(p.waivers ?? []), { nodeId: `${b}:${i}`, field: "width", designed: 1, built: 2, exportContentSha256: "x", reason: "r", decidedBy: "d", decidedAt: "t" }];
    return p;
  }, { waitMs: 60_000 });
} else if (mode === "hold") {
  const lock = acquireFileLock(a, { staleMs: 300 });
  fs.writeFileSync(b, "");
  sleepSync(Number(c));
  fs.writeFileSync(b + ".done", "");
  lock.release();
} else if (mode === "try") {
  const t0 = Date.now();
  let name = "acquired", code = "";
  try { acquireFileLock(a, { waitMs: Number(b) }).release(); } catch (e) {
    name = e instanceof Error ? e.name : "?";
    code = e !== null && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "";
  }
  process.stdout.write(JSON.stringify({ ms: Date.now() - t0, name, code }));
} else if (mode === "crasher") {
  for (let n = 0; Date.now() < Number(b); n++) {
    try {
      const fd = fs.openSync(a, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: Number(c), host: os.hostname(), at: Date.now(), token: `dead${n}`, ns: PID_NS }));
      fs.closeSync(fd);
    } catch { /* held */ }
    sleepSync(2);
  }
} else if (mode === "worker") {
  let rounds = 0, overlaps = 0;
  while (Date.now() < Number(c)) {
    let lock: HeldLock;
    try { lock = acquireFileLock(a, { waitMs: 2_000 }); } catch { continue; }
    let fd: number | null = null;
    try { fd = fs.openSync(b, "wx"); } catch { overlaps++; }
    sleepSync(1);
    if (fd !== null) { fs.closeSync(fd); fs.rmSync(b, { force: true }); }
    lock.release();
    rounds++;
  }
  process.stdout.write(JSON.stringify({ rounds, overlaps }));
} else if (mode === "transient") {
  const [, , , , refuseArg = "-1", kind = "lock"] = process.argv.slice(2);
  const busyMs = Number(c), refuseMs = Number(refuseArg);
  const guard = a + ".break";
  // "guard": another host's lock a minute old — a dead holder's whatever pid it names
  fs.writeFileSync(a, JSON.stringify(kind === "guard" ? { pid: process.pid, host: "another-host.invalid", at: Date.now() - 60_000, token: "child" }
    : { pid: process.pid, host: os.hostname(), at: Date.now(), token: "child", ns: PID_NS }));
  Object.defineProperty(process, "platform", { value: "win32" });
  const t0 = Date.now();
  let refusedFrom: number | null = null;
  const openSync = fs.openSync;
  const eperm = (p: string): Error => Object.assign(new Error(`EPERM: operation not permitted, open '${p}'`), { code: "EPERM" });
  fs.openSync = (...args: Parameters<typeof fs.openSync>): number => {
    const [p, flags] = args;
    if (flags === "wx" && kind === "guard" && p === guard) throw eperm(guard);
    if (flags === "wx" && kind === "lock" && p === a && Date.now() - t0 >= busyMs) {
      if (refusedFrom === null) { refusedFrom = Date.now(); fs.rmSync(a, { force: true }); } // released, still delete-pending
      if (refuseMs < 0 || Date.now() - refusedFrom < refuseMs) throw eperm(a);
    }
    return Reflect.apply(openSync, fs, args);
  };
  let name = "acquired", code = "";
  try { acquireFileLock(a, { waitMs: Number(b) }).release(); } catch (e) {
    name = e instanceof Error ? e.name : "?";
    code = e !== null && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "";
  }
  process.stdout.write(JSON.stringify({ ms: Date.now() - t0, name, code }));
} else {
  console.error(`lock-child: unknown mode '${mode ?? ""}'`);
  process.exitCode = 2;
}
