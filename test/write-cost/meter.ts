// What a write costs the agent: every tool call it makes, the text it sends and the text it gets back.
//
// Tokens are ESTIMATED: ceil(characters / 4), the usual rule of thumb for English and JSON. It is the same rule for
// every route, so a route's saving against the baseline is a fair comparison even where the absolute count is off by
// a model's real tokenizer; `estimateTokens` is the one place to swap in a real one. The characters are counted too.
//
// "Out" is what the model writes: the tool name and its arguments as JSON. "In" is what it reads back: the reply's
// text content. A round trip is one tool call. The fixed cost of the tool definitions (sent with every session, not
// per call) is reported separately (`toolDefinition`).
//
// A reply's timing (`durationMs=<n>` in an outline) is replaced by `durationMs=0` before it is counted, so the same
// route measures the same on every run and machine.

/** The token estimate for one text. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
/** A reply's text with its run-to-run noise (timings) taken out. */
export const normalise = (text: string): string => text.replace(/durationMs=\d+/g, "durationMs=0");

/** Why a call was made: to find what to change, to write, to check the result, or to correct it after a check. */
export type Phase = "find" | "write" | "verify" | "fix";
export const PHASES: readonly Phase[] = ["find", "write", "verify", "fix"];

export interface Call { tool: string; phase: Phase; ops: number; outChars: number; inChars: number; out: number; in: number; isError: boolean }

/** One route's totals for one job. */
export interface Cost {
  /** round trips: tool calls */
  calls: number;
  /** write ops sent (figma_write ops; a route without ops sends 0) */
  ops: number;
  /** estimated tokens the model wrote (tool calls) */
  out: number;
  /** estimated tokens the model read (replies) */
  in: number;
  total: number;
  /** calls per phase */
  byPhase: Record<Phase, number>;
}

export class Ledger {
  readonly calls: Call[] = [];
  record(tool: string, args: unknown, phase: Phase, reply: string, isError: boolean): void {
    const outText = JSON.stringify({ tool, arguments: args });
    const inText = normalise(reply);
    const ops = tool === "figma_write" && typeof args === "object" && args !== null && "ops" in args && Array.isArray(args.ops) && !("dryRun" in args && args.dryRun === true) ? args.ops.length : 0;
    this.calls.push({ tool, phase, ops, outChars: outText.length, inChars: inText.length, out: estimateTokens(outText), in: estimateTokens(inText), isError });
  }
  cost(): Cost {
    const byPhase: Record<Phase, number> = { find: 0, write: 0, verify: 0, fix: 0 };
    let ops = 0, out = 0, inn = 0;
    for (const c of this.calls) { byPhase[c.phase]++; ops += c.ops; out += c.out; inn += c.in; }
    return { calls: this.calls.length, ops, out, in: inn, total: out + inn, byPhase };
  }
}
