// test/audit-gate.test.ts — the audit report seen from a plan (design-to-code/audit-gate.ts), on temp projects at the
// module's interface: which report and sidecars are the screen's, what it blocks, the verdict on a plan's auditGate, and
// the gate a skeleton writes and keeps. verify-build renders the verdict and plan-skeleton writes the gate: their own
// suites check only that wiring.
// Run with:  bun test/audit-gate.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockerIds, crossCheckFileOf, gatePrefill, judgeGate, mergeGate, overridesFileOf, screenAudit } from "../design-to-code/audit-gate.ts";
import type { GateVerdict, ScreenAudit } from "../design-to-code/audit-gate.ts";
import type { PlanAuditGate } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";

/** A temp project: `put` writes a JSON (or raw text) file under it. */
function project(): { root: string; put: (rel: string, doc: unknown) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dt-audit-gate-"));
  const put = (rel: string, doc: unknown): string => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
    return rel;
  };
  return { root, put };
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const finding = (severity: string, code: string, nodeId?: string, id?: string) => ({ severity, code, message: code, ...(nodeId ? { nodeId } : {}), ...(id ? { id } : {}) });
const reportOf = (findings: unknown[]) => ({ summary: { blockers: 0, warnings: 0, info: 0 }, findings });
/** A read audit with these blockers (positional ids by their order), as screenAudit returns one. */
const read = (blockers: string[], legacyBlockers: string[] = blockers.map((b, i) => `${b.split("@")[0]}#${i}`)): ScreenAudit =>
  ({ status: "read", auditFile: "design/audit/Bins__1_1.json", blockers, legacyBlockers, crossCheckFile: null });
const gate = (overridden: unknown[], reason: string | null = "acknowledged"): PlanAuditGate =>
  ({ auditFile: "design/audit/Bins__1_1.json", verdict: "blocked", overridden: overridden as string[], reason });

console.log("the report's family — its cross-check sidecar and the overrides a run reads:");
{
  check("the cross-check sidecar is <stem>.cross.json", crossCheckFileOf("design/audit/Bins__1_1.json") === "design/audit/Bins__1_1.cross.json");
  const has = (...files: string[]) => (f: string): boolean => files.includes(f);
  const own = path.join("design", "audit", "Bins__1_1.overrides.json"), lib = path.join("design", "audit", "Bins__1_1.library");
  check("a report's run reads its own <base>.overrides.json (there or not)", overridesFileOf(path.join("design", "audit", "Bins__1_1"), has()) === own);
  check("a sidecar run with no overrides of its own reads its report's", overridesFileOf(lib, has(own)) === own);
  check("…its own when it has one", overridesFileOf(lib, has(own, lib + ".overrides.json")) === lib + ".overrides.json");
  check("…and its own name when neither is there", overridesFileOf(lib, has()) === lib + ".overrides.json");
}

console.log("blockerIds — what a report blocks:");
{
  const doc = reportOf([finding("blocker", "missing-font", "1:1"), finding("warning", "fixed-size-text", "1:2"), finding("blocker", "token-name-collision"),
    finding("blocker", "missing-font", "1:1"), finding("blocker", "assets-failed", undefined, "assets-failed@own")]);
  check(`each blocker's id in report order: code@node, bare code, ~n for a repeat, a written id kept (got ${JSON.stringify(blockerIds(doc))})`,
    same(blockerIds(doc), ["missing-font@1:1", "token-name-collision", "missing-font@1:1~2", "assets-failed@own"]));
  check("anything that is not a report blocks nothing", blockerIds(null).length === 0 && blockerIds({ findings: "x" }).length === 0 && blockerIds([1]).length === 0);
}

