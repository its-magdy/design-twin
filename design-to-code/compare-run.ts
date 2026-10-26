// compare-run.ts — what one `verify-screen --compare` reads before compare() runs: the expectation and the measured file,
// the set they belong to, and every fact on disk compare()'s options carry (verify-compare.ts CompareOptions) — the
// measured file's dropped blocks, the --interactions evidence, the artefacts as they are on disk (a set renamed by --migrate
// after its run), the run status, the plan and its code hashes, the coverage baseline and the visual diff's place.
//
// gatherCompareRun returns those inputs and the notes the CLI prints, or the one refusal that stops the run before
// anything is compared or written (exit 2). verify-screen's compareMain is then parse → gather → compare → write → print.
// Which plan is used is plan-binding.ts's (choosePlan, resolvePlan); how the set is opened, verify-sets.ts's (openVerifySet).
//
// Paths: every file is read under the project `root` — a relative one (an argument, an artefact the measured file lists, a
// plan path the expectation recorded) is the project's — and reported as it was spelt. The set itself (where its report
// goes, its run status, its verify dir) is spelt from the expectation's path as given, as the report records it: a caller
// whose cwd is not `root` passes the expectation absolute. The CLI's root is its cwd.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { anyJson, readJson } from "../bridge/src/read-json.ts";
import { loadDocFile } from "./catalog-input.ts";
import { planCodeSkippedNote } from "./content-hash.ts";
import { isInteractionEvidenceList, isMeasuredComponentList, isPlan, isVerifyExpectation, isVerifyMeasured, isVerifyReport, readableMeasured } from "./doc-guards.ts";
import { idlessNote, plansFound } from "./node-artefacts.ts";
import { choosePlan, resolvePlan } from "./plan-binding.ts";
import type { ChosenPlan } from "./plan-binding.ts";
import { reportFreshness } from "./report-freshness.ts";
import { isJsonObject } from "./types.ts";
import type { ArtifactCheck, CodeInputs, InteractionEvidence, MeasuredComponent, Plan, VerifyMeasured, VerifyReport } from "./types.ts";
import type { CompareOptions } from "./verify-compare.ts";
import type { Expectation } from "./verify-shared.ts";
import { readStatusAt, statusFile } from "./verify-run.ts";
import type { VerifyStatusV2 } from "./verify-run.ts";
import { openVerifySet, setFile, underRoot, verifySets } from "./verify-sets.ts";

/** --compare's flags, as parsed. */
export interface CompareRunFlags { out?: string | undefined; interactions?: string | undefined; against?: string | undefined; plan?: string | undefined; recordPlan?: boolean | undefined }

/** One --compare run, gathered: compare()'s inputs, the set its report goes to and the plan --record-plan writes into. */
export interface CompareRun {
  ok: true;
  expectation: Expectation;
  measured: VerifyMeasured;
  options: CompareOptions;
  /** the set the expectation names: `outBase` is where the report goes, `statusBase` its run status's key */
  set: { name: string; outBase: string; statusBase: string };
  /** the plan --record-plan records the report in (null without --record-plan) */
  recordInto: ChosenPlan | null;
  /** what the CLI prints as `note  …`, in order (some are also compare()'s input notes) */
  notes: string[];
}
/** Why the run stops before anything is compared or written (exit 2): `message` is the line(s) to print as they are;
 *  `notes` what was noted before it. */
export interface CompareRunRefusal { ok: false; message: string; notes: string[] }

/** Where an artefact the measured file lists under its set's OLD name is now — `<dir>/<set><rest>` — when the set was
 *  renamed (verify-screen --migrate) after the run that wrote it; else null. Every condition holds or nothing is taken:
 *  the listed file is gone; the run's status (v2) names the set by another name (`screen`, the old one, which no live set
 *  of the dir holds now, in any case); the measured file is that run's (its runId) and the very file the run recorded (its sha); the
 *  listed file was in the set's own dir and carries the old name's prefix (`<old>.` / `<old>-`); the renamed file exists.
 *  Never a screenshot of another set, never one that is not on disk. `listed` is project-relative (under `root`). */
