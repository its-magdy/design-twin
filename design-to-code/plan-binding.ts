// plan-binding.ts — which plan a verify run uses, and what of it binds the run. ONE module for both steps:
//   - selection (choosePlan): --plan, else the one plan of the frame's node — --expect and --compare pick by the same rule;
//   - --expect (planAtExpect): the plan's sections the expectation consumes — interactions[] merged beside the export's,
//     the TEXT layers its placeholder rows (deviations[] field "placeholder") declare — and the record of each (which
//     plan, the hash of its rows: expectation.planInteractions / planPlaceholders);
//   - --compare (resolvePlan, then planAtCompare): the plan the expectation recorded wins over another found now (flag /
//     found / recorded / gone), and the binding of the plan used: its waivers/descopes/anchors/navigate/reference rows
//     for compare to apply, the hash of its waivers the report records, and — against what the expectation recorded —
//     the reasons the run cannot pass (a bound section drifted) and the notes beside them.
// No file reads (resolvePlan takes a reader); the hashes are the ones report-freshness.ts judges a report's waivers by.
import path from "node:path";
import { sha256Hex } from "../bridge/src/hash.ts";
import { canonical, ifDefined } from "../bridge/src/json-util.ts";
import { actionForExpect, isPlanExpect, parseSteps } from "./probe-steps.ts";
import { isJsonObject } from "./types.ts";
import type { Plan, PlanAnchor, PlanDeviation, PlanInteractionsInput, PlanPlaceholdersInput, VerifyExpectation, VerifyInteraction } from "./types.ts";

// ---------------------------------------------------------------- the plan's rows and their hashes

/** sha256 (hex) of the canonical JSON of {waivers, descopes}; `[]`, absent or non-array hash as the empty set. */
export function waiversHash(plan: Plan | null | undefined): string {
  const waivers = Array.isArray(plan?.waivers) ? plan.waivers : [];
  const descopes = Array.isArray(plan?.descopes) ? plan.descopes : [];
  return sha256Hex(canonical({ descopes, waivers }));
}

/** The plan's placeholder rows: deviations[] with field "placeholder" — a TEXT layer the builder declares it built as a
 *  form control's placeholder attribute (Figma has no such role: a hint and a value are both just TEXT). */
function placeholderRows(plan: Plan | null | undefined): PlanDeviation[] {
  return (Array.isArray(plan?.deviations) ? plan.deviations : []).filter((d) => d && d.field === "placeholder");
}
/** the plan's interactions[] rows; absent or non-array is none */
const interactionRows = (plan: Plan | null | undefined): unknown[] => (Array.isArray(plan?.interactions) ? plan.interactions : []);

/** a plan deviation row's node ids (nodeId and nodeIds), trimmed */
const rowIds = (d: PlanDeviation): string[] =>
  [d.nodeId, ...(Array.isArray(d.nodeIds) ? d.nodeIds : [])].filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());

/** The sections that bind an expectation: the rows --expect read, hashed (canonical JSON; none hashes as `[]`) into the
 *  record it writes, and the wording --compare's reasons and notes use for each. */
interface BoundSection {
  key: "planInteractions" | "planPlaceholders";
  rows: (plan: Plan | null | undefined) => unknown[];
  /** what the reasons call the rows */
  name: string;
  /** what --expect did with them, and what the notes call them ("--expect merged …", "the expectation read placeholder rows",
   *  "declares the same interactions[]") */
  verb: string; noun: string; same: string;
  /** the reason for rows the expectation never read, before " — re-run --expect…" */
  unread: (file: string, n: number) => string;
  /** with no plan to check them against at --compare: a reason (they decided what is compared — not a pass), else a note */
  uncheckedBlocks: boolean;
}
const INTERACTIONS: BoundSection = { key: "planInteractions", rows: interactionRows, name: "the plan's interactions[]", verb: "merged", noun: "plan interactions",
  same: "interactions[]", unread: (file) => `the plan's interactions[] changed since --expect (${file}: the expectation merged none)`, uncheckedBlocks: false };
const PLACEHOLDERS: BoundSection = { key: "planPlaceholders", rows: placeholderRows, name: `the plan's placeholder rows (deviations[] field "placeholder")`, verb: "read",
  noun: "placeholder rows", same: "placeholder rows",
  unread: (file, n) => `the plan declares ${n} placeholder row(s) (deviations[] field "placeholder") the expectation never read (${file})`, uncheckedBlocks: true };