console.log("screenAudit — the screen's report, located and read:");
{
  const p = project();
  check("no design/audit at all: none", screenAudit(p.root, { nodeId: "1:1", screenName: "Bins" }).status === "none");
  p.put("design/audit/Bins__1_1.json", reportOf([finding("blocker", "missing-font", "1:1"), finding("blocker", "token-name-collision")]));
  const a = screenAudit(p.root, { nodeId: "1:1", screenFile: "/x/design/export/pages/P/Bins__1_1.json", screenName: "Bins" });
  check(`the screen file's own name: its blockers and their positional ids (got ${JSON.stringify(a)})`,
    a.status === "read" && a.auditFile === "design/audit/Bins__1_1.json" && same(a.blockers, ["missing-font@1:1", "token-name-collision"])
    && same(a.legacyBlockers, ["missing-font#0", "token-name-collision#1"]) && a.crossCheckFile === null);
  p.put("design/audit/Bins__1_1.cross.json", reportOf([]));
  const c = screenAudit(p.root, { nodeId: "1:1" });
  check("found by its node too, with the cross-check sidecar beside it", c.status === "read" && c.crossCheckFile === "design/audit/Bins__1_1.cross.json");
  check("another screen's report is not this one's", screenAudit(p.root, { nodeId: "2:2", screenName: "Crates" }).status === "none");
  p.put("design/audit/Crates__2_2.json", "{ truncated");
  const bad = screenAudit(p.root, { nodeId: "2:2" });
  check(`a report that cannot be read is unreadable, with why — never "no blockers" (got ${JSON.stringify(bad)})`,
    bad.status === "unreadable" && bad.auditFile === "design/audit/Crates__2_2.json" && /is not valid JSON/.test(bad.error));
  p.put("design/audit/Pots__3_3.json", { findings: "none" });
  const shape = screenAudit(p.root, { nodeId: "3:3" });
  check("a file there that is not an audit report is unreadable too", shape.status === "unreadable" && /is not an audit report/.test(shape.error));
}

console.log("judgeGate — the verdict on a plan's auditGate:");
{
  const st = (v: GateVerdict): string => v.status;
  check("no report: clear", st(judgeGate({ status: "none" }, null)) === "clear");
  check("a report with no blockers: clear, whatever the plan holds", st(judgeGate(read([]), null)) === "clear" && st(judgeGate(read([]), gate(["x"]))) === "clear");
  const un = judgeGate({ status: "unreadable", auditFile: "design/audit/Bins__1_1.json", error: "is not valid JSON — x" }, gate([]));
  check("an unreadable report: unchecked, with the reason", un.status === "unchecked" && un.error === "is not valid JSON — x");
  const ungated = judgeGate(read(["missing-font@1:1", "token-name-collision"]), undefined);
  check("blockers and no auditGate: ungated, naming every blocker", ungated.status === "ungated" && same(ungated.blockers, ["missing-font@1:1", "token-name-collision"]));
  const five = ["a", "b", "c", "d", "e"].map((c) => `${c}@1:1`);
  const part = judgeGate(read(five), gate(five.slice(0, 2)));
  check(`2 of 5 overridden: the 3 others uncovered (got ${JSON.stringify(part)})`, part.status === "uncovered" && same(part.uncovered, five.slice(2)));
  const noReason = judgeGate(read(five), gate(five, null));
  check("every blocker overridden, no reason: unreasoned, counting the entries", noReason.status === "unreasoned" && noReason.overridden === 5);
  const ok = judgeGate(read(five), gate(five));
  check("every blocker overridden with a reason: covered, nothing legacy", ok.status === "covered" && ok.legacy.via.length === 0 && ok.legacy.stale.length === 0);
  check("an overridden list that is not an array covers nothing", st(judgeGate(read(five), JSON.parse('{"auditFile":null,"verdict":"blocked","overridden":"a@1:1","reason":"r"}') as PlanAuditGate)) === "uncovered");
}

