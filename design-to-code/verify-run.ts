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
//   verify-screen.js --status <Layer>__<id> --phase <p> [--run <id> | --new-run] [--detail …] [--dir design/verify] [--publish <stageDir>]
//   verify-screen.js --wait <Layer>__<id> --run <id> [--timeout <s>] [--stall <s>] [--dir design/verify]
// (on verify-screen.js, so one script path covers every allow rule — the CLI glue is statusMain/waitMain here).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sha256Hex } from "../bridge/src/hash.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { bindMeasured, measuredText } from "./report-freshness.ts";
import { anyJson, readJson } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import { scriptCmd, shellArg } from "./cli-args.ts";
import { RunCacheUnwritable, UNWRITABLE_CODES, canonical, runCacheDir, runCacheOf } from "./run-cache.ts";
import { errCode, firstLine } from "../bridge/src/errmsg.ts";
import { renameOver, tmpSuffix, writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { LockBusy, acquireFileLock, lockFileOf, processState } from "../bridge/src/file-lock.ts";
import { EXPORT_DIR, PLAN_DIR, VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { screenKey, setKey } from "./screen-key.ts";
import { SET_FILE, isToolOwned, setFile } from "./verify-sets.ts";
import { STATUS_PHASES, STATUS_SCHEMA, TERMINAL_PHASES, isPhase, liveStatusFile, openRunSets, readStatusFile, runCommands } from "./verify-status.ts";
import type { OwnRunStamp, ReplacedRun, StatusPhase, StatusWriter, VerifyStatusV2 } from "./verify-status.ts";

// the status shape, its live file and the open-run listing (verify-status.ts), re-exported for the writers' callers
export { MEASURED_PHASES, STATUS_PHASES, STATUS_SCHEMA, TERMINAL_PHASES, isVerifyStatusV2, liveStatusFile, openRunSets } from "./verify-status.ts";
export type { OwnRunStamp, ReplacedRun, StatusPhase, StatusWriter, VerifyStatusV2 } from "./verify-status.ts";

/** The failed probe attempts (exit 3/4) a run named by --run takes: the last of them ends the run `failed` — the
 *  probe writes it, so a verifier re-runs a failed probe once and never writes that `failed` itself. */
export const PROBE_ATTEMPTS = 2;
/** What a failed probe attempt's status detail adds: which attempt it was in the run, and what follows it — after an
 *  exit 3 (no renderer) the user fixes the renderer first; after an exit 4 the one re-run follows at once. */
export function probeAttemptNote(n: number, exit: number): string {
  const next = n >= PROBE_ATTEMPTS ? "the probe ended the run failed"
    : exit === 3 ? "ask the user to make a renderer available, then re-run the probe once in this run" : "re-run the probe once in this run";
  return `failed probe attempt ${n} of ${PROBE_ATTEMPTS}: ${next}`;
}
/** Whether a probe's own run is past its deadline (an unreadable deadline is not). */
const overdue = (o: OwnRunStamp): boolean => Date.parse(o.deadline) < Date.now();

// ---------------------------------------------------------------- files
/** `<base>.status.json` — the PUBLISHED (durable) status in the verify dir; base is design/verify/<S>. */
export const statusFile = (base: string): string => setFile(base, "status");
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
/** The lock every status write of `<base>` holds: `<live status>.lock`, beside it in the run cache. */
export const lockFileOfStatus = (base: string): string => lockFileOf(liveStatusFile(base));
/** Where a run stages its evidence and state screenshots until `--publish`: `<run cache>/stage/<runId>/`. */
export const stageDirOf = (base: string, runId: string): string => path.join(runCacheDir(path.dirname(base)), "stage", runId);

/** A run id: time + randomness, sortable, safe in a file name and a shell word (--new-run's, and the probe's own run's). */
export function newRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + crypto.randomBytes(3).toString("hex");
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
  /** the write records a failed probe attempt of the run, with its exit code (3 or 4): probeFailures + 1, counted under
   *  the status lock; the PROBE_ATTEMPTS-th is written `failed` whatever `phase` says, and the detail names the attempt
   *  (probeAttemptNote) */
  probeFailed?: 3 | 4;
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
    const { waitIt, endIt } = runCommands(base, open);
    const o = open.ownRun, S = path.basename(base);
    super(o
      ? `run ${open.runId} of ${S} ${ownRunOpen(open, o)} — ` +
        `a probe without --run starts a run of its own only when no other run of the screen is open; if no probe is running, end it: ${endIt}`
      : `run ${open.runId} of ${S} is open (phase ${open.phase}, rev ${open.rev}, by ${open.by}, ${open.at}) — a probe without --run starts a run of its own ` +
        `only when no other run of the screen is open: that run's verifier passes --run ${open.runId}; anyone else waits for it (${waitIt}) ` +
        `or, only if nobody is running it any more, ends it (${endIt})`);
    this.name = "RunOpen";
  }
}
/** How a refusal names another probe's own run that is open: when and by which process it started — nobody waits for
 *  that. `why`: the probe that started it is gone or past the run's deadline (abandonedRun), said after it. */
