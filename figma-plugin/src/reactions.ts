// Prototype interactions and flows (writes: setReactions, setFlowStart, clearFlowStart; docs/write-plane-spec.md
// decision 22): what a tap on a layer does, and the frames a prototype starts from.
//
// The op's `reactions` were checked whole before this module sees them (bridge/src/reaction-spec.ts checkReactions, run
// by the wire check and again by applyWrites). What is left can only be answered by the file, and is answered BEFORE the
// first op of the batch runs (resolvePrototypeOps, decisions 14 and 15): the node exists and can carry reactions, and
// every destination resolves to exactly one node of the kind its navigation goes to —
//   * navigate, swap, overlay: a frame, component or instance at the top of the node's page, or directly in a section on
//     it (Figma's prototype connects frames of one page);
//   * scroll_to: a layer inside the node's own top frame;
//   * change_to: a variant of the component set the node is a variant of, or is inside (an interactive component);
// by its exact id, or a name exactly one such node has (several: refused with their ids; none: the closest names). A flow
// starting point is a frame at the top of its page or in a section; its name is the page's only flow of that name.
//
// Applying keeps what the node (or page) has now and puts it back when a later op of the batch fails. The list replaces
// the layer's reactions whole (as Figma's setReactionsAsync does): `[]` removes them.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * Under documentAccess "dynamic-page" `reactions` is read-only; setReactionsAsync sets them. A Reaction's `actions`
//     is the list (the singular `action` is deprecated); a NODE action names its destination by `destinationId`.
//   * MOUSE_ENTER / MOUSE_LEAVE triggers carry `deprecatedVersion` (false: the current behaviour).
//   * PageNode.flowStartingPoints is a plain writable list of {nodeId, name}; the first is the page's default flow.
//   * A frame's overlay settings (overlayPositionType, overlayBackground, …) are read-only: an overlay offset applies only
//     to a destination whose position is MANUAL, which the designer sets in Figma.
import type { AppliedWrite, WriteOp } from "../../bridge/src/commands.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import { checkReactions, DEFAULT_DURATION, DEFAULT_EASING, isReactionList, type DestinationRef, type WriteAction, type WriteReaction, type WriteTransition } from "../../bridge/src/reaction-spec.ts";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";
import { goneFrom, inDocument, nodeById, noNode, stillInDocument } from "./node-lookup";
import { pageHolding } from "./places";
import { errMsg } from "./util";

type ReactiveNode = SceneNode & ReactionMixin;

/** A setReactions op whose node and destinations all resolved, with the reactions as Figma takes them. */
export interface ReactionTarget {
  kind: "reactions";
  node: ReactiveNode;
  /** the node's name as the batch resolved it (a removed node reads no field but id, removed and type) */
  name: string;
  reactions: Reaction[];
  /** every destination, held: each is checked again right before the op runs */
  dests: SceneNode[];
  /** each node action's destination by the name the file has, in the op's order (the review card's words) */
  destNames: string[];
}
/** A flow op whose frame and page resolved. `flow` is the name it sets (null: clearFlowStart); `was` the flow the frame
 *  starts now (null: none). */
export interface FlowTarget { kind: "flow"; node: SceneNode; name: string; page: PageNode; flow: string | null; was: string | null }
export type ProtoTarget = ReactionTarget | FlowTarget;

const isProtoOp = (op: WriteOp): boolean => op.op === "setReactions" || op.op === "setFlowStart" || op.op === "clearFlowStart";
/** The kinds a prototype goes to, and a flow starts from, at the top of a page. */
const TOP_TYPES: readonly string[] = ["FRAME", "COMPONENT", "INSTANCE"];
const label = (n: BaseNode): string => "'" + n.name + "' (" + n.id + ")";

/** `n` sits at the top of its page: right on the page, or directly in a section (sections nest). */
function atTop(n: BaseNode): boolean {
  const p = n.parent;
  return !!p && (p.type === "PAGE" || p.type === "SECTION");
}
/** The node, or the one above it, at the top of its page (null for a page, a section, or a node outside one). */
function topOf(n: BaseNode): SceneNode | null {
  for (let a: BaseNode | null = n; a && a.type !== "PAGE"; a = a.parent) if (a.type !== "SECTION" && atTop(a)) return a as SceneNode;
  return null;
}
/** Every frame, component and instance at the top of `page` (in sections too). */
function topFrames(page: PageNode): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (parent: ChildrenMixin): void => {
    for (const c of parent.children) {
      if (c.type === "SECTION") walk(c);
      else if (TOP_TYPES.indexOf(c.type) >= 0) out.push(c);
    }
  };
  walk(page);
  return out;
}
/** Every layer below `top` (not inside an instance: its layers are the component's). */
function layersIn(top: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (n: SceneNode): void => {
    if (!("children" in n) || n.type === "INSTANCE") return;
    for (const c of n.children) { out.push(c); walk(c); }
  };
  walk(top);
  return out;
}
/** The variant `n` is, or is inside: a component whose parent is a component set. */
function variantOf(n: BaseNode): ComponentNode | null {
  for (let a: BaseNode | null = n; a && a.type !== "PAGE"; a = a.parent) if (a.type === "COMPONENT" && a.parent && a.parent.type === "COMPONENT_SET") return a;
  return null;
}

