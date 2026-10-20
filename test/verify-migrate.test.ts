// design-to-code/verify-migrate.ts — `verify-screen --migrate [--apply] [--dir]`: legacy-named verify sets renamed to
// `<Layer>__<id>` (a variant to `<Layer>__<id>.<slug>`), the plan's recorded paths rewritten together, a legacy set
// beside its node's canonical set retired, and every refusal (hand-edited record, open run, a taken name) leaving the
// disk as it was. Invented screens, temp projects only.
//   node test/verify-migrate.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { must, readFixture, screenExport } from "./fixtures.ts";
import { migrate, noHardLinks } from "../design-to-code/verify-migrate.ts";
import type { MigrateOpts, MigrateResult } from "../design-to-code/verify-migrate.ts";
import { recordPlan } from "../design-to-code/plan-record.ts";
import { computeStatus, recordedEdits } from "../design-to-code/verify-build.ts";
import { compare } from "../design-to-code/verify-compare.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import { STATUS_SCHEMA, liveStatusFile, writeStatus } from "../design-to-code/verify-run.ts";
import { legacyPlanHash, planHash } from "../design-to-code/content-hash.ts";
import { isPlan, isVerificationRecord } from "../design-to-code/doc-guards.ts";
import type { MeasuredBehaviour, MeasuredNode, MeasuredStyles, Plan, VerifyReportV2 } from "../design-to-code/types.ts";
import { STYLE_KEYS } from "../design-to-code/verify-shared.ts";

const VS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
const NOW = "2026-10-07T12:00:00.000Z";
const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- a real expectation + report (invented screen "Crates", node 80:1)
const exp = buildExpectation([{ doc: screenExport([{ type: "FRAME", id: "80:1", name: "Crates", box: { x: 0, y: 0, w: 1280, h: 800 }, fills: [{ type: "solid", color: "#ffffff" }],
  children: [{ type: "RECTANGLE", id: "80:2", name: "Card", box: { x: 40, y: 40, w: 200, h: 100 }, fills: [{ type: "solid", color: "#5b5fc7" }] }] }],
  { exportedAt: "2026-10-02T00:00:00Z", screen: "Crates", nodeId: "80:1" }), label: "Crates" }]);
const echo = (n: { nodeId: string }): MeasuredNode => { const styles: MeasuredStyles = {}; const src: Record<string, unknown> = { ...n }; for (const k of STYLE_KEYS) { const v = src[k]; if (v !== undefined) styles[k] = v; } return { nodeId: n.nodeId, styles, matchedBy: "tag" }; };
const nodes = exp.nodes.map(echo);
for (const n of nodes) if (n.nodeId === "80:2") must(n.styles, "styles").backgroundColor = "#ff0000";
const expText = JSON.stringify(exp, null, 2) + "\n";
const measured = { measuredAt: "2026-10-02T01:00:00Z", renderer: "playwright-chromium", nodes, artifacts: ["design/verify/Crates.png"], expectationSha256: sha256(expText) };
const behaviour: MeasuredBehaviour = { version: 1, ran: true, browser: { name: "chromium", version: "153.0" }, namesComputedBy: "Playwright (Chromium)", budgetMs: 90000, elapsedMs: 1000, cut: false,
  checks: [{ id: "a11y.landmarks", status: "pass", detail: "1 main" }], landmarks: [], axe: { ran: true, package: "axe-core", version: "4.13.0", violations: [] }, widths: [], artifacts: [] };
const rep: VerifyReportV2 = compare(exp, { ...measured, behaviour }, {});
const repText = JSON.stringify(rep, null, 2) + "\n";

// ---------------------------------------------------------------- a project
interface Project { root: string; put(rel: string, body: unknown): void; ls(): string[]; planText(): string; plan(): Plan }
const REL = "design/plan/Crates.json";
/** A project with a legacy set `<set>` of node 80:1 (expectation, measured, report + md, screenshot, diff, published status),
 *  an export index naming 80:1 "Crates", and a plan whose verification.recorded names the set's report. */
function project(set = "Crates", opts: { record?: boolean } = {}): Project {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-migrate-"));
  const put = (rel: string, body: unknown): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
  };
  put("package.json", "{}\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  put("design/export/pages/index.json", { pageDirs: [{ page: "P", dir: "P" }], layers: [{ name: "Crates", id: "80:1", type: "FRAME", page: "P", file: "pages/P/Crates__80_1.json" }] });
  writeSet(put, set);
  put("src/Crates.tsx", "export const Crates = () => null;\n");
  put(REL, { status: "pending", screenName: "Crates", nodeId: "80:1", files: ["src/Crates.tsx"], anchors: { "80:1": { mapModule: "src/Crates.tsx" } },
    verification: { coverage: { rendered: ["default"], notChecked: [] } } });
  if (opts.record !== false) recordPlan(REL, rep, `design/verify/${set}.report.json`, { cwd: root, now: NOW });
  const verify = path.join(root, "design", "verify");
  return { root, put, ls: () => fs.readdirSync(verify).sort(), planText: () => fs.readFileSync(path.join(root, REL), "utf8"), plan: () => readFixture(path.join(root, REL), isPlan) };
}
/** One verify set's files under `<set>`, the bytes a run writes (the report names its artifact by the set's name). */
function writeSet(put: (rel: string, body: unknown) => void, set: string, id = "80:1"): void {
  const d = "design/verify/" + set;
  put(d + ".expected.json", id === "80:1" ? expText : JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: id, name: "Other" } }, null, 2) + "\n");
  put(d + ".measured.json", { ...measured, artifacts: [`${d}.png`] });
  put(d + ".report.json", repText);
  put(d + ".report.md", "# report\n");
  put(d + ".png", "png");
  put(d + "-diff.png", "diff");
  put(d + ".status.json", { schema: STATUS_SCHEMA, screen: set, runId: "r0", rev: 3, phase: "done", detail: "", at: "2026-10-02T01:00:00Z", by: "agent" });
}
const run = (p: Project, apply: boolean, extra: Partial<MigrateOpts> = {}): { r: MigrateResult; out: string[]; err: string[] } => {
  const out: string[] = [], err: string[] = [];
  const r = migrate({ cwd: p.root, verifyDir: "design/verify", apply, out: (l) => out.push(l), err: (l) => err.push(l), ...extra });
  return { r, out, err };
};
const cli = (p: Project, ...args: string[]) => spawnSync(process.execPath, [VS, ...args], { cwd: p.root, encoding: "utf8" });
const recOf = (plan: Plan) => must(isVerificationRecord(plan.verification?.recorded) ? plan.verification?.recorded : undefined, "recorded@2");
const SET_FILES = ["expected.json", "measured.json", "report.json", "report.md", "png", "status.json"];

