// test/report-freshness.test.ts — what a verify report was computed against (stamped at --compare), and whether it still
// holds (design-to-code/report-freshness.ts): fresh, or stale with typed reasons; a measured file bound to its expectation
// and run. Temp projects and a fake git, at the module's interface.
// Run with:  bun test/report-freshness.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { exportContentSha256 } from "../design-to-code/content-hash.ts";
import { waiversHash } from "../design-to-code/plan-binding.ts";
import { bindMeasured, codeChanged, measuredText, reportFreshness, reportInputs, stampEvidence, staleText } from "../design-to-code/report-freshness.ts";
import type { Git, StaleReason } from "../design-to-code/report-freshness.ts";
import type { Plan } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

function project(): { root: string; put: (rel: string, body: unknown) => string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-report-freshness-"));
  const put = (rel: string, body: unknown): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
    return rel;
  };
  return { root, put, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40);
const fakeGit = (head: string | null): Git => ({ head: () => head, dirty: () => (head === null ? null : false) });
const kinds = (rs: ReadonlyArray<{ kind: string }>): string[] => rs.map((r) => r.kind);

// ---------------------------------------------------------------- stamp
console.log("stamp — what --compare records about the code and the plan's waivers:");
{
  const p = project();
  p.put("src/A.tsx", "export const A = 1;\n");
  p.put("src/Shell.tsx", "export const Shell = 1;\n");
  const plan: Plan = { files: ["src/A.tsx"], anchors: { "1:1": { mapModule: "src/Shell" } }, waivers: [] };
  const fr = reportFreshness(p.root, { git: fakeGit(HEAD_A) });
  const s = fr.stamp({ file: "design/plan/A__1_1.json", plan });
  check("[stamp] code: the plan, each code file's 16-hex content hash (files[], then mapped modules) and git HEAD",
    s.code !== undefined && s.code.plan === "design/plan/A__1_1.json" && same(Object.keys(s.code.files), ["src/A.tsx", "src/Shell.tsx"])
    && s.code.files["src/A.tsx"] === sha256Hex("export const A = 1;\n").slice(0, 16) && s.code.gitHead === HEAD_A);
  check("[stamp] not a git work tree: gitHead null", reportFreshness(p.root, { git: fakeGit(null) }).stamp({ file: "x.json", plan }).code?.gitHead === null);
  check("[stamp] a plan with no files[]: no code is recorded", reportFreshness(p.root, { git: fakeGit(HEAD_A) }).stamp({ file: "x.json", plan: { anchors: {} } }).code === undefined);
  p.done();
}

console.log("stampEvidence — what a report records about the design and the run, read back by reportInputs:");
{
  const E = "e".repeat(64), M = "m".repeat(64), X = "x".repeat(64);
  const ev = stampEvidence({ expectation: { exportContentSha256: X }, expectationSha256: E, measuredSha256: M, measured: { expectationSha256: E } });
  check("[evidence] the expectation and measured shas, the expectation the measured file names, the export content hash",
    same(ev, { expectationSha256: E, measuredSha256: M, measuredAgainst: E, exportContentSha256: X }));
  check("[evidence] what is not known is left out, never written empty", same(stampEvidence({ expectation: {}, measured: {} }), {}));
  const back = reportInputs({ inputs: ev });
  check("[evidence] reportInputs reads back what was stamped", back.expectationSha256 === E && back.exportContentSha256 === X);
}

