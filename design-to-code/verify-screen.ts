// verify-screen.ts — turn "looks right" into a per-node number, and refuse to say "pass" without one.
//
// The live run shipped three verification passes totalling ~42 minutes, all of which returned
// "pass"/"verified", against a build where an independent measurement pass then found ~35% of sampled
// values wrong. Not rounding — real errors: a heading rendered at the page-title style
// instead of its own, an empty-state body at 16px/#d4d4d4 where the export says 14px/#a0a0a0, a status
// chip with its fill token never applied, a modal at radius 20 against a spec of 12, and two toolbar
// components never built at all. The verifiers compared screenshots and structure; nothing compared
// the numbers, so anything wrong-but-plausible passed.
//
// The root causes were all mechanical, and so are the fixes here:
//
//   (a) The spec was PARAPHRASED. The builder's own EmptyState.tsx comment asserted "heading 20/Semi
//       Bold, subtitle 16/Regular" — which contradicts the export — and that comment is presumably
//       how the bug got written. So `--expect` emits the spec as DATA, read straight off the node
//       tree. Nobody retypes a number that a file already holds.
//   (b) There was no per-node comparison at all. `--compare` diffs measured computed styles against
//       that spec, field by field, with an explicit tolerance per field.
//   (c) Verdicts were prose in a chat hand-back, so nothing could be audited or re-run.
//       Every run writes <screen>.report.json, and `pass` is computed from it, never asserted.
//   (d) Coverage and interactions were never checked. A screen can match every
//       pixel and still be a dead mockup with two components missing.
//
// Two commands, one CLI. What they must agree on (tolerances, fields, measured keys, schemas) is defined once in
// verify-shared.ts so the expectation format and the comparison never drift; the expectation is built in verify-expect.ts,
// compared in verify-compare.ts and rendered in verify-report-md.ts. This file reads the inputs, writes the artefacts and
// routes the modes:
//   node verify-screen.js --expect  <screen.json>... [--out design/verify]
//   node verify-screen.js --compare <Layer>__<id>.expected.json <measured.json> [--interactions <file>] [--out design/verify]
// --out is the verify directory; the set's name is its node's (`<Layer>__<id>`, verify-sets.ts), never the caller's.
//
// There is NO browser here. `--compare` diffs two JSON files; the rendering, measuring and
// interaction-driving are the probe's job (the visual-verifier agent, or any script), and what it did
// arrives as measured.json (+ an optional --interactions file). Anything the probe did not measure is
// reported as not measured / not probed — never as passed, and never as failed.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { fileHashes, gitHead, planCodeFiles, planCodeSkippedNote } from "./content-hash.ts";
import { parsePlanText, recordPlan, reportFileText, updatePlan } from "./plan-record.ts";
import { readDocFile, readJsonFile } from "./catalog-input.ts";
import {
  isInteractionEvidenceList, isMeasuredComponentList, isPageIndex, isPagesRootIndex, isPlan, isVerifyExpectation, isVerifyMeasured, isVerifyReport,
  readableMeasured,
} from "./doc-guards.ts";
import { isPassingVerdict, waiversHash } from "./plan-waivers.ts";
import { STATUS_PHASES, TERMINAL_PHASES, openRunSets, readStatusAt, statusFile, statusMain, waitMain } from "./verify-run.ts";
import type { VerifyStatusV2 } from "./verify-run.ts";
import { writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import type { ArtifactCheck, CodeInputs, IndexRow, InteractionEvidence, JsonValue, MeasuredComponent, Plan, PlanWaiver, ScreenDoc, VerifyDelta, VerifyReport } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { errMsg } from "../bridge/src/errmsg.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { EXPORT_DIR, PLAN_DIR, VERIFY_DIR, listPlans } from "../bridge/src/project-layout.ts";
import { nodeIdFromStem } from "../bridge/src/pages-layout.ts";
import { TEXT_BOX_HEIGHT, fmt, resolveInside, samePlanFile, scaleText } from "./verify-shared.ts";
import type { ChosenPlan } from "./verify-shared.ts";
import { buildExpectation } from "./verify-expect.ts";
import type { ExpectInput, ExpectOptions } from "./verify-expect.ts";
import { compare } from "./verify-compare.ts";
import { probeLine, reportToMarkdown } from "./verify-report-md.ts";
import { migrateMain } from "./verify-migrate.ts";
import { expectationSetProblem, formatSetName, nodeIdFromSetName, nodeStem, outBaseOf, setNameOfFile, statusBaseOf, variantOverlap, variantProblem, variantsOf, verifySets } from "./verify-sets.ts";

// what the last verify run of <base> says about the artefacts beside an expectation — for --expect's notes.
// failed/blocked: its measured/report files are partial (a probe's own run that failed recorded no measured file); a non-terminal phase older than --wait's stall (300 s): it never
// finished; younger: a run is measuring right now; v1: a hand-written status, not checked. done (or none): nothing to say.
const STATUS_STALL_MS = 300_000;
function runStatusNote(base: string, now = Date.now()): string | null {
  const found = readStatusAt(base);
  if (!found) return null;
  const st = found.status, name = path.basename(base);
  if (st === "v1") return `${found.file} is a hand-written status (no run id) — not checked`;
  const detail = st.detail ? ` (${st.detail})` : "";
  // a probe's own run (no --run) that failed recorded no measured file (its record is the `done` write)
  if (st.phase === "failed" && st.ownRun) return `the last run of ${name} (run ${st.runId}) was a probe's own run (no --run) that ended failed${detail} — it recorded no measured file; ` +
    `this expectation is safe to re-measure against`;
  if (st.phase === "failed" || st.phase === "blocked") return `the last run of ${name} (run ${st.runId}) ended at phase ${st.phase}${detail} — its measured/report files are partial; ` +
    `this expectation is safe to re-measure against`;
  if (TERMINAL_PHASES.includes(st.phase)) return null;
  const age = now - Date.parse(st.at);
  if (Number.isFinite(age) && age >= STATUS_STALL_MS) return `the last run of ${name} (run ${st.runId}) never finished — still at phase ${st.phase}${detail}, ${Math.round(age / 1000)} s ago; ` +
    `its measured/report files are partial`;
  return `a run of ${name} (run ${st.runId}) is in progress — phase ${st.phase}${detail}${Number.isFinite(age) ? `, ${Math.round(age / 1000)} s ago` : ""}; it measures against the expectation it started with`;
}

// a replaced expectation's previous bytes, one generation (overwritten). Never `*.expected.json`, so nothing that
// reads a verify dir's sets (verify-sets.ts, verify-build's report lookup, the run's expectation) takes it for a live one.
const PREV_EXPECTED_SUFFIX = ".expected.prev.json";

/** The verify directory --expect names the node's stem in (nodeStem) before the set's name is known: --out when it is
 *  an existing directory, ends in a separator or is design/verify; the parent of the older `<dir>/<set>` spelling;
 *  design/verify without --out. outBaseOf then decides, by the set's name, whether --out is taken at all. */
function expectDirOf(out: string | undefined): string {
  if (out === undefined) return VERIFY_DIR;
  let dir = false;
  try { dir = fs.statSync(out).isDirectory(); } catch { /* not there */ }
  if (dir || path.resolve(out) === path.resolve(VERIFY_DIR)) return out;
  if (/[\\/]$/.test(out)) return out.replace(/[\\/]+$/, "") || out;
  return path.dirname(out);
}

/** Where an artefact the measured file lists under its set's OLD name is now — `<dir>/<set><rest>` — when the set was
 *  renamed (verify-screen --migrate) after the run that wrote it; else null. Every condition holds or nothing is taken:
 *  the listed file is gone; the run's status (v2) names the set by another name (`screen`, the old one, which no live set
 *  of the dir holds now, in any case); the measured file is that run's (its runId) and the very file the run recorded (its sha); the
 *  listed file was in the set's own dir and carries the old name's prefix (`<old>.` / `<old>-`); the renamed file exists.
 *  Never a screenshot of another set, never one that is not on disk. */
function migratedArtifact(listed: string, o: { setName: string; verifyDir: string; status: VerifyStatusV2 | "v1" | null; measuredRun: string | undefined; measuredSha: string }): string | null {
  const st = o.status;
  if (fs.existsSync(listed) || st === null || st === "v1" || st.screen === o.setName) return null;
  if (o.measuredRun === undefined || st.runId !== o.measuredRun || st.measuredSha256 !== o.measuredSha) return null;
  if (path.resolve(path.dirname(listed)) !== path.resolve(o.verifyDir)) return null;
  const base = path.basename(listed);
  if (!base.startsWith(st.screen + ".") && !base.startsWith(st.screen + "-")) return null;
  // in any case: on a case-insensitive disk `garden.*` are `Garden.*` — a live set under the old name in another case owns them
  const old = st.screen.toLowerCase();
  if (verifySets(o.verifyDir).some((n) => n.toLowerCase() === old)) return null;
  // the listed path's own directory spelling, the new name in place of the old
  const candidate = listed.slice(0, listed.length - base.length) + o.setName + base.slice(st.screen.length);
  return fs.existsSync(candidate) ? candidate : null;
}

// The plans under design/plan/ (relative to the working directory) of node `nodeId`, by node id only: a plan's `nodeId`,
// else (none given) the id its `<Layer>__<id>` file name carries — never its screen or file name (a name is no identity,
// and `nodeId` wins when the two disagree). `idless`: the plans that name no node either way (none of them can be
// matched — each one says to add "nodeId").
function plansForNode(nodeId: string | undefined): { hits: Array<{ file: string; plan: Plan }>; idless: string[] } {
  const hits: Array<{ file: string; plan: Plan }> = [];
  const idless: string[] = [];
  for (const f of listPlans(PLAN_DIR)) {
    // a plan under design/plan/ (plan-skeleton.ts); one that is not a readable plan describes nothing
    const p = readJsonOrNull(path.join(PLAN_DIR, f), isPlan);
    if (!p) continue;
    const file = path.join(PLAN_DIR, f).split(path.sep).join("/");
    const id = p.nodeId || nodeIdFromStem(path.basename(f, ".json"));
    if (!id) idless.push(file);
    else if (nodeId !== undefined && id === nodeId) hits.push({ file, plan: p });
  }
  return { hits, idless };
}
/** What the "no plan describes this frame" note adds about the plans that name no node. */
const idlessNote = (idless: string[]): string => idless.length ? ` (${idless.join(", ")} name${idless.length === 1 ? "s" : ""} no node — add "nodeId")` : "";

/** ONE plan-selection rule for --expect and --compare (they must pick the same plan, or the plan's interactions[] hash can
 *  never agree and the run stays incomplete): --plan (the other plans of the node named in `note`); else the one plan
 *  in design/plan/ of the frame's node (plansForNode); several are a data error (`error`: keep one, or pass --plan — a
 *  multi-frame plan); none is no plan. */
function choosePlan(flagged: { file: string; plan: Plan } | undefined, frameId: string | undefined):
  { hit?: ChosenPlan; all: Array<{ file: string; plan: Plan }>; idless: string[]; note?: string; error?: string } {
  const { hits: all, idless } = plansForNode(frameId);
  if (flagged) {
    const others = all.filter((h) => !samePlanFile(h.file, flagged.file));
    return { hit: { ...flagged, choice: "flag" }, all, idless, ...(others.length ? { note: `using ${flagged.file} (--plan); design/plan/ also describes node ${frameId ?? "?"} in ${others.map((h) => h.file).join(", ")}` } : {}) };
  }
  if (all.length === 1 && all[0]) return { hit: { ...all[0], choice: "only" }, all, idless };
  if (all.length > 1) return { all, idless, error: `${all.length} plans in design/plan/ describe node ${frameId ?? "?"} (${all.map((h) => h.file).join(", ")}) — keep one, or pass --plan <plan.json> (a multi-frame plan)` };
  return { all, idless };
}

/** --accept's selection: the report deltas one waiver row each is written for, or why there are none. */
function selectForAccept(rep: VerifyReport, sel: { node?: string | undefined; field?: string | undefined; group?: string | undefined }): { deltas: VerifyDelta[] } | { error: string } {
  // a report whose run failed its integrity checks graded numbers nothing ties to this design and run — a
  // waiver written from it would bind to values that may never have been rendered
  // the integrity reasons compare recorded (report.integrity, [] for a clean run); a report without the field cannot
  // show its run was verified, so nothing in it is accepted
  const integrity = rep.integrity;
  if (!Array.isArray(integrity)) return { error: "the report records no integrity[] — nothing says whether its run was verified; re-run --compare, then accept against the new report" };
  if (integrity.length) return { error: `the report's run is unverified (${integrity.join("; ")}) — nothing in it can be accepted; re-measure and --compare, then accept against the new report` };
  const deltas: VerifyDelta[] = Array.isArray(rep.deltas) ? rep.deltas : [];
  const picked = sel.group !== undefined ? deltas.filter((d) => d.group === sel.group)
    : deltas.filter((d) => d.nodeId === sel.node && (sel.field === undefined || d.field === sel.field));
  if (picked.length) return { deltas: picked };
  if (sel.group !== undefined) {
    const gs = [...new Set(deltas.map((d) => d.group).filter((g): g is string => !!g))];
    return { error: `no delta in the report belongs to group '${sel.group}'${gs.length ? ` (groups: ${gs.join(", ")})` : " (the report has no groups)"}` };
  }
  const id = sel.node;
  // Not a delta = not waivable: say which kind of item it is instead.
  if ((rep.componentsAbsent || []).some((c) => c.nodeIds.includes(String(id)))) return { error: `${id} belongs to a component set reported ABSENT — a missing component is never waivable; build it` };
  if ((rep.interactions || []).some((i) => i.nodeId === id && i.result === "fail")) return { error: `${id} is a failed interaction — never waivable; fix it, or have the owner descope it in plan.descopes` };
  if ((rep.notMeasured || []).some((n) => n.nodeId === id)) return { error: `${id} was not measured — there is no delta to accept; measure it (or fold it, plan anchor foldedInto) first` };
  if (sel.field !== undefined && (rep.fieldsNotMeasured || []).some((n) => n.nodeId === id && n.field === sel.field)) return { error: `${id} (${sel.field}) was not measured — there is no delta to accept` };
  const fields = deltas.filter((d) => d.nodeId === id).map((d) => d.field);
  return { error: `no delta in the report for ${id}${sel.field !== undefined ? ` field '${sel.field}'` : ""}${fields.length ? ` (its deltas: ${fields.join(", ")})` : ""}` };
}

export { selectForAccept };

// ---------------------------------------------------------------- CLI
function main(argv: string[]): number | Promise<number> {
  const USAGE =
    "usage:\n" +
    `  ${scriptCmd("verify-screen")} --expect <screen.json>... [--out design/verify] [--variant <slug>] [--plan <plan.json>]\n` +
    "      writes <Layer>__<id>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      The plan for this frame (--plan, else the one plan in design/plan/ that describes it) adds its interactions[]\n" +
    "      ({nodeId, trigger, expect: dialog|url|selector:<css>, destinationId?}) the export cannot carry; a row that cannot\n" +
    "      be graded is dropped with why. Their hash binds the expectation: change them → re-run --expect.\n" +
    "      Read them; never retype them. --out is the verify directory (default design/verify; a new one ends in \"/\"): the set is\n" +
    "      named by the frame's node, <Layer>__<id> — the name a set of that node there already has (a frame renamed in Figma keeps\n" +
    "      it). Any other --out basename is refused (exit 2): one node, one set. --variant <slug> writes the variant set\n" +
    "      <Layer>__<id>.<slug> instead (a dark theme, a narrow width): lower-case letters and digits, words joined by single \"-\",\n" +
    "      at most 32; a file tail of the set is no slug, nor one that extends another variant of the node by \"-\" (exit 2).\n" +
    "      Replacing one that differs keeps the old bytes as\n" +
    "      <Layer>__<id>.expected.prev.json (one generation) and says why: the export changed, or verify-screen did (same export\n" +
    "      content). It notes a last run of <Layer>__<id> that failed, was blocked or never finished (its files are partial).\n" +
    `  ${scriptCmd("verify-screen")} --compare <Layer>__<id>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] [--plan <plan.json>] [--record-plan] [--out design/verify]\n` +
    "      writes <Layer>__<id>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares\n" +
    "      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n" +
    "      (a JSON array, or {interactions:[…], components:[…], inferred:[…]}, of {nodeId, trigger, ok, selector, selectorCount, detail};\n" +
    "      components[] rows {setName|nodeId, present} are merged with measured.json's; inferred[] rows {nodeId?, state, built, why?}\n" +
    "      — what the build does that the design never drew — are listed under 'Inferred, not designed', never graded).\n" +
    "      --out is the verify directory (default design/verify); the report takes the expectation's set name. A legacy-named\n" +
    "      expectation, or one named for another node than its frame, is refused (exit 2: verify-screen --migrate / re-run --expect).\n" +
    "      Coverage is compared with the report this run overwrites (or --against <report.json>): a drop in nodes\n" +
    "      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.\n" +
    "      Integrity first: a measured file naming no or another expectation, or a run status not finished / naming another\n" +
    "      measured file, makes the verdict 'incomplete' even with high mismatches (the numbers belong to an unverified run).\n" +
    "      The plan for this frame (--plan <plan.json>; else the plan file --expect merged interactions from, while it exists;\n" +
    "      else design/plan/ as at --expect) supplies waivers[] and descopes[]: an accepted\n" +
    "      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).\n" +
    "      --record-plan: then writes that plan's verification.recorded from the report, whole — report sha, verdict,\n" +
    "      counts, mode, renderer, artifacts, open high/medium deltas, a11y; hand keys (coverage, notes) stay. Of the\n" +
    "      record's keys at verification's top level (an older record, a hand-written plan), one the new record holds is\n" +
    "      removed (the record has its own, from the report); one it lacks stays — an a11y, or the reason of a static-only\n" +
    "      or the renderer of a rendered report that gives none.\n" +
    "      No plan, or several and no --plan: exit 2 before comparing. A failed record — e.g. a report outside the project\n" +
    "      (the plan records project-relative paths only) — leaves the report written (exit 1).\n" +
    `  ${scriptCmd("verify-screen")} --accept <Layer>__<id>.report.json (--node <id> (--field <label> | --all-fields) | --group <gid>) --reason "<why>" --by "<who>" [--plan <plan.json>]\n` +
    "      writes one plan waiver per node + field from the report's delta(s), bound to the export content, the designed\n" +
    "      and the built value (any change reopens it). Only on the owner's explicit word. Refuses a node with no delta:\n" +
    "      absent components, failed interactions and unmeasured nodes are never waivable. Refuses a report whose run is\n" +
    "      unverified (its integrity[]), or that records no integrity[] (re-run --compare first). Re-run --compare to apply.\n" +
    `  ${scriptCmd("verify-screen")} --status <Layer>__<id> --phase <${STATUS_PHASES.join("|")}> [--run <id> | --new-run] [--detail "…"] [--by agent|orchestrator] [--dir design/verify] [--publish <stageDir>]\n` +
    "      writes the run's LIVE status (status v2: runId, rev, machine time) atomically in the run cache —\n" +
    "      node_modules/.cache/designtwin-verify/<Layer>__<id>.status.json (the project's: the nearest package.json at or above <dir>, or the\n" +
    "      workspace root its dependencies are hoisted to, never past .git; the OS temp dir, not shared between sandboxed and unsandboxed\n" +
    "      commands, with no package.json or Yarn PnP) — <dir> resolves against the cwd — outside every dev-server\n" +
    "      watch, so a heartbeat never reloads the page being measured — and prints `run <id> rev <n>` (stdout), the live file and the run's\n" +
    "      stage dir (stderr). A run that has ended (done/failed/blocked) takes no more writes, with or without --run (exit 2: start a --new-run),\n" +
    "      and without --new-run nothing is written while ANOTHER run is open (exit 2: wait for it or end it; a probe's own run is named as\n" +
    "      one — when and by which pid it started, whether that probe is gone or past its deadline — with only the command that ends\n" +
    "      it). Over another run that has ended it is written and says so: a `note  run <id> replaced run <other> …` line, and\n" +
    "      replaced {runId, phase, at} in the status (carried through the run, kept in the published copy). `done` checks first — refuses (exit 1)\n" +
    "      a missing measured file (the staged one when --publish holds it), one measured against another expectation, in another run, or\n" +
    "      not the one the probe recorded in this run — then publishes, records the sha256 of <Layer>__<id>.expected/.measured.json (and\n" +
    "      .evidence.json when this run published it), and writes the final status into <dir>/<Layer>__<id>.status.json. --publish copies every\n" +
    "      file of a staging directory into <dir> (tmp file in <dir>, then rename) — stage in the run cache while any page of the app is open.\n" +
    `  ${scriptCmd("verify-screen")} --wait <Layer>__<id> --run <id> [--timeout <s>=1200] [--stall <s>=300] [--interval <s>=2] [--dir design/verify]\n` +
    "      waits (on the live status, else <dir>/<Layer>__<id>.status.json) until run <id> is done and <Layer>__<id>.measured.json (and the\n" +
    "      evidence this run published) is the file it names, then prints the --compare command (exit 0; with --interactions only for evidence this run published);\n" +
    "      exit 1 when the run failed or is blocked (prints why), 5 on timeout or when the status did not change for --stall seconds,\n" +
    "      6 when the run cache exists but cannot be read.\n" +
    `  ${scriptCmd("verify-screen")} --migrate [--apply] [--dir design/verify]\n` +
    "      renames each legacy-named verify set (a nickname, <Screen>@320, <Screen>-r1) to its screen's key <Layer>__<id> — a variant of\n" +
    "      it to <Layer>__<id>.<slug> — with every file of the set (the live status too), and rewrites the paths a plan's\n" +
    "      verification.recorded (report, a11y.report, artifacts), verification.a11y.report and verification.artifacts name.\n" +
    "      A dry run unless --apply. A legacy set whose node already has its <Layer>__<id> set has its expectation retired\n" +
    "      (<S>.expected.json.retired; its other files stay under <S>).\n" +
    "      Skips a set (says why) whose node is unknown or ambiguous, with an open run, whose new name is taken, or that a plan\n" +
    "      records with a hand-edited record or finds by its name alone with no node id of the set's (add \"nodeId\" to it).\n" +
    "      Never rewrites a report, measured file or expectation; plans are never renamed.\n" +
    "      A run that dies part way leaves design/verify/.migrate-<S>.json (its journal): the next --migrate reports it and does\n" +
    "      nothing else; --migrate --apply rolls it back first (files to their old names, each plan it rewrote to its old bytes\n" +
    "      unless written again since), then migrates.\n" +
    "exit (--status): 0 wrote · 1 refused · 2 usage · 6 the run cache is not writable (sandbox write scope? — run from the project root).\n" +
    "exit (--migrate): 0 nothing skipped · 1 a set skipped or refused, or an interrupted migration awaits its rollback (a dry run,\n" +
    "      or --apply whose rollback could not finish) · 2 usage.";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); return argv.length ? 0 : 2; }

  const OPTIONS = {
    out: { type: "string" }, interactions: { type: "string" }, against: { type: "string" }, force: { type: "boolean" }, expect: { type: "boolean" }, compare: { type: "boolean" }, variant: { type: "string" },
    accept: { type: "boolean" }, node: { type: "string" }, field: { type: "string" }, group: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, plan: { type: "string" },
      "all-fields": { type: "boolean" },
    status: { type: "string" }, wait: { type: "string" }, phase: { type: "string" }, run: { type: "string" }, "new-run": { type: "boolean" }, detail: { type: "string" },
    dir: { type: "string" }, publish: { type: "string" }, timeout: { type: "string" }, stall: { type: "string" }, interval: { type: "string" },
    "record-plan": { type: "boolean" }, migrate: { type: "boolean" }, apply: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  // (still parsed, so a caller that passes it is told why rather than "unknown option")
  if (flags.force !== undefined) {
    console.error("--force is gone: one node, one set — a second set of the node is a variant (--expect --variant <slug>); a legacy-named set: verify-screen --migrate\n" + USAGE);
    return 2;
  }
  // --migrate renames legacy-named verify sets (verify-migrate.ts); it takes --apply and --dir only
  if (flags.migrate) {
    const other = Object.entries(flags).filter(([k, v]) => v !== undefined && !["migrate", "apply", "dir"].includes(k)).map(([k]) => k);
    if (other.length || files.length) { console.error(`--migrate takes none of ${[...other.map((k) => `--${k}`), ...files].join(", ")}\n` + USAGE); return 2; }
    return migrateMain({ apply: flags.apply, dir: flags.dir });
  }
  if (flags.apply !== undefined) { console.error("--apply only applies to --migrate\n" + USAGE); return 2; }
  // the run's status file and the wait on it — the tools write machine time, rev and shas, never the agent
  const runFlags = ["phase", "run", "new-run", "detail", "dir", "publish", "timeout", "stall", "interval"] as const;
  if (flags.status !== undefined || flags.wait !== undefined) {
    if (flags.status !== undefined && flags.wait !== undefined) { console.error("pass --status or --wait, not both\n" + USAGE); return 2; }
    const other = (["expect", "compare", "accept", "out", "interactions", "against", "variant", "node", "field", "group", "reason", "plan", "all-fields", "record-plan"] as const).filter((k) => flags[k] !== undefined);
    if (other.length || files.length) { console.error(`--${flags.status !== undefined ? "status" : "wait"} takes none of ${[...other.map((k) => `--${k}`), ...files].join(", ")}\n` + USAGE); return 2; }
    if (flags.wait !== undefined) {
      const bad = (["phase", "new-run", "detail", "publish", "by"] as const).filter((k) => flags[k] !== undefined);
      if (bad.length) { console.error(`--wait takes none of ${bad.map((k) => `--${k}`).join(", ")}\n` + USAGE); return 2; }
      return waitMain(flags.wait, flags, USAGE);
    }
    const bad = (["timeout", "stall", "interval"] as const).filter((k) => flags[k] !== undefined);
    if (bad.length) { console.error(`--status takes none of ${bad.map((k) => `--${k}`).join(", ")}\n` + USAGE); return 2; }
    return statusMain(flags.status, flags, USAGE);
  }
  for (const k of runFlags) if (flags[k] !== undefined) { console.error(`--${k} only applies to --status / --wait\n` + USAGE); return 2; }
  const { interactions: interactionsFile, against: againstFile } = flags;
  const doExpect = !!flags.expect, doCompare = !!flags.compare, doAccept = !!flags.accept;
  if ([doExpect, doCompare, doAccept].filter(Boolean).length !== 1) { console.error("pass exactly one of --expect / --compare / --accept\n" + USAGE); return 2; }
  for (const k of ["node", "field", "group", "reason", "by", "all-fields"] as const) if (flags[k] !== undefined && !doAccept) { console.error(`--${k} only applies to --accept\n` + USAGE); return 2; }
  // a variant is named once, when its expectation is written: --compare, the probe and --status read it from the set's name
  if (flags.variant !== undefined && !doExpect) { console.error("--variant only applies to --expect (the set's name carries it after that)\n" + USAGE); return 2; }
  if (doAccept) return acceptMain(files, flags, USAGE);
  if (interactionsFile !== undefined && !doCompare) { console.error("--interactions only applies to --compare\n" + USAGE); return 2; }
  if (againstFile !== undefined && !doCompare) { console.error("--against only applies to --compare\n" + USAGE); return 2; }
  const recordPlanFlag = !!flags["record-plan"];
  if (recordPlanFlag && !doCompare) { console.error("--record-plan only applies to --compare\n" + USAGE); return 2; }
  if (doExpect) return expectMain(files, flags, USAGE);
  return compareMain(files, flags, USAGE);
}

