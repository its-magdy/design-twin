// verifier-guard.ts — the visual-verifier subagent's PreToolUse guard. Usage in --help (USAGE below).
//
// Registered in claude-plugin/hooks/hooks.json (PreToolUse, matcher `Bash|Write`: the agent's tools are
// Read, Glob, Grep, Bash and Write, and the matcher sends only the two that change things): Claude Code ignores `hooks` in a plugin-shipped agent's frontmatter, so a rule meant
// for one plugin agent has to be a plugin-level hook that looks at who is calling. Every PreToolUse
// payload carries `agent_type` when the call comes from inside a subagent (`designtwin:visual-verifier`
// for this plugin's agent — the plugin-scoped name); a call from anywhere else is not this hook's
// business and gets no answer at all, so the normal permission flow applies.
//
// For the verifier it refuses exactly what the agent's own instructions forbid and a measuring agent
// never needs:
//   - a file write (Write; Edit/MultiEdit/NotebookEdit are judged the same way defensively, should the agent
//     ever be given them — the matcher does not send them today) anywhere but its own outputs — design/verify/
//     (except the files the tools own: the expectation, the report, the status, the diff) and the run
//     cache (`node_modules/.cache/designtwin-verify/`, or `designtwin-verify/` under a temp dir when the
//     project has no package.json). An allow-list: it measures, it never edits app code, config or plans.
//   - a pattern kill (pkill, killall, `fuser -k`, `taskkill /IM`, a kill fed by pgrep/pidof/lsof/ps, and
//     `kill -1` / `kill 0`): it takes down the user's own servers and editors. `kill <pid>` of a PID it
//     recorded, `kill -- -<pgid>` of its own process group, and `pkill -P <pid>` / `kill $(pgrep -P <pid>)`
//     (the children of a PID — no name or pattern) stay allowed.
//   - a dependency install or reinstall (npm/pnpm/yarn/bun install, ci, add, …) and a Playwright
//     browser install: the user's call, and `npm ci`/`npm install` clear node_modules/.cache with the
//     live status and the staged evidence in it.
//   - a Bash call with `dangerouslyDisableSandbox`: a permission denial is not a sandbox violation.
// A refusal is a PreToolUse decision on stdout (permissionDecision "deny" + the reason, which Claude
// sees) with exit 0 — not exit 2, which PowerShell turns into 1, a non-blocking error.
//
// It never bricks a session: a payload that is missing, unparsable or not shaped like a tool call, and
// any error of its own, is logged to stderr and answered with nothing (allow), exit 0.
import fs from "node:fs";
import os from "node:os";
import { readHookInput } from "./hook-input.ts";
import { simpleCommands } from "./shell-words.ts";
import type { Words } from "./shell-words.ts";
import { scriptCmd } from "./cli-args.ts";
import { isJsonObject } from "./types.ts";
import type { JsonObject } from "./types.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

/** The agent this guard applies to: the plugin-scoped name, or the bare one (the same agent copied into a project's .claude/agents/). */
export const VERIFIER_AGENT = /^(designtwin:)?visual-verifier$/;

/** Where the guard resolves a relative path and which directories count as the OS temp dir. */
export interface GuardCtx { cwd: string; tmpRoots: readonly string[] }

const HOOK_WAIT_MS = 1000;
const HOOK_HARD_MS = 5000;

// ================================================================ file writes

// Written only by verify-screen.js / verify-probe.js, never by hand: the expectation the build is graded
// against, the report and its markdown, the run status, and the visual diff.
const TOOL_OWNED = /\.(expected(\.prev)?\.json|report\.json|report\.md|status\.json|diff\.png)$/i;
const CACHE_RUN = ["node_modules", ".cache", "designtwin-verify"];
const VERIFY_DIR = ["design", "verify"];

// A path as lower-cased segments, `.`/`..` resolved — `/` and `\` alike, so a Windows path reads the same on
// any host. A relative path is taken from cwd (Claude Code passes file paths absolute; this is the fallback).
function segments(p: string, cwd: string): string[] {
  const norm = (s: string): string => s.replaceAll("\\", "/");
  const abs = (s: string): boolean => s.startsWith("/") || /^[A-Za-z]:\//.test(s);
  const full = abs(norm(p)) ? norm(p) : norm(cwd) + "/" + norm(p);
  const out: string[] = [];
  for (const s of full.toLowerCase().split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop(); else out.push(s);
  }
  return out;
}

