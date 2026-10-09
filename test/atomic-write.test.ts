// The shared atomic write (bridge/src/atomic-write.ts): content, a unique tmp name beside the target, no tmp left
// after a failure, the old file intact, the 0600 mode for a secret — plus its callers that have no other
// port-free coverage (the token file). Temp dirs only; binds no port.
// Run with:  node test/atomic-write.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { tmpSuffix, writeFileAtomic } from "../bridge/src/atomic-write.ts";
import * as tokenStore from "../bridge/src/token-store.ts";

const t = (name: string, cond: () => boolean): void => {
  let v = false;
  try { v = cond(); } catch (e) { console.log("    threw: " + String(e instanceof Error ? e.message : e)); }
  check(name, v);
};
const roots: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-atomic-")); roots.push(d); return d; };
const tmpsIn = (d: string): string[] => fs.readdirSync(d).filter((n) => n.includes(".tmp-"));
const posix = process.platform !== "win32";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

console.log("writeFileAtomic — content:");
{
  const d = mk();
  const f = path.join(d, "doc.json");
  writeFileAtomic(f, "{\"v\":1}\n");
  writeFileAtomic(f, "{\"v\":2}\n");
  t("writes and replaces; nothing else is left in the directory", () => fs.readFileSync(f, "utf8") === "{\"v\":2}\n" && fs.readdirSync(d).join() === "doc.json");
  const bin = path.join(d, "pic.png");
  writeFileAtomic(bin, new Uint8Array([0x89, 0x50, 0x00, 0xff]));
  t("writes bytes unchanged", () => fs.readFileSync(bin).equals(Buffer.from([0x89, 0x50, 0x00, 0xff])));
  const deep = path.join(d, "a", "b", "doc.json");
  writeFileAtomic(deep, "x");
  t("creates a missing parent directory", () => fs.readFileSync(deep, "utf8") === "x");
}

console.log("writeFileAtomic — a unique tmp name beside the target:");
{
  const d = mk();
  const f = path.join(d, "doc.json");
  const seen: string[] = [];
  const realRename = fs.renameSync;
  fs.renameSync = (from: fs.PathLike, to: fs.PathLike): void => { seen.push(String(from)); realRename(from, to); };
  try { writeFileAtomic(f, "1"); writeFileAtomic(f, "2"); } finally { fs.renameSync = realRename; }
  t("each write renames its own tmp file, in the target's directory, named with the pid", () =>
    seen.length === 2 && seen[0] !== seen[1] && seen.every((s) => path.dirname(s) === d && s.startsWith(f + ".tmp-" + process.pid + "-")));
  t("tmpSuffix is unique across 2000 calls", () => new Set(Array.from({ length: 2000 }, tmpSuffix)).size === 2000);
  // a leftover `<file>.tmp-<pid>` from an older run or another writer is neither reused nor removed
  const stale = f + ".tmp-" + process.pid;
  fs.writeFileSync(stale, "stale");
  writeFileAtomic(f, "3");
  t("a stale tmp file with the old pid-only name is left alone", () => fs.readFileSync(stale, "utf8") === "stale" && fs.readFileSync(f, "utf8") === "3");
}

console.log("writeFileAtomic — failures:");
{
  const d = mk();
  // the rename fails (the target is a non-empty directory)
  const blocked = path.join(d, "report.json");
  fs.mkdirSync(blocked); fs.writeFileSync(path.join(blocked, "keep"), "x");
  let threw = false;
  try { writeFileAtomic(blocked, "new"); } catch { threw = true; }
  t("a failed rename throws and leaves no tmp file beside the target", () => threw && tmpsIn(d).length === 0 && fs.readFileSync(path.join(blocked, "keep"), "utf8") === "x");
  let threwMode = false;
  try { writeFileAtomic(blocked, "new", { mode: 0o600 }); } catch { threwMode = true; }
  t("…also with a mode", () => threwMode && tmpsIn(d).length === 0);
  // the tmp write fails (read-only directory): the old file is left exactly as it was
  if (posix && !isRoot) {
    const ro = path.join(d, "ro");
    fs.mkdirSync(ro);
    const old = path.join(ro, "pic.png");
    fs.writeFileSync(old, "old picture");
    fs.chmodSync(ro, 0o555);
    let threw2 = false;
    try { writeFileAtomic(old, "new picture"); } catch { threw2 = true; }
    fs.chmodSync(ro, 0o755);
    t("a failed tmp write throws, leaves the old file intact and no tmp file", () => threw2 && fs.readFileSync(old, "utf8") === "old picture" && fs.readdirSync(ro).length === 1);
  }
}

console.log("writeFileAtomic — mode:");
if (posix) {
  const d = mk();
  const f = path.join(d, "secret");
  const um = process.umask(0); // open(2)'s mode is masked by the umask; the explicit chmod must win
  try {
    writeFileAtomic(f, "s3cret\n", { mode: 0o600 });
    t("mode 0600 holds under a umask of 0", () => (fs.statSync(f).mode & 0o777) === 0o600);
    fs.chmodSync(f, 0o644);
    writeFileAtomic(f, "again\n", { mode: 0o600 });
    t("replacing a wider file narrows it to 0600", () => (fs.statSync(f).mode & 0o777) === 0o600 && fs.readFileSync(f, "utf8") === "again\n");
  } finally { process.umask(um); }
  process.umask(0o077);
  try {
    const h = path.join(d, "shared");
    writeFileAtomic(h, "x", { mode: 0o660 });
    t("the requested mode is applied past the umask (open(2) alone would give 0600)", () => (fs.statSync(h).mode & 0o777) === 0o660);
  } finally { process.umask(um); }
  process.umask(0o022);
  try {
    const g = path.join(d, "plain");
    writeFileAtomic(g, "x");
    t("without a mode the umask default applies", () => (fs.statSync(g).mode & 0o777) === 0o644);
  } finally { process.umask(um); }
}

console.log("token-store.write — atomic, owner-only:");
{
  const d = path.join(mk(), "cfg");
  const f = path.join(d, "bridge-token");
  tokenStore.write("tok-1", f);
  tokenStore.write("tok-2", f);
  t("the token file holds the last token and nothing else is in the directory", () => fs.readFileSync(f, "utf8") === "tok-2\n" && fs.readdirSync(d).join() === "bridge-token");
  if (posix) t("the token file is 0600 and its directory 0700", () => (fs.statSync(f).mode & 0o777) === 0o600 && (fs.statSync(d).mode & 0o777) === 0o700);
}

for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
report();
