// verify-run.ts — one verification run, as files on disk the tools (not the agent) write: status v2, atomic
// writes, publishing a staged run into design/verify/, and waiting for a run to finish.
//
// Why it exists (field tests F-72, F-91, F-107): the verifier's status file was hand-written prose
// ({screen, phase, detail, at}) with a hand-typed timestamp, two docs disagreed on its phases, nothing tied it
// to the measured file it described, and an orchestrator waited on it with a hand-rolled shell loop (one
// zsh loop never saw the file change). Files were written in place, so a reader could see half a JSON, and the
// agent wrote into design/verify/ while its own browser was open on a dev server that watched that tree (the
// reload that aborted a measurement). So:
//   - status v2: {schema, screen, runId, rev, phase, detail, at, by, shas…} written by the tools; `rev` counts
//     writes within one run (a heartbeat an orchestrator can watch), the shas tie `done` to the exact files;
//   - the LIVE status never touches the project tree a dev server watches: it lives in the run cache,
//     `<project>/node_modules/.cache/designtwin-verify/` (Vite's watcher ignores node_modules, and Tailwind v4's
//     source detection skips it; <project> = the nearest package.json's directory, or the workspace root its
//     dependencies are hoisted to — never an unrelated ancestor outside the sandbox's write scope), else
//     `<os tmpdir>/designtwin-verify/<key>/` (no package.json, or Yarn PnP). A refused write there is one sentence and
//     exit 6 (--status / --wait), a warning from the probe — never a stack.
//     Not $TMPDIR first: with Claude Code's sandbox on, sandboxed and unsandboxed commands resolve $TMPDIR to
//     different directories, so a verifier and its caller would never see the same file. Rewriting an existing
//     text file under design/ is what made Vite (with Tailwind v4 source detection) reload the page being
//     measured; `done` publishes the final status into design/verify/<S>.status.json — the durable record,
//     written once, with every page closed. Readers (--wait, --compare, the next write) prefer the live file and
//     fall back to the published one (or an older v1 file there);
//   - writeFileAtomic: a tmp file BESIDE the target, then rename (same directory → same filesystem → atomic);
//   - publish: the agent stages its artefacts in the run cache (`stage/<runId>/`), and `--status … --publish
//     <dir>` copies them in only after every page is closed (D9) — copy to a tmp name in the target dir, then
//     rename, so a stage dir on another filesystem (EXDEV) works too;
//   - wait: poll the status until THIS run is done and the measured file is the one the status names.
//
//   verify-screen.js --status <S> --phase <p> [--run <id> | --new-run] [--detail …] [--dir design/verify] [--publish <stageDir>]
//   verify-screen.js --wait <S> --run <id> [--timeout <s>] [--stall <s>] [--dir design/verify]
// (on verify-screen.js, so one script path covers every allow rule — the CLI glue is statusMain/waitMain here).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { anyJson, readJson } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import { scriptCmd, shellArg } from "./cli-args.ts";
import { errMsg } from "../bridge/src/errmsg.ts";

export const STATUS_SCHEMA = "designtwin/verify-status@2";
/** Every phase a status v2 can be in, in the order a run normally passes through them. */
export const STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"] as const;
export type StatusPhase = (typeof STATUS_PHASES)[number];
/** Phases after which nothing more happens in this run. */
export const TERMINAL_PHASES: readonly StatusPhase[] = ["done", "failed", "blocked"];
/** Phases at which the measured file is complete — a --compare may read it (D26). */
export const MEASURED_PHASES: readonly StatusPhase[] = ["measured", "done"];
export type StatusWriter = "verify-probe" | "agent" | "orchestrator";

/** design/verify/<S>.status.json, schema @2. */
export interface VerifyStatusV2 {
  schema: typeof STATUS_SCHEMA;
  screen: string;
  runId: string;
  /** 1 for a run's first write, +1 for every later write of the same run */
  rev: number;
  phase: StatusPhase;
  detail: string;
  /** machine time, ISO — written by the tool, never typed by hand */
  at: string;
  by: StatusWriter;
  expectationSha256?: string;
  measuredSha256?: string;
  evidenceSha256?: string;
  /** file names --publish copied into the verify directory */
  published?: string[];
}