// Index just past the first run of `want` in `segs` that still has a file name after it, or -1.
function after(segs: readonly string[], want: readonly string[]): number {
  for (let i = 0; i + want.length < segs.length; i++) if (want.every((w, j) => segs[i + j] === w)) return i + want.length;
  return -1;
}

const startsWith = (segs: readonly string[], root: readonly string[]): boolean => root.length > 0 && root.length <= segs.length && root.every((r, i) => segs[i] === r);

/** Why a write to `file` is refused, or null when it is one of the verifier's own outputs. */
export function writeVerdict(file: string, ctx: GuardCtx): string | null {
  const segs = segments(file, ctx.cwd);
  if (after(segs, CACHE_RUN) >= 0) return null;
  for (const root of ctx.tmpRoots) {
    const r = segments(root, "/");
    if (startsWith(segs, r) && after(segs.slice(r.length), ["designtwin-verify"]) >= 0) return null;
  }
  if (after(segs, VERIFY_DIR) >= 0) {
    if (!TOOL_OWNED.test(segs[segs.length - 1] ?? "")) return null;
    return `${file} is the verify tools' own (the expectation, report, status and diff), never written by hand. `
      + `Report progress with \`${scriptCmd("verify-screen")} --status <Screen> --phase <phase> --run <id>\`; the caller runs --expect and --compare.`;
  }
  return `the visual-verifier measures, it never edits app code: it writes only design/verify/ (its measured file and screenshots) `
    + `and the run cache node_modules/.cache/designtwin-verify/ (stage/<runId>/ for evidence, scratch/ for throwaway scripts). ${file} is outside both. `
    + "Put a scratch script in node_modules/.cache/designtwin-verify/scratch/, and report a defect in the build as a measurement or a note — never fix it.";
}

// ================================================================ shell commands

