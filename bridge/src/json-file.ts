// The writer for JSON files a person also edits (plans, the component map): atomic, and in the file's own format.
// Shared by bridge/ and design-to-code/ (the layer may import bridge/src; bridge cannot import the layer).
import fs from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { errCode } from "./errmsg.ts";
import { lockFileOf, withFileLock } from "./file-lock.ts";
import type { FileLockOpts } from "./file-lock.ts";

// The file's own indentation: the first indented line's leading whitespace (2 spaces when the file has none).
const indentOf = (text: string): string => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";

/** `value` as the text of the file it replaces — that file's BOM, indentation, line endings and final newline.
 *  `raw` is the file as read; null (no file yet) → 2 spaces, LF, a final newline. */
export function formatJsonLike(value: unknown, raw: string | null): string {
  if (raw === null) return JSON.stringify(value, null, 2) + "\n";
  const bom = raw.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  const text = raw.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return bom + JSON.stringify(value, null, indentOf(text)).split("\n").join(eol) + (/\n$/.test(text) ? eol : "");
}

/** Formats `value` like the file (formatJsonLike over `raw`, else the file as it is on disk now) and writes it
 *  atomically — a tmp file beside it, then a rename, so a kill mid-write leaves the old file whole — only when the
 *  bytes change. True when written. */
export function writeJsonLike(file: string, value: unknown, raw?: string | null): boolean {
  let was: string | null = raw ?? null;
  if (raw === undefined) try { was = fs.readFileSync(file, "utf8"); } catch { was = null; }
  const out = formatJsonLike(value, was);
  if (out === was) return false;
  writeFileAtomic(file, out);
  return true;
}

/** How often updateJsonLike starts over when the file changed under it. */
const UPDATE_TRIES = 3;
const readIfThere = (file: string): string | null => {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { if (errCode(e) === "ENOENT") return null; throw e; }
};
export interface UpdateJsonOpts extends FileLockOpts {
  /** the lock file to hold (default `<file>.lock` beside it) */
  lockFile?: string;
  /** runs right after the write, still under the lock — only when the file was written */
  afterWrite?: () => void;
}
/**
 * Read-modify-write of a JSON file several writers share (a plan: --record-plan, --accept, plan-skeleton --out, the
 * verify-build hook). Under the lock `opts.lockFile` (default `<file>.lock`; file-lock.ts) it reads the file (null
 * when there is none), gives the text to `fn`, which returns the new value, and writes it like writeJsonLike —
 * formatted like the file, atomic, only when the bytes change; true when written. Two tool writers never interleave:
 * the second reads what the first wrote. A writer that takes no lock (an agent's Edit/Write) is caught by reading the
 * file again before the rename — changed bytes start over from them (up to UPDATE_TRIES times, then it throws); its
 * write landing between that re-read and the rename is still lost. `fn` may run more than once, so it computes from
 * its argument only. Throws LockBusy (file-lock.ts) when another writer holds the lock past `opts.waitMs`, LockLost
 * when the lock was taken from this writer before its write (nothing written), and whatever reading the file throws
 * other than ENOENT (an unreadable plan is never treated as absent and overwritten).
 */
export function updateJsonLike(file: string, fn: (raw: string | null) => unknown, opts: UpdateJsonOpts = {}): boolean {
  const { lockFile = lockFileOf(file), afterWrite, ...lockOpts } = opts;
  return withFileLock(lockFile, (lock) => {
    for (let tries = 1; ; tries++) {
      const raw = readIfThere(file);
      const out = formatJsonLike(fn(raw), raw);
      if (out === raw) return false;
      if (readIfThere(file) === raw) {
        lock.assertMine();
        writeFileAtomic(file, out);
        afterWrite?.();
        return true;
      }
      if (tries >= UPDATE_TRIES) throw new Error(`${file} kept changing while it was being updated (${UPDATE_TRIES} tries) — retry once its other writer is done`);
    }
  }, lockOpts);
}