/** Where a navigation may go, from `node`, and what that is in a sentence. */
function placesFor(node: SceneNode, page: PageNode, nav: DestinationRef["navigation"]): { list: SceneNode[]; what: string } | { error: string } {
  if (nav === "scroll_to") {
    // A layer of a variant scrolls within that variant (its set is not one frame).
    const top = variantOf(node) || topOf(node);
    if (!top) return { error: "scroll_to scrolls within the frame the layer is in, and " + label(node) + " is in none" };
    return { list: layersIn(top).filter((c) => c.id !== node.id), what: "layer inside '" + top.name + "' (scroll_to stays in the layer's own frame)" };
  }
  if (nav === "change_to") {
    const v = variantOf(node);
    if (!v || !v.parent || v.parent.type !== "COMPONENT_SET") return { error: "change_to switches an interactive component to another variant, and " + label(node) + " is not a variant of a component set or inside one" };
    const set = v.parent;
    return { list: set.children.filter((c): c is ComponentNode => c.type === "COMPONENT"), what: "variant of '" + set.name + "' (change_to goes to a variant of the same set)" };
  }
  return { list: topFrames(page), what: "frame at the top of page '" + page.name + "' (a prototype goes to a frame on the layer's own page, or in a section on it)" };
}

/** Why `n` is not one of `list`: on another page, inside another frame, the wrong kind. */
function notAmong(n: BaseNode, node: SceneNode, page: PageNode, nav: DestinationRef["navigation"], what: string): string {
  const pg = n.type === "PAGE" ? null : pageHolding(n);
  if (nav !== "change_to" && pg && pg.id !== page.id) return label(n) + " is on page '" + pg.name + "'; a prototype connection stays on its own page ('" + page.name + "')";
  if (n.id === node.id && nav === "scroll_to") return label(n) + " is the layer itself; scroll_to goes to another layer of its frame";
  return label(n) + " is a " + n.type + (nav === "scroll_to" || nav === "change_to" ? "" : n.parent ? " inside '" + n.parent.name + "'" : "") + ", not a " + what;
}

