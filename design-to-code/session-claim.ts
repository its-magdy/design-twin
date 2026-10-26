// session-claim.ts — which plans the stopping agent claimed, for the build-screen Stop / SubagentStop hook (verify-build.ts).
// ONE call, sessionClaim(): the hook payload (its transcript) plus the open and the unreadable plans under design/plan/ in,
// a verdict out — the plans to check and the unreadable ones to block on, or "none claimed" and whether to send the agent
// back. verify-build.ts only renders the verdict.
//
// Several screens build in parallel (one screen-builder each), and every one lands in the hook when it stops. The hook
// narrows to the plans the stopping agent's own transcript claims (OWNERSHIP below; a subagent's own transcript when the
// payload names one, else the session's). A transcript that claims NO plan checks NOTHING: build-screen's Stop hook is
// skill-scoped, so it also fires in an orchestrator session that loaded the skill and built nothing itself — it must not
// block that session on a plan another agent is still filling. A transcript that claims only plans the hook already
// closed narrows to nothing too: agent A, finished, is not blocked on agent B's half-built plan. A payload with no readable
// transcript at all (a hand-piped `{"cwd": …}`) is UNSCOPED: every open plan is checked.
//
// OWNERSHIP. A plan is this session's when the session's OWN tool calls (message.content[] tool_use items; for the session
// transcript, not a subagent's sidechain entries) either
//   (a) WRITE the plan; or
//   (b) WRITE a file that exactly ONE open plan lists in files[] — a builder or fixer editing that screen's code. A file
//       several plans list (a shared component) claims none of them.
// "Write" = a structured write only: a Write/Edit/MultiEdit/NotebookEdit of the path, or a Bash/PowerShell call that runs
// the plan-skeleton script with `--out <path>` (build-screen's step 2, the call that creates the plan — see
// planSkeletonOuts). Any other shell command (a redirect, `sed -i`, `cp`/`mv`, a script writing through fs) is not read: a
// command's targets can only be guessed, and a guess misses as much as it finds. The builder's own transcript is the
// owner's identity because nothing else is per-agent: Claude Code hands a subagent's Bash only the session id
// (CLAUDE_CODE_SESSION_ID), which parallel builders share, so a plan cannot carry its owner; the agent id is in the hook
// payload alone. Not prose, not an Agent/Task prompt (an orchestrator naming the plan a subagent should fill), not a
// tool_result (a subagent's report). Relative paths resolve against the transcript entry's own `cwd`, else the payload's.
// Separators are normalised; a Windows drive path from another machine matches by its project-relative tail.
// Nothing claimed → nothing checked, by design: the screen-builder's SubagentStop still gates delegated builds, and every
// builder's transcript holds its plan-skeleton call and the Write/Edit calls of its own code.
//
// An UNREADABLE plan (findPlans' `bad`) the session wrote is its claim on a plan it broke: it blocks, rather than being a
// warning nobody reads — unless its raw JSON holds a closed status ("abandoned", "awaiting-user"): that plan is given up on.
//
// SEND BACK. An orchestrator claiming nothing is normal; a screen-builder claiming nothing is a build the gate never saw.
// Its tool calls name no plan of their own, so no other reader of them could claim one either: only the builder knows which
// plan it built. So its SubagentStop is sent back ONCE (verify-build.ts renders the request, which holds NO_CLAIM_MARK) —
// unless its transcript already holds that request (Claude Code delivers it as a user-role entry that is not a
// tool_result), or it holds no tool call at all: an internal agent (prompt suggestions, a side question) reports the
// session's own agent_type under `claude --agent`, and is not a build.
import fs from "node:fs";
import path from "node:path";
import { anyJson, readJsonOrNull } from "../bridge/src/read-json.ts";
import { lifecycleOf } from "./plan-status.ts";
import { dropHeredocBodies, simpleCommands } from "./shell-words.ts";
import { isJsonObject } from "./types.ts";
import type { PlanLifecycle } from "./types.ts";
import type { BadPlan, PlanFile } from "./node-artefacts.ts";
import type { HookPayload } from "./hook-input.ts";