const isPhase = (x: unknown): x is StatusPhase => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
const optStr = (x: unknown): boolean => x === undefined || typeof x === "string";
export function isVerifyStatusV2(x: unknown): x is VerifyStatusV2 {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number"
    && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator")
    && optStr(x.expectationSha256) && optStr(x.measuredSha256) && optStr(x.evidenceSha256)
    && (x.published === undefined || (Array.isArray(x.published) && x.published.every((p) => typeof p === "string")));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";

// ---------------------------------------------------------------- files
/** `<base>.status.json` — the PUBLISHED (durable) status in the verify dir; base is design/verify/<S>. */
export const statusFile = (base: string): string => base + ".status.json";
export const sha256Of = (data: string | Uint8Array): string => crypto.createHash("sha256").update(data).digest("hex");
/** sha256 of a file's bytes, or null when it cannot be read. */
export function sha256File(file: string): string | null {
  try { return sha256Of(fs.readFileSync(file)); } catch { return null; }
}

// ---- H1: where a run's live files go — never under the tree a dev server watches
const CACHE_NAME = "designtwin-verify";
const shortSha = (s: string): string => sha256Of(s).slice(0, 16);
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
function canonical(p: string): string {
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
 * Where the run cache of `verifyDir` goes (M-a) — always inside the project, never an unrelated ancestor (a stray
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
    const cache = path.join(root, "node_modules", ".cache", CACHE_NAME);
    const rel = path.relative(root, v).split(path.sep).join("/");
    return { dir: rel === "design/verify" ? cache : path.join(cache, "dirs", shortSha(rel)), root };
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
/** Filesystem refusals that mean "this process may not write there" (the sandbox's write scope, a read-only mount). */
const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);
const errCode = (e: unknown): string | undefined => (e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined);
/** A write into the run cache was refused: the one sentence --status (exit 6), --wait (exit 6) and the probe (a warning) print. */
export class RunCacheUnwritable extends Error {
  readonly cacheDir: string;
  readonly root: string;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT is not a
   *  permission: a directory on the way was removed while the run wrote there (L-4) */
  constructor(cacheDir: string, root: string, code: string) {
    super(code === "ENOENT"
      ? `run cache ${cacheDir} disappeared — was node_modules reinstalled during the run? (a reinstall clears node_modules/.cache: the live status and the staged files with it) — start a new run once it is back`
      : `run cache ${cacheDir} is not ${code === "read" ? "readable" : "writable"} (sandbox write scope?) — run from ${root} or allow ${code === "read" ? "access" : "writes"} there`);
    this.name = "RunCacheUnwritable";
    this.cacheDir = cacheDir;
    this.root = root;
  }
}
/** Run `fn` (a write into the run cache of `verifyDir`); a permission / read-only / missing-dir refusal becomes RunCacheUnwritable. */
export function inRunCache<T>(verifyDir: string, fn: () => T): T {
  try { return fn(); } catch (e) {
    const code = errCode(e);
    if (code !== undefined && UNWRITABLE_CODES.has(code)) { const c = runCacheOf(verifyDir); throw new RunCacheUnwritable(c.dir, c.root, code); }
    throw e;
  }
}
/** The exit code of --status / --wait when the run cache cannot be written (or read). */
export const EXIT_RUN_CACHE = 6;
/** The LIVE status of `<base>` (design/verify/<S>): `<run cache>/<S>.status.json`. */
export const liveStatusFile = (base: string): string => path.join(runCacheDir(path.dirname(base)), path.basename(base) + ".status.json");
/** Where a run stages its evidence and state screenshots until `--publish` (D9): `<run cache>/stage/<runId>/`. */
export const stageDirOf = (base: string, runId: string): string => path.join(runCacheDir(path.dirname(base)), "stage", runId);

/**
 * Write `data` to `file` so that a reader sees the old file or the new one, never half of either: write a tmp
 * file BESIDE the target (same directory, so the same filesystem — rename is atomic only there), then rename it
 * over the target. On any error the tmp file is removed and the old file is left as it was.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/** A run id: time + randomness, sortable, safe in a file name and a shell word. */
export function newRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomBytes(3).toString("hex");
}

function readStatusFile(file: string): VerifyStatusV2 | "v1" | null {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  return isJsonObject(r.doc) && r.doc.schema === undefined && typeof r.doc.phase === "string" ? "v1" : null;
}
/** The status of `<base>` and the file it was read from: the live one first, else the published
 *  `<base>.status.json` (a v2 `done`, or an older hand-written "v1" — read, never trusted for shas); null when neither. */
export function readStatusAt(base: string): { file: string; status: VerifyStatusV2 | "v1" } | null {
  for (const file of [liveStatusFile(base), statusFile(base)]) {
    const status = readStatusFile(file);
    if (status !== null) return { file, status };
  }
  return null;
}
/** readStatusAt() without the file name. */
export function readStatus(base: string): VerifyStatusV2 | "v1" | null {
  const r = readStatusAt(base);
  return r ? r.status : null;
}

export interface StatusWrite {
  runId: string;
  phase: StatusPhase;
  by: StatusWriter;
  detail?: string;
  expectationSha256?: string;
  measuredSha256?: string;
  evidenceSha256?: string;
  published?: string[];
}
/** A status write for a run that has already ended (done/failed/blocked): refused by writeStatus itself, so a writer
 *  that checked at its start (the probe, up to its time budget earlier) cannot reopen the run with a late write. */
export class RunEnded extends Error {
  constructor(runId: string, phase: StatusPhase, detail: string) {
    super(`run ${runId} already ended at ${phase}${detail ? ` (${detail})` : ""} — start a new run with --new-run`);
    this.name = "RunEnded";
  }
}
/**
 * Write the LIVE status of `<base>` atomically (never into the project's watched tree). rev = the previous rev + 1
 * when it is the same run, else 1. Within one run the shas and the published list carry forward (a `driving`
 * write after the probe's `measured` still names the measured file the probe wrote; published is the run's union).
 * Throws RunCacheUnwritable when the run cache refuses the write (sandbox write scope, read-only mount), RunEnded when
 * the same run has already ended.
 */
export function writeStatus(base: string, p: StatusWrite): VerifyStatusV2 {
  const prev = readStatus(base);
  const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
  // an ended run stays ended (live F4): checked HERE, at the write, not only by the caller at its start
  if (same && TERMINAL_PHASES.includes(same.phase)) throw new RunEnded(same.runId, same.phase, same.detail);
  const pick = (k: "expectationSha256" | "measuredSha256" | "evidenceSha256"): { [K in typeof k]?: string } => {
    const v = p[k] ?? (same ? same[k] : undefined);
    return v !== undefined ? { [k]: v } : {};
  };
  const published = p.published !== undefined || (same && same.published) ? [...new Set([...(same && same.published) || [], ...(p.published || [])])].sort() : undefined;
  const doc: VerifyStatusV2 = {
    schema: STATUS_SCHEMA, screen: path.basename(base), runId: p.runId, rev: same ? same.rev + 1 : 1, phase: p.phase, detail: p.detail ?? "", at: new Date().toISOString(), by: p.by,
    ...pick("expectationSha256"), ...pick("measuredSha256"), ...pick("evidenceSha256"),
    ...(published !== undefined ? { published } : {}),
  };
  const live = liveStatusFile(base);
  inRunCache(path.dirname(base), () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n"));
  return doc;
}
/** `done`: the live status, published as the durable record design/verify/<S>.status.json (every page is closed by now). */
export function publishStatus(base: string, doc: VerifyStatusV2): void {
  writeFileAtomic(statusFile(base), JSON.stringify(doc, null, 2) + "\n");
}

// Files the verify tools own: a staged copy must never replace them (--expect / --compare / --status write these;
// L13: --expect keeps a replaced expectation as <S>.expected.prev.json — `*.prev.json` is tool-written too).
const TOOL_OWNED = /\.(expected\.json|report\.json|report\.md|status\.json|prev\.json)$/;
/**
 * Copy every regular file of `stageDir` (top level only) into `destDir`: each goes to `<dest>.tmp-<pid>` IN the
 * destination directory, then is renamed over `<dest>` — so the copy crosses filesystems (EXDEV) and the
 * rename is still atomic. Refuses (nothing copied) a stage dir that is the destination itself or holds a file
 * the verify tools own. Returns the copied names, sorted.
 */
export function publishStaged(stageDir: string, destDir: string): { published: string[] } | { error: string } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stageDir, { withFileTypes: true }); } catch (e) { return { error: `--publish ${stageDir}: ${errMsg(e).split("\n")[0]}` }; }
  // realpaths: a symlinked or ../ spelling of the verify dir is still the verify dir (L-10)
  if (canonical(stageDir) === canonical(destDir)) return { error: `--publish ${stageDir} is the verify directory itself — stage outside the project (D9)` };
  const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
  const owned = files.filter((f) => TOOL_OWNED.test(f));
  if (owned.length) return { error: `--publish refuses ${owned.join(", ")} — expected/report/status files are written by verify-screen itself, never copied in` };
  fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(destDir, f), tmp = `${dest}.tmp-${process.pid}`;
    try {
      fs.copyFileSync(path.join(stageDir, f), tmp);
      fs.renameSync(tmp, dest);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      return { error: `--publish: copying ${f} failed (${errMsg(e).split("\n")[0]}) — files before it were published` };
    }
  }
  return { published: files };
}

