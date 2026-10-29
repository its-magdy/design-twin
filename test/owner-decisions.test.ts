// owner-decisions.ts on its own: what may be accepted, --accept's selection and the rows it writes, a round's descopes
// and waivers (applied / reopened / unused), and the hash a report records — table tests over plain deltas and reports,
// no expectation, no compare(). verify-waivers.test.ts stays the end-to-end check (compare(), the CLI).
// Run with:  bun test/owner-decisions.test.ts
import { acceptInto, descopeRound, selectForAccept, waiverRound, waiversChanged, waiversHash, whyNotWaivable } from "../design-to-code/owner-decisions.ts";
import type { WaiverGaps, WaiverRound } from "../design-to-code/owner-decisions.ts";
import type { JsonValue, PlanDescope, PlanWaiver, VerifyDelta, VerifyReport } from "../design-to-code/types.ts";
import { planHash } from "../design-to-code/content-hash.ts";
import { malformed } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const SHA = "a".repeat(64), REPULLED = "b".repeat(64);
const DECIDED = { reason: "the wider type reads better", decidedBy: "Sam Doe", decidedAt: "2026-10-29T00:00:00Z" };
const delta = (nodeId: string, field: string, expected: JsonValue, actual: JsonValue, extra: Partial<VerifyDelta> = {}): VerifyDelta =>
  ({ severity: "high", nodeId, field, expected, actual, ...extra });
const NO_GAPS: WaiverGaps = { notMeasured: [], fieldsNotMeasured: [], interactionsFailed: [], componentsAbsent: [] };
const round = (deltas: VerifyDelta[], o: Partial<WaiverRound> = {}): WaiverRound => ({ deltas, exportSha: SHA, gaps: NO_GAPS, inkWidthNodes: new Set(), ...o });
const reportOf = (r: Partial<VerifyReport>): VerifyReport => ({ integrity: [], deltas: [], ...r });

// ---------------------------------------------------------------- the lifecycle: accept → apply → re-export → reopen
console.log("lifecycle — accept, apply, re-export, reopen:");
{
  const rep = reportOf({ inputs: { exportContentSha256: SHA }, deltas: [delta("2:1", "font-size", 14, 16), delta("2:1", "color", "#111111", "#222222")] });
  const sel = selectForAccept(rep, { node: "2:1", field: "font-size" });
  check("--accept --field picks that one delta only", "deltas" in sel && sel.deltas.length === 1 && sel.deltas[0]?.field === "font-size");
  const picked = "deltas" in sel ? sel.deltas : [];
  const acc = acceptInto(undefined, picked, { exportContentSha256: SHA, ...DECIDED });
  const w = acc.waivers[0];
  check("the row: designed = delta.expected, built = delta.actual, bound to the export, the decision copied; no cause without --group",
    acc.waivers.length === 1 && !!w && w.nodeId === "2:1" && w.field === "font-size" && w.designed === 14 && w.built === 16 && w.exportContentSha256 === SHA
    && w.reason === DECIDED.reason && w.decidedBy === "Sam Doe" && !("cause" in w) && acc.wrote[0]?.replaced === false);

  const next = [delta("2:1", "font-size", 14, 16), delta("2:1", "color", "#111111", "#222222")];
  const applied = waiverRound(acc.waivers, round(next));
  check("next round, same delta: applied — the delta carries accepted, the other delta is untouched",
    applied.applied === 1 && next[0]?.accepted?.decidedBy === "Sam Doe" && next[1]?.accepted === undefined && !applied.reopened.length && !applied.unused.length);

  const reexported = [delta("2:1", "font-size", 14, 16)];
  const r = waiverRound(acc.waivers, round(reexported, { exportSha: REPULLED }));
  check("the design re-exported: reopened, not applied", r.applied === 0 && !reexported[0]?.accepted && r.reopened.length === 1 && /design re-exported/.test(r.reopened[0]?.why ?? ""));

  const noSha = waiverRound(acc.waivers, round([delta("2:1", "font-size", 14, 16)], { exportSha: undefined }));
  check("an expectation with no export hash: reopened, says regenerate it", /regenerate it with --expect/.test(noSha.reopened[0]?.why ?? ""));

  const moved = waiverRound(acc.waivers, round([delta("2:1", "font-size", 14, 18)]));
  check("the built value moved beyond the tolerance: reopened 'built value moved: was 16, now 18'", moved.applied === 0 && moved.reopened[0]?.why === "built value moved: was 16, now 18");
  const nudged = [delta("2:1", "font-size", 14, 16.4)];
  check("…within the field's tolerance (font-size 0.5): still applied", waiverRound(acc.waivers, round(nudged)).applied === 1 && !!nudged[0]?.accepted);

  const redesigned = waiverRound(acc.waivers, round([delta("2:1", "font-size", 12, 16)]));
  check("the designed value changed: reopened 'designed value changed: was 14, now 12'", redesigned.reopened[0]?.why === "designed value changed: was 14, now 12");

  const fixed = waiverRound(acc.waivers, round([]));
  check("the delta is gone: unused, 'fixed? drop the waiver'", fixed.unused.length === 1 && /fixed\? drop the waiver/.test(fixed.unused[0]?.why ?? ""));

  // re-accepting after the build moved replaces the row in place — one row per node + field
  const again = acceptInto([malformed<PlanWaiver>({ junk: true }), ...acc.waivers], [delta("2:1", "font-size", 14, 18)], { exportContentSha256: SHA, ...DECIDED, cause: "g1" });
  check("a new decision replaces the node + field's row in place; a malformed row is kept; --group's cause recorded",
    again.waivers.length === 2 && again.wrote[0]?.replaced === true && again.waivers[1]?.built === 18 && again.waivers[1]?.cause === "g1");
}