/** sessionClaim()'s input: the hook payload, the project root it resolves against, and design/plan/'s plans. */
export interface ClaimInput {
  payload: HookPayload;
  cwd: string;
  /** the plans the hook still has work on (verify-build.ts isOpen) */
  open: readonly PlanFile[];
  /** every readable plan (open or not): a claim on a closed one claims nothing to check, but it IS a claim */
  all: readonly PlanFile[];
  /** the plans that could not be read */
  bad: readonly BadPlan[];
}

/** The verdict.
 *  - `unscoped`: no readable transcript — check every open plan.
 *  - `claimed`: check `plans` (the open ones claimed; none when only closed plans were) and block on `unreadable` (the
 *    unreadable plans this session wrote). Also the verdict when nothing is open and nothing unreadable was written.
 *  - `none`: open plans exist and the session claimed none of them (nor wrote an unreadable one): check nothing;
 *    `sendBack` — this is a screen-builder's SubagentStop to send back once. */
export type SessionClaim =
  | { kind: "unscoped"; plans: PlanFile[] }
  | { kind: "claimed"; plans: PlanFile[]; unreadable: BadPlan[] }
  | { kind: "none"; sendBack: boolean };

/** The phrase the send-back request holds: its presence in a hook-feedback entry of the transcript means "already asked". */
export const NO_CLAIM_MARK = "are stopping without claiming a plan, so your build has NOT been checked";

/** The builder agent hooks.json gates: the plugin-scoped name, or the bare one (the agent copied into a project's .claude/agents/). */
const BUILDER_AGENT = /^(designtwin:)?screen-builder$/;

export function sessionClaim({ payload, cwd, open, all, bad }: ClaimInput): SessionClaim {
  if (!open.length && !bad.length) return { kind: "claimed", plans: [], unreadable: [] }; // nothing to claim: the transcript is not read
  const agent = typeof payload.agent_transcript_path === "string" && !!payload.agent_transcript_path;
  // the session transcript is never used to scope a SUBAGENT's stop
  const file = payload.agent_transcript_path || (payload.agent_id ? null : payload.transcript_path);
  if (!file || typeof file !== "string") return { kind: "unscoped", plans: [...open] };
  let scan: TranscriptScan;
  // the session transcript may carry a subagent's sidechain entries: those are not this session's actions
  try { scan = scanTranscript(file, !agent); } catch { return { kind: "unscoped", plans: [...open] }; }
  const wrote = (rel: string): boolean => scan.writes.some((w) => sameFile(w, rel, cwd));
  const relOf = (file: string): string => path.relative(cwd, path.resolve(file));
  // rule (b): a written file claims the ONE open plan that lists it; a file two or more open plans list claims none
  const listers = new Map<string, number>();
  for (const p of open) for (const f of new Set(p.plan.files || [])) listers.set(f, (listers.get(f) || 0) + 1);
  const owns = (p: PlanFile): boolean => wrote(relOf(p.file)) || (open.includes(p) && (p.plan.files || []).some((f) => listers.get(f) === 1 && wrote(f)));
  const unreadable = bad.filter((b) => wrote(relOf(b.file)) && !closedStatusOf(b));
  const known = all.length ? all : open;
  if (known.some(owns) || unreadable.length || !open.length) return { kind: "claimed", plans: open.filter(owns), unreadable };
  const builder = payload.hook_event_name === "SubagentStop" && typeof payload.agent_type === "string" && BUILDER_AGENT.test(payload.agent_type);
  return { kind: "none", sendBack: builder && scan.toolUses > 0 && !scan.sentBack };
}

/** The closed status ("abandoned", "awaiting-user") the raw JSON of an unreadable plan holds, or null when it holds none:
 *  parsePlan, which fails on such a plan, never gets as far as the status. */
export function closedStatusOf(b: BadPlan): PlanLifecycle | null {
  const life = lifecycleOf(readJsonOrNull(b.file, anyJson));
  return life === "pending" ? null : life;
}

// ================================================================ the transcript

