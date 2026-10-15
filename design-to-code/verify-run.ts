// verify-run.ts — one verification run, as files on disk the tools (not the agent) write: status v2, atomic
// writes, publishing a staged run into design/verify/, and waiting for a run to finish.
//
// Why it exists: the verifier's status file was hand-written prose
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
//   - writeFileAtomic (bridge/src/atomic-write.ts): a tmp file BESIDE the target, then rename (same directory → same
//     filesystem → atomic);
//   - one status writer at a time: writeStatus holds `<live status>.lock` (bridge/src/file-lock.ts) from its read to
//     its last step, so the ended-run check, the files the record stands for (the probe's measured file) and what
//     follows it (a --publish commit) all see the status they act on;
//   - publish: the agent stages its artefacts in the run cache (`stage/<runId>/`), and `--status … --publish
//     <dir>` copies them in only after every page is closed — copy to a tmp name in the target dir, then
//     rename, so a stage dir on another filesystem (EXDEV) works too;
//   - wait: poll the status until THIS run is done and the measured file is the one the status names.
//
//   verify-screen.js --status <S> --phase <p> [--run <id> | --new-run] [--detail …] [--dir design/verify] [--publish <stageDir>]
//   verify-screen.js --wait <S> --run <id> [--timeout <s>] [--stall <s>] [--dir design/verify]
// (on verify-screen.js, so one script path covers every allow rule — the CLI glue is statusMain/waitMain here).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sha256Hex } from "../bridge/src/hash.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { anyJson, readJson } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import { scriptCmd, shellArg } from "./cli-args.ts";
import { RunCacheUnwritable, UNWRITABLE_CODES, canonical, runCacheDir, runCacheOf } from "./run-cache.ts";
import { errCode, firstLine } from "../bridge/src/errmsg.ts";
import { tmpSuffix, writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { LockBusy, acquireFileLock, lockFileOf, processState } from "../bridge/src/file-lock.ts";
import type { ProcessStamp } from "../bridge/src/file-lock.ts";
import { VERIFY_DIR } from "../bridge/src/project-layout.ts";

export const STATUS_SCHEMA = "designtwin/verify-status@2";
/** Every phase a status v2 can be in, in the order a run normally passes through them. */
export const STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"] as const;
export type StatusPhase = (typeof STATUS_PHASES)[number];
/** Phases after which nothing more happens in this run. */
export const TERMINAL_PHASES: readonly StatusPhase[] = ["done", "failed", "blocked"];
/** Phases at which the measured file is complete — a --compare may read it. */
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
  /** a probe's own run (started without --run): the process that started it and when — so a run its probe left open
   *  (killed outright) can be told from a live one (file-lock.ts processState) */
  ownRun?: OwnRunStamp;
}
/** Who started a probe's own run: the probe process (file-lock.ts thisProcess), the time it started the run, and the
 *  deadline past which no live probe still writes in it (its start + --max-time + a grace for closing the browser,
 *  writing the files and the status lock) — the backstop for a pid that a later process reuses. */
export interface OwnRunStamp extends ProcessStamp { startedAt: string; deadline: string }

const isPhase = (x: unknown): x is StatusPhase => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
const optStr = (x: unknown): boolean => x === undefined || typeof x === "string";
const isOwnRunStamp = (x: unknown): x is OwnRunStamp => isJsonObject(x) && typeof x.pid === "number" && typeof x.host === "string" && optStr(x.ns) && typeof x.startedAt === "string"
  && typeof x.deadline === "string";