// ---------------------------------------------------------------- the matching rule
console.log("matching — tolerance, explicit slack, strings with numbers, one delta per waiver:");
{
  const w = (p: Partial<PlanWaiver> & Pick<PlanWaiver, "nodeId" | "field" | "designed" | "built">): PlanWaiver => ({ exportContentSha256: SHA, ...DECIDED, ...p });
  const rows: Array<[string, PlanWaiver, VerifyDelta, boolean]> = [
    ["color is exact", w({ nodeId: "1", field: "color", designed: "#111111", built: "#222222" }), delta("1", "color", "#111111", "#222223"), false],
    ["padding within 1px per side", w({ nodeId: "1", field: "padding", designed: [8, 8, 8, 8], built: [12, 8, 12, 8] }), delta("1", "padding", [8, 8, 8, 8], [12.8, 8, 12, 8]), true],
    ["padding past 1px", w({ nodeId: "1", field: "padding", designed: [8, 8, 8, 8], built: [12, 8, 12, 8] }), delta("1", "padding", [8, 8, 8, 8], [13.5, 8, 12, 8]), false],
    ["a border-radius corner within 0.5", w({ nodeId: "1", field: "border-radius (top-left)", designed: 12, built: 20 }), delta("1", "border-radius (top-left)", 12, 20.4), true],
    ["placement text: every number within 2px", w({ nodeId: "1", field: "placement", designed: "y=720", built: "bottom edge at y=1450" }), delta("1", "placement", "y=720", "bottom edge at y=1451.5"), true],
    ["placement text: other words never match", w({ nodeId: "1", field: "placement", designed: "y=720", built: "bottom edge at y=1450" }), delta("1", "placement", "y=720", "top edge at y=1450"), false],
    ["an explicit tolerance on built widens it", w({ nodeId: "1", field: "font-size", designed: 14, built: 16, tolerance: 3 }), delta("1", "font-size", 14, 18.5), true],
    ["match (size) within 1px per side", w({ nodeId: "1", field: "match (size)", designed: [300, 120], built: [640, 120] }), delta("1", "match (size)", [300, 120], [641, 120]), true],
  ];
  for (const [name, wv, d, applies] of rows) check(name, (waiverRound([wv], round([d])).applied === 1) === applies);
  const labelled: Array<[string, number, number]> = [["border-radius (bottom-right)", 0.5, 0.6], ["width (text ink)", 3, 3.1], ["overflowX", 2, 2.1], ["not a field", 0, 0.01]];
  for (const [field, within, past] of labelled) {
    const at = (built: number): number => waiverRound([w({ nodeId: "1", field, designed: 10, built: 20 })], round([delta("1", field, 10, built)])).applied;
    check(`'${field}' is matched within ${within}px, not ${past}px`, at(20 + within) === 1 && at(20 + past) === 0);
  }
  const twin = [delta("1", "font-size", 14, 16), delta("1", "font-size", 14, 16)];
  const one = waiverRound([w({ nodeId: "1", field: "font-size", designed: 14, built: 16 })], round(twin));
  check("one waiver accepts one delta (a second identical one stays open)", one.applied === 1 && !!twin[0]?.accepted && !twin[1]?.accepted);
  const pair = [delta("1", "font-size", 14, 16), delta("1", "font-size", 14, 16)];
  const both = waiverRound([w({ nodeId: "1", field: "font-size", designed: 14, built: 16 }), w({ nodeId: "1", field: "font-size", designed: 14, built: 16 })], round(pair));
  check("two waivers on two identical deltas: both applied, one each", both.applied === 2 && pair.every((d) => !!d.accepted));
  // the order the report lists them in is the plan's row order
  const mixed = waiverRound([
    w({ nodeId: "a", field: "font-size", designed: 14, built: 16 }), malformed<PlanWaiver>({ nodeId: "b" }), w({ nodeId: "c", field: "font-size", designed: 14, built: 16, exportContentSha256: REPULLED }),
    w({ nodeId: "d", field: "color", designed: "#000000", built: "#111111" }), w({ nodeId: "e", field: "font-size", designed: 14, built: 16 }), malformed<PlanWaiver>({ nodeId: "f" }),
  ], round([delta("c", "font-size", 14, 16), delta("e", "font-size", 14, 20)]));
  check("reopened, unused and notes keep the plan's row order", mixed.reopened.map((r) => r.nodeId).join() === "c,e" && mixed.unused.map((r) => r.nodeId).join() === "a,d"
    && mixed.notes.length === 2 && /waivers\[1\]/.test(mixed.notes[0] ?? "") && /waivers\[5\]/.test(mixed.notes[1] ?? ""));
  const bad = waiverRound([{ nodeId: "1", field: "font-size" }], round([delta("1", "font-size", 14, 16)]));
  check("a malformed row is ignored with a note naming its index", bad.applied === 0 && bad.notes.length === 1 && /^plan waivers\[0\] is not a plan waiver/.test(bad.notes[0] ?? ""));
}