const SECTIONS: readonly BoundSection[] = [INTERACTIONS, PLACEHOLDERS];
const sectionSha = (s: BoundSection, plan: Plan | null | undefined): string => sha256Hex(canonical(s.rows(plan)));

/** sha256 (hex) of the canonical JSON of plan.interactions — the hash expectation.planInteractions records. */
export const planInteractionsSha256 = (plan: Plan | null | undefined): string => sectionSha(INTERACTIONS, plan);

// ---------------------------------------------------------------- selection

/** How a plan was chosen for a frame: "flag" = --plan, "only" = the one plan of the frame's node, "recorded" = --compare's:
 *  the plan file the expectation recorded (recordedPlanOf), when another plan (or none, or several) is found now. */
type PlanChoice = "flag" | "only" | "recorded";
export interface ChosenPlan { file: string; plan: Plan; choice?: PlanChoice }

/** Two spellings of one plan file (`./design/plan/x.json`, an absolute path) are the same plan. */
function samePlanFile(a: string, b: string): boolean { return path.resolve(a) === path.resolve(b); }

/** The plans of a frame's node found on disk (node-artefacts.ts plansFound): the hits, the plans naming no node, and the
 *  refusal when there are several. */
export interface PlansFound { hits: Array<{ file: string; plan: Plan }>; idless: string[]; several: string | null }
export interface PlanSelection { hit?: ChosenPlan; all: Array<{ file: string; plan: Plan }>; idless: string[]; note?: string; error?: string }

/** ONE plan-selection rule for --expect and --compare (they must pick the same plan, or the bound sections' hashes can
 *  never agree and the run stays incomplete): --plan (the other plans of the node named in `note`); else the one plan of
 *  the frame's node; several are a data error (`error`: keep one, or pass --plan — a multi-frame plan); none is no plan. */
export function choosePlan(flagged: { file: string; plan: Plan } | undefined, found: PlansFound, frameId: string | undefined): PlanSelection {
  const { hits: all, idless, several } = found;
  if (flagged) {
    const others = all.filter((h) => !samePlanFile(h.file, flagged.file));
    return { hit: { ...flagged, choice: "flag" }, all, idless, ...(others.length ? { note: `using ${flagged.file} (--plan); design/plan/ also describes node ${frameId ?? "?"} in ${others.map((h) => h.file).join(", ")}` } : {}) };
  }
  if (all.length === 1 && all[0]) return { hit: { ...all[0], choice: "only" }, all, idless };
  if (several !== null) return { all, idless, error: `${several}, or pass --plan <plan.json> (a multi-frame plan)` };
  return { all, idless };
}

// ---------------------------------------------------------------- --expect

/** What --expect knows of a node a plan row names: visible (its name, Figma file and type) or a hidden layer. */
export interface ExpectNodes {
  visible: (id: string) => { name: string; file: string; type: string } | undefined;
  hidden: (id: string) => boolean;
}
/** The plan as --expect consumes it. */
export interface PlanAtExpect {
  /** the plan declares this node a placeholder (a deviations[] row with field "placeholder") */
  isPlaceholder: (nodeId: string) => boolean;
  /** the plan's interactions[] beside the export's own rows: the rows to add (each with its node's file) and the record —
   *  undefined when the plan has no interactions list */
  mergeInteractions: (own: readonly VerifyInteraction[], nodes: ExpectNodes) => { added: Array<{ row: VerifyInteraction; file: string }>; record: PlanInteractionsInput } | undefined;
  /** the record of the placeholder rows: the visible TEXT layers they name, the rest dropped with why — undefined when none */
  placeholders: (nodes: ExpectNodes) => PlanPlaceholdersInput | undefined;
}

