// The designer's review of a write, the pure halves: when a batch waits and when its card offers a preview
// (bridge/src/review-policy.ts), and the card's plain lines (bridge/src/review-card.ts).
//   bun test/review-policy.test.ts
import { check, report } from "./assert.ts";
import { countLayers, previewOffered, REVIEW_LAYER_LIMIT, reviewDecision, type ReviewFacts } from "../bridge/src/review-policy.ts";
import { cardLines, lineText, valueText, type CardLine } from "../bridge/src/review-card.ts";
import { describeTree, sizePhrase } from "../bridge/src/tree-spec.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import { writeOpPreview, type WriteOp } from "../bridge/src/commands.ts";

const facts = (f: Partial<ReviewFacts> = {}): ReviewFacts => ({ checkbox: false, sourceEdits: 0, bulkByRule: false, layers: 0, sinceApproval: 0, ...f });

console.log("\nwhen a write waits:");
check("the limit is 25 layers, fixed", REVIEW_LAYER_LIMIT === 25);
check("the box ticked: every batch waits, saying so", reviewDecision(facts({ checkbox: true })).wait && reviewDecision(facts({ checkbox: true })).reason === "'Review each change first' is on");
check("the box clear: a small change goes straight through", !reviewDecision(facts({ layers: 3, sinceApproval: 10 })).wait && reviewDecision(facts()).reason === "");
const src = reviewDecision(facts({ sourceEdits: 1 }));
check("the box clear: a source edit still waits, saying other layers follow it", src.wait && /variable, style or main component that other layers follow/.test(src.reason));
check("…and a bulk change by rule (#171's hook)", reviewDecision(facts({ bulkByRule: true })).wait && /picks by a rule/.test(reviewDecision(facts({ bulkByRule: true })).reason));
check("over the limit in one batch waits; exactly the limit does not", reviewDecision(facts({ layers: 26 })).wait && /it changes 26 existing layers \(over 25\)/.test(reviewDecision(facts({ layers: 26 })).reason) && !reviewDecision(facts({ layers: 25 })).wait);
const chunk = reviewDecision(facts({ layers: 10, sinceApproval: 20 }));
check("the count is cumulative since the last approval: chunks of 10 stop at the one that crosses 25", chunk.wait && /30 existing layers would have changed since your last approval \(over 25\)/.test(chunk.reason));
check("every reason that holds is named, the box last", /^it changes a variable.*; 'Review each change first' is on$/.test(reviewDecision(facts({ checkbox: true, sourceEdits: 1 })).reason));
check("layers are counted once, this session's own left out", countLayers(["1:1", "1:1", "1:2", "9:9"], (id) => id === "9:9") === 2);

console.log("\nwhen a preview is offered:");
const pv = { sourceEdits: 0, bulkByRule: false, layers: 0, deletes: false, keyedResend: false };
check("a source edit, a bulk change by rule, or a batch over the limit by itself", previewOffered({ ...pv, sourceEdits: 1 }) && previewOffered({ ...pv, bulkByRule: true }) && previewOffered({ ...pv, layers: 26 }));
check("not a small change", !previewOffered({ ...pv, layers: 25 }));
check("never with a delete or a keyed re-send (they cannot be put back)", !previewOffered({ ...pv, sourceEdits: 1, deletes: true }) && !previewOffered({ ...pv, layers: 40, keyedResend: true }));

console.log("\nthe card's lines:");
/** The first line of a card, as text ("(no line)" when there is none). */
const firstLine = (ls: readonly CardLine[]): string => { const l = ls[0]; return l ? lineText(l) : "(no line)"; };
const patch = (id: string, set: Record<string, unknown>): WriteOp => ({ op: "patch", nodeId: id, set });
const many = Array.from({ length: 30 }, (_, i) => patch("1:" + i, { radius: 20, opacity: 0.8 }));
const grouped = cardLines(many, many.map(() => ({ name: "Card", old: { radius: 6, opacity: 1 } })));
check("30 layers patched alike are one line, old → new, opacity as a percentage",
  grouped.length === 1 && firstLine(grouped) === "30 layers: radius 6 → 20, opacity 100% → 80%" && grouped[0]?.ops.length === 30);
