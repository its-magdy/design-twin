// reaction-spec.ts — prototype interactions and flows (docs/write-plane-spec.md decision 22): what a tap opens, overlays,
// back navigation, and the frames a prototype starts from.
//
//   {op: "setReactions", nodeId: "12:4", reactions: [{trigger: "on_click", actions: [{type: "node", destination: "Home",
//     transition: {type: "smart_animate", duration: 0.3}}]}]}
//   {op: "setFlowStart", nodeId: "12:1", name: "Onboarding"}      {op: "clearFlowStart", nodeId: "12:1"}
//
// `reactions` is the read export's form (figma-plugin/src/prototype.ts simplifyReactions; doc-types.ts Reaction), so a
// reaction read from a file is written back as it is: a trigger, then its actions. The list REPLACES the layer's
// reactions (`[]` removes them all). A destination is a node's exact id (`destinationId`, or `destination` when it
// reads as an id) or its exact name (`destination`), resolved by the plugin against the file (decision 15): a frame at
// the top of the layer's page (or in a section on it) for navigate, swap and overlay, a layer of the same top frame for
// scroll_to, a variant of the same component set for change_to (figma-plugin/src/reactions.ts).
//
// What only the file can say — the node has reactions, the destinations exist and are of the right kind, an overlay
// offset's destination is placed by hand — is the plugin's. Not written yet, each refused by name: variable actions
// (set_variable, set_variable_mode, conditional), media actions and triggers, and a frame's own overlay settings, which
// Figma's plugin API reads but cannot set.
//
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it stays ES2019 (no `??`, no `?.`).
import { isNodeId } from "./node-id.ts";
import { isObj, objectProblems, oneOf, refuse, type Check, type Rule } from "./tree-spec.ts";

/** The most reactions one setReactions op sets on its layer, and the most actions one reaction runs. */
export const MAX_REACTIONS = 50;
export const MAX_ACTIONS = 10;
/** A transition's duration when the spec gives none (seconds; Figma's own default), and the longest one accepted. */
export const DEFAULT_DURATION = 0.3;
export const MAX_DURATION = 10;
/** A transition's easing when the spec gives none (Figma's own default). */
export const DEFAULT_EASING = "ease_out";

export const TRIGGERS = ["on_click", "on_hover", "on_press", "on_drag", "after_timeout", "mouse_enter", "mouse_leave", "mouse_up", "mouse_down", "on_key_down"] as const;
export type WriteTrigger = (typeof TRIGGERS)[number];
export const NAVIGATIONS = ["navigate", "swap", "overlay", "scroll_to", "change_to"] as const;
export type WriteNavigation = (typeof NAVIGATIONS)[number];
export const SIMPLE_TRANSITIONS = ["dissolve", "smart_animate", "scroll_animate"] as const;
export const DIRECTIONAL_TRANSITIONS = ["move_in", "move_out", "push", "slide_in", "slide_out"] as const;
export const DIRECTIONS = ["left", "right", "top", "bottom"] as const;
export const EASINGS = ["ease_in", "ease_out", "ease_in_and_out", "linear", "ease_in_back", "ease_out_back", "ease_in_and_out_back", "custom_cubic_bezier", "gentle", "quick", "bouncy", "slow", "custom_spring"] as const;
export const DEVICES = ["keyboard", "xbox_one", "ps4", "switch_pro", "unknown_controller"] as const;

