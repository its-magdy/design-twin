// The one atomic file write: a tmp file beside the target, then a rename over it. Shared by bridge/ and
// design-to-code/ (the layer may import bridge/src; bridge cannot import the layer).
//
// rename(2) replaces the destination atomically on POSIX, so a run killed mid-write (Ctrl-C, OOM) leaves the
// PREVIOUS file whole instead of a truncated one every later reader fails on. The tmp file sits in the target's
// own directory so the rename never crosses a filesystem. There is no fsync by default: these files are
// re-creatable exports, plans and reports, and the guarantee wanted is "never half a file after a killed process",
// which rename gives; surviving a power cut would cost a sync per write on hundreds of layer files. A file that has
// to outlive a power cut as well (a migration's journal) passes `sync`. `sync` is fsyncSync (node:fs). On macOS a
// plain fsync does not flush the drive's write cache (that takes fcntl F_FULLFSYNC); which one Bun issues is unverified.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errCode } from "./errmsg.ts";

/** A `.tmp-<pid>-<random>` suffix: unique per call, so two writers (two processes, or two writes in one) never
 *  share a tmp name, and a stale tmp from a killed run is never reused. */
export const tmpSuffix = (): string => `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

// On Windows a rename over a file that another process has open — a reader polling it (verify-screen --wait reads the live
// status every --interval while the verifier writes it), an antivirus scan or an indexer — is refused
// (ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION → EPERM, EACCES, EBUSY) until that handle closes, which is a moment: the
// rename is retried for up to RENAME_RETRY_MS (as graceful-fs does for npm) before the refusal stands. POSIX renames over
// an open file at once; there the first error is final — as it is for a target that is a directory (a refusal no handle
// closing will lift).
const RENAME_RETRY_MS = 2_000;
const RENAME_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** fs.renameSync(from, to), retried on Windows while the refusal can be another process's open handle (see above). */
export function renameOver(from: string, to: string): void {
  const t0 = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try { fs.renameSync(from, to); return; } catch (e) {
      const code = errCode(e);
      if (process.platform !== "win32" || code === undefined || !RENAME_TRANSIENT.has(code) || Date.now() - t0 >= RENAME_RETRY_MS) throw e;
      let dir = false;
      try { dir = fs.statSync(to).isDirectory(); } catch { /* gone or unreadable: retried */ }
      if (dir) throw e;
      Atomics.wait(sleeper, 0, 0, delay);
    }
  }
}

/** The directory's entries flushed to disk (a rename into it, made durable). Not on Windows, where a directory
 *  cannot be opened for it; a filesystem that refuses it keeps the rename as it is. */
function syncDir(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(dir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* no directory fsync here: the rename stands, only its durability is the filesystem's */ }
}

/** Writes `data` to `file` atomically: a reader sees the old file or the new one, never half of either. The parent
 *  directory is created when missing. On any error the tmp file is removed, the old file is left as it was and the
 *  error is rethrown. `mode`: the new file's permission bits (a secret passes 0o600) — applied to the tmp file
 *  with open(2)'s mode AND chmod, because the umask masks the first. Without `mode` the umask default applies.
 *  `sync`: the bytes are fsynced before the rename and the directory after it, so the new file survives a power
 *  cut too. */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number; sync?: boolean } = {}): void {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + tmpSuffix();
  try {
    // "wx": exclusive create — never follows a symlink planted at the tmp name
    if (opts.sync) {
      const fd = fs.openSync(tmp, "wx", opts.mode);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } else {
      fs.writeFileSync(tmp, data, { flag: "wx", ...(opts.mode === undefined ? {} : { mode: opts.mode }) });
    }
    if (opts.mode !== undefined) fs.chmodSync(tmp, opts.mode);
    renameOver(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  if (opts.sync) syncDir(dir);
}
