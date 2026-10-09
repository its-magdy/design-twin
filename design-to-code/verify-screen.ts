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
// Two commands, one file, because the expectation format and the comparison must never drift:
//   node verify-screen.js --expect  <screen.json>... --out design/verify/<Screen>
//   node verify-screen.js --compare <Screen>.expected.json <measured.json> [--interactions <file>] --out design/verify/<Screen>
//
// There is NO browser in this file. `--compare` diffs two JSON files; the rendering, measuring and
// interaction-driving are the probe's job (the visual-verifier agent, or any script), and what it did
// arrives as measured.json (+ an optional --interactions file). Anything the probe did not measure is
// reported as not measured / not probed — never as passed, and never as failed.
import fs from "node:fs";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { fileHashes, gitHead, planCodeFiles, planCodeSkippedNote } from "./content-hash.ts";
import { recordPlan, writePlan } from "./plan-record.ts";
import { readDocFile, readJsonFile } from "./catalog-input.ts";
import {
  isInteractionEvidenceList, isMeasuredComponentList, isPageIndex, isPagesRootIndex, isPlan, isVerifyExpectation, isVerifyMeasured, isVerifyReport,
  readableMeasured,
} from "./doc-guards.ts";
import { isPassingVerdict, waiversHash } from "./plan-waivers.ts";
import { STATUS_PHASES, TERMINAL_PHASES, readStatusAt, statusFile, statusMain, waitMain } from "./verify-run.ts";
import { writeFileAtomic } from "../bridge/src/atomic-write.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";
import { cliParse, scriptCmd, shellArg } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import type { ArtifactCheck, CodeInputs, IndexRow, InteractionEvidence, JsonValue, MeasuredComponent, Plan, PlanWaiver, ScreenDoc, VerifyDelta, VerifyReport } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { errMsg } from "../bridge/src/errmsg.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { EXPORT_DIR, PLAN_DIR, VERIFY_DIR, listPlans } from "../bridge/src/project-layout.ts";
import { TEXT_BOX_HEIGHT, fmt, resolveInside, samePlanFile } from "./verify-shared.ts";
import type { ChosenPlan } from "./verify-shared.ts";
import { buildExpectation } from "./verify-expect.ts";
import type { ExpectInput, ExpectOptions } from "./verify-expect.ts";
import { compare, isIntegrityReason } from "./verify-compare.ts";
import { probeLine, reportToMarkdown } from "./verify-report-md.ts";

// Defaulting `--out` to the input's own basename only helps when the caller actually uses that default.
// An explicit `--out <nickname>` — which both the verify skill's own `<Screen>` placeholder and
// build-screen's `<Layer>__<id>` convention invite, under two different names for the SAME node — would
// write a second, complete artefact set with no warning.
// Scans a directory's own `*.expected.json` files (never a subdirectory — one screen, one flat
// design/verify/) for one whose `frame.nodeId` already matches, at a DIFFERENT basename than the one
// about to be written. Returns that file's path, or null.
// what the last verify run of <base> says about the artefacts beside an expectation — for --expect's notes.
// failed/blocked: its measured/report files are partial; a non-terminal phase older than --wait's stall (300 s): it never
// finished; younger: a run is measuring right now; v1: a hand-written status, not checked. done (or none): nothing to say.
const STATUS_STALL_MS = 300_000;
function runStatusNote(base: string, now = Date.now()): string | null {
  const found = readStatusAt(base);
  if (!found) return null;
  const st = found.status, name = path.basename(base);
  if (st === "v1") return `${found.file} is a hand-written status (no run id) — not checked`;
  const detail = st.detail ? ` (${st.detail})` : "";
  if (st.phase === "failed" || st.phase === "blocked") return `the last run of ${name} (run ${st.runId}) ended at phase ${st.phase}${detail} — its measured/report files are partial; this expectation is safe to re-measure against`;
  if (TERMINAL_PHASES.includes(st.phase)) return null;
  const age = now - Date.parse(st.at);
  if (Number.isFinite(age) && age >= STATUS_STALL_MS) return `the last run of ${name} (run ${st.runId}) never finished — still at phase ${st.phase}${detail}, ${Math.round(age / 1000)} s ago; its measured/report files are partial`;
  return `a run of ${name} (run ${st.runId}) is in progress — phase ${st.phase}${detail}${Number.isFinite(age) ? `, ${Math.round(age / 1000)} s ago` : ""}; it measures against the expectation it started with`;
}

// a replaced expectation's previous bytes, one generation (overwritten). Never `*.expected.json`, so no scan
// (findExistingExpectedFor, verify-build's report lookup, the run's expectation) ever takes it for a live one.
const PREV_EXPECTED_SUFFIX = ".expected.prev.json";