/** One destination, resolved against the file: the node, or why not. */
async function resolveDestination(ref: DestinationRef, node: SceneNode, page: PageNode): Promise<{ node: SceneNode } | { error: string }> {
  const at = ref.path + ": ";
  const places = placesFor(node, page, ref.navigation);
  if ("error" in places) return { error: at + places.error };
  if (ref.id !== undefined) {
    const n = await nodeById(ref.id);
    if (!n) return { error: at + "destination: " + noNode(ref.id) };
    const hit = places.list.filter((c) => c.id === n.id)[0];
    if (!hit) return { error: at + "destination " + notAmong(n, node, page, ref.navigation, places.what) };
    if (ref.name !== undefined && ref.name !== hit.name) return { error: at + "`destinationId` '" + ref.id + "' is '" + hit.name + "', but `destination` says '" + ref.name + "'; give one, or both naming the same node" };
    return { node: hit };
  }
  const name = ref.name || "";
  const m = matchByName(name, places.list, (c) => c.name);
  if (m.kind === "one") return { node: m.item };
  if (m.kind === "many") return { error: at + "destination '" + name + "' names " + m.matches.length + " of them (each a " + places.what + ") — pass one's id: " + m.matches.slice(0, 3).map(label).join(", ") };
  return { error: at + "destination '" + name + "' matches no " + places.what + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
}

const TRIGGER_TYPES = {
  on_click: "ON_CLICK", on_hover: "ON_HOVER", on_press: "ON_PRESS", on_drag: "ON_DRAG", after_timeout: "AFTER_TIMEOUT",
  mouse_enter: "MOUSE_ENTER", mouse_leave: "MOUSE_LEAVE", mouse_up: "MOUSE_UP", mouse_down: "MOUSE_DOWN", on_key_down: "ON_KEY_DOWN",
} as const;
const DEVICE_TYPES = { keyboard: "KEYBOARD", xbox_one: "XBOX_ONE", ps4: "PS4", switch_pro: "SWITCH_PRO", unknown_controller: "UNKNOWN_CONTROLLER" } as const;
const NAV_TYPES = { navigate: "NAVIGATE", swap: "SWAP", overlay: "OVERLAY", scroll_to: "SCROLL_TO", change_to: "CHANGE_TO" } as const;
const EASING_TYPES = {
  ease_in: "EASE_IN", ease_out: "EASE_OUT", ease_in_and_out: "EASE_IN_AND_OUT", linear: "LINEAR", ease_in_back: "EASE_IN_BACK", ease_out_back: "EASE_OUT_BACK",
  ease_in_and_out_back: "EASE_IN_AND_OUT_BACK", custom_cubic_bezier: "CUSTOM_CUBIC_BEZIER", gentle: "GENTLE", quick: "QUICK", bouncy: "BOUNCY", slow: "SLOW", custom_spring: "CUSTOM_SPRING",
} as const;
const SIMPLE_TYPES = { dissolve: "DISSOLVE", smart_animate: "SMART_ANIMATE", scroll_animate: "SCROLL_ANIMATE" } as const;
const DIRECTIONAL_TYPES = { move_in: "MOVE_IN", move_out: "MOVE_OUT", push: "PUSH", slide_in: "SLIDE_IN", slide_out: "SLIDE_OUT" } as const;
const DIRECTION_TYPES = { left: "LEFT", right: "RIGHT", top: "TOP", bottom: "BOTTOM" } as const;

function figmaTrigger(r: WriteReaction): Trigger {
  const t = r.trigger || "on_click";
  switch (t) {
    // Milliseconds, as Figma stores them and the read export writes them.
    case "after_timeout": return { type: "AFTER_TIMEOUT", timeout: r.timeout || 0 };
    case "mouse_enter": case "mouse_leave": return { type: TRIGGER_TYPES[t], delay: r.delay || 0, deprecatedVersion: false };
    case "mouse_up": case "mouse_down": return { type: TRIGGER_TYPES[t], delay: r.delay || 0 };
    case "on_key_down": return { type: "ON_KEY_DOWN", device: DEVICE_TYPES[r.device || "keyboard"], keyCodes: (r.keyCodes || []).slice() };
    case "on_click": case "on_hover": case "on_press": case "on_drag":
    default: return { type: TRIGGER_TYPES[t] };
  }
}
function figmaEasing(t: WriteTransition): Easing {
  const e: { type: Easing["type"]; easingFunctionCubicBezier?: EasingFunctionBezier; easingFunctionSpring?: EasingFunctionSpring } = { type: EASING_TYPES[t.easing || DEFAULT_EASING] };
  // A preset easing's curve (the read writes it beside the preset) is Figma's own: only a custom easing takes one.
  if (t.cubicBezier && e.type === "CUSTOM_CUBIC_BEZIER") e.easingFunctionCubicBezier = { x1: t.cubicBezier.x1, y1: t.cubicBezier.y1, x2: t.cubicBezier.x2, y2: t.cubicBezier.y2 };
  if (t.spring && e.type === "CUSTOM_SPRING") e.easingFunctionSpring = { mass: t.spring.mass, stiffness: t.spring.stiffness, damping: t.spring.damping, initialVelocity: t.spring.initialVelocity };
  return e;
}
function figmaTransition(t: WriteTransition | undefined): Transition | null {
  if (!t) return null;
  const duration = t.duration === undefined ? DEFAULT_DURATION : t.duration;
  const easing = figmaEasing(t);
  switch (t.type) {
    case "move_in": case "move_out": case "push": case "slide_in": case "slide_out":
      return { type: DIRECTIONAL_TYPES[t.type], direction: DIRECTION_TYPES[t.direction || "left"], matchLayers: t.matchLayers === true, easing, duration };
    case "dissolve": case "smart_animate": case "scroll_animate":
    default: return { type: SIMPLE_TYPES[t.type], easing, duration };
  }
}
function figmaAction(a: WriteAction, destId: string | undefined): Action {
  switch (a.type) {
    case "back": return { type: "BACK" };
    case "close": return { type: "CLOSE" };
    case "url": return a.openInNewTab === undefined ? { type: "URL", url: a.url || "" } : { type: "URL", url: a.url || "", openInNewTab: a.openInNewTab };
    case "node":
    default: {
      const o: { type: "NODE"; destinationId: string | null; navigation: Navigation; transition: Transition | null; preserveScrollPosition?: boolean; overlayRelativePosition?: Vector; resetVideoPosition?: boolean; resetScrollPosition?: boolean; resetInteractiveComponents?: boolean } = {
        type: "NODE", destinationId: destId || null, navigation: NAV_TYPES[a.navigation || "navigate"], transition: figmaTransition(a.transition),
      };
      if (a.preserveScroll !== undefined) o.preserveScrollPosition = a.preserveScroll;
      if (a.resetScroll !== undefined) o.resetScrollPosition = a.resetScroll;
      if (a.resetVideo !== undefined) o.resetVideoPosition = a.resetVideo;
      if (a.resetInteractive !== undefined) o.resetInteractiveComponents = a.resetInteractive;
      if (a.overlayOffset) o.overlayRelativePosition = { x: a.overlayOffset.x, y: a.overlayOffset.y };
      return o;
    }
  }
}

/**
 * Resolve every prototype op of a batch against the file. Every op is looked at, so the refusal lists every problem at
 * once.
 */
export async function resolvePrototypeOps(ops: readonly WriteOp[]): Promise<{ targets: Map<number, ProtoTarget>; problems: OpProblem[] }> {
  const targets = new Map<number, ProtoTarget>();
  const problems: OpProblem[] = [];
  /** each page's flow starting points as the batch's flow ops leave them, in op order */
  const flows = new Map<string, Array<{ nodeId: string; name: string }>>();
  for (const [index, op] of ops.entries()) {
    if (!isProtoOp(op)) continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const nodeId = op.nodeId || "";
    const nd = await nodeById(nodeId);
    if (!nd) { bad(noNode(nodeId)); continue; }
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") { bad(label(nd) + " is a " + nd.type + "; " + (op.op === "setReactions" ? "prototype interactions are on a layer" : "a flow starts from a frame")); continue; }
    const node = nd;
    const page = pageHolding(node);
    if (!page) { bad(noNode(nodeId)); continue; }
    await page.loadAsync(); // dynamic-page: its children are read below
    if (goneFrom(node, bad) || goneFrom(page, bad, "page")) continue;
    const name = node.name;

    if (op.op === "setReactions") {
      if (!("setReactionsAsync" in node)) { bad(label(node) + " is a " + node.type + ", which has no prototype interactions"); continue; }
      const list = isReactionList(op.reactions) ? op.reactions : null;
      if (!list) { bad("the reactions are not valid (checked before the batch): " + checkReactions(op.reactions).problems.join("; ")); continue; }
      const refs = checkReactions(list).summary.destinations;
      const dests: SceneNode[] = [];
      let failed = false;
      for (const ref of refs) {
        const d = await resolveDestination(ref, node, page);
        if ("error" in d) { bad(d.error); failed = true; continue; }
        dests.push(d.node);
      }
      // Each lookup awaits: the node, and every destination found before, checked again once they are done.
      if (goneFrom(node, bad)) continue;
      for (const d of dests) if (goneFrom(d, bad, "destination")) failed = true;
      if (failed) continue;
      // An overlay offset places the overlay by hand, which Figma honours only on a destination set to Manual.
      let k = 0;
      for (const [ri, r] of list.entries()) for (const [ai, a] of r.actions.entries()) {
        if (a.type !== "node") continue;
        const d = dests[k++];
        if (!a.overlayOffset || !d) continue;
        const pos = "overlayPositionType" in d ? d.overlayPositionType : undefined;
        if (pos !== "MANUAL") bad("reactions[" + ri + "].actions[" + ai + "].overlayOffset: the overlay '" + d.name + "' is positioned " + (pos ? pos.toLowerCase().replace(/_/g, " ") : "in the centre (the default)") + ", and an offset applies only to one set to Manual (a frame's overlay position is set in Figma's Prototype panel; plugins cannot)");
      }
      k = 0;
      const reactions: Reaction[] = list.map((r) => ({ trigger: figmaTrigger(r), actions: r.actions.map((a) => { if (a.type !== "node") return figmaAction(a, undefined); const d = dests[k++]; return figmaAction(a, d ? d.id : undefined); }) }));
      targets.set(index, { kind: "reactions", node: node as ReactiveNode, name, reactions, dests, destNames: dests.map((d) => d.name) });
      continue;
    }

    // A flow starts from a frame at the top of its page.
    if (!atTop(node) || TOP_TYPES.indexOf(node.type) < 0) { bad(label(node) + " is a " + node.type + (node.parent && !atTop(node) ? " inside '" + node.parent.name + "'" : "") + "; a flow starts from a frame at the top of its page, or in a section on it"); continue; }
    // The page's flows as the ops before this one in the batch leave them: a clear frees a name, a set takes one.
    let points = flows.get(page.id);
    if (!points) { points = (page.flowStartingPoints || []).map((p) => ({ nodeId: p.nodeId, name: p.name })); flows.set(page.id, points); }
    const mine = points.filter((p) => p.nodeId === node.id)[0];
    const was = mine ? mine.name : null;
    if (op.op === "clearFlowStart") {
      if (!mine) { bad(label(node) + " starts no flow on page '" + page.name + "'" + (points.length ? " (its flows: " + quoteList(points.map((p) => p.name)) + ")" : "")); continue; }
      targets.set(index, { kind: "flow", node, name, page, flow: null, was });
      flows.set(page.id, points.filter((p) => p.nodeId !== node.id));
      continue;
    }
    const flow = op.name || "";
    const clash = points.filter((p) => p.name === flow && p.nodeId !== node.id)[0];
    if (clash) { bad("page '" + page.name + "' already has a flow '" + flow + "' (it starts at " + clash.nodeId + "); flows are told apart by name — pick another"); continue; }
    targets.set(index, { kind: "flow", node, name, page, flow, was });
    flows.set(page.id, mine ? points.map((p) => (p.nodeId === node.id ? { nodeId: p.nodeId, name: flow } : p)) : points.concat([{ nodeId: node.id, name: flow }]));
  }
  return { targets, problems };
}

/** Every destination id a resolved op holds (a delete of one in the same batch refuses the batch). */
export function destinationIds(t: ProtoTarget): string[] {
  return t.kind === "reactions" ? t.dests.map((d) => d.id) : [];
}

/** A deep copy of what Figma hands back (its lists are frozen), as plain values setReactionsAsync takes again. */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = plain(Reflect.get(v, k));
    return o;
  }
  return v;
}

