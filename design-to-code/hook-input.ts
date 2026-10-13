// hook-input.ts — reads a Claude Code hook's JSON payload off stdin, for the plugin's hook scripts
// (verify-build.ts, the SubagentStop gate; verifier-guard.ts, the visual-verifier's PreToolUse guard).
//
// stdin is read ONLY when fd 0 is not a TTY. A regular file or /dev/null reads to EOF at once; a
// pipe/socket is read asynchronously with two deadlines, so an inherited pipe that never closes
// ("same command, two different outcomes") cannot stall the hook: one that delivers nothing within
// `waitMs` is "no payload", and one that delivers bytes but no end-of-file is cut off at `hardMs`
// with the caller's message. Whatever the pipe carried, only a JSON object is a payload (anything
// else reads as an empty one).
import fs from "node:fs";
import { isJsonObject } from "./types.ts";
import type { JsonObject } from "./types.ts";

/** A hook payload as read off stdin: arbitrary JSON from Claude Code, so a plain JSON object. */
export type HookPayload = JsonObject;
/** readHookInput()'s result: a payload and where it came from, or an error naming what stalled. */
export interface HookRead { payload?: HookPayload; source?: string; error?: string }
export interface HookReadOptions {
  /** How long a pipe may stay silent before it counts as "no payload". */
  waitMs: number;
  /** When a payload with no end-of-file is given up on. */
  hardMs: number;
  /** The error for a payload cut off at hardMs, given the bytes received so far. */
  stalled: (bytes: number) => string;
}

export function parseHookPayload(raw: string): HookPayload {
  if (!raw.trim()) return {};
  try { const v: unknown = JSON.parse(raw); return isJsonObject(v) ? v : {}; } catch { return {}; }
}

export function readHookInput(opts: HookReadOptions): Promise<HookRead> {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st: fs.Stats;
  try { st = fs.fstatSync(0); } catch { return Promise.resolve({ payload: {}, source: "closed" }); }
  if (st.isFile() || st.isCharacterDevice()) {
    try { return Promise.resolve({ payload: parseHookPayload(fs.readFileSync(0, "utf8")), source: "file" }); } catch { return Promise.resolve({ payload: {}, source: "unreadable" }); }
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0, finished = false;
    const done = (value: HookRead): void => {
      if (finished) return;
      finished = true;
      clearTimeout(first); clearTimeout(hard);
      process.stdin.removeAllListeners("data"); process.stdin.removeAllListeners("end");
      try { process.stdin.pause(); process.stdin.unref && process.stdin.unref(); } catch { /* ignore */ }
      resolve(value);
    };
    const first = setTimeout(() => { if (!bytes) done({ payload: {}, source: "silent-pipe" }); }, opts.waitMs);
    const hard = setTimeout(() => done({ error: opts.stalled(bytes) }), opts.hardMs);
    process.stdin.on("data", (c: Buffer) => { bytes += c.length; chunks.push(c); });
    process.stdin.on("end", () => done({ payload: parseHookPayload(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}