/** A path the session wrote, and the directory it was relative to (the entry's `cwd`, when recorded). */
interface WrittenPath { path: string; base: string | null }
/** What a transcript tells the hook: the paths its tool calls write, how many tool calls it holds, and whether it already
 *  holds the send-back request (NO_CLAIM_MARK) — the builder was sent back once before. */
interface TranscriptScan { writes: WrittenPath[]; toolUses: number; sentBack: boolean }

function scanTranscript(file: string, ownOnly: boolean): TranscriptScan {
  const scan: TranscriptScan = { writes: [], toolUses: 0, sentBack: false };
  forEachLine(file, (line) => {
    if (!scan.sentBack && line.includes(NO_CLAIM_MARK) && isHookFeedback(line)) scan.sentBack = true;
    if (mayHoldToolUse(line)) scan.toolUses += lineActions(line, ownOnly, scan.writes);
  });
  return scan;
}

// The send-back request reaches the builder as a user-role entry that is not a tool_result. The phrase in any other entry
// (the builder's own tool_use, its text, a tool_result of it reading this script's source) is not that delivery.
function isHookFeedback(line: string): boolean {
  let v: unknown = null;
  try { const parsed: unknown = JSON.parse(line); v = parsed; } catch { return false; }
  if (!isJsonObject(v) || !isJsonObject(v.message) || v.message.role !== "user") return false;
  const c = v.message.content;
  return typeof c === "string" || (Array.isArray(c) && !c.some((item) => isJsonObject(item) && item.type === "tool_result"));
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// The paths one transcript line's tool_use items write, appended to `out`; returns how many tool_use items it holds.
function lineActions(line: string, ownOnly: boolean, out: WrittenPath[]): number {
  if (!line.trim()) return 0;
  let v: unknown = null;
  try { const parsed: unknown = JSON.parse(line); v = parsed; } catch { return 0; }
  if (!isJsonObject(v) || (ownOnly && v.isSidechain === true) || !isJsonObject(v.message) || !Array.isArray(v.message.content)) return 0;
  let uses = 0;
  for (const item of v.message.content) {
    if (!isJsonObject(item) || item.type !== "tool_use") continue;
    uses++;
    if (typeof item.name !== "string" || !isJsonObject(item.input)) continue;
    const inp = item.input;
    const base = typeof v.cwd === "string" && v.cwd ? v.cwd : null;
    if (WRITE_TOOLS.has(item.name)) { for (const k of ["file_path", "notebook_path"]) { const f = inp[k]; if (typeof f === "string") out.push({ path: f, base }); } }
    else if (SHELL_TOOLS.has(item.name) && typeof inp.command === "string") for (const f of planSkeletonOuts(inp.command, item.name === "PowerShell")) out.push({ path: f, base });
  }
  return uses;
}

// A transcript is tens of MB, mostly tool_result text, and only a line holding a tool_use item can claim a plan. Such a
// line holds the JSON string "tool_use": written plainly by Claude Code, or (by another JSON writer) with some of its
// letters as \uXXXX escapes, which the second test admits. A line passing neither cannot hold `type: "tool_use"`, so it is
// skipped without JSON.parse.
const TOOL_USE_ESCAPED = /"(?:t|\\u0074)(?:o|\\u006f)(?:o|\\u006f)(?:l|\\u006c)(?:_|\\u005f)(?:u|\\u0075)(?:s|\\u0073)(?:e|\\u0065)"/i;
const mayHoldToolUse = (line: string): boolean => line.includes('"tool_use"') || (line.includes("\\u") && TOOL_USE_ESCAPED.test(line));

// The file's lines exactly as readFileSync(file, "utf8").split("\n") gives them, read LINE_CHUNK bytes at a time so a large
// transcript is never held whole. A chunk is decoded only up to its last newline byte (0x0A never occurs inside a
// multi-byte UTF-8 sequence), so every decoded piece starts and ends on a character boundary.
const LINE_CHUNK = 1 << 20;
function forEachLine(file: string, onLine: (line: string) => void): void {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(LINE_CHUNK);
    let carry: Buffer[] = [];
    for (;;) {
      const n = fs.readSync(fd, buf, 0, LINE_CHUNK, null);
      if (n === 0) break;
      const cut = buf.subarray(0, n).lastIndexOf(0x0a);
      if (cut < 0) { carry.push(Buffer.from(buf.subarray(0, n))); continue; }
      const head = buf.subarray(0, cut);
      const text = (carry.length ? Buffer.concat([...carry, head]) : head).toString("utf8");
      for (const line of text.split("\n")) onLine(line);
      carry = cut + 1 < n ? [Buffer.from(buf.subarray(cut + 1, n))] : [];
    }
    onLine(Buffer.concat(carry).toString("utf8"));
  } finally { fs.closeSync(fd); }
}