export function planAtExpect(planIn: { file: string; plan: Plan } | null | undefined): PlanAtExpect {
  const rows = planIn ? placeholderRows(planIn.plan) : [];
  const placeholderIds = new Set(rows.flatMap(rowIds));
  return {
    isPlaceholder: (id) => placeholderIds.has(id),
    // plan.interactions[] — interactions the export cannot carry (a control with no prototype reaction). Merged only when
    // the row can be graded like an export row: a visible node of this export, a known `expect` (→ the action
    // OUTCOMES_FOR_ACTION grades), a dialog naming the frame it opens, and no export row with the same nodeId + trigger
    // (the export wins). Every other row is dropped with why. exportContentSha256 does not change (waivers bind the
    // export, not the plan); only the rows' own hash binds (planInteractions.sha256).
    mergeInteractions(own, nodes) {
      if (!(planIn && Array.isArray(planIn.plan.interactions))) return undefined;
      const dropped: Array<{ nodeId: string; why: string }> = [];
      const added: Array<{ row: VerifyInteraction; file: string }> = [];
      const keys = new Set(own.map((r) => `${r.nodeId}|${r.trigger}`));
      planIn.plan.interactions.forEach((raw, k) => {
        const at = `interactions[${k}]`;
        const o = isJsonObject(raw) ? raw : null;
        const id = o && typeof o.nodeId === "string" && o.nodeId.trim() ? o.nodeId.trim() : null;
        const drop = (why: string): void => { dropped.push({ nodeId: id ?? `(${at})`, why }); };
        if (!o) return drop(`${at} is not an object`);
        if (id === null) return drop(`${at} has no nodeId — a plan interaction is keyed by its node like an export reaction`);
        if (typeof o.trigger !== "string" || !o.trigger.trim()) return drop("no trigger (on_click, on_press, …)");
        if (!isPlanExpect(o.expect)) return drop(`expect ${JSON.stringify(o.expect ?? null)} is not dialog | url | selector:<css>`);
        if (o.destinationId !== undefined && (typeof o.destinationId !== "string" || !o.destinationId.trim())) return drop("destinationId is not a node id");
        if (o.expect === "dialog" && o.destinationId === undefined) return drop("expect dialog needs the destinationId of the frame it opens (its root is tagged with it)");
        const node = nodes.visible(id);
        if (!node) return drop(nodes.hidden(id) ? "the node is a hidden layer — it is not built or driven" : "no visible node of this export has that id");
        const trigger = o.trigger.trim().toLowerCase();
        // the probe opens a dialog by clicking its opener — a dialog row on any other trigger (hover, key, drag…)
        // could never be driven, so it would sit not-probed forever
        if (o.expect === "dialog" && trigger !== "on_click" && trigger !== "on_press") return drop(`expect dialog needs trigger on_click or on_press (the probe opens a dialog by clicking its opener), not ${trigger}`);
        if (keys.has(`${id}|${trigger}`)) return drop(`duplicates ${own.some((r) => r.nodeId === id && r.trigger === trigger) ? "the export's own interaction" : "an earlier plan row"} for ` +
          `this node and trigger (${trigger})`);
        keys.add(`${id}|${trigger}`);
        const destinationId = typeof o.destinationId === "string" ? o.destinationId.trim() : undefined;
        added.push({ row: { nodeId: id, name: node.name, trigger, action: actionForExpect(o.expect), expect: o.expect, ...ifDefined("destinationId", destinationId), source: "plan" }, file: node.file });
      });
      return { added, record: { plan: planIn.file, sha256: planInteractionsSha256(planIn.plan), merged: added.length, dropped } };
    },
    // the plan's placeholder rows — a TEXT the builder built as a form control's placeholder attribute. Read only from the
    // plan, never guessed: its copy and colour move to placeholderText / placeholderColor (compared, never waived). A row
    // naming no visible TEXT layer of this export is dropped with why.
    placeholders(nodes) {
      if (!planIn || !rows.length) return undefined;
      const nodeIds: string[] = [], dropped: Array<{ nodeId: string; why: string }> = [];
      rows.forEach((d, k) => {
        const ids = rowIds(d);
        if (!ids.length) dropped.push({ nodeId: `(placeholder row #${k})`, why: "the row names no nodeId — a placeholder is declared per TEXT layer" });
        for (const id of ids) {
          const type = nodes.visible(id)?.type;
          if (type === "TEXT") { if (!nodeIds.includes(id)) nodeIds.push(id); }
          else dropped.push({ nodeId: id, why: type !== undefined ? `a ${type} layer, not TEXT — only a text layer can be a placeholder`
            : nodes.hidden(id) ? "the node is a hidden layer — it is not built" : "no visible node of this export has that id" });
        }
      });
      return { plan: planIn.file, sha256: sectionSha(PLACEHOLDERS, planIn.plan), nodeIds, dropped };
    },
  };
}

// ---------------------------------------------------------------- --compare: which plan

/** What an expectation recorded of the plan it read: each bound section's {plan, sha256} (a malformed record is none). */
type Recorded = Pick<VerifyExpectation, "planInteractions" | "planPlaceholders">;
const recordOf = (exp: Recorded, s: BoundSection): { plan: string; sha256: string } | undefined => {
  const v: unknown = exp[s.key];
  return isJsonObject(v) && typeof v.plan === "string" && typeof v.sha256 === "string" ? { plan: v.plan, sha256: v.sha256 } : undefined;
};

