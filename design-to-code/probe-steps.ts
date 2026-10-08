// probe-steps.ts — the closed step vocabulary that takes a freshly loaded page to a screen,
// and the plan-interaction `expect` → designed action map. Pure: no browser, no file system.
//
// A screen that is a section of a single-page app (picked by component state, not by the URL) cannot be reached
// with --url alone: the probe would measure the default section and every spec would read as "not measured", so a
// screen is reached by a short list of steps replayed after every page load — in the measurement pass, its re-run
// and every interaction-driving page. Because they are replayed many times, a step must be IDEMPOTENT and NAVIGATION-ONLY:
// click (a link, a tab, a sidebar button), waitFor (a selector to be visible), goto (a same-origin path). No fill,
// press or hover: a typed value or a key press may submit a form, and a replay would submit it again.
import { sha256Hex } from "../bridge/src/hash.ts";
import { canonical } from "./plan-waivers.ts";
import { isJsonObject } from "./types.ts";
import type { PlanInteractionExpect, ProbeStep } from "./types.ts";

/** The step keys, in the order they are named in messages. */
export const STEP_KINDS = ["click", "waitFor", "goto"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
const isStepKind = (k: string): k is StepKind => (STEP_KINDS as readonly string[]).includes(k);

// keys a person is likely to try — refused by name, with the reason
const REFUSED: Record<string, string> = {
  fill: "a typed value may submit a form when the steps are replayed",
  type: "a typed value may submit a form when the steps are replayed",
  press: "a key press may submit a form when the steps are replayed",
  hover: "a hover is not a navigation (hover-revealed openers are revealed by the probe itself)",
  check: "a checked box is state, not navigation",
  select: "a selected option is state, not navigation",
};

/** One step as `{click: "…"}` — how messages name it. */
export function describeStep(s: ProbeStep, i: number): string {
  const [k, v] = Object.entries(s)[0] ?? ["?", ""];
  return `step ${i + 1} {${k}: ${JSON.stringify(v)}}`;
}

/** A goto value that can only resolve on the page's own origin: starts with "/", not "//" or "/\\" (browsers read
 *  both as a scheme-relative URL to another host), and holds no backslash (read as "/"), whitespace or control
 *  character (a URL parser strips tabs/newlines, so "/\t/host" becomes "//host"). */
function isSameOriginPath(v: string): boolean {
  return v.startsWith("/") && !v.startsWith("//") && !/[\\\s\u0000-\u001f\u007f]/.test(v);
}

/**
 * A steps list from what a --steps file (or plan.navigate) holds: a JSON array of steps, or any object with a
 * `navigate` array (a plan). Each step has exactly one key of click / waitFor / goto with a non-empty string;
 * goto is a same-origin path ("/x?y", never "//host" or a URL). Anything else is refused, naming the step.
 */
export function parseSteps(x: unknown): { steps: ProbeStep[] } | { error: string } {
  const list: unknown = Array.isArray(x) ? x : isJsonObject(x) && x.navigate !== undefined ? x.navigate : undefined;
  if (!Array.isArray(list)) {
    return { error: isJsonObject(x) ? "holds no `navigate` list — pass a JSON array of steps, or a plan with navigate: [...]" : "is not a list of steps (a JSON array, or a plan with navigate: [...])" };
  }
  const steps: ProbeStep[] = [];
  for (const [i, raw] of list.entries()) {
    const at = `step ${i + 1}`;
    if (!isJsonObject(raw)) return { error: `${at} is not an object like {"click": "<selector>"}` };
    const keys = Object.keys(raw);
    const k = keys[0];
    if (keys.length !== 1 || k === undefined) return { error: `${at} has ${keys.length ? `${keys.length} keys (${keys.join(", ")})` : "no key"} — exactly one of ${STEP_KINDS.join(" / ")}` };
    const v = raw[k];
    if (!isStepKind(k)) {
      // own keys only — "__proto__" / "constructor" must not read Object.prototype
      const lk = k.toLowerCase();
      const why = Object.hasOwn(REFUSED, k) ? REFUSED[k] : Object.hasOwn(REFUSED, lk) ? REFUSED[lk] : undefined;
      return { error: `${at} {${k}: …} is not a step — the vocabulary is ${STEP_KINDS.join(" / ")} (navigation only)${why ? `: ${why}` : ""}` };
    }
    if (typeof v !== "string" || v.trim() === "") return { error: `${at} {${k}: …} needs a non-empty string` };
    if (k === "goto" && !isSameOriginPath(v)) return { error: `${at} {goto: ${JSON.stringify(v)}} must be a same-origin path starting with "/" (e.g. "/orders?tab=open") — never "//" or "/\\", and no backslash, whitespace or control character` };
    steps.push(k === "click" ? { click: v } : k === "waitFor" ? { waitFor: v } : { goto: v });
  }
  return { steps };
}

/** sha256 (hex) of the steps' canonical JSON — the same steps hash the same whatever the file's formatting. */
export function stepsSha256(steps: readonly ProbeStep[]): string {
  return sha256Hex(canonical(steps));
}

/** The plan `expect` values. */
export function isPlanExpect(x: unknown): x is PlanInteractionExpect {
  return x === "dialog" || x === "url" || (typeof x === "string" && x.startsWith("selector:") && x.length > "selector:".length);
}
/** The designed action a plan interaction's `expect` stands for (verify-screen OUTCOMES_FOR_ACTION keys). */
export function actionForExpect(expect: PlanInteractionExpect): "overlay" | "navigate" | "other" {
  return expect === "dialog" ? "overlay" : expect === "url" ? "navigate" : "other";
}