// ---------------------------------------------------------------- CLI glue (called from verify-screen.ts main)
/** `<dir>/<S>`: S is a screen name (`--dir` defaults to design/verify); a path with a separator is taken as-is. */
export function runBase(screen: string, dir: string | undefined): string {
  const s = screen.replace(/\.(status|measured|expected|evidence)\.json$/, "");
  return /[\\/]/.test(s) && dir === undefined ? s : path.join(dir ?? path.join("design", "verify"), s);
}

/** The measured file's expectationSha256 (and runId, when it names one), or why it has none. */
function measuredExpectation(file: string): { sha: string; runId?: string } | { error: string } {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { error: `${file} ${r.error}` };
  if (!isJsonObject(r.doc)) return { error: `${file} is not a JSON object` };
  const v = r.doc.expectationSha256, run = r.doc.runId;
  return typeof v === "string" && v ? { sha: v, ...(typeof run === "string" && run ? { runId: run } : {}) } : { error: `${file} names no expectation (expectationSha256)` };
}

/** The checks `done` and `measured` apply before recording a measured file as this run's (M3, M-1): the current
 *  expectation exists, the file exists and names it, names no other run, and is the file the probe recorded in
 *  this run (when it recorded one). Returns the two shas to record, or the refusal (one line, exit 1). */