/** Apply a resolved setReactions op, keeping the reactions it replaces. Pushes its Change once Figma took the list. */
export async function applyReactions(t: ReactionTarget, consent: () => void, changes: Change[]): Promise<AppliedWrite> {
  const { node } = t;
  stillInDocument(node); // resolved before the batch ran: deleted since, it fails as its lookup would have
  for (const d of t.dests) stillInDocument(d, "destination");
  const prev = plain(node.reactions) as Reaction[];
  consent();
  try { await node.setReactionsAsync(plain(t.reactions) as Reaction[]); } catch (e) {
    if (!inDocument(node)) throw new Error(noNode(node.id));
    throw new Error("Figma refused the reactions for '" + t.name + "': " + errMsg(e));
  }
  const change: Change = {
    applied: { id: node.id, reactions: t.reactions.length, replaced: prev.length },
    kind: "prototype change",
    what: "the prototype interactions of '" + t.name + "' (" + node.id + ")",
    on: node,
    async restore(allowed) {
      await node.setReactionsAsync(prev);
      if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off");
    },
  };
  changes.push(change);
  // Deleted during the await: the change went with it (the put-back says so), and the op fails as missing.
  stillInDocument(node);
  for (const d of t.dests) stillInDocument(d, "destination");
  return change.applied;
}