/** The plan file the expectation read (one --expect reads one plan), with the section that names it; two sections naming
 *  different plans is an error no --expect writes. */
function recordedPlanOf(exp: Recorded): { file?: string; section?: BoundSection["key"] } | { error: string } {
  const named = SECTIONS.flatMap((s) => { const v: unknown = exp[s.key]; return isJsonObject(v) && typeof v.plan === "string" ? [{ s, file: v.plan }] : []; });
  const [first, ...rest] = named;
  const clash = rest.find((r) => first && !samePlanFile(r.file, first.file));
  if (first && clash) return { error: `the expectation names two plans — interactions from ${first.file}, placeholder rows from ${clash.file} — one --expect reads one plan: re-run --expect` };
  return first ? { file: first.file, section: first.s.key } : {};
}

/** The plan --compare uses: the one chosen now, unless the expectation recorded another — gone (`recordedGone`: why it
 *  could not be used: "no longer exists" / "is not a readable plan now (…)") or not. */
export interface PlanResolution { now: ChosenPlan | null; recordedGone?: string }
/** reads a plan file: the plan, or why not (`missing`: no such file) */
export type PlanReader = (file: string) => { doc: Plan } | { missing?: true; error: string };

/** --compare's plan: the plan the expectation recorded wins over another found now — --expect may have been given --plan,
 *  or design/plan/ changed since; without --plan, check the rows it read. `note` (an input note) says when the recorded
 *  plan replaced the one found. Errors: the expectation names two plans; several plans of the node and none to go by
 *  (waivers, descopes and the code hashes would come from a guess). */
export function resolvePlan(exp: Recorded, sel: PlanSelection, flagged: boolean, read: PlanReader): (PlanResolution & { note?: string }) | { error: string } {
  const rec = recordedPlanOf(exp);
  if ("error" in rec) return rec;
  let now: ChosenPlan | null = sel.hit ?? null;
  let recordedGone: string | undefined, note: string | undefined;
  if (rec.file !== undefined && !(now && samePlanFile(now.file, rec.file))) {
    const r = read(rec.file);
    if (!("doc" in r)) recordedGone = r.missing ? "no longer exists" : `is not a readable plan now (${r.error})`;
    else if (!flagged) {
      const foundNow = now ? ` instead of ${now.file}, the plan found in design/plan/ now` : sel.all.length ? `; ${sel.all.length} plans in design/plan/ describe this frame now (${sel.all.map((h) => h.file).join(", ")})`
        : "; no plan in design/plan/ describes this frame";
      note = `using ${rec.file} (the plan --expect ${rec.section === "planInteractions" ? "merged interactions from" : "read placeholder rows from"})${foundNow} — its interactions[], placeholder rows, waivers, descopes, anchors and navigate apply; pass --plan <plan.json> to use another`;
      now = { file: rec.file, plan: r.doc, choice: "recorded" };
    }
  }
  if (!now && sel.error !== undefined) return { error: sel.error };
  return { now, ...ifDefined("recordedGone", recordedGone), ...ifDefined("note", note) };
}

// ---------------------------------------------------------------- --compare: what binds

/** The binding of the plan --compare uses: the rows compare applies, the waivers hash the report records, and — against
 *  the expectation's record — why the run cannot pass and what to note. */
export interface PlanBinding {
  /** the plan used (null: none) — named in compare's notes */
  file: string | null;
  /** the plan's waivers[] / descopes[] (each row checked where it is applied) and its anchors{} */
  waivers: unknown[]; descopes: unknown[]; anchors: Record<string, PlanAnchor>;
  /** report.inputs.waivers: the plan and waiversHash() of it */
  waiversInput?: { plan: string; sha256: string };
  /** the plan's navigate[] parsed (null: it declares none); `declared` = a non-empty list */
  navigate: { parsed: ReturnType<typeof parseSteps>; declared: boolean } | null;
  /** the plan's deviations[] with field "reference": the reference PNG is illustrative for those nodes (none named = the frame) */
  reference: Array<{ nodeIds: string[]; reason: string }>;
  /** a bound section changed since --expect (or could not be checked, where that blocks): the verdict's reasons */
  reasons: string[];
  /** the report's input notes */
  notes: string[];
}

/** Each bound section the expectation recorded against the plan used now: unchanged, drifted (a reason with the re-run that
 *  fixes it), or not checkable (no plan now). The advice names --plan when the plan was not simply the frame's only one
 *  (picked by --plan, or as the recorded plan), or the expectation read another plan — a plain re-run of --expect could
 *  otherwise pick a different plan. When the expectation read ANOTHER plan file, both are named, never only the one used now. */
