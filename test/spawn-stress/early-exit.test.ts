// oven-sh/bun #45483 under `bun test` (where it was reported, macOS): the raw pattern — an exit listener attached right after
// spawn() — next to the helper, which must always settle with the status. A bun:test file, NOT a run-suites suite: it lives
// below test/, where the runner's coverage guard (test/*.test.ts, one level) does not look, and only the spawn-stress
// workflow runs it:
//   bun test --rerun-each=300 -t '^raw' test/spawn-stress/early-exit.test.ts      the repro (fails where the bug lives)
//   bun test --rerun-each=300 -t '^helper' test/spawn-stress/early-exit.test.ts   the gate
// The child is this bun (`-e "process.exit(2)"`), so it runs the same on every OS.
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { runAsync } from "../../design-to-code/proc.ts";

const ARGS = ["-e", "process.exit(2)"];

test("raw: exit listener attached after spawn()", async () => {
  const c = spawn(process.execPath, ARGS);
  const code = await Promise.race([
    new Promise<number | null>((r) => c.on("exit", (n) => r(n))),
    new Promise<string>((r) => setTimeout(() => r(c.exitCode !== null ? `LOST(exitCode=${c.exitCode})` : "HANG"), 5000)),
  ]);
  expect(code).toBe(2);
}, 10_000);

test("helper: always settles with the status", async () => {
  const r = await runAsync(process.execPath, ARGS, { timeoutMs: 8000 }).done;
  expect(r.status).toBe(2);
  expect(r.lost).toBeUndefined();
}, 10_000);