/** A transition as a write takes it (the read form): seconds, Figma's easing names lower-cased. */
export interface WriteTransition {
  type: (typeof SIMPLE_TRANSITIONS)[number] | (typeof DIRECTIONAL_TRANSITIONS)[number];
  direction?: (typeof DIRECTIONS)[number];
  matchLayers?: boolean;
  duration?: number;
  easing?: (typeof EASINGS)[number];
  cubicBezier?: { x1: number; y1: number; x2: number; y2: number };
  spring?: { mass: number; stiffness: number; damping: number; initialVelocity: number };
}
/** One action as a write takes it. */
export interface WriteAction {
  type: "back" | "close" | "url" | "node";
  url?: string;
  openInNewTab?: boolean;
  navigation?: WriteNavigation;
  destination?: string;
  destinationId?: string;
  transition?: WriteTransition;
  preserveScroll?: boolean;
  resetScroll?: boolean;
  resetVideo?: boolean;
  resetInteractive?: boolean;
  overlayOffset?: { x: number; y: number };
}
/** One reaction as a write takes it: a trigger (on_click when absent) and the actions it runs, in order. */
export interface WriteReaction {
  trigger?: WriteTrigger;
  timeout?: number;
  delay?: number;
  keyCodes?: number[];
  device?: (typeof DEVICES)[number];
  actions: WriteAction[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bool: Check = (v) => (typeof v === "boolean" ? null : "must be true or false");
const seconds: Check = (v) => (isNum(v) && v >= 0 ? null : "must be a number of seconds ≥ 0");
const nonEmpty: Check = (v) => (typeof v === "string" && v.trim().length > 0 ? null : "must be a non-empty string");
const xy: Check = (v) => (isObj(v) && isNum(v.x) && isNum(v.y) && Object.keys(v).every((k) => k === "x" || k === "y") ? null : "must be {x, y}, two numbers");
const unitNum: Check = (v) => (isNum(v) && v >= 0 && v <= 1 ? null : "must be a number from 0 to 1");
const realNum: Check = (v) => (isNum(v) ? null : "must be a number");
const positiveNum: Check = (v) => (isNum(v) && v > 0 ? null : "must be a number > 0");
const fields = (rules: Readonly<Record<string, Rule>>, required: readonly string[]): Check => (v) => {
  if (!isObj(v)) return "must be an object {" + Object.keys(rules).join(", ") + "}";
  const bad = objectProblems(v, rules, "");
  if (bad.length) return bad[0] || null;
  const missing = required.filter((k) => v[k] === undefined);
  return missing.length ? "is missing " + missing.join(", ") : null;
};
const VARIABLE_ACTION = "a prototype action that sets a variable, a variable mode or runs a conditional cannot be written yet; back, close, url and node can";
const MEDIA = "a media action or trigger cannot be written yet";

const TRANSITION_RULES: Readonly<Record<keyof WriteTransition, Rule>> = {
  type: (v) => (v === "instant" ? "an instant change has no transition; leave `transition` out" : oneOf(...SIMPLE_TRANSITIONS, ...DIRECTIONAL_TRANSITIONS)(v)),
  direction: oneOf(...DIRECTIONS),
  matchLayers: bool,
  duration: (v) => (isNum(v) && v >= 0 && v <= MAX_DURATION ? null : "must be a number of seconds from 0 to " + MAX_DURATION),
  easing: oneOf(...EASINGS),
  cubicBezier: fields({ x1: unitNum, y1: realNum, x2: unitNum, y2: realNum }, ["x1", "y1", "x2", "y2"]),
  spring: fields({ mass: positiveNum, stiffness: positiveNum, damping: positiveNum, initialVelocity: realNum }, ["mass", "stiffness", "damping", "initialVelocity"]),
};
const ACTION_RULES: Readonly<Record<string, Rule>> = {
  type: (v) => (v === "set_variable" || v === "set_variable_mode" || v === "conditional" ? VARIABLE_ACTION : v === "update_media_runtime" ? MEDIA : oneOf("back", "close", "url", "node")(v)),
  url: nonEmpty,
  openInNewTab: bool,
  navigation: oneOf(...NAVIGATIONS),
  destination: nonEmpty,
  destinationId: nonEmpty,
  transition: (v) => (isObj(v) ? null : "must be an object {type, duration?, easing?, …} (leave it out for an instant change)"),
  preserveScroll: bool, resetScroll: bool, resetVideo: bool, resetInteractive: bool,
  overlayOffset: xy,
  // The read form's other action fields: refused by name.
  variable: refuse(VARIABLE_ACTION), value: refuse(VARIABLE_ACTION), collection: refuse(VARIABLE_ACTION), mode: refuse(VARIABLE_ACTION),
  conditionalBlocks: refuse(VARIABLE_ACTION), mediaAction: refuse(MEDIA), amountToSkip: refuse(MEDIA), newTimestamp: refuse(MEDIA),
};
const REACTION_RULES: Readonly<Record<string, Rule>> = {
  trigger: (v) => (v === "on_media_hit" || v === "on_media_end" ? MEDIA : v === "unknown" ? "a trigger the read could not name cannot be written; give one of " + TRIGGERS.join(" | ") : oneOf(...TRIGGERS)(v)),
  timeout: seconds,
  delay: seconds,
  keyCodes: (v) => (Array.isArray(v) && v.length > 0 && v.every((k) => isNum(k) && Number.isInteger(k) && k >= 0) ? null : "must be a non-empty list of key codes (whole numbers ≥ 0)"),
  device: oneOf(...DEVICES),
  actions: (v) => (Array.isArray(v) ? null : "must be a list of actions"),
  mediaHitTime: refuse(MEDIA),
};
/** Which fields belong to which trigger: a field given with another trigger is refused, never dropped. */
const TRIGGER_FIELDS: Readonly<Record<string, readonly WriteTrigger[]>> = {
  timeout: ["after_timeout"], delay: ["mouse_enter", "mouse_leave", "mouse_up", "mouse_down"], keyCodes: ["on_key_down"], device: ["on_key_down"],
};
const NODE_ONLY = ["navigation", "destination", "destinationId", "transition", "preserveScroll", "resetScroll", "resetVideo", "resetInteractive", "overlayOffset"];

/** A node action's destination as the plugin resolves it: an exact id, or a name. */
export interface DestinationRef { path: string; navigation: WriteNavigation; id?: string; name?: string }
/** What a valid reaction list does. */
export interface ReactionSummary {
  reactions: number;
  actions: number;
  /** every node action's destination, in order */
  destinations: DestinationRef[];
}

/** Every problem with a setReactions op's `reactions` (each starting with `path`), and for a valid list what it does. */
export function checkReactions(list: unknown, path = "reactions"): { problems: string[]; summary: ReactionSummary } {
  const summary: ReactionSummary = { reactions: 0, actions: 0, destinations: [] };
  if (!Array.isArray(list)) return { problems: [path + ": must be a list of reactions in the read export's form, e.g. [{trigger: \"on_click\", actions: [{type: \"back\"}]}] ([] removes them all)"], summary };
  const problems: string[] = [];
  if (list.length > MAX_REACTIONS) problems.push(path + ": " + list.length + " reactions; a layer takes at most " + MAX_REACTIONS + " in one op");
  list.forEach((r, i) => {
    const at = path + "[" + i + "]";
    if (!isObj(r)) { problems.push(at + ": must be an object {trigger?, actions}"); return; }
    const own = objectProblems(r, REACTION_RULES, at);
    problems.push(...own);
    if (own.length) return;
    const trigger = typeof r.trigger === "string" ? r.trigger : "on_click";
    for (const k of Object.keys(TRIGGER_FIELDS)) {
      const allowed = TRIGGER_FIELDS[k] || [];
      if (r[k] !== undefined && allowed.indexOf(trigger as WriteTrigger) < 0) problems.push(at + "." + k + ": only with trigger " + allowed.join(" | ") + " (this one is " + trigger + ")");
    }
    if (trigger === "after_timeout" && r.timeout === undefined) problems.push(at + ": trigger after_timeout needs `timeout` (seconds)");
    if (trigger === "on_key_down" && r.keyCodes === undefined) problems.push(at + ": trigger on_key_down needs `keyCodes`");
    const acts = Array.isArray(r.actions) ? r.actions : null;
    if (!acts) { if (r.actions === undefined) problems.push(at + ": needs `actions`, a list of what the trigger does"); return; }
    if (!acts.length) problems.push(at + ".actions: is empty; a reaction runs at least one action (to remove reactions, leave them out of the list)");
    if (acts.length > MAX_ACTIONS) problems.push(at + ".actions: " + acts.length + " actions; a reaction runs at most " + MAX_ACTIONS);
    acts.forEach((a, j) => checkAction(a, at + ".actions[" + j + "]", problems, summary));
    summary.reactions++;
  });
  if (problems.length) return { problems, summary: { reactions: 0, actions: 0, destinations: [] } };
  return { problems, summary };
}

function checkAction(a: unknown, at: string, problems: string[], summary: ReactionSummary): void {
  if (!isObj(a)) { problems.push(at + ": must be an object {type, …}"); return; }
  const own = objectProblems(a, ACTION_RULES, at);
  if (a.type === undefined) own.push(at + ": needs `type`: back | close | url | node");
  problems.push(...own);
  if (own.length) return;
  const type = String(a.type);
  if (type !== "node") for (const k of NODE_ONLY) if (a[k] !== undefined) problems.push(at + "." + k + ": only on a `node` action (this one is " + type + ")");
  if (type !== "url") for (const k of ["url", "openInNewTab"]) if (a[k] !== undefined) problems.push(at + "." + k + ": only on a `url` action (this one is " + type + ")");
  if (type === "url" && a.url === undefined) problems.push(at + ": a url action needs `url`");
  summary.actions++;
  if (type !== "node") return;
  const navigation = (typeof a.navigation === "string" ? a.navigation : "navigate") as WriteNavigation;
  const id = typeof a.destinationId === "string" ? a.destinationId : undefined;
  const dest = typeof a.destination === "string" ? a.destination : undefined;
  if (id === undefined && dest === undefined) problems.push(at + ": a node action needs `destination` (a node's exact name or id) or `destinationId`");
  if (a.overlayOffset !== undefined && navigation !== "overlay" && navigation !== "swap") problems.push(at + ".overlayOffset: only when the action opens an overlay (navigation overlay or swap)");
  if (isObj(a.transition)) {
    const tp = at + ".transition";
    const t = a.transition;
    const bad = objectProblems(t, TRANSITION_RULES, tp);
    problems.push(...bad);
    if (!bad.length) {
      if (t.type === undefined) problems.push(tp + ": needs `type`: " + [...SIMPLE_TRANSITIONS, ...DIRECTIONAL_TRANSITIONS].join(" | "));
      const directional = (DIRECTIONAL_TRANSITIONS as readonly unknown[]).indexOf(t.type) >= 0;
      if (directional && t.direction === undefined) problems.push(tp + ": a " + String(t.type) + " transition needs `direction`: " + DIRECTIONS.join(" | "));
      if (!directional && t.type !== undefined) for (const k of ["direction", "matchLayers"]) if (t[k] !== undefined) problems.push(tp + "." + k + ": only on a directional transition (" + DIRECTIONAL_TRANSITIONS.join(" | ") + ")");
      if (t.easing === "custom_cubic_bezier" && t.cubicBezier === undefined) problems.push(tp + ": easing custom_cubic_bezier needs `cubicBezier` {x1, y1, x2, y2}");
      if (t.easing === "custom_spring" && t.spring === undefined) problems.push(tp + ": easing custom_spring needs `spring` {mass, stiffness, damping, initialVelocity}");
      // The read writes a preset easing's curve beside it too: accepted with any easing, written only with its custom one.
    }
  }
  // An id in `destination` names that node; with `destinationId` too, the plugin checks they name the same one.
  const ref: DestinationRef = { path: at, navigation };
  if (id !== undefined) ref.id = id;
  else if (dest !== undefined && isNodeId(dest)) ref.id = dest;
  if (dest !== undefined && !(id === undefined && isNodeId(dest))) ref.name = dest;
  summary.destinations.push(ref);
}

/** `reactions` is a list checkReactions accepts. The plugin applies only one that passed this. */
export function isReactionList(v: unknown): v is WriteReaction[] {
  return checkReactions(v).problems.length === 0;
}

/** The refusal for an invalid reaction list: every problem, one per line. */
export function reactionRefusal(problems: readonly string[]): string {
  const first = problems[0];
  if (problems.length === 1 && first !== undefined) return first + ". Nothing was changed.";
  return problems.length + " problems in the reactions — nothing was changed:\n" + problems.join("\n");
}

/** The problem with a flow starting point's name, or null (the wire check's: a name is matched exactly). */
export function flowNameError(name: unknown, at: string): string | null {
  if (typeof name !== "string" || !name.trim()) return "`" + at + ".name`: a flow starting point needs a name";
  if (name !== name.trim()) return "`" + at + ".name`: '" + name + "' has spaces at its start or end; a flow is named exactly";
  return null;
}

// ---------------------------------------------------------------- words (the dry run, the card)

const words = (s: string): string => s.replace(/_/g, " ");
const secs = (n: number): string => (Math.round(n * 1000) / 1000) + " s";

/** A trigger in a few words: "on click", "after 2 s", "mouse enter after 0.3 s", "key down 13, 27". */
export function triggerText(r: WriteReaction): string {
  const t = r.trigger || "on_click";
  if (t === "after_timeout") return "after " + secs(r.timeout || 0);
  if (t === "on_key_down") return "key " + (r.keyCodes || []).join(", ") + (r.device && r.device !== "keyboard" ? " (" + words(r.device) + ")" : "");
  if (r.delay) return words(t) + " after " + secs(r.delay);
  return words(t);
}

/** A transition in a few words: "smart animate 300 ms", "slide in from left 200 ms". */
function transitionText(t: WriteTransition | undefined): string {
  if (!t) return "instant";
  const ms = Math.round((t.duration === undefined ? DEFAULT_DURATION : t.duration) * 1000);
  return words(t.type) + (t.direction ? " " + t.direction : "") + " " + ms + " ms";
}

/** An action in a few words. `dest` is the destination's name as the file has it (else the op's own ref). */
export function actionText(a: WriteAction, dest?: string): string {
  if (a.type === "back") return "back";
  if (a.type === "close") return "close the overlay";
  if (a.type === "url") return "open " + String(a.url) + (a.openInNewTab ? " in a new tab" : "");
  const to = "'" + (dest !== undefined ? dest : a.destination !== undefined ? a.destination : String(a.destinationId)) + "'";
  const nav = a.navigation || "navigate";
  const verb = nav === "navigate" ? "go to " : nav === "overlay" ? "open overlay " : nav === "swap" ? "swap overlay for " : nav === "scroll_to" ? "scroll to " : "change to ";
  return verb + to + (a.transition ? " (" + transitionText(a.transition) + ")" : "");
}

/** A whole list in a few words ("on click → go to 'Home' (dissolve 300 ms); after 2 s → back"), or "none". `dests`: the
 *  node actions' destination names, in order (absent where unknown). */
export function reactionsText(list: readonly WriteReaction[], dests: readonly (string | undefined)[] = []): string {
  if (!list.length) return "none";
  let k = 0;
  return list.map((r) => triggerText(r) + " → " + r.actions.map((a) => actionText(a, a.type === "node" ? dests[k++] : undefined)).join(", then ")).join("; ");
}

const plural = (n: number, w: string): string => n + " " + w + (n === 1 ? "" : "s");
/** One sentence of what a valid setReactions op changes: the dry run's `change`. */
export function describeReactions(nodeId: string | undefined, list: readonly WriteReaction[]): string {
  const node = "node " + (nodeId || "?");
  if (!list.length) return node + ": removes every prototype interaction — the reply counts the ones it removed; put back if a later op of the batch fails";
  return node + ": its prototype interactions become " + plural(list.length, "reaction") + " (" + reactionsText(list) + "), replacing the ones it has — " +
    "the node and each destination are checked against the file when applied (navigate, swap and overlay go to a frame at the top of the node's page or in a section on it; scroll_to to a layer of the same top frame; change_to to a variant of the same set); put back if a later op of the batch fails";
}
/** One sentence of what a flow op changes: the dry run's `change`. */
export function describeFlow(nodeId: string | undefined, name: string | undefined): string {
  const node = "node " + (nodeId || "?");
  return name === undefined
    ? node + ": stops being a flow starting point on its page — checked against the file when applied; put back if a later op of the batch fails"
    : node + ": becomes the starting point of flow '" + name + "' on its page (renamed when it is one already) — the node must be a frame at the top of its page or in a section, and no other flow on the page may have that name; put back if a later op of the batch fails";
}