function checkMeasured(base: string, measFile: string, runId: string, sameRun: VerifyStatusV2 | null, prev: VerifyStatusV2 | null): { expectationSha256: string; measuredSha256: string } | { refused: string } {
  const exp = sha256File(base + ".expected.json");
  if (!exp) return { refused: `${base}.expected.json does not exist — nothing to be done against` };
  const meas = sha256File(measFile);
  if (!meas) return { refused: `${measFile} does not exist — measure first (the probe on web; on native write it with expectationSha256) (phase stays ${prev ? prev.phase : "unset"})` };
  const named = measuredExpectation(measFile);
  if ("error" in named) return { refused: `${named.error} — re-run the probe` };
  if (named.sha !== exp) return { refused: `${measFile} was measured against expectation ${short(named.sha)}, not the current ${short(exp)} — re-run the probe` };
  if (named.runId !== undefined && named.runId !== runId) return { refused: `${measFile} was measured in run ${named.runId}, not ${runId} — re-run the probe with --run ${runId}` };
  if (sameRun && sameRun.measuredSha256 && sameRun.measuredSha256 !== meas) {
    return { refused: `run ${runId} recorded measured file ${short(sameRun.measuredSha256)} (by the probe), but ${measFile} is ${short(meas)} — measured again outside this run? re-run the probe with --run ${runId}` };
  }
  return { expectationSha256: exp, measuredSha256: meas };
}