console.log("judgeGate — stable ids, positional ids, bare codes:");
{
  // a report written before findings carried an id: a missing-font blocker on 1:1, a node-less token-name-collision
  const audit = read(["missing-font@1:1", "token-name-collision"]);
  const legacy = judgeGate(audit, gate(["missing-font#0", "token-name-collision#1"]));
  check(`the positional ids still cover their blockers, each mapped to its stable id (got ${JSON.stringify(legacy)})`,
    legacy.status === "covered" && same(legacy.legacy.via, [{ old: "missing-font#0", id: "missing-font@1:1" }, { old: "token-name-collision#1", id: "token-name-collision" }]) && legacy.legacy.stale.length === 0);
  check("stable ids (the bare code of a node-less blocker among them): covered, nothing legacy",
    (() => { const v = judgeGate(audit, gate(["missing-font@1:1", "token-name-collision"])); return v.status === "covered" && v.legacy.via.length === 0; })());
  const stale = judgeGate(audit, gate(["missing-font@1:1", "token-name-collision", "contrast#3"]));
  check("a positional entry matching no blocker is stale", stale.status === "covered" && same(stale.legacy.stale, ["contrast#3"]) && stale.legacy.via.length === 0);
  const mixed = judgeGate(audit, gate(["missing-font#0"]));
  check("a positional id covers only its own blocker — the other is uncovered by its stable id",
    mixed.status === "uncovered" && same(mixed.uncovered, ["token-name-collision"]) && same(mixed.legacy.via, [{ old: "missing-font#0", id: "missing-font@1:1" }]));
  check("an entry by its stable id is not also read as a positional cover",
    (() => { const v = judgeGate(audit, gate(["missing-font@1:1", "missing-font#0", "token-name-collision"])); return v.status === "covered" && v.legacy.via.length === 0; })());
  // a position shifts when an earlier blocker is fixed: the plan overrode missing-font#0 (1:1); once 1:1 is fixed the
  // report holds only missing-font@2:2 — now missing-font#0, so the old entry covers a DIFFERENT blocker, and says so
  const before = judgeGate(read(["missing-font@1:1", "missing-font@2:2"], ["missing-font#0", "missing-font#1"]), gate(["missing-font#0"]));
  check("both open: #0 covers 1:1, 2:2 uncovered", before.status === "uncovered" && same(before.uncovered, ["missing-font@2:2"]) && before.legacy.via[0]?.id === "missing-font@1:1");
  const after = judgeGate(read(["missing-font@2:2"], ["missing-font#0"]), gate(["missing-font#0"]));
  check("1:1 fixed: the shifted #0 now covers 2:2 — named", after.status === "covered" && same(after.legacy.via, [{ old: "missing-font#0", id: "missing-font@2:2" }]));
}

console.log("gatePrefill / mergeGate — the gate a skeleton writes, and keeps:");
{
  const audit: ScreenAudit = { ...read(["missing-font@1:1"]), crossCheckFile: "design/audit/Bins__1_1.cross.json" } as ScreenAudit;
  const fresh = gatePrefill(audit);
  check(`a blocking report: every blocker to decide on, nothing decided (got ${JSON.stringify(fresh)})`,
    same(fresh, { auditFile: "design/audit/Bins__1_1.json", crossCheckFile: "design/audit/Bins__1_1.cross.json", verdict: "blocked", blockers: ["missing-font@1:1"], overridden: [], reason: null, decidedBy: null, decidedAt: null }));
  check("nothing to decide: no gate (no report, none blocking, unreadable)",
    gatePrefill({ status: "none" }) === null && gatePrefill(read([])) === null && gatePrefill({ status: "unreadable", auditFile: "x", error: "e" }) === null);
  const decided: PlanAuditGate = { auditFile: "design/audit/Old.json", verdict: "accepted", blockers: ["old@1:1"], overridden: ["old@1:1"], reason: "fine", decidedBy: "owner", decidedAt: "2026-10-01" };
  const merged = mergeGate(decided, fresh);
  check(`a re-run refreshes what it read, keeps what a person decided (got ${JSON.stringify(merged)})`,
    merged?.auditFile === "design/audit/Bins__1_1.json" && same(merged.blockers, ["missing-font@1:1"]) && merged.crossCheckFile === "design/audit/Bins__1_1.cross.json"
    && same(merged.overridden, ["old@1:1"]) && merged.reason === "fine" && merged.decidedBy === "owner" && merged.verdict === "accepted");
  check("no fresh gate: the decision stays as it was", mergeGate(decided, null) === decided);
  check("no earlier gate: the fresh one", mergeGate(null, fresh) === fresh && mergeGate(undefined, null) === null);
}

report();
