// The repo's own entry points as a suite runs them in a child process: dtwin (bridge/src/figma-pull.ts), the MCP
// server (bridge/src/figma-mcp.ts), seed-components, or any `bun <script>`. Every child goes through
// design-to-code/proc.ts — the path cli-runner and pool.runNode use — so it gets the same hardening: file-backed capture
// for a sync run, and for an async one a settle that never hangs, a lost exit detected, a timeout that kills.
//
//   const env = bridgeEnv({ port: 8789, token: TOKEN });
//   const r = await dtwin(["whoami", "--timeout", "5"], { cwd, env, timeoutMs: 40_000 });   // ProcResult
//   const h = dtwinSync(["--help"], { env });                                                // runSync
//   const serve = startChild([DTWIN, "serve"], { cwd, env });  await serve.waitFor(/listening/, 10_000);  serve.kill();
//   const mcp = startMcp({ env, cwd });  await mcp.rpc("initialize", {...});  await mcp.call("figma_status", {});
//
// Children are never detached: they stay in the suite's process group, so run-suites' group kill on an interrupt or a
// suite timeout reaches a server a suite left running. A child whose point is the runtime's own pipe behaviour (what
// proc.ts works around) does not belong here: spawn it raw.
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { runAsync, runSync, type AsyncOpts, type ProcResult, type SyncOpts } from "../design-to-code/proc.ts";

const SRC = path.join(import.meta.dirname, "..", "bridge", "src");
/** The entry points by name. */
export const DTWIN = path.join(SRC, "figma-pull.ts");
export const MCP = path.join(SRC, "figma-mcp.ts");
export const SEED = path.join(SRC, "seed-components.ts");

/** The environment a child that holds (or reaches) the bridge gets: this process's, without the variables that would
 *  point it somewhere else (`unset`, by default the token file and DTWIN_PORT), with the port and token given, then
 *  `set` on top. The caller's own process.env is never changed. */
export function bridgeEnv(o: { port?: number | string; token?: string; unset?: readonly string[]; set?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of o.unset ?? ["FIGMA_BRIDGE_TOKEN_FILE", "DTWIN_PORT"]) delete env[k];
  if (o.token !== undefined) env.FIGMA_BRIDGE_TOKEN = o.token;
  if (o.port !== undefined) env.FIGMA_BRIDGE_PORT = String(o.port);
  return { ...env, ...o.set };
}

/** `bun <args>` to completion, file-backed capture (proc.ts runSync). */
export const bunSync = (args: readonly string[], o: SyncOpts = {}): ProcResult => runSync(process.execPath, args, o);
/** `bun <args>` to completion, asynchronously (proc.ts runAsync, not detached): the suite's own servers keep answering. */
export const bun = (args: readonly string[], o: Omit<AsyncOpts, "detached"> = {}): Promise<ProcResult> =>
  runAsync(process.execPath, args, { ...o, detached: false }).done;
export const dtwinSync = (args: readonly string[], o: SyncOpts = {}): ProcResult => bunSync([DTWIN, ...args], o);
export const dtwin = (args: readonly string[], o: Omit<AsyncOpts, "detached"> = {}): Promise<ProcResult> => bun([DTWIN, ...args], o);

/** A long-lived child (a `dtwin serve`, a held port, an MCP server) the suite talks to while it runs. */
export interface Child {
  readonly child: ChildProcess;
  /** settles when the child is gone (proc.ts: on close, on exit + the pipes' end, or a lost exit) */
  readonly done: Promise<ProcResult>;
  /** what it has written so far */
  stdout(): string;
  stderr(): string;
  /** how it exited (`at`: when), or null while it runs */
  exit(): { code: number | null; signal: NodeJS.Signals | null; at: number } | null;
  /** polls stderr (or stdout) every `everyMs` until `re` matches; false at `ms` */
  waitFor(re: RegExp, ms: number, o?: { stream?: "stderr" | "stdout"; everyMs?: number }): Promise<boolean>;
  /** a signal to the child (default SIGKILL); a child already gone is not an error */
  kill(signal?: NodeJS.Signals): void;
}