const RUN_ID = /^[\w.:-]+$/;
const short = (sha: string | null | undefined): string => (sha ? `${sha.slice(0, 12)}…` : "none");

export interface StatusFlags { phase?: string | undefined; run?: string | undefined; "new-run"?: boolean | undefined; detail?: string | undefined; dir?: string | undefined; publish?: string | undefined; by?: string | undefined }
/**
 * `--status <S> --phase <p> …` → exit 0 wrote / 1 refused / 2 usage (or a write to a run that already ended) / 6 the run cache is not writable (printed as
 * one sentence naming the cache and the project root — never a stack). Prints `run <id> rev <n>` on stdout and the
 * live status file + the run's stage dir on stderr. Writes only the live status (outside the watched tree); `done`
 * checks first, then publishes (--publish), then writes the live status and its durable copy <dir>/<S>.status.json.
 * `measured` applies done's checks and records the measured file's sha too (the probe's recovery command, M-1).
 */
export function statusMain(screen: string | undefined, f: StatusFlags, usage: string): number {
  try { return statusRun(screen, f, usage); } catch (e) {
    if (e instanceof RunCacheUnwritable) { console.error(e.message); return EXIT_RUN_CACHE; }
    if (e instanceof RunEnded) { console.error(e.message + "\n" + usage); return 2; } // it ended while this write was checked
    throw e;
  }
}
function statusRun(screen: string | undefined, f: StatusFlags, usage: string): number {
  if (!screen) { console.error("--status needs the screen name: --status <Screen> --phase <phase>\n" + usage); return 2; }
  if (!isPhase(f.phase)) { console.error(`--status needs --phase ${STATUS_PHASES.join("|")}${f.phase !== undefined ? ` (got '${f.phase}')` : ""}\n` + usage); return 2; }
  if (f.run !== undefined && f["new-run"]) { console.error("pass --run <id> or --new-run, not both\n" + usage); return 2; }
  if (f.run !== undefined && !RUN_ID.test(f.run)) { console.error(`--run must be a run id (letters, digits, . : _ -), got '${f.run}'\n` + usage); return 2; }
  if (f.by !== undefined && f.by !== "agent" && f.by !== "orchestrator") { console.error(`--by must be agent or orchestrator (got '${f.by}')\n` + usage); return 2; }
  const by: StatusWriter = f.by === "orchestrator" ? "orchestrator" : "agent";
  const base = runBase(screen, f.dir);
  const phase = f.phase;
  const prev = readStatus(base);
  const prevV2 = prev && prev !== "v1" ? prev : null;
  // no --run: continue the run in progress — only a v2 run that has not ended (M5); anything else is ambiguous
  let runId: string;
  if (f.run !== undefined) runId = f.run;
  else if (f["new-run"]) runId = newRunId();
  else if (prevV2 && !TERMINAL_PHASES.includes(prevV2.phase)) runId = prevV2.runId;
  else {
    console.error(`pass --run <id> or --new-run — ${prevV2 ? `the last run (${prevV2.runId}) ended at ${prevV2.phase}` : prev === "v1" ? "the status on disk is an older hand-written one" : "there is no run in progress"}, so there is nothing to continue\n` + usage);
    return 2;
  }
  const sameRun = prevV2 && prevV2.runId === runId ? prevV2 : null;
  // an ended run stays ended: a later write would replace its phase and detail (a `done` over the verifier's
  // `blocked` lost the block, and --compare saw a clean run) — the next attempt is a new run
  if (sameRun && TERMINAL_PHASES.includes(sameRun.phase)) {
    console.error(`run ${runId} already ended at ${sameRun.phase}${sameRun.detail ? ` (${sameRun.detail})` : ""} — start a new run with --new-run\n` + usage);
    return 2;
  }
  const S = path.basename(base), dir = path.dirname(base);
  // the run cache must take a write BEFORE anything is checked or published (a `done` that publishes, then cannot
  // record itself, would leave design/verify changed and the run unfinished)
  // M-2: a real write, not access(W_OK) — a sandbox can refuse creating a file in a directory access() calls writable
  const cache = runCacheDir(dir);
  inRunCache(dir, () => {
    fs.mkdirSync(cache, { recursive: true });
    const probe = path.join(cache, `.w-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
  });

  const shas: Pick<StatusWrite, "expectationSha256" | "measuredSha256" | "evidenceSha256"> = {};
  if (phase === "done" || phase === "measured") {
    // done (and measured — the recovery the probe prints when its own write was refused, M-1) names the exact files
    // it is about — checked BEFORE anything is published (M3): a measured file taken against another expectation,
    // in another run, or not the one the probe measured in this run is not done (F-72). measured reads the run's
    // stage dir first (a probe --out there), done the --publish dir; else the verify dir.
    const staged = phase === "done" ? (f.publish !== undefined ? path.join(f.publish, S + ".measured.json") : null) : path.join(stageDirOf(base, runId), S + ".measured.json");
    const measFile = staged !== null && fs.existsSync(staged) ? staged : base + ".measured.json";
    const checked = checkMeasured(base, measFile, runId, sameRun, prevV2);
    if ("refused" in checked) { console.error(`refused  ${checked.refused}`); return 1; }
    shas.expectationSha256 = checked.expectationSha256;
    shas.measuredSha256 = checked.measuredSha256;
  }
  let published: string[] | undefined;
  if (f.publish !== undefined) {
    // re-checked right before publishing: a run ended while the measured file was checked publishes nothing
    // (writeStatus below refuses it too, but only after the files would be in the verify dir)
    const now = readStatus(base);
    if (now && now !== "v1" && now.runId === runId && TERMINAL_PHASES.includes(now.phase)) throw new RunEnded(now.runId, now.phase, now.detail);
    const r = publishStaged(f.publish, dir);
    if ("error" in r) { console.error(`refused  ${r.error}`); return 1; }
    published = r.published;
    console.error(`published ${published.length} file(s) from ${f.publish} into ${dir}${published.length ? `: ${published.join(", ")}` : ""}`);
  }
  if (phase === "done") {
    // the evidence file is this run's only when this run published it (LOW: an older run's evidence is not hashed)
    const evName = S + ".evidence.json";
    const ours = (published || []).includes(evName) || !!(sameRun && sameRun.published && sameRun.published.includes(evName));
    const ev = ours ? sha256File(base + ".evidence.json") : null;
    if (ev) shas.evidenceSha256 = ev;
    else if (fs.existsSync(base + ".evidence.json")) console.error(`note  ${base}.evidence.json was not published in run ${runId} — not recorded as this run's evidence`);
  }
  const doc = writeStatus(base, { runId, phase, by, ...(f.detail !== undefined ? { detail: f.detail } : {}), ...shas, ...(published ? { published } : {}) });
  if (phase === "done") publishStatus(base, doc);
  const stage = stageDirOf(base, runId);
  if (!TERMINAL_PHASES.includes(phase)) inRunCache(dir, () => fs.mkdirSync(stage, { recursive: true }));
  console.log(`run ${doc.runId} rev ${doc.rev}`);
  console.error(`status ${shellArg(liveStatusFile(base))}${phase === "done" ? ` (published to ${shellArg(statusFile(base))})` : ""}`);
  if (!TERMINAL_PHASES.includes(phase)) console.error(`stage  ${shellArg(stage)}`);
  return 0;
}

export interface WaitFlags { run?: string | undefined; timeout?: string | undefined; stall?: string | undefined; interval?: string | undefined; dir?: string | undefined }
const seconds = (v: string | undefined, dflt: number): number | null => {
  if (v === undefined) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
/**
 * `--wait <S> --run <id>` → 0 when that run is `done` and the measured file on disk is the one it names (prints the
 * --compare command); 1 when it is failed/blocked (prints the detail); 5 on --timeout, or when the status has not
 * changed for --stall seconds; 6 when the run cache exists but cannot be read; 2 usage. Polls every --interval seconds (2).
 */
export async function waitMain(screen: string | undefined, f: WaitFlags, usage: string): Promise<number> {
  if (!screen || f.run === undefined) { console.error("--wait needs the screen name and the run: --wait <Screen> --run <id>\n" + usage); return 2; }
  const timeout = seconds(f.timeout, 1200), stall = seconds(f.stall, 300), interval = seconds(f.interval, 2);
  if (timeout === null || stall === null || interval === null) { console.error("--timeout / --stall / --interval must be positive numbers of seconds\n" + usage); return 2; }
  const base = runBase(screen, f.dir);
  console.error(`wait  run ${f.run} on ${liveStatusFile(base)} (then ${statusFile(base)})`);
  const t0 = Date.now();
  let lastKey = "", lastChange = Date.now(), noted = "";
  for (;;) {
    const unreadable = cacheUnreadable(base);
    if (unreadable) { console.error(unreadable.message); return EXIT_RUN_CACHE; }
    const at = readStatusAt(base);
    const st = at ? at.status : null;
    const key = st && st !== "v1" ? `${st.runId}#${st.rev}` : String(st);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    if (st && st !== "v1" && st.runId === f.run) {
      if (st.phase === "failed" || st.phase === "blocked") { console.error(`run ${st.runId} ${st.phase} (rev ${st.rev}, ${st.at})${st.detail ? `: ${st.detail}` : ""}`); return 1; }
      if (st.phase === "done") {
        const onDisk = sha256File(base + ".measured.json");
        if (st.measuredSha256 && onDisk === st.measuredSha256) {
          // only this run's evidence: the file the status hashed at done
          const ev = st.evidenceSha256 && sha256File(base + ".evidence.json") === st.evidenceSha256 ? ` --interactions ${shellArg(base + ".evidence.json")}` : "";
          console.error(`run ${st.runId} done (rev ${st.rev}, ${st.at})`);
          console.log(`${scriptCmd("verify-screen")} --compare ${shellArg(base + ".expected.json")} ${shellArg(base + ".measured.json")}${ev} --out ${shellArg(base)}`);
          return 0;
        }
        const why = `run ${st.runId} says done, but ${base}.measured.json ${onDisk ? `is not the file it names (sha ${onDisk.slice(0, 12)}… vs ${(st.measuredSha256 || "none").slice(0, 12)}…)` : "does not exist"} — still waiting`;
        if (why !== noted) { console.error(`note  ${why}`); noted = why; }
      }
    } else if (st && st !== "v1" && noted !== st.runId) {
      console.error(`note  ${at ? at.file : liveStatusFile(base)} is run ${st.runId} (${st.phase}), not ${f.run} — waiting for run ${f.run}`);
      noted = st.runId;
    }
    const now = Date.now();
    if (now - t0 >= timeout * 1000) { console.error(`timed out after ${timeout}s waiting for run ${f.run} (${describe(st)})`); return 5; }
    if (now - lastChange >= stall * 1000) { console.error(`stalled: ${at ? at.file : liveStatusFile(base)} has not changed for ${stall}s (${describe(st)}) — the verifier may be stuck; check it before re-running`); return 5; }
    await sleep(Math.min(interval * 1000, Math.max(1, timeout * 1000 - (now - t0))));
  }
}
/** The run cache exists but this process cannot list or read it (an unreadable file reads as "no status" otherwise,
 *  and --wait would sit out its whole --timeout on a run it can never see). */
function cacheUnreadable(base: string): RunCacheUnwritable | null {
  const c = runCacheOf(path.dirname(base));
  const checks: Array<[string, number]> = [[c.dir, fs.constants.R_OK | fs.constants.X_OK], [liveStatusFile(base), fs.constants.R_OK]];
  for (const [p, mode] of checks) {
    try { fs.accessSync(p, mode); } catch (e) {
      const code = errCode(e);
      if (code === "EACCES" || code === "EPERM") return new RunCacheUnwritable(c.dir, c.root, "read");
    }
  }
  return null;
}
const describe = (st: VerifyStatusV2 | "v1" | null): string =>
  st === null ? "no status file" : st === "v1" ? "an older v1 status file, not written by the tools" : `last: run ${st.runId} rev ${st.rev} ${st.phase} at ${st.at}`;
