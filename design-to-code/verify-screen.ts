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
//   bun verify-screen.js --expect  <screen.json>... [--out design/verify]
//   bun verify-screen.js --compare <Layer>__<id>.expected.json <measured.json> [--interactions <file>] [--out <dir>, default the expectation's]
// --out is the verify directory; the set's name is its node's (`<Layer>__<id>`, verify-sets.ts), never the caller's.
//
// There is NO browser here. `--compare` diffs two JSON files; the rendering, measuring and
// interaction-driving are the probe's job (the visual-verifier agent, or any script), and what it did
// arrives as measured.json (+ an optional --interactions file). Anything the probe did not measure is
// reported as not measured / not probed — never as passed, and never as failed.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { parsePlanText, recordPlan, reportFileText, updatePlan } from "./plan-record.ts";
import { readDocFile } from "./catalog-input.ts";
import { isPlan, isVerifyReport } from "./doc-guards.ts";
import { choosePlan } from "./plan-binding.ts";
import { STATUS_PHASES, TERMINAL_PHASES, readStatusAt, statusMain, waitMain } from "./verify-run.ts";
import { writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { readJson, readJsonOrNull } from "../bridge/src/read-json.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { isJsonObject, isPassingVerdict } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import type { JsonValue, Plan, PlanWaiver, ScreenDoc, VerifyDelta, VerifyReport } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { errMsg } from "../bridge/src/errmsg.ts";
import { runCli } from "./proc.ts";
import { EXPORT_DIR, VERIFY_DIR } from "../bridge/src/project-layout.ts";
import { idlessNote, nodeArtefacts, plansFound } from "./node-artefacts.ts";
import { gatherCompareRun } from "./compare-run.ts";
import { pagesRootOfScreen, readDesignSystemStamp, readExportIndex, resolveInside, rootIndexFile } from "../bridge/src/export-reader.ts";
import { TEXT_BOX_HEIGHT, fmt, scaleText } from "./verify-shared.ts";
import { buildExpectation } from "./verify-expect.ts";
import type { ExpectInput, ExpectOptions } from "./verify-expect.ts";
import { compare } from "./verify-compare.ts";
import { probeLine, reportToMarkdown } from "./verify-report-md.ts";
import { migrateMain } from "./verify-migrate.ts";
import { endsInSep, formatSetName, outBaseOf, setBaseOf, setFile, trimSep, variantOverlap, variantProblem, variantsOf } from "./verify-sets.ts";

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

/** The verify directory --expect names the node's stem in (node-artefacts.ts claim) before the set's name is known: --out when it is
 *  an existing directory, ends in a separator or is design/verify; the parent of the older `<dir>/<set>` spelling;
 *  design/verify without --out. outBaseOf then decides, by the set's name, whether --out is taken at all. */
function expectDirOf(out: string | undefined): string {
  if (out === undefined) return VERIFY_DIR;
  let dir = false;
  try { dir = fs.statSync(out).isDirectory(); } catch { /* not there */ }
  if (dir || path.resolve(out) === path.resolve(VERIFY_DIR)) return out;
  if (endsInSep(out)) return trimSep(out);
  return path.dirname(out);
}

/** The plan for a frame, by plan-binding.ts's one rule for --expect and --compare, over design/plan/ (plansFound). */
const planFor = (flagged: { file: string; plan: Plan } | undefined, frameId: string | undefined): ReturnType<typeof choosePlan> =>
  choosePlan(flagged, plansFound(process.cwd(), frameId), frameId);

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
export function main(argv: string[]): number | Promise<number> {
  const USAGE =
    "usage:\n" +
    `  ${scriptCmd("verify-screen")} --expect <screen.json>... [--out design/verify] [--variant <slug>] [--plan <plan.json>]\n` +
    "      writes <Layer>__<id>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      The plan for this frame (--plan, else the one plan in design/plan/ that describes it) adds its interactions[]\n" +
    "      ({nodeId, trigger, expect: dialog|url|selector:<css>, destinationId?}) the export cannot carry; a row that cannot\n" +
    "      be graded is dropped with why. Their hash binds the expectation: change them → re-run --expect.\n" +
    "      Its deviations[] rows with field \"placeholder\" ({nodeId, field, designed, built, reason}) mark a TEXT layer built as a\n" +
    "      form control's placeholder attribute: compared as placeholderText/placeholderColor; their hash binds the same way.\n" +
    "      Run it from the project root: a screen of another project's design/export is refused (exit 2), naming that project.\n" +
    "      Read them; never retype them. --out is the verify directory (default design/verify; a new one ends in \"/\"): the set is\n" +
    "      named by the frame's node, <Layer>__<id> — the name a set of that node there already has (a frame renamed in Figma keeps\n" +
    "      it). Any other --out basename is refused (exit 2): one node, one set. --variant <slug> writes the variant set\n" +
    "      <Layer>__<id>.<slug> instead (a dark theme, a narrow width): lower-case letters and digits, words joined by single \"-\",\n" +
    "      at most 32; a file tail of the set is no slug, nor one that extends another variant of the node by \"-\" (exit 2).\n" +
    "      Replacing one that differs keeps the old bytes as\n" +
    "      <Layer>__<id>.expected.prev.json (one generation) and says why: the export changed, or verify-screen did (same export\n" +
    "      content). It notes a last run of <Layer>__<id> that failed, was blocked or never finished (its files are partial).\n" +
    `  ${scriptCmd("verify-screen")} --compare <Layer>__<id>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] [--plan <plan.json>] [--record-plan] [--out <dir>]\n` +
    "      writes <Layer>__<id>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares\n" +
    "      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n" +
    "      (a JSON array, or {interactions:[…], components:[…], inferred:[…]}, of {nodeId, trigger, ok, selector, selectorCount, detail};\n" +
    "      components[] rows {setName|nodeId, present} are merged with measured.json's; inferred[] rows {nodeId?, state, built, why?}\n" +
    "      — what the build does that the design never drew — are listed under 'Inferred, not designed', never graded).\n" +
    "      --out is the verify directory (default: the expectation's own, as verify-probe's); the report takes the expectation's set name. A legacy-named\n" +
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
    "      A dry run unless --apply. A legacy base set whose node already has its <Layer>__<id> base set has its expectation retired\n" +
    "      (<S>.expected.json.retired; its other files stay under <S>).\n" +
    "      Skips a set (says why) whose node is unknown or ambiguous, with an open run, whose new name is taken, or that a plan\n" +
    "      records with a hand-edited record or finds by its name alone with no node id of the set's (add \"nodeId\" to it).\n" +
    "      Also skips a set whose plan's reportSha256 no longer names the report on disk, and two legacy sets of one node that\n" +
    "      extend no other name (which one is the screen is your call). Most skips say what to do.\n" +
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
  const written = setFile(base, doExpect ? "expected" : "report");
  writeFileAtomic(written, reportFileText(obj));
  if (md) writeFileAtomic(setFile(base, "reportMd"), md);
  console.error(`wrote ${written}${md ? " and " + setFile(base, "reportMd") : ""}`);
}

/** `--expect <screen.json>... [--out <dir>] [--variant <slug>] [--plan <plan.json>]`: writes <dir>/<Layer>__<id>[.<slug>].expected.json
 *  (buildExpectation) — the set named by the frame's node, never by the caller — says what it replaced, and notes the last run beside it. */
function expectMain(files: string[], flags: { out?: string | undefined; plan?: string | undefined; variant?: string | undefined }, USAGE: string): number {
  const { out, plan: planFlag, variant } = flags;
  const firstFile = files[0];
  if (firstFile === undefined) { console.error("--expect needs at least one screen export\n" + USAGE); return 2; }
  const slugWhy = variant === undefined ? null : variantProblem(variant);
  if (slugWhy !== null) { console.error(`error  --variant: ${slugWhy}`); return 2; }
  // The export a screen file belongs to is the pages/ tree it sits in — the expectation reads that export's index, sibling
  // screens, reference PNG and design-system.json from design/export (relative to the working directory, the project
  // root: the reference path it records, the plans and the verify sets are all project-relative). A screen in ANOTHER
  // export is refused, naming its project — read from here, its reference would be "missing" and its aliases silently gone.
  const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const ownExport = realOf(EXPORT_DIR);
  for (const f of files) {
    const root = pagesRootOfScreen(f);
    if (root === null || realOf(root) === ownExport) continue;
    const project = path.basename(root) === path.basename(EXPORT_DIR) && path.basename(path.dirname(root)) === path.dirname(EXPORT_DIR) ? path.dirname(path.dirname(root)) : null;
    console.error(project !== null
      ? `error  ${f} is a screen of the export in ${project}, not of this working directory (${process.cwd()}) — run --expect from ${project}: the expectation's reference path, plans and verify sets are relative to the project root`
      : `error  ${f} sits in the export at ${root}, not in this project's ${EXPORT_DIR.split(path.sep).join("/")} — pull the screen into ${EXPORT_DIR.split(path.sep).join("/")} and run --expect from the project root`);
    return 2;
  }
  const docs: ExpectInput[] = files.map((f) => ({ doc: readDocFile(f, "screen export", isScreenDoc), label: path.basename(f, ".json") }));
  // the export's own index (relative to the project root) tells which destinations were exported: every screen it
  // indexes (bridge/src/export-reader.ts) — a page walk replaces the root index, so a destination an earlier walk exported is in
  // its page's own index only
  const ix = readExportIndex(EXPORT_DIR);
  if (ix.rootProblem !== null) console.error(`note  ${rootIndexFile(EXPORT_DIR)} ${ix.rootProblem} — interaction destinations are checked against the given export(s) only`);
  const layers = [...ix.rows];
  // (rows only: the root index's own top-level sourceFile names its last walk, not the page-dir rows merged in)
  // sibling screen exports (aliases for a shared shell's nodes) — read lazily, only the same file's rows
  const exportRoot = EXPORT_DIR;
  const readSibling = (file: string): ScreenDoc | null => { const f = ix.fileOf({ file }); return f === null ? null : readJsonOrNull(f, isScreenDoc); };
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
  const chosen = planFor(flagged, firstRoot && firstRoot.id);
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
  const colorProfile = readDesignSystemStamp(exportRoot).stamp?.colorProfile ?? null;
  const expOpts: ExpectOptions = { ...(ix.indexed || layers.length ? { index: { layers }, readSibling } : {}), ...(planForExpect ? { plan: planForExpect } : {}), readReference, colorProfile };
  const exp = buildExpectation(docs, Object.keys(expOpts).length ? expOpts : null);
  const pi = exp.planInteractions;
  if (pi) {
    console.error(`${pi.plan}: ${pi.merged} plan interaction(s) merged${pi.dropped.length ? `, ${pi.dropped.length} dropped` : ""} (plan interactions sha256 ${pi.sha256.slice(0, 12)}…)`);
    for (const d of pi.dropped) console.error(`warn  plan interaction ${d.nodeId} dropped: ${d.why}`);
  }
  const pp = exp.planPlaceholders;
  if (pp) {
    console.error(`${pp.plan}: ${pp.nodeIds.length} TEXT layer(s) compared as input placeholders (deviations[] field "placeholder")${pp.dropped.length ? `, ${pp.dropped.length} row id(s) dropped` : ""} ` +
      `(placeholder rows sha256 ${pp.sha256.slice(0, 12)}…)`);
    for (const d of pp.dropped) console.error(`warn  plan placeholder ${d.nodeId} dropped: ${d.why}`);
  }
  // the set's name is its node's: <Layer>__<id> — the stem a set of the node in the verify dir already has, or a run of it
  // open in the run cache (fixed: a frame renamed in Figma keeps it), else the indexed layer name's (the frame's own without an index). Never the input file's
  // basename or a name the caller typed: two names for one node would be two artefact sets.
  const nodeId = exp.frame.nodeId;
  if (!nodeId) { console.error(`error  the export's frame has no node id — its set cannot be named; re-pull the screen`); return 2; }
  const layerName = layers.find((l) => l.id === nodeId)?.name ?? exp.frame.name ?? "";
  const kDir = expectDirOf(out);
  const k = nodeArtefacts(process.cwd(), { verifyDir: kDir }).claim("verify set", nodeId, { layerName });
  if (!k.ok) { console.error(`error  ${k.why}`); return 2; }
  const setName = formatSetName(k.name, variant);
  const ob = outBaseOf(out, setName, VERIFY_DIR);
  if ("error" in ob) { console.error(`error  ${ob.error}`); return 2; }
  // a slug that extends another live variant of the node by "-" (or that one extends) would share files with it (variantOverlap)
  if (variant !== undefined) {
    const clash = variantOverlap(variant, variantsOf(ob.dir, k.name));
    if (clash !== null) { console.error(`error  --variant ${variant} overlaps the variant ${k.name}.${clash} of node ${nodeId} by "-": <set>-<state>.png of one names a screenshot of the other — pick a slug that neither extends`); return 2; }
  }
  if (ob.deprecated) console.error(`note  --out ${out} names the set: pass the directory ${ob.dir}`);
  if (k.legacy.length) console.error(`note  legacy-named verify set(s) ${k.legacy.join(", ")} of node ${nodeId} — verify-screen --migrate renames them to ${k.name}`);
  const outBase = ob.base;
  // Re-running --expect replaces the file in place and leaves a measurement and a report from the
  // PREVIOUS expectation beside it, undated. The file itself stays byte-deterministic —
  // the notice goes to stderr, and every report records the sha it was computed on.
  const target = setFile(outBase, "expected");
  const next = JSON.stringify(exp, null, 2) + "\n";
  const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  let prevContent: JsonValue | undefined = null;
  try { if (prev !== null) { const prevDoc: unknown = JSON.parse(prev); prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null; } } catch { /* unreadable */ }
  const onlyExportedAt = prev !== null && prev !== next && !!prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "");
  // the sha256 of the expectation on disk after this run: the kept bytes when only exportedAt changed (below)
  const h = sha256Hex(onlyExportedAt && prev !== null ? prev : next);
  // a REPLACED expectation keeps its previous bytes (one generation) — written before the new one
  const prevFile = setFile(outBase, "expectedPrev");
  if (prev !== null && prev !== next && !onlyExportedAt) writeFileAtomic(prevFile, prev);
  // only exportedAt changed: the file is left as it is — its sha256 is what the measured file and the report were bound
  // to (report-freshness.ts), and rewriting the timestamp alone would unbind both from the same design
  if (!onlyExportedAt) write(true, outBase, exp);
  // what the last run beside this expectation says (failed/blocked, never finished, in progress, hand-written)
  const runNote = runStatusNote(outBase);
  if (runNote) console.error(`note  ${runNote}`);
  if (prev !== null && prev === next) console.error(`note  ${target} is byte-identical to the expectation on disk (same export inputs, sha256 ${h.slice(0, 12)}…) — unchanged; ` +
    `this says nothing about the build: re-measure to check the code`);
  else if (onlyExportedAt) {
    // a re-pull with nothing changed rewrites only exportedAt. Same design, same specs — the expectation is kept byte for
    // byte, so the measurements and report beside it still describe it.
    console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}… unchanged) — kept as it is; existing measurements and report still apply`);
  } else if (prev !== null) {
    // say WHY it differs — the same export content means verify-screen itself changed (an upgrade)
    const why = typeof prevContent === "string" && prevContent === exp.exportContentSha256 ? "same export content — the expectation generator changed (verify-screen upgrade)"
      : typeof prevContent === "string" ? `the export changed (content sha ${prevContent.slice(0, 12)}… → ${exp.exportContentSha256.slice(0, 12)}…)`
      // an expectation written before exportContentSha256 — whether the export or the generator changed is unknown
      : `the expectation recorded no export hash (exportContentSha256) — cannot tell whether the export or the expectation generator changed`;
    console.error(`note  REPLACED an existing ${target} that differed (sha256 ${sha256Hex(prev).slice(0, 12)}… → ${h.slice(0, 12)}…): ${why}; the previous one is kept as ${prevFile}`);
    const stale = (["measured", "report", "reportMd"] as const).map((k) => setFile(outBase, k)).filter((f) => fs.existsSync(f));
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
 *  [--out <dir>]`: writes <dir>/<set>.report.json + .md (compare), the set the expectation names, and exits 1 unless the verdict passes.
 *  What compare() is given is gathered by compare-run.ts; this is parse → gather → compare → write → print. */
