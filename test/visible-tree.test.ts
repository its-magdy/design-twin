// Offline tests for design-to-code/visible-tree.ts — the one walk over an export's node tree: the hidden
// state, the ancestor chain and the backdrop each node sits on, through the walk's own interface on small
// hand-built trees. The last block runs audit.ts and cross-check.ts on one tree: they must name the same backdrop.
//   bun test/visible-tree.test.ts
import { walkWithHidden, walkVisible, hiddenIds, hiddenRoots } from "../design-to-code/visible-tree.ts";
import type { WalkContext } from "../design-to-code/visible-tree.ts";
import { audit } from "../design-to-code/audit.ts";
import { crossCheck } from "../design-to-code/cross-check.ts";
import type { IrNode } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { node, screenExport, tokens } from "./fixtures.ts";
import type { NodeInput } from "./fixtures.ts";

const solid = (color: string, token?: string) => ({ type: "solid" as const, color, ...(token ? { tokens: { color: token } } : {}) });
const grad = { type: "gradient" as const, kind: "GRADIENT_LINEAR" as const, stops: [{ pos: 0, color: "#000000" }, { pos: 1, color: "#ffffff" }] };
/** Every visited node's context, by id. */
function contexts(walker: typeof walkWithHidden, root: IrNode): Map<string, WalkContext> {
  const out = new Map<string, WalkContext>();
  walker(root, (n, c) => { out.set(n.id, c); });
  return out;
}
const at = (m: Map<string, WalkContext>, id: string): WalkContext => {
  const c = m.get(id);
  if (!c) throw new Error(`node ${id} was not visited`);
  return c;
};

console.log("visible-tree — hidden state and ancestry:");
{
  const tree = node({ type: "FRAME", id: "1", name: "Page", children: [
    { type: "FRAME", id: "2", name: "Panel", hidden: true, children: [{ type: "TEXT", id: "3", name: "Toast", text: "Saved" }] },
    { type: "FRAME", id: "4", name: "Body", children: [{ type: "TEXT", id: "5", name: "Title", text: "Hi" }] },
  ] });
  const all = contexts(walkWithHidden, tree);
  check("walkWithHidden visits hidden layers too, in tree order", [...all.keys()].join() === "1,2,3,4,5");
  check("hidden is inherited; parentHidden marks the top of a hidden subtree",
    at(all, "2").hidden && !at(all, "2").parentHidden && at(all, "3").hidden && at(all, "3").parentHidden && !at(all, "4").hidden);
  check("ancestors: the chain root first, each with its node", at(all, "5").ancestors.map((a) => a.node.id).join() === "1,4" && at(all, "1").ancestors.length === 0);
  check("path / depth / parent", at(all, "5").path === "Page > Body > Title" && at(all, "5").depth === 2 && at(all, "5").parent?.id === "4");
  const vis = contexts(walkVisible, tree);
  check("walkVisible prunes a hidden layer and its whole subtree", [...vis.keys()].join() === "1,4,5");
  check("…and a hidden root yields nothing", contexts(walkVisible, node({ type: "FRAME", id: "9", name: "Off", hidden: true, children: [{ type: "TEXT", id: "10" }] })).size === 0);
  check("the flag is `hidden`, never `visible` (a component property can be called that)",
    contexts(walkVisible, node({ type: "FRAME", id: "1", name: "P", children: [{ type: "INSTANCE", id: "2", name: "Crumb", props: { visible: "Show Breadcrumb" } }] })).size === 2);
  check("hiddenIds / hiddenRoots", hiddenIds([tree]).join() === "2,3" && hiddenRoots([tree]).map((n) => n.id).join() === "2");
}