/** The CLI's output: the expectation (--expect) or the report and its .md (--compare) beside `base`, atomically; no base = stdout. */
function write(doExpect: boolean, base: string | undefined, obj: unknown, md?: string): void {
  if (!base) { process.stdout.write(reportFileText(obj)); return; }
  // atomic (tmp beside the target, then rename) — a reader never sees half a report or expectation. The report's text is
  // the one --record-plan hashes (plan-record.ts reportFileText).
  writeFileAtomic(base + (doExpect ? ".expected.json" : ".report.json"), reportFileText(obj));
  if (md) writeFileAtomic(base + ".report.md", md);
  console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md ? " and " + base + ".report.md" : ""}`);
}

/** `--expect <screen.json>... [--out <dir>] [--variant <slug>] [--plan <plan.json>]`: writes <dir>/<Layer>__<id>[.<slug>].expected.json
 *  (buildExpectation) — the set named by the frame's node, never by the caller — says what it replaced, and notes the last run beside it. */
function expectMain(files: string[], flags: { out?: string | undefined; plan?: string | undefined; variant?: string | undefined }, USAGE: string): number {
  const { out, plan: planFlag, variant } = flags;
  const firstFile = files[0];
  if (firstFile === undefined) { console.error("--expect needs at least one screen export\n" + USAGE); return 2; }
  const slugWhy = variant === undefined ? null : variantProblem(variant);
  if (slugWhy !== null) { console.error(`error  --variant: ${slugWhy}`); return 2; }
  const docs: ExpectInput[] = files.map((f) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json") }));
  // the export's own index (relative to the project root) tells which destinations were exported
  const indexFile = path.join(EXPORT_DIR, "pages", "index.json");
  const idx = readJson(indexFile, isPagesRootIndex);
  if (!("doc" in idx) && !idx.missing) console.error(`note  ${indexFile} ${idx.error} — interaction destinations are checked against the given export(s) only`);
  // The root index is REPLACED by a page walk (only single-screen pulls merge into it), so the frames an earlier
  // walk exported live on only in their page's own pages/<dir>/index.json: read every one on disk too, or a
  // destination exported by the first walk reads as "never exported" after the second.
  const pagesDir = path.join(EXPORT_DIR, "pages");
  const pageRows: IndexRow[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(pagesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* no pages dir */ }
  for (const d of dirs) {
    const pi = readJson(path.join(pagesDir, d, "index.json"), isPageIndex);
    if ("doc" in pi) pageRows.push(...pi.doc.layers);
  }
  const rootRows: IndexRow[] = "doc" in idx ? idx.doc.layers || [] : [];
  const seen = new Set(rootRows.map((l) => `${l.id}\u0000${l.sourceFile ?? ""}`));
  const layers = [...rootRows, ...pageRows.filter((l) => !seen.has(`${l.id}\u0000${l.sourceFile ?? ""}`))];
  // (rows only: the root index's own top-level sourceFile names its last walk, not the page-dir rows merged in)
  // sibling screen exports (aliases for a shared shell's nodes) — read lazily, only the same file's rows
  const exportRoot = EXPORT_DIR;
  const readSibling = (file: string): ScreenDoc | null => readJsonOrNull(path.join(exportRoot, file), isScreenDoc);
  // the plan's interactions[] — the plan --compare will pick too (choosePlan)
  let flagged: { file: string; plan: Plan } | undefined;
  if (planFlag !== undefined) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
    flagged = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
  }
  // the plan is merged INTO the expectation, so it is chosen by the node buildExpectation records as frame.nodeId (its
  // frames[0]: the first root of the first export that has one)
  const firstRoot = docs.map((d) => screenRoots(d.doc)[0]).find((r) => r !== undefined);
  const chosen = choosePlan(flagged, firstRoot && firstRoot.id);
  // several plans of the node: which one's interactions bind the expectation is not ours to guess (--compare would face the same)
  if (chosen.error !== undefined) { console.error(`error  ${chosen.error}`); return 2; }
  if (chosen.note !== undefined) console.error(`note  ${chosen.note}`);
  const planForExpect = chosen.hit;
  // the reference PNG (pointer relative to design/export/) and the document's colour profile stamp
  const readReference = (pointer: string): Uint8Array | null => {
    const file = resolveInside(exportRoot, pointer);
    if (file === null) return null; // (referenceImageFor refuses such a pointer before reading)
    try { return fs.readFileSync(file); } catch { return null; }
  };
  const ds = readJsonOrNull(path.join(exportRoot, "design-system.json"), isJsonObject);
  const colorProfile = ds && typeof ds.colorProfile === "string" ? ds.colorProfile : null;
  const expOpts: ExpectOptions = { ...("doc" in idx || layers.length ? { index: { layers }, readSibling } : {}), ...(planForExpect ? { plan: planForExpect } : {}), readReference, colorProfile };
  const exp = buildExpectation(docs, Object.keys(expOpts).length ? expOpts : null);
  const pi = exp.planInteractions;
  if (pi) {
    console.error(`${pi.plan}: ${pi.merged} plan interaction(s) merged${pi.dropped.length ? `, ${pi.dropped.length} dropped` : ""} (plan interactions sha256 ${pi.sha256.slice(0, 12)}…)`);
    for (const d of pi.dropped) console.error(`warn  plan interaction ${d.nodeId} dropped: ${d.why}`);
  }
  // the set's name is its node's: <Layer>__<id> — the stem a set of the node in the verify dir already has, or a run of it
  // open in the run cache (fixed: a frame renamed in Figma keeps it), else the indexed layer name's (the frame's own without an index). Never the input file's
  // basename or a name the caller typed: two names for one node would be two artefact sets.
  const nodeId = exp.frame.nodeId;
  if (!nodeId) { console.error(`error  the export's frame has no node id — its set cannot be named; re-pull the screen`); return 2; }
  const layerName = layers.find((l) => l.id === nodeId)?.name ?? exp.frame.name ?? "";
  const kDir = expectDirOf(out);
  const k = nodeStem(kDir, nodeId, layerName, openRunSets(kDir));
  if ("why" in k) { console.error(`error  ${k.why}`); return 2; }
  const setName = formatSetName(k.stem, variant);
  const ob = outBaseOf(out, setName, VERIFY_DIR);
  if ("error" in ob) { console.error(`error  ${ob.error}`); return 2; }
  // a slug that extends another live variant of the node by "-" (or that one extends) would share files with it (variantOverlap)
  if (variant !== undefined) {
    const clash = variantOverlap(variant, variantsOf(ob.dir, k.stem));
    if (clash !== null) { console.error(`error  --variant ${variant} overlaps the variant ${k.stem}.${clash} of node ${nodeId} by "-": <set>-<state>.png of one names a screenshot of the other — pick a slug that neither extends`); return 2; }
  }
  if (ob.deprecated) console.error(`note  --out ${out} names the set: pass the directory ${ob.dir}`);
  if (k.legacy.length) console.error(`note  legacy-named verify set(s) ${k.legacy.join(", ")} of node ${nodeId} — verify-screen --migrate renames them to ${k.stem}`);
  const outBase = ob.base;
  // Re-running --expect replaces the file in place and leaves a measurement and a report from the
  // PREVIOUS expectation beside it, undated. The file itself stays byte-deterministic —
  // the notice goes to stderr, and every report records the sha it was computed on.
  const target = outBase + ".expected.json";
  const next = JSON.stringify(exp, null, 2) + "\n";
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  const h = sha256Hex(next);
  let prevContent: JsonValue | undefined = null;
  try { if (prev !== null) { const prevDoc: unknown = JSON.parse(prev); prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null; } } catch { /* unreadable */ }
  const onlyExportedAt = prev !== null && prev !== next && !!prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "");
  // a REPLACED expectation keeps its previous bytes (one generation) — written before the new one
  const prevFile = outBase + PREV_EXPECTED_SUFFIX;
  if (prev !== null && prev !== next && !onlyExportedAt) writeFileAtomic(prevFile, prev);
  write(true, outBase, exp);
  // what the last run beside this expectation says (failed/blocked, never finished, in progress, hand-written)
  const runNote = runStatusNote(outBase);
  if (runNote) console.error(`note  ${runNote}`);
  if (prev !== null && prev === next) console.error(`note  ${target} is byte-identical to the expectation on disk (same export inputs, sha256 ${h.slice(0, 12)}…) — unchanged; ` +
    `this says nothing about the build: re-measure to check the code`);
  else if (onlyExportedAt) {
    // a re-pull with nothing changed rewrites only exportedAt. Same design, same specs —
    // the measurements and report beside it still describe it.
    console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}… unchanged) — existing measurements and report still apply`);
  } else if (prev !== null) {
    // say WHY it differs — the same export content means verify-screen itself changed (an upgrade)
    const why = typeof prevContent === "string" && prevContent === exp.exportContentSha256 ? "same export content — the expectation generator changed (verify-screen upgrade)"
      : typeof prevContent === "string" ? `the export changed (content sha ${prevContent.slice(0, 12)}… → ${exp.exportContentSha256.slice(0, 12)}…)`
      // an expectation written before exportContentSha256 — whether the export or the generator changed is unknown
      : `the expectation recorded no export hash (exportContentSha256) — cannot tell whether the export or the expectation generator changed`;
    console.error(`note  REPLACED an existing ${target} that differed (sha256 ${sha256Hex(prev).slice(0, 12)}… → ${h.slice(0, 12)}…): ${why}; the previous one is kept as ${prevFile}`);
    const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs.existsSync(f));
    if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation — re-measure and re-compare before reading ` +
      `${stale.length > 1 ? "them" : "it"}.`);
  }
  const hc = exp.counts.hidden;
  const lineBoxes = exp.notComparable.filter((g) => g.field === TEXT_BOX_HEIGHT).length;
  console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) — visible layers only; ` +
    `skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ` +
    `${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable${lineBoxes ? `; ${lineBoxes} a line box taller than its fixed text box — the build chooses its line-height` : ""}) · ` +
      `expectation sha256 ${h.slice(0, 12)}…`);
  const ri = exp.referenceImage;
  if (ri) console.error(ri.usable ? `reference ${ri.path} ${ri.png.w}×${ri.png.h} at ${scaleText(ri.scale)} ` +
    `(${ri.from})${ri.offset.x || ri.offset.y ? `, offset ${ri.offset.x},${ri.offset.y}` : ""}${ri.colorProfile ? ` — ${ri.colorProfile}: colours are compared without colour management` : ""}`
    : `note  no visual diff for this screen: ${ri.why}`);
  if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers — interaction coverage cannot be checked, and the report will say so rather than passing.");
  return 0;
}

/** `--compare <Layer>__<id>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] [--plan <plan.json>] [--record-plan]
 *  [--out <dir>]`: writes <dir>/<set>.report.json + .md (compare), the set the expectation names, and exits 1 unless the verdict passes. */
function compareMain(files: string[], flags: { out?: string | undefined; interactions?: string | undefined; against?: string | undefined; plan?: string | undefined; "record-plan"?: boolean | undefined },
  USAGE: string): number {
  const sha = (file: string): string => sha256Hex(fs.readFileSync(file));
  const { out, interactions: interactionsFile, against: againstFile, plan: planFlag } = flags;
  const recordPlanFlag = !!flags["record-plan"];
  const [expFile, measuredFile] = files;
  if (!expFile || !measuredFile) { console.error("--compare needs <expected.json> <measured.json>\n" + USAGE); return 2; }
  const expectation = readDocFile(expFile, "expectation", isVerifyExpectation);
  const measuredRaw = readJsonFile(measuredFile, "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}.");
  // A malformed OPTIONAL extra (a hand-written `probe: "handmade"`, `notMeasured: {}`) is dropped with a note;
  // only measurements compare cannot read at all are refused.
  const readable = readableMeasured(measuredRaw);
  if (!readable) { console.error(`error  probe measurements: '${measuredFile}' is not ${isVerifyMeasured.expected}`); return 2; }
  const measured = readable.doc;
  for (const n of readable.notes) console.error(`note  ${measuredFile}: ${n}`);
  let extra: InteractionEvidence[] | undefined;
  let extraComponents: MeasuredComponent[] | undefined;
  let extraInferred: unknown;
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    // The object form ({interactions:[…], components:[…], inferred:[…]}, the verifier's evidence.json) may carry any of
    // the lists; `inferred` is checked row by row in compare (a malformed row is an input note, not a refusal).
    const obj = isJsonObject(raw) ? raw : null;
    const list = isInteractionEvidenceList(raw) ? raw : obj && isInteractionEvidenceList(obj.interactions) ? obj.interactions
      : obj && obj.interactions === undefined && (obj.components !== undefined || obj.inferred !== undefined) ? [] : null;
    if (obj && obj.inferred !== undefined) extraInferred = obj.inferred;
    const comps = obj && obj.components !== undefined ? (isMeasuredComponentList(obj.components) ? obj.components : null) : [];
    if (!list || !comps) { console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[…], components:[…], inferred:[…]}`); return 2; }
    extra = list;
    if (comps.length) extraComponents = comps;
  }
  // the expectation's set name is the report's: a legacy name, or one of another node than its frame, is refused before
  // anything is compared or written (--migrate renames a legacy set; --expect names the set by its frame)
  const setName = setNameOfFile(expFile);
  const setProblem = expectationSetProblem(expFile, expectation.frame && expectation.frame.nodeId, path.dirname(expFile));
  if (setProblem !== null) { console.error(`error  ${setProblem}`); return 2; }
  const ob = outBaseOf(out, setName, VERIFY_DIR);
  if ("error" in ob) { console.error(`error  ${ob.error}`); return 2; }
  if (ob.deprecated) console.error(`note  --out ${out} names the set: pass the directory ${ob.dir}`);
  const compareBase = ob.base;
  // the run status of the set: ONE status base, the expectation's (<its dir>/<set>, statusBaseOf) — the live status in the
  // run cache, else the published <dir>/<set>.status.json — the key every writer of the set's run uses (--status, --wait,
  // verify-probe), wherever the measured file was written. Always looked up: null = looked and found none (a measured file
  // naming its run then has nothing recording it).
  const statusBase = statusBaseOf(expFile);
  const found = readStatusAt(statusBase);
  const statusOpt = { status: found ? { file: found.file === statusFile(statusBase) ? path.basename(found.file) : `${path.basename(found.file)} (live, ${found.file})`, status: found.status, screen: setName } : null };
  // an artefact listed under the set's old name (renamed by --migrate after its run) is read under the new one — only by
  // migratedArtifact's rule, and said so
  const measuredRun = typeof measured.runId === "string" && measured.runId ? measured.runId : undefined;
  const measuredSha = sha(measuredFile);
  const migrated = (listed: string): string | null => migratedArtifact(listed, { setName, verifyDir: path.dirname(expFile), status: found ? found.status : null, measuredRun, measuredSha });
  const artifactNotes: string[] = [];
  const movedNote = (listed: string, now: string): void => {
    artifactNotes.push(`${listed} is listed under the set's name before --migrate (run ${measuredRun ?? "?"}) — read as ${now}`);
    console.error(`note  ${artifactNotes[artifactNotes.length - 1]}`);
  };
  // Artifacts are checked on disk, relative to the working directory (the project root), so a report
  // can never cite a screenshot that does not exist.
  const artifacts = measured.artifacts || [];
  const artifactCheck: ArtifactCheck[] = artifacts.map((a) => {
    const listed = typeof a === "string" ? a : a && a.path;
    const moved = listed ? migrated(listed) : null;
    if (listed && moved !== null) movedNote(listed, moved);
    const p = moved ?? listed;
    const exists = !!p && fs.existsSync(p);
    return { ...ifDefined("path", p), exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists ? sha(p) : undefined), ...(moved !== null ? { listedAs: listed } : {}) };
  });
  // tie the report to the code it measured — the plan (design/plan/*.json) for this
  // frame lists the files; their content hashes and `git rev-parse HEAD` go into report.inputs.code.
  let code: CodeInputs | undefined;
  // the same plan supplies waivers[], descopes[] and foldedInto anchors — found whether or not it lists files.
  let planHit: ChosenPlan | undefined;
  let recordedPlanGone: string | undefined;
  const compareNotes: string[] = [];
  let flagged: { file: string; plan: Plan } | undefined;
  if (planFlag !== undefined) {
    const r = readJson(planFlag, isPlan);
    if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
    flagged = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
  }
  {
    const frameId = expectation.frame && expectation.frame.nodeId;
    // the same rule --expect used (choosePlan) — never a second way of picking the plan
    const chosen = choosePlan(flagged, frameId);
    const all = chosen.all;
    planHit = chosen.hit;
    if (chosen.note !== undefined) console.error(`note  ${chosen.note}`);
    // the plan --expect merged interactions from (planInteractions.plan) wins over another found now —
    // --expect may have been given --plan, or design/plan/ changed since; without --plan, check the rows it merged
    const recPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.plan === "string" ? expectation.planInteractions.plan : undefined;
    if (recPi !== undefined && !(planHit && samePlanFile(planHit.file, recPi))) {
      const r = readJson(recPi, isPlan);
      if (!("doc" in r)) recordedPlanGone = r.missing ? "no longer exists" : `is not a readable plan now (${r.error})`;
      else if (!flagged) {
        const foundNow = planHit ? ` instead of ${planHit.file}, the plan found in design/plan/ now` : all.length ? `; ${all.length} plans in design/plan/ describe this frame now (${all.map((h) => h.file).join(", ")})`
          : "; no plan in design/plan/ describes this frame";
        compareNotes.push(`using ${recPi} (the plan --expect merged interactions from)${foundNow} — its interactions[], waivers, descopes, anchors and navigate apply; pass --plan <plan.json> to use another`);
        console.error(`note  ${compareNotes[compareNotes.length - 1]}`);
        planHit = { file: recPi, plan: r.doc, choice: "recorded" };
      }
    }
    // several plans of the node and no plan to go by (--plan, or the one --expect merged): a data error, BEFORE anything
    // is compared or written — waivers, descopes and the code hashes would come from a guess
    if (!planHit && chosen.error !== undefined) { console.error(`error  ${chosen.error}`); return 2; }
    // --record-plan writes into the plan this compare uses — none is a usage error BEFORE anything is compared or written
    if (recordPlanFlag && !planHit) {
      console.error(`--record-plan: no plan in design/plan/ describes this frame${idlessNote(chosen.idless)} (run from the project root) — pass --plan <plan.json>`);
      return 2;
    }
    if (planHit && planHit.plan.files) {
      // the chosen plan's files[] and every module its anchors/components map (a shared shell)
      code = { plan: planHit.file, files: fileHashes(planCodeFiles(planHit.plan, process.cwd()), process.cwd()), gitHead: gitHead(process.cwd()) };
      // what the code hashes leave out, beside them in the report's input notes
      const skipped = planCodeSkippedNote(planHit.plan, process.cwd());
      if (skipped) { compareNotes.push(`${planHit.file}: ${skipped}`); console.error(`note  ${compareNotes[compareNotes.length - 1]}`); }
    } else {
      console.error(planHit ? `note  ${planHit.file} lists no files[] — the report records no code hashes, so verify-build --status cannot tie it to the code`
        : `note  no plan in design/plan/ describes this frame${idlessNote(chosen.idless)} — the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code`);
    }
  }
  const planInputs = planHit ? {
    ...ifDefined("waivers", planHit.plan.waivers), ...ifDefined("descopes", planHit.plan.descopes), ...ifDefined("anchors", planHit.plan.anchors),
    waiversInput: { plan: planHit.file, sha256: waiversHash(planHit.plan) },
  } : {};
  // the report this run is about to overwrite is the coverage baseline — read BEFORE writing.
  // --against names another one. An explicit file that cannot be read is an error; an unreadable implicit
  // one is only noted (it is about to be replaced anyway).
  let against: { file: string; report: VerifyReport } | undefined;
  if (againstFile !== undefined) {
    const r = readJson(againstFile, isVerifyReport);
    if (!("doc" in r)) { console.error(`--against '${againstFile}' ${r.error}`); return 2; }
    against = { file: againstFile, report: r.doc };
  } else {
    const own = compareBase + ".report.json";
    const r = readJson(own, isVerifyReport);
    if ("doc" in r) against = { file: own, report: r.doc };
    else if (!r.missing) console.error(`note  ${own} ${r.error} — no coverage baseline this round (it is about to be overwritten)`);
  }
  // the diff PNG the probe recorded — as recorded, else the same name beside the measured file (a published stage), else
  // under the set's new name (migratedArtifact)
  const vd: unknown = measured.visual && measured.visual.ran ? measured.visual.diff : undefined;
  let visualDiff: { path: string; exists: boolean } | null = null;
  if (typeof vd === "string" && vd) {
    const beside = path.join(path.dirname(measuredFile), path.basename(vd));
    const moved = fs.existsSync(vd) || fs.existsSync(beside) ? null : migrated(vd);
    if (moved !== null) movedNote(vd, moved);
    visualDiff = fs.existsSync(vd) ? { path: vd, exists: true } : fs.existsSync(beside) ? { path: beside.split(path.sep).join("/"), exists: true }
      : moved !== null ? { path: moved, exists: true } : { path: vd, exists: false };
  }
  const inputNotes = [...readable.notes, ...compareNotes, ...artifactNotes];
  const rep = compare(expectation, measured, { ...statusOpt, ...(readable.dropped.includes("behaviour") ? { behaviourMalformed: true } : {}), ...(readable.dropped.includes("visual") ? { visualMalformed: true } : {}),
    ...(visualDiff ? { visualDiff } : {}), ...(inputNotes.length ? { inputNotes } : {}), ...ifDefined("recordedPlanGone", recordedPlanGone),
    ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), ...(extraInferred !== undefined ? { inferred: extraInferred } : {}), expectationSha256: sha(expFile),
    measuredSha256: measuredSha, artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs, ...(planHit ? { plan: planHit } : {}) });
  const md = reportToMarkdown(rep);
  write(false, compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  console.error(rep.behaviour.headline);
  console.error(rep.visual.headline);
  const nie = rep.probe.measuredIdsNotInExpectation || 0;
  if (nie) console.error(`note  ${nie} measured node id(s) are not in the expectation (e.g. ${(rep.probe.measuredIdsNotInExpectationSample || []).join(", ")}) — ` +
    `measured against another screen or an older expectation?`);
  for (const w of rep.waivers.reopened) console.error(`warn  waiver REOPENED ${w.nodeId} (${w.field}): ${w.why}`);
  if (rep.waivers.unused.length) console.error(`note  ${rep.waivers.unused.length} plan waiver(s)/descope(s) match nothing this round: ${rep.waivers.unused.map((w) => `${w.nodeId} (${w.field})`).join(", ")} — ` +
    `fixed? drop them`);
  // the report just written → plan.verification.recorded, the tool-owned block (plan-record.ts). A failure leaves
  // the report in place and says so (exit 1): the plan then still holds the previous record.
  if (recordPlanFlag && planHit) {
    // relative to the project by REAL paths — an absolute --out through a symlink (macOS /tmp → /private/tmp) is
    // still inside the project
    const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    const reportRel = path.relative(realOf(process.cwd()), realOf(path.resolve(compareBase + ".report.json"))).split(path.sep).join("/");
    try {
      const r = recordPlan(planHit.file, rep, reportRel, { cwd: process.cwd() });
      for (const n of r.notes) console.error(`note  ${n}`);
      console.error(r.written ? `recorded ${reportRel} in ${planHit.file} (plan.verification.recorded)` : `${planHit.file}: plan.verification.recorded already records ${reportRel} — unchanged`);
    } catch (e) {
      console.error(`error  --record-plan: ${errMsg(e)} — ${reportRel} is written; ${planHit.file} was not updated`);
      return 1;
    }
  }
  return isPassingVerdict(rep.verdict) ? 0 : 1;
}