function compareMain(files: string[], flags: { out?: string | undefined; interactions?: string | undefined; against?: string | undefined; plan?: string | undefined; "record-plan"?: boolean | undefined },
  USAGE: string): number {
  const [expFile, measuredFile] = files;
  if (!expFile || !measuredFile) { console.error("--compare needs <expected.json> <measured.json>\n" + USAGE); return 2; }
  const run = gatherCompareRun(expFile, measuredFile, { out: flags.out, interactions: flags.interactions, against: flags.against, plan: flags.plan, recordPlan: !!flags["record-plan"] }, process.cwd());
  for (const n of run.notes) console.error(`note  ${n}`);
  if (!run.ok) { console.error(run.message); return 2; }
  const rep = compare(run.expectation, run.measured, run.options);
  write(false, run.set.outBase, rep, reportToMarkdown(rep));
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
  const planHit = run.recordInto;
  if (planHit) {
    // relative to the project by REAL paths — an absolute --out through a symlink (macOS /tmp → /private/tmp) is
    // still inside the project
    const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    const reportRel = path.relative(realOf(process.cwd()), realOf(path.resolve(setFile(run.set.outBase, "report")))).split(path.sep).join("/");
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
    // the report's node: its set's (node-artefacts.ts setNode — the expectation beside it, else the report's nodeId, else
    // the id its set name `<Layer>__<id>[.<slug>]` carries); an expectation and a report that disagree name none, and
    // whose plan a waiver goes into is not ours to guess
    const set = setBaseOf(path.basename(reportFile), "report") ?? path.basename(reportFile);
    const nodeId = nodeArtefacts(process.cwd(), { verifyDir: path.dirname(reportFile) }).setNode(set);
    if (nodeId === null) { console.error(`error  the set ${set} names no node (its expectation and report name different nodes, or neither names one) — pass --plan <plan.json>`); return 1; }
    const { hits, idless, several } = plansFound(process.cwd(), nodeId);
    // several plans of the report's node: a data error, as at --expect and --compare
    if (several !== null) { console.error(`error  ${several}, or pass --plan <plan.json>`); return 2; }
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

if (import.meta.main) runCli(main, { name: "verify-screen", errorLine: (e) => `verify-screen: ${errMsg(e)}` }); // exitCode, never exit() (proc.ts)