function ownRunOpen(open: VerifyStatusV2, o: OwnRunStamp, why?: string): string {
  return `is a probe's own run (no --run), started at ${o.startedAt} by pid ${o.pid} on ${o.host} and still open (phase ${open.phase})` +
    (why !== undefined ? `, but the probe that started it ${why}` : "");
}
/** Why a probe's own run counts as abandoned: its probe's pid is gone, else the run is past its deadline. */
function abandonedWhy(o: OwnRunStamp): string {
  return processState(o) === "gone" ? "is gone" : `is past the run's deadline ${o.deadline}`;
}
/** A later write of a run whose earlier write was recorded (`continues`: a probe's run, --run or its own, after its
 *  `measuring`) while the status names ANOTHER run, in any phase: the run was replaced — a later probe ended it as
 *  abandoned (a stopped or sleeping probe past its deadline) and started its own, or a newer run of the screen started
 *  while a --run probe measured; either may have ended since. Nothing more is written in it, so a late probe never writes
 *  over the run that replaced it. Refused by writeStatus itself. */
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
/** Another v2 run over `prev` (readStatus's) that has not ended — open, abandoned or not. */
function otherOpenRun(prev: VerifyStatusV2 | "v1" | null, runId: string): VerifyStatusV2 | null {
  return prev && prev !== "v1" && prev.runId !== runId && !TERMINAL_PHASES.includes(prev.phase) ? prev : null;
}
/** The refusal for a write of run `runId` that must be the screen's only open run, over the status `prev` (readStatus's):
 *  null when no other v2 run is open (none, a v1 file, an ended run, `runId` itself) or the open one is abandoned
 *  (abandonedRun: the write ends it). The one place that sentence is built. */
export function openRun(base: string, prev: VerifyStatusV2 | "v1" | null, runId: string): RunOpen | null {
  const open = otherOpenRun(prev, runId);
  return open && !abandonedRun(open, runId) ? new RunOpen(base, open) : null;
}
/** A `--status` write of run `runId` (named by --run, or the run in progress when it read the status), or a write of the
 *  probe's --run, while the status names ANOTHER run that has not ended: that run's writer goes on in it (a verifier's, an orchestrator's, a probe's own —
 *  one left behind too), and a record of `runId` would replace it in the status and publish over it. Refused by
 *  writeStatus itself (`current`), so a run started after the writer looked is not written over either. Another probe's
 *  own run is named as one (when and by which pid it started, and when abandonedRun says so, that its probe is gone or
 *  past its deadline) — nobody waits for that: if no probe is running, it is ended. */
export class RunNotCurrent extends Error {
  constructor(base: string, runId: string, open: VerifyStatusV2) {
    const { waitIt, endIt } = runCommands(base, open);
    const o = open.ownRun, S = path.basename(base);
    super(o
      ? `run ${runId} is not the current run of ${S}: run ${open.runId} ${ownRunOpen(open, o, abandonedRun(open, runId) ? abandonedWhy(o) : undefined)} — ` +
        `nothing is written; if no probe is running, end it: ${endIt}`
      : `run ${runId} is not the current run of ${S}: run ${open.runId} is open (phase ${open.phase}, rev ${open.rev}, by ${open.by}, ${open.at}) — ` +
        `nothing is written; wait for it (${waitIt}) or, only if nobody is running it any more, end it (${endIt})`);
    this.name = "RunNotCurrent";
  }
}
/** The refusal for a `--status` write, or a write of the probe's --run, of run `runId` over the status `prev`
 *  (readStatus's): null when no other v2 run is open (none, a v1 file, an ended run, `runId` itself). openRun's test
 *  without its abandoned-run exemption — only a probe's own run ends an abandoned one. The one place that sentence is
 *  built. */
