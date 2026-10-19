// verify-status.ts — a verification run's status v2 as a reader sees it: its shape (isVerifyStatusV2), where its live
// file is in the run cache (liveStatusFile), which sets have a run open there (openRunSets), and the commands that wait for
// or end an open run (runCommands). verify-run.ts writes
// statuses and re-exports all of this; a module of its own so readers that only ask which runs are open (resolve-screen,
// plan-skeleton — a set whose only trace is an open run keeps its stem) do not bundle verify-run.
import path from "node:path";
import fs from "node:fs";
import { anyJson, readJson } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import { runCacheDir } from "./run-cache.ts";
import { scriptCmd, shellArg } from "./cli-args.ts";
import type { ProcessStamp } from "../bridge/src/file-lock.ts";

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
  /** the probe's failed attempts (exit 3/4) in this run (--run): the PROBE_ATTEMPTS-th ends the run `failed` */
  probeFailures?: number;
  /** the run this run's record replaced in the live status: ANOTHER run that had ended, written over by a write that
   *  names this run (`current`: verify-screen --status without --new-run, the probe's --run) — a late record of an older
   *  run after a newer one ended. Set by the run's first write and carried forward within the run, like the shas. */
  replaced?: ReplacedRun;
}
/** Which ended run a run's record replaced (VerifyStatusV2.replaced): its id, its last phase, and that write's time. */
export interface ReplacedRun { runId: string; phase: StatusPhase; at: string }
/** Who started a probe's own run: the probe process (file-lock.ts thisProcess), the time it started the run, and the
 *  deadline past which no live probe still writes in it (its start + --max-time + a grace for closing the browser,
 *  writing the files and the status lock) — the backstop for a pid that a later process reuses. */
export interface OwnRunStamp extends ProcessStamp { startedAt: string; deadline: string }

export const isPhase = (x: unknown): x is StatusPhase => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
const optStr = (x: unknown): boolean => x === undefined || typeof x === "string";
const isOwnRunStamp = (x: unknown): x is OwnRunStamp => isJsonObject(x) && typeof x.pid === "number" && typeof x.host === "string" && optStr(x.ns) && typeof x.startedAt === "string"
  && typeof x.deadline === "string";
const isFailureCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isReplacedRun = (x: unknown): x is ReplacedRun => isJsonObject(x) && typeof x.runId === "string" && isPhase(x.phase) && typeof x.at === "string";
export function isVerifyStatusV2(x: unknown): x is VerifyStatusV2 {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number"
    && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator")
    && optStr(x.expectationSha256) && optStr(x.measuredSha256) && optStr(x.evidenceSha256)
    && (x.published === undefined || (Array.isArray(x.published) && x.published.every((p) => typeof p === "string")))
    && (x.ownRun === undefined || isOwnRunStamp(x.ownRun)) && (x.probeFailures === undefined || isFailureCount(x.probeFailures))
    && (x.replaced === undefined || isReplacedRun(x.replaced));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";

/** The LIVE status of `<base>` (design/verify/<S>): `<run cache>/<S>.status.json`. */
export const liveStatusFile = (base: string): string => path.join(runCacheDir(path.dirname(base)), path.basename(base) + ".status.json");

/** A status file read: a v2 status, "v1" (an older hand-written one), or null (absent, unreadable, or neither). */
export function readStatusFile(file: string): VerifyStatusV2 | "v1" | null {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  // a malformed ownRun is ignored (read as a run nobody's probe owns), a malformed probeFailures as none counted, a
  // malformed replaced as no run replaced — never the whole status
  if (isJsonObject(r.doc) && (r.doc.ownRun !== undefined || r.doc.probeFailures !== undefined || r.doc.replaced !== undefined)) {
    const { ownRun, probeFailures, replaced, ...rest } = r.doc;
    const kept = { ...rest, ...(isOwnRunStamp(ownRun) ? { ownRun } : {}), ...(isFailureCount(probeFailures) ? { probeFailures } : {}), ...(isReplacedRun(replaced) ? { replaced } : {}) };
    if (isVerifyStatusV2(kept)) return kept;
  }
  return isJsonObject(r.doc) && r.doc.schema === undefined && typeof r.doc.phase === "string" ? "v1" : null;
}

/** The commands a refusal names for the open run `open` of `<base>`: wait for it, and end it `failed` — by the set's name,
 *  basename(base) (a migrated set's status still says its old name in `screen`). */
export function runCommands(base: string, open: { runId: string }): { waitIt: string; endIt: string } {
  const vs = scriptCmd("verify-screen"), S = shellArg(path.basename(base)), id = shellArg(open.runId), dir = shellArg(path.resolve(path.dirname(base)));
  return { waitIt: `${vs} --wait ${S} --run ${id} --dir ${dir}`, endIt: `${vs} --status ${S} --phase failed --run ${id} --dir ${dir}` };
}

/** The sets of `verifyDir` with a run open (a v2 live status that has not ended) in its run cache, sorted — a run opened
 *  by --status before any of its set's files exist is one of them. */
export function openRunSets(verifyDir: string): string[] {
  const SUFFIX = ".status.json";
  let files: fs.Dirent[];
  try { files = fs.readdirSync(runCacheDir(verifyDir), { withFileTypes: true }); } catch { return []; }
  return files.filter((e) => e.isFile() && e.name.endsWith(SUFFIX)).map((e) => e.name.slice(0, -SUFFIX.length))
    .filter((name) => { const st = readStatusFile(liveStatusFile(path.join(verifyDir, name))); return st !== null && st !== "v1" && !TERMINAL_PHASES.includes(st.phase); }).sort();
}
