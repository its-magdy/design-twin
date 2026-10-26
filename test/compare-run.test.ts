// test/compare-run.test.ts — design-to-code/compare-run.ts: what one `verify-screen --compare` reads before compare() runs
// (gatherCompareRun), on temp projects — the set its report goes to, the artefacts as they are on disk, the visual diff's
// place, the coverage baseline, the plan, the --interactions evidence, and the refusals that stop a run before anything
// is compared or written. The CLI around it (exit codes) is verify-screen.test.ts's.
// Run with:  bun test/compare-run.test.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planCodeFiles } from "../design-to-code/content-hash.ts";
import { gatherCompareRun } from "../design-to-code/compare-run.ts";
import type { CompareRun, CompareRunFlags, CompareRunRefusal } from "../design-to-code/compare-run.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import type { ArtifactCheck, MeasuredVisual, VerifyMeasured } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { malformed, screenExport } from "./fixtures.ts";

const S = "Garden_Plots__1_1";
const exp = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "1:1", name: "Garden Plots", box: { w: 100, h: 100 }, children: [] }], { exportedAt: "2026-10-26T00:00:00Z", screen: "Garden Plots" }), label: "Garden Plots" }], null);
const measure = (extra: Partial<VerifyMeasured> = {}): VerifyMeasured => ({ measuredAt: "2026-10-26T01:00:00Z", renderer: "test", viewport: "100x100", nodes: [], components: [], interactions: [], ...extra });
const sha = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A temp project with the set's expectation in `expDir` (project-relative); `put` writes a project file. */
function project(expDir = "design/verify", expectation: unknown = exp): { root: string; expFile: string; put: (rel: string, v: unknown) => string; gather: (measuredRel: string, flags?: CompareRunFlags) => CompareRun | CompareRunRefusal } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compare-run-"));
  const put = (rel: string, v: unknown): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
    return f;
  };
  const expFile = put(`${expDir}/${S}.expected.json`, expectation);
  return { root, expFile, put, gather: (measuredRel, flags = {}) => gatherCompareRun(expFile, path.join(root, measuredRel), flags, root) };
}
const ran = (r: CompareRun | CompareRunRefusal): CompareRun | null => (r.ok ? r : null);
/** a published status v2 of the set (what --status done writes) */
const status = (st: Record<string, unknown>): Record<string, unknown> => ({ schema: "designtwin/verify-status@2", rev: 4, phase: "done", detail: "", at: "2026-10-26T01:00:00Z", by: "verify-probe", ...st });