function findExistingExpectedFor(dir: string, nodeId: string | undefined, ownTarget: string): string | null {
  if (!nodeId || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".expected.json")) continue;
    const full = path.join(dir, f);
    if (path.resolve(full) === path.resolve(ownTarget)) continue;
    // an expectation this repo wrote — only frame.nodeId is looked at
    const doc = readJsonOrNull(full, isJsonObject);
    if (doc && isJsonObject(doc.frame) && doc.frame.nodeId === nodeId) return full;
  }
  return null;
}

// The plan(s) under design/plan/ (relative to the working directory) that describe this frame: by the frame's
// node id (plan.nodeId, or a `<Layer>__<id>` file name) or by name (the plan's own stem, or its export's).
function plansFor(frameId: string | undefined, stem: string): Array<{ file: string; plan: Plan }> {
  const hits: Array<{ file: string; plan: Plan }> = [];
  for (const f of listPlans(PLAN_DIR)) {
    // a plan under design/plan/ (plan-skeleton.ts); one that is not a readable plan describes nothing
    const p = readJsonOrNull(path.join(PLAN_DIR, f), isPlan);
    if (!p) continue;
    const byId = frameId && (p.nodeId === frameId || new RegExp(`__${String(frameId).replace(":", "_")}$`).test(path.basename(f, ".json")));
    const byName = path.basename(f, ".json") === stem || (p.file && path.basename(String(p.file), ".json") === stem);
    if (byId || byName) hits.push({ file: path.join(PLAN_DIR, f).split(path.sep).join("/"), plan: p });
  }
  return hits;
}

/** ONE plan-selection rule for --expect and --compare (they must pick the same plan, or the plan's
 *  interactions[] hash can never agree and the run stays incomplete). --plan; else the one plan in design/plan/ that
 *  describes this frame; else, among several, the one that lists files[]; else none (`all` names the candidates). */
function choosePlan(flagged: { file: string; plan: Plan } | undefined, frameId: string | undefined, stem: string): { hit?: ChosenPlan; all: Array<{ file: string; plan: Plan }> } {
  if (flagged) return { hit: { ...flagged, choice: "flag" }, all: [flagged] };
  const all = plansFor(frameId, stem);
  if (all.length === 1 && all[0]) return { hit: { ...all[0], choice: "only" }, all };
  const withFiles = all.filter((h) => h.plan.files);
  if (withFiles.length === 1 && withFiles[0]) return { hit: { ...withFiles[0], choice: "files" }, all };
  return { all };
}