// ---------------------------------------------------------------- what may be accepted (one list, both sides)
console.log("never waivable — one list for --accept and --compare:");
{
  const gaps: WaiverGaps = {
    componentsAbsent: [{ setName: "Order Row", nodeIds: ["5:1", "5:9"] }], interactionsFailed: [{ nodeId: "5:1" }, { nodeId: "6:1" }],
    notMeasured: [{ nodeId: "5:1" }, { nodeId: "6:1" }, { nodeId: "7:1" }], fieldsNotMeasured: [{ nodeId: "8:1", field: "color" }],
  };
  const table: Array<[string, string | undefined, RegExp | null]> = [
    ["5:1", undefined, /component set 'Order Row' is reported ABSENT — a missing component is never waivable/],
    ["6:1", undefined, /a failed interaction is never waivable/],
    ["7:1", "font-size", /the node was not measured/],
    ["8:1", "color", /that value was not measured this round/],
    ["8:1", "font-size", null],
    ["8:1", undefined, null],
  ];
  for (const [id, field, want] of table) {
    const why = whyNotWaivable(gaps, id, field);
    check(`${id}${field ? ` (${field})` : ""}: ${want ? want.source.slice(0, 40) : "waivable"}`, want === null ? why === null : why !== null && want.test(why));
  }
  // the same reason, read off a report by --accept and off a round by --compare
  const rep = reportOf({ componentsAbsent: gaps.componentsAbsent.map((c) => ({ ...c, instances: 1 })), notMeasured: [{ nodeId: "7:1", name: "Wrap", why: "no element" }],
    interactions: [{ nodeId: "6:1", name: "Open", trigger: "on_click", result: "fail" }], fieldsNotMeasured: [{ nodeId: "8:1", field: "color", why: "null" }] });
  const pairs: Array<[string, string]> = [["5:9", "font-size"], ["6:1", "color"], ["7:1", "font-size"], ["8:1", "color"]];
  for (const [id, field] of pairs) {
    const sel = selectForAccept(rep, { node: id, field });
    const unused = waiverRound([{ nodeId: id, field, designed: 1, built: 2, exportContentSha256: SHA, ...DECIDED }], round([], { gaps })).unused[0]?.why;
    check(`${id} (${field}): --accept refuses with the reason --compare gives an unused waiver`, "error" in sel && unused !== undefined && sel.error === `${id} (${field}): ${unused}`);
  }
  const ink = waiverRound([{ nodeId: "9:1", field: "width", designed: 121, built: 34, exportContentSha256: SHA, ...DECIDED }], round([], { inkWidthNodes: new Set(["9:1"]) }));
  const inkDelta = waiverRound([{ nodeId: "9:1", field: "width", designed: 121, built: 34, exportContentSha256: SHA, ...DECIDED }], round([delta("9:1", "width (text ink)", 100, 104)]));
  check("…or because this round has a 'width (text ink)' delta for it", /compared as 'width \(text ink\)'/.test(inkDelta.unused[0]?.why ?? ""));
  const gapFirst = waiverRound([{ nodeId: "7:1", field: "width", designed: 121, built: 34, exportContentSha256: SHA, ...DECIDED }], round([], { gaps, inkWidthNodes: new Set(["7:1"]) }));
  check("a gap's reason beats the ink-width hint", /the node was not measured/.test(gapFirst.unused[0]?.why ?? ""));
  check("a waiver on a TEXT's width (compared at its ink width now): unused, re-accept", /compared as 'width \(text ink\)'/.test(ink.unused[0]?.why ?? ""));
}