export function migratedArtifact(listed: string, o: { root: string; setName: string; verifyDir: string; status: VerifyStatusV2 | "v1" | null; measuredRun: string | undefined; measuredSha: string }): string | null {
  const at = (p: string): string => underRoot(p, o.root);
  const st = o.status;
  if (fs.existsSync(at(listed)) || st === null || st === "v1" || st.screen === o.setName) return null;
  if (o.measuredRun === undefined || st.runId !== o.measuredRun || st.measuredSha256 !== o.measuredSha) return null;
  if (path.resolve(o.root, path.dirname(listed)) !== path.resolve(o.verifyDir)) return null;
  const base = path.basename(listed);
  if (!base.startsWith(st.screen + ".") && !base.startsWith(st.screen + "-")) return null;
  // in any case: on a case-insensitive disk `garden.*` are `Garden.*` — a live set under the old name in another case owns them
  const old = st.screen.toLowerCase();
  if (verifySets(o.verifyDir).some((n) => n.toLowerCase() === old)) return null;
  // the listed path's own directory spelling, the new name in place of the old
  const candidate = listed.slice(0, listed.length - base.length) + o.setName + base.slice(st.screen.length);
  return fs.existsSync(at(candidate)) ? candidate : null;
}

/** The --interactions file read: the list, the components and the unchecked `inferred` value — or why it is refused. The
 *  object form ({interactions:[…], components:[…], inferred:[…]}, the verifier's evidence.json) may carry any of the lists;
 *  `inferred` is checked row by row in compare (a malformed row is an input note, not a refusal). */
function interactionsOf(file: string, abs: string): { list: InteractionEvidence[]; components: MeasuredComponent[]; inferred: unknown } | { error: string } {
  const r = loadDocFile(file, "interaction evidence", anyJson, "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.", abs);
  if ("error" in r) return { error: `error  ${r.error}` };
  const raw = r.doc;
  const obj = isJsonObject(raw) ? raw : null;
  const list = isInteractionEvidenceList(raw) ? raw : obj && isInteractionEvidenceList(obj.interactions) ? obj.interactions
    : obj && obj.interactions === undefined && (obj.components !== undefined || obj.inferred !== undefined) ? [] : null;
  const comps = obj && obj.components !== undefined ? (isMeasuredComponentList(obj.components) ? obj.components : null) : [];
  if (!list || !comps) return { error: `--interactions ${file}: expected a JSON array or {interactions:[…], components:[…], inferred:[…]}` };
  return { list, components: comps, inferred: obj ? obj.inferred : undefined };
}

