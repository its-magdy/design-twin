// file-memo.ts — a value computed from a file's contents, remembered across pulls in one process while the file
// is provably unchanged. A process that pulls many screens (the daemon, the MCP server, a multi-screen CLI run)
// would otherwise re-read every file a pull consults on every pull: the shared assets/ directory
// (asset-compare.ts FileKeyCache) and every other screen's .assets.json (write-out.ts otherScreenTrees). The
// memo lives in memory only: a sidecar file in the export would have to be trusted across processes and dtwin
// versions (a changed rule would silently keep old values), and the one-shot CLI pulls few screens per process.
//
// A remembered value is used only while the file's identity and status are unchanged: size, mtime, ctime, inode
// and device all equal to what they were when the value was computed. ctime is set by the kernel on every write,
// rename-over or utimes call and cannot be set back by a user, so a file rewritten with the same size and a
// preserved or restored mtime still misses; a file replaced by rename (atomic-write.ts) has a new inode as well.
// Timestamp precision is platform specific (whole seconds on some file systems, coarse ctime steps on Windows),
// so a rewrite within the same tick could keep every field equal; a value is therefore stored only for a file
// whose mtime and ctime are both at least `recentMs` (default 2 s) in the past — a file still being written to,
// or written in the last tick, is always read again. The stat is read as bigint: a JavaScript number holds
// integers exactly only up to 2^53, and inode numbers above that (NTFS file ids, some NFS and exFAT volumes) would
// round, so two different files could compare as one; nanosecond times come with it.
import fs from "node:fs";

interface Entry<V> { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; dev: bigint; value: V }
export interface FileMemoOptions { recentMs?: number; maxEntries?: number; now?: () => number }

export class FileMemo<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly recentMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  constructor(o: FileMemoOptions = {}) {
    this.recentMs = o.recentMs ?? 2000;
    this.maxEntries = o.maxEntries ?? 50_000;
    this.now = o.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); }

  /** `compute()` for `file` — it reads the file itself — or the value it gave while the file is unchanged.
   *  undefined when `file` cannot be stat'ed (compute is not called) or when compute returns undefined (nothing is
   *  stored). A path that is not a regular file is computed every time and never stored. */
  get(file: string, compute: () => V | undefined): V | undefined {
    // The clock is read before the stat, so the window is measured from no later than the moment the file was seen.
    const now = this.now();
    let st: fs.BigIntStats;
    try { st = fs.statSync(file, { bigint: true }); } catch { return undefined; }
    if (!st.isFile()) return compute();
    const hit = this.entries.get(file);
    if (hit && hit.size === st.size && hit.mtimeNs === st.mtimeNs && hit.ctimeNs === st.ctimeNs && hit.ino === st.ino && hit.dev === st.dev) {
      this.entries.delete(file); this.entries.set(file, hit); // most recently used last
      return hit.value;
    }
    this.entries.delete(file);
    const value = compute();
    if (value === undefined) return undefined;
    // `st` is from before the read: a change between the two moves ctime past it, so the next stat misses.
    const changedNs = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
    if (changedNs <= BigInt(Math.floor(now - this.recentMs)) * 1_000_000n) {
      this.entries.set(file, { size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, ino: st.ino, dev: st.dev, value });
      for (const oldest of this.entries.keys()) { if (this.entries.size <= this.maxEntries) break; this.entries.delete(oldest); }
    }
    return value;
  }
}
