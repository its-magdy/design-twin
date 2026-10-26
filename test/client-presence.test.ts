// The MCP server's client presence (bridge/src/client-presence.ts) in process: fake stdio streams, fake signals, a
// fake timer and exit, and a recording holder — so "the first of stdin end, stdout EPIPE or a signal decides, the rest
// change nothing", the abort every tool call carries, and the exit timing are checked without spawning a server.
// test/mcp-lifecycle.test.ts keeps two smoke tests of the real process (stdin EOF; stdout EPIPE then SIGTERM).
//   bun test/client-presence.test.ts
import { EventEmitter } from "node:events";
import { check, report } from "./assert.ts";
import {
  clientPresence, RELEASED_BACKSTOP_MS, RELEASED_FLUSH_CAP_MS, SIGNAL_FLUSH_CAP_MS, SIGNAL_GRACE_MS, SIGNALS,
} from "../bridge/src/client-presence.ts";
import type { PresenceHolder, PresenceIO } from "../bridge/src/client-presence.ts";

interface Timer { fn: () => void; ms: number; unrefd: boolean }

function rig() {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const signals = new Map<NodeJS.Signals, () => void>();
  const timers: Timer[] = [];
  const exits: { code: number; capMs: number }[] = [];
  let exitCode: number | null = null;
  const io: PresenceIO = {
    stdin, stdout, stderr,
    onSignal: (sig, fn) => { signals.set(sig, fn); },
    setTimer: (fn, ms) => { const t: Timer = { fn, ms, unrefd: false }; timers.push(t); return { unref() { t.unrefd = true; } }; },
    setExitCode: (c) => { exitCode = c; },
    exit: (code, capMs) => { exits.push({ code, capMs }); },
  };
  const left: string[] = [];
  const releases: (string | undefined)[] = [];
  let settle: (why: string) => void = () => {};
  const holder: PresenceHolder = {
    clientLeft: (how) => { left.push(how); },
    release: (why) => { releases.push(why); settle(why ?? "released"); },
    released: new Promise<string>((r) => { settle = r; }),
  };
  let made = 0;
  const p = clientPresence(io, () => { made++; return holder; });
  return {
    p, stdin, stdout, stderr, signals, timers, exits, left, releases,
    exitCode: () => exitCode, made: () => made, settle: (why: string) => settle(why),
    reason: () => (p.gone.aborted ? String((p.gone.reason as Error).message) : null),
  };
}
const epipe = (code: string): Error => Object.assign(new Error("write " + code), { code });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

console.log("\nbefore start:");
{
  const r = rig();
  check("nothing is wired and the holder is not made until start (a suite can load the MCP server without it)",
    r.made() === 0 && r.stdout.listenerCount("error") === 0 && r.signals.size === 0 && !r.p.gone.aborted);
}

console.log("\nstart:");
{
  const r = rig();
  r.p.start();
  r.p.start();
  check("guards stdout and stderr once, and handles SIGTERM / SIGINT / SIGHUP",
    r.stdout.listenerCount("error") === 1 && r.stderr.listenerCount("error") === 1 && SIGNALS.every((s) => r.signals.has(s)) && r.signals.size === 3);
  check("stdin is not watched until the transport reads it", r.stdin.listenerCount("end") === 0 && r.stdin.listenerCount("close") === 0);
  r.stderr.emit("error", epipe("EPIPE"));
  check("a stderr error is swallowed: nobody is left to tell, and the client is not taken to have gone", r.left.length === 0 && !r.p.gone.aborted);
}