function sectionDrift(s: BoundSection, exp: Recorded, recorded: string | undefined, r: PlanResolution): { reason?: string; note?: string } {
  const rec = recordOf(exp, s), now = r.now, gone = r.recordedGone;
  if (!now) {
    if (!rec) return {};
    const text = `the expectation ${s.verb} ${s.noun} from ${rec.plan}${gone ? `, which ${gone},` : ","} and no plan describes this frame now — ${s.uncheckedBlocks ? "whether they still hold is not checked" : "not checked"}; ` +
      `pass --compare … --plan <plan.json>, or re-run --expect … --plan <plan.json>`;
    return s.uncheckedBlocks ? { reason: text } : { note: text };
  }
  const n = s.rows(now.plan).length, sha = sectionSha(s, now.plan);
  const otherPlan = recorded !== undefined && !samePlanFile(recorded, now.file);
  if (rec ? rec.sha256 === sha : n === 0) {
    return rec && otherPlan && gone ? { note: `the expectation ${s.verb} ${s.noun} from ${rec.plan}, which ${gone}; ${now.file} (used now) declares the same ${s.same}` } : {};
  }
  const rerun = now.choice === "flag" || now.choice === "recorded" || otherPlan ? ` --plan ${now.file}` : "";
  if (!rec) return { reason: `${s.unread(now.file, n)} — re-run --expect${rerun}` };
  const was = `${rec.sha256.slice(0, 12)}…`, is = `${sha.slice(0, 12)}…`;
  if (otherPlan && now.choice === "flag") return { reason: `${s.name} differ from those --expect ${s.verb} (${now.file}, passed by --plan: sha256 ${is}; --expect ${s.verb} ${rec.plan}'s${gone ? `, which ${gone}` : ""}: ${was}) — ` +
    `re-run --expect --plan ${now.file}${gone ? "" : `, or drop --plan at --compare to check against ${rec.plan}`}` };
  if (otherPlan) return { reason: `${s.name} at --expect came from ${rec.plan}, which ${gone ?? "--compare did not use"}; the plan found now, ${now.file}, declares others (sha256 ${was} at --expect, ${is} now) — ` +
    `if that plan moved, re-run --compare … --plan <its path now>; otherwise re-run --expect … --plan <the plan you intend> (--plan ${now.file} to adopt this one)` };
  return { reason: `${s.name} changed since --expect (${now.file}: sha256 ${was} at --expect, ${is} now) — re-run --expect${rerun}` };
}

/** The binding of `r` (the plan --compare uses; none = no plan) for an expectation. */
export function planAtCompare(exp: Recorded, r: PlanResolution | null | undefined): PlanBinding {
  const res: PlanResolution = r ?? { now: null };
  const plan = res.now ? res.now.plan : null;
  const rec = recordedPlanOf(exp);
  const recorded = "file" in rec ? rec.file : undefined;
  const reasons: string[] = [], notes: string[] = [];
  for (const s of SECTIONS) {
    const d = sectionDrift(s, exp, recorded, res);
    if (d.reason) reasons.push(d.reason);
    if (d.note) notes.push(d.note);
  }
  const reference: PlanBinding["reference"] = [];
  for (const d of plan && Array.isArray(plan.deviations) ? plan.deviations : []) {
    if (!isJsonObject(d) || d.field !== "reference") continue;
    const nodeIds = [...(typeof d.nodeId === "string" && d.nodeId ? [d.nodeId] : []), ...(Array.isArray(d.nodeIds) ? d.nodeIds.filter((x): x is string => typeof x === "string" && x !== "") : [])];
    reference.push({ nodeIds, reason: typeof d.reason === "string" && d.reason ? d.reason : typeof d.what === "string" ? d.what : "" });
  }
  return {
    file: res.now ? res.now.file : null,
    waivers: plan && Array.isArray(plan.waivers) ? plan.waivers : [],
    descopes: plan && Array.isArray(plan.descopes) ? plan.descopes : [],
    anchors: plan && isJsonObject(plan.anchors) ? plan.anchors : {},
    ...(res.now ? { waiversInput: { plan: res.now.file, sha256: waiversHash(plan) } } : {}),
    navigate: plan && plan.navigate !== undefined ? { parsed: parseSteps({ navigate: plan.navigate }), declared: Array.isArray(plan.navigate) && plan.navigate.length > 0 } : null,
    reference, reasons, notes,
  };
}