// The program a word names: its basename, lower-cased, without a Windows executable extension.
const prog = (w: string): string => (w.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
const isAssign = (w: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

// The first word that is not an option, skipping the value of each option in `valued`. Returns its index (or words.length).
function firstArg(words: Words, from: number, valued: ReadonlySet<string> = new Set()): number {
  let i = from;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += valued.has(w) ? 2 : 1;
  }
  return i;
}

// Wrappers that run the rest of their words as a command: they are looked through.
const WRAPPER_VALUED: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  nice: new Set(["-n"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set(["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a", "-i", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"]),
  doas: new Set(["-u", "-C"]),
  nohup: new Set(), command: new Set(), builtin: new Set(), exec: new Set(), time: new Set(), stdbuf: new Set(), setsid: new Set(),
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

// Package-manager subcommands that install, reinstall, add, remove or update the project's dependencies.
const NPM_DEPS = new Set(["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add",
  "ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-test", "it", "install-ci-test", "cit", "clean-install-test", "sit",
  "update", "up", "upgrade", "udpate", "uninstall", "unlink", "remove", "rm", "r", "un", "dedupe", "ddp", "prune",
  // `npm init <initializer>` / `npm create …` runs create-<initializer>: `npm init playwright@latest` is Playwright's own installer
  "init", "create", "innit"]);
const PNPM_DEPS = new Set(["install", "i", "add", "update", "up", "upgrade", "remove", "rm", "un", "uninstall", "prune", "dedupe", "install-test", "it", "ci", "fetch", "import", "create"]);
const YARN_DEPS = new Set(["install", "add", "remove", "up", "upgrade", "upgrade-interactive", "dedupe", "create"]);
const BUN_DEPS = new Set(["install", "i", "add", "a", "remove", "rm", "update", "create"]);
// Each package manager's global options that take a value (so the value is not read as the subcommand). Per manager:
// pnpm's `-w` is the boolean --workspace-root, npm's is --workspace <name>.
const NPM_VALUED = new Set(["--prefix", "-C", "--workspace", "-w", "--loglevel", "--cache", "--userconfig", "--globalconfig", "--registry", "--tag", "--omit", "--include", "--before", "--otp", "--scope"]);
const PNPM_VALUED = new Set(["-C", "--dir", "--filter", "-F", "--loglevel", "--reporter", "--registry", "--store-dir"]);
const YARN_VALUED = new Set(["--cwd", "--cache-folder", "--modules-folder", "--global-folder", "--registry", "--network-timeout"]);
const BUN_VALUED = new Set(["--cwd", "--config", "-c"]);
const NPX_VALUED = new Set(["-p", "--package", "--call", "-c", "--cache", "--registry", "--userconfig"]);
const PLAYWRIGHT_PKG = /^(@playwright\/test|playwright|playwright-core|playwright-chromium)(@.*)?$/;
const PID_LOOKUPS = new Set(["pgrep", "pidof", "lsof", "ps", "fuser"]);
// A playwright CLI run by path: …/playwright/cli.js, …/playwright-core/cli.js, …/@playwright/test/cli.js.
const PLAYWRIGHT_CLI = /(^|[\\/])(@playwright[\\/][^\\/]+|playwright[^\\/]*)[\\/]cli\.js$/i;

// pkill / pgrep selecting ONLY by parent PID (`-P 123`, `-P123`, `--parent=123`, plus a signal option): the children
// of a process the verifier started and recorded — no name, no pattern. Anything else is a pattern match.
function parentOnly(args: Words): boolean {
  let parent = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const next = args[i + 1] ?? "";
    if ((a === "-P" || a === "--parent") && /^\d+(,\d+)*$/.test(next)) { parent = true; i++; continue; }
    if (/^(-P|--parent=)\d+(,\d+)*$/.test(a)) { parent = true; continue; }
    if (a === "--signal" && next) { i++; continue; }
    if (/^(--signal=\S+|-\d+|-(SIG)?[A-Z]+[0-9]*)$/.test(a)) continue; // -9, -TERM, -SIGTERM, -RTMIN1
    return false;
  }
  return parent;
}

// Does `text` (a command line, or a substitution's raw text) look PIDs up by name, pattern or port? `pgrep -P <pid>` does not.
function lookupByPattern(text: string): boolean {
  return simpleCommands(text).some((w) => { // a $( … ) / backtick in `text` is lifted out as a command of its own
    const p = prog(w[0] ?? "");
    return PID_LOOKUPS.has(p) && !(p === "pgrep" && parentOnly(w.slice(1)));
  });
}

// The PIDs a kill names (after its signal option): `kill -1` (every process the user may signal), `kill -9 -1`,
// `kill -- -1` and `kill 0` (the caller's whole process group) reach far beyond anything the verifier started.
function killsEverything(args: Words): boolean {
  if (args.length === 1 && args[0] === "-1") return true;
  const pids: string[] = [];
  let signal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") { pids.push(...args.slice(i + 1)); break; }
    if (a === "-s" || a === "-n") { signal = true; i++; continue; }
    if (a.startsWith("-") && !signal) { signal = true; continue; }
    pids.push(a);
  }
  return pids.some((p) => p === "-1" || p === "0" || p === "-0");
}

const REASON = {
  kill: "pattern kills (pkill, killall, fuser -k, taskkill /IM, a kill fed by pgrep/pidof/lsof/ps, kill -1 / kill 0) take down the user's own servers and editors. "
    + "Close only what you opened: stop only a PID you started and recorded (`kill <pid>`) — its whole tree with `kill -- -<pgid>` (the process group you started) "
    + "or its children with `pkill -P <pid>` — and reuse a dev server the user already runs.",
  install: "installing or reinstalling dependencies is the user's call, never the verifier's — and `npm ci`/`npm install` clear node_modules/.cache, "
    + "the live status and your staged evidence with it. Write status `blocked` with the command as the detail and hand it back to the caller.",
  playwright: "installing Playwright or its browsers is the user's call (it edits the project's dependencies and downloads ~150 MB). "
    + `No usable renderer (\`${scriptCmd("verify-probe")} --check\` exit 3): stop and ask the user, with the install line the probe printed and its cost.`,
  sandbox: "a permission denial is not a sandbox violation: never bypass the sandbox. Retry a transient no-verdict denial unchanged (at most twice); "
    + "otherwise write status `blocked` and hand back \"blocked on permissions: done / remaining\" with a narrow allow rule for the owner to add.",
} as const;

// Is words[i…] `playwright install` (or install-deps)?
const playwrightInstall = (words: Words, i: number): boolean => {
  const sub = words[firstArg(words, i)] ?? "";
  return sub === "install" || sub === "install-deps";
};

// The verdict on one simple command; `line` is the whole command line it came from (for a piped kill).
function commandVerdict(cmd: Words, line: string, depth: number): string | null {
  let words = cmd;
  let viaXargs = false;
  for (let guard = 0; guard < 8; guard++) {
    let i = 0;
    while (i < words.length && isAssign(words[i] ?? "")) i++;
    words = words.slice(i);
    const p = prog(words[0] ?? "");
    const valued = WRAPPER_VALUED[p];
    if (!valued) break;
    if (p === "xargs") viaXargs = true;
    let j = firstArg(words, 1, valued);
    if (p === "env") while (j < words.length && isAssign(words[j] ?? "")) j++;
    if (p === "timeout") j++; // its duration
    words = words.slice(j);
  }
  const p = prog(words[0] ?? "");
  const args = words.slice(1);
  if (!p) return null;

  if (SHELLS.has(p)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a) || a === "--command");
    const body = c >= 0 ? (args[c + 1] === "--" ? args[c + 2] : args[c + 1]) : undefined;
    return body !== undefined && depth < 4 ? bashVerdict(body, depth + 1) : null;
  }
  if (p === "eval") return depth < 4 ? bashVerdict(args.join(" "), depth + 1) : null;

  if (p === "killall" || (p === "pkill" && !parentOnly(args))) return REASON.kill;
  if (p === "fuser" && args.some((a) => /^-[a-z]*k/i.test(a))) return REASON.kill;
  // `/IM` from cmd or PowerShell, `//IM` from Git Bash (which would otherwise rewrite `/IM` as a path), `-IM`
  if (p === "taskkill" && args.some((a) => /^(\/\/?|-)(im|fi)$/i.test(a))) return REASON.kill;
  if (p === "kill") {
    if (killsEverything(args)) return REASON.kill;
    if (viaXargs && lookupByPattern(line)) return REASON.kill;
    if (args.some((a) => (a.includes("$(") || a.includes("`")) && lookupByPattern(a))) return REASON.kill;
    return null;
  }

  if (p === "npm") {
    const s = firstArg(words, 1, NPM_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (NPM_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "exec" || sub === "x") return npxVerdict(words, s + 1);
    return null;
  }
  if (p === "npx" || p === "pnpx" || p === "bunx") return npxVerdict(words, 1);
  if (p === "pnpm") {
    const s = firstArg(words, 1, PNPM_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (PNPM_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "dlx" || sub === "exec" || sub === "x") return npxVerdict(words, s + 1);
    return PLAYWRIGHT_PKG.test(sub) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
  }
  if (p === "yarn") {
    let s = firstArg(words, 1, YARN_VALUED);
    // `yarn workspace <name> <command…>` runs the command in that workspace
    if ((words[s] ?? "").toLowerCase() === "workspace" && s + 2 < words.length) s += 2;
    const sub = (words[s] ?? "").toLowerCase();
    // a bare `yarn` (options only, e.g. --frozen-lockfile) installs; `yarn --version` / `--help` do not
    if (s >= words.length && !args.some((a) => /^(-v|--version|-h|--help)$/.test(a))) return REASON.install;
    if (YARN_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "dlx" || sub === "exec") return npxVerdict(words, s + 1);
    return PLAYWRIGHT_PKG.test(sub) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
  }
  if (p === "bun") {
    const s = firstArg(words, 1, BUN_VALUED);
    const sub = (words[s] ?? "").toLowerCase();
    if (BUN_DEPS.has(sub)) return createsPlaywright(words, s) ? REASON.playwright : REASON.install;
    if (sub === "x") return npxVerdict(words, s + 1);
    return null;
  }
  if (PLAYWRIGHT_PKG.test(p) && playwrightInstall(words, 1)) return REASON.playwright;
  if (p === "node") {
    const s = firstArg(words, 1);
    if (PLAYWRIGHT_CLI.test(words[s] ?? "") && playwrightInstall(words, s + 1)) return REASON.playwright;
  }
  return null;
}

// `<pm> init|create playwright…` (or create-playwright): Playwright's installer, refused with its own reason.
const createsPlaywright = (words: Words, s: number): boolean => {
  const sub = (words[s] ?? "").toLowerCase();
  return (sub === "init" || sub === "innit" || sub === "create") && /^(create-)?playwright(@.*)?$/i.test(words[firstArg(words, s + 1)] ?? "");
};

// npx / npm exec / pnpm dlx / yarn dlx / bunx: what runs is the package named first.
function npxVerdict(words: Words, from: number): string | null {
  const c = words.findIndex((w, k) => k >= from && (w === "-c" || w === "--call"));
  if (c >= 0 && words[c + 1] !== undefined) return bashVerdict(words[c + 1] ?? "", 1);
  const s = firstArg(words, from, NPX_VALUED);
  const pkg = (words[s] ?? "").toLowerCase();
  if (/^create-playwright(@.*)?$/.test(pkg)) return REASON.playwright;
  return PLAYWRIGHT_PKG.test(pkg) && playwrightInstall(words, s + 1) ? REASON.playwright : null;
}

/** Why a shell command line is refused, or null. */
export function bashVerdict(command: string, depth = 0): string | null {
  for (const cmd of simpleCommands(command)) {
    const v = commandVerdict(cmd, command, depth);
    if (v) return v;
  }
  return null;
}

// ================================================================ the decision

const FILE_TOOLS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/**
 * The guard's answer to one PreToolUse payload: the reason a call is refused, null when it has no
 * objection (not the verifier, or an allowed call), or `{ malformed }` when the payload is not a tool call
 * it can read (logged and allowed by the caller).
 */
export function decide(payload: unknown, ctx: GuardCtx): { deny: string } | { malformed: string } | null {
  if (!isJsonObject(payload)) return { malformed: "the payload is not a JSON object" };
  const agent = payload.agent_type;
  if (typeof agent !== "string" || !VERIFIER_AGENT.test(agent)) return null;
  const tool = payload.tool_name;
  const input = payload.tool_input;
  if (typeof tool !== "string" || !isJsonObject(input)) return { malformed: `a ${agent} call with no tool_name/tool_input` };
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : ctx.cwd;
  const here: GuardCtx = { cwd, tmpRoots: ctx.tmpRoots };
  if (tool === "Bash") {
    if (input.dangerouslyDisableSandbox === true) return { deny: REASON.sandbox };
    if (typeof input.command !== "string") return { malformed: "a Bash call with no command" };
    const v = bashVerdict(input.command);
    return v ? { deny: v } : null;
  }
  const key = FILE_TOOLS[tool];
  if (key) {
    const file = input[key];
    if (typeof file !== "string" || !file) return { malformed: `a ${tool} call with no ${key}` };
    const v = writeVerdict(file, here);
    return v ? { deny: v } : null;
  }
  return null;
}

/** The directories that count as the OS temp dir: os.tmpdir() (and its real path), $TMPDIR/$TEMP/$TMP, and the POSIX defaults. */
export function tempRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [os.tmpdir(), env.TMPDIR, env.TEMP, env.TMP];
  try { roots.push(fs.realpathSync(os.tmpdir())); } catch { /* not there: os.tmpdir() alone */ }
  if (process.platform !== "win32") roots.push("/tmp", "/private/tmp", "/var/folders", "/private/var/folders");
  return [...new Set(roots.filter((r): r is string => typeof r === "string" && r !== ""))];
}

/** The PreToolUse JSON that refuses a call (printed on stdout, exit 0). */
export function denyOutput(reason: string): JsonObject {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `designtwin visual-verifier guard: ${reason}` } };
}