// ---------------------------------------------------------------- judge
console.log("judge — a report is fresh, or stale with reasons (by content, never a clock):");
{
  const p = project();
  const exportDoc = { screen: "Plots", exportedAt: "2026-10-01T00:00:00Z", nodes: [{ id: "1:1", type: "FRAME", name: "Plots" }] };
  const exportSha = exportContentSha256(exportDoc);
  p.put("src/A.tsx", "export const A = 1;\n");
  const expText = JSON.stringify({ frame: { nodeId: "1:1" } });
  p.put("design/verify/Plots__1_1.expected.json", expText);
  const plan: Plan = { files: ["src/A.tsx"] };
  const fr = reportFreshness(p.root, { git: fakeGit(HEAD_A) });
  const stamped = fr.stamp({ file: "design/plan/Plots__1_1.json", plan });
  const rep = (inputs: Record<string, unknown>): { inputs: Record<string, unknown> } => ({ inputs });
  const good = rep({ exportContentSha256: exportSha, expectationSha256: sha256Hex(expText), code: stamped.code, waivers: { plan: "design/plan/Plots__1_1.json", sha256: waiversHash(plan) } });
  const REL = "design/verify/Plots__1_1.report.json";
  const judge = (r: { inputs: Record<string, unknown> }, o: { plan?: Plan; exportDoc?: unknown } = {}): StaleReason[] =>
    fr.judge(REL, reportInputs(r), { plan: o.plan ?? plan, exportDoc: o.exportDoc === undefined ? exportDoc : o.exportDoc });

  check("[judge] the same design, expectation, code and waivers: fresh", judge(good).length === 0);
  check("[judge] a re-pull that only rewrote exportedAt: still fresh (timestamps stripped)", judge(good, { exportDoc: { ...exportDoc, exportedAt: "2026-10-09T00:00:00Z" } }).length === 0);
  const changed = judge(good, { exportDoc: { ...exportDoc, nodes: [{ id: "1:1", type: "FRAME", name: "Plots 2" }] } });
  check("[judge] the design changed: export-changed, with both hashes", same(kinds(changed), ["export-changed"]) && changed[0]?.kind === "export-changed" && changed[0].was === exportSha);
  check("[judge] no export to compare with: no-export", same(kinds(judge(good, { exportDoc: null })), ["no-export"]));
  check("[judge] a report recording no export hash: no-export-sha", same(kinds(judge(rep({ ...good.inputs, exportContentSha256: undefined }))), ["no-export-sha"]));
  // the gap closed: an expectation regenerated from the same export (a generator upgrade, plan interactions re-merged)
  p.put("design/verify/Plots__1_1.expected.json", JSON.stringify({ frame: { nodeId: "1:1" }, generator: 2 }));
  check("[judge] the expectation on disk is not the one compared against, the export unchanged: expectation-changed", same(kinds(judge(good)), ["expectation-changed"]));
  check("[judge] …and with no export hash recorded, expectation-changed comes first",
    same(kinds(judge(rep({ ...good.inputs, exportContentSha256: undefined }))), ["expectation-changed", "no-export-sha"]));
  p.put("design/verify/Plots__1_1.expected.json", expText);
  check("[judge] a report recording no code: no-code", same(kinds(judge(rep({ ...good.inputs, code: undefined }))), ["no-code"]));
  p.put("src/A.tsx", "export const A = 2;\n");
  const edited = judge(good);
  check("[judge] a code file edited since: code-changed, naming it", edited[0]?.kind === "code-changed" && same(edited[0].files, ["src/A.tsx"]));
  p.put("src/A.tsx", "export const A = 1;\n");
  p.put("src/Shell.tsx", "export const Shell = 1;\n");
  const mapped = judge(good, { plan: { ...plan, anchors: { "1:1": { mapModule: "src/Shell.tsx" } } } });
  check("[judge] a mapped module the report never hashed: code-changed '(not recorded)'", mapped[0]?.kind === "code-changed" && same(mapped[0].files, ["src/Shell.tsx (not recorded)"]));
  const accepted: Plan = { ...plan, waivers: [{ nodeId: "2:1", field: "width", designed: 10, built: 12, exportContentSha256: exportSha, reason: "r", decidedBy: "o", decidedAt: "2026-10-01" }] };
  check("[judge] a waiver accepted since: waivers-changed", same(kinds(judge(good, { plan: accepted })), ["waivers-changed"]) && fr.waiversChanged(reportInputs(good), accepted));
  check("[judge] an older report recording no waivers, a plan with none: fresh", judge(rep({ ...good.inputs, waivers: undefined })).length === 0);
  check("[judge] git HEAD is never a reason: another commit, the same files", judge(good, {}).length === 0
    && reportFreshness(p.root, { git: fakeGit(HEAD_B) }).judge(REL, reportInputs(good), { plan, exportDoc }).length === 0);

  // the one wording of each reason
  const R = "design/verify/Plots__1_1.report.json";
  check("[text] each reason reads as the status says it",
    staleText(R, { kind: "export-changed", was: "1".repeat(64), now: "2".repeat(64) }) === `the design changed since ${R} was computed (export content sha256 111111111111… → 222222222222…, timestamps ignored) — re-run --expect and --compare`
    && staleText(R, { kind: "expectation-changed", expectation: "design/verify/Plots__1_1.expected.json" }) === `${R} was computed against a different design/verify/Plots__1_1.expected.json than the one on disk (inputs.expectationSha256 no longer matches) — re-run --compare`
    && staleText(R, { kind: "code-changed", files: ["a", "b", "c", "d", "e", "f", "g"] }) === `${R} measured different code — changed since: a, b, c, d, e, f, +1 more — re-run --compare`
    && /^cannot find this plan's screen export to compare with design\/verify\/Plots__1_1\.report\.json's inputs\.exportContentSha256/.test(staleText(R, { kind: "no-export" })));
  p.done();
}

