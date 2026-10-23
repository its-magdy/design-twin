// verify-migrate.ts — `verify-screen --migrate [--apply] [--dir design/verify]`: renames the legacy-named verify sets
// in a verify dir to the canonical key (screen-key.ts): `<Layer>__<id>`, and a variant to `<Layer>__<id>.<slug>`.
//
// A dry run unless --apply: it prints what it would do, writes nothing. Per legacy set (a set whose name is not
// `<stem>` / `<stem>.<slug>`, not retired):
//   - its node id: the expectation's frame, else the report's nodeId (the two disagreeing: skipped), else the set's name
//     resolved exactly (screenKey: node id, exact name/title/plan header, a carried id); none or several: skipped;
//   - its new name: the node's existing grammar-named stem (several: skipped), else screenStem(the indexed layer name —
//     else the expectation's frame name, the report's screen, the set's own name —, id). A set whose name extends another
//     set of the same node (`<S>@320`, `<S>.dark`, `<S>-r1`) is a variant: `<stem>.<slug>`. So is a set named for the
//     layer itself and a suffix after "." or "@" (`<X>.dark`, `<X>@320`, safe(X) the layer name's safe(): the index's,
//     else the expectation's frame name, else the report's screen) — with or without a base set beside it, it is never
//     retired and never becomes the base; "-" is not read this way (layer names hold dashes). Any other name is the
//     base (a nickname). Two sets of one node that extend nothing are skipped (which one is the screen is a person's call),
//     and so is a variant whose slug the grammar refuses (reserved — `<S>.diff` — or too long), or that overlaps another
//     variant of the node by "-" (`w320` / `w320-dialog`, a live one or one the same run plans: variantOverlap);
//   - the node already has a canonical base set: the legacy expectation is retired (`<S>.expected.json.retired`, which
//     every reader skips) and its other files stay under `<S>` — unless a plan's verification.recorded names the
//     legacy report (re-record first: skipped);
//   - else every file of the set is renamed: `<S>.*` (its diff is `<S>.diff.png`), and of `<S>-*` only `<S>-diff.png` (no tool
//     writes that name now; kept for a diff named by hand) and what the set's measured
//     file or report lists in `artifacts` (any other may be another screen's); a file of a longer set name belongs to
//     that set. A case-only rename goes through a temp name. Refused when a new name is taken; each move is a hard link
//     then an unlink (link refuses an existing name), so a name taken meanwhile is never replaced. A disk without hard
//     links gets a rename after an existence check: the status locks keep status writes out, but a verify tool's other
//     writes (--expect, --compare, a probe's files) take no lock, so there a file written under the new name between
//     that check and the rename is replaced. Bytes a sha256 binds (the expectation, measured file, report, evidence) are
//     never rewritten — only file names change;
//   - a plan that names the set's files is rewritten under its lock: verification.recorded.report, .a11y.report and
//     .artifacts together (recordFacts makes a11y.report the report path, so changing one alone reads as a hand edit),
//     and the hand-owned verification.a11y.report and verification.artifacts (each said in a note). Each path is read as
//     verify-build reads it (only verification.a11y.report may be relative to the plan file, or a bare file name).
//     Never screen/file/nodeId (planHash covers them). The
//     hook's record is re-stamped only when it matched the plan under the older formula (legacyPlanHash), as
//     --record-plan does. Before anything moves: a plan whose record was edited by hand (verify-build recordedEdits), or
//     whose reportSha256 no longer names the report on disk (a rename would hide that), skips the set;
//   - a plan whose status reads the set's report by the name alone (plan-status.ts reports, verify-locate.ts locateReports: its `screen`, its
//     `file`, its export's or its own file name is the set's name) would lose it under the new name unless its node id
//     (node-artefacts.ts planNode: its nodeId, else the id its file name carries) is the set's — it then finds the
//     renamed report by id. Otherwise the set is skipped (renamed or retired), saying to add `nodeId` to the plan — or,
//     a plan of another node, naming both nodes;
//   - a set with an open run (status v2 not ended), under its name or the new one, is skipped. Both status locks are held
//     from the last checks to the end, so no status write lands in between; the live status moves with the set;
//   - after the move every plan written is checked again (recordedEdits == [] and its record names its report), and
//     every plan that found the set's report must find the renamed one; on a failure every rename is undone and every
//     plan restored — a plan only while it still holds the bytes the migration wrote (read under its lock): one written
//     again since is left as it is, and said.
// Recovery: a rename keeps a journal, `<verifyDir>/.migrate-<set>.json`, from before its first move until its post-check
// passes (or its rollback completes), each write of it synced to disk before the steps it records begin (so after a power
// cut, too, every step that can have reached the disk is in it). A run that dies in between leaves it, and the next --migrate reports it and does
// nothing else; --migrate --apply rolls it back first — every file to its old name (from whatever state each move
// reached), the live status back, and every plan it rewrote back to its old bytes, only while that plan still holds the
// bytes the migration wrote — then migrates as usual. A rollback that cannot finish keeps the journal and says what is
// left. The verify tools read no dot file there (it names no set); the visual-verifier may not write one.
// Not migrated: plans (never renamed), audit files, design/.sync snapshots, design/changes.
// Exit: 0 nothing skipped, 1 a set skipped or refused (each says why) or an interrupted migration awaiting its rollback
// (a dry run, or an --apply whose rollback could not finish), 2 usage.
import fs from "node:fs";
import path from "node:path";
import { tmpSuffix, writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { acquireFileLock } from "../bridge/src/file-lock.ts";
import type { HeldLock } from "../bridge/src/file-lock.ts";
import { errCode, errMsg } from "../bridge/src/errmsg.ts";
import { nodeIdFromStem, safe } from "../bridge/src/pages-layout.ts";
import { PLAN_DIR, VERIFY_DIR, findExportDir, listPlans } from "../bridge/src/project-layout.ts";
import { hookHashOf, planHash } from "./content-hash.ts";
import { formatPlan, parsePlanText, recordedEditFacts, recordedEdits, updatePlan } from "./plan-record.ts";
import { reportRecordNames } from "./report-freshness.ts";
import { canonical, planLockFile } from "./run-cache.ts";
import { resolveScreen } from "./resolve-screen.ts";
import { MAX_SLUG, RESERVED_SLUGS, allSets, formatSetName, isVariantSlug, parseSetName, screenKey, setFacts, variantOverlap, variantSlug, variantsOf } from "./screen-key.ts";
import { TERMINAL_PHASES, liveStatusFile, lockFileOfStatus, readStatus } from "./verify-run.ts";
import { nodeArtefacts, planNode } from "./node-artefacts.ts";
import { planStatus } from "./plan-status.ts";
import type { ReportRef } from "./verify-locate.ts";
import { getOrInit } from "./map-util.ts";
import { SET_FILE, isJournalFile, journalFile, setFile } from "./verify-sets.ts";
import { readJsonOrNull } from "./read-json.ts";
import { isJsonObject } from "./types.ts";
import type { Plan } from "./types.ts";

/** One file renamed: absolute paths, and the temp name a case-only rename goes through (`from` and `to` one name on a
 *  case-insensitive disk). */
export interface FileMove { from: string; to: string; tmp?: string }
/** A plan that names a set's files: its path (absolute, and as shown) and the file names it names, old → new. */
export interface PlanEdit { file: string; rel: string; names: Map<string, string> }
export type MigrateStep =
  | { kind: "rename"; set: string; to: string; nodeId: string; files: FileMove[]; plans: PlanEdit[] }
  | { kind: "retire"; set: string; nodeId: string; canonical: string; file: FileMove }
  | { kind: "skip"; set: string; why: string[] };

export interface MigrateOpts {
  /** the project root: plan paths are relative to it */
  cwd: string;
  /** the verify dir (absolute, or relative to cwd) */
  verifyDir: string;
  /** default <cwd>/design/plan */
  planDir?: string;
  /** default the project's export dir (findExportDir) */
  exportDir?: string;
  apply: boolean;
  /** where the steps are printed (default stdout) and the notes and skips (default stderr) */
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** more post-checks of a plan after the move (tests inject a failure here): problems, [] when none */
  postCheck?: (planFile: string, plan: Plan) => string[];
  /** tests only: called after each move and each plan write of a rename; a throw from it stands for the process dying
   *  there — it propagates at once, with no rollback, and the journal stays (as a killed run leaves it) */
  crashAt?: (at: { moved: number; plansWritten: number }) => void;
  /** tests only: called after a journal is read, before its rollback takes the status locks — where the run that wrote
   *  it may still finish and remove it */
  journalRead?: (file: string) => void;
  /** tests only: how a file gets its new name before its old one is unlinked (default fs.linkSync) — a disk's link
   *  refusals are injected here */
  link?: LinkFn;
}
export interface MigrateResult {
  steps: MigrateStep[]; done: string[]; skipped: Array<{ set: string; why: string[] }>;
  /** the sets whose interrupted migration (a journal) was rolled back first */
  rolledBack: string[];
}

const slash = (p: string): string => p.split(path.sep).join("/");
const exists = (p: string): boolean => fs.existsSync(p);
/** Two paths are one file (a case-only rename on a case-insensitive disk). The ids are read as bigints: a 64-bit file
 *  id (NTFS) loses its low bits as a Number, and two files could then compare equal. */
function sameFile(a: string, b: string): boolean {
  try { const x = fs.statSync(a, { bigint: true }), y = fs.statSync(b, { bigint: true }); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}
/** A status of `base` that names a run still open (v2, not ended), or null. */
function openRunOf(base: string): string | null {
  const st = readStatus(base);
  return st && st !== "v1" && !TERMINAL_PHASES.includes(st.phase) ? `run ${st.runId} of ${path.basename(base)} is open (phase ${st.phase}, ${st.at}) — wait for it to end, then --migrate` : null;
}

// ---------------------------------------------------------------- the paths a plan names

type RefField = "verification.recorded.report" | "verification.recorded.a11y.report" | "verification.recorded.artifacts" | "verification.a11y.report" | "verification.artifacts";
/** The fields a person writes (not --record-plan): rewriting one is said in a note. */
const HAND_FIELDS: readonly RefField[] = ["verification.a11y.report", "verification.artifacts"];
/** Every path in the plan's verification that may name a verify file — `map` gives each one's new spelling (null: not
 *  one of the set's files). With `write`, the plan is changed in place. The fields changed, in order. */
function rewriteRefs(plan: Plan, map: (ref: string, field: RefField) => string | null, write: boolean): RefField[] {
  const changed: RefField[] = [];
  const v: unknown = plan.verification;
  if (!isJsonObject(v)) return changed;
  const one = (o: Record<string, unknown>, key: string, field: RefField): void => {
    const ref = o[key];
    if (typeof ref !== "string") return;
    const to = map(ref, field);
    if (to === null) return;
    if (write) o[key] = to;
    if (!changed.includes(field)) changed.push(field);
  };
  const list = (arts: unknown, field: RefField): void => {
    if (Array.isArray(arts)) arts.forEach((a, i) => {
      if (typeof a !== "string") return;
      const to = map(a, field);
      if (to === null) return;
      if (write) arts[i] = to;
      if (!changed.includes(field)) changed.push(field);
    });
  };
  const rec = v.recorded;
  if (isJsonObject(rec)) {
    one(rec, "report", "verification.recorded.report");
    if (isJsonObject(rec.a11y)) one(rec.a11y, "report", "verification.recorded.a11y.report");
    list(rec.artifacts, "verification.recorded.artifacts");
  }
  if (isJsonObject(v.a11y)) one(v.a11y, "report", "verification.a11y.report");
  list(v.artifacts, "verification.artifacts");
  return changed;
}

/** The recorded report path of a plan, when it has a record naming one. */
function recordedReport(plan: Plan): { report: string; sha: unknown } | null {
  const v: unknown = plan.verification;
  const rec = isJsonObject(v) ? v.recorded : undefined;
  return isJsonObject(rec) && typeof rec.report === "string" && rec.report ? { report: rec.report, sha: rec.reportSha256 } : null;
}

// ---------------------------------------------------------------- the migration

interface PlanText { file: string; rel: string; plan: Plan }

export function migrate(opts: MigrateOpts): MigrateResult {
  const out = opts.out ?? ((l: string) => { console.log(l); });
  const err = opts.err ?? ((l: string) => { console.error(l); });
  const cwd = path.resolve(opts.cwd);
  const verifyDir = path.resolve(cwd, opts.verifyDir);
  const planDir = path.resolve(cwd, opts.planDir ?? PLAN_DIR);
  const exportDir = opts.exportDir !== undefined ? path.resolve(cwd, opts.exportDir) : findExportDir(cwd).dir;
  const shown = (abs: string): string => slash(path.relative(cwd, abs)) || ".";
  /** A path relative to the project (its own spelling or its path as the run cache spells it: realpathSync.native, the long
   *  name in the on-disk case), or absolute when it is outside (a run cache in the OS temp dir). */
  const roots = [cwd, canonical(cwd)];
  const shownAnywhere = (abs: string): string => {
    for (const root of roots) { const rel = path.relative(root, abs); if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return slash(rel); }
    return slash(abs);
  };
  const link = opts.link ?? fs.linkSync;
  const skip = (result: MigrateResult, set: string, why: string[]): void => {
    result.skipped.push({ set, why });
    err(`skip    ${shown(path.join(verifyDir, set))}: ${why[0] ?? ""}`);
    for (const w of why.slice(1)) err(`        ${w}`);
  };

  // an interrupted migration first: its journal is rolled back (--apply) before anything is planned — the disk is half
  // way between two names until then, and a plan read from it would be wrong
  const first: MigrateResult = { steps: [], done: [], skipped: [], rolledBack: [] };
  for (const file of listJournals(verifyDir)) {
    const j = readJournal(file);
    if ("why" in j) { skip(first, path.basename(file), [`${shown(file)}: ${j.why} — not a journal --migrate wrote; remove it by hand`]); continue; }
    const what = `an interrupted migration of ${j.set} -> ${j.to} (${j.at}) left ${shown(file)}`;
    if (!opts.apply) { skip(first, j.set, [`${what} — --migrate --apply rolls it back first (every file to its old name, every plan it rewrote to its old bytes), then migrates`]); continue; }
    opts.journalRead?.(file);
    const rb = rollbackJournal(file, j, { cwd, verifyDir, planDir, link });
    if ("gone" in rb) { err(`note  ${shown(file)} is gone: the migration of ${j.set} -> ${j.to} ended while its status locks were awaited — nothing to roll back`); continue; }
    const now = `an interrupted migration of ${rb.j.set} -> ${rb.j.to} (${rb.j.at}) left ${shown(file)}`;
    if (rb.retry) { skip(first, j.set, [`${now} — rolled back in part; the journal stays, so --migrate --apply tries again:`, ...rb.left.map((x) => `  ${x}`)]); continue; }
    first.rolledBack.push(j.set);
    out(`rolled back ${shown(path.join(verifyDir, j.set))}: ${now} — every file is under its old name again`);
    for (const x of rb.left) err(`note  ${x}`);
  }
  if (first.skipped.length) { err(`nothing migrated: ${first.skipped.length} interrupted migration(s) to roll back first`); return first; }

  const steps = planMigration({ cwd, verifyDir, planDir, exportDir });
  const result: MigrateResult = { ...first, steps };

  for (const s of steps) {
    if (s.kind === "skip") { skip(result, s.set, s.why); continue; }
    if (s.kind === "retire") {
      out(`${opts.apply ? "retire " : "would retire"}  ${shown(s.file.from)} -> ${path.basename(s.file.to)} (node ${s.nodeId} already has ${shown(path.join(verifyDir, s.canonical))}; its other files stay under ${s.set})`);
    } else {
      out(`${opts.apply ? "migrate" : "would migrate"} ${shown(path.join(verifyDir, s.set))} -> ${s.to} (node ${s.nodeId}): ${s.files.length} file(s)`);
      for (const f of s.files) out(`  rename  ${path.basename(f.from)} -> ${path.basename(f.to)}`);
      // the live status in the run cache moves too, when the new name has none (as applyRename decides)
      const liveOld = liveStatusFile(path.join(verifyDir, s.set)), liveNew = liveStatusFile(path.join(verifyDir, s.to));
      if (exists(liveOld) && !exists(liveNew)) out(`  live    ${shownAnywhere(liveOld)} -> ${path.basename(liveNew)}`);
      for (const p of s.plans) out(`  plan    ${p.rel}: ${[...p.names].map(([a, b]) => `${a} -> ${b}`).join(", ")}`);
    }
    if (!opts.apply) continue;
    const r = s.kind === "retire" ? applyRetire(s, { cwd, verifyDir, planDir, link }) : applyRename(s, { cwd, verifyDir, planDir, link, postCheck: opts.postCheck, crashAt: opts.crashAt });
    if (r.why.length) skip(result, s.set, r.why);
    else result.done.push(s.set);
    for (const n of r.notes) err(`note  ${n}`);
  }
  const moving = steps.filter((s) => s.kind !== "skip").length;
  if (!steps.length) err(`nothing to migrate: every verify set in ${shown(verifyDir)} is named <Layer>__<id> or <Layer>__<id>.<variant>`);
  else if (!opts.apply) err(`dry run — nothing written: ${moving} set(s) to migrate or retire, ${result.skipped.length} skipped; pass --apply to do it`);
  else err(`${result.done.length} set(s) migrated or retired, ${result.skipped.length} skipped`);
  return result;
}

interface Dirs { cwd: string; verifyDir: string; planDir: string; exportDir: string }

/** Every plan in the plan dir that parses (one that does not names nothing the migration could rewrite). */
function readPlans(planDir: string, cwd: string): PlanText[] {
  const out: PlanText[] = [];
  for (const f of listPlans(planDir)) {
    const file = path.join(planDir, f);
    try { out.push({ file, rel: slash(path.relative(cwd, file)), plan: parsePlanText(fs.readFileSync(file, "utf8"), file) }); } catch { /* not a plan */ }
  }
  return out;
}

/** The verify file a plan's path names, as its file name in the verify dir; null for any other path. Read as verify-build
 *  reads that field: verification.a11y.report project-relative or absolute, relative to the plan file, or a bare file
 *  name (a11yReportOf); every other field project-relative or absolute only (reportRecordNames, the artifact checks). */
function namedFile(ref: string, field: RefField, planFile: string, d: { cwd: string; verifyDir: string }): string | null {
  if (field !== "verification.a11y.report") { const abs = path.resolve(d.cwd, ref); return path.dirname(abs) === d.verifyDir ? path.basename(abs) : null; }
  for (const abs of [path.resolve(d.cwd, ref), path.resolve(path.dirname(planFile), ref)]) {
    if (path.dirname(abs) === d.verifyDir) return path.basename(abs);
  }
  return /[\\/]/.test(ref) ? null : ref;
}
/** `ref` with its file name `from` replaced by `to`, spelt as it was (its directory part kept). */
const respell = (ref: string, from: string, to: string): string => (ref.endsWith(from) ? ref.slice(0, ref.length - from.length) + to : to);

/** The way on for a plan whose record cannot be re-recorded under the legacy name (verify-screen --compare refuses
 *  one): record the node's canonical set instead — --record-plan replaces the block whole, so the plan no longer names
 *  this set's report — and --migrate then retires a base set (its node has a base set now) or renames a variant. */
const RECORD_THE_NODE = "run verify-screen --expect (no --variant; it writes the node's <Layer>__<id> base set), measure that set and run --compare --record-plan on it " +
  "(it replaces the block), then --migrate retires this set (a base set) or renames it (a variant)";
/** Why a plan cannot be rewritten for a move (its record edited by hand, or naming a report its sha no longer names).
 *  The record's findings are verify-build's facts without its advice (recordedEditFacts): that advice re-records, and
 *  --compare refuses a legacy-named set. */
function planBlocks(p: PlanText, names: ReadonlyMap<string, string>, d: { cwd: string; verifyDir: string }): string[] {
  const edits = recordedEditFacts(p.plan, d.cwd);
  if (edits.length) {
    return [`${p.rel} has a hand-edited record, and it cannot be re-recorded under this legacy name (verify-screen --compare refuses one) — restore the block (undo the edit); or ${RECORD_THE_NODE}; residuals go in deviations[]. The record's findings:`,
      ...edits.map((e) => `  ${e.fact}`)];
  }
  const rec = recordedReport(p.plan);
  if (rec) {
    const name = namedFile(rec.report, "verification.recorded.report", p.file, d);
    if (name !== null && names.has(name) && reportRecordNames(rec.report, rec.sha, d.cwd) === null) {
      return [`${p.rel}: verification.recorded.reportSha256 does not name ${rec.report} as it is on disk (an older record, or the report changed) — restore the report the record names; or ${RECORD_THE_NODE}. Renaming now would hide the difference`];
    }
  }
  return [];
}

// ---------------------------------------------------------------- the plans that find a set's report

/** The reports a plan's status reads (plan-status.ts reports). */
type RefsOf = (p: PlanText) => ReportRef[];
const freshRefs = (d: { cwd: string }): RefsOf => (p) => planStatus(d.cwd).reports(p.plan, p.file);
/** The plans whose status reads `<set>.report.json`, each with how (the first matcher that holds). None when the verify
 *  dir is not the project's design/verify: a status reads no other. */
function plansFinding(plans: readonly PlanText[], set: string, d: { cwd: string; verifyDir: string }, refsOf: RefsOf): Array<{ p: PlanText; ref: ReportRef }> {
  if (path.resolve(d.verifyDir) !== path.join(d.cwd, VERIFY_DIR)) return [];
  const rel = slash(path.relative(d.cwd, setFile(path.join(d.verifyDir, set), "report")));
  return plans.flatMap((p) => { const ref = refsOf(p).find((r) => r.rel === rel); return ref ? [{ p, ref }] : []; });
}
/** Why the set `set` of node `id` cannot change its name: a plan that finds its report by the name alone (its `screen`,
 *  its `file`, its export's or its own file name is the set's name) and whose node id (planNode) is another, or none,
 *  would find nothing under the new name. A plan with no node id is told to add the set's; one of another node is told
 *  which two nodes differ. */
function nameOnlyBlocks(plans: readonly PlanText[], set: string, id: string, d: { cwd: string; verifyDir: string }, refsOf: RefsOf): string[] {
  return plansFinding(plans, set, d, refsOf).filter((f) => f.ref.matchedBy === "name").flatMap(({ p }) => {
    const pid = planNode(p.plan, p.file);
    if (pid === id) return [];
    if (pid === null) return [`${p.rel} finds this set only by its name — add \`"nodeId": "${id}"\` to it, then --migrate`];
    return [`${p.rel} is a plan of node ${pid}, and finds this set (of node ${id}) only by its name — if the plan is of node ${id}, give it \`"nodeId": "${id}"\`; ` +
      `if not, the set is another screen's: retire it or verify node ${pid} under its own set; then --migrate`];
  });
}

/** The `<set>-…` files that are the set's: `<set>-diff.png` (no tool writes that name now — the probe writes `<set>.diff.png`,
 *  SET_FILE.diff, which `<set>.*` covers — kept for a diff named by hand), and every one its measured file or its report lists in
 *  `artifacts` (a hand-taken `<set>-dark.png`, `<set>-<state>.png`). Any other `<set>-…` name may be another screen's
 *  (`Crates-detail.png` of a screen named `Crates-detail`) and stays where it is. */
function dashFiles(verifyDir: string, set: string): Set<string> {
  const own = new Set<string>([`${set}-diff.png`]);
  for (const tail of [SET_FILE.measured, SET_FILE.report]) {
    const doc = readJsonOrNull(path.join(verifyDir, set + tail), isJsonObject);
    const arts = doc && Array.isArray(doc.artifacts) ? doc.artifacts : [];
    for (const a of arts) if (typeof a === "string" && path.basename(a).startsWith(set + "-")) own.add(path.basename(a));
  }
  return own;
}

/** What --migrate would do, computed from the disk now (nothing written). */
export function planMigration(d: Dirs): MigrateStep[] {
  const sets = allSets(d.verifyDir);
  if (!sets.length) return [];
  // each file of the dir belongs to the LONGEST set name it starts with, followed by "." or "-" — a "-" file only when
  // that set owns it (dashFiles), else to no set (retired sets count: their files are theirs)
  const names = sets.map((s) => s.name).sort((a, b) => b.length - a.length);
  const dashCache = new Map<string, Set<string>>();
  const ownsDash = (set: string, file: string): boolean => getOrInit(dashCache, set, () => dashFiles(d.verifyDir, set)).has(file);
  const filesOf = new Map<string, string[]>();
  for (const e of fs.readdirSync(d.verifyDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const longest = names.find((n) => e.name.startsWith(n + ".") || e.name.startsWith(n + "-"));
    const owner = longest !== undefined && (e.name.startsWith(longest + ".") || ownsDash(longest, e.name)) ? longest : undefined;
    if (owner !== undefined) filesOf.set(owner, [...(filesOf.get(owner) ?? []), e.name]);
  }
  const live = sets.filter((s) => !s.retired).map((s) => s.name);
  const legacy = live.filter((n) => parseSetName(n) === null);
  if (!legacy.length) return [];
  const steps: MigrateStep[] = [];
  const hasIndex = exists(path.join(d.exportDir, "pages", "index.json"));

  // node id of each legacy set: the one id it carries (node-artefacts.ts setIds — its name's, its expectation's frame,
  // its report's), else its name resolved; two ids are skipped, never one picked
  const art = nodeArtefacts(d.cwd, { verifyDir: d.verifyDir });
  const byId = new Map<string, string[]>();
  for (const name of legacy) {
    const ids = art.setIds(name);
    if (ids.length > 1) {
      steps.push({ kind: "skip", set: name, why: [`its name, expectation and report carry nodes ${ids.join(" and ")} — retire the stale one by hand`] });
      continue;
    }
    let id = ids[0] ?? null;
    if (id === null) {
      const k = screenKey(name, { exportDir: d.exportDir, planDir: d.planDir });
      if (k.status !== "resolved") { steps.push({ kind: "skip", set: name, why: [`no node id: its expectation and report name none, and the name gives none (${k.why})`] }); continue; }
      id = k.nodeId;
    }
    byId.set(id, [...(byId.get(id) ?? []), name]);
  }

  const plans = readPlans(d.planDir, d.cwd);
  const refCache = new Map<string, ReportRef[]>();
  const fresh = freshRefs(d);
  const refsOf: RefsOf = (p) => getOrInit(refCache, p.file, () => fresh(p));
  const taken = new Set<string>(sets.map((s) => s.name));
  for (const [id, group] of byId) {
    // the node's layer name: the index's, else (per set) what the set's files say
    const row = hasIndex ? resolveScreen(d.exportDir, id) : null;
    const indexed = row && row.status === "resolved" ? row.row.name : null;
    const layerOf = (name: string): string | null => { if (indexed !== null) return indexed; const f = setFacts(d.verifyDir, name); return f.expectedName ?? f.reportScreen; };
    // the stem: the node's existing one — a run open in the run cache with no file yet included — else from its layer name
    // (else the set's own name): node-artefacts.ts claim. A set whose new name has an open run is skipped below.
    const first = group[0] ?? "";
    const k = art.claim("verify set", id, { layerName: layerOf(first) ?? first });
    if (!k.ok) {
      for (const name of group) steps.push({ kind: "skip", set: name, why: [`${k.why}, then --migrate`] });
      continue;
    }
    const T = k.name;
    const baseExists = live.includes(T);
    // a set that extends another name of the node (`<S>@320`, `<S>.dark`, `<S>-r1`) is a variant of it; `cut` is where its
    // own part starts (after the "." / "@" / "-")
    const parentOf = new Map<string, string>();
    const cutOf = new Map<string, number>();
    for (const name of group) {
      const cands = new Set<string>([T, ...group.filter((g) => g !== name)]);
      for (let i = 1; i < name.length; i++) {
        const p = name.slice(0, i);
        if (".@-".includes(name[i] ?? "") && /^[A-Za-z0-9_]+$/.test(p) && nodeIdFromStem(p) === id) cands.add(p);
      }
      let best: string | undefined;
      for (const c of cands) if (name.length > c.length + 1 && name.startsWith(c) && ".@-".includes(name[c.length] ?? "") && (best === undefined || c.length > best.length)) best = c;
      if (best !== undefined) { parentOf.set(name, best); cutOf.set(name, best.length + 1); continue; }
      // `<Layer>.<x>` / `<Layer>@<x>` — the layer name (as safe() spells it) and a suffix — is a variant of the screen
      // itself, never its base: `Crates.dark`, `Crates@320`. "-" is not read this way: layer names hold dashes.
      const layer = layerOf(name);
      if (layer === null) continue;
      for (let i = 1; i < name.length - 1; i++) {
        if (".@".includes(name[i] ?? "") && safe(name.slice(0, i)) === safe(layer)) { parentOf.set(name, T); cutOf.set(name, i + 1); break; }
      }
    }
    const slugOf = (name: string): string => {
      const p = parentOf.get(name);
      if (p === undefined) return "";
      const own = variantSlug(name.slice(cutOf.get(name) ?? p.length + 1));
      const up = group.includes(p) ? slugOf(p) : "";
      return up && own ? `${up}-${own}` : up || own;
    };
    const roots = group.filter((n) => !parentOf.has(n));
    const rootOf = (name: string): string => { let n = name; for (let p = parentOf.get(n); p !== undefined && group.includes(p); p = parentOf.get(n)) n = p; return n; };
    const wanted = new Map<string, string[]>(); // new name -> the legacy sets that want it
    const plannedTo = new Map<string, string>();
    for (const name of group) {
      if (roots.length > 1 && roots.includes(rootOf(name))) continue;
      const isRoot = !parentOf.has(name);
      const slug = slugOf(name);
      if (!isRoot && !slug) { steps.push({ kind: "skip", set: name, why: [`its name extends ${parentOf.get(name) ?? "?"} by nothing a variant slug can keep — rename it by hand`] }); continue; }
      // a slug the grammar refuses (reserved: `diff` would make `<S>.diff.png` both this variant's screenshot and the base set's diff)
      if (!isRoot && !isVariantSlug(slug)) {
        steps.push({ kind: "skip", set: name, why: [`variant '${slug}' is not a slug a set can take (${RESERVED_SLUGS.has(slug) ? "reserved: it names a file of a set" : `longer than ${MAX_SLUG} characters`}) — rename it by hand`] });
        continue;
      }
      const to = isRoot ? T : formatSetName(T, slug);
      plannedTo.set(name, to);
      wanted.set(to, [...(wanted.get(to) ?? []), name]);
    }
    if (roots.length > 1) {
      const why = `${roots.length} legacy sets of node ${id} extend no other name (${roots.join(", ")}) — which one is the screen is your call: retire the others ` +
        `(mv <S>.expected.json <S>.expected.json.retired), then --migrate`;
      for (const name of group) if (roots.includes(rootOf(name))) steps.push({ kind: "skip", set: name, why: [why] });
    }
    // the node's variants once the batch is done: the live ones and every one this batch plans (variantOverlap)
    const variantsAfter = [...variantsOf(d.verifyDir, T), ...[...plannedTo.values()].flatMap((t) => { const v = parseSetName(t)?.variant; return v ? [v] : []; })];
    for (const [name, to] of plannedTo) {
      const rivals = wanted.get(to) ?? [];
      if (rivals.length > 1) { steps.push({ kind: "skip", set: name, why: [`${rivals.join(" and ")} would both become ${to} — retire one by hand`] }); continue; }
      const slug = parseSetName(to)?.variant ?? null;
      const overlap = slug !== null ? variantOverlap(slug, variantsAfter) : null;
      if (slug !== null && overlap !== null) {
        steps.push({ kind: "skip", set: name, why: [`variant '${slug}' overlaps '${overlap}' by "-" (<set>-<state>.png of one names a screenshot of the other) — rename one by hand`] });
        continue;
      }
      const open = openRunOf(path.join(d.verifyDir, name)) ?? openRunOf(path.join(d.verifyDir, to));
      if (open) { steps.push({ kind: "skip", set: name, why: [open] }); continue; }
      const files = (filesOf.get(name) ?? []).sort();
      const report = setFile(name, "report");
      if (to === T && baseExists) {
        // the node's canonical set is there: this one is history — unless a plan still records its report
        const recording = plans.filter((p) => { const r = recordedReport(p.plan); return r !== null && namedFile(r.report, "verification.recorded.report", p.file, d) === report; }).map((p) => p.rel);
        if (recording.length) { steps.push({ kind: "skip", set: name, why: [`node ${id} already has ${T}, and ${recording.join(", ")} still record${recording.length === 1 ? "s" : ""} ${report} — re-run verify-screen --compare --record-plan on ${T}, then --migrate`] }); continue; }
        const byName = nameOnlyBlocks(plans, name, id, d, refsOf);
        if (byName.length) { steps.push({ kind: "skip", set: name, why: byName }); continue; }
        const from = setFile(path.join(d.verifyDir, name), "expected");
        if (!exists(from)) { steps.push({ kind: "skip", set: name, why: [`node ${id} already has ${T}, and this set has no expectation to retire — move its files aside by hand`] }); continue; }
        const retired = setFile(path.join(d.verifyDir, name), "retired");
        // one file under both names is a retire killed between its link and its unlink: applyRetire finishes it
        if (exists(retired) && !sameFile(from, retired)) { steps.push({ kind: "skip", set: name, why: [`${path.basename(retired)} already exists — refusing to replace it`] }); continue; }
        steps.push({ kind: "retire", set: name, nodeId: id, canonical: T, file: { from, to: retired } });
        continue;
      }
      if (taken.has(to)) { steps.push({ kind: "skip", set: name, why: [`${to} already exists in the verify dir — refusing to merge two sets; retire one by hand`] }); continue; }
      const moves: FileMove[] = files.map((f) => ({ from: path.join(d.verifyDir, f), to: path.join(d.verifyDir, to + f.slice(name.length)) }));
      const clash = moves.filter((m) => exists(m.to) && !sameFile(m.from, m.to)).map((m) => path.basename(m.to));
      if (clash.length) { steps.push({ kind: "skip", set: name, why: [`refusing to replace ${clash.join(", ")}`] }); continue; }
      const nameMap = new Map(files.map((f) => [f, to + f.slice(name.length)] as const));
      const edits: PlanEdit[] = [];
      const blocks: string[] = [];
      for (const p of plans) {
        const used = new Map<string, string>();
        rewriteRefs(p.plan, (ref, field) => { const n = namedFile(ref, field, p.file, d); const nn = n === null ? undefined : nameMap.get(n); if (n !== null && nn !== undefined) used.set(n, nn); return null; }, false);
        if (!used.size) continue;
        blocks.push(...planBlocks(p, nameMap, d));
        edits.push({ file: p.file, rel: p.rel, names: used });
      }
      blocks.push(...nameOnlyBlocks(plans, name, id, d, refsOf));
      if (blocks.length) { steps.push({ kind: "skip", set: name, why: blocks }); continue; }
      steps.push({ kind: "rename", set: name, to, nodeId: id, files: moves, plans: edits });
      taken.add(to);
    }
  }
  const order = new Map(legacy.map((n, i) => [n, i] as const));
  return steps.sort((a, b) => (order.get(a.set) ?? 0) - (order.get(b.set) ?? 0));
}

// ---------------------------------------------------------------- applying one step

const STATUS_LOCK = { waitMs: 15_000 };
/** The status locks of `bases`, taken in one order (two migrations never wait on each other), or why not. Two names
 *  that differ only in case are one lock file on a case-insensitive disk: the second is then the first, already held. */
function lockStatuses(bases: string[]): { locks: HeldLock[] } | { why: string } {
  const locks: HeldLock[] = [];
  const taken: string[] = [];
  for (const file of [...new Set(bases.map(lockFileOfStatus))].sort()) {
    if (taken.some((t) => t.toLowerCase() === file.toLowerCase() && sameFile(t, file))) continue;
    try { locks.push(acquireFileLock(file, STATUS_LOCK)); taken.push(file); } catch (e) {
      for (const l of locks) l.release();
      return { why: `the status lock ${file} could not be taken: ${errMsg(e)}` };
    }
  }
  return { locks };
}

// ---------------------------------------------------------------- moving files, never over another

/** How a file gets its second name (fs.linkSync; MigrateOpts.link in tests). */
export type LinkFn = (from: string, to: string) => void;
/** Link errors that mean the disk has no hard links (FAT/exFAT, some network shares). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);
/** Does a link error `code` mean the disk has no hard links? On Windows, CreateHardLink on FAT/exFAT fails with
 *  ERROR_INVALID_FUNCTION, which libuv reports as EISDIR — the source of a move is always a regular file, so there
 *  EISDIR means no hard links too. */
export function noHardLinks(code: string | undefined, platform: string = process.platform): boolean {
  return code !== undefined && (NO_HARD_LINKS.has(code) || (code === "EISDIR" && platform === "win32"));
}
/** `from` renamed to `to`, never replacing a file there: a hard link (which refuses an existing name), then the old name
 *  unlinked. A disk without hard links gets a rename after an existence check instead. The status locks held here keep
 *  out status writes only — a verify tool's other writes (--expect, --compare, a probe's files) take no such lock — so
 *  on that disk a file written under `to` between the check and the rename is replaced. */
function moveNoReplace(from: string, to: string, link: LinkFn): void {
  try { link(from, to); } catch (e) {
    const code = errCode(e);
    const noLinks = noHardLinks(code);
    if (code === "EEXIST" || (noLinks && exists(to))) throw new Error(`${path.basename(to)} appeared during the move — refusing to replace it`);
    if (!noLinks) throw e;
    fs.renameSync(from, to);
    return;
  }
  try { fs.unlinkSync(from); } catch (e) {
    try { fs.unlinkSync(to); } catch { /* both names stay: undoMove reads one file under two names as "linked, not unlinked" */ }
    throw e;
  }
}
/** A move: a case-only one (`from` and `to` one name on a case-insensitive disk) goes through its temp name. */
function doMove(m: FileMove, link: LinkFn): void {
  if (m.tmp === undefined) { moveNoReplace(m.from, m.to, link); return; }
  fs.renameSync(m.from, m.tmp);
  try { moveNoReplace(m.tmp, m.to, link); } catch (e) { fs.renameSync(m.tmp, m.from); throw e; }
}
/** Is `p`'s own name, case and all, in its directory? (existsSync answers for any spelling on a case-insensitive disk.) */
function listed(p: string): boolean {
  try { return fs.readdirSync(path.dirname(p)).includes(path.basename(p)); } catch { return false; }
}
/** One move undone from whatever state it reached — not begun, inside its temp name, linked but not yet unlinked, done:
 *  null, or why it could not be. */
function undoMove(m: FileMove, link: LinkFn): string | null {
  const name = path.basename;
  try {
    if (m.tmp !== undefined && listed(m.tmp)) {
      if (listed(m.from)) return `${name(m.tmp)} and ${name(m.from)} both exist — keep one by hand`;
      // linked to the new name, the temp name not yet unlinked: the new name goes first (on a case-insensitive disk it
      // is the old name in another case, and a link to the old name would find it taken)
      if (listed(m.to) && sameFile(m.tmp, m.to)) fs.unlinkSync(m.to);
      moveNoReplace(m.tmp, m.from, link);
      return null;
    }
    const atFrom = listed(m.from), atTo = listed(m.to);
    if (atFrom && atTo) {
      if (!sameFile(m.from, m.to)) return `${name(m.from)} and ${name(m.to)} both exist — keep one by hand`;
      fs.unlinkSync(m.to); // linked, not yet unlinked
      return null;
    }
    if (atFrom) return null; // never moved, or already back
    if (!atTo) return `${name(m.from)} is gone and ${name(m.to)} is not there — restore it by hand`;
    if (m.from.toLowerCase() !== m.to.toLowerCase()) { moveNoReplace(m.to, m.from, link); return null; }
    const tmp = m.to + tmpSuffix();
    fs.renameSync(m.to, tmp);
    try { moveNoReplace(tmp, m.from, link); } catch (e) { fs.renameSync(tmp, m.to); throw e; }
    return null;
  } catch (e) { return `${name(m.to)} could not be renamed back to ${name(m.from)}: ${errMsg(e)}`; }
}

/** A plan this migration rewrote: the bytes it replaced and the bytes it wrote, both read under the plan's lock. */
interface PlanWrite { file: string; before: string; after: string }
const readText = (file: string): string | null => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
/** What one undo step could not do: why, and whether it is final — nothing a retry does can settle it (a plan written
 *  again since) — or worth another try once the cause is gone (a lock, an I/O error, two files under one name). */
interface Unsettled { why: string; final: boolean }
/** A plan put back as it was — only while it still holds the bytes this migration wrote: a newer write is kept, and
 *  said (final). Null when done or nothing to do. */
function restorePlan(w: PlanWrite, cwd: string): Unsettled | null {
  const rel = slash(path.relative(cwd, w.file));
  try {
    const lock = acquireFileLock(planLockFile(w.file));
    try {
      const now = readText(w.file);
      if (now === w.before) return null;
      if (now !== w.after) return { why: `${rel} was written again after the migration rewrote it — left as it is (a path in it may name a renamed file: fix it by hand)`, final: true };
      writeFileAtomic(w.file, w.before);
      return null;
    } finally { lock.release(); }
  } catch (e) { return { why: `${rel} could not be restored: ${errMsg(e)}`, final: false }; }
}
/** Undo steps in order: what is left (said), and whether a retry may still settle part of it (the journal stays). */
function settle(plans: Array<Unsettled | null>, moves: readonly FileMove[], link: LinkFn): { left: string[]; retry: boolean } {
  const all = [...plans, ...moves.map((m): Unsettled | null => { const why = undoMove(m, link); return why === null ? null : { why, final: false }; })].filter((x): x is Unsettled => x !== null);
  return { left: all.map((x) => x.why), retry: all.some((x) => !x.final) };
}

// ---------------------------------------------------------------- the journal: what a rename in progress has done

// `<verifyDir>/.migrate-<set>.json`, written (atomically, and synced to disk: writeFileAtomic's `sync`) before a
// rename's first move and before each plan write, and removed once its post-check passes or its rollback is complete:
// the moves (file names in the verify dir, a case-only one's temp name, and whether
// the live status moves too) and each plan it rewrites, with the bytes it replaced and — once written — the bytes it
// wrote. A run that dies half way leaves it; the next --migrate reports it, and --apply rolls it back first. Names
// only, never paths: a journal can move nothing outside the verify dir, the run cache's live status of its two sets,
// and the plan dir's plans.
const JOURNAL_SCHEMA = "designtwin/verify-migrate-journal@1";
interface JournalPlan { file: string; before: string; after?: string }
interface Journal { schema: string; set: string; to: string; at: string; moves: Array<{ from: string; to: string; tmp?: string }>; live: boolean; plans: JournalPlan[] }

function listJournals(verifyDir: string): string[] {
  try { return fs.readdirSync(verifyDir).filter(isJournalFile).sort().map((f) => path.join(verifyDir, f)); } catch { return []; }
}
/** A plain file name: no directory part, not "." or "..". */
const isName = (x: unknown): x is string => typeof x === "string" && x !== "" && x !== "." && x !== ".." && !/[\\/]/.test(x);
function readJournal(file: string): Journal | { why: string } {
  let j: unknown;
  try { const x: unknown = JSON.parse(fs.readFileSync(file, "utf8")); j = x; } catch (e) { return { why: `unreadable (${errMsg(e)})` }; }
  if (!isJsonObject(j) || j.schema !== JOURNAL_SCHEMA) return { why: `no ${JOURNAL_SCHEMA} schema` };
  const { set, to, at, moves, live, plans } = j;
  if (!isName(set) || !isName(to) || typeof at !== "string" || typeof live !== "boolean" || !Array.isArray(moves) || !Array.isArray(plans)) return { why: "malformed" };
  const ms: Journal["moves"] = [];
  for (const m of moves) {
    if (!isJsonObject(m) || !isName(m.from) || !isName(m.to) || (m.tmp !== undefined && !isName(m.tmp))) return { why: "a move that is not two file names" };
    ms.push({ from: m.from, to: m.to, ...(m.tmp !== undefined ? { tmp: m.tmp } : {}) });
  }
  const ps: JournalPlan[] = [];
  for (const p of plans) {
    if (!isJsonObject(p) || !isName(p.file) || !p.file.endsWith(".json") || typeof p.before !== "string" || (p.after !== undefined && typeof p.after !== "string")) return { why: "a plan entry that is not a plan file name and its bytes" };
    ps.push({ file: p.file, before: p.before, ...(p.after !== undefined ? { after: p.after } : {}) });
  }
  return { schema: JOURNAL_SCHEMA, set, to, at, moves: ms, live, plans: ps };
}
/** A journal's moves as paths, in the order they were made: the set's files, then the live status. */
function journalMoves(j: Journal, verifyDir: string): FileMove[] {
  const abs = (n: string): string => path.join(verifyDir, n);
  const files: FileMove[] = j.moves.map((m) => ({ from: abs(m.from), to: abs(m.to), ...(m.tmp !== undefined ? { tmp: abs(m.tmp) } : {}) }));
  return j.live ? [...files, { from: liveStatusFile(abs(j.set)), to: liveStatusFile(abs(j.to)) }] : files;
}
/** An interrupted rename undone from its journal `file`, under both status locks: every plan it wrote put back (only
 *  while it holds what the rename wrote), every move undone from whatever state it reached, and the journal removed once
 *  nothing is left a retry could settle. The journal is read again under the locks — `read` came before them, and the
 *  run that wrote it may have finished meanwhile: no journal then is nothing to roll back (`gone`). The journal rolled
 *  back, and what could not be (settle). */
function rollbackJournal(file: string, read: Journal, d: ApplyDirs): { gone: true } | { j: Journal; left: string[]; retry: boolean } {
  const held = lockStatuses([path.join(d.verifyDir, read.set), path.join(d.verifyDir, read.to)]);
  if ("why" in held) return { j: read, left: [held.why], retry: true };
  try {
    if (!exists(file)) return { gone: true };
    const j = readJournal(file);
    if ("why" in j) return { j: read, left: [`${path.basename(file)} is ${j.why} now — run --migrate again`], retry: true };
    if (j.set !== read.set || j.to !== read.to) return { j: read, left: [`${path.basename(file)} names another migration now (${j.set} -> ${j.to}) — run --migrate again`], retry: true };
    const plans = j.plans.flatMap((p) => (p.after === undefined ? [] : [restorePlan({ file: path.join(d.planDir, p.file), before: p.before, after: p.after }, d.cwd)]));
    const { left, retry } = settle(plans, journalMoves(j, d.verifyDir).reverse(), d.link);
    if (!retry) fs.rmSync(file, { force: true });
    return { j, left, retry };
  } finally { for (const l of held.locks) l.release(); }
}

/** Where a step applies: the dirs, and how a file gets its second name. */
interface ApplyDirs { cwd: string; verifyDir: string; planDir: string; link: LinkFn }

/** A thrown value that stands for the process dying (MigrateOpts.crashAt): it passes every catch untouched. */
class Crash extends Error {}

function applyRetire(s: Extract<MigrateStep, { kind: "retire" }>, d: ApplyDirs): { why: string[]; notes: string[] } {
  const base = path.join(d.verifyDir, s.set);
  const held = lockStatuses([base]);
  if ("why" in held) return { why: [held.why], notes: [] };
  try {
    const open = openRunOf(base);
    if (open) return { why: [open], notes: [] };
    const report = setFile(s.set, "report");
    const plans = readPlans(d.planDir, d.cwd);
    const recording = plans.filter((p) => { const r = recordedReport(p.plan); return r !== null && namedFile(r.report, "verification.recorded.report", p.file, d) === report; });
    if (recording.length) return { why: [`${recording.map((p) => p.rel).join(", ")} now record${recording.length === 1 ? "s" : ""} ${report} — re-run verify-screen --compare --record-plan on ${s.canonical}, then --migrate`], notes: [] };
    const byName = nameOnlyBlocks(plans, s.set, s.nodeId, d, freshRefs(d));
    if (byName.length) return { why: byName, notes: [] };
    if (exists(s.file.to)) {
      if (!sameFile(s.file.from, s.file.to)) return { why: [`${path.basename(s.file.to)} already exists — refusing to replace it`], notes: [] };
      // linked, not yet unlinked: a retire killed between its two steps, finished here
      fs.unlinkSync(s.file.from);
      return { why: [], notes: [`${path.basename(s.file.from)} and ${path.basename(s.file.to)} were one file (a retire that was interrupted) — finished`] };
    }
    moveNoReplace(s.file.from, s.file.to, d.link);
    return { why: [], notes: [] };
  } catch (e) {
    return { why: [`retiring failed: ${errMsg(e)}`], notes: [] };
  } finally { for (const l of held.locks) l.release(); }
}

function applyRename(s: Extract<MigrateStep, { kind: "rename" }>, d: ApplyDirs & { postCheck?: MigrateOpts["postCheck"]; crashAt?: MigrateOpts["crashAt"] }): { why: string[]; notes: string[] } {
  const oldBase = path.join(d.verifyDir, s.set), newBase = path.join(d.verifyDir, s.to);
  const held = lockStatuses([oldBase, newBase]);
  if ("why" in held) return { why: [held.why], notes: [] };
  const notes: string[] = [];
  const moved: FileMove[] = []; // every move begun, in order
  const writes: PlanWrite[] = []; // every plan rewritten
  const journal = journalFile(d.verifyDir, s.set);
  let journaled = false;
  const rollback = (): string[] => {
    const { left, retry } = settle(writes.map((w) => restorePlan(w, d.cwd)), [...moved].reverse(), d.link);
    // a rollback a retry may still finish keeps the journal, so the next --apply tries again
    if (journaled && !retry) fs.rmSync(journal, { force: true });
    keepJournal = journaled && retry;
    return left;
  };
  let keepJournal = false;
  const undone = (left: string[]): string => (!left.length ? "every rename undone and every plan restored"
    : keepJournal ? `undone in part (${path.basename(journal)} stays: --migrate --apply tries again)` : "undone in part (see below)");
  const crash = (): void => {
    if (!d.crashAt) return;
    try { d.crashAt({ moved: moved.length, plansWritten: writes.length }); } catch (e) { throw new Crash(errMsg(e)); }
  };
  try {
    // the checks again, now that no status write can land: an open run, a name taken since, the plans as they are now
    const open = openRunOf(oldBase) ?? openRunOf(newBase);
    if (open) return { why: [open], notes };
    const clash = s.files.filter((m) => !exists(m.from) || (exists(m.to) && !sameFile(m.from, m.to)));
    if (clash.length) return { why: [`the verify dir changed since it was read (${clash.map((m) => path.basename(m.from)).join(", ")}) — run --migrate again`], notes };
    if (exists(journal)) return { why: [`${path.basename(journal)} already exists — run --migrate again (it rolls that migration back first)`], notes };
    const plans = readPlans(d.planDir, d.cwd);
    const nameMap = new Map(s.files.map((m) => [path.basename(m.from), path.basename(m.to)] as const));
    const touched = plans.filter((p) => rewriteRefs(p.plan, (ref, field) => { const n = namedFile(ref, field, p.file, d); return n !== null && nameMap.has(n) ? "" : null; }, false).length > 0);
    const refsOf = freshRefs(d);
    const blocks = [...touched.flatMap((p) => planBlocks(p, nameMap, d)), ...nameOnlyBlocks(plans, s.set, s.nodeId, d, refsOf)];
    if (blocks.length) return { why: blocks, notes };
    // every plan whose status reads the set's report must still read it under the new name
    const finders = plansFinding(plans, s.set, d, refsOf).map((f) => f.p);
    const newReportRel = slash(path.relative(d.cwd, setFile(newBase, "report")));
    const hadRecord = new Set(touched.filter((p) => { const r = recordedReport(p.plan); return r !== null && reportRecordNames(r.report, r.sha, d.cwd) !== null; }).map((p) => p.file));

    // the files (a case-only rename through a temp name), and the live status in the run cache when the new name has none
    const moves: FileMove[] = s.files.filter((m) => m.from !== m.to)
      .map((m) => (m.from.toLowerCase() === m.to.toLowerCase() || sameFile(m.from, m.to) ? { ...m, tmp: m.from + tmpSuffix() } : m));
    const liveOld = liveStatusFile(oldBase), liveNew = liveStatusFile(newBase);
    const live = exists(liveOld) && !exists(liveNew);

    // the journal, before the first move: what is about to move, and each plan as it is now
    const jdoc: Journal = {
      schema: JOURNAL_SCHEMA, set: s.set, to: s.to, at: new Date().toISOString(), live,
      moves: moves.map((m) => ({ from: path.basename(m.from), to: path.basename(m.to), ...(m.tmp !== undefined ? { tmp: path.basename(m.tmp) } : {}) })),
      plans: touched.map((p) => ({ file: path.basename(p.file), before: readText(p.file) ?? "" })),
    };
    const saveJournal = (): void => { writeFileAtomic(journal, JSON.stringify(jdoc, null, 2) + "\n", { sync: true }); };
    saveJournal();
    journaled = true;
    if (live) moves.push({ from: liveOld, to: liveNew });
    for (const m of moves) { moved.push(m); doMove(m, d.link); crash(); }

    // the plans: every path naming a moved file, together, under the plan's lock. The bytes replaced and the bytes to be
    // written go into the journal before the write (inside updatePlan, under that lock), so a rollback — now or after a
    // crash — restores a plan only while it holds what this wrote
    touched.forEach((p, i) => {
      const entry = jdoc.plans[i];
      const w: { before?: string; after?: string } = {};
      let fields: RefField[] = [];
      updatePlan(p.file, (raw) => {
        if (raw === null) throw new Error(`${p.rel} disappeared`);
        const plan = parsePlanText(raw, p.rel);
        const hook = plan.verification && plan.verification.hook;
        const restamp = hookHashOf(hook, plan) === "legacy";
        fields = rewriteRefs(plan, (ref, field) => { const n = namedFile(ref, field, p.file, d); const nn = n === null ? undefined : nameMap.get(n); return n !== null && nn !== undefined ? respell(ref, n, nn) : null; }, true);
        if (restamp && hook) hook.planHash = planHash(plan);
        const after = formatPlan(plan, raw);
        w.before = raw;
        w.after = after;
        if (entry) { entry.before = raw; entry.after = after; saveJournal(); }
        return plan;
      });
      if (w.before !== undefined && w.after !== undefined) writes.push({ file: p.file, before: w.before, after: w.after });
      for (const f of HAND_FIELDS.filter((h) => fields.includes(h))) notes.push(`${p.rel}: ${f} is yours (hand-written) — rewritten to the renamed ${f === "verification.artifacts" ? "files" : "report"}`);
      crash();
    });

    // the post-check: every plan written reads as untouched, and a record still names its report
    const problems: string[] = [];
    for (const p of touched) {
      const plan = parsePlanText(fs.readFileSync(p.file, "utf8"), p.rel);
      for (const e of recordedEdits(plan, d.cwd)) problems.push(`${p.rel}: ${e}`);
      const r = recordedReport(plan);
      if (hadRecord.has(p.file) && (r === null || reportRecordNames(r.report, r.sha, d.cwd) === null)) problems.push(`${p.rel}: verification.recorded no longer names its report`);
      if (d.postCheck) for (const x of d.postCheck(p.file, plan)) problems.push(`${p.rel}: ${x}`);
    }
    for (const p of finders) {
      const plan = parsePlanText(fs.readFileSync(p.file, "utf8"), p.rel);
      if (!planStatus(d.cwd).reports(plan, p.file).some((r) => r.rel === newReportRel)) problems.push(`${p.rel}: its status no longer reads ${path.basename(newReportRel)}`);
    }
    if (problems.length) {
      const left = rollback();
      return { why: [`the plans failed the check after the move — ${undone(left)}:`, ...problems.map((x) => `  ${x}`), ...left.map((x) => `  ${x}`)], notes: [] };
    }
    fs.rmSync(journal, { force: true });
    return { why: [], notes };
  } catch (e) {
    if (e instanceof Crash) throw e;
    const left = rollback();
    return { why: [`the move failed (${errMsg(e)}) — ${undone(left)}${left.length ? ":" : ""}`, ...left.map((x) => `  ${x}`)], notes: [] };
  } finally { for (const l of held.locks) l.release(); }
}

/** `verify-screen --migrate [--apply] [--dir design/verify]`, from the project root. */
export function migrateMain(f: { apply?: boolean | undefined; dir?: string | undefined }): number {
  const cwd = process.cwd();
  const verifyDir = path.resolve(cwd, f.dir ?? VERIFY_DIR);
  if (!exists(verifyDir)) { console.error(`--migrate: ${f.dir ?? VERIFY_DIR} does not exist (run from the project root, or pass --dir)`); return 2; }
  const r = migrate({ cwd, verifyDir, apply: !!f.apply });
  return r.skipped.length ? 1 : 0;
}