// ---------------------------------------------------------------- --accept's selection
console.log("--accept selection:");
{
  const deltas = [delta("2:1", "font-size", 14, 16, { group: "g1" }), delta("2:2", "font-size", 14, 16, { group: "g1" }), delta("2:2", "color", "#111111", "#222222")];
  const sel = (r: Partial<VerifyReport>, s: Parameters<typeof selectForAccept>[1]): ReturnType<typeof selectForAccept> => selectForAccept(reportOf({ deltas, ...r }), s);
  const g = sel({}, { group: "g1" });
  check("--group picks every delta of the group", "deltas" in g && g.deltas.length === 2);
  const all = sel({}, { node: "2:2" });
  check("--node with no field (--all-fields) picks every delta of the node", "deltas" in all && all.deltas.length === 2);
  const none = sel({}, { group: "g9" });
  check("an unknown group names the groups there are", "error" in none && /group 'g9' \(groups: g1\)/.test(none.error));
  const nofield = sel({}, { node: "2:2", field: "opacity" });
  check("no delta for that field names the node's deltas", "error" in nofield && /\(its deltas: font-size, color\)/.test(nofield.error));
  const { integrity: _i, ...noIntegrity } = reportOf({ deltas });
  const ni = selectForAccept(noIntegrity, { node: "2:1", field: "font-size" });
  check("a report with no integrity[] → refused", "error" in ni && /records no integrity\[\]/.test(ni.error));
  const unverified = sel({ integrity: ["the verifier had not finished"] }, { node: "2:1", field: "font-size" });
  check("an unverified run → refused, naming why", "error" in unverified && /run is unverified \(the verifier had not finished\)/.test(unverified.error));
}

