// A tree spec from disk (bridge/src/spec-file.ts) and a keyed re-send's plan (bridge/src/tree-diff.ts): the pure halves of
// docs/write-plane-spec.md decisions 10 and 11. The plugin half (finding the result, applying the plan) is in
// test/harness/writes.ts; the MCP tool end to end in test/mcp-smoke.test.ts.
//   bun test/write-keyed.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { loadSpecFiles, MAX_SPEC_FILE_BYTES } from "../bridge/src/spec-file.ts";
import { checkPatch } from "../bridge/src/patch-spec.ts";
import { ownSpec, planUpdate, type OldNode } from "../bridge/src/tree-diff.ts";
import { MAX_KEY_LENGTH, type TreeNodeSpec } from "../bridge/src/tree-spec.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import { writeOpError, writeOpPreview } from "../bridge/src/commands.ts";
import { VERBS } from "../bridge/src/verbs.ts";
import { COMMAND_ROWS } from "../bridge/src/cli-commands.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-keyed-"));
const file = (name: string, text: string): string => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
const inside = (p: string): string => path.resolve(dir, p);

console.log("\na spec from disk:");
{
  const spec = { name: "Card", key: "card", layout: { display: "flex", flexDirection: "column" }, children: [{ text: "Hi", handle: "hi" }] };
  file("card.json", JSON.stringify(spec, null, 2));
  const r = loadSpecFiles([{ op: "createTree", treeFile: "card.json", page: "Screens" }], inside);
  check("a path is read into `tree`, and the path is gone", "ops" in r && JSON.stringify(r.ops) === JSON.stringify([{ op: "createTree", page: "Screens", tree: spec }]));
  const inline = [{ op: "createTree" as const, tree: spec, page: "Screens" }];
  const viaPath = "ops" in r ? r.ops : [];
  check("the dry run of a spec by path is the dry run of the same spec inline",
    JSON.stringify(viaPath.map((o, i) => writeOpPreview({ ...o, op: "createTree" }, i))) === JSON.stringify(inline.map((o, i) => writeOpPreview(o, i))));

  // The same validation: a bad spec by path is refused with exactly the inline refusal.
  const badSpec = { name: "Card", children: [{ text: "Hi", key: "nested" }], fills: [{ type: "solid", color: "red" }] };
  file("bad.json", JSON.stringify(badSpec));
  const bad = loadSpecFiles([{ op: "createTree", treeFile: "bad.json" }], inside);
  const badOps = "ops" in bad ? bad.ops : [];
  const loadedErr = badOps[0] ? writeOpError(badOps[0], 0) : "not loaded";
  const inlineErr = writeOpError({ op: "createTree", tree: badSpec }, 0);
  check("an invalid spec by path is refused with the inline spec's own refusal", loadedErr !== null && loadedErr === inlineErr && /ops\[0\]\.tree\.fills\[0\]\.color/.test(loadedErr));

  const missing = loadSpecFiles([{ op: "createTree", treeFile: "nope.json" }], inside);
  check("a missing file: refused, naming the op and the full path", "error" in missing && missing.error === "ops[0].treeFile: no file at " + path.join(dir, "nope.json"));
  file("broken.json", "{ \"name\": ");
  const broken = loadSpecFiles([{ op: "createTree", treeFile: "broken.json" }], inside);
  check("a file that is not JSON: refused, saying so", "error" in broken && broken.error.startsWith("ops[0].treeFile: " + path.join(dir, "broken.json") + " is not valid JSON ("));
  const both = loadSpecFiles([{ op: "createTree", tree: spec, treeFile: "card.json" }], inside);
  check("a path beside an inline spec: refused (one or the other)", "error" in both && /give the spec inline \(`tree`\) or as a path \(`treeFile`\), not both/.test(both.error));
  const wrongOp = loadSpecFiles([{ op: "patch", nodeId: "1:2", treeFile: "card.json" }], inside);
  check("a path on an op other than createTree: refused", "error" in wrongOp && /only a createTree op takes a spec from a file/.test(wrongOp.error));
  fs.mkdirSync(path.join(dir, "a-dir"));
  const isDir = loadSpecFiles([{ op: "createTree", treeFile: "a-dir" }], inside);
  check("a directory: refused", "error" in isDir && /is not a file/.test(isDir.error));
  file("huge.json", " ".repeat(MAX_SPEC_FILE_BYTES + 1));
  const huge = loadSpecFiles([{ op: "createTree", treeFile: "huge.json" }], inside);
  check("a file over the cap: refused before it is read", "error" in huge && /a spec file is at most/.test(huge.error));
  const outside = loadSpecFiles([{ op: "createTree", treeFile: "../x.json" }], (p, what) => { throw new Error(`${what} must stay inside the directory (got ${p})`); });
  check("a path the server refuses (outside its directory): that refusal, verbatim", "error" in outside && outside.error === "ops[0].treeFile must stay inside the directory (got ../x.json)");
  const untouched = loadSpecFiles([{ op: "createFrame", name: "X" }, { op: "createTree", tree: spec }], inside);
  check("ops without a path pass through as they are", "ops" in untouched && untouched.ops.length === 2 && untouched.ops[1]?.tree === spec);
  check("over the bridge a path is refused: the MCP server reads it, the plugin never does",
    writeOpError({ op: "createTree", tree: spec, treeFile: "card.json" }, 2) === "`ops[2].treeFile`: a spec path is read by figma_write on the MCP server; send the spec itself as `tree`");
}