export function notCurrentRun(base: string, prev: VerifyStatusV2 | "v1" | null, runId: string): RunNotCurrent | null {
  const open = otherOpenRun(prev, runId);
  return open ? new RunNotCurrent(base, runId, open) : null;
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
  /** the write continues a run whose earlier write was recorded (a probe's run, --run or its own, after its `measuring`): refused
   *  (RunReplaced) when the status now names another run, in any phase — checked before `before` */
  continues?: boolean;
  /** the write is of a run its writer names (verify-screen --status without --new-run, the probe with --run): refused (RunNotCurrent) when the
   *  status names another run that has not ended, an abandoned one included — checked with the ended-run check, before
   *  `before`. An ended run or no status takes it (the record of a measured file after the status's run ended) — over
   *  ANOTHER run that ended, the record names that run as `replaced` (replacedNote says so) */
  current?: boolean;
}
/** How long a status write waits for another one (the probe writes a measured file and its screenshots inside). */
const STATUS_LOCK = { waitMs: 15_000 };
/**
 * Write the LIVE status of `<base>` atomically (never into the project's watched tree). rev = the previous rev + 1
 * when it is the same run, else 1. Within one run the shas, the published list, the failed probe attempts and the run
 * it replaced carry forward (a `driving` write after the probe's `measured` still names the measured file the probe
 * wrote; published is the run's union); a write with probeFailed counts one more attempt, and the PROBE_ATTEMPTS-th
 * ends the run `failed`. A hooks.current write over ANOTHER run that has ended records that run as `replaced`.
 * Serialised by `<live status>.lock` (file-lock.ts): read → ended-run (and open-run) check → hooks.before → write → hooks.after
 * happen with no other status write of this screen in between, so two writers never write the same rev and a run
 * that ends is not reopened, published into or given files by a writer that checked it earlier. With hooks.alone, another
 * probe's own run that its probe left open (abandonedRun) is first ended `failed` under the same lock (hooks.abandoned).
 * Throws RunCacheUnwritable when the run cache refuses the lock or the write (sandbox write scope, read-only mount),
 * RunEnded when the same run has already ended, RunReplaced (hooks.continues) when the status names another run,
 * RunOpen (hooks.alone) or RunNotCurrent (hooks.current) when another run is open, LockBusy when another status write holds the lock past 15 s (or
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
    const other = hooks.current ? notCurrentRun(base, prev, p.runId) : null;
    if (other) throw other;
    // (after the open-run check: an open run that replaced it is refused as open, with how to wait for it)
    const replaced = hooks.continues ? replacedRun(prev, p.runId) : null;
    if (replaced) throw replaced;
    const put = (doc: VerifyStatusV2): void => { lock.assertMine(); inRunCache(dir, () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n")); };
    const left = hooks.alone ? abandonedRun(prev, p.runId) : null;
    if (left?.ownRun) {
      const o = left.ownRun;
      const endDoc: VerifyStatusV2 = { ...left, rev: left.rev + 1, phase: "failed", at: new Date().toISOString(), by: "verify-probe",
        detail: `abandoned — the probe that started it (pid ${o.pid} on ${o.host}, ${o.startedAt}) ${abandonedWhy(o)}; ended by the next probe` };
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
    // the run's failed probe attempts carry forward; one more is counted here, under the lock, so two probes of the
    // run never count the same attempt — and the last one ends the run
    const failures = w.probeFailed !== undefined ? (same?.probeFailures ?? 0) + 1 : same?.probeFailures;
    const phase: StatusPhase = w.probeFailed !== undefined && failures !== undefined && failures >= PROBE_ATTEMPTS ? "failed" : w.phase;
    const detail = w.probeFailed !== undefined && failures !== undefined ? `${w.detail ?? ""} (${probeAttemptNote(failures, w.probeFailed)})` : w.detail ?? "";
    const ownRun = w.ownRun ?? (same && (hooks.alone || TERMINAL_PHASES.includes(phase)) ? same.ownRun : undefined);
    // a run its writer names (`current`) written over ANOTHER run — one that has ended, the checks above refused any
    // other — says so in its record: a late record of an older run never replaces a newer one silently
    const over: ReplacedRun | undefined = hooks.current && prev && prev !== "v1" && prev.runId !== p.runId ? { runId: prev.runId, phase: prev.phase, at: prev.at } : same?.replaced;
    const doc: VerifyStatusV2 = {
      schema: STATUS_SCHEMA, screen: path.basename(base), runId: w.runId, rev: same ? same.rev + 1 : 1, phase, detail, at: new Date().toISOString(), by: w.by,
      ...pick("expectationSha256"), ...pick("measuredSha256"), ...pick("evidenceSha256"),
      ...(published !== undefined ? { published } : {}),
      ...(ownRun !== undefined ? { ownRun } : {}),
      ...(failures !== undefined ? { probeFailures: failures } : {}),
      ...(over !== undefined ? { replaced: over } : {}),
    };
    put(doc);
    hooks.after?.(doc);
    return doc;
  } finally { lock.release(); }
}
/** `done`: the live status, published as the durable record design/verify/<S>.status.json (every page is closed by now) —
 *  without ownRun: the project commits that file, and a pid and host name are nobody's business there (`replaced`, a
 *  run id, phase and time, stays). */