// ---------------------------------------------------------------- descopes
console.log("descopes — removed from the graded set while their export holds:");
{
  const ds = (p: Partial<PlanDescope> = {}): PlanDescope => ({ nodeId: "2:5", trigger: "on_click", exportContentSha256: SHA, ...DECIDED, ...p });
  const designed = [{ nodeId: "2:5", trigger: "on_click", destinationId: "1:50" }, { nodeId: "2:4", trigger: "on_click" }];
  const live = descopeRound([ds()], designed, SHA);
  const [open, other] = designed;
  check("a matching descope: that interaction is descoped, the other is not", !!open && !!other && live.descopeOf(open)?.decidedBy === "Sam Doe" && live.descopeOf(other) === undefined && !live.reopened.length && !live.unused.length);
  check("the trigger matches case-insensitively", !!open && descopeRound([ds({ trigger: "ON_CLICK" })], designed, SHA).descopeOf(open) !== undefined);
  check("a descope naming the interaction's destination matches it", !!open && descopeRound([ds({ destinationId: "1:50" })], designed, SHA).descopeOf(open) !== undefined);
  const dest = descopeRound([ds({ destinationId: "9:9" })], designed, SHA);
  check("a descope naming another destination matches nothing: unused", !!open && dest.descopeOf(open) === undefined && dest.unused.length === 1 && /no designed interaction/.test(dest.unused[0]?.why ?? ""));
  const re = descopeRound([ds()], designed, REPULLED);
  check("the design re-exported: reopened (graded again), not unused", !!open && re.descopeOf(open) === undefined && re.reopened.length === 1 && re.reopened[0]?.field === "interaction (on_click)"
    && /design re-exported/.test(re.reopened[0]?.why ?? "") && !re.unused.length);
  const bad = descopeRound([{ nodeId: "2:5" }], designed, SHA);
  check("a malformed descope is ignored with a note", bad.notes.length === 1 && /^plan descopes\[0\] is not a plan descope/.test(bad.notes[0] ?? ""));
}

// ---------------------------------------------------------------- the hash a report records
console.log("the hash — what a report records, and whether it is still current:");
{
  const p1 = { waivers: [{ nodeId: "1", field: "color", designed: "#111111", built: "#222222", exportContentSha256: SHA, ...DECIDED }], descopes: [] };
  const flipped = { waivers: p1.waivers.map((x) => ({ decidedAt: x.decidedAt, decidedBy: x.decidedBy, reason: x.reason, exportContentSha256: x.exportContentSha256, built: x.built, designed: x.designed, field: x.field, nodeId: x.nodeId })) };
  check("key order does not change the hash; a change does", waiversHash(p1) === waiversHash(flipped) && waiversHash(p1) !== waiversHash({}));
  check("none, [] and a plan without the keys hash alike", waiversHash(null) === waiversHash({}) && waiversHash({}) === waiversHash({ waivers: [], descopes: [] }));
  check("a report that recorded none is current for a plan with none, changed for a plan with one",
    !waiversChanged(undefined, {}) && waiversChanged(undefined, p1) && !waiversChanged(waiversHash(p1), p1) && waiversChanged(waiversHash(p1), { waivers: [] }));
  const plan = { nodeId: "1:1", files: ["a.tsx"] };
  check("waivers[]/descopes[] are left out of the Stop hook's plan hash (accepting is not editing the plan)",
    planHash(plan) === planHash({ ...plan, ...p1 }) && planHash(plan) !== planHash({ ...plan, files: ["b.tsx"] }));
}

report();
