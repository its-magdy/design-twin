// When a write waits for the designer's review (docs/write-plane-spec.md decision 18), and when its card offers a
// preview on the canvas. Pure: the plugin (figma-plugin/src/writes.ts) decides with it before a batch runs, and
// figma_write's dry run (figma-mcp.ts previewWrites) asks it the same question from what it can see, so the two say
// the same thing.
//
// A batch waits when
//   - "Review each change first" is ticked in the plugin window (on by default: a box never set reads ON), or, whatever
//     the box says,
//   - it edits a source: a variable, a style, or a main component through `patch` — one change other layers follow;
//   - it is a bulk change by rule (`patchWhere`, figma-plugin/src/rules.ts: `bulkByRule`);
//   - the existing layers changed since the designer's last approval, this batch included, exceed REVIEW_LAYER_LIMIT.
// The layers counted are the existing ones a batch patches, moves or deletes (a keyed re-send: the layers of its earlier
// result its update changes, moves or removes) plus the layers and instances that follow its source edits, each once; the layers this plugin session created do not count (the designer is watching
// them appear). The count is kept per plugin session and goes back to 0 when the designer approves a batch (or keeps
// its preview), so a large change sent in chunks of 25 still stops at the chunk that crosses the line.
//
// The preview ("Preview on canvas") is offered for what is hard to judge from words: a source edit, a bulk change by
// rule, a batch over the limit by itself. Not for a batch with a delete or a keyed re-send: those cannot be put back.

/** The most existing layers that change between two of the designer's approvals before a write must wait. Fixed. */
export const REVIEW_LAYER_LIMIT = 25;

/** What the decision reads of one batch, and of the session it arrives in. */
export interface ReviewFacts {
  /** "Review each change first" as the designer left it (true when never set) */
  checkbox: boolean;
  /** how many of its ops edit a source (setVariable, setStyle, a patch of a main component) */
  sourceEdits: number;
  /** the batch changes layers it picks by a rule (a patchWhere) */
  bulkByRule: boolean;
  /** the existing layers it changes (see the header), each once */
  layers: number;
  /** the existing layers changed since the designer's last approval, this plugin session */
  sinceApproval: number;
}

export interface ReviewDecision {
  wait: boolean;
  /** why, in the designer's words (the card shows it, the dry run returns it as `waitReason`); "" when it does not wait */
  reason: string;
}

const plural = (n: number, one: string, many: string = one + "s"): string => n + " " + (n === 1 ? one : many);

/** Whether a batch waits for the designer, and why. Every reason that holds is named, the checkbox last (it says
 *  least: the others are why it would wait even with the box clear). */
export function reviewDecision(f: ReviewFacts): ReviewDecision {
  const reasons: string[] = [];
  if (f.sourceEdits) reasons.push("it changes " + (f.sourceEdits === 1 ? "a variable, style or main component" : f.sourceEdits + " variables, styles or main components") + " that other layers follow");
  if (f.bulkByRule) reasons.push("it changes layers it picks by a rule");
  const total = f.sinceApproval + f.layers;
  if (total > REVIEW_LAYER_LIMIT) {
    reasons.push(f.sinceApproval
      ? plural(total, "existing layer") + " would have changed since your last approval (over " + REVIEW_LAYER_LIMIT + ")"
      : "it changes " + plural(total, "existing layer") + " (over " + REVIEW_LAYER_LIMIT + ")");
  }
  if (f.checkbox) reasons.push("'Review each change first' is on");
  return reasons.length ? { wait: true, reason: reasons.join("; ") } : { wait: false, reason: "" };
}

/** What the preview offer reads of one batch. */
export interface PreviewFacts {
  sourceEdits: number;
  bulkByRule: boolean;
  /** the existing layers this batch alone changes */
  layers: number;
  /** it deletes a node, or a keyed createTree re-sends (and so may remove nodes): neither can be put back */
  deletes: boolean;
  keyedResend: boolean;
}

/** Whether the card offers "Preview on canvas". */
export function previewOffered(f: PreviewFacts): boolean {
  if (f.deletes || f.keyedResend) return false;
  return f.sourceEdits > 0 || f.bulkByRule || f.layers > REVIEW_LAYER_LIMIT;
}

/** The layers a batch changes, counted once: the ids of the existing layers it changes and the ones that follow its
 *  source edits. `own` says which ids this plugin session created (they do not count). */
export function countLayers(ids: Iterable<string>, own: (id: string) => boolean): number {
  const seen = new Set<string>();
  for (const id of ids) if (!own(id)) seen.add(id);
  return seen.size;
}
