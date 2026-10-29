// test/plan-binding.test.ts — which plan a verify run uses and what of it binds the run (design-to-code/plan-binding.ts):
// the selection rule, the rows --expect consumes and records, the plan --compare resolves (flag / found / recorded / gone),
// and the table of {what the expectation recorded, the plan used now} → the reasons and notes compare is handed.
// Run with:  bun test/plan-binding.test.ts
import { choosePlan, planAtCompare, planAtExpect, planInteractionsSha256, resolvePlan } from "../design-to-code/plan-binding.ts";
import { waiversHash } from "../design-to-code/owner-decisions.ts";
import type { ChosenPlan, ExpectNodes, PlanReader, PlanResolution, PlanSelection } from "../design-to-code/plan-binding.ts";
import { compare } from "../design-to-code/verify-compare.ts";
import { buildExpectation } from "../design-to-code/verify-expect.ts";
import type { ExpectInput } from "../design-to-code/verify-expect.ts";
import type { Plan, VerifyExpectation, VerifyInteraction } from "../design-to-code/types.ts";
import { malformed, screenExport, usingPlan } from "./fixtures.ts";
import { check, report } from "./assert.ts";

const A = "scratch/mine.json", B = "design/plan/Checkout__1_1.json", C = "design/plan/Checkout_v2.json";
const GONE = "no longer exists";
const ix = (expect: string): Plan => ({ interactions: [{ nodeId: "2:5", trigger: "on_click", expect }] });
const ph = (reason: string): Plan => ({ deviations: [{ nodeId: "2:9", field: "placeholder", designed: "Search", built: "<input placeholder>", reason }] });
const NODES: ExpectNodes = { visible: (id) => (id === "2:9" ? { name: "Search", file: "", type: "TEXT" } : undefined), hidden: () => false };
const placeholderSha = (plan: Plan): string => planAtExpect({ file: "x", plan }).placeholders(NODES)?.sha256 ?? "";
type Recorded = Pick<VerifyExpectation, "planInteractions" | "planPlaceholders">;
/** what an expectation recorded: interactions[] and/or placeholder rows read from `file` */
const recorded = (file: string, o: { ix?: Plan; ph?: Plan }): Recorded => ({
  ...(o.ix ? { planInteractions: { plan: file, sha256: planInteractionsSha256(o.ix), merged: 1, dropped: [] } } : {}),
  ...(o.ph ? { planPlaceholders: { plan: file, sha256: placeholderSha(o.ph), nodeIds: ["2:9"], dropped: [] } } : {}),
});
const used = (file: string, plan: Plan, choice: ChosenPlan["choice"], gone?: string): PlanResolution =>
  ({ now: { file, plan, ...(choice ? { choice } : {}) }, ...(gone ? { recordedGone: gone } : {}) });
const one = (xs: string[]): string => (xs.length === 1 ? xs[0] ?? "" : `<${xs.length}: ${xs.join(" | ")}>`);

