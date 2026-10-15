// Ending a process this one started, with what it started — by pid, never by name. verify-probe ends its browser this way
// when the browser does not go; the test pool ends a run it killed and the browsers that run left.
//
//   killPidTree(pid)             // POSIX: SIGKILL to the process group pid leads; Windows: taskkill /T /F /PID pid
//   await killChildTree(pid)     // that, for a child of this process (or, pid unknown, every direct child of it)
//
// Each takes a host stand-in (KillHost / ProcHost), so both platforms' branches are testable on any OS without a live kill.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** What killPidTree needs from the host: its platform, a way to run taskkill (spawnSync's result: `error` when it could not
 *  start or hit its timeout, `status` its exit code) and a way to signal a pid (process.kill: throws when there is no such
 *  process or group). The tests pass their own. KILL_HOST's taskkill is capped at 10 s. */
export interface KillHost {
  platform: NodeJS.Platform;
  taskkill: (args: string[]) => { error?: Error; status: number | null };
  kill: (pid: number, signal: NodeJS.Signals) => void;
}
/** The real taskkill: hidden, capped at `capMs` (it blocks the event loop while it runs). */
export const taskkillCapped = (capMs: number): KillHost["taskkill"] => (args) => spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: capMs });
export const KILL_HOST: KillHost = {
  platform: process.platform,
  taskkill: taskkillCapped(10_000),
  kill: (pid, s) => { process.kill(pid, s); },
};

/** Ends the process `pid` and its descendants; false when that did not happen (the caller can then kill what it holds).
 *  POSIX: SIGKILL to the process group `pid` leads (the test pool spawns its child detached for that; Playwright spawns its
 *  browser detached) — false when there is no such group. Windows has no groups: `taskkill /T /F /PID <pid>` ends the process
 *  and the processes it started — false when taskkill does not start or exits non-zero (spawnSync reports both, it never
 *  throws). A pid below 2 is refused, false at once with nothing signalled (POSIX: -0 is this process's group, -1 every
 *  process; a child's or a browser's pid is never 1). */
export const killPidTree = (pid: number, host: KillHost = KILL_HOST): boolean => {
  if (!(pid > 1)) return false;
  if (host.platform === "win32") { const r = host.taskkill(["/T", "/F", "/PID", String(pid)]); return r.error === undefined && r.status === 0; }
  try { host.kill(-pid, "SIGKILL"); return true; } catch { return false; }
};

/** What killChildTree needs beyond KillHost: this process's pid, procfs reads (Linux; each throws when the path is absent),
 *  a command run capped at `timeoutMs` (spawnSync's result: `error` when it did not start or timed out) and whether a pid
 *  exists (process.kill(pid, 0)). The tests pass their own. */
export interface ProcHost extends KillHost {
  self: number;
  readdir: (dir: string) => string[];
  readFile: (file: string) => string;
  run: (cmd: string, args: string[], timeoutMs: number) => { error?: Error; status: number | null; stdout: string };
  exists: (pid: number) => boolean;
}
export const PROC_HOST: ProcHost = {
  ...KILL_HOST,
  self: process.pid,
  readdir: (dir) => fs.readdirSync(dir),
  readFile: (file) => fs.readFileSync(file, "utf8"),
  run: (cmd, args, timeoutMs) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return { ...(r.error !== undefined ? { error: r.error } : {}), status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
  },
  exists: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
};

const pidsIn = (text: string): number[] => text.split(/\s+/).filter((w) => /^\d+$/.test(w)).map(Number);

/** The parent pid of `pid` from /proc/<pid>/stat (Linux procfs: field 4, after the parenthesised command, which may itself
 *  hold spaces and parentheses), or undefined when that file cannot be read or parsed. */
export function parentPid(pid: number, host: Pick<ProcHost, "readFile"> = PROC_HOST): number | undefined {
  let stat: string;
  try { stat = host.readFile(`/proc/${pid}/stat`); } catch { return undefined; }
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
}
const notFound = (e: Error | undefined): boolean => e !== undefined && "code" in e && e.code === "ENOENT";

