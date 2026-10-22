// run-cache.ts — where a project's tool-owned scratch files go (a verification run's live status, staged files and
// status locks; the plans' write locks): the run cache, never the tree a dev server watches or git tracks. The one
// resolver, shared by verify-run (status) and plan-record (plans), so every caller finds the same files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { lockFileOf } from "../bridge/src/file-lock.ts";
import { errCode } from "../bridge/src/errmsg.ts";
import { VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { anyJson, readJson } from "./read-json.ts";
import { isJsonObject } from "./types.ts";

/** The run cache's own directory name (under a project's node_modules/.cache/, or the OS temp dir). */
export const CACHE_NAME = "designtwin-verify";
/** A project's run cache, as path segments below its root: node_modules/.cache/<CACHE_NAME>. */
export const RUN_CACHE_SEGMENTS: readonly string[] = ["node_modules", ".cache", CACHE_NAME];
const shortSha = (s: string): string => sha256Hex(s).slice(0, 16);
const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = (p: string): boolean => fs.existsSync(p);
/** fs.realpathSync.native (the on-disk spelling: on a case-insensitive filesystem `Design/Verify` and `design/verify`
 *  are one directory, so they must be one key), else fs.realpathSync; throws when `p` does not exist. */
function realpath(p: string): string {
  if (typeof fs.realpathSync.native === "function") {
    try { return fs.realpathSync.native(p); } catch { /* fall through: the JS resolver says whether it exists */ }
  }
  return fs.realpathSync(p);
}
/** The realpath of `p`, or of its nearest existing ancestor joined with the rest (the verify dir may not exist yet). */
export function canonical(p: string): string {
  const abs = path.resolve(p);
  try { return realpath(abs); } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonical(parent), path.basename(abs));
  }
}
const hasPnp = (d: string): boolean => exists(path.join(d, ".pnp.cjs")) || exists(path.join(d, ".pnp.js"));
/** A workspace root: its package.json declares `workspaces`, or it has a pnpm-workspace.yaml. */
function isWorkspaceRoot(d: string): boolean {
  if (exists(path.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== undefined;
}
/**
 * Where the run cache of `verifyDir` goes — always inside the project, never an unrelated ancestor (a stray
 * ~/node_modules is outside the Claude Code sandbox's default write scope, cwd + the per-user temp dir):
 *   P = the nearest directory at or above it with a package.json (the walk stops at a `.git` boundary);
 *   P/node_modules exists → P;
 *   else the nearest workspace root at or above P (package.json `workspaces`, or pnpm-workspace.yaml — dependencies
 *   hoisted there), never past a `.git` boundary, when it has a node_modules → that root;
 *   else, unless P or that root is Yarn PnP (.pnp.cjs / .pnp.js) → P (its node_modules/.cache is created on write);
 * null (the OS temp dir) when there is no package.json at all, or PnP.
 */
function installRootOf(dir: string): string | null {
  let P: string | null = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, "package.json"))) { P = d; break; }
    if (exists(path.join(d, ".git")) || path.dirname(d) === d) return null;
  }
  if (isDir(path.join(P, "node_modules"))) return P;
  let ws: string | null = null;
  for (let d = P; ; d = path.dirname(d)) {
    if (isWorkspaceRoot(d)) { ws = d; break; }
    if (exists(path.join(d, ".git")) || path.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || (ws !== null && hasPnp(ws))) return null;
  return P;
}
/** The run cache of a verify directory and the directory it belongs to (the project root, or the verify dir itself
 *  for the temp-dir fallback) — see runCacheDir. */