// ---------------------------------------------------------------- codeChanged
console.log("codeChanged — did the code change between two compares (the SAME BUILD SERVED note)?");
{
  check("[code] a file both hashed differs: changed", codeChanged({ files: { a: "1", b: "2" } }, { files: { a: "1", b: "3" } }));
  check("[code] the files both hashed agree, one only the new one hashed: unchanged", !codeChanged({ files: { a: "1" } }, { files: { a: "1", b: "3" } }));
  check("[code] no file in common: the git commits decide", codeChanged({ files: { a: "1" }, gitHead: HEAD_A }, { files: { b: "1" }, gitHead: HEAD_B })
    && !codeChanged({ files: { a: "1" }, gitHead: HEAD_A }, { files: { b: "1" }, gitHead: HEAD_A }) && !codeChanged({ files: { a: "1" } }, { files: { b: "1" } }));
  check("[code] either side unrecorded: unchanged", !codeChanged(undefined, { files: { a: "1" } }) && !codeChanged({ files: { a: "1" } }, undefined));
}

// ---------------------------------------------------------------- bindMeasured
console.log("bindMeasured — a measured file is tied to the expectation on disk and to its run:");
{
  const E = "e".repeat(64), M = "m".repeat(64), F = "f".repeat(64);
  check("[bind] names the expectation on disk, its run's, the file the run recorded: bound",
    bindMeasured({ expectationSha256: E, measured: { expectationSha256: E, runId: "r1" }, measuredSha256: M, run: { runId: "r1", measuredSha256: M } }).length === 0);
  check("[bind] names no expectation: no-expectation", same(kinds(bindMeasured({ expectationSha256: E, measured: {}, measuredSha256: M })), ["no-expectation"]));
  const other = bindMeasured({ expectationSha256: E, measured: { expectationSha256: F }, measuredSha256: M });
  check("[bind] names another expectation: other-expectation, both shas", other[0]?.kind === "other-expectation" && other[0].measured === F && other[0].current === E);
  check("[bind] taken in another run: other-run", same(kinds(bindMeasured({ expectationSha256: E, measured: { expectationSha256: E, runId: "r0" }, measuredSha256: M, run: { runId: "r1" } })), ["other-run"]));
  check("[bind] its run recorded another measured file: other-measured",
    same(kinds(bindMeasured({ expectationSha256: E, measured: { expectationSha256: E }, measuredSha256: M, run: { runId: "r1", measuredSha256: F } })), ["other-measured"]));
  check("[bind] a file that names no run beside a run: not other-run", !kinds(bindMeasured({ expectationSha256: E, measured: { expectationSha256: E }, measuredSha256: M, run: { runId: "r1" } })).includes("other-run"));
  check("[text] the one wording, as --compare's integrity reasons and verify-run's refusals print it",
    measuredText({ kind: "other-expectation", measured: F, current: E }) === "the measurements were taken against a DIFFERENT expectation (ffffffffffff… vs eeeeeeeeeeee…)"
    && measuredText({ kind: "no-expectation" }) === "measured file names no expectation (expectationSha256)"
    && measuredText({ kind: "other-run", measuredRun: "r0", run: "r1" }) === "the measured file was taken in run r0, not run r1"
    && measuredText({ kind: "other-measured", recorded: F, now: M }) === "its run names a different measured file (sha ffffffffffff…, this one mmmmmmmmmmmm…)"
    && measuredText({ kind: "other-measured", recorded: F, now: M }, "Plots.status.json") === "Plots.status.json names a different measured file (sha ffffffffffff…, this one mmmmmmmmmmmm…)");
}

report();