const USAGE = [
  `usage: ${scriptCmd("verifier-guard")}        (PreToolUse hook: reads the hook JSON from stdin when stdin is not a terminal)`,
  "",
  "Refuses, for the designtwin:visual-verifier subagent only: a file write outside design/verify/ and the run cache",
  "(node_modules/.cache/designtwin-verify/), or to a tool-owned file in design/verify/; a pattern kill (pkill, killall, …);",
  "a dependency install or a Playwright browser install; a Bash call with dangerouslyDisableSandbox.",
  "A refusal is {\"hookSpecificOutput\":{\"permissionDecision\":\"deny\",…}} on stdout; every answer exits 0.",
  "A call from any other agent, or a payload it cannot read, is allowed (the latter logged to stderr).",
].join("\n");

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
  // fail open here too: on PreToolUse a non-zero exit would read as an error of the hook, never as the agent's
  if (argv.length) { console.error(`verifier-guard: unexpected argument ${argv.join(" ")} — ignored, allowing the call\n${USAGE}`); return 0; }
  const r = await readHookInput({ waitMs: HOOK_WAIT_MS, hardMs: HOOK_HARD_MS, stalled: (bytes) => `no end-of-file on stdin after ${HOOK_HARD_MS / 1000} s (${bytes} byte(s) received)` });
  if (r.error || !r.payload) { console.error(`verifier-guard: ${r.error ?? "no hook payload"} — allowing the call`); return 0; }
  if (!Object.keys(r.payload).length) { console.error(`verifier-guard: no hook payload on stdin (${r.source ?? "?"}) — allowing the call`); return 0; }
  const d = decide(r.payload, { cwd: process.cwd(), tmpRoots: tempRoots() });
  if (d && "malformed" in d) console.error(`verifier-guard: ${d.malformed} — allowing the call`);
  else if (d) console.log(JSON.stringify(denyOutput(d.deny)));
  return 0;
}

export { USAGE, main };

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    console.error(`verifier-guard: ${(e instanceof Error && e.stack) || String(e)} — allowing the call`);
    process.exitCode = 0;
  });
}