export function publishStatus(base: string, doc: VerifyStatusV2): void {
  const { ownRun: _private, ...durable } = doc;
  writeFileAtomic(statusFile(base), JSON.stringify(durable, null, 2) + "\n");
}
/** The note line a writer prints when the write it made replaced another run that had ended (the run's first write —
 *  rev 1 — is the one that records `replaced`; later writes only carry it), else null. The one place it is built. */
export function replacedNote(doc: VerifyStatusV2): string | null {
  const r = doc.replaced;
  return r && doc.rev === 1 ? `note  run ${doc.runId} replaced run ${r.runId} (ended at ${r.phase}, ${r.at}) as the screen's last run — recorded as \`replaced\` in run ${doc.runId}'s status` : null;
}

// Files the verify tools own (verify-sets.ts isToolOwned): a staged copy must never replace them.
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
  const owned = files.filter(isToolOwned);
  if (owned.length) return { error: `--publish refuses ${owned.join(", ")} — expected/report/status files and migration journals are written by verify-screen itself, never copied in` };
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
  return { files, tmpOf, abort, commit: () => { for (const f of files) renameOver(tmpOf(f), path.join(destDir, f)); } };
}
/** prepareStaged + commit. */
export function publishStaged(stageDir: string, destDir: string): { published: string[] } | { error: string } {
  const p = prepareStaged(stageDir, destDir);
  if ("error" in p) return p;
  p.commit();
  return { published: p.files };
}

// ---------------------------------------------------------------- CLI glue (called from verify-screen.ts main)
/**
 * `<verify dir>/<set>`: the verify set `screen` names (screen-key.ts setKey) — a set name as written (a variant
 * `<Layer>__<id>.<slug>` too, an artefact's file tail dropped), else the screen's base set through the export index's
 * exact stages (a node id, the exact layer name / title / plan header): the set's stem is fixed once it exists, so a frame
 * renamed in Figma mid-run still names the same live status. The verify dir is --dir, else the directory of a `screen`
 * given as a path, else design/verify. A set whose only trace is a run open in the run cache (opened by --status before
 * any of its files exist) keeps its stem as well (openRunSets). Refused: a query that names no set (the candidates
 * listed); at --status a node with only legacy-named sets — a run under the new name would start a second set for it
 * (--migrate first); and at --status --new-run a set name with no files and no status whose node the export index names
 * by another stem (the set --expect would write is that one). A legacy set's own name is refused too (--migrate renames
 * it), except while a run of it is open — --migrate skips such a set, so that run is waited for (--wait --run <its id>,
 * which reads its outcome there once it has ended too), or ended (--status --run <its id> with done/failed/blocked) under
 * the old name. So is a set name whose node another stem holds now, except that its open run is ended under it (--status
 * --run <its id> with done/failed/blocked).
 */