console.log("dry run (the default):");
{
  const p = project();
  const before = p.ls(), planBefore = p.planText();
  const { r, out } = run(p, false);
  check(`one rename step: Crates -> Crates__80_1, its 7 files and the plan (got ${JSON.stringify(r.steps.map((s) => s.kind))})`,
    r.steps.length === 1 && r.steps[0]?.kind === "rename" && r.steps[0].to === "Crates__80_1" && r.steps[0].files.length === 7 && r.steps[0].plans.length === 1);
  check("it prints what it would do", out.some((l) => l.startsWith("would migrate design/verify/Crates -> Crates__80_1 (node 80:1): 7 file(s)")) && out.some((l) => l === "  rename  Crates-diff.png -> Crates__80_1-diff.png")
    && out.some((l) => l.startsWith("  plan    design/plan/Crates.json: ")));
  check("…and writes nothing (the verify dir and the plan's bytes unchanged)", JSON.stringify(p.ls()) === JSON.stringify(before) && p.planText() === planBefore);
  const c = cli(p, "--migrate");
  check(`the CLI's dry run exits 0, writes nothing, and says to pass --apply (exit ${c.status})`, c.status === 0 && /would migrate design\/verify\/Crates -> Crates__80_1/.test(c.stdout) && /pass --apply/.test(c.stderr)
    && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\n--apply renames the set and the plan's recorded paths together:");
{
  const p = project();
  const shaBefore = new Map(SET_FILES.map((s) => [s, sha256(fs.readFileSync(path.join(p.root, "design/verify/Crates." + s)))] as const));
  const recBefore = recOf(p.plan());
  const stBefore = computeStatus(p.plan(), { cwd: p.root, planFile: path.join(p.root, REL) });
  const c = cli(p, "--migrate", "--apply");
  check(`exit 0 (got ${c.status}: ${c.stderr.trim().split("\n").pop() ?? ""})`, c.status === 0);
  const ls = p.ls();
  check(`every file of the set is renamed, none left under the old name (got ${JSON.stringify(ls)})`,
    JSON.stringify(ls) === JSON.stringify(["Crates__80_1-diff.png", ...SET_FILES.map((s) => "Crates__80_1." + s)].sort()));
  check("no sha-bound byte rewritten: each file's bytes are the old file's", SET_FILES.every((s) => sha256(fs.readFileSync(path.join(p.root, "design/verify/Crates__80_1." + s))) === shaBefore.get(s)));
  const plan = p.plan(), rec = recOf(plan);
  check(`recorded.report, recorded.a11y.report and recorded.artifacts name the new files (got ${JSON.stringify([rec.report, rec.a11y?.report, rec.artifacts])})`,
    rec.report === "design/verify/Crates__80_1.report.json" && rec.a11y?.report === "design/verify/Crates__80_1.report.json"
    && JSON.stringify(rec.artifacts) === JSON.stringify(recBefore.artifacts.map((a) => a.replace("/Crates.", "/Crates__80_1.")))
    && rec.reportSha256 === recBefore.reportSha256 && rec.at === recBefore.at);
  check("screen/file/nodeId untouched", plan.screenName === "Crates" && plan.nodeId === "80:1" && plan.file === undefined);
  const edits = recordedEdits(plan, p.root);
  check(`recordedEdits stays [] (got ${JSON.stringify(edits)})`, edits.length === 0);
  const st = computeStatus(plan, { cwd: p.root, planFile: path.join(p.root, REL) });
  const renamed = (x: string[]): string => JSON.stringify(x).replaceAll("design/verify/Crates.", "design/verify/Crates__80_1.");
  check(`verify-build reads the plan as before: the same status and reasons, the renamed report found (before ${stBefore.status}, after ${st.status})`,
    st.status === stBefore.status && renamed(stBefore.reasons) === JSON.stringify(st.reasons) && st.reports.some((x) => x.rel === "design/verify/Crates__80_1.report.json"));
  const again = cli(p, "--migrate", "--apply");
  check(`a second run has nothing to do (exit ${again.status}) and changes nothing`, again.status === 0 && /nothing to migrate/.test(again.stderr) && JSON.stringify(p.ls()) === JSON.stringify(ls));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nthe live status moves with the set; the hook's record is re-stamped only when it held the older formula:");
{
  const p = project();
  const live = liveStatusFile(path.join(p.root, "design/verify/Crates"));
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, JSON.stringify({ schema: STATUS_SCHEMA, screen: "Crates", runId: "r0", rev: 3, phase: "done", detail: "", at: "2026-10-02T01:00:00Z", by: "agent" }));
  const plan0 = p.plan();
  const v = must(plan0.verification, "verification");
  v.hook = { result: "pass", checkedAt: NOW, blocking: [], warnings: 0, planHash: legacyPlanHash(plan0), files: {} };
  fs.writeFileSync(path.join(p.root, REL), JSON.stringify(plan0, null, 2) + "\n");
  const dry = run(p, false);
  check(`the dry run lists the live status among what moves (got ${JSON.stringify(dry.out.filter((l) => l.startsWith("  live")))})`,
    dry.out.includes("  live    node_modules/.cache/designtwin-verify/Crates.status.json -> Crates__80_1.status.json"));
  const { r, err } = run(p, true);
  const plan = p.plan();
  check(`migrated (got ${JSON.stringify(r.done)}; ${err.join(" | ")})`, JSON.stringify(r.done) === JSON.stringify(["Crates"]));
  check("the live status is under the new name in the run cache", !fs.existsSync(live) && fs.existsSync(liveStatusFile(path.join(p.root, "design/verify/Crates__80_1"))));
  check("a hook record under the older formula is re-stamped with the current one", plan.verification?.hook?.planHash === planHash(plan));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nrefusals leave the disk as it was:");
{
  const p = project();
  const plan0 = p.plan();
  recOf(plan0).verdict = "pass"; // a hand edit of the tool's block
  fs.writeFileSync(path.join(p.root, REL), JSON.stringify(plan0, null, 2) + "\n");
  const before = p.ls(), planBefore = p.planText();
  const { r, err } = run(p, true);
  check(`a plan with a hand-edited record: the set is skipped with the block (got ${JSON.stringify(r.skipped)})`,
    r.skipped.length === 1 && /hand-edited record/.test(r.skipped[0]?.why[0] ?? "") && (r.skipped[0]?.why ?? []).some((w) => /verification\.recorded\.verdict is tool-owned/.test(w)) && err.some((l) => l.startsWith("skip    design/verify/Crates:")));
  check("…nothing renamed, the plan untouched", JSON.stringify(p.ls()) === JSON.stringify(before) && p.planText() === planBefore);
  const c = cli(p, "--migrate", "--apply");
  check(`…and the CLI exits 1 (got ${c.status})`, c.status === 1);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  fs.writeFileSync(path.join(p.root, "design/verify/Crates.report.json"), repText.replace("\n}\n", ',\n  "extra": 1\n}\n')); // the report rewritten since the record
  const before = p.ls();
  const { r } = run(p, true);
  check(`a record whose reportSha256 no longer names the report on disk: skipped (a rename would hide it) (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.skipped.length === 1 && /reportSha256 does not name design\/verify\/Crates\.report\.json/.test(r.skipped[0]?.why[0] ?? "") && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  writeStatus(path.join(p.root, "design/verify/Crates"), { runId: "r9", phase: "measuring", by: "agent" });
  const before = p.ls(), planBefore = p.planText();
  const { r } = run(p, true);
  check(`an open run of the set: skipped (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`, r.skipped.length === 1 && /run r9 of Crates is open \(phase measuring/.test(r.skipped[0]?.why[0] ?? ""));
  check("…nothing renamed, the plan untouched", JSON.stringify(p.ls()) === JSON.stringify(before) && p.planText() === planBefore);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  p.put("design/verify/Crates__80_1-diff.png", "someone else's");
  const before = p.ls();
  const { r } = run(p, true);
  check(`a new name already taken: refused (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`, r.skipped.length === 1 && /refusing to replace Crates__80_1-diff\.png/.test(r.skipped[0]?.why[0] ?? "") && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Mystery", { record: false });
  fs.writeFileSync(path.join(p.root, "design/verify/Mystery.expected.json"), "{}\n");
  fs.writeFileSync(path.join(p.root, "design/verify/Mystery.report.json"), "{}\n");
  const { r } = run(p, false);
  check(`a set whose files name no node and whose name resolves to none: skipped (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`, r.skipped.length === 1 && /^no node id/.test(r.skipped[0]?.why[0] ?? ""));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  writeSet(p.put, "Boxes");
  const { r } = run(p, false);
  check(`two legacy sets of one node that extend no other name: both skipped (got ${JSON.stringify(r.skipped.map((s) => s.set))})`,
    JSON.stringify(r.skipped.map((s) => s.set)) === JSON.stringify(["Boxes", "Crates"]) && /extend no other name/.test(r.skipped[0]?.why[0] ?? ""));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\na plan that finds the set's report by its name alone keeps the status it had:");
/** The plan rewritten as one with no record that finds `Crates.report.json` by its own file name: static-only by hand,
 *  closed by the hook (a pass), with `nodeId` only when given. */
function byNamePlan(p: Project, nodeId?: string): void {
  const plan: Plan = { status: "pending", screenName: "Crates", ...(nodeId ? { nodeId } : {}), verification: { mode: "static-only", reason: "no renderer on this machine" } };
  must(plan.verification, "verification").hook = { result: "pass", checkedAt: NOW, blocking: [], warnings: 0, planHash: planHash(plan), files: {} };
  fs.writeFileSync(path.join(p.root, REL), JSON.stringify(plan, null, 2) + "\n");
}
const statusOf = (p: Project) => { const st = computeStatus(p.plan(), { cwd: p.root, planFile: path.join(p.root, REL) }); return { status: st.status, reasons: st.reasons, reports: st.reports.map((r) => r.rel) }; };
{
  const p = project("Crates", { record: false });
  byNamePlan(p);
  const before = statusOf(p), ls = p.ls(), planBefore = p.planText();
  const { r } = run(p, true);
  check(`setup: the plan finds the failing report by its name (got ${before.status}: ${JSON.stringify(before.reports)})`, before.status === "failed" && JSON.stringify(before.reports) === JSON.stringify(["design/verify/Crates.report.json"]));
  check(`no node id in the plan: the set is skipped, saying to add it (got ${JSON.stringify(r.skipped)})`,
    r.skipped.length === 1 && r.skipped[0]?.why[0] === 'design/plan/Crates.json finds this set only by its name — add `"nodeId": "80:1"` to it, then --migrate');
  check("…nothing renamed, the plan untouched", JSON.stringify(p.ls()) === JSON.stringify(ls) && p.planText() === planBefore);
  const after = statusOf(p);
  check(`…and computeStatus is the same as before (got ${after.status})`, JSON.stringify(after) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Crates", { record: false });
  byNamePlan(p, "80:1");
  const before = statusOf(p);
  const { r, err } = run(p, true);
  const after = statusOf(p);
  const renamed = (x: typeof before) => JSON.stringify(x).replaceAll("design/verify/Crates.report.json", "design/verify/Crates__80_1.report.json");
  check(`with the node id: migrated (got ${JSON.stringify(r.done)}; ${err.join(" | ")})`, JSON.stringify(r.done) === JSON.stringify(["Crates"]));
  check(`…computeStatus is identical before and after, the report found under its new name (before ${before.status}: ${JSON.stringify(before.reports)}; after ${after.status}: ${JSON.stringify(after.reports)})`,
    before.status === "failed" && renamed(before) === JSON.stringify(after));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Crates", { record: false });
  byNamePlan(p, "9:9");
  const before = statusOf(p);
  const { r } = run(p, false);
  check(`setup: a plan of node 9:9 finds the set by its name (got ${JSON.stringify(before.reports)})`, JSON.stringify(before.reports) === JSON.stringify(["design/verify/Crates.report.json"]));
  check(`a plan of another node: the set is skipped, naming both nodes, never told to add the set's node id (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.skipped.length === 1 && /^design\/plan\/Crates\.json is a plan of node 9:9, and finds this set \(of node 80:1\) only by its name — if the plan is of node 80:1, give it `"nodeId": "80:1"`/.test(r.skipped[0]?.why[0] ?? "")
    && !/^design\/plan\/Crates\.json finds this set only by its name — add/.test(r.skipped[0]?.why[0] ?? ""));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Crates", { record: false });
  writeSet(p.put, "Crates__80_1");
  byNamePlan(p);
  const { r } = run(p, true);
  check(`retiring: a plan that finds the legacy set by its name alone skips it too (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.skipped.length === 1 && /finds this set only by its name/.test(r.skipped[0]?.why[0] ?? "") && fs.existsSync(path.join(p.root, "design/verify/Crates.expected.json")));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nthe post-check fails → every rename undone and the plan's bytes restored:");
{
  const p = project();
  const before = p.ls(), planBefore = p.planText();
  const { r } = run(p, true, { postCheck: () => ["injected failure"] });
  check(`the set is reported skipped with the post-check's problem (got ${JSON.stringify(r.skipped.map((s) => s.why))})`,
    r.skipped.length === 1 && /every rename undone and every plan restored/.test(r.skipped[0]?.why[0] ?? "") && (r.skipped[0]?.why ?? []).some((w) => /injected failure/.test(w)));
  check("every file back under its old name", JSON.stringify(p.ls()) === JSON.stringify(before));
  check("the plan's bytes are the old ones", p.planText() === planBefore);
  fs.rmSync(p.root, { recursive: true, force: true });
}

{
  const p = project();
  const before = p.ls();
  const newer = p.planText().replace('"status": "pending"', '"status": "awaiting-user"');
  const { r } = run(p, true, { postCheck: (file) => { fs.writeFileSync(file, newer); return ["injected failure"]; } });
  const why = r.skipped[0]?.why ?? [];
  check(`a plan written again after the migration's rewrite is NOT restored over: the newer bytes stay, and it is said (got ${JSON.stringify(why)})`,
    p.planText() === newer && /undone in part/.test(why[0] ?? "") && why.some((w) => /design\/plan\/Crates\.json was written again after the migration rewrote it — left as it is/.test(w)));
  check("…the files are still renamed back, and no journal is left (no retry can settle a newer write)", JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\na run that dies part way leaves a journal; the next --apply rolls it back first:");
for (const [when, at] of [["after 3 of the moves", (a: { moved: number; plansWritten: number }) => a.moved === 3], ["after every move and the plan's rewrite", (a: { moved: number; plansWritten: number }) => a.plansWritten === 1]] as const) {
  const p = project();
  const verify = path.join(p.root, "design/verify");
  const liveOld = liveStatusFile(path.join(verify, "Crates")), liveNew = liveStatusFile(path.join(verify, "Crates__80_1"));
  fs.mkdirSync(path.dirname(liveOld), { recursive: true });
  fs.writeFileSync(liveOld, JSON.stringify({ schema: STATUS_SCHEMA, screen: "Crates", runId: "r0", rev: 3, phase: "done", detail: "", at: "2026-10-02T01:00:00Z", by: "agent" }));
  const snap = (): string => JSON.stringify({ files: p.ls().map((f) => [f, sha256(fs.readFileSync(path.join(verify, f)))]), plan: p.planText(), live: [fs.existsSync(liveOld), fs.existsSync(liveNew)] });
  const original = snap();
  let crashed = "";
  try { run(p, true, { crashAt: (a) => { if (at(a)) throw new Error("killed"); } }); } catch (e) { crashed = e instanceof Error ? e.message : String(e); }
  const journal = path.join(verify, ".migrate-Crates.json");
  check(`${when}: the run dies (got ${JSON.stringify(crashed)}), its journal is left, the disk half way`, crashed === "killed" && fs.existsSync(journal) && snap() !== original);
  const half = snap();
  const dry = run(p, false);
  check(`…a dry run reports it, plans nothing, writes nothing (got ${JSON.stringify(dry.r.skipped.map((s) => s.why[0]))})`,
    dry.r.steps.length === 0 && dry.r.skipped.length === 1 && /an interrupted migration of Crates -> Crates__80_1 .* left design\/verify\/\.migrate-Crates\.json — --migrate --apply rolls it back first/.test(dry.r.skipped[0]?.why[0] ?? "") && snap() === half);
  const dryCli = cli(p, "--migrate");
  check(`…the CLI's dry run exits 1 while it awaits its rollback (got ${dryCli.status})`, dryCli.status === 1 && snap() === half);
  const back = run(p, true, { postCheck: () => ["held here, to see the rolled-back disk"] });
  check(`…--apply rolls it back first, and the journal is gone (got rolledBack ${JSON.stringify(back.r.rolledBack)}; ${back.out.find((l) => l.startsWith("rolled back")) ?? "no 'rolled back' line"})`,
    JSON.stringify(back.r.rolledBack) === JSON.stringify(["Crates"]) && !fs.existsSync(journal));
  check("…every file, its bytes, the plan's bytes and the live status are exactly as before the first run", snap() === original);
  const again = run(p, true);
  check(`…and a clean --apply then migrates it (got ${JSON.stringify(again.r.done)})`, JSON.stringify(again.r.done) === JSON.stringify(["Crates"]) && fs.existsSync(liveNew) && p.ls().includes("Crates__80_1.report.json"));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  const synced: number[] = [];
  const realFsync = fs.fsyncSync;
  fs.fsyncSync = (fd: number): void => { synced.push(fd); realFsync(fd); };
  let r: MigrateResult;
  try { r = run(p, true).r; } finally { fs.fsyncSync = realFsync; }
  // two journal writes, each syncing its bytes and then (off Windows, where a directory cannot be opened) its directory
  const wanted = 2 * (process.platform === "win32" ? 1 : 2);
  check(`the journal is synced to disk: before the first move and before the plan's write (got ${synced.length} fsync(s), want ${wanted}; done ${JSON.stringify(r.done)})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && synced.length === wanted);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  // run B reads run A's journal, then waits for the status locks while A finishes and removes it: B rolls nothing back
  const p = project();
  const verify = path.join(p.root, "design/verify");
  const journal = path.join(verify, ".migrate-Crates.json");
  let seen = "";
  const a = run(p, true, { crashAt: (x) => { if (x.plansWritten === 1) seen = fs.readFileSync(journal, "utf8"); } });
  const done = { ls: p.ls(), plan: p.planText() };
  check(`setup: run A migrates the set, its journal (read before its end) is gone (got ${JSON.stringify(a.r.done)})`, JSON.stringify(a.r.done) === JSON.stringify(["Crates"]) && seen !== "" && !fs.existsSync(journal));
  fs.writeFileSync(journal, seen);
  const b = run(p, true, { journalRead: (f) => { fs.rmSync(f); } });
  check(`a journal removed between its read and the locks is not rolled back (got rolledBack ${JSON.stringify(b.r.rolledBack)}; ${b.err.join(" | ")})`,
    b.r.rolledBack.length === 0 && b.r.skipped.length === 0 && !b.out.some((l) => l.startsWith("rolled back")) && b.err.some((l) => /\.migrate-Crates\.json is gone: .* nothing to roll back/.test(l)));
  check("…A's migration stands: every file under its new name, the plan as A wrote it", JSON.stringify(p.ls()) === JSON.stringify(done.ls) && p.planText() === done.plan);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  p.put("design/verify/.migrate-Other.json",{ schema: "designtwin/verify-migrate-journal@1", set: "Other", to: "Other__1_1", at: NOW, live: false, moves: [{ from: "../../package.json", to: "x" }], plans: [] });
  const before = p.ls();
  const { r } = run(p, true);
  check(`a journal naming a path outside the verify dir is refused, nothing moved (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.skipped.length === 1 && /not a journal --migrate wrote/.test(r.skipped[0]?.why[0] ?? "") && JSON.stringify(p.ls()) === JSON.stringify(before) && fs.existsSync(path.join(p.root, "package.json")));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\na disk without hard links: a rename after an existence check; a name taken meanwhile is never replaced:");
check("a link's EISDIR means no hard links on Windows only (CreateHardLink on FAT/exFAT), EPERM everywhere, EEXIST nowhere",
  noHardLinks("EISDIR", "win32") && !noHardLinks("EISDIR", "darwin") && !noHardLinks("EISDIR", "linux") && noHardLinks("EPERM", "linux") && !noHardLinks("EEXIST", "win32") && !noHardLinks(undefined, "win32"));
const linkError = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
{
  const p = project();
  const { r, err } = run(p, true, { link: () => { throw linkError("EPERM"); } });
  const ls = p.ls();
  check(`every link refused with EPERM: the set is migrated by renames (got ${JSON.stringify(r.done)}; ${err.join(" | ")})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && JSON.stringify(ls) === JSON.stringify(["Crates__80_1-diff.png", ...SET_FILES.map((s) => "Crates__80_1." + s)].sort()));
  fs.rmSync(p.root, { recursive: true, force: true });
}
for (const code of ["EEXIST", "EPERM"]) {
  // another writer takes the new name between the checks and the move: the link refuses (EEXIST), or there are no
  // hard links and the existence check sees it (EPERM)
  const p = project();
  const verify = path.join(p.root, "design/verify");
  const diff = path.join(verify, "Crates-diff.png"), taken = path.join(verify, "Crates__80_1-diff.png");
  const { r } = run(p, true, { link: (_from, to) => { if (to === taken) fs.writeFileSync(to, "another writer's"); throw linkError(code); } });
  check(`${code} with the new name taken meanwhile: refused, the other file is not replaced and the set's file keeps its bytes (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.done.length === 0 && /Crates__80_1-diff\.png appeared during the move — refusing to replace it/.test(r.skipped[0]?.why[0] ?? "")
    && fs.readFileSync(taken, "utf8") === "another writer's" && fs.readFileSync(diff, "utf8") === "diff");
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nvariants: legacy `<S>@320` / `<S>.dark` → `<stem>.<slug>`; a case-only rename:");
{
  const p = project();
  writeSet(p.put, "Crates@320");
  writeSet(p.put, "Crates.dark");
  const { r, err } = run(p, true);
  check(`three sets migrated (got ${JSON.stringify(r.done)}; ${err.join(" | ")})`, JSON.stringify([...r.done].sort()) === JSON.stringify(["Crates", "Crates.dark", "Crates@320"]));
  const ls = p.ls();
  check(`Crates@320 → Crates__80_1.320, Crates.dark → Crates__80_1.dark, each with its own files (got ${JSON.stringify(ls)})`,
    ["Crates__80_1", "Crates__80_1.320", "Crates__80_1.dark"].every((s) => SET_FILES.every((x) => ls.includes(`${s}.${x}`)) && ls.includes(`${s}-diff.png`)) && !ls.some((f) => f.startsWith("Crates.") || f.startsWith("Crates@")));
  fs.rmSync(p.root, { recursive: true, force: true });
}
for (const [legacy, to] of [["Crates@320", "Crates__80_1.320"], ["Crates.dark", "Crates__80_1.dark"]] as const) {
  const p = project("Crates__80_1", { record: false });
  writeSet(p.put, legacy);
  const { r, err } = run(p, true);
  const ls = p.ls();
  check(`beside the canonical base, a lone legacy ${legacy} (the layer name + a suffix) is its variant ${to}, never retired (got ${JSON.stringify(r.steps.map((s) => s.kind === "rename" ? `${s.set} -> ${s.to}` : `${s.kind} ${s.set}`))}; ${err.join(" | ")})`,
    JSON.stringify(r.done) === JSON.stringify([legacy]) && ls.includes(`${to}.expected.json`) && ls.includes(`${to}.report.json`)
    && !ls.some((f) => f.endsWith(".retired")) && ls.includes("Crates__80_1.expected.json"));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Crates.dark", { record: false });
  const { r } = run(p, true);
  const ls = p.ls();
  check(`a lone Crates.dark with no base keeps its variant: Crates__80_1.dark (got ${JSON.stringify(ls)})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates.dark"]) && ls.includes("Crates__80_1.dark.expected.json") && !ls.includes("Crates__80_1.expected.json"));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Boxes@320", { record: false });
  const { r } = run(p, false);
  const s = r.steps[0];
  check(`a name whose prefix is not the layer name is a nickname: Boxes@320 becomes the base (got ${s?.kind === "rename" ? s.to : JSON.stringify(s)})`, s?.kind === "rename" && s.to === "Crates__80_1");
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project("Plots__1_1.Dark", { record: false });
  fs.writeFileSync(path.join(p.root, "design/verify/Plots__1_1.Dark.expected.json"), JSON.stringify({ frame: { nodeId: "1:1", name: "Plots" } }));
  fs.writeFileSync(path.join(p.root, "design/verify/Plots__1_1.Dark.report.json"), JSON.stringify({ nodeId: "1:1" }));
  const { r, err } = run(p, true);
  const ls = p.ls();
  check(`a slug in the wrong case is renamed through a temp name: Plots__1_1.Dark → Plots__1_1.dark (got ${JSON.stringify(ls)}; ${err.join(" | ")})`,
    JSON.stringify(r.done) === JSON.stringify(["Plots__1_1.Dark"]) && ls.includes("Plots__1_1.dark.expected.json") && ls.includes("Plots__1_1.dark-diff.png") && !ls.some((f) => f.includes(".Dark")) && !ls.some((f) => /\.tmp-/.test(f)));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  // a case-only rename killed between its link (temp name -> new name) and its unlink (temp name): the temp name and the
  // new name are one file, the old name is gone (on a case-insensitive disk the new name IS the old name in another case)
  const p = project("Plots__1_1.Dark", { record: false });
  const verify = path.join(p.root, "design/verify");
  fs.writeFileSync(path.join(verify, "Plots__1_1.Dark.expected.json"), JSON.stringify({ frame: { nodeId: "1:1", name: "Plots" } }));
  fs.writeFileSync(path.join(verify, "Plots__1_1.Dark.report.json"), JSON.stringify({ nodeId: "1:1" }));
  const files = p.ls();
  const moves = files.map((f) => ({ from: f, to: f.replace(".Dark", ".dark"), tmp: f + ".tmp-1-0a0b0c0d" }));
  const first = must(moves[0], "a move");
  fs.renameSync(path.join(verify, first.from), path.join(verify, first.tmp));
  fs.linkSync(path.join(verify, first.tmp), path.join(verify, first.to));
  p.put("design/verify/.migrate-Plots__1_1.Dark.json", { schema: "designtwin/verify-migrate-journal@1", set: "Plots__1_1.Dark", to: "Plots__1_1.dark", at: NOW, live: false, moves, plans: [] });
  const { r, err } = run(p, true);
  const ls = p.ls();
  check(`killed between the link and the unlink of a case-only move: --apply rolls it back, then migrates (got rolledBack ${JSON.stringify(r.rolledBack)}, done ${JSON.stringify(r.done)}; ${err.join(" | ")})`,
    JSON.stringify(r.rolledBack) === JSON.stringify(["Plots__1_1.Dark"]) && JSON.stringify(r.done) === JSON.stringify(["Plots__1_1.Dark"]));
  check(`…every file under its new name once, no temp name, no journal (got ${JSON.stringify(ls)})`,
    JSON.stringify(ls) === JSON.stringify(files.map((f) => f.replace(".Dark", ".dark")).sort()) && !fs.existsSync(path.join(verify, ".migrate-Plots__1_1.Dark.json")));
  fs.rmSync(p.root, { recursive: true, force: true });
}

{
  // a reserved slug: Crates.diff would become Crates__80_1.diff, whose screenshot <S>.diff.png is the base set's diff
  const p = project("Crates__80_1", { record: false });
  writeSet(p.put, "Crates.diff");
  const before = p.ls();
  const { r } = run(p, true);
  const s = r.steps.find((x) => x.set === "Crates.diff");
  check(`[slug] a legacy set whose variant slug is reserved (Crates.diff) is skipped, saying so; nothing moves (got ${JSON.stringify(s)})`,
    s?.kind === "skip" && s.why.some((w) => /variant 'diff' is not a slug a set can take \(reserved/.test(w)) && r.done.length === 0 && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}

{
  // [slug] a variant that overlaps a live one by "-": Crates@w320-dialog would become Crates__80_1.w320-dialog beside the live
  // Crates__80_1.w320, whose -dialog state screenshot (<set>-<state>.png) is that set's screenshot
  const p = project("Crates__80_1.w320", { record: false });
  writeSet(p.put, "Crates@w320-dialog");
  const before = p.ls();
  const { r } = run(p, true);
  const s = r.steps.find((x) => x.set === "Crates@w320-dialog");
  check(`[slug] a legacy variant that overlaps a live variant by "-" (w320-dialog / w320) is skipped, saying so; nothing moves (got ${JSON.stringify(s)})`,
    s?.kind === "skip" && s.why.some((w) => /^variant 'w320-dialog' overlaps 'w320' by "-"/.test(w) && /rename one by hand$/.test(w)) && r.done.length === 0 && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}

{
  // [slug] two legacy variants of one batch that overlap by "-": neither is renamed (which one keeps its slug is a person's call)
  const p = project("Crates__80_1", { record: false });
  writeSet(p.put, "Crates@w320");
  writeSet(p.put, "Crates@w320-dialog");
  const before = p.ls();
  const { r } = run(p, true);
  const why = (set: string): string[] => { const s = r.steps.find((x) => x.set === set); return s?.kind === "skip" ? s.why : []; };
  check(`[slug] two planned variants that overlap (w320, w320-dialog) are both skipped; nothing moves (got ${JSON.stringify(r.steps.map((x) => [x.set, x.kind]))})`,
    why("Crates@w320").some((w) => /^variant 'w320' overlaps 'w320-dialog'/.test(w)) && why("Crates@w320-dialog").some((w) => /^variant 'w320-dialog' overlaps 'w320'/.test(w))
    && r.done.length === 0 && JSON.stringify(p.ls()) === JSON.stringify(before));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\na legacy set beside its node's canonical set is retired:");
{
  const p = project("Crates", { record: false });
  writeSet(p.put, "Crates__80_1");
  const { r, out } = run(p, true);
  check(`Crates.expected.json → Crates.expected.json.retired; the canonical set untouched (got ${JSON.stringify(r.done)}; ${out.join(" | ")})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && fs.existsSync(path.join(p.root, "design/verify/Crates.expected.json.retired")) && !fs.existsSync(path.join(p.root, "design/verify/Crates.expected.json"))
    && fs.existsSync(path.join(p.root, "design/verify/Crates__80_1.expected.json")));
  check("…the line says the set's other files stay under its name", out.some((l) => l.endsWith("(node 80:1 already has design/verify/Crates__80_1; its other files stay under Crates)")) && fs.existsSync(path.join(p.root, "design/verify/Crates.report.json")));
  const again = run(p, true);
  check("a second run has nothing to do", again.r.steps.length === 0);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  // a retire killed between its link and its unlink: the expectation under both names, one file
  const p = project("Crates", { record: false });
  writeSet(p.put, "Crates__80_1");
  const from = path.join(p.root, "design/verify/Crates.expected.json");
  fs.linkSync(from, from + ".retired");
  const { r, err } = run(p, true);
  check(`an interrupted retire is finished, not refused (got done ${JSON.stringify(r.done)}, skipped ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && !fs.existsSync(from) && fs.readFileSync(from + ".retired", "utf8") === expText
    && err.some((l) => /Crates\.expected\.json and Crates\.expected\.json\.retired were one file \(a retire that was interrupted\) — finished/.test(l)));
  check("…and a second run has nothing to do", run(p, true).r.steps.length === 0);
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  writeSet(p.put, "Crates__80_1");
  const { r } = run(p, true);
  check(`…unless a plan still records the legacy report: skipped, nothing retired (got ${JSON.stringify(r.skipped.map((s) => s.why[0]))})`,
    r.skipped.length === 1 && /still records Crates\.report\.json/.test(r.skipped[0]?.why[0] ?? "") && fs.existsSync(path.join(p.root, "design/verify/Crates.expected.json")));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nthe hand-owned verification.a11y.report and verification.artifacts are rewritten, each with a note:");
{
  const p = project("Crates", { record: false });
  const plan0 = p.plan();
  const v0 = must(plan0.verification, "verification");
  v0.a11y = { tool: "axe-core", violations: 0, warnings: 0, report: "design/verify/Crates.report.md" };
  v0.artifacts = ["design/verify/Crates.png", "design/verify/Crates.report.json", "src/Crates.tsx"];
  fs.writeFileSync(path.join(p.root, REL), JSON.stringify(plan0, null, 2) + "\n");
  const { r, err } = run(p, true);
  const v = p.plan().verification;
  check(`rewritten to the renamed files, and said (got ${v?.a11y?.report}, ${JSON.stringify(v?.artifacts)}; ${err.join(" | ")})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && v?.a11y?.report === "design/verify/Crates__80_1.report.md" && err.some((l) => /verification\.a11y\.report is yours/.test(l))
    && JSON.stringify(v?.artifacts) === JSON.stringify(["design/verify/Crates__80_1.png", "design/verify/Crates__80_1.report.json", "src/Crates.tsx"]) && err.some((l) => /verification\.artifacts is yours \(hand-written\) — rewritten to the renamed files/.test(l)));
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nwhich files are the set's, and which paths a plan names, as verify-build reads them:");
{
  const p = project("Crates", { record: false });
  const m = JSON.parse(fs.readFileSync(path.join(p.root, "design/verify/Crates.measured.json"), "utf8")) as { artifacts: string[] };
  m.artifacts.push("design/verify/Crates-hover.png");
  p.put("design/verify/Crates.measured.json", m);
  p.put("design/verify/Crates-hover.png", "hover");
  p.put("design/verify/Crates-detail.png", "another screen's");
  const { r } = run(p, true);
  const ls = p.ls();
  check(`a <S>-… file the set's measured file lists moves; a stray Crates-detail.png (another screen's, maybe) stays (got ${JSON.stringify(ls)})`,
    JSON.stringify(r.done) === JSON.stringify(["Crates"]) && ls.includes("Crates__80_1-hover.png") && ls.includes("Crates-detail.png") && !ls.includes("Crates__80_1-detail.png"));
  fs.rmSync(p.root, { recursive: true, force: true });
}
{
  const p = project();
  const plan0 = p.plan();
  recOf(plan0).report = "../verify/Crates.report.json"; // relative to the plan file: verify-build reads it from the project root, and finds nothing
  fs.writeFileSync(path.join(p.root, REL), JSON.stringify(plan0, null, 2) + "\n");
  const { r } = run(p, false);
  const s = r.steps[0];
  check(`a recorded report path verify-build cannot read is not taken for the set's report: no misleading reportSha256 skip (got ${s?.kind === "skip" ? s.why[0] : s?.kind})`,
    s?.kind === "rename" && s.to === "Crates__80_1");
  fs.rmSync(p.root, { recursive: true, force: true });
}

console.log("\nthe CLI's usage:");
{
  const p = project();
  const a = cli(p, "--apply");
  const b = cli(p, "--migrate", "--out", "design/verify/X");
  const c = cli(p, "--migrate", "extra.json");
  const h = cli(p, "--help");
  check(`--apply without --migrate, --migrate with --out or a file: exit 2 (got ${a.status}, ${b.status}, ${c.status})`, a.status === 2 && b.status === 2 && c.status === 2 && /--migrate takes none of --out/.test(b.stderr));
  check("--help lists --migrate [--apply] [--dir design/verify]", h.status === 0 && /--migrate \[--apply\] \[--dir design\/verify\]/.test(h.stdout));
  check("…and its exit codes: 1 for a skip, a refusal or an interrupted migration awaiting its rollback",
    /exit \(--migrate\): 0 nothing skipped · 1 a set skipped or refused, or an interrupted migration awaits its rollback \(a dry run,\s+or --apply whose rollback could not finish\) · 2 usage\./.test(h.stdout));
  const d = cli(p, "--migrate", "--dir", "design/nowhere");
  check(`--dir naming no directory: exit 2 (got ${d.status})`, d.status === 2);
  fs.rmSync(p.root, { recursive: true, force: true });
}

report();
