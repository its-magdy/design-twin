// Clone and patch, and repetition (docs/write-plane-spec.md decisions 6, 7): a createTree node that copies an existing
// node with only its differences (figma-plugin/src/clones.ts), an instance with a table of rows and a fragment placed
// by name (bridge/src/tree-expand.ts). All three keep the all-or-nothing rule.
import { argsShapeError, writeOpPreview } from "../../bridge/src/commands.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

const isNode = (v: unknown): v is FakeNode => typeof v === "object" && v !== null;
const kids = (n: FakeNode | undefined): readonly FakeNode[] => n?.children ?? [];
const all = (n: FakeNode | undefined): FakeNode[] => (n ? [n, ...kids(n).flatMap(all)] : []);
const fill = (n: FakeNode | undefined): string => JSON.stringify(isNode(n) && Array.isArray(n.fills) ? n.fills.map((p: unknown) => (isNode(p) ? p.color : null)) : null);

/** An order screen: a title, two rows of a label and a value, a button. Handles on the title and the first value. */
const orderScreen = (): Record<string, unknown> => ({
  name: "Order 1", handle: "screen", box: { w: 390, h: 844 }, fills: [{ type: "solid", color: "#ffffff" }],
  layout: { display: "flex", flexDirection: "column", gap: 16 },
  children: [
    { name: "Title", handle: "title", text: "Order 1", font: { size: 24 } },
    { name: "Status row", layout: { display: "flex" }, children: [{ name: "Label", text: "Status" }, { name: "Value", handle: "status", text: "Delivered" }] },
    { name: "Total row", layout: { display: "flex" }, children: [{ name: "Label", text: "Total" }, { name: "Value", text: "$18.00" }] },
    { name: "Track", box: { w: 358, h: 48 }, fills: [{ type: "solid", color: "#4f46e5" }], layout: { display: "flex" }, children: [{ name: "Button label", text: "Track order" }] },
  ],
});