type RunAt = { kind: "wait"; run: string | undefined } | { kind: "status"; phase: StatusPhase; run: string | undefined; newRun: boolean };
function runBase(screen: string, dir: string | undefined, at: RunAt): { base: string; notes: string[] } | { error: string } {
  const asPath = dir === undefined && /[\\/]/.test(screen);
  const verifyDir = dir ?? (asPath ? path.dirname(screen) : VERIFY_DIR);
  const opts = { exportDir: EXPORT_DIR, planDir: PLAN_DIR, verifyDir, openSets: openRunSets(verifyDir) };
  const k = setKey(asPath ? path.basename(screen) : screen, opts);
  if (k.status === "unresolved") {
    const open = k.legacySet !== undefined ? readStatus(path.join(verifyDir, k.legacySet)) : null;
    // (a --wait for the status's own run reads its outcome there once it has ended, too)
    const waited = open !== null && open !== "v1" && at.kind === "wait" && at.run === open.runId;
    if (k.legacySet !== undefined && open !== null && open !== "v1" && (waited || !TERMINAL_PHASES.includes(open.phase))) {
      const S = k.legacySet;
      // no new run opens under a legacy name: only the open run itself is waited for or ended there
      const ends = at.kind === "wait" ? at.run === undefined || at.run === open.runId : !at.newRun && at.run === open.runId && TERMINAL_PHASES.includes(at.phase);
      const once = TERMINAL_PHASES.includes(open.phase) ? "" : ` once run ${open.runId} ends,`;
      if (ends) return { base: path.join(verifyDir, S), notes: [`note  ${S} is a legacy-named verify set —${once} verify-screen --migrate renames it`] };
      const { waitIt, endIt } = runCommands(path.join(verifyDir, S), open);
      return { error: `'${screen}' names no verify set: ${S} is a legacy-named verify set, and its run ${open.runId} is open (phase ${open.phase}) — only that run's end is ` +
        `written under the old name: wait for it (${waitIt}) or end it (${endIt}, or --phase done|blocked), then run verify-screen --migrate --apply` };
    }
    // a set name another stem of its node is refused for, while a run is open under it: only that run's end is written
    // there — the command a refusal that names the run prints (stemHolders); the run id is checked again under the lock
    const name = asPath ? path.basename(screen) : screen;
    const own = at.kind === "status" && !at.newRun && TERMINAL_PHASES.includes(at.phase) && opts.openSets.includes(name) ? readStatus(path.join(verifyDir, name)) : null;
    if (own !== null && own !== "v1" && own.runId === at.run) {
      return { base: path.join(verifyDir, name), notes: [`note  another verify set holds ${name}'s node — only run ${own.runId}'s end is written under ${name}`] };
    }
    return { error: [`'${screen}' names no verify set: ${k.why}`, ...k.candidates.map((c) => `  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}`)].join("\n") };
  }
  // a fresh run under a set name no file or status holds yet: the name must be the one the export index gives the node,
  // or --expect would later write the set under another
  if (at.kind === "status" && at.newRun && k.via === "set name" && !k.existing && readStatus(path.join(verifyDir, k.name)) === null) {
    const c = screenKey(k.nodeId, opts);
    if (c.status === "resolved" && c.stem !== k.stem) {
      const want = k.variant !== null ? `${c.stem}.${k.variant}` : c.stem;
      return { error: `'${screen}' is not node ${k.nodeId}'s verify set: the export index names the node ${JSON.stringify(c.name ?? "")}, so its set is ${want} — pass --status ${shellArg(want)}` };
    }
  }
  const legacy = k.legacy.length ? `legacy-named verify set(s) ${k.legacy.join(", ")} of node ${k.nodeId}` : null;
  if (legacy !== null && !k.existing && at.kind === "status") {
    return { error: `${legacy}, and none named ${k.stem} — a run of ${k.name} would start a second set for the node: run ${scriptCmd("verify-screen")} --migrate --apply` +
      `${dir !== undefined ? ` --dir ${shellArg(dir)}` : ""}, then --status ${shellArg(k.name)}` };
  }
  return { base: path.join(verifyDir, k.name), notes: legacy !== null ? [`note  ${legacy} — verify-screen --migrate renames them to ${k.stem}`] : [] };
}