/** --accept's selection: the report deltas one waiver row each is written for, or why there are none. */
function selectForAccept(rep: VerifyReport, sel: { node?: string | undefined; field?: string | undefined; group?: string | undefined }): { deltas: VerifyDelta[] } | { error: string } {
  // L-c: a report whose run failed its integrity checks graded numbers nothing ties to this design and run — a
  // waiver written from it would bind to values that may never have been rendered
  // the integrity reasons compare recorded (report.integrity); an older report has only why[] — match its wording
  const integrity = Array.isArray(rep.integrity) ? rep.integrity : (rep.why || []).filter(isIntegrityReason);
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

export { selectForAccept, findExistingExpectedFor };

// ---------------------------------------------------------------- CLI
function main(argv: string[]): number | Promise<number> {
  const sha = (file: string): string => sha256Hex(fs.readFileSync(file));
  const USAGE =
    "usage:\n" +
    `  ${scriptCmd("verify-screen")} --expect <screen.json>... --out design/verify/<Screen> [--force] [--plan <plan.json>]\n` +
    "      writes <Screen>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      The plan for this frame (--plan, else the one plan in design/plan/ that describes it) adds its interactions[]\n" +
    "      ({nodeId, trigger, expect: dialog|url|selector:<css>, destinationId?}) the export cannot carry; a row that cannot\n" +
    "      be graded is dropped with why. Their hash binds the expectation: change them → re-run --expect.\n" +
    "      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.\n" +
    "      Refuses (exit 1) if the same node already has an expectation under a DIFFERENT name in this\n" +
    "      directory — pass --force to write a second one anyway. Replacing one that differs keeps the old bytes as\n" +
    "      <Screen>.expected.prev.json (one generation) and says why: the export changed, or verify-screen did (same export\n" +
    "      content). It notes a last run of <Screen> that failed, was blocked or never finished (its files are partial).\n" +
    `  ${scriptCmd("verify-screen")} --compare <Screen>.expected.json <measured.json> [--interactions <file>] [--against <report.json>] [--plan <plan.json>] [--record-plan] --out design/verify/<Screen>\n` +
    "      writes <Screen>.report.json + .md and exits 1 unless the verdict passes (pass / pass-with-deviations). It has NO browser: it compares\n" +
    "      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n" +
    "      (a JSON array, or {interactions:[…], components:[…], inferred:[…]}, of {nodeId, trigger, ok, selector, selectorCount, detail};\n" +
    "      components[] rows {setName|nodeId, present} are merged with measured.json's; inferred[] rows {nodeId?, state, built, why?}\n" +
    "      — what the build does that the design never drew — are listed under 'Inferred, not designed', never graded).\n" +
    "      --out defaults to design/verify/<the .expected.json file's own basename>.\n" +
    "      Coverage is compared with the report this run overwrites (or --against <report.json>): a drop in nodes\n" +
    "      measured prints COVERAGE FELL, a different probe prints 'probe changed'. Neither changes the verdict.\n" +    "      Integrity first: a measured file naming no or another expectation, or a run status not finished / naming another\n" +
    "      measured file, makes the verdict 'incomplete' even with high mismatches (the numbers belong to an unverified run).\n" +
    "      The plan for this frame (--plan <plan.json>; else the plan file --expect merged interactions from, while it exists;\n" +
    "      else design/plan/ as at --expect) supplies waivers[] and descopes[]: an accepted\n" +
    "      delta stays listed but leaves the counts; with nothing else open the verdict is 'pass-with-deviations' (exit 0).\n" +
    "      --record-plan: then writes the tool-owned keys of that plan's verification block from the report (mode, renderer,\n" +
    "      artifacts, open high/medium deltas, a11y, recorded{report sha, verdict, counts}); hand keys (coverage, notes) stay.\n" +
    "      No plan, or several and no --plan: exit 2 before comparing. A failed record — e.g. a report outside the project\n" +
    "      (the plan records project-relative paths only) — leaves the report written (exit 1).\n" +
    `  ${scriptCmd("verify-screen")} --accept <Screen>.report.json (--node <id> (--field <label> | --all-fields) | --group <gid>) --reason "<why>" --by "<who>" [--plan <plan.json>]\n` +
    "      writes one plan waiver per node + field from the report's delta(s), bound to the export content, the designed\n" +
    "      and the built value (any change reopens it). Only on the owner's explicit word. Refuses a node with no delta:\n" +
    "      absent components, failed interactions and unmeasured nodes are never waivable. Re-run --compare to apply.\n" +
    `  ${scriptCmd("verify-screen")} --status <Screen> --phase <${STATUS_PHASES.join("|")}> [--run <id> | --new-run] [--detail "…"] [--by agent|orchestrator] [--dir design/verify] [--publish <stageDir>]\n` +
    "      writes the run's LIVE status (status v2: runId, rev, machine time) atomically in the run cache —\n" +
    "      node_modules/.cache/designtwin-verify/<Screen>.status.json (the project's: the nearest package.json at or above <dir>, or the\n" +
    "      workspace root its dependencies are hoisted to, never past .git; the OS temp dir, not shared between sandboxed and unsandboxed\n" +
    "      commands, with no package.json or Yarn PnP) — <dir> resolves against the cwd — outside every dev-server\n" +
    "      watch, so a heartbeat never reloads the page being measured — and prints `run <id> rev <n>` (stdout), the live file and the run's\n" +
    "      stage dir (stderr). A run that has ended (done/failed/blocked) takes no more writes, with or without --run (exit 2: start a --new-run). `done` checks first — refuses (exit 1)\n" +
    "      a missing measured file (the staged one when --publish holds it), one measured against another expectation, in another run, or\n" +
    "      not the one the probe recorded in this run — then publishes, records the sha256 of <Screen>.expected/.measured.json (and\n" +
    "      .evidence.json when this run published it), and writes the final status into <dir>/<Screen>.status.json. --publish copies every\n" +
    "      file of a staging directory into <dir> (tmp file in <dir>, then rename) — stage in the run cache while any page of the app is open.\n" +
    `  ${scriptCmd("verify-screen")} --wait <Screen> --run <id> [--timeout <s>=1200] [--stall <s>=300] [--interval <s>=2] [--dir design/verify]\n` +
    "      waits (on the live status, else <dir>/<Screen>.status.json) until run <id> is done and <Screen>.measured.json is the file it\n" +
    "      names, then prints the --compare command (exit 0; with --interactions only for evidence this run published);\n" +
    "      exit 1 when the run failed or is blocked (prints why), 5 on timeout or when the status did not change for --stall seconds,\n" +
    "      6 when the run cache exists but cannot be read.\n" +
    "exit (--status): 0 wrote · 1 refused · 2 usage · 6 the run cache is not writable (sandbox write scope? — run from the project root).";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); return argv.length ? 0 : 2; }

  const OPTIONS = {
    out: { type: "string" }, interactions: { type: "string" }, against: { type: "string" }, force: { type: "boolean" }, expect: { type: "boolean" }, compare: { type: "boolean" },
    accept: { type: "boolean" }, node: { type: "string" }, field: { type: "string" }, group: { type: "string" }, reason: { type: "string" }, by: { type: "string" }, plan: { type: "string" }, "all-fields": { type: "boolean" },
    status: { type: "string" }, wait: { type: "string" }, phase: { type: "string" }, run: { type: "string" }, "new-run": { type: "boolean" }, detail: { type: "string" },
    dir: { type: "string" }, publish: { type: "string" }, timeout: { type: "string" }, stall: { type: "string" }, interval: { type: "string" },
    "record-plan": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("verify-screen", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  // the run's status file and the wait on it — the tools write machine time, rev and shas, never the agent
  const runFlags = ["phase", "run", "new-run", "detail", "dir", "publish", "timeout", "stall", "interval"] as const;
  if (flags.status !== undefined || flags.wait !== undefined) {
    if (flags.status !== undefined && flags.wait !== undefined) { console.error("pass --status or --wait, not both\n" + USAGE); return 2; }
    const other = (["expect", "compare", "accept", "out", "interactions", "against", "force", "node", "field", "group", "reason", "plan", "all-fields", "record-plan"] as const).filter((k) => flags[k] !== undefined);
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
  const { out, interactions: interactionsFile, against: againstFile, plan: planFlag } = flags;
  const force = !!flags.force, doExpect = !!flags.expect, doCompare = !!flags.compare, doAccept = !!flags.accept;
  if ([doExpect, doCompare, doAccept].filter(Boolean).length !== 1) { console.error("pass exactly one of --expect / --compare / --accept\n" + USAGE); return 2; }
  for (const k of ["node", "field", "group", "reason", "by", "all-fields"] as const) if (flags[k] !== undefined && !doAccept) { console.error(`--${k} only applies to --accept\n` + USAGE); return 2; }
  if (doAccept) return acceptMain(files, flags, USAGE);
  if (interactionsFile !== undefined && !doCompare) { console.error("--interactions only applies to --compare\n" + USAGE); return 2; }
  if (againstFile !== undefined && !doCompare) { console.error("--against only applies to --compare\n" + USAGE); return 2; }
  const recordPlanFlag = !!flags["record-plan"];
  if (recordPlanFlag && !doCompare) { console.error("--record-plan only applies to --compare\n" + USAGE); return 2; }

  const write = (base: string | undefined, obj: unknown, md?: string): void => {
    if (!base) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); return; }
    // atomic (tmp beside the target, then rename) — a reader never sees half a report or expectation
    writeFileAtomic(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md) writeFileAtomic(base + ".report.md", md);
    console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md ? " and " + base + ".report.md" : ""}`);
  };

  if (doExpect) {
    const firstFile = files[0];
    if (firstFile === undefined) { console.error("--expect needs at least one screen export\n" + USAGE); return 2; }
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
    const outBase0 = out || path.join(VERIFY_DIR, path.basename(firstFile, ".json"));
    // the plan's interactions[] — the plan --compare will pick too (choosePlan)
    let flagged: { file: string; plan: Plan } | undefined;
    if (planFlag !== undefined) {
      const r = readJson(planFlag, isPlan);
      if (!("doc" in r)) { console.error(`--plan '${planFlag}' ${r.error}`); return 2; }
      flagged = { file: planFlag.split(path.sep).join("/"), plan: r.doc };
    }
    const firstRoot = docs.map((d) => screenRoots(d.doc)[0]).find((r) => r !== undefined);
    const chosen = choosePlan(flagged, firstRoot && firstRoot.id, path.basename(outBase0));
    const planForExpect = chosen.hit;
    if (chosen.all.length > 1 && chosen.all.some((h) => h.plan.interactions !== undefined)) {
      console.error(planForExpect ? `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h) => h.file).join(", ")}) — using ${planForExpect.file}, the only one listing files[] (--compare picks the same); pass --plan <plan.json> to choose another`
        : `note  ${chosen.all.length} plans in design/plan/ describe this frame (${chosen.all.map((h) => h.file).join(", ")}) — no plan interactions merged; pass --plan <plan.json> (here and at --compare)`);
    }
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
    // `--expect` run once by base name and once by a nickname for the SAME screen would write
    // two byte-identical files (`<Layer>__<id>.expected.json` and `<Nickname>.expected.json`)
    // if nothing tied the output name to the screen's own identity. Defaulting to the FIRST
    // input file's own basename — already `<LayerName>__<node-id>` by construction (write-out.ts) —
    // means two runs against the same export file always land on the same name, whatever string the
    // caller typed on the command line.
    const outBase = outBase0;
    // Re-running --expect replaces the file in place and leaves a measurement and a report from the
    // PREVIOUS expectation beside it, undated. The file itself stays byte-deterministic —
    // the notice goes to stderr, and every report records the sha it was computed on.
    const target = outBase + ".expected.json";
    // an explicit --out under a DIFFERENT name than the one already indexing
    // this node (e.g. --out design/verify/<Nickname> when design/verify/<Layer>__<id> already
    // covers the node) is refused rather than silently creating a second artefact set.
    const dup = findExistingExpectedFor(path.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      // the existing set is under another name (a nickname). Say what it is, which name is canonical
      // (the screen file's basename, `<Layer>__<id>`), and the way out: retire the old expectation, re-run.
      const oldBase = dup.slice(0, -".expected.json".length);
      const dir = path.dirname(dup), stemOld = path.basename(oldBase);
      const oldFiles = fs.readdirSync(dir).filter((f) => f.startsWith(stemOld + ".") || f.startsWith(stemOld + "-")).sort().map((f) => path.join(dir, f));
      const canonical = path.join(path.dirname(target), path.basename(firstFile, ".json"));
      // the old set's last run, when it says something (a failed run under the nickname is partial evidence)
      const oldStatus = runStatusNote(oldBase);
      if (oldStatus) console.error(`note  ${oldStatus}`);
      if (stemOld === path.basename(canonical)) {
        console.error(
          `error  node ${exp.frame.nodeId} already has an expectation at ${dup} — refusing to also write ${target} ` +
            `(one screen, one artefact set). That is the canonical name: drop --out (the default is ${shellArg(canonical)}), or pass --force to write a second set anyway.`
        );
        return 1;
      }
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} — refusing to also write ${target} ` +
          "(one screen, one artefact set).\n" +
          `       existing set under '${stemOld}' (${oldFiles.length} file(s)): ${oldFiles.join(", ")}\n` +
          `       the canonical name for this screen is '${path.basename(canonical)}' (<Layer>__<id> — the screen file's own basename), not '${stemOld}'.\n` +
          `       To move it to the canonical name: mv ${shellArg(dup)} ${shellArg(dup + ".retired")}, then re-run this command` +
          (path.resolve(target) === path.resolve(canonical + ".expected.json") ? "" : ` with --out ${shellArg(canonical)}`) +
          ", then probe + --compare as usual — the old measured/report/PNGs stay as history under the old name.\n" +
          `       Or keep the old name: --out ${shellArg(oldBase)}. (--force writes a second, parallel set — not recommended.)`
      );
      return 1;
    }
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    const h = sha256Hex(next);
    let prevContent: JsonValue | undefined = null;
    try { if (prev !== null) { const prevDoc: unknown = JSON.parse(prev); prevContent = isJsonObject(prevDoc) ? prevDoc.exportContentSha256 : null; } } catch { /* unreadable */ }
    const onlyExportedAt = prev !== null && prev !== next && !!prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "");
    // a REPLACED expectation keeps its previous bytes (one generation) — written before the new one
    const prevFile = outBase + PREV_EXPECTED_SUFFIX;
    if (prev !== null && prev !== next && !onlyExportedAt) writeFileAtomic(prevFile, prev);
    write(outBase, exp);
    // what the last run beside this expectation says (failed/blocked, never finished, in progress, hand-written)
    const runNote = runStatusNote(outBase);
    if (runNote) console.error(`note  ${runNote}`);
    if (prev !== null && prev === next) console.error(`note  ${target} is byte-identical to the expectation on disk (same export inputs, sha256 ${h.slice(0, 12)}…) — unchanged; this says nothing about the build: re-measure to check the code`);
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
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation — re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    const lineBoxes = exp.notComparable.filter((g) => g.field === TEXT_BOX_HEIGHT).length;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) — visible layers only; ` +
      `skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ` +
      `${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable${lineBoxes ? `; ${lineBoxes} a line box taller than its fixed text box — the build chooses its line-height` : ""}) · expectation sha256 ${h.slice(0, 12)}…`);
    const ri = exp.referenceImage;
    if (ri) console.error(ri.usable ? `reference ${ri.path} ${ri.png.w}×${ri.png.h} at ${ri.scale}x (${ri.from})${ri.offset.x || ri.offset.y ? `, offset ${ri.offset.x},${ri.offset.y}` : ""}${ri.colorProfile ? ` — ${ri.colorProfile}: colours are compared without colour management` : ""}`
      : `note  no visual diff for this screen: ${ri.why}`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers — interaction coverage cannot be checked, and the report will say so rather than passing.");
    return 0;
  }

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
  // Artifacts are checked on disk, relative to the working directory (the project root), so a report
  // can never cite a screenshot that does not exist.
  const artifacts = measured.artifacts || [];
  const artifactCheck: ArtifactCheck[] = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists = !!p && fs.existsSync(p);
    return { ...ifDefined("path", p), exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), ...ifDefined("sha256", exists ? sha(p) : undefined) };
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
    const stem = path.basename(expFile, ".json").replace(/\.expected$/, "");
    // the same rule --expect used (choosePlan) — never a second way of picking the plan
    const chosen = choosePlan(flagged, frameId, stem);
    const all = chosen.all;
    const hits = all.filter((h) => h.plan.files);
    const onlyHit = hits.length === 1 ? hits[0] : undefined;
    planHit = chosen.hit;
    // the plan --expect merged interactions from (planInteractions.plan) wins over another found now —
    // --expect may have been given --plan, or design/plan/ changed since; without --plan, check the rows it merged
    const recPi = expectation.planInteractions && isJsonObject(expectation.planInteractions) && typeof expectation.planInteractions.plan === "string" ? expectation.planInteractions.plan : undefined;
    if (recPi !== undefined && !(planHit && samePlanFile(planHit.file, recPi))) {
      const r = readJson(recPi, isPlan);
      if (!("doc" in r)) recordedPlanGone = r.missing ? "no longer exists" : `is not a readable plan now (${r.error})`;
      else if (!flagged) {
        const foundNow = planHit ? ` instead of ${planHit.file}, the plan found in design/plan/ now` : all.length ? `; ${all.length} plans in design/plan/ describe this frame now (${all.map((h) => h.file).join(", ")})` : "; no plan in design/plan/ describes this frame";
        compareNotes.push(`using ${recPi} (the plan --expect merged interactions from)${foundNow} — its interactions[], waivers, descopes, anchors and navigate apply; pass --plan <plan.json> to use another`);
        console.error(`note  ${compareNotes[compareNotes.length - 1]}`);
        planHit = { file: recPi, plan: r.doc, choice: "recorded" };
      }
    }
    if (!planHit && all.length > 1) console.error(`note  ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) — no waivers/descopes applied; pass --plan <plan.json>`);
    // --record-plan writes into the plan this compare uses — none, or several and no way to choose, is a
    // usage error BEFORE anything is compared or written
    if (recordPlanFlag && !planHit) {
      console.error(all.length > 1 ? `--record-plan: ${all.length} plans in design/plan/ describe this frame (${all.map((h) => h.file).join(", ")}) — pass --plan <plan.json> to say which one records the run`
        : "--record-plan: no plan in design/plan/ describes this frame (run from the project root) — pass --plan <plan.json>");
      return 2;
    }
    if (onlyHit && onlyHit.plan.files) {
      // files[] and every module the plan's anchors/components map (a shared shell)
      code = { plan: onlyHit.file, files: fileHashes(planCodeFiles(onlyHit.plan, process.cwd()), process.cwd()), gitHead: gitHead(process.cwd()) };
      // what the code hashes leave out, beside them in the report's input notes
      const skipped = planCodeSkippedNote(onlyHit.plan, process.cwd());
      if (skipped) { compareNotes.push(`${onlyHit.file}: ${skipped}`); console.error(`note  ${compareNotes[compareNotes.length - 1]}`); }
    } else {
      console.error(hits.length ? `note  ${hits.length} plans in design/plan/ describe this frame (${hits.map((h) => h.file).join(", ")}) — the report records no code hashes, so its status cannot be tied to the code`
        : all.length ? `note  ${all.map((h) => h.file).join(", ")} list${all.length === 1 ? "s" : ""} no files[] — the report records no code hashes, so verify-build --status cannot tie it to the code`
        : "note  no plan in design/plan/ describes this frame — the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code");
    }
  }
  const planInputs = planHit ? {
    ...ifDefined("waivers", planHit.plan.waivers), ...ifDefined("descopes", planHit.plan.descopes), ...ifDefined("anchors", planHit.plan.anchors),
    waiversInput: { plan: planHit.file, sha256: waiversHash(planHit.plan) },
  } : {};
  // Same rule as --expect: default to the EXPECTATION file's own basename (stripping the
  // `.expected` suffix it was written with), so `--compare <Screen>.expected.json <measured.json>`
  // always reports under `<Screen>.report.*`, never a second name for the same screen.
  const compareBase = out || path.join(VERIFY_DIR, path.basename(expFile, ".json").replace(/\.expected$/, ""));
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
  // the run status of the measured file (<dir>/<S>.measured.json → the live status of <dir>/<S>, else the
  // published <dir>/<S>.status.json) — the same resolver --status, --wait and verify-probe --run use
  // — and, for a measured file naming its run, else the status of the expectation's dir the probe wrote it to
  // (verify-probe keys the run by the expectation's dir, so a measured file it wrote to a stage dir finds its run)
  const measuredBase = /\.measured\.json$/.test(measuredFile) ? measuredFile.replace(/\.measured\.json$/, "") : null;
  const probeBase = measuredBase !== null && typeof measured.runId === "string" && measured.runId ? path.join(path.dirname(expFile), path.basename(measuredBase)) : null;
  const found = measuredBase === null ? null : readStatusAt(measuredBase) ?? (probeBase !== null && path.resolve(probeBase) !== path.resolve(measuredBase) ? readStatusAt(probeBase) : null);
  // (status: null = looked and found none — a measured file naming its run then has nothing recording it)
  const statusOpt = found ? { status: { file: [measuredBase, probeBase].some((b) => b !== null && found.file === statusFile(b)) ? path.basename(found.file) : `${path.basename(found.file)} (live, ${found.file})`, status: found.status } }
    : measuredBase !== null ? { status: null } : {};
  // the diff PNG the probe recorded — as recorded, else the same name beside the measured file (a published stage)
  const vd: unknown = measured.visual && measured.visual.ran ? measured.visual.diff : undefined;
  let visualDiff: { path: string; exists: boolean } | null = null;
  if (typeof vd === "string" && vd) {
    const beside = path.join(path.dirname(measuredFile), path.basename(vd));
    visualDiff = fs.existsSync(vd) ? { path: vd, exists: true } : fs.existsSync(beside) ? { path: beside.split(path.sep).join("/"), exists: true } : { path: vd, exists: false };
  }
  const rep = compare(expectation, measured, { ...statusOpt, ...(readable.dropped.includes("behaviour") ? { behaviourMalformed: true } : {}), ...(readable.dropped.includes("visual") ? { visualMalformed: true } : {}), ...(visualDiff ? { visualDiff } : {}), ...(readable.notes.length || compareNotes.length ? { inputNotes: [...readable.notes, ...compareNotes] } : {}), ...ifDefined("recordedPlanGone", recordedPlanGone), ...ifDefined("interactions", extra), ...ifDefined("components", extraComponents), ...(extraInferred !== undefined ? { inferred: extraInferred } : {}), expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, ...ifDefined("code", code), ...ifDefined("against", against), ...planInputs, ...(planHit ? { plan: planHit } : {}) });
  const md = reportToMarkdown(rep);
  write(compareBase, rep, md);
  console.error(rep.headline);
  console.error(probeLine(rep));
  console.error(rep.behaviour.headline);
  console.error(rep.visual.headline);
  const nie = rep.probe.measuredIdsNotInExpectation || 0;
  if (nie) console.error(`note  ${nie} measured node id(s) are not in the expectation (e.g. ${(rep.probe.measuredIdsNotInExpectationSample || []).join(", ")}) — measured against another screen or an older expectation?`);
  for (const w of rep.waivers.reopened) console.error(`warn  waiver REOPENED ${w.nodeId} (${w.field}): ${w.why}`);
  if (rep.waivers.unused.length) console.error(`note  ${rep.waivers.unused.length} plan waiver(s)/descope(s) match nothing this round: ${rep.waivers.unused.map((w) => `${w.nodeId} (${w.field})`).join(", ")} — fixed? drop them`);
  // the report just written → the tool-owned keys of plan.verification (plan-record.ts). A failure leaves
  // the report in place and says so (exit 1): the plan then still holds the previous record.
  if (recordPlanFlag && planHit) {
    // relative to the project by REAL paths — an absolute --out through a symlink (macOS /tmp → /private/tmp) is
    // still inside the project
    const realOf = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };
    const reportRel = path.relative(realOf(process.cwd()), realOf(path.resolve(compareBase + ".report.json"))).split(path.sep).join("/");
    try {
      const r = recordPlan(planHit.file, rep, reportRel, { cwd: process.cwd() });
      for (const n of r.notes) console.error(`note  ${n}`);
      console.error(r.written ? `recorded ${reportRel} in ${planHit.file} (plan.verification)` : `${planHit.file}: plan.verification already records ${reportRel} — unchanged`);
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
function acceptMain(files: string[], flags: { node?: string | undefined; field?: string | undefined; group?: string | undefined; reason?: string | undefined; by?: string | undefined; plan?: string | undefined; "all-fields"?: boolean | undefined }, USAGE: string): number {
  const reportFile = files[0];
  if (!reportFile || files.length > 1) { console.error("--accept needs exactly one <Screen>.report.json\n" + USAGE); return 2; }
  if ((flags.node === undefined) === (flags.group === undefined)) { console.error("--accept needs exactly one of --node <id> / --group <gid>\n" + USAGE); return 2; }
  if ((flags.field !== undefined || flags["all-fields"]) && flags.group !== undefined) { console.error("--field / --all-fields go with --node, not --group\n" + USAGE); return 2; }
  // One "keep the 16px" must not also waive a copy or colour delta on the same node: name the field, or say all.
  if (flags.node !== undefined && (flags.field === undefined) === !flags["all-fields"]) { console.error("--accept --node needs exactly one of --field \"<label>\" / --all-fields\n" + USAGE); return 2; }
  const reason = (flags.reason || "").trim(), by = (flags.by || "").trim();
  if (!reason || !by) { console.error(`--accept needs ${!reason ? "--reason \"<why this deviation is intended>\"" : ""}${!reason && !by ? " and " : ""}${!by ? "--by \"<who decided>\"" : ""} — a waiver without a reason and a decider is not recorded\n` + USAGE); return 2; }
  const r = readJson(reportFile, isVerifyReport);
  if (!("doc" in r)) { console.error(`error  report: '${reportFile}' ${r.error}`); return 2; }
  const report = r.doc;
  const exportSha = report.inputs && report.inputs.exportContentSha256;
  if (!exportSha) { console.error(`error  ${reportFile} records no inputs.exportContentSha256 — re-run --expect and --compare, then accept against the new report`); return 1; }
  const sel = selectForAccept(report, { node: flags.node, field: flags.field, group: flags.group });
  if ("error" in sel) { console.error(`refused  ${sel.error}`); return 1; }

  // the plan: --plan, else the one the report was compared with, else the one that describes this report's screen
  const stem = path.basename(reportFile, ".json").replace(/\.report$/, "");
  const recorded = (report.inputs && report.inputs.waivers && report.inputs.waivers.plan) || (report.inputs && report.inputs.code && report.inputs.code.plan) || undefined;
  let planFile = flags.plan ?? (recorded && fs.existsSync(recorded) ? recorded : undefined);
  if (!planFile) {
    const hits = plansFor(report.nodeId, stem);
    const only = hits.length === 1 ? hits[0] : undefined;
    if (!only) { console.error(hits.length ? `error  ${hits.length} plans describe this screen (${hits.map((h) => h.file).join(", ")}) — pass --plan <plan.json>` : "error  no plan in design/plan/ describes this screen (run from the project root, or pass --plan <plan.json>)"); return 1; }
    planFile = only.file;
  }
  const pr = readJson(planFile, isPlan);
  if (!("doc" in pr)) { console.error(`error  plan: '${planFile}' ${pr.error}`); return 1; }
  const plan = pr.doc;
  const decidedAt = new Date().toISOString();
  const waivers: PlanWaiver[] = Array.isArray(plan.waivers) ? [...plan.waivers] : [];
  const wrote: string[] = [];
  for (const d of sel.deltas) {
    const row: PlanWaiver = { nodeId: d.nodeId, field: d.field, designed: d.expected, built: d.actual, exportContentSha256: exportSha, reason, decidedBy: by, decidedAt, ...ifDefined("cause", flags.group) };
    // one row per node + field: a new decision replaces the old one
    const at = waivers.findIndex((w) => isJsonObject(w) && w.nodeId === d.nodeId && w.field === d.field);
    if (at >= 0) waivers[at] = row; else waivers.push(row);
    wrote.push(`${at >= 0 ? "replaced" : "added"}  ${d.nodeId} ${d.name ? `(${d.name}) ` : ""}${d.field}: designed ${fmt(d.expected)}, built ${fmt(d.actual)}`);
  }
  plan.waivers = waivers;
  writePlan(planFile, plan); // atomic (a crash never leaves half a plan), in the plan file's own format
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