// ---------------------------------------------------------------- {recorded binding, plan now} → reasons / notes
console.log("planAtCompare — what the expectation recorded against the plan used now:");
interface Row { name: string; rec: Recorded; now: PlanResolution | null; reason?: RegExp | string; note?: RegExp | string }
const table: Row[] = [
  // interactions[]
  { name: "interactions: the same plan, unchanged → nothing", rec: recorded(B, { ix: ix("url") }), now: used(B, ix("url"), "only") },
  { name: "interactions: the frame's only plan, edited → re-run --expect (no --plan)", rec: recorded(B, { ix: ix("url") }), now: used(B, ix("dialog"), "only"),
    reason: /^the plan's interactions\[\] changed since --expect \(design\/plan\/Checkout__1_1\.json: sha256 [0-9a-f]{12}… at --expect, [0-9a-f]{12}… now\) — re-run --expect$/ },
  { name: "interactions: chosen by --plan, edited → re-run --expect --plan <it>", rec: recorded(B, { ix: ix("url") }), now: used(B, ix("dialog"), "flag"),
    reason: /changed since --expect .* re-run --expect --plan design\/plan\/Checkout__1_1\.json$/ },
  { name: "interactions: the recorded plan (used over the one found), edited → re-run --expect --plan <recorded>", rec: recorded(A, { ix: ix("url") }), now: used(A, ix("dialog"), "recorded"),
    reason: /^the plan's interactions\[\] changed since --expect \(scratch\/mine\.json: .*re-run --expect --plan scratch\/mine\.json$/ },
  { name: "interactions: a plan declaring rows the expectation never merged → 'merged none'", rec: {}, now: used(B, ix("url"), "only"),
    reason: `the plan's interactions[] changed since --expect (${B}: the expectation merged none) — re-run --expect` },
  { name: "interactions: --plan <another> (the recorded one still there) → names both, offers to drop --plan", rec: recorded(A, { ix: ix("url") }), now: used(B, ix("dialog"), "flag"),
    reason: /--expect merged scratch\/mine\.json's: .* re-run --expect --plan design\/plan\/Checkout__1_1\.json, or drop --plan at --compare to check against scratch\/mine\.json$/ },
  { name: "interactions: --plan <another>, the recorded one gone → no 'drop --plan' (nothing to fall back to)", rec: recorded(A, { ix: ix("url") }), now: used(B, ix("dialog"), "flag", GONE),
    reason: /scratch\/mine\.json's, which no longer exists: .* re-run --expect --plan design\/plan\/Checkout__1_1\.json$/ },
  { name: "interactions: the recorded plan gone, another found with other rows → names both, advises both re-runs", rec: recorded(A, { ix: ix("url") }), now: used(B, ix("dialog"), "only", GONE),
    reason: /came from scratch\/mine\.json, which no longer exists; the plan found now, design\/plan\/Checkout__1_1\.json, declares others .*re-run --compare … --plan <its path now>; otherwise re-run --expect … --plan <the plan you intend> \(--plan design\/plan\/Checkout__1_1\.json to adopt this one\)$/ },
  { name: "interactions: the recorded plan gone, --plan <its new path> with the same rows → a note, no reason", rec: recorded(A, { ix: ix("url") }), now: used(C, ix("url"), "flag", GONE),
    note: `the expectation merged plan interactions from ${A}, which no longer exists; ${C} (used now) declares the same interactions[]` },
  { name: "interactions: no plan now → a note (not checked), never a reason", rec: recorded(A, { ix: ix("url") }), now: null,
    note: /^the expectation merged plan interactions from scratch\/mine\.json, and no plan describes this frame now — not checked;/ },
  { name: "interactions: no plan now, the recorded one gone → the note says why", rec: recorded(A, { ix: ix("url") }), now: { now: null, recordedGone: GONE },
    note: /from scratch\/mine\.json, which no longer exists, and no plan describes/ },
  { name: "the same plan file spelled another way (./…) is the same plan → nothing", rec: recorded(`./${B}`, { ix: ix("url") }), now: used(B, ix("url"), "only") },
  // placeholder rows — the same branches (the copy the interactions check was cloned into missed the other-plan / --plan ones)
  { name: "placeholders: the same plan, unchanged → nothing", rec: recorded(B, { ph: ph("hint") }), now: used(B, ph("hint"), "only") },
  { name: "placeholders: no placeholder rows, an expectation that read none → nothing", rec: {},
    now: used(B, { deviations: [{ nodeId: "2:9", field: "control", designed: "x", built: "y", reason: "z" }] }, "only") },
  { name: "placeholders: chosen by --plan, edited → re-run --expect --plan <it>", rec: recorded(B, { ph: ph("hint") }), now: used(B, ph("edited"), "flag"),
    reason: /^the plan's placeholder rows \(deviations\[\] field "placeholder"\) changed since --expect \(design\/plan\/Checkout__1_1\.json: .*re-run --expect --plan design\/plan\/Checkout__1_1\.json$/ },
  { name: "placeholders: rows the expectation never read → 'never read'", rec: {}, now: used(B, ph("hint"), "only"),
    reason: `the plan declares 1 placeholder row(s) (deviations[] field "placeholder") the expectation never read (${B}) — re-run --expect` },
  { name: "placeholders: --plan <another> (the recorded one still there) → names both, offers to drop --plan", rec: recorded(A, { ph: ph("hint") }), now: used(B, ph("edited"), "flag"),
    reason: /--expect read scratch\/mine\.json's: .* re-run --expect --plan design\/plan\/Checkout__1_1\.json, or drop --plan at --compare to check against scratch\/mine\.json$/ },
  { name: "placeholders: the recorded plan gone, another found with other rows → names both", rec: recorded(A, { ph: ph("hint") }), now: used(B, ph("edited"), "only", GONE),
    reason: /^the plan's placeholder rows \(deviations\[\] field "placeholder"\) at --expect came from scratch\/mine\.json, which no longer exists; the plan found now, design\/plan\/Checkout__1_1\.json, declares others/ },
  { name: "placeholders: the recorded plan gone, another declares the same rows → a note, no reason", rec: recorded(A, { ph: ph("hint") }), now: used(B, ph("hint"), "only", GONE),
    note: `the expectation read placeholder rows from ${A}, which no longer exists; ${B} (used now) declares the same placeholder rows` },
  { name: "placeholders: no plan now, the recorded one gone → a REASON (they decided what is compared)", rec: recorded(A, { ph: ph("hint") }), now: { now: null, recordedGone: GONE },
    reason: /^the expectation read placeholder rows from scratch\/mine\.json, which no longer exists, and no plan describes this frame now — whether they still hold is not checked; pass --compare … --plan <plan\.json>/ },
  // one --expect reads one plan: a placeholder-only record names it for the interactions too
  { name: "interactions declared by another plan than the one the placeholder rows came from → 'merged none', re-run --expect --plan <it>", rec: recorded(A, { ph: ph("hint") }),
    now: used(B, { ...ph("hint"), ...ix("url") }, "only", GONE),
    reason: `the plan's interactions[] changed since --expect (${B}: the expectation merged none) — re-run --expect --plan ${B}`,
    note: `the expectation read placeholder rows from ${A}, which no longer exists; ${B} (used now) declares the same placeholder rows` },
];
const fits = (got: string[], want: RegExp | string | undefined): boolean =>
  want === undefined ? got.length === 0 : got.length === 1 && (typeof want === "string" ? got[0] === want : want.test(got[0] ?? ""));
for (const t of table) {
  const b = planAtCompare(t.rec, t.now);
  check(`${t.name} (reasons ${one(b.reasons)}; notes ${one(b.notes)})`, fits(b.reasons, t.reason) && fits(b.notes, t.note));
}

console.log("planAtCompare — the rows compare applies:");
{
  const at = "2026-10-25T00:00:00Z", sha = "e".repeat(64);
  const plan: Plan = {
    waivers: [{ nodeId: "2:1", field: "font-size", designed: 14, built: 16, exportContentSha256: sha, reason: "kept", decidedBy: "owner", decidedAt: at }],
    descopes: [{ nodeId: "2:5", trigger: "on_click", exportContentSha256: sha, reason: "inert", decidedBy: "owner", decidedAt: at }],
    anchors: { "2:3": { foldedInto: "2:8" } }, navigate: [{ click: "#tab" }],
    deviations: [{ nodeId: "8:1", field: "reference", designed: "a sample chart", built: "the live chart", reason: "placeholder data" },
      { field: "reference", designed: "x", built: "y", reason: "the whole frame" }],
  };
  const b = planAtCompare({}, used(B, plan, "only"));
  check("waivers[], descopes[] and anchors{} as the plan holds them", b.file === B && b.waivers.length === 1 && b.descopes.length === 1 && b.anchors["2:3"]?.foldedInto === "2:8");
  check("report.inputs.waivers: the plan and waiversHash() of it", b.waiversInput?.plan === B && b.waiversInput.sha256 === waiversHash(plan));
  check("navigate[] parsed, declared", !!b.navigate && b.navigate.declared && "steps" in b.navigate.parsed && b.navigate.parsed.steps.length === 1);
  check("reference rows: their node ids (none = the frame) and reason",
    b.reference.length === 2 && b.reference[0]?.nodeIds[0] === "8:1" && b.reference[1]?.nodeIds.length === 0 && b.reference[1]?.reason === "the whole frame");
  const none = planAtCompare({}, null);
  check("no plan: nothing to apply, no waivers record, no reasons", none.file === null && none.waivers.length === 0 && none.descopes.length === 0
    && none.waiversInput === undefined && none.navigate === null && none.reasons.length === 0 && none.notes.length === 0);
  const odd = planAtCompare({}, used(B, { anchors: malformed<NonNullable<Plan["anchors"]>>([]) }, "only"));
  check("anchors that are not an object read as none", Object.keys(odd.anchors).length === 0);
}

// ---------------------------------------------------------------- selection
console.log("choosePlan — one rule for --expect and --compare:");
{
  const hit = (file: string): { file: string; plan: Plan } => ({ file, plan: { nodeId: "1:1" } });
  const flag = choosePlan(hit(A), { hits: [hit(B)], idless: [], several: null }, "1:1");
  check("--plan wins; a note names the node's other plans", flag.hit?.file === A && flag.hit.choice === "flag" && flag.note === `using ${A} (--plan); design/plan/ also describes node 1:1 in ${B}`);
  check("--plan naming the node's own plan: no note", choosePlan(hit(`./${B}`), { hits: [hit(B)], idless: [], several: null }, "1:1").note === undefined);
  const only = choosePlan(undefined, { hits: [hit(B)], idless: [], several: null }, "1:1");
  check("the node's one plan → choice only", only.hit?.file === B && only.hit.choice === "only" && only.error === undefined);
  const several = choosePlan(undefined, { hits: [hit(B), hit(C)], idless: [], several: "node 1:1 has 2 plans" }, "1:1");
  check("several → no plan, an error advising --plan", several.hit === undefined && several.error === "node 1:1 has 2 plans, or pass --plan <plan.json> (a multi-frame plan)");
  const none = choosePlan(undefined, { hits: [], idless: ["design/plan/x.json"], several: null }, "1:1");
  check("none → no plan, no error; the plans naming no node passed on", none.hit === undefined && none.error === undefined && none.idless[0] === "design/plan/x.json");
}

// ---------------------------------------------------------------- --compare: which plan (flag / found / recorded / gone)
console.log("resolvePlan — the plan --expect recorded wins over another found now:");
{
  const files: Record<string, Plan> = { [A]: ix("url"), [B]: ix("dialog"), [C]: ix("dialog") };
  const reader = (on: Record<string, Plan>): PlanReader => (file) => { const doc = on[file.replace(/^\.\//, "")]; return doc ? { doc } : { missing: true, error: "does not exist" }; };
  const sel = (hits: string[], o: { flag?: string; several?: string } = {}): PlanSelection =>
    choosePlan(o.flag ? { file: o.flag, plan: files[o.flag] ?? {} } : undefined, { hits: hits.map((f) => ({ file: f, plan: files[f] ?? {} })), idless: [], several: o.several ?? null }, "1:1");
  const res = (rec: Recorded, s: PlanSelection, flagged: boolean, on = files): ReturnType<typeof resolvePlan> => resolvePlan(rec, s, flagged, reader(on));
  const nowOf = (r: ReturnType<typeof resolvePlan>): string => ("error" in r ? `error: ${r.error}` : `${r.now?.file ?? "none"}/${r.now?.choice ?? "-"}${r.recordedGone ? ` gone(${r.recordedGone})` : ""}`);
  const rows: Array<{ name: string; r: ReturnType<typeof resolvePlan>; want: string; note?: RegExp | null }> = [
    { name: "nothing recorded → the plan found now", r: res({}, sel([B]), false), want: `${B}/only`, note: null },
    { name: "the recorded plan is the one found now → it, no note", r: res(recorded(B, { ix: ix("dialog") }), sel([B]), false), want: `${B}/only`, note: null },
    { name: "…spelled another way at --expect (./…) → the same plan, no note", r: res(recorded(`./${B}`, { ix: ix("dialog") }), sel([B]), false), want: `${B}/only`, note: null },
    { name: "recorded elsewhere, another found → the recorded one, a note naming the one found", r: res(recorded(A, { ix: ix("url") }), sel([B]), false), want: `${A}/recorded`,
      note: /^using scratch\/mine\.json \(the plan --expect merged interactions from\) instead of design\/plan\/Checkout__1_1\.json, the plan found in design\/plan\/ now — its interactions\[\], placeholder rows, waivers, descopes, anchors and navigate apply; pass --plan <plan\.json> to use another$/ },
    { name: "recorded elsewhere, several found (none chosen) → the recorded one, a note naming them, no error", r: res(recorded(A, { ix: ix("url") }), sel([B, C], { several: "node 1:1 has 2 plans" }), false),
      want: `${A}/recorded`, note: /^using scratch\/mine\.json \(the plan --expect merged interactions from\); 2 plans in design\/plan\/ describe this frame now \(design\/plan\/Checkout__1_1\.json, design\/plan\/Checkout_v2\.json\)/ },
    { name: "recorded elsewhere, none found → the recorded one", r: res(recorded(A, { ix: ix("url") }), sel([]), false), want: `${A}/recorded`, note: /; no plan in design\/plan\/ describes this frame —/ },
    { name: "a placeholder-only record names its plan the same way", r: res(recorded(A, { ph: ph("hint") }), sel([B]), false), want: `${A}/recorded`,
      note: /^using scratch\/mine\.json \(the plan --expect read placeholder rows from\)/ },
    { name: "--plan wins over the recorded one (no note — the reasons name both)", r: res(recorded(A, { ix: ix("url") }), sel([B], { flag: C }), true), want: `${C}/flag`, note: null },
    { name: "the recorded one gone → the one found, gone said", r: res(recorded(A, { ix: ix("url") }), sel([B]), false, { [B]: ix("dialog") }), want: `${B}/only gone(no longer exists)`, note: null },
    { name: "the recorded one gone, --plan → the flag, gone said", r: res(recorded(A, { ix: ix("url") }), sel([], { flag: C }), true, { [C]: ix("dialog") }), want: `${C}/flag gone(no longer exists)`, note: null },
    { name: "the recorded one unreadable → why", r: resolvePlan(recorded(A, { ix: ix("url") }), sel([]), false, () => ({ error: "is not a plan" })),
      want: "none/- gone(is not a readable plan now (is not a plan))", note: null },
    { name: "the recorded one gone and several found → the selection's error (no guess)", r: res(recorded(A, { ix: ix("url") }), sel([B, C], { several: "node 1:1 has 2 plans" }), false, {}),
      want: "error: node 1:1 has 2 plans, or pass --plan <plan.json> (a multi-frame plan)" },
    { name: "an expectation naming two plans → an error naming both", r: res({ ...recorded(A, { ix: ix("url") }), ...recorded(B, { ph: ph("hint") }) }, sel([B]), false),
      want: `error: the expectation names two plans — interactions from ${A}, placeholder rows from ${B} — one --expect reads one plan: re-run --expect` },
  ];
  for (const t of rows) {
    const note = "error" in t.r ? undefined : t.r.note;
    check(`${t.name} (got ${nowOf(t.r)}${note ? `; note ${note}` : ""})`, nowOf(t.r) === t.want && (t.note === undefined || (t.note === null ? note === undefined : !!note && t.note.test(note))));
  }
  const both = res({ ...recorded(B, { ix: ix("dialog") }), ...recorded(`./${B}`, { ph: ph("hint") }) }, sel([B]), false);
  check(`interactions and placeholder rows of one plan, spelled two ways, are one plan: no error, no note (got ${nowOf(both)})`, nowOf(both) === `${B}/only` && !("error" in both) && both.note === undefined);
}

// ---------------------------------------------------------------- --expect: the rows the expectation consumes
console.log("planAtExpect — the rows --expect reads, and their record:");
{
  const plan: Plan = {
    deviations: [...(ph("hint").deviations ?? []), { nodeIds: ["2:10", "9:99"], field: "placeholder", designed: "x", built: "y", reason: "z" }],
    interactions: [{ nodeId: "2:9", trigger: "on_click", expect: "url" }, { nodeId: "2:9", trigger: "ON_CLICK", expect: "url" }, { nodeId: "2:10", trigger: "on_click", expect: "url" }, { trigger: "on_click", expect: "url" }],
  };
  const pe = planAtExpect({ file: B, plan });
  check("isPlaceholder: the ids its placeholder rows name (nodeId and nodeIds)", pe.isPlaceholder("2:9") && pe.isPlaceholder("2:10") && !pe.isPlaceholder("2:11"));
  const nodes: ExpectNodes = { visible: (id) => (id === "2:9" ? { name: "Search", file: "F", type: "TEXT" } : id === "2:10" ? { name: "Box", file: "F", type: "FRAME" } : undefined), hidden: () => false };
  const own: VerifyInteraction[] = [{ nodeId: "2:10", name: "Box", trigger: "on_click", action: "navigate" }];
  const m = pe.mergeInteractions(own, nodes);
  check(`mergeInteractions: a gradable row added with its node's file; a duplicate of an earlier plan row, of the export's own row, and a row with no nodeId dropped with why (got ${JSON.stringify(m?.record.dropped)})`,
    !!m && m.added.length === 1 && m.added[0]?.row.source === "plan" && m.added[0].file === "F" && m.record.merged === 1 && m.record.sha256 === planInteractionsSha256(plan)
    && m.record.dropped.length === 3 && /an earlier plan row/.test(m.record.dropped[0]?.why ?? "") && /the export's own interaction/.test(m.record.dropped[1]?.why ?? "") && /has no nodeId/.test(m.record.dropped[2]?.why ?? ""));
  check("mergeInteractions: a plan with no interactions list → no record", planAtExpect({ file: B, plan: ph("hint") }).mergeInteractions([], nodes) === undefined);
  const p = pe.placeholders(nodes);
  check(`placeholders: the visible TEXT ids; a FRAME and an unknown id dropped with why (got ${JSON.stringify(p)})`,
    !!p && p.plan === B && JSON.stringify(p.nodeIds) === '["2:9"]' && p.dropped.length === 2 && /a FRAME layer, not TEXT/.test(p.dropped[0]?.why ?? "") && /no visible node/.test(p.dropped[1]?.why ?? ""));
  check("placeholders: no rows → no record", planAtExpect({ file: B, plan: ix("url") }).placeholders(nodes) === undefined && planAtExpect(null).placeholders(nodes) === undefined);
}

// ---------------------------------------------------------------- through compare: one binding, the verdict reads it
console.log("compare() — the binding's reasons make the run incomplete, its notes are input notes:");
{
  const hint = { type: "TEXT" as const, id: "2:9", name: "Search", text: "Search", font: { family: "Inter", size: 14 } };
  const doc: ExpectInput = { doc: screenExport([{ type: "FRAME", id: "1:1", name: "Checkout", children: [hint] }]), label: "Checkout" };
  const exp = buildExpectation([doc], { plan: { file: A, plan: ph("hint") } });
  const m = { measuredAt: "2026-10-25T00:00:00Z", renderer: "playwright-chromium", viewport: "1280x800", nodes: [{ nodeId: "2:9", styles: { tag: "input", placeholderText: "Search" } }] };
  const placeholderWhy = (r: { why: string[] }): string[] => r.why.filter((w) => /placeholder row/.test(w));
  const same = compare(exp, m, { plan: usingPlan(ph("hint"), A, "flag") });
  check(`the plan --expect read, unchanged → no plan reason (got ${same.why.join(" | ")})`, placeholderWhy(same).length === 0);
  const flagged = compare(exp, m, { plan: usingPlan(ph("edited"), B, "flag") });
  check(`--plan <another> → incomplete, the reason names the plan --expect read (got ${flagged.verdict}: ${placeholderWhy(flagged).join(" | ")})`,
    flagged.verdict === "incomplete" && placeholderWhy(flagged).length === 1 && placeholderWhy(flagged).every((w) => w.includes(`--expect read ${A}'s`)));
  const goneSame = compare(exp, m, { plan: { ...usingPlan(ph("hint"), B), recordedGone: GONE } });
  check("the recorded plan gone, the one found the same → no reason, the note in probe.inputNotes",
    placeholderWhy(goneSame).length === 0 && (goneSame.probe.inputNotes ?? []).some((n) => n.includes(`${A}, which no longer exists; ${B} (used now) declares the same`)));
  const waived = compare(exp, m, { plan: usingPlan({ ...ph("hint"), waivers: [] }, A, "flag") });
  check("report.inputs.waivers is the binding's record", waived.inputs?.waivers?.plan === A && waived.inputs.waivers.sha256 === waiversHash({ waivers: [] }));
}

report();
