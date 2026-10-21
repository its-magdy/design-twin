// Runs a CLI's exported `main(argv)` inside the suite's own process, with what a child would have had: its own cwd,
// stdout / stderr captured (process.std*.write AND console.*, which Bun does not route through the streams), and
// process.exit turned into a return. For a CLI whose main is synchronous and leaves no timers or handles behind.
//
//   const r = runMainSync(main, ["tokens.json", "--check", "theme.css"], { cwd });   // { status, out, err }
import { format } from "node:util";

class Exit extends Error { code: number; constructor(code: number) { super(`process.exit(${code})`); this.code = code; } }

export interface MainResult { status: number | null; out: string; err: string }

export function runMainSync(main: (argv: string[]) => number, argv: string[], o: { cwd?: string } = {}): MainResult {
  let out = "", err = "";
  const saved = { cwd: process.cwd(), exit: process.exit, exitCode: process.exitCode, ow: process.stdout.write, ew: process.stderr.write,
    log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const sink = (to: "out" | "err") => (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (to === "out") out += s; else err += s;
    const cb = rest.find((x) => typeof x === "function") as (() => void) | undefined; cb?.();
    return true;
  };
  const line = (to: "out" | "err") => (...a: unknown[]): void => { if (to === "out") out += format(...a) + "\n"; else err += format(...a) + "\n"; };
  let status: number | null;
  try {
    if (o.cwd) process.chdir(o.cwd);
    process.exit = ((code?: number | string | null) => { throw new Exit(Number(code ?? process.exitCode ?? 0)); }) as typeof process.exit;
    process.stdout.write = sink("out") as typeof process.stdout.write;
    process.stderr.write = sink("err") as typeof process.stderr.write;
    console.log = console.info = console.debug = line("out");
    console.warn = console.error = line("err");
    try { status = main(argv); }
    catch (e) {
      if (e instanceof Exit) status = e.code;
      else { err += (e instanceof Error ? e.stack ?? e.message : String(e)) + "\n"; status = 1; } // an uncaught throw: node exits 1
    }
  } finally {
    process.chdir(saved.cwd); process.exit = saved.exit; process.exitCode = saved.exitCode;
    process.stdout.write = saved.ow; process.stderr.write = saved.ew;
    Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug });
  }
  return { status, out, err };
}