export function runCacheOf(verifyDir: string): { dir: string; root: string } {
  const v = canonical(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path.join(root, ...RUN_CACHE_SEGMENTS);
    const rel = path.relative(root, v).split(path.sep).join("/");
    return { dir: rel === VERIFY_DIR.split(path.sep).join("/") ? cache : path.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
/**
 * The run cache of a verify directory: `<root>/node_modules/.cache/designtwin-verify/`, root = the project that owns
 * the verify dir (installRootOf: its package.json's directory, or the workspace root its dependencies are hoisted to;
 * a verify dir other than `<root>/design/verify` gets its own `dirs/<key>/` below it, key = a short sha256 of its
 * path relative to root); else — no package.json, or Yarn PnP — `<os tmpdir>/designtwin-verify/<key>/`, key = a
 * short sha256 of the verify dir's realpath. That fallback is NOT shared between sandboxed and unsandboxed commands
 * (the sandbox gives them different tmp dirs), so there every --status / --wait / probe of a run must run the same
 * way. The ONE resolver: --status, --wait, verify-probe --run and --compare all go through it, so every caller
 * finds the same file.
 */
export function runCacheDir(verifyDir: string): string {
  return runCacheOf(verifyDir).dir;
}
/**
 * The write lock of a plan: `<root>/node_modules/.cache/designtwin-verify/plan-locks/<plan name>.<key>.lock`, root =
 * the project that owns the plan (as for the run cache), key = a short sha256 of the plan's real path relative to
 * root — so a lock a killed writer leaves is never beside the plan, where it could be committed. With no such root
 * (no package.json, or Yarn PnP) it is `<plan>.lock` beside the plan: the temp-dir fallback is not shared between
 * sandboxed and unsandboxed commands, and the agent's plan writes and the Stop hook's must take the same lock. There a
 * writer killed while it held the lock, or inside its turn breaking a dead one, can leave `<plan>.lock` or
 * `<plan>.lock.break` in the plan directory; dtwin init writes no .gitignore, so such a project ignores
 * `design/plan/*.lock` and `design/plan/*.lock.break` itself.
 * `cache` is the run cache the lock lives in (its dir and the root), null for the lock beside the plan.
 */
export function planLockOf(planFile: string): { lockFile: string; cache: { dir: string; root: string } | null } {
  const abs = canonical(planFile);
  const root = installRootOf(path.dirname(abs));
  if (root === null) return { lockFile: lockFileOf(planFile), cache: null };
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const dir = path.join(root, ...RUN_CACHE_SEGMENTS);
  return { lockFile: path.join(dir, "plan-locks", `${path.basename(abs)}.${shortSha(rel)}.lock`), cache: { dir, root } };
}
/** The write lock of a plan (planLockOf). */
export const planLockFile = (planFile: string): string => planLockOf(planFile).lockFile;
/** Refusals of a plan's lock in the run cache that are the run cache's (the sandbox's write scope, a read-only mount):
 *  worded like a status write's. A plan write never falls back to a lock beside the plan — two writers would then
 *  hold two different locks. */
const PLAN_LOCK_UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS"]);
/** What taking the plan lock of `planFile` threw → RunCacheUnwritable when the run cache refused it, else as it is. */
export function planLockRefused(planFile: string, e: unknown): unknown {
  const code = errCode(e);
  const { cache } = planLockOf(planFile);
  return cache !== null && code !== undefined && PLAN_LOCK_UNWRITABLE.has(code) ? new RunCacheUnwritable(cache.dir, cache.root, code) : e;
}

/** Filesystem refusals that mean "this process may not write there" (the sandbox's write scope, a read-only mount), or
 *  that the run cache's path is gone (ENOENT, ENOTDIR — see GONE_CODES). */
export const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOENT", "ENOTDIR"]);
/** The refusals that say a directory on the run cache's path is gone, not a permission. ENOTDIR as well as ENOENT: a
 *  node_modules that is a link to a removed directory (a reinstall mid-run) is ENOENT on POSIX but ENOTDIR from Bun's
 *  mkdir on Windows (the link is there, not a directory), and a node_modules replaced by a file is ENOTDIR everywhere. */
const GONE_CODES = new Set(["ENOENT", "ENOTDIR"]);
/** A write into the run cache was refused: the one sentence --status (exit 6), --wait (exit 6) and the probe (a warning) print. */
export class RunCacheUnwritable extends Error {
  readonly cacheDir: string;
  readonly root: string;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT / ENOTDIR are
   *  not a permission: a directory on the way was removed while the run wrote there */
  constructor(cacheDir: string, root: string, code: string) {
    super(GONE_CODES.has(code)
      ? `run cache ${cacheDir} disappeared — was node_modules reinstalled during the run? (a reinstall clears node_modules/.cache: the live status and the staged files with it) — start a new run once it is back`
      : `run cache ${cacheDir} is not ${code === "read" ? "readable" : "writable"} (sandbox write scope?) — run from ${root} or allow ${code === "read" ? "access" : "writes"} there`);
    this.name = "RunCacheUnwritable";
    this.cacheDir = cacheDir;
    this.root = root;
  }
}
