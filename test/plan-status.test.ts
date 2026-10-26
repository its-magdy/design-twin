// test/plan-status.test.ts — a plan's status, computed and never stored (design-to-code/plan-status.ts): the lifecycle a
// person sets, the Stop hook's record against the plan and its code now, whether the hook still has work on the plan,
// and the status precedence over the hook's state and what the verify report says. Temp projects, at the module's
// interface; the hook records are written by hand as the hook writes them (planHash, the code hashes it holds).
// Run with:  bun test/plan-status.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { exportContentSha256, legacyPlanHash, planHash } from "../design-to-code/content-hash.ts";
import { parsePlan } from "../design-to-code/doc-guards.ts";
import { lifecycleOf, planStatus, rootOfPlan, storedComputed } from "../design-to-code/plan-status.ts";
import { waiversHash } from "../design-to-code/plan-binding.ts";
import { reportFreshness } from "../design-to-code/report-freshness.ts";
import type { Git } from "../design-to-code/report-freshness.ts";
import type { ExportHit } from "../design-to-code/verify-locate.ts";
import type { Plan, PlanHookRecord } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { screenExport } from "./fixtures.ts";

const PLAN = "design/plan/Plots__1_1.json";
function project(): { root: string; put: (rel: string, body: unknown) => string; planFile: string; done: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-plan-status-"));
  const put = (rel: string, body: unknown): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
    return rel;
  };
  return { root, put, planFile: path.join(root, PLAN), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const noGit: Git = { head: () => null, dirty: () => null };
// The record the Stop hook writes after a check of `plan` as it is now (verify-build checkAndRecord).
function hooked(root: string, plan: Plan, o: Partial<PlanHookRecord> = {}): Plan {
  const hook: PlanHookRecord = { result: "pass", checkedAt: "2026-10-22T00:00:00Z", blocking: [], warnings: 0, planHash: planHash(plan), files: planStatus(root).codeHashes(plan), ...o };
  return { ...plan, verification: { ...plan.verification, hook } };
}
// A plan as a hand edit leaves it (a key dropped, a block no tool writes): its JSON, read the way a plan file is read.
function asPlan(doc: unknown): Plan {
  const raw: unknown = JSON.parse(JSON.stringify(doc));
  const r = parsePlan(raw);
  if ("error" in r) throw new Error(r.error);
  return r.plan;
}
const WAIVER = { nodeId: "1:1", field: "font-size", designed: 14, built: 16, exportContentSha256: "", reason: "brand scale", decidedBy: "owner", decidedAt: "2026-10-22" };
const has = (xs: readonly string[], re: RegExp): boolean => xs.some((x) => re.test(x));
const STATIC = { mode: "static-only", reason: "no dev server" } as const;

// ---------------------------------------------------------------- the lifecycle a person sets
console.log("lifecycleOf / storedComputed — the states a person sets, and a status an older hook stored:");
check("[lifecycle] none → pending; \" Abandoned \" and \"Awaiting-User\" read as set (case, spaces)",
  lifecycleOf({}) === "pending" && lifecycleOf({ status: " Abandoned " }) === "abandoned" && lifecycleOf({ status: "Awaiting-User" }) === "awaiting-user");
check("[lifecycle] a stored computed value (\"verified\") or anything else is pending — not trusted",
  lifecycleOf({ status: "verified" }) === "pending" && lifecycleOf({ status: "done" }) === "pending");
const unparsable: unknown = JSON.parse('{"status":"abandoned","tokens":7}');
check("[lifecycle] the raw JSON of a plan that cannot be parsed reads the same way; a status that is not a string is none",
  lifecycleOf(unparsable) === "abandoned" && lifecycleOf({ status: ["abandoned"] }) === "pending" && lifecycleOf(null) === "pending");
check("[stored] a computed status an older hook stored is named as written (verified, static-only, verified-with-deviations); a lifecycle is not",
  storedComputed({ status: "Verified" }) === "Verified" && storedComputed({ status: "verified-with-deviations" }) === "verified-with-deviations"
  && storedComputed({ status: "static-only" }) === "static-only" && storedComputed({ status: "pending" }) === null && storedComputed({}) === null);
check("[root] a plan's project is the dir above design/plan/; any other file falls back",
  rootOfPlan(path.join("/p", "design", "plan", "A.json")) === path.resolve("/p") && rootOfPlan("/elsewhere/A.json", "/fb") === "/fb");

// ---------------------------------------------------------------- the hook's record against the plan and its code
console.log("hook / open — the Stop hook's record against the plan and its code now, and whether it still has work:");
{
  const p = project();
  p.put("src/A.tsx", "export const A = 1;\n");
  p.put("src/Shell.tsx", "export const Shell = 1;\n");
  const ps = planStatus(p.root);
  const base: Plan = { files: ["src/A.tsx"], anchors: { "1:1": { mapModule: "src/Shell.tsx" } }, verification: STATIC };
  const passed = hooked(p.root, base);
  check("[codeHashes] files[] then the mapped modules, each by content", JSON.stringify(Object.keys(ps.codeHashes(base))) === JSON.stringify(["src/A.tsx", "src/Shell.tsx"]));
  check("[hook] no record → unchecked, open", ps.hook(base).kind === "unchecked" && ps.open(base));
  const h = ps.hook(passed);
  check("[hook] the record of this plan and this code → passed, complete, closed", h.kind === "passed" && h.complete && !ps.open(passed));
  const routed = { ...passed, route: "/plots" };
  check("[hook] the plan changed since → plan-changed, open", ps.hook(routed).kind === "plan-changed" && ps.open(routed));
  const waived: Plan = { ...passed, waivers: [WAIVER] };
  check("[hook] waivers[] are not the plan's substance: still passed", ps.hook(waived).kind === "passed" && !ps.open(waived));
  const covered = asPlan({ ...passed, verification: { ...passed.verification, coverage: { rendered: ["default", "hover"], notChecked: [] } } });
  check("[hook] a hand edit of verification (coverage) after the check: still passed — planHash leaves verification out", ps.hook(covered).kind === "passed" && !ps.open(covered));
  const legacy = asPlan({ ...passed, verification: { ...passed.verification, hook: { ...passed.verification?.hook, planHash: legacyPlanHash(passed) } } });
  check("[hook] a record under the older formula (legacyPlanHash) is still accepted: passed, closed", ps.hook(legacy).kind === "passed" && !ps.open(legacy));
  const blocked = hooked(p.root, base, { result: "blocked", blocking: ["raw #5B5FC7 in src/A.tsx"] });
  const b = ps.hook(blocked);
  check("[hook] the last check blocked → blocked, with what it blocked on; open", b.kind === "blocked" && b.blocking[0] === "raw #5B5FC7 in src/A.tsx" && ps.open(blocked));
  const edited = hooked(p.root, asPlan({ ...base, verification: { ...STATIC, recorded: { note: "by hand" } } }));
  const e = ps.hook(edited);
  check("[hook] passed, then verification.recorded edited by hand (planHash leaves verification out) → edited, open",
    e.kind === "edited" && has(e.edits, /verification\.recorded holds only `note`/) && ps.open(edited));
  const noFiles = asPlan({ ...passed, verification: { ...passed.verification, hook: { ...passed.verification?.hook, files: undefined } } });
  const nf = ps.hook(noFiles);
  check("[hook] a passed record with no code hashes (or no planHash) is passed but incomplete: open, the hook records it",
    nf.kind === "passed" && !nf.complete && ps.open(noFiles)
    && ps.open(asPlan({ ...passed, verification: { ...passed.verification, hook: { ...passed.verification?.hook, planHash: undefined } } })));
  check("[open] a plan a person closed is never open, whatever its record", !ps.open({ ...base, status: "abandoned" }) && !ps.open({ ...base, status: "awaiting-user" }));

  // the code: changed, gone, added to files[], and a mapped module an older record never hashed
  fs.appendFileSync(path.join(p.root, "src/Shell.tsx"), "// edited\n");
  const s1 = ps.hook(passed);
  check("[hook] a mapped module edited since → stale, naming it; open", s1.kind === "stale" && s1.changed.join() === "src/Shell.tsx" && ps.open(passed));
  fs.rmSync(path.join(p.root, "src/A.tsx"));
  const s2 = ps.hook(passed);
  check("[hook] a files[] entry deleted → stale \"(missing)\"", s2.kind === "stale" && s2.changed.includes("src/A.tsx (missing)"));
  p.put("src/A.tsx", "export const A = 1;\n");
  p.put("src/Shell.tsx", "export const Shell = 1;\n");
  const added = hooked(p.root, base);
  const addedRec = added.verification?.hook;
  if (addedRec) delete addedRec.files["src/A.tsx"];
  const s3 = ps.hook(added);
  check("[hook] a files[] entry the record never hashed → stale \"(added to files[])\"", s3.kind === "stale" && s3.changed.includes("src/A.tsx (added to files[])"));
  const older = hooked(p.root, base);
  const olderRec = older.verification?.hook;
  if (olderRec) delete olderRec.files["src/Shell.tsx"];
  const s4 = ps.hook(older);
  check("[hook] a mapped module an older record never hashed is noted, not a change: passed, closed",
    s4.kind === "passed" && s4.unhashed.join() === "src/Shell.tsx (now hashed: mapped module)" && !ps.open(older));
  const dropped = { ...passed, anchors: {} };
  const dropRec = hooked(p.root, dropped);
  if (dropRec.verification?.hook) dropRec.verification.hook.files = { ...dropRec.verification.hook.files, "src/Shell.tsx": "0".repeat(16) };
  const s5 = ps.hook(dropRec);
  check("[hook] a file the record hashed that the plan no longer lists or maps → stale \"(no longer hashed …)\"",
    s5.kind === "stale" && has(s5.changed, /^src\/Shell\.tsx \(no longer hashed: not in files\[\] nor a mapped module that resolves\)$/));
  p.done();
}

// ---------------------------------------------------------------- the status
console.log("status — precedence over the lifecycle, the hook's state and the report:");
{
  const p = project();
  p.put("src/A.tsx", "export const A = 1;\n");
  const doc = screenExport([{ id: "1:1", type: "FRAME", name: "Plots" }], { screen: "Plots", exportedAt: "2026-10-01T00:00:00Z" });
  const exp: ExportHit = { file: "design/export/Plots__1_1.json", doc, row: null, nodeId: "1:1", layerName: "Plots", sameNameRows: 1, staleFile: null };
  const ps = planStatus(p.root);
  const base: Plan = { nodeId: "1:1", files: ["src/A.tsx"], verification: { mode: "rendered" } };
  const at = (plan: Plan) => ps.status(plan, { planFile: p.planFile, export: exp });
  const REP = "design/verify/Plots__1_1.report.json";
  // a report as --compare writes it: the export it measured, the code and waivers stamped (report-freshness.ts stamp)
  const putReport = (plan: Plan, verdict: string, extra: object = {}): void => {
    const s = reportFreshness(p.root, { git: noGit }).stamp({ file: PLAN, plan });
    p.put(REP, { schema: "designtwin/verify-report@2", screen: "Plots", verdict, headline: `${verdict.toUpperCase()} — 3/3`, why: [],
      inputs: { exportContentSha256: exportContentSha256(doc), ...s, waivers: { plan: PLAN, sha256: waiversHash(plan) } }, ...extra });
  };

  const ab = at({ ...base, status: "abandoned" }), aw = at({ ...base, status: "awaiting-user" });
  check("[1] abandoned / awaiting-user: the person's state, nothing else read",
    ab.status === "abandoned" && /retired by hand/.test(ab.reasons.join()) && aw.status === "awaiting-user" && /paused on a question/.test(aw.reasons.join()) && ab.reports.length === 0);

  const none = at(hooked(p.root, base));
  check("[6] no report, rendered → unverified, saying where to run verify-screen", none.status === "unverified" && has(none.reasons, /no verify report found for this screen in design\/verify\//));
  const stat = at(hooked(p.root, { ...base, verification: STATIC }));
  check("[6] no report, static-only → static-only with the recorded reason", stat.status === "static-only" && has(stat.reasons, /not rendered \(no dev server\)/));

  putReport(base, "pass");
  const ok = at(hooked(p.root, base));
  check("[6] the hook passed and an @2 pass measured this design, this code and these waivers → verified",
    ok.status === "verified" && ok.reasons.length === 1 && /^hook passed; design\/verify\/Plots__1_1\.report\.json says pass and measured this design and exactly these files \(by content\)$/.test(ok.reasons[0] ?? "")
    && ok.reports[0]?.rel === REP && ok.reports[0]?.matchedBy === "name");
  check("[reports] the reports a plan's status reads are the ones located for it (verify-migrate's post-check)",
    ps.reports(base, p.planFile, exp).map((r) => r.rel).join() === REP);
  putReport(base, "pass-with-deviations");
  check("[6] every report passing, one pass-with-deviations → verified-with-deviations", at(hooked(p.root, base)).status === "verified-with-deviations");
  {
    // two passing, fresh reports: the own set (matched by name) and a variant set (matched by node id) whose file name sorts
    // first — the status is judged over both, and the commit its reason names is the own report's (it was the first
    // located report's: the variant's)
    const VAR = "design/verify/Plots__1_1.narrow.report.json";
    const putAt = (rel: string, head: string): void => {
      const s = reportFreshness(p.root, { git: { head: () => head, dirty: () => null } }).stamp({ file: PLAN, plan: base });
      p.put(rel, { schema: "designtwin/verify-report@2", screen: "Plots", verdict: "pass", headline: "PASS — 3/3", why: [],
        inputs: { exportContentSha256: exportContentSha256(doc), ...s, waivers: { plan: PLAN, sha256: waiversHash(base) } } });
    };
    putAt(REP, "a".repeat(40));
    putAt(VAR, "b".repeat(40));
    const both = at(hooked(p.root, base));
    check(`[own] two passing reports, a variant's sorting first → verified over both, naming the OWN report's commit (got ${both.reasons.join(" | ")})`,
      both.status === "verified" && both.reports.map((r) => `${r.rel} ${r.matchedBy}`).join() === `${VAR} nodeId,${REP} name` && /— at git aaaaaaaaaaaa$/.test(both.reasons[0] ?? ""));
    putAt(REP, "");
    const noHead = at(hooked(p.root, base));
    check(`[own] …the own report recorded no commit → the first located report that did is named (got ${noHead.reasons.join(" | ")})`,
      noHead.status === "verified" && /— at git bbbbbbbbbbbb$/.test(noHead.reasons[0] ?? ""));
    fs.rmSync(path.join(p.root, VAR));
    putReport(base, "pass-with-deviations");
  }

  const pend = at({ ...base, status: "verified" });
  check("[3] no hook record → pending, saying so and what the report says; a stored \"verified\" is ignored and noted",
    pend.status === "pending" && has(pend.reasons, /stored "status": "verified" was not confirmed/) && has(pend.reasons, /^the build-screen Stop hook has not checked this plan$/)
    && has(pend.reasons, /^report: .* says pass/));
  const changed = hooked(p.root, base);
  const ch = at({ ...changed, route: "/plots" });
  check("[3] the plan changed after the hook's check → pending", ch.status === "pending" && has(ch.reasons, /plan changed after the hook's last check/));
  const bl = at(hooked(p.root, base, { result: "blocked", blocking: ["raw #5B5FC7 in src/A.tsx"] }));
  check("[4] the hook's last check blocked → blocked, its block first", bl.status === "blocked" && bl.reasons[0] === "raw #5B5FC7 in src/A.tsx");
  const ed = at(hooked(p.root, asPlan({ ...base, verification: { mode: "rendered", recorded: { note: "x" } } })));
  check("[4] passed, then the record edited by hand → blocked, the edit first", ed.status === "blocked" && /verification\.recorded holds only `note`/.test(ed.reasons[0] ?? ""));

  putReport(base, "pass");
  const closed = hooked(p.root, base);
  fs.appendFileSync(path.join(p.root, "src/A.tsx"), "// edited\n");
  const st = at(closed);
  check("[5] a file changed since the hook passed → stale, naming it (the report's view follows)",
    st.status === "stale" && st.reasons[0] === "file(s) changed since the hook passed: src/A.tsx" && has(st.reasons, /^report: .*measured different code — changed since: src\/A\.tsx/));
  const rehooked = at(hooked(p.root, base));
  check("[6] the hook re-checks: unverified, the report measured different code", rehooked.status === "unverified" && has(rehooked.reasons, /measured different code/));
  putReport(base, "pass");

  const waived: Plan = { ...base, waivers: [WAIVER] };
  const w = at(hooked(p.root, waived));
  check("[6] a waiver added after the compare: the hook stays passed, the report is stale (waivers changed)",
    w.status === "unverified" && !has(w.reasons, /plan changed/) && has(w.reasons, /waivers changed since the last compare/));

  putReport(base, "fail");
  const f0 = at(base);
  check("[2] a failing @2 report → failed even before the hook ran, the hook's state after it",
    f0.status === "failed" && /says verdict "fail" \(FAIL — 3\/3\)/.test(f0.reasons[0] ?? "") && has(f0.reasons, /^hook: the build-screen Stop hook has not checked this plan$/));
  const f1 = at(hooked(p.root, waived));
  check("[2] a failure stays a failure after the owner accepts something, and says to re-compare", f1.status === "failed" && has(f1.reasons, /fail.* — waivers changed since the last compare/));

  putReport(base, "incomplete");
  const inc = at(hooked(p.root, base));
  check("[6] \"incomplete\" is not a pass → unverified, quoting the headline", inc.status === "unverified" && has(inc.reasons, /INCOMPLETE — 3\/3/));
  p.put(REP, { verdict: "pass", why: [] });
  const old = at(hooked(p.root, base));
  check("[6] a report older than verify-report@2 → unverified, its verdict named but not trusted", old.status === "unverified" && has(old.reasons, /predates designtwin\/verify-report@2/));
  p.put(REP, { schema: "designtwin/verify-report@2", screen: "Plots", verdict: "pass", why: [], inputs: {} });
  const noSha = at(hooked(p.root, base));
  check("[6] an @2 pass that records no export content hash → unverified (report-freshness judge)", noSha.status === "unverified" && has(noSha.reasons, /inputs\.exportContentSha256/));

  // a mapped module an older hook record never hashed: noted after the status, never a change
  p.put("src/Shell.tsx", "export const Shell = 1;\n");
  const mapped: Plan = { ...base, anchors: { "1:1": { mapModule: "src/Shell.tsx" } } };
  putReport(mapped, "pass");
  const rec = hooked(p.root, mapped);
  if (rec.verification?.hook) delete rec.verification.hook.files["src/Shell.tsx"];
  const un = at(rec);
  check("[unhashed] still verified, with one note naming the module the hook's next check records",
    un.status === "verified" && un.reasons.length === 2 && /^hook: not hashed by the hook's last check .*src\/Shell\.tsx \(now hashed: mapped module\)/.test(un.reasons[1] ?? ""));

  // a set the plan's file name does not name, found by its expectation's frame; its expectation regenerated since
  fs.rmSync(path.join(p.root, REP));
  const EXP = JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "1:1", name: "Plots" }, hidden: { ids: [] } });
  p.put("design/verify/Plots.expected.json", EXP);
  const s = reportFreshness(p.root, { git: noGit }).stamp({ file: PLAN, plan: base });
  p.put("design/verify/Plots.report.json", { schema: "designtwin/verify-report@2", screen: "Plots", verdict: "pass", why: [],
    inputs: { exportContentSha256: exportContentSha256(doc), expectationSha256: sha256Hex(EXP), ...s, waivers: { plan: PLAN, sha256: waiversHash(base) } } });
  const byFrame = at(hooked(p.root, base));
  check("[reports] a set found through its expectation's frame.nodeId is read: verified", byFrame.status === "verified" && byFrame.reports[0]?.matchedBy === "expectation frame");
  p.put("design/verify/Plots.expected.json", EXP.replace('"Plots"', '"Plots "'));
  const regen = at(hooked(p.root, base));
  check("[6] the expectation on disk is not the one the report was computed against → unverified, saying so",
    regen.status === "unverified" && has(regen.reasons, /inputs\.expectationSha256 no longer matches/));
  p.done();
}

report();