console.log("the set: where the report goes and the status base, beside the expectation:");
{
  const p = project("elsewhere");
  p.put("elsewhere/m.json", measure());
  const r = ran(p.gather("elsewhere/m.json"));
  check("[set] no --out: the report goes beside the expectation (outside design/verify), the status base is the same",
    !!r && r.set.name === S && r.set.outBase === path.join(p.root, "elsewhere", S) && r.set.statusBase === r.set.outBase && r.options.status === null);
  p.put(`elsewhere/${S}.status.json`, status({ screen: S, runId: "run-1", measuredSha256: "f".repeat(64) }));
  const st = ran(p.gather("elsewhere/m.json"));
  check("[set] the published status at the set's base is the one compare is given", st?.options.status?.file === `${S}.status.json` && st.options.status.screen === S);
  p.put(`elsewhere/Nick.expected.json`, exp);
  const legacy = gatherCompareRun(path.join(p.root, "elsewhere", "Nick.expected.json"), path.join(p.root, "elsewhere/m.json"), {}, p.root);
  check("[set] a legacy-named expectation → refused, the line names --migrate", !legacy.ok && /^error {2}.*legacy-named verify set — run verify-screen --migrate/.test(legacy.message));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the artefacts — checked on disk under the project root; a set renamed by --migrate after its run:");
{
  const p = project();
  p.put(`design/verify/${S}.png`, "png");
  const mRel = `design/verify/${S}.measured.json`;
  const mFile = p.put(mRel, measure({ runId: "run-m", artifacts: ["design/verify/Garden.png", "design/verify/gone.png"] }));
  p.put(`design/verify/${S}.status.json`, status({ screen: "Garden", runId: "run-m", measuredSha256: sha(mFile) }));
  const r = ran(p.gather(mRel));
  const rows = (r?.options.artifactCheck ?? []).filter((a): a is ArtifactCheck => typeof a === "object");
  const moved = rows[0], gone = rows[1];
  check(`[migrated] Garden.png listed, the set now ${S}: read as ${S}.png (exists, its sha), listedAs the old path (got ${JSON.stringify(moved)})`,
    !!moved && moved.path === `design/verify/${S}.png` && moved.exists && moved.image && moved.listedAs === "design/verify/Garden.png" && moved.sha256 === sha(path.join(p.root, "design/verify", `${S}.png`)));
  check("[migrated] …said in a note and in compare's input notes", !!r && r.notes.some((n) => n.startsWith("design/verify/Garden.png is listed under the set's name before --migrate (run run-m) — read as"))
    && (r.options.inputNotes ?? []).some((n) => n.startsWith("design/verify/Garden.png is listed")));
  check("[artefacts] a listed file that is not on disk → exists:false, no listedAs", !!gone && gone.path === "design/verify/gone.png" && !gone.exists && gone.listedAs === undefined);
  p.put(`design/verify/${S}.status.json`, status({ screen: "Garden", runId: "run-other", measuredSha256: sha(mFile) }));
  const other = ran(p.gather(mRel));
  const row = (other?.options.artifactCheck ?? []).find((a): a is ArtifactCheck => typeof a === "object");
  check("[migrated] another run's status → no fallback: the listed path, missing", row?.path === "design/verify/Garden.png" && row.exists === false);
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the visual diff — as recorded, else beside the measured file, else under the set's new name:");
{
  // the fields the guard reads (doc-guards.ts isMeasuredVisual) and the diff — not a full probe block
  const visual = (diff: string): MeasuredVisual => malformed<MeasuredVisual>({ version: 1, ran: true, differingPct: 1, shiftTolerantPct: 1, regions: [], diff });
  const p = project();
  p.put(`published/${S}.diff.png`, "png");
  p.put(`published/${S}.measured.json`, measure({ visual: visual(`.stage/run-1/${S}.diff.png`) }));
  const beside = ran(p.gather(`published/${S}.measured.json`));
  check(`[diff] the recorded path is gone, the same name beside the measured file is found (got ${JSON.stringify(beside?.options.visualDiff)})`,
    beside?.options.visualDiff?.exists === true && beside.options.visualDiff.path === path.join(p.root, "published", `${S}.diff.png`).split(path.sep).join("/"));
  p.put(`design/verify/${S}.recorded.diff.png`, "png");
  p.put(`published/${S}.measured.json`, measure({ visual: visual(`design/verify/${S}.recorded.diff.png`) }));
  const asRecorded = ran(p.gather(`published/${S}.measured.json`));
  check("[diff] the recorded project-relative path exists → taken as recorded", asRecorded?.options.visualDiff?.path === `design/verify/${S}.recorded.diff.png` && asRecorded.options.visualDiff.exists);
  p.put(`published/${S}.measured.json`, measure({ visual: visual("nowhere/x.diff.png") }));
  const missing = ran(p.gather(`published/${S}.measured.json`));
  check("[diff] found nowhere → the recorded path, exists:false", missing?.options.visualDiff?.path === "nowhere/x.diff.png" && missing.options.visualDiff.exists === false);
  p.put(`published/${S}.measured.json`, measure({ visual: malformed<MeasuredVisual>({ ran: "yes" }) }));
  const badVisual = ran(p.gather(`published/${S}.measured.json`));
  check("[diff] a malformed visual block → dropped with a note, visualMalformed, no diff", !!badVisual && badVisual.options.visualMalformed === true && badVisual.options.visualDiff === undefined
    && badVisual.notes.some((n) => /measured\.visual is not a visual block/.test(n)));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the coverage baseline — the report about to be overwritten, or --against:");
{
  const p = project();
  const mRel = `design/verify/${S}.measured.json`;
  p.put(mRel, measure());
  const none = ran(p.gather(mRel));
  check("[against] no report yet → no baseline, nothing noted about one", !!none && none.options.against === undefined && !none.notes.some((n) => /coverage baseline/.test(n)));
  const own = p.put(`design/verify/${S}.report.json`, "{ not json");
  const broken = ran(p.gather(mRel));
  check("[against] an unreadable implicit baseline → only a note; the run goes on with none",
    !!broken && broken.options.against === undefined && broken.notes.some((n) => n.startsWith(`${own} `) && n.endsWith("— no coverage baseline this round (it is about to be overwritten)")));
  p.put(`design/verify/${S}.report.json`, { verdict: "fail", why: [], deltas: [], inputs: {} });
  const read = ran(p.gather(mRel));
  check("[against] a readable implicit baseline is the set's own report", read?.options.against?.file === own);
  const explicit = p.gather(mRel, { against: path.join(p.root, "nope.json") });
  check("[against] an explicit --against that cannot be read → refused", !explicit.ok && explicit.message.startsWith(`--against '${path.join(p.root, "nope.json")}' `));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the plan — --record-plan needs one:");
{
  const p = project();
  const mRel = `design/verify/${S}.measured.json`;
  p.put(mRel, measure());
  const r = p.gather(mRel, { recordPlan: true });
  check("[plan] --record-plan with no plan → refused before anything is compared", !r.ok && /^--record-plan: no plan in design\/plan\/ describes this frame .*— pass --plan <plan\.json>$/.test(r.message));
  const plain = ran(p.gather(mRel));
  check("[plan] no plan without --record-plan → a note, compare runs with plan.now null and nothing to record into",
    !!plain && plain.options.plan?.now === null && plain.recordInto === null && plain.notes.some((n) => n.startsWith("no plan in design/plan/ describes this frame")));
  p.put("design/plan/Garden_Plots__1_1.json", { nodeId: "1:1", screen: "Garden Plots" });
  const withPlan = ran(p.gather(mRel, { recordPlan: true }));
  check(`[plan] a plan of the node under the project root → found and recorded into (got ${JSON.stringify(withPlan?.recordInto?.file)})`,
    withPlan?.recordInto?.file === "design/plan/Garden_Plots__1_1.json" && withPlan.options.plan?.now?.file === "design/plan/Garden_Plots__1_1.json"
    && withPlan.notes.some((n) => /lists no files\[\]/.test(n)));
  const badFlag = p.gather(mRel, { plan: path.join(p.root, "missing.json") });
  check("[plan] --plan that cannot be read → refused", !badFlag.ok && badFlag.message.startsWith(`--plan '${path.join(p.root, "missing.json")}' `));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the plan — which one (plan-binding.ts's rule over the project's design/plan/), and its code hashes:");
{
  const p = project();
  const mRel = `design/verify/${S}.measured.json`;
  p.put(mRel, measure());
  p.put("src/A.tsx", "export {}\n");
  p.put("src/B.tsx", "export {}\n");
  const codeOf = (r: CompareRun | null): string => { const c = r?.options.code; return c ? `${c.plan} ${Object.keys(c.files).join(",")}` : "none"; };
  // a plan whose nodeId names another node (its name carries the frame's id: nodeId wins), and a plan that names no node
  p.put(`design/plan/${S}.json`, { nodeId: "9:9", files: ["src/A.tsx"] });
  p.put("design/plan/Garden.json", { screen: S, files: ["src/A.tsx"] });
  const none = ran(p.gather(mRel));
  check(`[plans] a plan's nodeId wins over the id its name carries; an id-less plan describes nothing — the note names it (got ${codeOf(none)})`,
    codeOf(none) === "none" && !!none && none.notes.includes(`no plan in design/plan/ describes this frame (design/plan/Garden.json names no node — add "nodeId") — the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code`));
  // two plans of node 1:1: one by its nodeId, one by the id its name carries
  fs.rmSync(path.join(p.root, "design/plan/Garden.json"));
  p.put(`design/plan/${S}.json`, { files: ["src/A.tsx"], anchors: { "1:2": { mapModule: "@/components/Shell" } }, components: [{ name: "Badge", mapModule: "@acme/ui" }] });
  p.put("design/plan/Crates_bins.json", { nodeId: "1:1", files: ["src/B.tsx"] });
  const two = p.gather(mRel);
  check(`[plans] two plans of the node → refused naming both (got ${two.ok ? "ok" : two.message})`,
    !two.ok && two.message.startsWith(`error  node 1:1 has 2 plans (design/plan/Crates_bins.json, design/plan/${S}.json) — one node, one plan: keep one, or pass --plan`));
  const flag = ran(gatherCompareRun(p.expFile, path.join(p.root, mRel), { plan: "design/plan/Crates_bins.json" }, p.root));
  check(`[plans] --plan wins over them: its code hashes, and a note names the other (got ${codeOf(flag)})`,
    codeOf(flag) === "design/plan/Crates_bins.json src/B.tsx" && !!flag && flag.notes.includes(`using design/plan/Crates_bins.json (--plan); design/plan/ also describes node 1:1 in design/plan/${S}.json`));
  fs.rmSync(path.join(p.root, "design/plan/Crates_bins.json"));
  const one = ran(p.gather(mRel));
  const skipped = (one?.options.inputNotes ?? []).filter((n) => n.startsWith(`design/plan/${S}.json: mapModule path(s) not hashed with this plan's code: @/components/Shell, @acme/ui — `));
  check(`[plans] the one plan: its files[] hashed; an alias/package mapModule → ONE input note naming them (got ${codeOf(one)}, ${skipped.length})`,
    codeOf(one) === `design/plan/${S}.json ${planCodeFiles(one?.options.plan?.now?.plan ?? {}).join(",")}` && skipped.length === 1 && !!one && one.notes.includes(skipped[0] ?? ""));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  // the plan --expect merged interactions from (outside design/plan/) is used at --compare: the code hashes are ITS files
  const docs = [{ doc: screenExport([{ type: "FRAME", id: "1:1", name: "Garden Plots", box: { w: 100, h: 100 }, children: [] }], { exportedAt: "2026-10-26T00:00:00Z", screen: "Garden Plots" }), label: "Garden Plots" }];
  const mine = { nodeId: "1:1", interactions: [], files: ["src/A.tsx"] };
  const p = project("design/verify", buildExpectation(docs, { plan: { file: "scratch/mine.json", plan: mine } }));
  const mRel = `design/verify/${S}.measured.json`;
  p.put(mRel, measure());
  p.put("src/A.tsx", "export {}\n");
  p.put("scratch/mine.json", mine);
  p.put(`design/plan/${S}.json`, { files: ["src/A.tsx"] });
  p.put("design/plan/Crates_bins.json", { nodeId: "1:1", files: ["src/A.tsx"] });
  const rec = ran(p.gather(mRel));
  check(`[plans] the recorded plan wins over two plans of the node: its code hashes, a note that is also an input note (got ${rec?.options.code?.plan})`,
    rec?.options.code?.plan === "scratch/mine.json" && rec.options.plan?.now?.file === "scratch/mine.json"
    && (rec.options.inputNotes ?? []).some((n) => n.startsWith("using scratch/mine.json (the plan --expect merged interactions from); 2 plans in design/plan/ describe this frame now")));
  fs.rmSync(path.join(p.root, "scratch/mine.json"));
  const gone = p.gather(mRel);
  check("[plans] the recorded plan gone + two plans of the node → refused naming both", !gone.ok && /^error {2}node 1:1 has 2 plans \(design\/plan\/Crates_bins\.json, design\/plan\/Garden_Plots__1_1\.json\)/.test(gone.message));
  const e = JSON.parse(fs.readFileSync(p.expFile, "utf8")) as Record<string, unknown>;
  p.put(`design/verify/${S}.expected.json`, { ...e, planPlaceholders: { plan: "scratch/other.json", sha256: "0".repeat(64), nodeIds: [], dropped: [] } });
  const twoNamed = p.gather(mRel);
  check("[plans] an expectation whose interactions and placeholder rows name different plans → refused, both named",
    !twoNamed.ok && /names two plans — interactions from scratch\/mine\.json, placeholder rows from scratch\/other\.json/.test(twoNamed.message));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  // a --node pull of a layer inside an instance: its frame id is "I5:2;30:7", its files `<Name>__I5_2_30_7.*`; a plan named
  // for the id only (no nodeId header) describes it by the id in its name
  const e = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "I5:2;30:7", name: "Chip", box: { w: 10, h: 10 }, children: [] }], { exportedAt: "2026-10-26T00:00:00Z", screen: "Chip" }), label: "Chip" }], null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compare-run-stem-"));
  const put = (rel: string, v: unknown): string => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); return f; };
  const expFile = put("design/verify/Chip__I5_2_30_7.expected.json", e);
  const mFile = put("design/verify/Chip__I5_2_30_7.measured.json", measure());
  put("design/plan/Chip_copy__I5_2_30_7.json", { files: [] });
  const r = ran(gatherCompareRun(expFile, mFile, { recordPlan: true }, root));
  check(`[plans] the plan whose name carries an instance sublayer's id describes the frame (got ${r?.recordInto?.file})`, r?.recordInto?.file === "design/plan/Chip_copy__I5_2_30_7.json");
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("--interactions — a list, or the object form:");
{
  const p = project();
  const mRel = `design/verify/${S}.measured.json`;
  p.put(mRel, measure());
  const list = p.put("ints.json", [{ nodeId: "1:1", trigger: "on_click", ok: true }]);
  const l = ran(p.gather(mRel, { interactions: list }));
  check("[interactions] a JSON array → compare's interactions, no components", l?.options.interactions?.length === 1 && l.options.components === undefined && l.options.inferred === undefined);
  const obj = p.put("evidence.json", { components: [{ setName: "Button", present: false }], inferred: [{ state: "hover", built: "x" }] });
  const o = ran(p.gather(mRel, { interactions: obj }));
  check("[interactions] the object form → interactions [], its components, and inferred passed on unchecked",
    o?.options.interactions?.length === 0 && o.options.components?.length === 1 && Array.isArray(o.options.inferred));
  const bad = p.gather(mRel, { interactions: p.put("bad.json", { interactions: "no" }) });
  check("[interactions] neither form → refused", !bad.ok && /^--interactions .*bad\.json: expected a JSON array or \{interactions/.test(bad.message));
  const missing = p.gather(mRel, { interactions: path.join(p.root, "none.json") });
  check("[interactions] a file that is not there → refused as an input error", !missing.ok && /^error {2}interaction evidence: '/.test(missing.message));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("the inputs themselves:");
{
  const p = project();
  p.put("m.json", { nodes: "no" });
  const r = p.gather("m.json");
  check("[inputs] measurements compare cannot read → refused", !r.ok && /^error {2}probe measurements: '.*m\.json' is not probe measurements/.test(r.message));
  p.put("m2.json", measure(malformed<Partial<VerifyMeasured>>({ probe: "handmade" })));
  const hand = ran(p.gather("m2.json"));
  check("[inputs] a malformed optional extra → dropped, noted with the file name, and an input note",
    !!hand && hand.notes.some((n) => n.startsWith(`${path.join(p.root, "m2.json")}: measured.probe`)) && (hand.options.inputNotes ?? []).some((n) => n.startsWith("measured.probe")));
  check("[inputs] the shas compare records are the files'", hand?.options.expectationSha256 === sha(p.expFile) && hand.options.measuredSha256 === sha(path.join(p.root, "m2.json")));
  fs.rmSync(p.root, { recursive: true, force: true });
}

report();