// `--accept <report> (--node <id> [--field <label>] | --group <gid>) --reason … --by … [--plan <plan.json>]`.
// Copies the report delta(s) into plan.waivers[] — one row per node + field — bound to the export content hash
// and to the designed and built values. It never grades anything: the next --compare applies (or reopens) them.
function acceptMain(files: string[], flags: { node?: string | undefined; field?: string | undefined; group?: string | undefined; reason?: string | undefined; by?: string | undefined; plan?: string | undefined;
  "all-fields"?: boolean | undefined }, USAGE: string): number {
  const reportFile = files[0];
  if (!reportFile || files.length > 1) { console.error("--accept needs exactly one <Layer>__<id>.report.json\n" + USAGE); return 2; }
  if ((flags.node === undefined) === (flags.group === undefined)) { console.error("--accept needs exactly one of --node <id> / --group <gid>\n" + USAGE); return 2; }
  if ((flags.field !== undefined || flags["all-fields"]) && flags.group !== undefined) { console.error("--field / --all-fields go with --node, not --group\n" + USAGE); return 2; }
  // One "keep the 16px" must not also waive a copy or colour delta on the same node: name the field, or say all.
  if (flags.node !== undefined && (flags.field === undefined) === !flags["all-fields"]) { console.error("--accept --node needs exactly one of --field \"<label>\" / --all-fields\n" + USAGE); return 2; }
  const reason = (flags.reason || "").trim(), by = (flags.by || "").trim();
  if (!reason || !by) { console.error(`--accept needs ${!reason ? "--reason \"<why this deviation is intended>\"" : ""}${!reason && !by ? " and " : ""}${!by ? "--by \"<who decided>\"" : ""} — a waiver without a ` +
    `reason and a decider is not recorded\n` + USAGE); return 2; }
  const r = readJson(reportFile, isVerifyReport);
  if (!("doc" in r)) { console.error(`error  report: '${reportFile}' ${r.error}`); return 2; }
  const report = r.doc;
  const exportSha = report.inputs && report.inputs.exportContentSha256;
  if (!exportSha) { console.error(`error  ${reportFile} records no inputs.exportContentSha256 — re-run --expect and --compare, then accept against the new report`); return 1; }
  const sel = selectForAccept(report, { node: flags.node, field: flags.field, group: flags.group });
  if ("error" in sel) { console.error(`refused  ${sel.error}`); return 1; }

  // the plan: --plan, else the one the report was compared with, else the one plan of the report's node
  const recorded = (report.inputs && report.inputs.waivers && report.inputs.waivers.plan) || (report.inputs && report.inputs.code && report.inputs.code.plan) || undefined;
  let planFile = flags.plan ?? (recorded && fs.existsSync(recorded) ? recorded : undefined);
  if (!planFile) {
    // the report's node: its nodeId (an older report's), else the id its set name (`<Layer>__<id>[.<slug>]`) carries
    const nodeId = report.nodeId || nodeIdFromSetName(path.basename(reportFile).replace(/\.report\.json$/, "")) || undefined;
    const { hits, idless } = plansForNode(nodeId);
    // several plans of the report's node: a data error, as at --expect and --compare
    if (hits.length > 1) { console.error(`error  ${hits.length} plans in design/plan/ describe node ${nodeId ?? "?"} (${hits.map((h) => h.file).join(", ")}) — keep one, or pass --plan <plan.json>`); return 2; }
    const only = hits[0];
    if (!only) { console.error(`error  no plan in design/plan/ describes this screen${idlessNote(idless)} (run from the project root, or pass --plan <plan.json>)`); return 1; }
    planFile = only.file;
  }
  const pr = readJson(planFile, isPlan);
  if (!("doc" in pr)) { console.error(`error  plan: '${planFile}' ${pr.error}`); return 1; }
  const decidedAt = new Date().toISOString();
  const target = planFile;
  let wrote: string[] = [];
  try {
    // under the plan's lock, from its bytes at that moment (plan-record.ts updatePlan): a record or hook write since
    // the read above is kept. Atomic (a crash never leaves half a plan), in the plan file's own format
    updatePlan(target, (raw) => {
      if (raw === null) throw new Error(`${target} does not exist`);
      const plan = parsePlanText(raw, target);
      const waivers: PlanWaiver[] = Array.isArray(plan.waivers) ? [...plan.waivers] : [];
      wrote = [];
      for (const d of sel.deltas) {
        const row: PlanWaiver = { nodeId: d.nodeId, field: d.field, designed: d.expected, built: d.actual, exportContentSha256: exportSha, reason, decidedBy: by, decidedAt, ...ifDefined("cause", flags.group) };
        // one row per node + field: a new decision replaces the old one
        const at = waivers.findIndex((w) => isJsonObject(w) && w.nodeId === d.nodeId && w.field === d.field);
        if (at >= 0) waivers[at] = row; else waivers.push(row);
        wrote.push(`${at >= 0 ? "replaced" : "added"}  ${d.nodeId} ${d.name ? `(${d.name}) ` : ""}${d.field}: designed ${fmt(d.expected)}, built ${fmt(d.actual)}`);
      }
      plan.waivers = waivers;
      return plan;
    });
  } catch (e) { console.error(`error  plan: ${errMsg(e)} — no waiver written`); return 1; }
  console.error(`wrote ${wrote.length} waiver(s) to ${planFile} (decided by ${by}: ${reason})`);
  for (const w of wrote) console.error(`  ${w}`);
  console.error(`re-run --compare to apply ${wrote.length === 1 ? "it" : "them"}: an accepted delta stays listed, leaves the counts, and reopens if the design is re-exported or the built value moves.`);
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
  else code.then((c) => { process.exitCode = c; }, (e: unknown) => { console.error(`verify-screen: ${errMsg(e)}`); process.exitCode = 1; });
}