/** Apply a resolved flow op on the page's list as it is now (an earlier op of the batch may have changed it), keeping
 *  the list it replaces. */
export function applyFlow(t: FlowTarget): Change {
  const { node, page } = t;
  stillInDocument(node);
  stillInDocument(page, "page");
  const prev = page.flowStartingPoints.map((p) => ({ nodeId: p.nodeId, name: p.name }));
  const mine = prev.filter((p) => p.nodeId === node.id)[0];
  let next: Array<{ nodeId: string; name: string }>;
  if (t.flow === null) {
    if (!mine) throw new Error("'" + t.name + "' starts no flow on page '" + page.name + "' any more (an earlier op of the batch changed its flows)");
    next = prev.filter((p) => p.nodeId !== node.id);
  } else {
    const flow = t.flow;
    const clash = prev.filter((p) => p.name === flow && p.nodeId !== node.id)[0];
    if (clash) throw new Error("page '" + page.name + "' has a flow '" + flow + "' already (it starts at " + clash.nodeId + "; an earlier op of the batch made it)");
    next = mine ? prev.map((p) => (p.nodeId === node.id ? { nodeId: p.nodeId, name: flow } : p)) : prev.concat([{ nodeId: node.id, name: flow }]);
  }
  page.flowStartingPoints = next;
  const applied: AppliedWrite = { id: node.id };
  if (t.flow !== null) applied.flow = t.flow;
  if (mine) applied.from = mine.name;
  return {
    applied,
    kind: "flow change",
    what: "the flow starting points of page '" + page.name + "'",
    on: node,
    restore() { page.flowStartingPoints = prev; },
  };
}