/** Everything --compare reads before compare(): `expFile` and `measuredFile` with `flags`, the project at `root`. */
export function gatherCompareRun(expFile: string, measuredFile: string, flags: CompareRunFlags, root: string): CompareRun | CompareRunRefusal {
  const notes: string[] = [];
  const note = (n: string): void => { notes.push(n); };
  const refuse = (message: string): CompareRunRefusal => ({ ok: false, message, notes });
  const at = (p: string): string => underRoot(p, root);
  const sha = (file: string): string => sha256Hex(fs.readFileSync(file));

  const e = loadDocFile(expFile, "expectation", isVerifyExpectation, undefined, at(expFile));
  if ("error" in e) return refuse(`error  ${e.error}`);
  const expectation = e.doc;
  const m = loadDocFile(measuredFile, "probe measurements", anyJson,
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}.", at(measuredFile));
  if ("error" in m) return refuse(`error  ${m.error}`);
  // A malformed OPTIONAL extra (a hand-written `probe: "handmade"`, `notMeasured: {}`) is dropped with a note;
  // only measurements compare cannot read at all are refused.
  const readable = readableMeasured(m.doc);
  if (!readable) return refuse(`error  probe measurements: '${measuredFile}' is not ${isVerifyMeasured.expected}`);
  const measured = readable.doc;
  for (const n of readable.notes) note(`${measuredFile}: ${n}`);
  const evidence = flags.interactions !== undefined && flags.interactions !== "" ? interactionsOf(flags.interactions, at(flags.interactions)) : null;
  if (evidence && "error" in evidence) return refuse(evidence.error);

  // the expectation's set name is the report's: a legacy name, or one of another node than its frame, is refused before
  // anything is compared or written (--migrate renames a legacy set; --expect names the set by its frame). --out defaults
  // to the expectation's own directory, as the probe's does (openVerifySet): the report and its implicit --against
  // baseline are the set's, beside the measured file and the status the probe wrote
  const frameId = expectation.frame && expectation.frame.nodeId;
  const set = openVerifySet(expFile, frameId, flags.out, root);
  if ("error" in set) return refuse(`error  ${set.error}`);
  for (const n of set.notes) note(n);
  const { name: setName, outBase, statusBase } = set;
  // the run status of the set: ONE status base, the expectation's (<its dir>/<set>, statusBaseOf) — the live status in the
  // run cache, else the published <dir>/<set>.status.json — the key every writer of the set's run uses (--status, --wait,
  // verify-probe), wherever the measured file was written. Always looked up: null = looked and found none (a measured file
  // naming its run then has nothing recording it).
  const found = readStatusAt(statusBase);
  const status = found ? { file: found.file === statusFile(statusBase) ? path.basename(found.file) : `${path.basename(found.file)} (live, ${found.file})`, status: found.status, screen: setName } : null;

  // an artefact listed under the set's old name (renamed by --migrate after its run) is read under the new one — only by
  // migratedArtifact's rule, and said so
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : undefined;
  const measuredSha = sha(at(measuredFile));
  const migrated = (listed: string): string | null => migratedArtifact(listed, { root, setName, verifyDir: path.dirname(expFile), status: found ? found.status : null, measuredRun, measuredSha });
  const artifactNotes: string[] = [];
  const movedNote = (listed: string, now: string): void => {
    const n = `${listed} is listed under the set's name before --migrate (run ${measuredRun ?? "?"}) — read as ${now}`;
    artifactNotes.push(n);
    note(n);
  };
  // Artifacts are checked on disk, under the project root, so a report can never cite a screenshot that does not exist.
  const artifactCheck: ArtifactCheck[] = (measured.artifacts || []).map((a) => {
    const listed = typeof a === "string" ? a : a && a.path;
    const moved = listed ? migrated(listed) : null;
    if (listed && moved !== null) movedNote(listed, moved);
    const p = moved ?? listed;
    const exists = !!p && fs.existsSync(at(p));
    return { ...ifDefined("path", p), exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists ? sha(at(p)) : undefined), ...(moved !== null ? { listedAs: listed } : {}) };
  });

  // tie the report to the code it measured — the plan (design/plan/*.json) for this frame lists the files; their content
  // hashes and `git rev-parse HEAD` go into report.inputs.code. The same plan supplies waivers[], descopes[] and foldedInto
  // anchors — found whether or not it lists files.
  const compareNotes: string[] = [];
  let flagged: { file: string; plan: Plan } | undefined;
  if (flags.plan !== undefined) {
    const r = readJson(at(flags.plan), isPlan);
    if (!("doc" in r)) return refuse(`--plan '${flags.plan}' ${r.error}`);
    flagged = { file: flags.plan.split(path.sep).join("/"), plan: r.doc };
  }
  // the same rule --expect used (choosePlan) — never a second way of picking the plan — then the plan --expect read wins
  // over another found now (plan-binding.ts resolvePlan): several plans of the node and none to go by is a data error,
  // BEFORE anything is compared or written
  const chosen = choosePlan(flagged, plansFound(root, frameId), frameId);
  if (chosen.note !== undefined) note(chosen.note);
  const resolved = resolvePlan(expectation, chosen, !!flagged, (file) => readJson(at(file), isPlan));
  if ("error" in resolved) return refuse(`error  ${resolved.error}`);
  const { note: using, ...plan } = resolved;
  if (using !== undefined) { compareNotes.push(using); note(using); }
  const planHit: ChosenPlan | null = plan.now;
  // --record-plan writes into the plan this compare uses — none is a usage error BEFORE anything is compared or written
  if (flags.recordPlan && !planHit) return refuse(`--record-plan: no plan in design/plan/ describes this frame${idlessNote(chosen.idless)} (run from the project root) — pass --plan <plan.json>`);
  // what this compare was computed against (report-freshness.ts stamp): the chosen plan's files[] and every module its
  // anchors/components map (a shared shell) and git HEAD (the waivers/descopes hash is the plan binding's, in compare)
  const stamped = planHit ? reportFreshness(root).stamp(planHit) : undefined;
  let code: CodeInputs | undefined;
  if (planHit && stamped?.code) {
    code = stamped.code;
    // what the code hashes leave out, beside them in the report's input notes
    const skipped = planCodeSkippedNote(planHit.plan, root);
    if (skipped) { compareNotes.push(`${planHit.file}: ${skipped}`); note(`${planHit.file}: ${skipped}`); }
  } else {
    note(planHit ? `${planHit.file} lists no files[] — the report records no code hashes, so verify-build --status cannot tie it to the code`
      : `no plan in design/plan/ describes this frame${idlessNote(chosen.idless)} — the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code`);
  }

  // the report this run is about to overwrite is the coverage baseline — read BEFORE writing. --against names another
  // one. An explicit file that cannot be read is refused; an unreadable implicit one is only noted (it is about to be
  // replaced anyway).
  let against: { file: string; report: VerifyReport } | undefined;
  if (flags.against !== undefined) {
    const r = readJson(at(flags.against), isVerifyReport);
    if (!("doc" in r)) return refuse(`--against '${flags.against}' ${r.error}`);
    against = { file: flags.against, report: r.doc };
  } else {
    const own = setFile(outBase, "report");
    const r = readJson(at(own), isVerifyReport);
    if ("doc" in r) against = { file: own, report: r.doc };
    else if (!r.missing) note(`${own} ${r.error} — no coverage baseline this round (it is about to be overwritten)`);
  }

  // the diff PNG the probe recorded — as recorded, else the same name beside the measured file (a published stage), else
  // under the set's new name (migratedArtifact)
  const vd: unknown = measured.visual && measured.visual.ran ? measured.visual.diff : undefined;
  let visualDiff: { path: string; exists: boolean } | null = null;
  if (typeof vd === "string" && vd) {
    const beside = path.join(path.dirname(measuredFile), path.basename(vd));
    const asRecorded = fs.existsSync(at(vd)), besideIt = fs.existsSync(at(beside));
    const moved = asRecorded || besideIt ? null : migrated(vd);
    if (moved !== null) movedNote(vd, moved);
    visualDiff = asRecorded ? { path: vd, exists: true } : besideIt ? { path: beside.split(path.sep).join("/"), exists: true }
      : moved !== null ? { path: moved, exists: true } : { path: vd, exists: false };
  }

  const inputNotes = [...readable.notes, ...compareNotes, ...artifactNotes];
  const options: CompareOptions = {
    status,
    ...(readable.dropped.includes("behaviour") ? { behaviourMalformed: true } : {}), ...(readable.dropped.includes("visual") ? { visualMalformed: true } : {}),
    ...(visualDiff ? { visualDiff } : {}), ...(inputNotes.length ? { inputNotes } : {}),
    ...(evidence ? { interactions: evidence.list } : {}), ...(evidence && evidence.components.length ? { components: evidence.components } : {}),
    ...(evidence && evidence.inferred !== undefined ? { inferred: evidence.inferred } : {}),
    expectationSha256: sha(at(expFile)), measuredSha256: measuredSha, artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), plan,
  };
  return { ok: true, expectation, measured, options, set: { name: setName, outBase, statusBase }, recordInto: flags.recordPlan ? planHit : null, notes };
}
