// PROTOTYPE (#174, throwaway): the switches the owner tries in live Figma before one form of the designer's review is
// picked (docs/write-plane-spec.md decision 18). Pure: the plugin (figma-plugin/src/review-proto.ts) and figma_write's
// dry run (figma-mcp.ts previewWrites) both ask reviewDecision() whether a batch waits, so the two cannot disagree.
//   display — what the card adds to the plain lines: "list" (Show me buttons), "draft" (applied first, then Keep or
//             Put back), "drawing" (a schematic of a new tree, a thumbnail of what a patch or source edit touches).
//   when    — which batches wait: "today" (the checkbox, off by default), "checkbox-forced" (the checkbox reads ON when
//             never set, and even off a source edit or a batch over `threshold` layers waits), "overwrites" (everything
//             but a pure create waits; the checkbox is ignored).
// Defaults reproduce today's behaviour: display "list", when "today".
import type { WriteEffect } from "./commands.ts";

export const REVIEW_DISPLAYS = ["list", "draft", "drawing"] as const;
export const REVIEW_WHENS = ["today", "checkbox-forced", "overwrites"] as const;
export type ReviewDisplay = (typeof REVIEW_DISPLAYS)[number];
export type ReviewWhen = (typeof REVIEW_WHENS)[number];
export interface ReviewProto { display: ReviewDisplay; when: ReviewWhen; threshold: number }
export const REVIEW_PROTO_DEFAULT: ReviewProto = { display: "list", when: "today", threshold: 25 };

/** A stored or sent setting, read leniently: a field that is not one of the choices keeps its default. */
export function reviewProtoOf(raw: unknown): ReviewProto {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = REVIEW_PROTO_DEFAULT;
  const display = REVIEW_DISPLAYS.find((x) => x === o.display) || d.display;
  const when = REVIEW_WHENS.find((x) => x === o.when) || d.when;
  const t = typeof o.threshold === "number" && Number.isFinite(o.threshold) && o.threshold >= 0 ? Math.floor(o.threshold) : d.threshold;
  return { display, when, threshold: t };
}

/** What one op does to layers that already exist. `nodes`: the existing nodes it changes itself (a patch, move, delete,
 *  fill/text/mode op, a keyed re-send's root); `follows`: how many layers or instances follow a source edit. A create
 *  counts nothing. */
export interface OpFact { effect: WriteEffect; source?: boolean; nodes?: readonly string[]; follows?: number }

export interface ReviewDecision { wait: boolean; reason: string }

/** How many existing layers a batch changes: its ops' unique nodes, plus what follows its source edits. */
export function layersChanged(facts: readonly OpFact[]): number {
  const ids = new Set<string>();
  let follows = 0;
  for (const f of facts) {
    if (f.effect === "creates" && !f.source) continue;
    for (const id of f.nodes || []) ids.add(id);
    follows += f.follows || 0;
  }
  return ids.size + follows;
}

/** Whether a batch waits for the designer, and why (the card and the dry run show the reason). `checkbox` is the saved
 *  checkbox, undefined when it was never set: "checkbox-forced" reads that as ON, "today" as off. */
export function reviewDecision(when: ReviewWhen, checkbox: boolean | undefined, threshold: number, facts: readonly OpFact[]): ReviewDecision {
  if (when === "today") return checkbox === true ? { wait: true, reason: "'Review each write' is on" } : { wait: false, reason: "" };
  if (when === "overwrites") {
    const n = facts.filter((f) => f.effect !== "creates" || f.source).length;
    return n ? { wait: true, reason: n + " op" + (n === 1 ? "" : "s") + " overwrite, move, delete or edit a source" } : { wait: false, reason: "" };
  }
  const reasons: string[] = [];
  const sources = facts.filter((f) => f.source);
  if (sources.length) {
    const follow = sources.reduce((n, f) => n + (f.follows || 0), 0);
    reasons.push("source edit: " + follow + " layer" + (follow === 1 ? "" : "s") + " follow");
  }
  const changed = layersChanged(facts);
  if (changed > threshold) reasons.push(changed + " layers change — over " + threshold);
  if (checkbox !== false) reasons.unshift("'Review each change first' is on");
  return reasons.length ? { wait: true, reason: reasons.join("; ") } : { wait: false, reason: "" };
}