console.log("visible-tree — backdrop through ancestors:");
{
  const tree = node({ type: "FRAME", id: "1", name: "Page", fills: [solid("#ffffff", "Bg/Page")], layout: { display: "flex", flexDirection: "column" }, children: [
    { type: "TEXT", id: "2", name: "On page", fills: [solid("#000000", "Text/Ink")] },
    { type: "FRAME", id: "3", name: "Card", fills: [solid("#202020", "Bg/Card")], children: [{ type: "TEXT", id: "4", name: "On card" }] },
    { type: "FRAME", id: "5", name: "Scrim", fills: [solid("#00000080", "Bg/Scrim")], children: [{ type: "TEXT", id: "6" }] },
    { type: "FRAME", id: "7", name: "Hero", fills: [grad], children: [{ type: "TEXT", id: "8" }, { type: "FRAME", id: "9", fills: [solid("#ffffff", "Bg/Chip")], children: [{ type: "TEXT", id: "10" }] }] },
    { type: "FRAME", id: "11", name: "Ghost", fills: [solid("#ff000000"), { ...grad, opacity: 0 }], children: [{ type: "TEXT", id: "12" }] },
    { type: "FRAME", id: "13", name: "Old", tokens: { fills: "Bg/Legacy" }, children: [{ type: "TEXT", id: "14" }] },
    { type: "FRAME", id: "15", name: "Raw", fills: [solid("#eeeeee")], children: [{ type: "TEXT", id: "16" }] },
  ] });
  const m = contexts(walkVisible, tree);
  const bd = (id: string) => at(m, id).backdrop;
  check("the root sits on nothing", bd("1").color === null && bd("1").token === null && !bd("1").complex);
  check("a text on the page: the page's colour and token", bd("2").token === "Bg/Page" && bd("2").color?.r === 255);
  check("a text on a card: the card's token, not the page's", bd("4").token === "Bg/Card" && bd("4").color?.r === 32);
  check("a translucent fill composites the colour and names no token", bd("6").token === null && Math.abs((bd("6").color?.r ?? 0) - 128) <= 1 && !bd("6").complex);
  check("a gradient makes it complex and tokenless", bd("8").complex && bd("8").token === null);
  check("…until an opaque solid covers it again", !bd("10").complex && bd("10").token === "Bg/Chip");
  check("a fully transparent solid and an opacity-0 paint paint nothing: the page token stays", bd("12").token === "Bg/Page" && !bd("12").complex);
  check("a node-level fill token with no fills[] still names the backdrop", bd("14").token === "Bg/Legacy");
  check("a raw (unbound) opaque fill: its colour, no token", bd("16").token === null && bd("16").color?.r === 238);
  check("a TEXT's own fill is its glyph colour, never a backdrop", bd("2").token === "Bg/Page");
}

console.log("visible-tree — backdrop through earlier siblings (stacking):");
{
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const tree = node({ type: "FRAME", id: "1", name: "Page", fills: [solid("#ffffff", "Bg/Page")], box: box(0, 0, 400, 800), children: [
    { type: "RECTANGLE", id: "2", name: "Hero", fills: [solid("#101010", "Bg/Hero")], box: box(0, 0, 400, 300) },
    { type: "TEXT", id: "3", name: "Caption", fills: [solid("#ffffff")], box: box(0, 0, 400, 300) },
    { type: "VECTOR", id: "4", name: "Icon", asset: "icon.svg", fills: [solid("#ff0000")], box: box(0, 0, 24, 24) },
    { type: "RECTANGLE", id: "5", name: "Off", hidden: true, fills: [solid("#00ff00", "Bg/Off")], box: box(0, 0, 400, 300) },
    { type: "FRAME", id: "6", name: "Card", box: box(20, 20, 200, 100), children: [{ type: "TEXT", id: "7", name: "Title", box: box(30, 30, 100, 20) }] },
    { type: "TEXT", id: "8", name: "Below", box: box(0, 500, 400, 20) },
  ] });
  const m = contexts(walkVisible, tree);
  check("a fill-less card laid over an earlier hero sits on the hero", at(m, "6").backdrop.token === "Bg/Hero" && at(m, "6").beneath.map((n) => n.id).join() === "2");
  check("…and so does the text inside it", at(m, "7").backdrop.token === "Bg/Hero" && at(m, "7").backdrop.color?.r === 16);
  check("a TEXT, an icon's ink and a hidden sibling paint nothing beneath", at(m, "6").beneath.length === 1);
  check("a sibling whose box does not meet the hero's sits on the page", at(m, "8").backdrop.token === "Bg/Page" && at(m, "8").beneath.length === 0);
  const flow = node({ type: "FRAME", id: "1", name: "Page", fills: [solid("#ffffff", "Bg/Page")], layout: { display: "flex", flexDirection: "column" }, children: [
    { type: "RECTANGLE", id: "2", name: "Hero", fills: [solid("#101010", "Bg/Hero")] },
    { type: "TEXT", id: "3", name: "Next" },
    { type: "TEXT", id: "4", name: "Pinned", absolute: true },
  ] });
  const f = contexts(walkVisible, flow);
  check("in auto layout earlier siblings sit beside, not beneath", at(f, "3").backdrop.token === "Bg/Page");
  check("…except for an absolute child laid over the flow (no positions known: assume it overlaps)", at(f, "4").backdrop.token === "Bg/Hero");
}