export const cases: Case[] = [{
  name: "clone (createTree `clone`): a copy of an existing screen, with only its differences",
  async run() {
    const w = await treeWorld();
    const { api, alive } = w;
    const src = await api.applyWrites([{ op: "createTree", tree: orderScreen() }]);
    const h = src.applied[0]?.handles ?? {};
    const sourceId = must(src.applied[0]?.id, "source id");
    const source = alive().find((n) => n.id === sourceId);
    const sourceText = (): string => JSON.stringify(all(source).map((n) => [n.name, n.characters, fill(n)]));
    const before = sourceText();
    const total = all(source).find((n) => n.name === "Total row");

    // The second screen: the same layers, a new name, three texts and a colour changed — by a layer's id (from the
    // read) or its name where the name is unique.
    const r = await api.applyWrites([{ op: "createTree", tree: { clone: sourceId, name: "Order 2", edits: {
      [must(h.title, "title")]: { text: "Order 2" },
      [must(h.status, "status")]: { text: "Shipped" },
      "Total row": { opacity: 0.5 },
      "Button label": { text: "Cancel order" },
      Track: { fills: [{ type: "solid", color: "#dc2626" }] },
    } } }]);
    const a = r.applied[0];
    const copy = alive().find((n) => n.id === a?.id);
    const texts = all(copy).filter((n) => n.type === "TEXT").map((n) => n.characters);
    ok("[CLONE] ok: one copy counted, nothing built node by node", r.ok === true && JSON.stringify(a?.created) === JSON.stringify({ frames: 0, texts: 0, clones: 1 }));
    ok("[CLONE] the copy has the source's layers and values, with only the named differences",
      copy?.name === "Order 2" && all(copy).length === all(source).length && JSON.stringify(texts) === JSON.stringify(["Order 2", "Status", "Shipped", "Total", "$18.00", "Cancel order"])
      && fill(all(copy).find((n) => n.name === "Track")) === JSON.stringify([{ r: 220 / 255, g: 38 / 255, b: 38 / 255 }]) && all(copy).find((n) => n.name === "Total row")?.opacity === 0.5);
    ok("[CLONE] the source is left as it was", sourceText() === before && total?.opacity === 1);
    ok("[CLONE] the copy is placed beside the existing frames, on the page, shown", copy?.parent === w.pages.current && Number(copy?.x) > Number(source?.x) && copy?.visible === true);
    ok("[CLONE] the copy's layers are new nodes (new ids), and this session's own", all(copy).every((n) => !all(source).includes(n)) && new Set(all(copy).map((n) => n.id)).size === all(copy).length);
    const moved = await api.applyWrites([{ op: "move", nodeId: must(all(copy).find((n) => n.name === "Track")?.id, "track"), parentId: must(copy?.id, "copy"), index: 0 }]);
    ok("[CLONE] …so a move (session-created only) accepts them", moved.ok === true);

    // A copy inside a new tree: placed in its auto-layout parent, filling it, its handle's id the copy's.
    const inTree = await api.applyWrites([{ op: "createTree", tree: { name: "Two cards", layout: { display: "flex", flexDirection: "column" }, box: { w: 400, h: 600 }, children: [
      { text: "Recent" },
      { clone: must(total?.id, "total"), handle: "first", widthMode: "fill", edits: { Value: { text: "$42.00" } } },
      { clone: must(total?.id, "total"), absolute: true, x: 10, y: 20 },
    ] } }]);
    const tree = alive().find((n) => n.id === inTree.applied[0]?.id);
    const [, first, second] = kids(tree);
    ok("[CLONE] copies as children: counted beside the built nodes, the handle's id is the copy's",
      inTree.ok === true && JSON.stringify(inTree.applied[0]?.created) === JSON.stringify({ frames: 1, texts: 1, clones: 2 }) && inTree.applied[0]?.handles?.first === first?.id);
    ok("[CLONE] …placed in the flow (fill) or out of it (absolute, x/y), each with its own edits",
      first?.layoutSizingHorizontal === "FILL" && kids(first)[1]?.characters === "$42.00" && second?.layoutPositioning === "ABSOLUTE" && second?.x === 10 && kids(second)[1]?.characters === "$18.00");
    ok("[CLONE] the dry run describes a copy", /^creates a copy of node \S+ named 'Order 2' with 5 layers changed on the current page/.test(writeOpPreview(
      { op: "createTree", tree: { clone: sourceId, name: "Order 2", edits: { a: { text: "x" }, b: { text: "y" }, c: { text: "z" }, d: { text: "1" }, e: { text: "2" } } } }, 0).change ?? ""));
    ok("[CLONE] …and copies inside a tree", /\(1 frame, 0 texts, 2 copies\)/.test(writeOpPreview({ op: "createTree", tree: { layout: { display: "flex" }, children: [{ clone: "1:1" }, { clone: "1:2" }] } }, 0).change ?? ""));
  },
}, {
  name: "clone: everything is checked before the file is touched; every problem listed, nothing copied",
  async run() {
    const w = await treeWorld();
    const { api, alive } = w;
    const src = await api.applyWrites([{ op: "createTree", tree: orderScreen() }]);
    const sourceId = must(src.applied[0]?.id, "source id");
    const h = src.applied[0]?.handles ?? {};
    const count = alive().length;
    const refused = async (what: string, ops: Array<{ op: string } & Record<string, unknown>>, ...want: RegExp[]): Promise<void> => {
      const r = await api.applyWrites(ops);
      const e = r.error ?? "";
      const missing = want.filter((re) => !re.test(e));
      ok("[CLONE-CHECK] " + what + (missing.length ? " (missing " + missing.join(", ") + " in: " + e + ")" : ""),
        r.ok === false && r.applied.length === 0 && alive().length === count && w.cloned.length === 0 && missing.length === 0);
    };
    // The spec's own check (dry run, wire and plugin): no node is looked up.
    await refused("a source by name, a layer inside an instance, a key on the root copy, children and a type on a copy, a bad patch value", [
      { op: "createFrame", name: "never" },
      { op: "createTree", tree: { layout: { display: "flex" }, children: [
        { clone: "Order 1" },
        { clone: "I1:2;3:4" },
        { clone: sourceId, children: [{ text: "x" }], type: "FRAME", opacity: 2, edits: { Title: { text: 5 } } },
      ] } },
    ], /a copy names its source by id, never by name/, /a layer inside an instance/, /children: not on a copy/, /type: not on a copy/, /opacity must be a number from 0 to 1/,
      /edits\["Title"\]\.text must be a string/);
    await refused("a key or `hidden` on the root copy", [{ op: "createTree", tree: { clone: sourceId, key: "order", hidden: true } }], /a copy as the root cannot carry a `key` yet/, /`hidden` on the root copy/);
    await refused("a fill on the root copy (no parent with auto-layout)", [{ op: "createTree", tree: { clone: sourceId, widthMode: "fill" } }], /widthMode: "fill"` needs a parent with auto-layout \(this is the root\)/);
    // The file's check: every problem of every copy, at once, before anything runs.
    await refused("a missing source, a page, a text as the root copy, an unknown and an ambiguous layer, a field the layer lacks, the same layer twice", [
      { op: "createFrame", name: "never" },
      { op: "createTree", tree: { clone: "9:99" } },
      { op: "createTree", tree: { clone: "0:2" } },
      { op: "createTree", tree: { clone: must(h.title, "title") } },
      { op: "createTree", tree: { clone: sourceId, edits: { Total: { text: "x" }, Label: { text: "y" }, "Total row": { text: "z" }, [must(h.status, "status")]: { text: "a" }, Value: { text: "b" } } } },
    ], /ops\[1\] \(createTree\): tree\.clone: no node with id '9:99'/, /ops\[2\] \(createTree\): tree\.clone: 'Screens' \(0:2\) is a PAGE/, /ops\[3\] \(createTree\): tree\.clone: the root copy is a screen, so its source must be a FRAME/,
      /edits\["Total"\]: no layer of 'Order 1' \(\S+\) is named 'Total'; closest: 'Total row'/, /edits\["Label"\]: matches 2 layers of 'Order 1'/,
      /edits\["Total row"\]\.text: only on a TEXT node/, /edits\["Value"\]: matches 2 layers/);
    await refused("the same layer named twice (by id and by its unique name)", [{ op: "createTree", tree: { clone: sourceId, edits: { [must(h.title, "title")]: { text: "a" }, Title: { text: "b" } } } }],
      /names 'Title' \(\S+\), which the edit '\S+' names too/);
    // A value Figma refuses partway through the copy's patches: the whole tree goes, and the batch is put back.
    w.trap.add("opacity");
    const partway = await api.applyWrites([{ op: "createFrame", name: "Earlier" }, { op: "createTree", tree: { name: "Holder", children: [{ clone: sourceId, edits: { "Total row": { opacity: 0.4 } } }] } }]);
    w.trap.delete("opacity");
    ok("[CLONE-CHECK] Figma refusing a copy's edit partway: the tree and its copy are removed, the earlier op put back, the source untouched",
      partway.ok === false && partway.failedAt === 1 && partway.restored?.length === 1 && alive().length === count && w.cloned.at(-1)?.id === sourceId
      && all(alive().find((n) => n.id === sourceId)).every((n) => n.opacity === 1));
    // Figma refusing something between clone() and the copy's place in the tree (its stamps cleared): the copy is removed
    // too, not left on the page.
    for (const tree of [{ clone: sourceId }, { name: "Holder", children: [{ clone: sourceId }] }]) {
      w.trap.add("setPluginData");
      const early = await api.applyWrites([{ op: "createTree", tree }]);
      w.trap.delete("setPluginData");
      ok("[CLONE-CHECK] Figma refusing the copy before it is in the tree (" + (tree.clone ? "the root" : "a child") + "): no copy is left on the page",
        early.ok === false && alive().length === count);
    }
    // The wire check and the dry run say the same.
    const bad = { op: "createTree", tree: { clone: "Order 1" } };
    ok("[CLONE-CHECK] the wire check and the dry run refuse the same spec, by path",
      argsShapeError("write", { ops: [bad] }) === "bad write args: ops[0].tree.clone must be a node id (e.g. \"12:34\", as the read gives it); a copy names its source by id, never by name. Nothing was changed."
      && writeOpPreview({ op: "createTree", tree: { clone: "Order 1" } }, 0).invalid === "tree.clone must be a node id (e.g. \"12:34\", as the read gives it); a copy names its source by id, never by name");
  },
}, {
  name: "clone: a keyed source's stamps stay with it; a copy in a keyed spec is kept, or made again when it changes; one Cmd-Z",
  async run() {
    const w = await treeWorld();
    const { api, alive } = w;
    const src = await api.applyWrites([{ op: "createTree", tree: { key: "orders", ...orderScreen() } }]);
    const sourceId = must(src.applied[0]?.id, "source id");
    const r = await api.applyWrites([{ op: "createTree", tree: { clone: sourceId, name: "Order 2" } }]);
    const copy = alive().find((n) => n.id === r.applied[0]?.id);
    const stamps = (n: FakeNode | undefined): string[] => all(n).map((x) => String((x.getPluginData as (k: string) => string)("dtwin.key")));
    ok("[CLONE-KEYED] a copy of a keyed result carries none of its stamps", r.ok === true && stamps(copy).every((k) => k === "") && stamps(alive().find((n) => n.id === sourceId)).every((k) => k === "orders"));
    const again = await api.applyWrites([{ op: "createTree", tree: { key: "orders", ...orderScreen() } }]);
    ok("[CLONE-KEYED] …and the source's key still updates the source alone", again.ok === true && again.applied[0]?.id === sourceId && again.applied[0]?.unchanged === true);

    const spec = (value: string): Record<string, unknown> => ({ key: "pair", name: "Pair", layout: { display: "flex" }, children: [{ text: "Pinned" }, { clone: sourceId, handle: "c", edits: { Title: { text: value } } }] });
    const one = await api.applyWrites([{ op: "createTree", tree: spec("Copy A") }]);
    const copyA = one.applied[0]?.handles?.c;
    const same = await api.applyWrites([{ op: "createTree", tree: spec("Copy A") }]);
    ok("[CLONE-KEYED] a keyed spec with a copy sent again unchanged: the copy is kept", same.ok === true && same.applied[0]?.unchanged === true);
    const changed = await api.applyWrites([{ op: "createTree", tree: spec("Copy B") }]);
    const pair = alive().find((n) => n.id === one.applied[0]?.id);
    const copyB = kids(pair)[1];
    ok("[CLONE-KEYED] …and with its edit changed: the copy is made again in its place, the old one removed",
      changed.ok === true && changed.applied[0]?.id === one.applied[0]?.id && changed.applied[0]?.handles?.c === copyB?.id && copyB?.id !== copyA
      && kids(pair).length === 2 && all(copyB).find((n) => n.name === "Title")?.characters === "Copy B" && !alive().some((n) => n.id === copyA));

    // A copy brings containers a spec does not build (a group): a layer the designer puts in one is still theirs, so a
    // re-send that drops the copy refuses instead of removing it.
    const grouped = await api.applyWrites([{ op: "createTree", tree: { name: "Group source", children: [{ name: "Inner", children: [{ text: "a" }] }] } }]);
    const inner = kids(alive().find((n) => n.id === grouped.applied[0]?.id))[0];
    if (inner) inner.type = "GROUP";
    const withGroup = (keep: boolean): Record<string, unknown> => ({ key: "grouped", name: "G", children: keep ? [{ clone: must(inner?.id, "group"), handle: "g" }] : [] });
    const g1 = await api.applyWrites([{ op: "createTree", tree: withGroup(true) }]);
    const copyG = alive().find((n) => n.id === g1.applied[0]?.handles?.g);
    const designer = await api.applyWrites([{ op: "createText", text: "mine", parentId: must(copyG?.id, "copied group") }]);
    const g2 = await api.applyWrites([{ op: "createTree", tree: withGroup(false) }]);
    ok("[CLONE-KEYED] a designer's layer inside a copied group: a re-send that drops the copy refuses, and the layer stays",
      copyG?.type === "GROUP" && designer.ok === true && g2.ok === false && /which this key did not build/.test(g2.error ?? "") && alive().some((n) => n.id === designer.applied[0]?.id));

    // One batch, one undo step: the checkpoints around a copy's batch, as around any other.
    const commits = w.undo.commits;
    await api.applyWrites([{ op: "createTree", tree: { clone: sourceId } }]);
    ok("[CLONE-KEYED] a copy's batch is one undo step (a checkpoint before and after)", w.undo.commits === commits + 2);
  },
}, {
  name: "rows (an instance with a table of rows): one instance per row, all or nothing",
  async run() {
    const w = await treeWorld({ kit: true });
    const { api, alive } = w;
    const r = await api.applyWrites([{ op: "createTree", tree: { name: "Actions", layout: { display: "flex", flexDirection: "column" }, children: [
      { text: "Pick one" },
      { component: "Button", props: { Size: "Large" }, widthMode: "fill", rows: [{ Label: "Pay" }, { Label: "Save", Size: "Medium" }, { Label: "Cancel", Icon: true }] },
      { component: "Button", columns: ["Label", "Icon"], rows: [["Back", false], ["Next", true]] },
    ] } }]);
    const root = alive().find((n) => n.id === r.applied[0]?.id);
    const props = kids(root).slice(1).map((n) => n.props);
    ok("[ROWS] one instance per row, in order, each with the node's props and its row's (a row's value wins)",
      r.ok === true && kids(root).length === 6 && JSON.stringify(r.applied[0]?.created) === JSON.stringify({ frames: 1, texts: 1, instances: 5 })
      && JSON.stringify(props) === JSON.stringify([
        { Size: "Large", "Label#1:0": "Pay" }, { Size: "Medium", "Label#1:0": "Save" }, { Size: "Large", "Label#1:0": "Cancel", "Icon#1:1": true },
        { "Label#1:0": "Back", "Icon#1:1": false }, { "Label#1:0": "Next", "Icon#1:1": true },
      ]) && kids(root).slice(1, 4).every((n) => n.layoutSizingHorizontal === "FILL"));
    const dry = writeOpPreview({ op: "createTree", tree: { children: [{ component: "Button", rows: [{ Label: "A" }, { Label: "B" }] }] } }, 0);
    ok("[ROWS] the dry run counts the rows' instances", /with 3 nodes \(1 frame, 0 texts, 2 instances\)/.test(dry.change ?? ""));
    const count = alive().length;
    const bad = await api.applyWrites([{ op: "createFrame", name: "never" }, { op: "createTree", tree: { children: [
      { component: "Button", rows: [{ Label: "A" }, { Lable: "B" }] },
    ] } }]);
    ok("[ROWS] a row naming a property the component lacks refuses the whole batch, by the row's path",
      bad.ok === false && bad.applied.length === 0 && alive().length === count && /tree\.children\[0\]\.rows\[1\]/.test(bad.error ?? "") && /Lable/.test(bad.error ?? ""));
    const shape = checkTree({ children: [
      { name: "F", rows: [{ a: "b" }] },
      { component: "Button", handle: "b", rows: [{ Label: "A" }] },
      { component: "Button", columns: ["Label", "Icon"], rows: [["A"], ["B", 3]] },
      { component: "Button", rows: [] },
      { component: "Button", columns: ["Label"], rows: [{ Label: "A" }] },
      { component: "Button", columns: ["Label", "Label"], rows: [["A", "B"]] },
      { name: "F", columns: ["Label"] },
      { component: "Button", props: 7, rows: [{ Label: "A" }] },
    ] }).problems;
    ok("[ROWS] the table's shape is checked with the spec: on an instance only, no handle, one value per column, a non-empty list",
      JSON.stringify(shape) === JSON.stringify([
        "tree.children[0].rows: a row table is on an instance (a node with `component`); repeat other parts with a fragment (`use`)",
        "tree.children[1].handle: a handle names one node, and a row table makes several; leave it out",
        "tree.children[2].rows[0]: must be a list of 2 values, one per column ('Label', 'Icon')",
        "tree.children[2].rows[1][1]: must be a string (a variant's value, a text) or a boolean",
        "tree.children[3].rows: must be a non-empty list of rows (each an object of property name → value)",
        "tree.children[4].rows[0]: must be a list of 1 value, one per column ('Label')",
        "tree.children[5].columns: names a property twice",
        "tree.children[6].columns: names the values of each row in `rows`, which this node does not have",
        "tree.children[7].props: must be an object of property name → value (the values every row shares)",
      ]));
    const rowProblem = checkTree({ layout: { display: "flex" }, children: [{ text: "x" }, { component: "Button", rows: [{ Label: "A" }, { Label: "B" }], grow: 2 }] }).problems;
    ok("[ROWS] a problem of the instances the rows make is named at each row", JSON.stringify(rowProblem) === JSON.stringify(["tree.children[1].rows[0].grow must be 0 or 1", "tree.children[1].rows[1].grow must be 0 or 1"]));
  },
}, {
  name: "fragments (named parts, `use`): defined once, placed several times, with edits; all or nothing",
  async run() {
    const w = await treeWorld();
    const { api, alive } = w;
    const fragments = {
      row: { name: "Row", layout: { display: "flex" }, children: [{ name: "Label", text: "Label" }, { name: "Value", text: "Value", fills: [{ type: "solid", color: "#71717a" }] }] },
      section: { name: "Section", layout: { display: "flex", flexDirection: "column" }, children: [{ name: "Heading", text: "Section" }, { use: "row" }, { use: "row", name: "Row 2" }] },
    };
    const r = await api.applyWrites([{ op: "createTree", tree: { name: "Settings", fragments, layout: { display: "flex", flexDirection: "column" }, children: [
      { use: "row", handle: "name", edits: { Label: { text: "Name" }, Value: { text: "Jane", fills: null } } },
      { use: "row", edits: { Label: { text: "Email" } } },
      { use: "section", name: "Account", edits: { Heading: { text: "ACCOUNT" } } },
    ] } }]);
    const root = alive().find((n) => n.id === r.applied[0]?.id);
    const [nameRow, emailRow, account] = kids(root);
    const texts = (n: FakeNode | undefined): string => JSON.stringify(all(n).filter((x) => x.type === "TEXT").map((x) => x.characters));
    ok("[FRAG] each use is a whole copy of the fragment, counted like built nodes; the handle's id comes back",
      r.ok === true && JSON.stringify(r.applied[0]?.created) === JSON.stringify({ frames: 6, texts: 9 }) && r.applied[0]?.handles?.name === nameRow?.id);
    ok("[FRAG] edits change the named layers of one use only; a null drops the field (the value is Figma's default again)",
      texts(nameRow) === JSON.stringify(["Name", "Jane"]) && texts(emailRow) === JSON.stringify(["Email", "Value"])
      && JSON.stringify(kids(nameRow)[1]?.fills) !== JSON.stringify(kids(emailRow)[1]?.fills));
    ok("[FRAG] a fragment can use another; its own fields override the fragment's root",
      account?.name === "Account" && texts(account) === JSON.stringify(["ACCOUNT", "Label", "Value", "Label", "Value"]) && kids(account)[2]?.name === "Row 2");
    ok("[FRAG] an unused fragment is a warning", JSON.stringify((await api.applyWrites([{ op: "createTree", tree: { fragments: { spare: { name: "x" } } } }])).warnings)
      === JSON.stringify(["ops[0].tree.fragments[\"spare\"]: no node uses it, so it is not built"]));
    const count = alive().length;
    const bad = await api.applyWrites([{ op: "createFrame", name: "never" }, { op: "createTree", tree: { fragments: { ...fragments, loop: { use: "loop2" }, loop2: { children: [{ use: "loop" }] } }, children: [
      { use: "rwo" },
      { use: "row", edits: { Lable: { text: "x" }, Value: { use: "section" } }, children: [] },
      { use: "loop" },
      { name: "Inner", fragments: {} },
    ] } }]);
    ok("[FRAG] every problem of the uses refuses the whole batch, at once: an unknown fragment (closest), an unknown layer, a loop, children on a use, fragments below the root",
      bad.ok === false && bad.applied.length === 0 && alive().length === count && [
        /tree\.children\[0\]\.use: no fragment 'rwo'; closest: 'row'/,
        /tree\.children\[1\]\.edits\["Lable"\]: no layer of fragment 'row' has that name; closest: 'Label'/,
        /tree\.children\[1\]\.edits\["Value"\]\.use: an edit changes a layer's fields; `use` cannot be edited/,
        /tree\.children\[1\]\.children: a fragment's layers come from the fragment/,
        /fragment 'loop' uses itself \('loop' → 'loop2' → 'loop'\)/,
        /tree\.children\[3\]\.fragments: fragments are defined once, on the spec's root/,
      ].every((re) => re.test(bad.error ?? "")));
    const inside = checkTree({ fragments: { row: { layout: { display: "flex" }, children: [{ name: "Label", text: 5 }] } }, children: [{ text: "x" }, { use: "row" }] }).problems;
    ok("[FRAG] a problem inside a fragment is named below the node that uses it", JSON.stringify(inside) === JSON.stringify(["tree.children[1] (fragment 'row').children[0].text must be a string", "tree.children[1] (fragment 'row').children[0]: a TEXT node needs `text`"]));
    const dup = checkTree({ fragments: { tag: { text: "x", handle: "t" } }, children: [{ use: "tag" }, { use: "tag" }] }).problems;
    ok("[FRAG] a handle inside a fragment used twice names two nodes: refused", dup.some((p) => /handle 't' is used twice/.test(p)));
    // A fragment of fragments multiplies: refused while it is expanded, not after.
    const doubling: Record<string, unknown> = { f0: { text: "leaf" } };
    for (let i = 1; i <= 12; i++) doubling["f" + i] = { children: [{ use: "f" + (i - 1) }, { use: "f" + (i - 1) }] };
    ok("[FRAG] a spec that expands past the node cap is refused", checkTree({ fragments: doubling, children: [{ use: "f12" }] }).problems.some((p) => /more than 500 nodes once its fragments and rows are expanded/.test(p)));

    // A keyed spec built from fragments re-sends like a spelled-out one: unchanged, then one edit changes one text.
    const keyed = (v: string): Record<string, unknown> => ({ key: "frag", fragments, layout: { display: "flex", flexDirection: "column" }, children: [{ use: "row", edits: { Label: { text: v } } }, { use: "row" }] });
    const k1 = await api.applyWrites([{ op: "createTree", tree: keyed("One") }]);
    const k2 = await api.applyWrites([{ op: "createTree", tree: keyed("One") }]);
    const k3 = await api.applyWrites([{ op: "createTree", tree: keyed("Two") }]);
    ok("[FRAG] a keyed spec with fragments: sent again unchanged, then updated in place with only the edit that changed",
      k1.ok && k2.applied[0]?.unchanged === true && k3.applied[0]?.id === k1.applied[0]?.id && k3.applied[0]?.changed?.length === 1 && JSON.stringify(k3.applied[0]?.changed?.[0]?.fields) === JSON.stringify(["text"]));
  },
}];