const mixed = cardLines([patch("1:1", { radius: 20 }), patch("1:2", { radius: 20 })], [{ old: { radius: 4 } }, { old: { radius: 6 } }]);
check("old values that differ read 'mixed'", firstLine(mixed) === "2 layers: radius mixed → 20");
const unread = cardLines([patch("1:1", { radius: 20 })], []);
check("a value the plugin could not read shows only the new one, and no id stands in for a name it read", firstLine(unread) === "A layer: radius → 20");
const one = cardLines([patch("1:1", { name: "Title", fills: [{ type: "solid", color: "#16a34a" }] })], [{ name: "Heading", old: { name: "Heading", fills: [{ type: "solid", color: "#3b82f6" }] } }]);
check("one layer is named; a fill reads as its colour", firstLine(one) === "Layer 'Heading': name Heading → Title, fills #3b82f6 → #16a34a");
const v = cardLines([{ op: "setVariable", variable: "demo/accent", value: "#16a34a" }], [{ name: "demo/accent", old: { Default: "#3b82f6" }, follows: 40 }]);
check("a variable: its value old → new, and how many layers follow", firstLine(v) === "Variable 'demo/accent': #3b82f6 → #16a34a — 40 layers follow");
const vm = cardLines([{ op: "setVariable", variable: "bg", values: { Light: "#ffffff", Dark: "#111111" } }], [{ old: { Light: "#fafafa", Dark: "#000000" }, follows: 1 }]);
check("…by mode when it sets several", firstLine(vm) === "Variable 'bg': Light #fafafa → #ffffff, Dark #000000 → #111111 — 1 layer follows");
const main = cardLines([patch("5:1", { radius: 8 })], [{ name: "Base", component: "Button", old: { radius: 4 }, follows: 12 }]);
check("a patch inside a main component is its own line, with the instances that follow", firstLine(main) === "Main component 'Button', layer 'Base': radius 4 → 8 — 12 layers follow");
const tree: WriteOp = { op: "createTree", tree: { name: "Settings card", layout: { display: "flex", flexDirection: "column", width: 320 }, heightMode: "hug", children: [{ text: "Hi" }] } };
const created = cardLines([tree], [{ lands: "right of the existing frames" }]);
check("a new frame: its name, its size (a width only: height hugs content), what is inside, where it lands",
  firstLine(created) === "New frame 'Settings card', 320 wide, height hugs content, 1 layer inside — lands right of the existing frames");
check("a keyed re-send says it updates in place", firstLine(cardLines([tree], [{ updates: "Settings card" }])) === "Updates 'Settings card' in place");
check("no line carries a node id or the dry run's check details", ![...grouped, ...v, ...created].some((l) => /\d+:\d+|checked against|put back if/.test(lineText(l))));
check("a delete says it cannot be put back", /cannot be put back/.test(firstLine(cardLines([{ op: "delete", nodeId: "3:3" }], [{ name: "Old" }]))));
check("values in a few words", valueText("hidden", true) === "hidden" && valueText("text", "x".repeat(60)).length === 42 && valueText("box", { w: 320, h: 200 }) === "320×200" && valueText("fills", []) === "none");

console.log("\nthe size of a new frame (shared with the dry run):");
check("both sides: W×H", sizePhrase({ box: { w: 320, h: 200 } }) === "320×200");
check("a width only never reads '×undefined'", sizePhrase({ layout: { width: 320 } }) === "320 wide, height as Figma makes a new frame" && sizePhrase({ layout: { width: 320 }, heightMode: "hug" }) === "320 wide, height hugs content");
const spec = { name: "Card", layout: { display: "flex" as const, width: 320 }, heightMode: "hug" as const };
const { summary } = checkTree(spec);
check("the dry run's sentence says it the same way", /creates frame 'Card' 320 wide, height hugs content, horizontal auto-layout with/.test(describeTree(spec, undefined, summary)) && !/undefined/.test(String(writeOpPreview({ op: "createTree", tree: spec }, 0).change)));

report();