/** The checks `done` and `measured` apply before recording a measured file as this run's: the current
 *  expectation exists, the file exists and is bound to it and to this run (report-freshness.ts bindMeasured: it names
 *  that expectation, no other run, and is the file the probe recorded in this run when it recorded one). Returns the two
 *  shas to record, or the refusal (one line, exit 1). */
function checkMeasured(base: string, measFile: string, runId: string, sameRun: VerifyStatusV2 | null, prev: VerifyStatusV2 | null): { expectationSha256: string; measuredSha256: string } | { refused: string } {
  const exp = sha256File(setFile(base, "expected"));
  if (!exp) return { refused: `${base}.expected.json does not exist — nothing to be done against` };
  const meas = sha256File(measFile);
  if (!meas) return { refused: `${measFile} does not exist — measure first (the probe on web; on native write it with expectationSha256) (phase stays ${prev ? prev.phase : "unset"})` };
  const r = readJson(measFile, anyJson);
  if (!("doc" in r)) return { refused: `${measFile} ${r.error} — re-run the probe` };
  if (!isJsonObject(r.doc)) return { refused: `${measFile} is not a JSON object — re-run the probe` };
  const why = bindMeasured({ expectationSha256: exp, measured: r.doc, measuredSha256: meas, run: { runId, measuredSha256: sameRun?.measuredSha256 } })[0];
  if (why === undefined) return { expectationSha256: exp, measuredSha256: meas };
  const next = why.kind === "no-expectation" || why.kind === "other-expectation" ? "re-run the probe" : `${why.kind === "other-measured" ? "measured again outside this run? " : ""}re-run the probe with --run ${runId}`;
  return { refused: `${measFile}: ${measuredText(why)} — ${next}` };
}

const RUN_ID = /^[\w.:-]+$/;

export interface StatusFlags { phase?: string | undefined; run?: string | undefined; "new-run"?: boolean | undefined; detail?: string | undefined; dir?: string | undefined; publish?: string | undefined;
  by?: string | undefined }
/**
 * `--status <S> --phase <p> …` → exit 0 wrote / 1 refused (a check, or another status write held the lock) / 2 usage (or a write to a run that already ended,
 * or, without --new-run, while another run is open) / 6 the run cache is not writable (printed as
 * one sentence naming the cache and the project root — never a stack). Prints `run <id> rev <n>` on stdout and the
 * live status file + the run's stage dir on stderr. Writes only the live status (outside the watched tree); `done`
 * checks first, then writes the live status, then publishes (--publish) and writes its durable copy <dir>/<S>.status.json.
 * `measured` applies done's checks and records the measured file's sha too (the probe's recovery command).
 */