console.log("visible-tree — audit and cross-check name the same backdrop:");
{
  // A form card with no fill of its own, laid over an earlier dark hero sibling; on it a dim-bordered input and a dark text.
  const vars = tokens({
    collections: [{ name: "Sem", key: "c1", modes: ["Dark", "Light"], default: "Dark" }],
    variables: [
      { name: "Bg/Page", collection: "Sem", key: "s1", type: "COLOR", values: { Dark: "#ffffff", Light: "#ffffff" } },
      { name: "Bg/Hero", collection: "Sem", key: "s2", type: "COLOR", values: { Dark: "#141414", Light: "#141414" } },
      { name: "Border", collection: "Sem", key: "s3", type: "COLOR", values: { Dark: "#2a2a2a", Light: "#2a2a2a" } },
      { name: "Text/Ink", collection: "Sem", key: "s4", type: "COLOR", values: { Dark: "#333333", Light: "#333333" } },
    ],
  });
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const input: NodeInput = {
    type: "INSTANCE", id: "1:4", name: "Input Field", mainComponent: { name: "State=Default", key: "fk", setKey: "fs", setName: "Input Field" },
    tokens: { strokes: "Border" }, strokes: { colors: ["#2a2a2a"], weight: 1, align: "inside" }, box: box(40, 40, 200, 48),
  };
  const ink: NodeInput = { type: "TEXT", id: "1:5", name: "Label", text: "Email", autoResize: "height", font: { family: "Inter", size: 14, color: "#333333" }, tokens: { fills: "Text/Ink" }, fills: [solid("#333333", "Text/Ink")], box: box(40, 100, 200, 20) };
  const doc = screenExport([{ type: "FRAME", id: "1:1", name: "Sign in", resolvedModes: { Sem: "Dark" }, box: box(0, 0, 400, 800), fills: [solid("#ffffff", "Bg/Page")], children: [
    { type: "RECTANGLE", id: "1:2", name: "Hero", fills: [solid("#141414", "Bg/Hero")], box: box(0, 0, 400, 300) },
    { type: "FRAME", id: "1:3", name: "Card", box: box(20, 20, 360, 200), children: [input, ink] },
  ] }], { screen: "Sign in" });
  const au = audit([{ doc, label: "Sign in", vars }], { platform: "web", variables: vars });
  const border = au.findings.find((x) => x.code === "non-text-contrast");
  check("audit: the input's border is judged against the hero it sits on", border?.backdropToken === "Bg/Hero");
  check("audit: the dark label is low contrast on the hero (not passed against a white page)", au.findings.some((x) => x.code === "low-contrast" && x.nodeId === "1:5"));
  const rows = crossCheck({ screens: [{ doc, label: "Sign in", vars }], variables: vars }).findings.find((x) => x.code === "token-pair-contrast")?.tokenPairs ?? [];
  check("cross-check: the border's row names the same backdrop token", rows.some((r) => r.kind === "non-text" && r.fg === "Border" && r.bg === "Bg/Hero"));
  check("cross-check: the label's row names it too", rows.some((r) => r.kind === "text" && r.fg === "Text/Ink" && r.bg === "Bg/Hero"));
  check("cross-check: no row judges either against the page under the hero", !rows.some((r) => r.bg === "Bg/Page"));
}

report();