// The plan files a shell command (the Bash tool's, or the PowerShell tool's — on by default on Windows without Git Bash,
// same `command` input) creates through plan-skeleton (see OWNERSHIP): the `--out <path>` / `--out=<path>` of each simple
// command with a word naming the plan-skeleton script (`plan-skeleton.js`, `.ts`, …) — run directly, through node/npx/tsx
// or PowerShell's `&`, or merely named (`echo plan-skeleton.js --out x` counts too: a miss would leave a plan unchecked, a
// false claim only checks one). A directory change earlier in the same command line (cd, pushd, chdir, `builtin cd`,
// PowerShell's Set-Location/sl/Push-Location) is followed, so a relative `--out` after it resolves under that dir. After
// one it cannot follow — no target, `-`, `~…`, a `$` expansion, popd, or any cd on a line with a `( … )` subshell or a
// `$( … )`/backtick substitution (simpleCommands flattens those, so a cd inside one cannot be told from one outside it) —
// a relative `--out` is tried against the entry's cwd, the likeliest root: a false claim needs that exact plan to exist.
// Heredoc bodies are data, not commands. A PowerShell command is split with PowerShell's quoting (a backslash is a plain
// character, a backtick an escape).
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PLAN_SKELETON = /^plan-skeleton(\.[cm]?[jt]s)?$/i;
const CHANGE_DIR = /^(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)$/i;
const isAbsPath = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(p);
function planSkeletonOuts(cmd: string, powershell = false): string[] {
  const out: string[] = [];
  const text = powershell ? cmd : dropHeredocBodies(cmd);
  const nested = (powershell ? /\(/ : /[(`]/).test(text);
  let dir: string | null = ""; // "" = the transcript entry's cwd; null = a directory this cannot follow
  const under = (d: string, p: string): string => (d && !isAbsPath(p) ? `${d.replace(/[\\/]+$/, "")}/${p}` : p);
  for (const all of simpleCommands(text, { powershell })) {
    const words = all[0] === "builtin" || all[0] === "command" ? all.slice(1) : all;
    const head = words[0] ?? "";
    if (CHANGE_DIR.test(head)) {
      const to = /^pop/i.test(head) ? undefined : words.slice(1).find((w) => w === "-" || !w.startsWith("-"));
      dir = nested || to === undefined || to === "-" || /^~|\$|`/.test(to) ? null : isAbsPath(to) ? to : dir === null ? null : under(dir, to);
      continue;
    }
    if (!words.some((w) => PLAN_SKELETON.test(w.split(/[\\/]/).pop() ?? ""))) continue;
    words.forEach((w, k) => {
      const eq = /^--out=(.+)$/.exec(w);
      const target = w === "--out" ? words[k + 1] : eq?.[1];
      if (target) out.push(dir === null ? target : under(dir, target));
    });
  }
  return out;
}

// Does a path the session wrote name `rel` (project-relative) under `cwd`?
function sameFile(w: WrittenPath, rel: string, cwd: string): boolean {
  const c = w.path.trim().replace(/\\/g, "/");
  if (!c) return false;
  const want = path.resolve(cwd, rel).replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(c) && !/^[A-Za-z]:\//.test(want)) return path.posix.normalize(c).toLowerCase().endsWith("/" + path.posix.normalize(rel.replace(/\\/g, "/")).toLowerCase());
  const got = path.resolve(w.base || cwd, c).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(want) ? got.toLowerCase() === want.toLowerCase() : got === want;
}
