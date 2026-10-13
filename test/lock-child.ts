// A separate process for the lock tests (file-lock, verify-run, plan-record): another writer contending for the same
// lock, the way a second tool run would. Not a suite. Usage:
//   node test/lock-child.ts counter <lockFile> <counterFile> <iterations>   locked read → nap 1 ms → write +1
//   node test/lock-child.ts status <base> <who> <iterations>                 writeStatus(base) of run-cc; prints the revs
//   node test/lock-child.ts end-run <base> <readyFile> <goFile>              holds base's status lock (then writes readyFile);
//                                                                           on goFile, ends the run (failed, "gave up") and releases
//   node test/lock-child.ts waive <plan> <who> <iterations>                  updatePlan(plan) adding one waiver row each time
import fs from "node:fs";
import { acquireFileLock, withFileLock } from "../bridge/src/file-lock.ts";
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
  const release = acquireFileLock(lockFileOfStatus(a));
  fs.writeFileSync(b, "");
  for (const t0 = Date.now(); !fs.existsSync(c) && Date.now() - t0 < 20_000;) sleepSync(20);
  const prev: unknown = JSON.parse(fs.readFileSync(live, "utf8"));
  if (!isVerifyStatusV2(prev)) throw new Error(`${live} is not a status v2`);
  fs.writeFileSync(live, JSON.stringify({ ...prev, rev: prev.rev + 1, phase: "failed", detail: "gave up", by: "orchestrator" }, null, 2) + "\n");
  release();
} else if (mode === "waive") {
  for (let i = 0; i < Number(c); i++) updatePlan(a, (raw) => {
    if (raw === null) throw new Error(`${a} does not exist`);
    const p = parsePlanText(raw, a);
    sleepSync(2);
    p.waivers = [...(p.waivers ?? []), { nodeId: `${b}:${i}`, field: "width", designed: 1, built: 2, exportContentSha256: "x", reason: "r", decidedBy: "d", decidedAt: "t" }];
    return p;
  }, { waitMs: 60_000 });
} else {
  console.error(`lock-child: unknown mode '${mode ?? ""}'`);
  process.exitCode = 2;
}