export function startChild(args: readonly string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: "pipe" | "ignore" } = {}): Child {
  const { child, done } = runAsync(process.execPath, args, { ...o, detached: false, stdin: o.stdin ?? "ignore" });
  // runAsync cannot fail to return a child except when spawn() itself throws; a suite cannot proceed without one.
  if (!child) throw new Error(`could not start bun ${args.join(" ")}`);
  let out = "", err = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null; at: number } | null = null;
  const outDec = new StringDecoder("utf8"), errDec = new StringDecoder("utf8");
  child.stdout?.on("data", (d: Buffer | string) => { out += typeof d === "string" ? d : outDec.write(d); });
  child.stderr?.on("data", (d: Buffer | string) => { err += typeof d === "string" ? d : errDec.write(d); });
  child.stdin?.on("error", () => { /* the child went away first */ });
  child.on("exit", (code, signal) => { exit ??= { code, signal, at: Date.now() }; });
  // a lost exit (proc.ts's liveness poll) still records one
  void done.then((r) => { exit ??= { code: r.status, signal: r.signal, at: Date.now() }; });
  return {
    child, done,
    stdout: () => out,
    stderr: () => err,
    exit: () => exit,
    async waitFor(re, ms, w = {}) {
      const t0 = Date.now();
      const text = (): string => (w.stream === "stdout" ? out : err);
      while (!re.test(text())) {
        if (Date.now() - t0 >= ms) return false;
        await new Promise((r) => setTimeout(r, w.everyMs ?? 50));
      }
      return true;
    },
    kill(signal = "SIGKILL") { if (!exit) { try { child.kill(signal); } catch { /* gone */ } } },
  };
}

/** The MCP server as a client drives it over stdio: newline-delimited JSON-RPC on its stdin/stdout. */
export interface McpChild extends Child {
  /** one JSON-RPC message, `jsonrpc: "2.0"` added */
  send(msg: { id?: number; method: string; params?: object }): void;
  notify(method: string, params?: object): void;
  /** a request; resolves with its `result`, `{ rpcError }` for an error reply, or null when none arrives within `ms` */
  rpc(method: string, params: object, ms?: number): Promise<Record<string, unknown> | null>;
  /** tools/call, its first text block and that text read as JSON (`{}` when it is not) */
  call(name: string, args: object, ms?: number): Promise<{ isError: boolean; text: string; json: Record<string, unknown> } | null>;
  /** the raw stdout line carrying JSON-RPC id `id`, once it has arrived */
  replyLine(id: number): string | undefined;
}

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {});

export function startMcp(o: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string } = {}): McpChild {
  const c = startChild([o.script ?? MCP], { ...o, stdin: "pipe" });
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  let buf = "";
  // decoded as a stream: a chunk can end inside a multi-byte character, whose halves would each read as U+FFFD
  const dec = new StringDecoder("utf8");
  c.child.stdout?.on("data", (d: Buffer | string) => {
    buf += typeof d === "string" ? d : dec.write(d);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: unknown;
      try { m = JSON.parse(line) as unknown; } catch { continue; }
      const r = rec(m);
      if (typeof r.id !== "number") continue;
      const w = waiting.get(r.id);
      waiting.delete(r.id);
      if (w) w(r.error !== undefined ? { rpcError: r.error } : rec(r.result));
    }
  });
  const send = (msg: { id?: number; method: string; params?: object }): void => {
    try { c.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"); } catch { /* closed */ }
  };
  let rpcId = 1000; // clear of the small ids a suite sends by hand with send()
  const rpc = (method: string, params: object, ms = 15_000): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    const id = ++rpcId;
    const t = setTimeout(() => { waiting.delete(id); resolve(null); }, ms);
    waiting.set(id, (v) => { clearTimeout(t); resolve(v); });
    send({ id, method, params });
  });
  return {
    ...c,
    send,
    notify: (method, params) => send({ method, ...(params !== undefined ? { params } : {}) }),
    rpc,
    async call(name, args, ms) {
      const r = await rpc("tools/call", { name, arguments: args }, ms);
      if (!r) return null;
      const first = Array.isArray(r.content) ? rec(r.content[0]) : {};
      const text = typeof first.text === "string" ? first.text : JSON.stringify(r);
      let json: Record<string, unknown> = {};
      try { json = rec(JSON.parse(text) as unknown); } catch { /* an error text */ }
      return { isError: r.isError === true, text, json };
    },
    replyLine: (id) => c.stdout().split("\n").find((l) => l.includes(`"id":${id}`)),
  };
}