/** The pids of this process's direct children, or null when they cannot be listed. Linux: a scan of /proc/<pid>/stat for
 *  the parent pid (field 4, after the parenthesised command) — in-process reads, no command to wait on (not the
 *  /proc/<pid>/task/<tid>/children files: absent without CONFIG_PROC_CHILDREN, and a child exiting during the read can drop
 *  others from the list). Elsewhere, and on a Linux without /proc: `pgrep -P <self>` (exit 0 matched, 1 none matched),
 *  capped at `capMs`; only when pgrep is missing, `ps -A -o pid=,ppid=` with the same cap. A pgrep that timed out or failed
 *  is null — a ps would fare no better. Windows: null (no process table to read). */
export function childPids(host: ProcHost = PROC_HOST, capMs = 3_000): number[] | null {
  if (host.platform === "win32") return null;
  if (host.platform === "linux") {
    let entries: string[] | null = null;
    try { entries = host.readdir("/proc"); } catch { /* no procfs: pgrep below */ }
    if (entries !== null) {
      const kids: number[] = [];
      for (const e of entries) {
        if (!/^\d+$/.test(e)) continue;
        if (parentPid(Number(e), host) === host.self) kids.push(Number(e)); // undefined: gone since the listing
      }
      return kids;
    }
  }
  const pg = host.run("pgrep", ["-P", String(host.self)], capMs);
  if (pg.error === undefined && (pg.status === 0 || pg.status === 1)) return pidsIn(pg.stdout);
  if (!notFound(pg.error)) return null;
  const ps = host.run("ps", ["-A", "-o", "pid=,ppid="], capMs);
  if (ps.error !== undefined || ps.status !== 0) return null;
  const kids: number[] = [];
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m && Number(m[2]) === host.self) kids.push(Number(m[1]));
  }
  return kids;
}

/** How often killChildTree looks whether what it waits for has gone. */
const POLL_MS = 50;

/** Ends the child `pid` of this process (one it launched) and what that child started. Never throws; meant for a process
 *  whose only children are the ones it wants gone. `pid` unknown: this process's direct children (childPids) instead.
 *  First waits up to `graceMs` for them to exit on their own (a browser told to quit usually goes within it), then:
 *  POSIX: SIGKILL to the group each leads (one that has exited may have left its group running: that ends it); when the
 *  known `pid` is still running but leads no group (a wrapper's child), each direct child is ended so instead, or alone
 *  when it leads no group. A group kill is safe after the leader `pid` has exited: a process group id is not reused while
 *  any member of that group lives, so the signal reaches only what the browser started (orphaned descendants included);
 *  with no member left there is no such group (ESRCH) unless the pid has since been given to a new group leader, which
 *  needs the pid space to cycle within the grace — POSIX hands pids out in sequence and wraps only at its maximum.
 *  Windows: `taskkill /T /F /PID <pid>` while that pid exists; nothing when `pid` is unknown (there is no process table to
 *  read) or when `exited` says the caller knows `pid` has exited. Windows may give an ended process's pid to a new
 *  process as soon as no handle to the old one is open, and then exists() is true of the new owner and /T would end its
 *  tree; while this process still holds the child's handle (it has not seen the exit) the pid is not reused. What remains
 *  is a child the caller still takes for running (a wedged but connected browser) that exits, and is reaped, between the
 *  caller's check, the exists() check and the taskkill — a window of one command start.
 *  A pgrep/ps is capped at `capMs`, a taskkill at the host's own cap. */
export async function killChildTree(pid: number | undefined, host: ProcHost = PROC_HOST,
  { capMs = 3_000, graceMs = 0, exited = false }: { capMs?: number; graceMs?: number; exited?: boolean } = {}): Promise<void> {
  const known = pid !== undefined && pid > 1 ? pid : undefined;
  if (host.platform === "win32" && (known === undefined || exited)) return;
  const targets = known !== undefined ? [known] : childPids(host, capMs) ?? [];
  const until = Date.now() + graceMs;
  while (targets.some((t) => host.exists(t)) && Date.now() < until) await sleep(POLL_MS);
  if (host.platform === "win32") {
    if (known !== undefined && host.exists(known)) killPidTree(known, host);
    return;
  }
  const end = (t: number): void => {
    if (killPidTree(t, host) || !host.exists(t)) return;
    try { host.kill(t, "SIGKILL"); } catch { /* gone already */ }
  };
  if (known === undefined) { for (const t of targets) end(t); return; }
  if (killPidTree(known, host) || !host.exists(known)) return;
  for (const t of childPids(host, capMs) ?? []) end(t);
}