console.log("\nwrites stay on the MCP server:");
{
  const words = [...VERBS, ...COMMAND_ROWS.map((r) => r.flag ?? "")];
  check("the CLI has no verb or flag that writes (write, patch, create, apply, tree, spec)", !words.some((w) => /write|patch|create|apply|tree|spec/i.test(w)));
  const src = path.join(import.meta.dirname, "..", "bridge", "src");
  const senders = fs.readdirSync(src).filter((f) => f.endsWith(".ts") && /\bask\(\s*"write"/.test(fs.readFileSync(path.join(src, f), "utf8")));
  check("the bridge's `write` command is sent from figma_write alone (figma-mcp.ts)", senders.join() === "figma-mcp.ts");
}

console.log("\nthe key:");
{
  check("a key on the root is accepted", checkTree({ key: "settings", name: "S" }).problems.length === 0);
  check("a key below the root is refused", checkTree({ children: [{ key: "x" }] }).problems.some((p) => p === "tree.children[0]: `key` names a whole result, so only the root carries it"));
  check("an empty key is refused", checkTree({ key: " " }).problems.some((p) => /tree\.key must be a non-empty string/.test(p)));
  check("a key over the cap is refused", checkTree({ key: "k".repeat(MAX_KEY_LENGTH + 1) }).problems.some((p) => /at most 200 characters/.test(p)));
  check("a patch cannot set a key", checkPatch({ key: "x" }).problems.some((p) => /set\.key: a patch cannot set it — a key names a createTree result/.test(p)));
  const step = writeOpPreview({ op: "createTree", tree: { key: "settings", name: "S" } }, 0);
  check("the dry run says a keyed spec updates the earlier result when there is one", /key 'settings': when the file already holds this key's earlier result, that result is updated in place/.test(step.change ?? ""));
}

// ---- the plan: an old result (each node's ref is its name here) against a new spec
/** An old result from a spec: what the plugin reads back off the nodes. Each node's ref is its path. */
function old(spec: TreeNodeSpec, at = "root"): OldNode<string> {
  return { ref: at, spec: ownSpec(spec), children: (spec.children ?? []).map((c, i) => old(c, at + "/" + (c.handle ?? c.name ?? String(i)))) };
}
const base: TreeNodeSpec = {
  key: "s", name: "Screen", box: { w: 390, h: 844 }, layout: { display: "flex", flexDirection: "column", gap: 16 }, fills: [{ type: "solid", color: "#ffffff" }],
  children: [
    { text: "Hello", name: "Title", handle: "title", font: { size: 24 } },
    { name: "Card", layout: { display: "flex", padding: [8, 8, 8, 8] }, children: [{ text: "A", name: "A" }, { text: "B", name: "B" }] },
    { component: "Button", handle: "btn", props: { Label: "Go" } },
  ],
};
const clone = (s: TreeNodeSpec): TreeNodeSpec => JSON.parse(JSON.stringify(s)) as TreeNodeSpec;
const kidsOf = (s: TreeNodeSpec): TreeNodeSpec[] => s.children ?? [];
const at = (s: TreeNodeSpec, ...path: number[]): TreeNodeSpec => {
  let n = s;
  for (const i of path) { const c = kidsOf(n)[i]; if (!c) throw new Error("no child " + i); n = c; }
  return n;
};

console.log("\nthe plan of a re-send:");
{
  const same = planUpdate(old(base), clone(base));
  check("the same spec again: nothing to do", same.updates.length + same.builds.length + same.removals.length + same.orders.length + same.stamps.length === 0);
  // Fields that set nothing do not count as a change.
  const cosmetic = clone(base);
  at(cosmetic, 0).renderBox = { x: 0, y: 0, w: 1, h: 1 };
  cosmetic.box = { w: 390, h: 844, x: 10, y: 20 };
  check("fields that set nothing (renderBox, a box's page x/y) change nothing in the file", planUpdate(old(base), cosmetic).updates.length === 0);

  const s2 = clone(base);
  at(s2, 0).text = "Hello there";
  (s2.layout ?? {}).gap = 24;
  s2.fills = [{ type: "solid", color: "#fafafa" }];
  const p2 = planUpdate(old(base), s2);
  const title = p2.updates.find((u) => u.ref === "root/title");
  const root = p2.updates.find((u) => u.ref === "root");
  check("a changed text: one update of that node, the text only", title !== undefined && JSON.stringify(title.fields) === "[\"text\"]" && JSON.stringify(title.set) === JSON.stringify({ text: "Hello there" }));
  check("the root: its layout whole and its fills, as a patch", root !== undefined && root.fields.join() === "layout,fills" &&
    root.set?.layout?.gap === 24 && root.set.layout.flexDirection === "column" && root.set.fills?.[0]?.color === "#fafafa");
  check("every patch the plan makes passes the patch check", p2.updates.every((u) => !u.set || checkPatch(u.set).problems.length === 0));
  check("nothing is built, removed or reordered", p2.builds.length + p2.removals.length + p2.orders.length === 0);
  check("the changed nodes get their new own spec stored", p2.stamps.map((s) => s.ref).sort().join() === "root,root/title");

  // A child added and one dropped (matched by name), a property changed on the instance.
  const s3 = clone(base);
  const card = at(s3, 1);
  card.children = [{ text: "A", name: "A" }, { text: "C", name: "C", handle: "c" }];
  at(s3, 2).props = { Label: "Stop" };
  const p3 = planUpdate(old(base), s3);
  check("a dropped child is removed", JSON.stringify(p3.removals) === JSON.stringify(["root/Card/B"]));
  check("an added child is built in its frame", p3.builds.length === 1 && p3.builds[0]?.parent === "root/Card" && p3.builds[0].replaces === null && p3.builds[0].spec.text === "C" && p3.builds[0].path === "tree.children[1].children[1]");
  check("the frame that gained a node gets its order", p3.orders.length === 1 && JSON.stringify(p3.orders[0]) === JSON.stringify({ parent: "root/Card", order: [{ ref: "root/Card/A" }, { build: 0 }] }));
  check("an instance's changed property: a props patch", p3.updates.some((u) => u.ref === "root/btn" && JSON.stringify(u.set) === JSON.stringify({ props: { Label: "Stop" } })));

  // Reordered by handle: same nodes, new order.
  const s4 = clone(base);
  s4.children = [at(base, 2), at(base, 0), at(base, 1)].map(clone);
  const p4 = planUpdate(old(base), s4);
  check("children reordered (matched by handle and name): no update, no build, one order", p4.updates.length === 0 && p4.builds.length === 0 &&
    JSON.stringify(p4.orders) === JSON.stringify([{ parent: "root", order: [{ ref: "root/btn" }, { ref: "root/title" }, { ref: "root/Card" }] }]));

  // What cannot change in place is built anew beside the old node, which is then removed.
  const s5 = clone(base);
  at(s5, 0).font = { size: 32 };
  at(s5, 2).component = "Link";
  const p5 = planUpdate(old(base), s5);
  check("a text's font, an instance's component: built anew, replacing the old node",
    p5.builds.length === 2 && p5.builds.every((b) => b.replaces !== null) && p5.builds.map((b) => b.replaces).join() === "root/title,root/btn" && p5.updates.length === 0);
  const s6 = clone(base);
  s6.children = [{ name: "Title", handle: "title" }, ...kidsOf(base).slice(1).map(clone)];
  check("a text that became a frame: built anew", planUpdate(old(base), s6).builds[0]?.replaces === "root/title");

  // A field the new spec drops goes back to a fresh build's.
  const s7 = clone(base);
  delete s7.fills;
  delete s7.layout;
  at(s7, 1).radius = 4;
  const p7 = planUpdate(old(base), s7);
  const r7 = p7.updates.find((u) => u.ref === "root");
  check("dropped fills and auto-layout: no fills, no auto-layout", JSON.stringify(r7?.set?.fills) === "[]" && JSON.stringify(r7?.set?.layout) === JSON.stringify({ mode: "absolute" }));
  check("an added radius: set", p7.updates.some((u) => u.ref === "root/Card" && u.set?.radius === 4));
  const s8 = clone(s7);
  delete at(s8, 1).radius;
  check("…and dropped again: back to 0", planUpdate(old(s7), s8).updates.some((u) => u.ref === "root/Card" && u.set?.radius === 0));

  // A variable binding: a raw value set again keeps the binding the spec still has; a dropped binding is unbound.
  const bound: TreeNodeSpec = { ...clone(base), tokens: { itemSpacing: "space/md" } };
  const rebound = clone(bound);
  rebound.fills = [{ type: "solid", color: "#000000" }];
  check("a raw field set again keeps the spec's bindings (given again)", planUpdate(old(bound), rebound).updates[0]?.set?.tokens?.itemSpacing === "space/md");
  const unbound = clone(bound);
  delete unbound.tokens;
  const pu = planUpdate(old(bound), unbound).updates[0];
  check("a dropped binding is unbound", pu?.set?.tokens?.itemSpacing === null && pu.fields.join() === "tokens");

  // The few fields a patch does not set are set on the node directly.
  const s9 = clone(base);
  s9.x = 400; s9.clip = true;
  at(s9, 1).grow = 1;
  const p9 = planUpdate(old(base), s9);
  check("x, clip and grow: set directly, not through a patch", p9.updates.some((u) => u.ref === "root" && u.extras.join() === "x,clip" && u.set === null) &&
    p9.updates.some((u) => u.ref === "root/Card" && u.extras.join() === "grow"));
  const s10 = clone(s9);
  delete s10.x;
  check("a position the spec drops leaves the node where it is", !planUpdate(old(s9), s10).updates.some((u) => u.extras.includes("x")));

  // A handle given to a kept node: no change in the file, its id comes back.
  const s11 = clone(base);
  at(s11, 1).handle = "card";
  const p11 = planUpdate(old(base), s11);
  check("a new handle on a kept node: no update, the handle listed, the spec stored", p11.updates.length === 0 && JSON.stringify(p11.handles) === JSON.stringify([{ handle: "card", ref: "root/Card" }]) && p11.stamps.length === 1);

  // A dropped per-side weight goes to the even weight the spec still gives (a fresh build's), not to 1.
  const sides: TreeNodeSpec = { ...clone(base), strokes: { colors: ["#000000"], weight: 2, weights: { top: 4 } } };
  const even = clone(sides);
  even.strokes = { colors: ["#000000"], weight: 2 };
  check("a dropped side weight takes the spec's even weight", JSON.stringify(planUpdate(old(sides), even).updates[0]?.set?.strokes) === JSON.stringify({ colors: ["#000000"], weight: 2, weights: { top: 2 } }));
  // A sizing mode dropped while the size stays: the spec's size applies again.
  const hug: TreeNodeSpec = { ...clone(base), widthMode: "hug", box: { w: 300, h: 200 } };
  const fixed = clone(hug);
  delete fixed.widthMode;
  const pf = planUpdate(old(hug), fixed).updates[0];
  const textFill: TreeNodeSpec = { ...clone(base), children: [{ text: "T", name: "T", box: { w: 100, h: 20 }, widthMode: "fill" }] };
  const taller = clone(textFill);
  at(taller, 0).box = { w: 100, h: 40 };
  const pt = planUpdate(old(textFill), taller).updates[0];
  check("a text's box changed while it fills: only the free axis is resized (the fill stays)", JSON.stringify(pt?.set) === JSON.stringify({ box: { h: 40 }, autoResize: "none" }));
  const tall: TreeNodeSpec = { key: "s", layout: { mode: "absolute", width: 300, height: 400 } };
  const narrow: TreeNodeSpec = { key: "s", layout: { mode: "absolute", width: 200 } };
  check("a dropped size axis goes back to a new frame's 100 (the other takes its new size)", JSON.stringify(planUpdate(old(tall), narrow).updates[0]?.set) === JSON.stringify({ box: { w: 200, h: 100 } }));
  check("a dropped `hug` sizes the axis to the spec's box again", JSON.stringify(pf?.set) === JSON.stringify({ box: { w: 300 }, widthMode: "fixed" }) && pf?.fields.join() === "box,widthMode");
}

fs.rmSync(dir, { recursive: true, force: true });
report();
