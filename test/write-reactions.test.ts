// Prototype interactions and flows (#183), the pure halves: setReactions' `reactions` and the flow ops checked by the
// wire check (bridge/src/reaction-spec.ts through commands.ts writeOpError), said by the dry run's preview
// (commands.ts writeOpPreview) and by the review card's words (review-card.ts). The file's half is
// test/harness/reactions.ts.
//   bun test/write-reactions.test.ts
import { check, report } from "./assert.ts";
import { checkReactions, MAX_ACTIONS, MAX_REACTIONS, reactionsText } from "../bridge/src/reaction-spec.ts";
import { checkPatch } from "../bridge/src/patch-spec.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import { writeOpError, writeOpPreview, type WriteOp } from "../bridge/src/commands.ts";
import { cardLines, lineText } from "../bridge/src/review-card.ts";

const op = (reactions: unknown): WriteOp => ({ op: "setReactions", nodeId: "1:2", reactions } as WriteOp);
const err = (o: unknown): string => String(writeOpError(o, 0));
const refused = (reactions: unknown): string => err(op(reactions));
const tap = (a: Record<string, unknown>): Record<string, unknown> => ({ actions: [a] });

console.log("\nthe wire check:");
check("a list in the read form passes: every trigger and action kind it may write", writeOpError(op([
  { trigger: "on_click", actions: [{ type: "node", destination: "Home", navigation: "navigate", transition: { type: "dissolve", duration: 0.3, easing: "ease_out" } }] },
  { trigger: "on_hover", actions: [{ type: "node", destinationId: "4:2", navigation: "overlay", overlayOffset: { x: 0, y: 8 } }] },
  { trigger: "on_press", actions: [{ type: "node", destination: "Card", navigation: "scroll_to", resetScroll: true }] },
  { trigger: "on_press", actions: [{ type: "node", destination: "State=On", navigation: "change_to", transition: { type: "smart_animate", easing: "gentle" } }] },
  { trigger: "after_timeout", timeout: 0.8, actions: [{ type: "back" }] },
  { trigger: "mouse_enter", delay: 0, actions: [{ type: "close" }] }, { trigger: "mouse_leave", delay: 0.1, actions: [{ type: "close" }] },
  { trigger: "mouse_up", delay: 0, actions: [{ type: "back" }] }, { trigger: "mouse_down", delay: 0, actions: [{ type: "back" }] },
  { trigger: "on_key_down", keyCodes: [27], device: "keyboard", actions: [{ type: "back" }] },
  { actions: [{ type: "url", url: "https://example.com", openInNewTab: true }, { type: "back" }] },
  { actions: [{ type: "node", destination: "Next", navigation: "swap", transition: { type: "push", direction: "right", matchLayers: true, easing: "custom_spring", spring: { mass: 1, stiffness: 100, damping: 15, initialVelocity: 0 } } }] },
]), 0) === null);
// What the read export writes (figma-plugin/src/prototype.ts): both destination fields, a preset easing's curve, the flags.
check("a reaction exactly as the read export writes it passes, written back as it is", writeOpError(op([
  { trigger: "on_click", actions: [{ type: "node", destinationId: "12:4", destination: "Home", navigation: "navigate", preserveScroll: true, resetInteractive: true,
    transition: { type: "slide_in", direction: "left", matchLayers: false, duration: 0.3, easing: "ease_out", cubicBezier: { x1: 0, y1: 0, x2: 0.58, y2: 1 } } }] },
]), 0) === null);
check("[] passes: it removes every reaction", writeOpError(op([]), 0) === null);
check("reactions must be a list", /`ops\[0\]\.reactions` is not|ops\[0\]\.reactions: must be a list of reactions/.test(refused({ trigger: "on_click" })));
check("only setReactions carries reactions", /`ops\[0\]\.reactions`: only a setReactions op/.test(err({ op: "patch", nodeId: "1:2", set: { name: "x" }, reactions: [] })));
check("a patch and a tree spec refuse `reactions` by name, pointing at setReactions",
  /set\.reactions: a patch cannot set it — a layer's prototype interactions are set with a setReactions op/.test(checkPatch({ reactions: [] }).problems.join("\n"))
  && /tree\.reactions: a read field a write cannot set yet — wire a layer's prototype with a setReactions op once the tree lands/.test(checkTree({ name: "S", reactions: [] }).problems.join("\n")));
check("a frame's overlay settings are refused: Figma's API makes them read-only to plugins",
  /tree\.overlay: .*read-only to plugins in Figma's API; set them in Figma's Prototype panel/.test(checkTree({ name: "S", overlay: { position: "center" } }).problems.join("\n"))
  && /set\.overlay: .*read-only to plugins/.test(checkPatch({ overlay: { position: "center" } }).problems.join("\n")));
check("variable and media actions are refused by name (not yet)", /reactions\[0\]\.actions\[0\]\.type a prototype action that sets a variable/.test(refused([tap({ type: "set_variable", variable: "x", value: 1 })]))
  && /a media action or trigger cannot be written yet/.test(refused([tap({ type: "update_media_runtime" })])) && /a media action or trigger/.test(refused([{ trigger: "on_media_end", actions: [{ type: "back" }] }]))
  && /`unknown`|a trigger the read could not name/.test(refused([{ trigger: "unknown", actions: [{ type: "back" }] }])));
check("an unknown trigger, action field or transition field is named, with the closest", /reactions\[0\]\.trigger must be one of on_click/.test(refused([{ trigger: "click", actions: [{ type: "back" }] }]))
  && /reactions\[0\]\.actions\[0\]\.destinaton: not a field the write accepts; closest: 'destination'/.test(refused([tap({ type: "node", destinaton: "Home" })])));
check("a reaction needs actions, at least one, at most " + MAX_ACTIONS, /needs `actions`/.test(refused([{ trigger: "on_click" }])) && /actions: is empty/.test(refused([{ actions: [] }]))
  && new RegExp("11 actions; a reaction runs at most " + MAX_ACTIONS).test(refused([{ actions: Array.from({ length: 11 }, () => ({ type: "back" })) }])));
check("at most " + MAX_REACTIONS + " reactions in one op", new RegExp("51 reactions; a layer takes at most " + MAX_REACTIONS).test(refused(Array.from({ length: 51 }, () => tap({ type: "back" })))));
check("a timeout and a delay are seconds, as Figma's plugin API takes them (seen live): said so when wrong",
  /timeout must be a number of seconds ≥ 0 \(2 is 2000 ms in Figma's Prototype panel\)/.test(refused([{ trigger: "after_timeout", timeout: -1, actions: [{ type: "back" }] }]))
  && /needs `timeout` \(seconds\)/.test(refused([{ trigger: "after_timeout", actions: [{ type: "back" }] }]))
  && reactionsText([{ trigger: "after_timeout", timeout: 0.8, actions: [{ type: "back" }] }]) === "after 0.8 s → back"
  && /on_drag trigger cannot be written yet \(Figma refuses it from a plugin/.test(refused([{ trigger: "on_drag", actions: [{ type: "back" }] }])));
check("each trigger's own fields: a timeout needs after_timeout (and it needs one), a delay a mouse trigger, keys a key trigger",
  /reactions\[0\]\.timeout: only with trigger after_timeout \(this one is on_click\)/.test(refused([{ timeout: 1, actions: [{ type: "back" }] }]))
  && /trigger after_timeout needs `timeout`/.test(refused([{ trigger: "after_timeout", actions: [{ type: "back" }] }]))
  && /reactions\[0\]\.delay: only with trigger mouse_enter/.test(refused([{ trigger: "on_hover", delay: 1, actions: [{ type: "back" }] }]))
  && /trigger on_key_down needs `keyCodes`/.test(refused([{ trigger: "on_key_down", actions: [{ type: "back" }] }]))
  && /keyCodes must be a non-empty list/.test(refused([{ trigger: "on_key_down", keyCodes: [], actions: [{ type: "back" }] }])));
check("each action's own fields: a node action needs a destination; url only on url, navigation only on node",
  /a node action needs `destination`/.test(refused([tap({ type: "node" })])) && /a url action needs `url`/.test(refused([tap({ type: "url" })]))
  && /actions\[0\]\.url: only on a `url` action \(this one is back\)/.test(refused([tap({ type: "back", url: "x" })]))
  && /actions\[0\]\.navigation: only on a `node` action \(this one is url\)/.test(refused([tap({ type: "url", url: "x", navigation: "navigate" })])));
check("an overlay offset only on an action that opens an overlay", /overlayOffset: only when the action opens an overlay/.test(refused([tap({ type: "node", destination: "A", overlayOffset: { x: 1, y: 1 } })])));
check("a transition: a type it may write (instant is no transition), a direction exactly when directional, durations in seconds, a custom curve given",
  /an instant change has no transition; leave `transition` out/.test(refused([tap({ type: "node", destination: "A", transition: { type: "instant" } })]))
  && /a slide_in transition needs `direction`/.test(refused([tap({ type: "node", destination: "A", transition: { type: "slide_in" } })]))
  && /transition\.direction: only on a directional transition/.test(refused([tap({ type: "node", destination: "A", transition: { type: "dissolve", direction: "left" } })]))
  && /transition\.duration must be a number of seconds from 0 to 10/.test(refused([tap({ type: "node", destination: "A", transition: { type: "dissolve", duration: 300 } })]))
  && /easing custom_cubic_bezier needs `cubicBezier`/.test(refused([tap({ type: "node", destination: "A", transition: { type: "dissolve", easing: "custom_cubic_bezier" } })]))
  && /transition: needs `type`/.test(refused([tap({ type: "node", destination: "A", transition: { duration: 1 } })])));
check("every problem at once, one per line", /^3 problems in the reactions — nothing was changed:\n/.test(refused([tap({ type: "node" }), tap({ type: "url" }), { actions: [] }])));
check("destinations in order, an id in `destination` read as an id", JSON.stringify(checkReactions([tap({ type: "node", destination: "Home" }), tap({ type: "node", destination: "12:4", navigation: "overlay" }), tap({ type: "back" }), tap({ type: "node", destinationId: "3:1", destination: "Menu" })]).summary.destinations)
  === JSON.stringify([{ path: "reactions[0].actions[0]", navigation: "navigate", name: "Home" }, { path: "reactions[1].actions[0]", navigation: "overlay", id: "12:4" }, { path: "reactions[3].actions[0]", navigation: "navigate", id: "3:1", name: "Menu" }]));
check("flows: setFlowStart needs a name, without edge spaces; clearFlowStart takes none",
  /missing name/.test(err({ op: "setFlowStart", nodeId: "1:2" })) && /`ops\[0\]\.name`: a flow starting point needs a name/.test(err({ op: "setFlowStart", nodeId: "1:2", name: " " }))
  && /'Main ' has spaces at its start or end/.test(err({ op: "setFlowStart", nodeId: "1:2", name: "Main " })) && /clearFlowStart takes only the frame's `nodeId`/.test(err({ op: "clearFlowStart", nodeId: "1:2", name: "Main" }))
  && writeOpError({ op: "setFlowStart", nodeId: "1:2", name: "Main" }, 0) === null && writeOpError({ op: "clearFlowStart", nodeId: "1:2" }, 0) === null);

console.log("\nthe dry run:");
const pv = writeOpPreview(op([tap({ type: "node", destination: "Home", transition: { type: "smart_animate" } }), { trigger: "after_timeout", timeout: 2, actions: [{ type: "back" }] }]), 0);
check(`setReactions overwrites the node, said in one sentence (got ${JSON.stringify(pv.change)})`, pv.effect === "overwrites" && pv.target === "1:2" && pv.invalid === undefined
  && /^node 1:2: its prototype interactions become 2 reactions \(on click → go to 'Home' \(smart animate 300 ms\); after 2 s → back\), replacing the ones it has — /.test(String(pv.change)));
check("[] says it removes them", /node 1:2: removes every prototype interaction/.test(String(writeOpPreview(op([]), 0).change)));
check("an invalid list is the wire check's problems", /needs `actions`/.test(String(writeOpPreview(op([{ trigger: "on_click" }]), 0).invalid)));
check("flow ops say what they do", /node 1:2: becomes the starting point of flow 'Main' on its page/.test(String(writeOpPreview({ op: "setFlowStart", nodeId: "1:2", name: "Main" }, 0).change))
  && /node 1:2: stops being a flow starting point/.test(String(writeOpPreview({ op: "clearFlowStart", nodeId: "1:2" }, 0).change))
  && writeOpPreview({ op: "setFlowStart", nodeId: "1:2" }, 0).invalid === "missing name");

console.log("\nthe card's words:");
check("a trigger and its actions in a few words", reactionsText([
  { trigger: "mouse_enter", delay: 0.25, actions: [{ type: "node", navigation: "overlay", destinationId: "3:1" }] },
  { trigger: "on_key_down", keyCodes: [13, 27], device: "ps4", actions: [{ type: "url", url: "https://x.test", openInNewTab: true }, { type: "close" }] },
  { actions: [{ type: "node", navigation: "scroll_to", destination: "Footer", transition: { type: "move_in", direction: "top", duration: 0.2 } }] },
], ["Menu"]) === "mouse enter after 0.25 s → open overlay 'Menu'; key 13, 27 (ps4) → open https://x.test in a new tab, then close the overlay; on click → scroll to 'Footer' (move in top 200 ms)");
const lines = cardLines([op([tap({ type: "back" })]), { op: "setReactions", nodeId: "1:3", reactions: [tap({ type: "back" })] }, { op: "clearFlowStart", nodeId: "1:4" }],
  [{ name: "Back", old: { prototype: 0 } }, { name: "Back 2", old: { prototype: 2 } }, { name: "Home", old: { flow: "Main" } }]).map((l) => lineText(l));
check(`the same list on two layers is one line, their old counts "mixed"; a flow cleared (got ${JSON.stringify(lines)})`,
  JSON.stringify(lines) === JSON.stringify(["2 layers: prototype mixed → on click → back", "Frame 'Home': flow start 'Main' → none"]));

report();