/** Whether a probe's own run is past its deadline (an unreadable deadline is not). */
const overdue = (o: OwnRunStamp): boolean => Date.parse(o.deadline) < Date.now();
export function isVerifyStatusV2(x: unknown): x is VerifyStatusV2 {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number"
    && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator")
    && optStr(x.expectationSha256) && optStr(x.measuredSha256) && optStr(x.evidenceSha256)
    && (x.published === undefined || (Array.isArray(x.published) && x.published.every((p) => typeof p === "string")))
    && (x.ownRun === undefined || isOwnRunStamp(x.ownRun));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";

// ---------------------------------------------------------------- files
/** `<base>.status.json` — the PUBLISHED (durable) status in the verify dir; base is design/verify/<S>. */
export const statusFile = (base: string): string => base + ".status.json";
/** sha256 of a file's bytes, or null when it cannot be read. */
function sha256File(file: string): string | null {
  try { return sha256Hex(fs.readFileSync(file)); } catch { return null; }
}

// ---- where a run's live files go — never under the tree a dev server watches (run-cache.ts)
export { RunCacheUnwritable, runCacheDir };
/** Run `fn` (a write into the run cache of `verifyDir`); a permission / read-only / missing-dir refusal becomes RunCacheUnwritable. */
function inRunCache<T>(verifyDir: string, fn: () => T): T {
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
/** The lock every status write of `<base>` holds: `<live status>.lock`, beside it in the run cache. */
export const lockFileOfStatus = (base: string): string => lockFileOf(liveStatusFile(base));
/** Where a run stages its evidence and state screenshots until `--publish`: `<run cache>/stage/<runId>/`. */
export const stageDirOf = (base: string, runId: string): string => path.join(runCacheDir(path.dirname(base)), "stage", runId);

/** A run id: time + randomness, sortable, safe in a file name and a shell word (--new-run's, and the probe's own run's). */
export function newRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomBytes(3).toString("hex");
}

function readStatusFile(file: string): VerifyStatusV2 | "v1" | null {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  // a malformed ownRun is ignored (read as a run nobody's probe owns), never the whole status
  if (isJsonObject(r.doc) && r.doc.ownRun !== undefined) {
    const { ownRun: _malformed, ...rest } = r.doc;
    if (isVerifyStatusV2(rest)) return rest;
  }
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
  /** a probe's own run: who started it (carried forward by that probe's own writes, and by a write that ends the run) */
  ownRun?: OwnRunStamp;
}
/** A status write for a run that has already ended (done/failed/blocked): refused by writeStatus itself, so a writer
 *  that checked at its start (the probe, up to its time budget earlier) cannot reopen the run with a late write. */
export class RunEnded extends Error {
  constructor(runId: string, phase: StatusPhase, detail: string) {
    super(`run ${runId} already ended at ${phase}${detail ? ` (${detail})` : ""} — start a new run with --new-run`);
    this.name = "RunEnded";
  }
}
/** The refusal for a write of run `runId` over the status `prev` (readStatus's), or null when that run has not ended
 *  (another run, a v1 file, no status). The one place the "already ended" sentence is built. */
export function endedRun(prev: VerifyStatusV2 | "v1" | null, runId: string): RunEnded | null {
  return prev && prev !== "v1" && prev.runId === runId && TERMINAL_PHASES.includes(prev.phase) ? new RunEnded(prev.runId, prev.phase, prev.detail) : null;
}
/** A write of a run the probe started itself (no --run) while ANOTHER run of the screen is open: a verifier's live run
 *  writes the same files, so the probe measures nothing beside it. Refused by writeStatus itself (`alone`), so a run
 *  that opens after the probe looked is not written over either. Another probe's own run that is still open is named
 *  as one (its pid could not be found gone: another host, or the pid runs) — nobody waits for that. */
export class RunOpen extends Error {
  constructor(base: string, open: VerifyStatusV2) {
    const vs = scriptCmd("verify-screen"), S = shellArg(open.screen), id = shellArg(open.runId), dir = shellArg(path.resolve(path.dirname(base)));
    const endIt = `${vs} --status ${S} --phase failed --run ${id} --dir ${dir}`;
    const o = open.ownRun;
    super(o
      ? `run ${open.runId} of ${open.screen} is a probe's own run (no --run), started at ${o.startedAt} by pid ${o.pid} on ${o.host} and still open (phase ${open.phase}) — ` +
        `a probe without --run starts a run of its own only when no other run of the screen is open; if no probe is running, end it: ${endIt}`
      : `run ${open.runId} of ${open.screen} is open (phase ${open.phase}, rev ${open.rev}, by ${open.by}, ${open.at}) — a probe without --run starts a run of its own ` +
        `only when no other run of the screen is open: that run's verifier passes --run ${open.runId}; anyone else waits for it (${vs} --wait ${S} --run ${id} --dir ${dir}) ` +
        `or, only if nobody is running it any more, ends it (${endIt})`);
    this.name = "RunOpen";
  }
}
/** A later write of a run whose earlier write was recorded (`continues`: the probe's own run after its `measuring`) while
 *  the status names ANOTHER run, in any phase: the run was replaced — a later probe ended it as abandoned (a stopped or
 *  sleeping probe past its deadline) and started its own, which may have ended since. Nothing more is written in it, so
 *  a late probe never writes over the run that replaced it. Refused by writeStatus itself. */
export class RunReplaced extends Error {
  constructor(runId: string, by: VerifyStatusV2) {
    super(`run ${runId} was replaced by run ${by.runId} (${by.phase}) while this probe ran — nothing more is written in it`);
    this.name = "RunReplaced";
  }
}
/** The refusal for a continuing write of run `runId` over the status `prev` (readStatus's), or null while the status still
 *  names that run (or there is none, or only a v1 file). The one place that sentence is built. */
export function replacedRun(prev: VerifyStatusV2 | "v1" | null, runId: string): RunReplaced | null {
  return prev && prev !== "v1" && prev.runId !== runId ? new RunReplaced(runId, prev) : null;
}
/** Another open run over `prev` (readStatus's) that a probe without --run left behind: its own run, whose probe is
 *  provably gone (same machine, the pid no longer exists — file-lock.ts processState) or that is past its deadline
 *  (a reused pid). The next own run ends it. */
export function abandonedRun(prev: VerifyStatusV2 | "v1" | null, runId: string): VerifyStatusV2 | null {
  return prev && prev !== "v1" && prev.runId !== runId && !TERMINAL_PHASES.includes(prev.phase) && prev.ownRun && (processState(prev.ownRun) === "gone" || overdue(prev.ownRun)) ? prev : null;
}
/** The refusal for a write of run `runId` that must be the screen's only open run, over the status `prev` (readStatus's):
 *  null when no other v2 run is open (none, a v1 file, an ended run, `runId` itself) or the open one is abandoned
 *  (abandonedRun: the write ends it). The one place that sentence is built. */
export function openRun(base: string, prev: VerifyStatusV2 | "v1" | null, runId: string): RunOpen | null {
  return prev && prev !== "v1" && prev.runId !== runId && !TERMINAL_PHASES.includes(prev.phase) && !abandonedRun(prev, runId) ? new RunOpen(base, prev) : null;
}
/** What a status write does around the record itself, inside its lock (see writeStatus). */
export interface StatusWriteHooks {
  /** after the ended-run check, before the record: files the record stands for (the probe's measured file and
   *  screenshots). A run that ended gets none of them; a throw writes no record. May return fields of the write
   *  only known once those files exist (the measured file's sha). */
  before?: () => Pick<StatusWrite, "measuredSha256">;
  /** after the record: what must not land in a run that ended meanwhile (a --publish commit, the durable copy) */
  after?: (doc: VerifyStatusV2) => void;
  /** the write is of a run that must be the screen's only open one (the probe's own run): refused (RunOpen) while
   *  another run is open — checked with the ended-run check, before `before`. An abandoned one (abandonedRun) is ended
   *  `failed` first, under the same lock, and handed to `abandoned`. Only such writes carry the run's ownRun forward (and
   *  one that ends the run) */
  alone?: boolean;
  abandoned?: (ended: VerifyStatusV2) => void;
  /** the write continues a run whose earlier write was recorded (the probe's own run after its `measuring`): refused
   *  (RunReplaced) when the status now names another run, in any phase — checked before `before` */
  continues?: boolean;
}
/** How long a status write waits for another one (the probe writes a measured file and its screenshots inside). */
const STATUS_LOCK = { waitMs: 15_000 };
/**
 * Write the LIVE status of `<base>` atomically (never into the project's watched tree). rev = the previous rev + 1
 * when it is the same run, else 1. Within one run the shas and the published list carry forward (a `driving`
 * write after the probe's `measured` still names the measured file the probe wrote; published is the run's union).
 * Serialised by `<live status>.lock` (file-lock.ts): read → ended-run (and open-run) check → hooks.before → write → hooks.after
 * happen with no other status write of this screen in between, so two writers never write the same rev and a run
 * that ends is not reopened, published into or given files by a writer that checked it earlier. With hooks.alone, another
 * probe's own run that its probe left open (abandonedRun) is first ended `failed` under the same lock (hooks.abandoned).
 * Throws RunCacheUnwritable when the run cache refuses the lock or the write (sandbox write scope, read-only mount),
 * RunEnded when the same run has already ended, RunReplaced (hooks.continues) when the status names another run,
 * RunOpen (hooks.alone) when another run is open, LockBusy when another status write holds the lock past 15 s (or
 * LockLost, a LockBusy, when the lock was taken from this write before the hook's files or the record — neither is
 * written then); a hook's own error is thrown as it is.
 */
export function writeStatus(base: string, p: StatusWrite, hooks: StatusWriteHooks = {}): VerifyStatusV2 {
  const live = liveStatusFile(base), dir = path.dirname(base);
  const lock = inRunCache(dir, () => acquireFileLock(lockFileOfStatus(base), STATUS_LOCK));
  try {
    const prev = readStatus(base);
    const ended = endedRun(prev, p.runId);
    if (ended) throw ended;
    const open = hooks.alone ? openRun(base, prev, p.runId) : null;
    if (open) throw open;
    // (after the open-run check: an open run that replaced it is refused as open, with how to wait for it)
    const replaced = hooks.continues ? replacedRun(prev, p.runId) : null;
    if (replaced) throw replaced;
    const put = (doc: VerifyStatusV2): void => { lock.assertMine(); inRunCache(dir, () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n")); };
    const left = hooks.alone ? abandonedRun(prev, p.runId) : null;
    if (left?.ownRun) {
      const o = left.ownRun;
      const why = processState(o) === "gone" ? "is gone" : `is past the run's deadline ${o.deadline}`;
      const endDoc: VerifyStatusV2 = { ...left, rev: left.rev + 1, phase: "failed", at: new Date().toISOString(), by: "verify-probe",
        detail: `abandoned — the probe that started it (pid ${o.pid} on ${o.host}, ${o.startedAt}) ${why}; ended by the next probe` };
      put(endDoc);
      hooks.abandoned?.(endDoc);
    }
    const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
    lock.assertMine();
    const w: StatusWrite = hooks.before ? { ...p, ...hooks.before() } : p;
    const pick = (k: "expectationSha256" | "measuredSha256" | "evidenceSha256"): { [K in typeof k]?: string } => {
      const v = w[k] ?? (same ? same[k] : undefined);
      return v !== undefined ? { [k]: v } : {};
    };
    const published = w.published !== undefined || (same && same.published) ? [...new Set([...(same && same.published) || [], ...(w.published || [])])].sort() : undefined;
    // a probe's own run stays one only through that probe's own writes (`alone`), or a write that ends it: a writer that
    // continues the run (an orchestrator's --status without --run, a verifier's probe --run) adopts it — no later probe
    // may take it for abandoned while they work in it
    const ownRun = w.ownRun ?? (same && (hooks.alone || TERMINAL_PHASES.includes(w.phase)) ? same.ownRun : undefined);
    const doc: VerifyStatusV2 = {
      schema: STATUS_SCHEMA, screen: path.basename(base), runId: w.runId, rev: same ? same.rev + 1 : 1, phase: w.phase, detail: w.detail ?? "", at: new Date().toISOString(), by: w.by,
      ...pick("expectationSha256"), ...pick("measuredSha256"), ...pick("evidenceSha256"),
      ...(published !== undefined ? { published } : {}),
      ...(ownRun !== undefined ? { ownRun } : {}),
    };
    put(doc);
    hooks.after?.(doc);
    return doc;
  } finally { lock.release(); }
}
/** `done`: the live status, published as the durable record design/verify/<S>.status.json (every page is closed by now) —
 *  without ownRun: the project commits that file, and a pid and host name are nobody's business there. */
export function publishStatus(base: string, doc: VerifyStatusV2): void {
  const { ownRun: _private, ...durable } = doc;
  writeFileAtomic(statusFile(base), JSON.stringify(durable, null, 2) + "\n");
}

// Files the verify tools own: a staged copy must never replace them (--expect / --compare / --status write these;
// --expect keeps a replaced expectation as <S>.expected.prev.json — `*.prev.json` is tool-written too).
const TOOL_OWNED = /\.(expected\.json|report\.json|report\.md|status\.json|prev\.json)$/;
/**
 * --publish in two steps. `prepareStaged` copies every regular file of `stageDir` (top level only) to `<dest>.tmp-<pid>-<random>`
 * IN `destDir` — so the copy may cross filesystems (EXDEV) and the later rename is still atomic; a copy that fails
 * removes the ones made and refuses. `commit` renames them over `<dest>`, `abort` removes them. statusRun writes the
 * status between the two, so a run that ended meanwhile publishes nothing. Refuses (nothing copied) a stage dir that
 * is the destination itself or holds a file the verify tools own. `files`: the names, sorted.
 */
export interface PreparedPublish { files: string[]; tmpOf(name: string): string; commit(): void; abort(): void }
export function prepareStaged(stageDir: string, destDir: string): PreparedPublish | { error: string } {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(stageDir, { withFileTypes: true }); } catch (e) { return { error: `--publish ${stageDir}: ${firstLine(e)}` }; }
  // realpaths: a symlinked or ../ spelling of the verify dir is still the verify dir
  if (canonical(stageDir) === canonical(destDir)) return { error: `--publish ${stageDir} is the verify directory itself — stage outside the project` };
  const files = entries.filter((d) => d.isFile()).map((d) => d.name).sort();
  const owned = files.filter((f) => TOOL_OWNED.test(f));
  if (owned.length) return { error: `--publish refuses ${owned.join(", ")} — expected/report/status files are written by verify-screen itself, never copied in` };
  fs.mkdirSync(destDir, { recursive: true });
  const suffix = tmpSuffix(); // one per publish: every copy shares it, so tmpOf(name) is stable between prepare and commit
  const tmpOf = (name: string): string => path.join(destDir, name) + suffix;
  const abort = (): void => { for (const f of files) try { fs.rmSync(tmpOf(f), { force: true }); } catch { /* best effort */ } };
  for (const f of files) {
    try { fs.copyFileSync(path.join(stageDir, f), tmpOf(f)); } catch (e) {
      abort();
      return { error: `--publish: copying ${f} failed (${firstLine(e)}) — nothing was published` };
    }
  }
  return { files, tmpOf, abort, commit: () => { for (const f of files) fs.renameSync(tmpOf(f), path.join(destDir, f)); } };
}
/** prepareStaged + commit. */
export function publishStaged(stageDir: string, destDir: string): { published: string[] } | { error: string } {
  const p = prepareStaged(stageDir, destDir);
  if ("error" in p) return p;
  p.commit();
  return { published: p.files };
}

// ---------------------------------------------------------------- CLI glue (called from verify-screen.ts main)
/** `<dir>/<S>`: S is a screen name (`--dir` defaults to design/verify); a path with a separator is taken as-is. */
function runBase(screen: string, dir: string | undefined): string {
  const s = screen.replace(/\.(status|measured|expected|evidence)\.json$/, "");
  return /[\\/]/.test(s) && dir === undefined ? s : path.join(dir ?? VERIFY_DIR, s);
}

/** The measured file's expectationSha256 (and runId, when it names one), or why it has none. */
function measuredExpectation(file: string): { sha: string; runId?: string } | { error: string } {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { error: `${file} ${r.error}` };
  if (!isJsonObject(r.doc)) return { error: `${file} is not a JSON object` };
  const v = r.doc.expectationSha256, run = r.doc.runId;
  return typeof v === "string" && v ? { sha: v, ...(typeof run === "string" && run ? { runId: run } : {}) } : { error: `${file} names no expectation (expectationSha256)` };
}

/** The checks `done` and `measured` apply before recording a measured file as this run's: the current
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

export interface StatusFlags { phase?: string | undefined; run?: string | undefined; "new-run"?: boolean | undefined; detail?: string | undefined; dir?: string | undefined; publish?: string | undefined;
  by?: string | undefined }
/**
 * `--status <S> --phase <p> …` → exit 0 wrote / 1 refused (a check, or another status write held the lock) / 2 usage (or a write to a run that already ended) / 6 the run cache is not writable (printed as
 * one sentence naming the cache and the project root — never a stack). Prints `run <id> rev <n>` on stdout and the
 * live status file + the run's stage dir on stderr. Writes only the live status (outside the watched tree); `done`
 * checks first, then writes the live status, then publishes (--publish) and writes its durable copy <dir>/<S>.status.json.
 * `measured` applies done's checks and records the measured file's sha too (the probe's recovery command).
 */
export function statusMain(screen: string | undefined, f: StatusFlags, usage: string): number {
  try { return statusRun(screen, f, usage); } catch (e) {
    if (e instanceof RunCacheUnwritable) { console.error(e.message); return EXIT_RUN_CACHE; }
    if (e instanceof RunEnded) { console.error(e.message); return 2; } // it ended while this write was checked
    if (e instanceof LockBusy) { console.error(`refused  ${e.message}`); return 1; } // another status write held the lock throughout
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
  // no --run: continue the run in progress — only a v2 run that has not ended; anything else is ambiguous
  let runId: string;
  if (f.run !== undefined) runId = f.run;
  else if (f["new-run"]) runId = newRunId();
  else if (prevV2 && !TERMINAL_PHASES.includes(prevV2.phase)) runId = prevV2.runId;
  else {
    console.error(`pass --run <id> or --new-run — ` +
      `${prevV2 ? `the last run (${prevV2.runId}) ended at ${prevV2.phase}` : prev === "v1" ? "the status on disk is an older hand-written one" : "there is no run in progress"}, ` +
      `so there is nothing to continue\n` + usage);
    return 2;
  }
  const sameRun = prevV2 && prevV2.runId === runId ? prevV2 : null;
  // an ended run stays ended: a later write would replace its phase and detail (a `done` over the verifier's
  // `blocked` lost the block, and --compare saw a clean run) — the next attempt is a new run. Said here, before the
  // measured-file checks and the staging copy, so an ended run is not refused for something else; writeStatus
  // checks again under its lock (a run that ends after this read)
  const ended = endedRun(prev, runId);
  if (ended) { console.error(ended.message); return 2; }
  const S = path.basename(base), dir = path.dirname(base);
  // the run cache must take a write BEFORE anything is checked or published (a `done` that publishes, then cannot
  // record itself, would leave design/verify changed and the run unfinished)
  // A real write, not access(W_OK) — a sandbox can refuse creating a file in a directory access() calls writable
  const cache = runCacheDir(dir);
  inRunCache(dir, () => {
    fs.mkdirSync(cache, { recursive: true });
    const probe = path.join(cache, `.w-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe, { force: true });
  });

  const shas: Pick<StatusWrite, "expectationSha256" | "measuredSha256" | "evidenceSha256"> = {};
  if (phase === "done" || phase === "measured") {
    // done (and measured — the recovery the probe prints when its own write was refused) names the exact files
    // it is about — checked BEFORE anything is published: a measured file taken against another expectation,
    // in another run, or not the one the probe measured in this run is not done. measured reads the run's
    // stage dir first (a probe --out there), done the --publish dir; else the verify dir.
    const staged = phase === "done" ? (f.publish !== undefined ? path.join(f.publish, S + ".measured.json") : null) : path.join(stageDirOf(base, runId), S + ".measured.json");
    const measFile = staged !== null && fs.existsSync(staged) ? staged : base + ".measured.json";
    const checked = checkMeasured(base, measFile, runId, sameRun, prevV2);
    if ("refused" in checked) { console.error(`refused  ${checked.refused}`); return 1; }
    shas.expectationSha256 = checked.expectationSha256;
    shas.measuredSha256 = checked.measuredSha256;
  }
  let prep: PreparedPublish | undefined;
  if (f.publish !== undefined) {
    const r = prepareStaged(f.publish, dir);
    if ("error" in r) { console.error(`refused  ${r.error}`); return 1; }
    prep = r;
  }
  if (phase === "done") {
    // the evidence file is this run's only when this run publishes it (an older run's evidence is not hashed)
    const evName = S + ".evidence.json";
    const ev = prep?.files.includes(evName) ? sha256File(prep.tmpOf(evName))
      : sameRun?.published?.includes(evName) ? sha256File(base + ".evidence.json") : null;
    if (ev) shas.evidenceSha256 = ev;
    else if (fs.existsSync(base + ".evidence.json")) console.error(`note  ${base}.evidence.json was not published in run ${runId} — not recorded as this run's evidence`);
  }
  let doc: VerifyStatusV2;
  try {
    // the publish commit and the durable copy happen inside the status write's lock, after the record: a run that
    // another writer ends meanwhile is ended before this write (refused, nothing published) or after the commit
    doc = writeStatus(base, { runId, phase, by, ...(f.detail !== undefined ? { detail: f.detail } : {}), ...shas, ...(prep ? { published: prep.files } : {}) }, {
      after: (d) => { prep?.commit(); if (phase === "done") publishStatus(base, d); },
    });
  } catch (e) { prep?.abort(); throw e; } // refused (the run ended meanwhile, the cache is unwritable, the lock is busy): nothing is published
  if (prep) console.error(`published ${prep.files.length} file(s) from ${f.publish} into ${dir}${prep.files.length ? `: ${prep.files.join(", ")}` : ""}`);
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
 * `--wait <S> --run <id>` → 0 when that run is `done` and the measured (and evidence) file on disk is the one it names (prints the
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
        // done is written before --publish moves its files in: a file it names that is not on disk yet is still waited for
        const onDisk = sha256File(base + ".measured.json");
        const evOnDisk = st.evidenceSha256 ? sha256File(base + ".evidence.json") : null;
        if (st.measuredSha256 && onDisk === st.measuredSha256 && evOnDisk === (st.evidenceSha256 ?? null)) {
          // only this run's evidence: the file the status hashed at done
          const ev = st.evidenceSha256 ? ` --interactions ${shellArg(base + ".evidence.json")}` : "";
          console.error(`run ${st.runId} done (rev ${st.rev}, ${st.at})`);
          console.log(`${scriptCmd("verify-screen")} --compare ${shellArg(base + ".expected.json")} ${shellArg(base + ".measured.json")}${ev} --out ${shellArg(base)}`);
          return 0;
        }
        const [file, sha, named] = st.measuredSha256 && onDisk === st.measuredSha256 ? [".evidence.json", evOnDisk, st.evidenceSha256] : [".measured.json", onDisk, st.measuredSha256];
        const why = `run ${st.runId} says done, but ${base}${file} ${sha ? `is not the file it names (sha ${sha.slice(0, 12)}… vs ${(named || "none").slice(0, 12)}…)` : "does not exist"} — still waiting`;
        if (why !== noted) { console.error(`note  ${why}`); noted = why; }
      }
    } else if (st && st !== "v1" && noted !== st.runId) {
      console.error(`note  ${at ? at.file : liveStatusFile(base)} is run ${st.runId} (${st.phase}), not ${f.run} — waiting for run ${f.run}`);
      noted = st.runId;
    }
    const now = Date.now();
    if (now - t0 >= timeout * 1000) { console.error(`timed out after ${timeout}s waiting for run ${f.run} (${describe(st)})`); return 5; }
    if (now - lastChange >= stall * 1000) { console.error(`stalled: ${at ? at.file : liveStatusFile(base)} has not changed for ${stall}s (${describe(st)}) — the verifier may be stuck; check it before re-running`);
      return 5; }
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
