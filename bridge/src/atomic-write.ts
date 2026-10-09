// The one atomic file write: a tmp file beside the target, then a rename over it. Shared by bridge/ and
// design-to-code/ (the layer may import bridge/src; bridge cannot import the layer).
//
// rename(2) replaces the destination atomically on POSIX, so a run killed mid-write (Ctrl-C, OOM) leaves the
// PREVIOUS file whole instead of a truncated one every later reader fails on. The tmp file sits in the target's
// own directory so the rename never crosses a filesystem. There is no fsync: these files are re-creatable
// exports, plans and reports, and the guarantee wanted is "never half a file after a killed process", which
// rename gives; surviving a power cut would cost a sync per write on hundreds of layer files.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A `.tmp-<pid>-<random>` suffix: unique per call, so two writers (two processes, or two writes in one) never
 *  share a tmp name, and a stale tmp from a killed run is never reused. */
export const tmpSuffix = (): string => `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

/** Writes `data` to `file` atomically: a reader sees the old file or the new one, never half of either. The parent
 *  directory is created when missing. On any error the tmp file is removed, the old file is left as it was and the
 *  error is rethrown. `mode`: the new file's permission bits (a secret passes 0o600) — applied to the tmp file
 *  with open(2)'s mode AND chmod, because the umask masks the first. Without `mode` the umask default applies. */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = file + tmpSuffix();
  try {
    // "wx": exclusive create — never follows a symlink planted at the tmp name
    fs.writeFileSync(tmp, data, { flag: "wx", ...(opts.mode === undefined ? {} : { mode: opts.mode }) });
    if (opts.mode !== undefined) fs.chmodSync(tmp, opts.mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}
