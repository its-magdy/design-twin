// A design-to-code CLI as a suite runs it: real children where the process surface is what is checked, its exported
// main() in-process everywhere else.
//
//   const audit = cliRunner(path.join(D2C, "audit.ts"), auditMain);
//   const r = audit([screen, "--platform", "ios"], { cwd });          // { status, stdout, stderr }
//
// A Bun child costs ~30 ms of start-up, most of a CLI-heavy suite's time. So the first `spawnFirst` runs of a runner (and
// further runs, a few at most, until one has exited 0) are real children (proc.ts runSync: the CLI end to end — argv, the exit code after the output, the streams), and every
// later run calls the module's main(argv) inside the suite's process (test/in-process.ts runMainSync: the same argv, cwd,
// stdout/stderr and exit code, process.exit turned into a return). An in-process run is then run again as a child, and the
// child's result is the one returned, when its exit code — 0 included — is one no child of this runner has produced yet
// (so every exit code a suite meets comes from a real process at least once), and whenever main THREW (an uncaught error
// is exit 1 with a stack: a crash in-process — state another check left in this process, say — must not pass for the
// exit 1 a child gave earlier for a real reason; the child shows whether the CLI really crashes). Re-running is safe for
// what ends that way here (a usage error, a refusal, a failed check: nothing or the same files written); a child whose
// code differs from the in-process run's throws, naming both — pass { spawn: true } for a call that cannot run twice.
// Always a real child: `spawn: true`, an `env` or `input` of its own (main() would see this process's), the runner's
// `spawnIf(args)` (a mode whose main returns a Promise, which cannot run synchronously; a main that returns one anyway is
// an error of the suite, thrown), and every run under DT_SPAWN=1 (the whole surface as children, e.g. to bisect a
// difference). DT_SPAWN_STATS=1 prints, per runner at exit, how many runs went which way and the codes children covered.
import path from "node:path";
import { runSync } from "../design-to-code/proc.ts";
import { runMainSync } from "./in-process.ts";

export interface CliResult { status: number | null; stdout: string; stderr: string }
export interface CliOpts { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; spawn?: boolean; timeoutMs?: number }
type Main = (argv: string[]) => number | Promise<number>;

const SPAWN_ALL = process.env.DT_SPAWN === "1";
const stats: Array<{ label: string; spawned: number; inProc: number; codes: Set<number | null> }> = [];
process.on("exit", () => {
  if (!process.env.DT_SPAWN_STATS) return;
  for (const s of stats) process.stderr.write(`[cli-runner] ${s.label}: ${s.spawned} spawned (exit codes ${[...s.codes].join(", ") || "none"}), ${s.inProc} in-process\n`);
});

/** `script` is the CLI's source (design-to-code/<name>.ts); `main` its exported main (null: always a child). */
export function cliRunner(script: string, main: Main | null,
  { spawnFirst = 2, label = path.basename(script), spawnIf }: { spawnFirst?: number; label?: string; spawnIf?: (args: string[]) => boolean } = {}):
  (args: string[], o?: CliOpts) => CliResult {
  const s = { label, spawned: 0, inProc: 0, codes: new Set<number | null>() };
  stats.push(s);
  const child = (args: string[], o: CliOpts): CliResult => {
    s.spawned++;
    const r = runSync(process.execPath, [script, ...args], { ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(o.env !== undefined ? { env: o.env } : {}), ...(o.input !== undefined ? { input: o.input } : {}), timeoutMs: o.timeoutMs ?? 120_000 });
    s.codes.add(r.status);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr + (r.lost ? `\n[cli-runner] ${r.lost}\n` : "") };
  };
  return (args, o = {}) => {
    if (main === null || SPAWN_ALL || o.spawn || o.env !== undefined || o.input !== undefined || spawnIf?.(args) === true
      || s.spawned < spawnFirst || (!s.codes.has(0) && s.spawned < spawnFirst + 6)) return child(args, o); // exit 0 from a child too
    let promised = false, threw = false;
    const r = runMainSync((argv) => {
      let v: number | Promise<number>;
      // process.exit(n) reaches here as a throw too (runMainSync's Exit): that is an exit, not a crash
      try { v = main(argv); } catch (e) { threw = !(e instanceof Error && e.constructor.name === "Exit" && /^process\.exit\(/.test(e.message)); throw e; }
      if (typeof v === "number") return v;
      promised = true;
      v.catch(() => undefined);
      return -1;
    }, args, o.cwd !== undefined ? { cwd: o.cwd } : {});
    if (promised) throw new Error(`cli-runner: ${label} ${args.join(" ")} returned a Promise in-process — spawn that mode (spawnIf)`);
    s.inProc++;
    if (!threw && s.codes.has(r.status)) return { status: r.status, stdout: r.out, stderr: r.err };
    const c = child(args, o);
    const how = threw ? ` (main threw: ${r.err.trim().split("\n")[0] ?? ""})` : "";
    if (c.status !== r.status) throw new Error(`cli-runner: ${label} ${args.join(" ")} exited ${r.status} in-process${how} but ${c.status} as a child (re-run) — pass { spawn: true } for this call\n${c.stderr}`);
    return c;
  };
}

/** A run's stdout, or a throw naming its exit code and stderr (what execFileSync did for a non-zero exit). */
export function stdoutOf(r: CliResult): string {
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  return r.stdout;
}