console.log("\nthe client goes — the first event decides:");
{
  const r = rig();
  r.p.start();
  r.p.watchStdin();
  r.stdin.emit("end");
  check("stdin ends → every tool call is aborted, saying the client went away", r.reason() === "the MCP client went away (stdin closed) — request abandoned");
  check("…and the holder hears clientLeft (it decides: exit, or serve other sessions on)", r.left.join() === "stdin closed" && r.releases.length === 0);
  r.stdin.emit("close");
  r.stdout.emit("error", epipe("EPIPE"));
  check("the events after it change nothing here: the abort keeps its first reason (each is passed on — the holder runs clientLeft once)",
    r.reason() === "the MCP client went away (stdin closed) — request abandoned" && r.left.join() === "stdin closed,stdin closed,stdout closed");
}
{
  const r = rig();
  r.p.start();
  r.p.watchStdin();
  r.stdin.emit("close");
  check("stdin closing with no 'end' first is the client going away too", r.left.join() === "stdin closed" && r.p.gone.aborted);
}
{
  const r = rig();
  r.p.start();
  r.p.watchStdin();
  // A killed client breaks both pipes at once: a progress tick can hit stdout before stdin's 'end' is handled.
  r.stdout.emit("error", epipe("EPIPE"));
  r.stdin.emit("end");
  check("stdout EPIPE before stdin's end → that is the client going away, and it decides",
    r.reason() === "the MCP client went away (stdout closed) — request abandoned" && r.left[0] === "stdout closed");
  check("…and no stdout error escapes as an uncaught exception (a listener is there)", r.stdout.listenerCount("error") === 1);
}
{
  const r = rig();
  r.p.start();
  r.stdout.emit("error", epipe("ERR_STREAM_DESTROYED"));
  const r2 = rig();
  r2.p.start();
  r2.stdout.emit("error", epipe("EIO"));
  check("a write after the pipe is gone (ERR_STREAM_DESTROYED) is the same; another stdout failure is named",
    r.left[0] === "stdout closed" && r2.left[0] === "stdout failed: EIO");
}
{
  const r = rig();
  r.p.watchStdin();
  r.stdin.emit("end");
  check("a client gone before start() still finds stdout guarded (the guard is the belt for an early path)",
    r.stdout.listenerCount("error") === 1 && r.left[0] === "stdin closed");
}

console.log("\na signal:");
{
  const r = rig();
  r.p.start();
  r.signals.get("SIGINT")?.();
  check("SIGINT → every tool call is aborted, naming the signal", r.reason() === "SIGINT — request abandoned");
  check("…the holder releases (cancel frames, socket unlinked) — not clientLeft: a signal ends even a shared process",
    r.releases.join() === "SIGINT — closing the bridge and exiting" && r.left.length === 0);
  const t = r.timers.find((x) => x.ms === SIGNAL_GRACE_MS);
  check(`…and exit 0 is armed ${SIGNAL_GRACE_MS} ms later (cancel frames reach the plugin), waiting ≤ ${SIGNAL_FLUSH_CAP_MS} ms for stderr`,
    t !== undefined && !t.unrefd && r.exits.length === 0);
  t?.fn();
  check("…which exits 0 with that cap", r.exits.length === 1 && r.exits[0]?.code === 0 && r.exits[0].capMs === SIGNAL_FLUSH_CAP_MS);
  r.signals.get("SIGTERM")?.();
  check("Claude Code's SIGTERM after its SIGINT changes nothing: one release, one exit timer",
    r.releases.length === 1 && r.timers.filter((x) => x.ms === SIGNAL_GRACE_MS).length === 1 && r.reason() === "SIGINT — request abandoned");
}
{
  const r = rig();
  r.p.start();
  r.p.watchStdin();
  r.stdin.emit("end");
  r.signals.get("SIGTERM")?.();
  check("a signal after the client went away still releases (the shared bridge it may be serving ends too); the abort keeps its first reason",
    r.releases.join() === "SIGTERM — closing the bridge and exiting" && r.reason() === "the MCP client went away (stdin closed) — request abandoned");
}

console.log("\nonce the holder has let go:");
{
  const r = rig();
  r.p.start();
  check("nothing is armed while the holder holds", r.exitCode() === null && r.timers.length === 0);
  r.settle("the MCP client went away (stdin closed) — exiting");
  await tick();
  const t = r.timers.find((x) => x.ms === RELEASED_BACKSTOP_MS);
  check("released (clientLeft, the idle shutdown, `dtwin stop`) → exit code 0, and the loop drains to exit on its own",
    r.exitCode() === 0 && r.exits.length === 0);
  check(`…with an unref'd backstop: exit 0 after ${RELEASED_BACKSTOP_MS} ms if a handle keeps the loop open, waiting ≤ ${RELEASED_FLUSH_CAP_MS} ms for stderr`,
    t !== undefined && t.unrefd);
  t?.fn();
  check("…which exits 0 with that cap", r.exits[0]?.code === 0 && r.exits[0].capMs === RELEASED_FLUSH_CAP_MS);
}

report();
