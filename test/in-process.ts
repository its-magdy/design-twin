// Runs a CLI's exported `main(argv)` inside the suite's own process, with what a child would have had: its own cwd,
// stdout / stderr captured (process.std*.write AND console.*, which Bun does not route through the streams), and
// process.exit turned into a return. For a CLI whose main is synchronous and leaves no timers or handles behind.
//
//   const r = runMainSync(main, ["tokens.json", "--check", "theme.css"], { cwd });   // { status, out, err }
//   const r = await runMain(main, ["--json"], { cwd, env: { FIGMA_BRIDGE_PORT: "1" } }); // an async main (Promise<number>)
//
// `env`: variables set (a string) or removed (undefined) for the call only, on top of this process's environment — the
// CLI reads process.env, so this is how it sees what a child would have been spawned with. Everything is restored after,
// even when main throws. An async main runs with the capture in place until it settles, so nothing else in the suite may
// write (or chdir) meanwhile — await it before the next step. Keep at least one real spawn per exit code of a CLI (the
// shebang, argv parsing, process.exitCode on a real exit are the CLI surface); move the rest in-process.
import { format } from "node:util";

class Exit extends Error { code: number; constructor(code: number) { super(`process.exit(${code})`); this.code = code; } }

export interface MainResult { status: number | null; out: string; err: string }
export interface MainOpts { cwd?: string; env?: Record<string, string | undefined> }

interface Capture { out: string; err: string; restore: () => void }
function capture(o: MainOpts): Capture {
  const c: Capture = { out: "", err: "", restore: () => {} };
  const saved = { cwd: process.cwd(), exit: process.exit, exitCode: process.exitCode, ow: process.stdout.write, ew: process.stderr.write,
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const savedEnv = new Map<string, string | undefined>();
  const sink = (to: "out" | "err") => (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (to === "out") c.out += s; else c.err += s;
    const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined; cb?.();
    return true;
  };
  const line = (to: "out" | "err") => (...a: unknown[]): void => { if (to === "out") c.out += format(...a) + "\n"; else c.err += format(...a) + "\n"; };
  c.restore = (): void => {
    process.chdir(saved.cwd); process.exit = saved.exit; process.exitCode = saved.exitCode;
    process.stdout.write = saved.ow; process.stderr.write = saved.ew;
    Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug });
    for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  try {
    for (const [k, v] of Object.entries(o.env ?? {})) {
      savedEnv.set(k, process.env[k]);
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (o.cwd) process.chdir(o.cwd);
  } catch (e) { c.restore(); throw e; }
  process.exit = (code?: number | string | null): never => { throw new Exit(Number(code ?? process.exitCode ?? 0)); };
  process.exitCode = undefined;
  process.stdout.write = sink("out");
  process.stderr.write = sink("err");
  console.log = console.info = console.debug = line("out");
  console.warn = console.error = line("err");
  return c;
}
// what main's end means as an exit status: its return value, else the process.exitCode it set (a CLI that ends with
// `process.exitCode = n; return`), else 0; process.exit(n) → n; an uncaught throw → 1 with the stack on stderr, as bun does
const settle = (c: Capture, r: { value: number | void } | { thrown: unknown }): number => {
  if ("value" in r) return typeof r.value === "number" ? r.value : Number(process.exitCode ?? 0);
  if (r.thrown instanceof Exit) return r.thrown.code;
  c.err += (r.thrown instanceof Error ? r.thrown.stack ?? r.thrown.message : String(r.thrown)) + "\n";
  return 1;
};

export function runMainSync(main: (argv: string[]) => number | void, argv: string[], o: MainOpts = {}): MainResult {
  const c = capture(o);
  let status: number;
  try {
    try { status = settle(c, { value: main(argv) }); } catch (e) { status = settle(c, { thrown: e }); }
  } finally { c.restore(); }
  return { status, out: c.out, err: c.err };
}

export async function runMain(main: (argv: string[]) => Promise<number | void> | number | void, argv: string[], o: MainOpts = {}): Promise<MainResult> {
  const c = capture(o);
  let status: number;
  try {
    try { status = settle(c, { value: await main(argv) }); } catch (e) { status = settle(c, { thrown: e }); }
  } finally { c.restore(); }
  return { status, out: c.out, err: c.err };
}