export function statusMain(screen: string | undefined, f: StatusFlags, usage: string): number {
  try { return statusRun(screen, f, usage); } catch (e) {
    if (e instanceof RunCacheUnwritable) { console.error(e.message); return EXIT_RUN_CACHE; }
    if (e instanceof RunEnded || e instanceof RunNotCurrent) { console.error(e.message); return 2; } // it ended, or another run opened, while this write was checked
    if (e instanceof LockBusy) { console.error(`refused  ${e.message}`); return 1; } // another status write held the lock throughout
    throw e;
  }
}
function statusRun(screen: string | undefined, f: StatusFlags, usage: string): number {
  if (!screen) { console.error("--status needs the verify set: --status <Layer>__<id> --phase <phase>\n" + usage); return 2; }
  if (!isPhase(f.phase)) { console.error(`--status needs --phase ${STATUS_PHASES.join("|")}${f.phase !== undefined ? ` (got '${f.phase}')` : ""}\n` + usage); return 2; }
  if (f.run !== undefined && f["new-run"]) { console.error("pass --run <id> or --new-run, not both\n" + usage); return 2; }
  if (f.run !== undefined && !RUN_ID.test(f.run)) { console.error(`--run must be a run id (letters, digits, . : _ -), got '${f.run}'\n` + usage); return 2; }
  if (f.by !== undefined && f.by !== "agent" && f.by !== "orchestrator") { console.error(`--by must be agent or orchestrator (got '${f.by}')\n` + usage); return 2; }
  const by: StatusWriter = f.by === "orchestrator" ? "orchestrator" : "agent";
  const key = runBase(screen, f.dir, { kind: "status", phase: f.phase, run: f.run, newRun: !!f["new-run"] });
  if ("error" in key) { console.error(key.error); return 2; }
  for (const n of key.notes) console.error(n);
  const base = key.base;
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
  // a run of its writer's (not --new-run) is written only while no other run is open: a recovery or end-it command run
  // late, after another run started, would replace that run in the status (and a `done` publish over it). Checked again
  // under the lock — that also catches a run started between the read above and the write (the inferred id is stale then;
  // a run that starts AND ends inside that gap is not caught: an ended run takes the record by design)
  const current = !f["new-run"];
  const other = current ? notCurrentRun(base, prev, runId) : null;
  if (other) { console.error(other.message); return 2; }
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
    const staged = phase === "done" ? (f.publish !== undefined ? setFile(path.join(f.publish, S), "measured") : null) : setFile(path.join(stageDirOf(base, runId), S), "measured");
    const measFile = staged !== null && fs.existsSync(staged) ? staged : setFile(base, "measured");
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
    const evName = setFile(S, "evidence");
    const ev = prep?.files.includes(evName) ? sha256File(prep.tmpOf(evName))
      : sameRun?.published?.includes(evName) ? sha256File(setFile(base, "evidence")) : null;
    if (ev) shas.evidenceSha256 = ev;
    else if (fs.existsSync(setFile(base, "evidence"))) console.error(`note  ${setFile(base, "evidence")} was not published in run ${runId} — not recorded as this run's evidence`);
  }
  let doc: VerifyStatusV2;
  try {
    // the publish commit and the durable copy happen inside the status write's lock, after the record: a run that
    // another writer ends meanwhile is ended before this write (refused, nothing published) or after the commit
    doc = writeStatus(base, { runId, phase, by, ...(f.detail !== undefined ? { detail: f.detail } : {}), ...shas, ...(prep ? { published: prep.files } : {}) }, {
      current,
      after: (d) => { prep?.commit(); if (phase === "done") publishStatus(base, d); },
    });
  } catch (e) { prep?.abort(); throw e; } // refused (the run ended, or another opened, meanwhile; the cache is unwritable; the lock is busy): nothing is published
  const note = replacedNote(doc);
  if (note !== null) console.error(note);
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
  if (!screen || f.run === undefined) { console.error("--wait needs the verify set and the run: --wait <Layer>__<id> --run <id>\n" + usage); return 2; }
  const timeout = seconds(f.timeout, 1200), stall = seconds(f.stall, 300), interval = seconds(f.interval, 2);
  if (timeout === null || stall === null || interval === null) { console.error("--timeout / --stall / --interval must be positive numbers of seconds\n" + usage); return 2; }
  const key = runBase(screen, f.dir, { kind: "wait", run: f.run });
  if ("error" in key) { console.error(key.error); return 2; }
  for (const n of key.notes) console.error(n);
  const base = key.base;
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
        const onDisk = sha256File(setFile(base, "measured"));
        const evOnDisk = st.evidenceSha256 ? sha256File(setFile(base, "evidence")) : null;
        if (st.measuredSha256 && onDisk === st.measuredSha256 && evOnDisk === (st.evidenceSha256 ?? null)) {
          // only this run's evidence: the file the status hashed at done
          const ev = st.evidenceSha256 ? ` --interactions ${shellArg(setFile(base, "evidence"))}` : "";
          console.error(`run ${st.runId} done (rev ${st.rev}, ${st.at})`);
          // (--out the verify directory: --compare names the report by the expectation's set)
          console.log(`${scriptCmd("verify-screen")} --compare ${shellArg(setFile(base, "expected"))} ${shellArg(setFile(base, "measured"))}${ev} --out ${shellArg(path.dirname(base))}`);
          return 0;
        }
        const [file, sha, named] = st.measuredSha256 && onDisk === st.measuredSha256 ? [SET_FILE.evidence, evOnDisk, st.evidenceSha256] : [SET_FILE.measured, onDisk, st.measuredSha256];
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
