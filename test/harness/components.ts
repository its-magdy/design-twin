// Components from a tree spec (figma-plugin/src/component-build.ts, bridge/src/component-spec.ts): a COMPONENT root makes
// a main component, a COMPONENT_SET root a set of variants from a table, `props` on the root declares TEXT, BOOLEAN and
// INSTANCE_SWAP properties and `propRefs` wires the layers inside to them. A component's name is its key: the next call
// uses it by name, and the same name sent again updates it in place (ids kept, so instances follow). All or nothing, one
// undo step. Names are the agent's: "__proto__", "constructor", "toString" and "hasOwnProperty" are ordinary names here.
import { writeOpPreview, type WriteImpactReply, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { checkTree } from "../../bridge/src/tree-check.ts";
import { ok } from "../assert.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

type W = Awaited<ReturnType<typeof treeWorld>>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const kids = (n: FakeNode | undefined): readonly FakeNode[] => n?.children ?? [];
// A deep copy of each op: the plugin is handed plain data, as the bridge hands it.
const write = (w: W, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...(JSON.parse(JSON.stringify(o)) as WriteOp) })));
const named = (w: W, type: string, name: string): FakeNode[] => w.alive().filter((n) => n.type === type && n.name === name);
const one = (w: W, type: string, name: string): FakeNode | undefined => named(w, type, name)[0];
const child = (n: FakeNode | undefined, name: string): FakeNode | undefined => kids(n).find((k) => k.name === name);
const defsOf = (n: FakeNode | undefined): Record<string, { type: string; defaultValue: unknown; preferredValues?: unknown; variantOptions?: string[] }> =>
  (isObj(n) && isObj(n.componentPropertyDefinitions) ? n.componentPropertyDefinitions : {}) as Record<string, { type: string; defaultValue: unknown; preferredValues?: unknown; variantOptions?: string[] }>;
const refsOf = (n: FakeNode | undefined): Record<string, unknown> => (isObj(n) && isObj(n.componentPropertyReferences) ? n.componentPropertyReferences : {});
const rowOf = (r: WriteResult, i = 0): Record<string, unknown> => { const a: unknown = r.applied[i]; return isObj(a) ? a : {}; };
const keyOf = (defs: Record<string, unknown>, name: string): string | undefined => Object.keys(defs).find((k) => k.slice(0, k.lastIndexOf("#")) === name);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isImpact = (v: unknown): v is WriteImpactReply => isObj(v) && Array.isArray(v.steps);
async function impact(w: W, ops: WriteOp[]): Promise<WriteImpactReply | null> {
  const posted = await w.send({ type: "bridge", id: "imp", cmd: "writeImpact", args: { ops } });
  const r = posted.find((m) => m.type === "bridge-result" && m.id === "imp");
  const result: unknown = r && r.ok ? r.result : null;
  return isImpact(result) ? result : null;
}

// ---- the kit the cases build: two icons, a Button set (Size × State; Label text, Show icon boolean, Icon swap), a Card
const icon = (name: string, color = "#111111"): WriteOp => ({ op: "createTree", tree: { type: "COMPONENT", name, box: { w: 16, h: 16 }, children: [{ name: "Glyph", box: { w: 16, h: 16 }, fills: [{ type: "solid", color }] }] } });
const buttonSpec = (): Record<string, unknown> => ({
  type: "COMPONENT_SET", name: "Button",
  props: {
    Label: { type: "TEXT", default: "Button" },
    "Show icon": { type: "BOOLEAN", default: false },
    Icon: { type: "INSTANCE_SWAP", default: "Icon/Plus", preferredValues: ["Icon/Plus", "Icon/Minus"] },
  },
  variant: {
    layout: { display: "flex", padding: [8, 16, 8, 16], gap: 8, alignItems: "center" }, widthMode: "hug", heightMode: "hug", radius: 8, fills: [{ type: "solid", color: "#3355ff" }],
    children: [
      { component: "Icon/Plus", name: "Icon", propRefs: { visible: "Show icon", mainComponent: "Icon" } },
      { name: "Label", text: "Button", font: { color: "#ffffff" }, propRefs: { characters: "Label" } },
    ],
  },
  columns: ["Size", "State"],
  rows: [["md", "default"], ["md", "hover", { fills: [{ type: "solid", color: "#2244ee" }] }], ["sm", "default", { edits: { Label: { font: { size: 11, color: "#ffffff" } } } }]],
});
const button = (spec: Record<string, unknown> = buttonSpec()): WriteOp => ({ op: "createTree", tree: spec });
const card: WriteOp = { op: "createTree", tree: { type: "COMPONENT", name: "Card", box: { w: 320, h: 200 }, layout: { display: "flex", flexDirection: "column", gap: 8, padding: [16, 16, 16, 16] }, radius: 12,
  props: { Title: { type: "TEXT", default: "Title" } },
  children: [{ name: "Title", text: "Title", font: { size: 18, weight: "Bold" }, propRefs: { characters: "Title" } }, { name: "Body", text: "Body copy", widthMode: "fill" }] } };
/** A world with the two icons made (one call), then `ops` (another). */
async function kitWorld(ops: WriteOp[] = [], opts: Parameters<typeof treeWorld>[0] = {}): Promise<{ w: W; r: WriteResult }> {
  const w = await treeWorld(opts);
  const icons = await write(w, [icon("Icon/Plus"), icon("Icon/Minus", "#999999")]);
  if (!icons.ok) throw new Error("the icons did not land: " + String(icons.error));
  const r = ops.length ? await write(w, ops) : icons;
  return { w, r };
}
const screen = (props: Record<string, unknown>): WriteOp => ({ op: "createTree", tree: { name: "Screen", box: { w: 390, h: 844 }, layout: { display: "flex", flexDirection: "column", gap: 12 }, children: [{ component: "Button", handle: "cta", props }, { component: "Card", handle: "card", props: { Title: "Hello" } }] } });
const refusal = (r: WriteResult): string => (r.ok ? "" : String(r.error));

export const cases: Case[] = [
  {
    name: "a COMPONENT root makes a main component: frame fields apply, stamped with its name, placed beside the frames",
    async run() {
      const { w, r } = await kitWorld([card]);
      const c = one(w, "COMPONENT", "Card");
      const row = rowOf(r);
      ok("[COMPONENTS] the reply names the component and its property", r.ok && row.component === "Card" && row.id === c?.id && isObj(row.props) && typeof row.props.Title === "string" && same(row.created, { frames: 0, texts: 2 }));
      ok("[COMPONENTS] it is a COMPONENT on the current page, shown, with the frame's fields", c?.type === "COMPONENT" && isObj(c.parent) && c.parent.type === "PAGE" && c.visible === true &&
        c.layoutMode === "VERTICAL" && c.itemSpacing === 8 && c.cornerRadius === 12 && c.width === 320 && c.height === 200);
      ok("[COMPONENTS] its layers are built and its Title text wired to the Title property", kids(c).length === 2 && refsOf(child(c, "Title")).characters === (isObj(row.props) ? row.props.Title : null));
      ok("[COMPONENTS] the definition holds its default", defsOf(c)[String(isObj(row.props) ? row.props.Title : "")]?.defaultValue === "Title");
      ok("[COMPONENTS] stamped with its name as key (a re-send finds it)", typeof c?.getPluginData === "function" && (c.getPluginData as (k: string) => string)("dtwin.key") === "dtwin/component:Card");
      ok("[COMPONENTS] placed right of the existing frames", typeof c?.x === "number" && c.x >= 890);
      ok("[COMPONENTS] one undo step per batch (commitUndo before and after)", w.undo.commits === 4);
    },
  },
  {
    name: "a variant table arrives as one set: names, options in row order, the first row the default variant, per-row fields and edits",
    async run() {
      const { w, r } = await kitWorld([button()]);
      const set = one(w, "COMPONENT_SET", "Button");
      const names = kids(set).map((k) => k.name);
      ok("[COMPONENTS] one set, three COMPONENT variants named as Figma names them", r.ok && set !== undefined && kids(set).every((k) => k.type === "COMPONENT") &&
        same(names, ["Size=md, State=default", "Size=md, State=hover", "Size=sm, State=default"]));
      const defs = defsOf(set);
      ok("[COMPONENTS] VARIANT options come from the rows in order; the first row is the default", same(defs.Size?.variantOptions, ["md", "sm"]) && same(defs.State?.variantOptions, ["default", "hover"]) &&
        isObj(set) && isObj(set.defaultVariant) && set.defaultVariant.name === "Size=md, State=default");
      const hover = child(set, "Size=md, State=hover");
      const sm = child(set, "Size=sm, State=default");
      const firstFill = (n: FakeNode | undefined): unknown => (Array.isArray(n?.fills) ? (n.fills as unknown[])[0] : undefined);
      ok("[COMPONENTS] a row's own fields land on its variant only", same(firstFill(hover), { type: "SOLID", color: { r: 0x22 / 255, g: 0x44 / 255, b: 0xee / 255 } }) &&
        same(firstFill(child(set, "Size=md, State=default")), { type: "SOLID", color: { r: 0x33 / 255, g: 0x55 / 255, b: 1 } }));
      ok("[COMPONENTS] a row's edits change the named layer of its variant only", child(sm, "Label")?.fontSize === 11 && child(hover, "Label")?.fontSize !== 11);
      ok("[COMPONENTS] the reply counts the variants", isObj(rowOf(r).created) && (rowOf(r).created as Record<string, unknown>).variants === 3);
      const ys = kids(set).map((k) => Number(k.y));
      ok("[COMPONENTS] a set without auto-layout lays its variants out in a column and holds them", ys[0] !== undefined && ys.every((y, i) => i === 0 || y > (ys[i - 1] ?? 0)) && Number(set?.height) > Math.max(...ys));
    },
  },
  {
    name: "text, boolean and instance-swap properties are declared on the set and wired to the right layers of every variant",
    async run() {
      const { w, r } = await kitWorld([button()]);
      const set = one(w, "COMPONENT_SET", "Button");
      const props = rowOf(r).props;
      const defs = defsOf(set);
      const k = (n: string): string => (isObj(props) && typeof props[n] === "string" ? String(props[n]) : "?");
      ok("[COMPONENTS] the reply gives each property's real key", isObj(props) && Object.keys(props).length === 3 && k("Label").startsWith("Label#") && k("Show icon").startsWith("Show icon#") && k("Icon").startsWith("Icon#"));
      const plus = one(w, "COMPONENT", "Icon/Plus");
      const minus = one(w, "COMPONENT", "Icon/Minus");
      ok("[COMPONENTS] the definitions: types, defaults, the swap's default as the icon's id and its suggestions", defs[k("Label")]?.type === "TEXT" && defs[k("Label")]?.defaultValue === "Button" &&
        defs[k("Show icon")]?.type === "BOOLEAN" && defs[k("Show icon")]?.defaultValue === false && defs[k("Icon")]?.type === "INSTANCE_SWAP" && defs[k("Icon")]?.defaultValue === plus?.id &&
        same(defs[k("Icon")]?.preferredValues, [{ type: "COMPONENT", key: plus?.key }, { type: "COMPONENT", key: minus?.key }]));
      const wired = kids(set).every((v) => refsOf(child(v, "Label")).characters === k("Label") && refsOf(child(v, "Icon")).visible === k("Show icon") && refsOf(child(v, "Icon")).mainComponent === k("Icon"));
      ok("[COMPONENTS] in every variant: Label's text, Icon's visibility and Icon's component follow their properties", wired && kids(set).length === 3);
      ok("[COMPONENTS] the variants themselves carry no property definitions (a variant's throw)", (() => { try { const d: unknown = kids(set)[0]?.componentPropertyDefinitions; return d === undefined; } catch { return true; } })());
    },
  },
  {
    name: "the next call uses the components by name: a variant, its text and boolean, a swap to another icon by name",
    async run() {
      const { w } = await kitWorld([button(), card]);
      const r = await write(w, [screen({ Size: "sm", Label: "Continue", "Show icon": true, Icon: "Icon/Minus" })]);
      const handles = isObj(rowOf(r).handles) ? rowOf(r).handles as Record<string, string> : {};
      const cta = w.scene.nodes[String(handles.cta)];
      const props = isObj(cta?.props) ? cta.props : {};
      const set = one(w, "COMPONENT_SET", "Button");
      const keys = Object.keys(defsOf(set));
      const by = (n: string): unknown => props[keys.find((x) => x.startsWith(n + "#")) ?? "?"];
      ok("[COMPONENTS] the screen lands with both instances", r.ok && cta?.type === "INSTANCE" && w.scene.nodes[String(handles.card)]?.type === "INSTANCE");
      ok("[COMPONENTS] the instance shows the sm variant", isObj(cta?.mainComponent) && cta.mainComponent.name === "Size=sm, State=default");
      ok("[COMPONENTS] its text and boolean are set by their keys, the swap to Icon/Minus's id", by("Label") === "Continue" && by("Show icon") === true && by("Icon") === one(w, "COMPONENT", "Icon/Minus")?.id);
      const bad = await write(w, [screen({ Icon: "Icon/Nothing" })]);
      ok("[COMPONENTS] a swap to a component the file does not have is refused", !bad.ok && refusal(bad).includes("swaps to a component") && refusal(bad).includes("Icon/Nothing"));
      const flag = await write(w, [screen({ Icon: true })]);
      ok("[COMPONENTS] a swap value that is not a component is refused", !flag.ok && refusal(flag).includes("give a component"));
    },
  },
  {
    name: "sending the same component again: unchanged, changed in place with ids kept, and an instance follows",
    async run() {
      const { w } = await kitWorld([button()]);
      await write(w, [{ op: "createTree", tree: { name: "Screen", children: [{ component: "Button", handle: "cta", props: { Label: "Go" } }] } }]);
      const set = one(w, "COMPONENT_SET", "Button");
      const ids = kids(set).map((k) => k.id);
      const inst = w.alive().find((n) => n.type === "INSTANCE" && isObj(n.parent) && n.parent.name === "Screen");
      const again = await write(w, [button()]);
      ok("[COMPONENTS] the same spec again changes nothing and says so", again.ok && rowOf(again).unchanged === true && rowOf(again).component === "Button" && rowOf(again).id === set?.id && rowOf(again).key === undefined);
      const spec = buttonSpec();
      (spec.rows as unknown[])[0] = ["md", "default", { radius: 20 }];
      const changed = await write(w, [button(spec)]);
      const first = child(set, "Size=md, State=default");
      ok("[COMPONENTS] a changed row updates its variant in place (only what changed is in the reply)", changed.ok && Array.isArray(rowOf(changed).changed) && (rowOf(changed).changed as Array<{ id: string; fields: string[] }>).length === 1 &&
        (rowOf(changed).changed as Array<{ id: string; fields: string[] }>)[0]?.id === first?.id && first?.cornerRadius === 20);
      ok("[COMPONENTS] every id stays, so the instance still shows the same main component", same(kids(set).map((k) => k.id), ids) && isObj(inst?.mainComponent) && inst.mainComponent.id === ids[0] && one(w, "COMPONENT_SET", "Button") === set);
      ok("[COMPONENTS] one Button in the file", named(w, "COMPONENT_SET", "Button").length === 1);
    },
  },
  {
    name: "a re-send adds a row as a new variant and drops a row's variant; adds a property and deletes a dropped one; the instance follows",
    async run() {
      const { w } = await kitWorld([button()]);
      await write(w, [{ op: "createTree", tree: { name: "Screen", children: [{ component: "Button", props: { Label: "Go", "Show icon": true } }] } }]);
      const set = one(w, "COMPONENT_SET", "Button");
      const inst = w.alive().find((n) => n.type === "INSTANCE" && isObj(n.parent) && n.parent.name === "Screen");
      const spec = buttonSpec();
      spec.rows = [["md", "default"], ["md", "hover", { fills: [{ type: "solid", color: "#2244ee" }] }], ["lg", "default"]];
      const props = spec.props as Record<string, unknown>;
      delete props["Show icon"];
      props.Hint = { type: "TEXT", default: "Optional" };
      const base = spec.variant as { children: Array<Record<string, unknown>> };
      base.children = [{ component: "Icon/Plus", name: "Icon", propRefs: { mainComponent: "Icon" } }, { name: "Label", text: "Button", font: { color: "#ffffff" }, propRefs: { characters: "Label" } }, { name: "Hint", text: "Optional", propRefs: { characters: "Hint" } }];
      const ids = kids(set).map((k) => k.id);
      const r = await write(w, [button(spec)]);
      const row = rowOf(r);
      ok("[COMPONENTS] the reply: built (a Hint per variant, and sm's Label anew: its font edit is gone), the renamed variant, the new property's key, the dropped one", r.ok && isObj(row.props) && typeof row.props.Hint === "string" && same(row.propsRemoved, ["Show icon"]) && row.removed === 1 && same(row.created, { frames: 0, texts: 4 }) &&
        Array.isArray(row.changed) && same((row.changed as Array<{ id: string; fields: string[] }>).map((c) => c.fields), [["name"]]));
      ok("[COMPONENTS] the set holds md/default, md/hover and lg/default: sm/default, its value changed, renamed in place (same ids)", same(kids(set).map((k) => k.name), ["Size=md, State=default", "Size=md, State=hover", "Size=lg, State=default"]) && same(kids(set).map((k) => k.id), ids));
      const defs = defsOf(set);
      ok("[COMPONENTS] Show icon is deleted, Hint declared; the options follow the variants", keyOf(defs, "Show icon") === undefined && keyOf(defs, "Hint") !== undefined && same(defs.Size?.variantOptions, ["md", "lg"]));
      const hintKey = keyOf(defs, "Hint");
      ok("[COMPONENTS] every variant's Hint text is wired to it; the kept Icon lost its visibility wiring", kids(set).every((v) => refsOf(child(v, "Hint")).characters === hintKey && refsOf(child(v, "Icon")).visible === undefined));
      const shows = isObj(inst?.componentProperties) ? inst.componentProperties : {};
      ok("[COMPONENTS] the instance follows: it has Hint now and no Show icon", hintKey !== undefined && isObj(shows[hintKey]) && !Object.keys(shows).some((k) => k.startsWith("Show icon#")) && isObj(inst?.mainComponent) && inst.mainComponent.name === "Size=md, State=default");
      const again = await write(w, [button(spec)]);
      ok("[COMPONENTS] sent once more, the new spec is unchanged", again.ok && rowOf(again).unchanged === true);
    },
  },
  {
    name: "a re-send that changes a default or a swap's suggestions edits the definition; a type change is refused",
    async run() {
      const { w } = await kitWorld([button()]);
      const set = one(w, "COMPONENT_SET", "Button");
      const spec = buttonSpec();
      const props = spec.props as Record<string, Record<string, unknown>>;
      if (props.Label) props.Label.default = "Click";
      if (props.Icon) { props.Icon.default = "Icon/Minus"; props.Icon.preferredValues = ["Icon/Minus"]; }
      const label = (spec.variant as { children: Array<Record<string, unknown>> }).children[1];
      if (label) label.text = "Click"; // a wired text shows its property's default
      const r = await write(w, [button(spec)]);
      const defs = defsOf(set);
      ok("[COMPONENTS] the wired Label text of every variant follows the new default (the patch never writes the bound field: Figma refuses it)", r.ok && kids(set).every((v) => child(v, "Label")?.characters === "Click" && refsOf(child(v, "Label")).characters === keyOf(defs, "Label")));
      const stale = buttonSpec();
      (stale.props as Record<string, Record<string, unknown>>).Label = { type: "TEXT", default: "Go" };
      const refused = await write(w, [button(stale)]);
      ok("[COMPONENTS] a wired text that differs from its property's default is refused at its path", !refused.ok && refusal(refused).includes(".children[1]: `text` \"Button\" differs from the default of 'Label' (\"Go\")") && refusal(refused).includes("change the property's default instead"));
      ok("[COMPONENTS] both definitions are edited in place (same keys)", r.ok && isObj(rowOf(r).props) && Object.keys(rowOf(r).props as object).length === 2 &&
        defs[String(keyOf(defs, "Label"))]?.defaultValue === "Click" && defs[String(keyOf(defs, "Icon"))]?.defaultValue === one(w, "COMPONENT", "Icon/Minus")?.id &&
        same(defs[String(keyOf(defs, "Icon"))]?.preferredValues, [{ type: "COMPONENT", key: one(w, "COMPONENT", "Icon/Minus")?.key }]));
      const typed = buttonSpec();
      (typed.props as Record<string, unknown>).Label = { type: "BOOLEAN", default: true };
      const base = typed.variant as { children: Array<Record<string, unknown>> };
      base.children = [{ component: "Icon/Plus", name: "Icon", propRefs: { visible: "Label" } }, { name: "Label", text: "Button" }];
      const bad = await write(w, [button(typed)]);
      ok("[COMPONENTS] changing a property's type is refused with the way out", !bad.ok && refusal(bad).includes("its type cannot change in place") && defs[String(keyOf(defsOf(set), "Label"))]?.type === "TEXT");
    },
  },
  {
    name: "a component the designer made, two of one name, or a single component sent as a set: refused before anything runs",
    async run() {
      const { w } = await kitWorld([], { kit: true });
      const before = w.alive().length;
      const hand = await write(w, [{ op: "createFrame", name: "never" }, { op: "createTree", tree: { type: "COMPONENT", name: "Badge" } }]);
      ok("[COMPONENTS] a hand-made component of the name is refused, pointing at a source edit", !hand.ok && hand.failedAt === 1 && refusal(hand).includes("a component named 'Badge' exists") && refusal(hand).includes("patch it (a source edit") && w.alive().length === before);
      const twice = await write(w, [{ op: "createTree", tree: { type: "COMPONENT", name: "Card" } }]);
      ok("[COMPONENTS] a name two components have is refused as ambiguous", !twice.ok && refusal(twice).includes("matches 2 components"));
      await write(w, [icon("Icon/Star")]);
      const swap = await write(w, [{ op: "createTree", tree: { type: "COMPONENT_SET", name: "Icon/Star", variant: {}, columns: ["Kind"], rows: [["a"]] } }]);
      ok("[COMPONENTS] a single component cannot become a set under the same name", !swap.ok && refusal(swap).includes("cannot turn one into the other"));
      const dup = await write(w, [icon("Icon/Dot"), icon("Icon/Dot")]);
      ok("[COMPONENTS] two ops of one batch making the same component are refused", !dup.ok && refusal(dup).includes("one batch makes or updates a component once") && named(w, "COMPONENT", "Icon/Dot").length === 0);
    },
  },
  {
    name: "a spec of the same batch cannot use a component the batch makes: refused with 'create it in an earlier call'",
    async run() {
      const w = await treeWorld();
      const before = w.alive().length;
      const r = await write(w, [icon("Icon/Plus"), { op: "createTree", tree: { name: "Screen", children: [{ component: "Icon/Plus" }] } }]);
      ok("[COMPONENTS] refused with the hint, nothing made", !r.ok && refusal(r).includes("create it in an earlier call") && refusal(r).includes("ops[0]") && w.alive().length === before);
      const swap = await write(w, [icon("Icon/Plus"), button()]);
      ok("[COMPONENTS] the same for a swap default naming it", !swap.ok && refusal(swap).includes("create it in an earlier call"));
      const made = await write(w, [icon("Icon/Plus")]);
      const kept = w.alive().length;
      const upd = await write(w, [icon("Icon/Plus"), { op: "createTree", tree: { name: "Screen", children: [{ component: "Icon/Plus" }] } }]);
      ok("[COMPONENTS] a component the same batch updates is refused too, nothing made", made.ok && !upd.ok && refusal(upd).includes("ops[0] of this batch updates") && refusal(upd).includes("use it in a later call") && w.alive().length === kept);
      // A swap default or suggestion may name a standalone component the batch updates (its id and key stay); a
      // variant of a set the batch updates may not.
      const chip = (prefer: string[]): WriteOp => ({ op: "createTree", tree: { type: "COMPONENT", name: "Chip", props: { Icon: { type: "INSTANCE_SWAP", default: "Icon/Minus", preferredValues: prefer } }, children: [{ component: "Icon/Minus", name: "Icon", propRefs: { mainComponent: "Icon" } }] } });
      const minus = await write(w, [icon("Icon/Minus")]);
      const chipMade = minus.ok ? await write(w, [chip(["Icon/Minus"])]) : minus;
      const both = await write(w, [icon("Icon/Plus", "#222222"), chip(["Icon/Minus", "Icon/Plus", "Chip"])]);
      ok("[COMPONENTS] a re-send may suggest components the same batch updates (itself too)", chipMade.ok && both.ok);
      // A copy's swap value resolves with the batch's components known: a variant of a set the batch updates is refused.
      const set = await write(w, [button()]);
      const host = set.ok ? await write(w, [{ op: "createTree", tree: { name: "Host", children: [{ component: "Button", name: "B", props: { Size: "md", State: "default" } }] } }]) : set;
      const hostId = host.ok ? String(rowOf(host).id) : "";
      const sm = named(w, "COMPONENT", "Size=sm, State=default")[0];
      const before2 = w.alive().length;
      const cloned = await write(w, [button(), { op: "createTree", tree: { clone: hostId, edits: { B: { props: { Icon: sm ? sm.id : "" } } } } }]);
      ok("[COMPONENTS] a copy's swap value naming a variant of a set the batch updates is refused, nothing made", host.ok && !!sm && !cloned.ok && refusal(cloned).includes("of this batch updates") && w.alive().length === before2);
    },
  },
  {
    name: "a failure mid-apply puts everything back: a new set, a re-send's added property and wiring, an earlier op",
    async run() {
      const { w } = await kitWorld();
      const before = w.alive().length;
      w.trap.add("componentPropertyReferences");
      const r = await write(w, [{ op: "createTree", tree: { name: "Earlier", box: { w: 10, h: 10 } } }, button()]);
      ok("[COMPONENTS] the build fails while wiring, and nothing it or the earlier op made stays", !r.ok && r.failedAt === 1 && w.alive().length === before && named(w, "COMPONENT_SET", "Button").length === 0 && named(w, "FRAME", "Earlier").length === 0);
      w.trap.delete("componentPropertyReferences");
      // A swap property with no suggestions (Glyph): a re-send that adds some and fails must leave it with none.
      const first = buttonSpec();
      (first.props as Record<string, unknown>).Glyph = { type: "INSTANCE_SWAP", default: "Icon/Plus" };
      const made = await write(w, [button(first)]);
      const set = one(w, "COMPONENT_SET", "Button");
      const defsBefore = JSON.stringify(defsOf(set));
      const wiredBefore = JSON.stringify(kids(set).map((v) => kids(v).map(refsOf)));
      const textsBefore = JSON.stringify(kids(set).map((v) => child(v, "Label")?.characters));
      const spec = buttonSpec();
      (spec.props as Record<string, unknown>).Hint = { type: "TEXT", default: "Optional" };
      (spec.props as Record<string, unknown>).Glyph = { type: "INSTANCE_SWAP", default: "Icon/Plus", preferredValues: ["Icon/Minus"] };
      (spec.props as Record<string, Record<string, unknown>>).Label = { type: "TEXT", default: "Changed" };
      const base = (spec.variant as { children: Array<Record<string, unknown>> }).children;
      if (base[1]) base[1].text = "Changed";
      base.push({ name: "Hint", text: "Optional", propRefs: { characters: "Hint" } });
      w.trap.add("componentPropertyReferences");
      const bad = await write(w, [button(spec)]);
      w.trap.delete("componentPropertyReferences");
      ok("[COMPONENTS] a re-send that fails is put back: the definitions, the wiring and the layers as they were", made.ok && !bad.ok && JSON.stringify(defsOf(set)) === defsBefore &&
        JSON.stringify(kids(set).map((v) => kids(v).map(refsOf))) === wiredBefore && kids(set).every((v) => kids(v).length === 2) && Array.isArray(bad.restored) && bad.restored.length > 0);
      const glyph = defsOf(set)[String(keyOf(defsOf(set), "Glyph"))];
      ok("[COMPONENTS] …a swap that had no suggestions has none again (the restore clears the ones the edit added); the bound texts show the old default", same(glyph?.preferredValues, []) && JSON.stringify(kids(set).map((v) => child(v, "Label")?.characters)) === textsBefore);
    },
  },
  {
    name: "the dry run: what the spec makes, and the file's answer — would create, or would update in place with its instances",
    async run() {
      const preview = writeOpPreview(button(), 0);
      ok("[COMPONENTS] the preview describes the set, its variants and properties", preview.invalid === undefined && String(preview.change).includes("creates component set 'Button' of 3 variants") && String(preview.change).includes("'Label', 'Show icon', 'Icon'") && String(preview.change).includes("updated in place"));
      const { w } = await kitWorld();
      const fresh = await impact(w, [button()]);
      const s0 = fresh?.steps[0];
      ok("[COMPONENTS] a new name: would create", s0 !== undefined && s0.change === "would create component set 'Button'" && same(s0.plan, { create: ["component set 'Button'"], update: [] }));
      await write(w, [button()]);
      await write(w, [{ op: "createTree", tree: { name: "Screen", children: [{ component: "Button" }, { component: "Button", props: { Size: "sm" } }] } }]);
      const again = await impact(w, [button()]);
      const s1 = again?.steps[0];
      ok("[COMPONENTS] its own name again: would update in place, two instances follow", s1 !== undefined && s1.change === "would update component set 'Button' in place (2 instances follow)" && isObj(s1.affects) && s1.affects.instances === 2);
      const hand = await impact(w, [{ op: "createTree", tree: { type: "COMPONENT", name: "Icon/Plus", children: [] } }, { op: "createTree", tree: { type: "COMPONENT_SET", name: "Icon/Plus", variant: {}, columns: ["A"], rows: [["b"]] } }]);
      const same2 = await impact(w, [button(), { op: "createTree", tree: { type: "COMPONENT", name: "Host", props: { Pick: { type: "INSTANCE_SWAP", default: "Button" } }, children: [{ component: "Button", name: "Slot", propRefs: { mainComponent: "Pick" } }] } }]);
      const p1 = (same2 ? same2.steps : []).filter((x) => x.index === 1 && x.problem).map((x) => String(x.problem)).join(" | ");
      ok("[COMPONENTS] the dry run refuses a spec naming a component the same batch updates (an instance, a set as a swap default), as the write does", p1.includes("ops[0] of this batch updates") && p1.includes("default to it in a later call"));
      ok("[COMPONENTS] a kind change is the file's refusal", hand?.steps[1]?.problem?.includes("cannot turn one into the other") === true && hand.steps[0]?.change?.startsWith("would update") === true);
    },
  },
  {
    name: "property, variant, column and layer names that are Object.prototype's own are ordinary names; '__proto__' names no property or column",
    async run() {
      const w = await treeWorld();
      // Columns constructor / valueOf, variant values toString / hasOwnProperty / valueOf, layers __proto__ / constructor /
      // toString; properties toString, hasOwnProperty, isPrototypeOf.
      const odd = ["toString", "hasOwnProperty", "isPrototypeOf"];
      // From JSON text: in an object literal `__proto__` would set the prototype, not a key.
      const spec = JSON.parse(`{
        "type": "COMPONENT_SET", "name": "Odd",
        "props": { "toString": { "type": "TEXT", "default": "t" }, "hasOwnProperty": { "type": "TEXT", "default": "h" }, "isPrototypeOf": { "type": "BOOLEAN", "default": true } },
        "variant": { "children": [{ "name": "__proto__", "text": "t", "propRefs": { "characters": "toString" } }, { "name": "constructor", "text": "h", "propRefs": { "characters": "hasOwnProperty", "visible": "isPrototypeOf" } }, { "name": "toString", "text": "c" }] },
        "columns": ["constructor", "valueOf"],
        "rows": [["toString", "hasOwnProperty"], ["valueOf", "hasOwnProperty", { "edits": { "__proto__": { "opacity": 0.4 }, "constructor": { "opacity": 0.5 }, "toString": { "text": "edited" } } }]]
      }`) as Record<string, unknown>;
      const checked = checkTree(spec);
      ok("[COMPONENTS] the check accepts them", checked.problems.length === 0);
      const r = await write(w, [{ op: "createTree", tree: spec }]);
      const set = one(w, "COMPONENT_SET", "Odd");
      const props = rowOf(r).props;
      ok("[COMPONENTS] the properties come back by their own names", r.ok && isObj(props) && Object.keys(props).length === 3 && odd.every((n) => Object.prototype.hasOwnProperty.call(props, n) && typeof props[n] === "string" && String(props[n]).startsWith(n + "#")));
      ok("[COMPONENTS] the variants are named by the columns, and their options read back", same(kids(set).map((k) => k.name), ["constructor=toString, valueOf=hasOwnProperty", "constructor=valueOf, valueOf=hasOwnProperty"]) &&
        Object.prototype.hasOwnProperty.call(defsOf(set), "constructor") && same(defsOf(set)["valueOf"]?.variantOptions, ["hasOwnProperty"]));
      const second = kids(set)[1];
      ok("[COMPONENTS] the row's edits reached the layers named __proto__, constructor and toString", child(second, "__proto__")?.opacity === 0.4 && child(second, "constructor")?.opacity === 0.5 && child(second, "toString")?.characters === "edited" && child(kids(set)[0], "toString")?.characters === "c");
      const key = (n: string): unknown => (isObj(props) ? props[n] : undefined);
      ok("[COMPONENTS] each layer is wired to the property it names", refsOf(child(second, "__proto__")).characters === key("toString") && refsOf(child(second, "constructor")).visible === key("isPrototypeOf") && refsOf(child(second, "constructor")).characters === key("hasOwnProperty"));
      const again = await write(w, [{ op: "createTree", tree: spec }]);
      ok("[COMPONENTS] sent again: unchanged", again.ok && rowOf(again).unchanged === true);
      const use = await write(w, [{ op: "createTree", tree: JSON.parse('{"name":"S","children":[{"component":"Odd","handle":"i","props":{"constructor":"valueOf","toString":"x","isPrototypeOf":false}}]}') as Record<string, unknown> }]);
      const inst = w.scene.nodes[String(isObj(rowOf(use).handles) ? (rowOf(use).handles as Record<string, unknown>).i : "")];
      ok("[COMPONENTS] an instance sets them by name, its variant picked by the constructor column", use.ok && isObj(inst?.mainComponent) && inst.mainComponent.name === "constructor=valueOf, valueOf=hasOwnProperty" &&
        isObj(inst.props) && inst.props[String(key("toString"))] === "x" && inst.props[String(key("isPrototypeOf"))] === false);
      // "__proto__" is dropped by Figma's own main-thread → UI message copy, so it names no property and no column.
      const proto = checkTree(JSON.parse('{"type":"COMPONENT_SET","name":"P","props":{"__proto__":{"type":"TEXT","default":"x"}},"variant":{},"columns":["Size","__proto__"],"rows":[["a","b"]]}') as unknown).problems.join("\n");
      ok("[COMPONENTS] '__proto__' as a variant column is refused, with the reason", proto.includes("tree.columns[1]: '__proto__' cannot be a property name (Figma's message passing drops that key)"));
      const protoProp = checkTree(JSON.parse('{"type":"COMPONENT","name":"P","props":{"__proto__":{"type":"TEXT","default":"x"}}}') as unknown).problems.join("\n");
      ok("[COMPONENTS] '__proto__' as a property name is refused, with the reason", protoProp.includes("tree.props[\"__proto__\"]: '__proto__' cannot be a property name (Figma's message passing drops that key); pick another name"));
      // A column called "toString" that a variant's values do not hold as their own key (the designer renamed the
      // default variant to drop it): read as missing, never off the prototype, so the instance finds its variant.
      const sparse = await write(w, [{ op: "createTree", tree: { type: "COMPONENT_SET", name: "Sparse", variant: {}, columns: ["Size", "toString"], rows: [["a", "x"], ["b", "x"]] } }]);
      const first = kids(one(w, "COMPONENT_SET", "Sparse"))[0];
      if (first) first.name = "Size=a";
      const pick = await write(w, [{ op: "createTree", tree: { name: "S2", children: [{ component: "Sparse", handle: "p", props: { Size: "b" } }] } }]);
      const picked = w.scene.nodes[String(isObj(rowOf(pick).handles) ? (rowOf(pick).handles as Record<string, unknown>).p : "")];
      ok("[COMPONENTS] a column `toString` that is not a variant's own key is not read off the prototype", sparse.ok && pick.ok && isObj(picked?.mainComponent) && picked.mainComponent.name === "Size=b, toString=x");
    },
  },
  {
    name: "every refusal of a component spec, with its path, before the file is touched",
    async run() {
      const problems = (tree: unknown): string => checkTree(tree).problems.join("\n");
      const base = { children: [{ name: "Label", text: "x" }] };
      ok("[COMPONENTS] a component root placed from a fragment is refused (its name is its identity)", problems({ use: "kit", fragments: { kit: { type: "COMPONENT", name: "Icon", children: [] } } }).includes("a component is written at the root itself") &&
        problems({ use: "kit", type: "COMPONENT", name: "Icon", fragments: { kit: { children: [] } } }).includes("a component is written at the root itself"));
      ok("[COMPONENTS] COMPONENT below the root", problems({ name: "F", children: [{ type: "COMPONENT", name: "C" }] }).includes("tree.children[0]: `type: \"COMPONENT\"` is only on the spec's root"));
      ok("[COMPONENTS] a component needs a name", problems({ type: "COMPONENT" }).includes("a component needs a `name`"));
      ok("[COMPONENTS] a key on a component root", problems({ type: "COMPONENT", name: "C", key: "k" }).includes("a component's name is its key"));
      ok("[COMPONENTS] `component` other than its name", problems({ type: "COMPONENT", name: "C", component: "D" }).includes("only the read's echo") && problems({ type: "COMPONENT", name: "C", component: "C" }) === "");
      ok("[COMPONENTS] a reserved key on a frame", problems({ name: "F", key: "dtwin/component:C" }).includes("cannot start with 'dtwin/'"));
      ok("[COMPONENTS] propRefs outside a component", problems({ name: "F", children: [{ text: "x", propRefs: { characters: "A" } }] }).includes("tree.children[0]: `propRefs` wires a layer"));
      ok("[COMPONENTS] propRefs on the component itself", problems({ type: "COMPONENT", name: "C", props: { A: { type: "BOOLEAN", default: true } }, propRefs: { visible: "A" } }).includes("the component itself cannot be wired"));
      const c = (props: unknown, refs: unknown, extra: Record<string, unknown> = {}): string => problems({ type: "COMPONENT", name: "C", props, children: [{ name: "L", text: "x", propRefs: refs, ...extra }] });
      ok("[COMPONENTS] a ref to a property not declared, with the declared ones", c({ Label: { type: "TEXT", default: "" } }, { characters: "Lable" }).includes("names 'Lable', which the component does not declare") && c({ Label: { type: "TEXT", default: "" } }, { characters: "Lable" }).includes("closest: 'Label'"));
      ok("[COMPONENTS] a ref of the wrong type", c({ On: { type: "BOOLEAN", default: true } }, { characters: "On" }).includes("a BOOLEAN property; `characters` follows a TEXT property"));
      ok("[COMPONENTS] characters on a frame, mainComponent on a text", problems({ type: "COMPONENT", name: "C", props: { T: { type: "TEXT", default: "" } }, children: [{ name: "F", propRefs: { characters: "T" } }] }).includes("only a TEXT layer's text follows a property") &&
        c({ S: { type: "INSTANCE_SWAP", default: "Icon" } }, { mainComponent: "S" }).includes("only an INSTANCE swaps its component"));
      ok("[COMPONENTS] an unknown propRefs field", c({}, { text: "A" }).includes("not a field a property drives"));
      const unused = checkTree({ type: "COMPONENT", name: "C", props: { Spare: { type: "TEXT", default: "" } }, ...base });
      ok("[COMPONENTS] a declared property no layer uses is a warning, not a refusal", unused.problems.length === 0 && unused.summary.warnings.some((x) => x.startsWith("tree.props[\"Spare\"]: no layer uses it")));
      const d = (def: unknown): string => problems({ type: "COMPONENT", name: "C", props: { P: def }, ...base });
      ok("[COMPONENTS] definitions: VARIANT, SLOT, a bad type, a missing or wrong default, suggestions on a text, an unknown field", d({ type: "VARIANT" }).includes("comes from the variant table") && d({ type: "SLOT" }).includes("cannot be written yet") &&
        d({ type: "NUMBER", default: 1 }).includes("must be one of TEXT | BOOLEAN | INSTANCE_SWAP") && d({ type: "TEXT" }).includes("is missing default") && d({ type: "BOOLEAN", default: "yes" }).includes("default is true or false") &&
        d({ type: "TEXT", default: "", preferredValues: ["A"] }).includes("only an INSTANCE_SWAP property suggests") && d({ type: "TEXT", default: "", value: 1 }).includes("not a field of a property definition") && problems({ type: "COMPONENT", name: "C", props: { "A#1": { type: "TEXT", default: "" } } }).includes("cannot hold '#'"));
      const set = (over: Record<string, unknown>): string => problems({ type: "COMPONENT_SET", name: "B", variant: base, columns: ["Size"], rows: [["sm"], ["md"]], ...over });
      ok("[COMPONENTS] the table: no variant, no columns, a duplicate row, a missing or extra cell, '=' in a value, children on the set", set({ variant: undefined }).includes("tree.variant: must be the node spec") && set({ columns: [] }).includes("tree.columns: must be a non-empty list") &&
        set({ rows: [["sm"], ["sm"]] }).includes("tree.rows[1]: Size=sm is rows[0]'s combination too") && set({ rows: [[]] }).includes("tree.rows[0]: must be a list of 1 value") && set({ rows: [["a", "b"]] }).includes("tree.rows[0]: must be a list of 1 value") &&
        set({ rows: [["a=b"]] }).includes("tree.rows[0][0]: cannot hold '=' or ','") && set({ children: [] }).includes("tree.children: a component set's variants come from its table"));
      ok("[COMPONENTS] a row cannot rename its variant or declare props; the base has no name", set({ rows: [["sm", { name: "X" }]] }).includes("tree.rows[0].name: a row cannot change it") && set({ rows: [["sm", { props: {} }]] }).includes("tree.rows[0].props: a row cannot change it") &&
        set({ variant: { name: "V" } }).includes("tree.variant.name: a variant's name is its row's values"));
      ok("[COMPONENTS] a row's edit naming no layer of the base", set({ rows: [["sm", { edits: { Lable: { text: "y" } } }]] }).includes("tree.rows[0].edits[\"Lable\"]: no layer of the base `variant` has that name; closest: 'Label'"));
      ok("[COMPONENTS] a property named like a column", set({ props: { Size: { type: "TEXT", default: "" } } }).includes("is a column of the variant table"));
      ok("[COMPONENTS] a padded column, value or property name is refused (Figma trims them)", set({ columns: [" __proto__ "] }).includes("tree.columns[0]: a variant property's name cannot start or end with a space") &&
        set({ rows: [["sm"], [" sm "]] }).includes("tree.rows[1][0]: cannot start or end with a space") && problems({ type: "COMPONENT", name: "C", props: { " Label ": { type: "TEXT", default: "" } } }).includes("cannot be empty or start or end with a space"));
      ok("[COMPONENTS] a table on a COMPONENT root", problems({ type: "COMPONENT", name: "C", variant: {}, columns: ["A"], rows: [["b"]] }).includes("makes a COMPONENT_SET"));
      ok("[COMPONENTS] a problem inside a variant is named by its row", set({ rows: [["sm", { opacity: 3 }]] }).includes("tree.rows[0] (variant 'Size=sm').opacity must be a number from 0 to 1"));
      const w = await treeWorld();
      const r = await write(w, [{ op: "createTree", tree: { type: "COMPONENT", name: "C", props: { S: { type: "INSTANCE_SWAP", default: "Nowhere" } }, children: [{ component: "Nowhere", propRefs: { mainComponent: "S" } }] } }]);
      ok("[COMPONENTS] a swap default the file does not have is refused by the plugin, with its path", !r.ok && refusal(r).includes("tree.props: component 'Nowhere' matches no component"));
    },
  },
  {
    name: "a re-send pairs the variants (handle, exact name, then order): a value change, a column added, renamed or dropped renames them in place and instances follow",
    async run() {
      // Each scenario: the Button set, an instance of each variant, then the re-send.
      const setUp = async (): Promise<{ w: W; set: FakeNode | undefined; ids: string[]; insts: FakeNode[] }> => {
        const { w } = await kitWorld([button()]);
        await write(w, [{ op: "createTree", tree: { name: "Screen", children: [{ component: "Button", handle: "a" }, { component: "Button", handle: "b", props: { State: "hover" } }, { component: "Button", handle: "c", props: { Size: "sm" } }] } }]);
        const set = one(w, "COMPONENT_SET", "Button");
        const insts = w.alive().filter((n) => n.type === "INSTANCE" && isObj(n.parent) && n.parent.name === "Screen");
        return { w, set, ids: kids(set).map((k) => String(k.id)), insts };
      };
      const mains = (insts: readonly FakeNode[]): unknown[] => insts.map((i) => (isObj(i.mainComponent) ? i.mainComponent.id : null));
      const rowsWith = (f: (row: unknown[]) => unknown[]): Record<string, unknown> => { const s = buttonSpec(); s.rows = (s.rows as unknown[][]).map(f); return s; };

      const v = await setUp();
      const before = mains(v.insts);
      const valued = await write(v.w, [button(rowsWith((r) => (r[0] === "sm" ? ["lg", ...r.slice(1)] : r)))]);
      ok("[COMPONENTS] a value change (sm → lg) renames that variant in place: same id, and its instance follows", valued.ok && same(kids(v.set).map((k) => k.id), v.ids) && child(v.set, "Size=lg, State=default")?.id === v.ids[2] && same(mains(v.insts), before) &&
        (v.insts[2]?.mainComponent as FakeNode | undefined)?.name === "Size=lg, State=default");

      const c = await setUp();
      const added = buttonSpec();
      added.columns = ["Size", "State", "Tone"];
      added.rows = (added.rows as unknown[][]).map((r) => [r[0], r[1], "solid", ...r.slice(2)]);
      const addCol = await write(c.w, [button(added)]);
      ok("[COMPONENTS] a column added: no throw, every variant renamed in place (ids kept), the instances follow", addCol.ok && same(kids(c.set).map((k) => k.id), c.ids) &&
        same(kids(c.set).map((k) => k.name), ["Size=md, State=default, Tone=solid", "Size=md, State=hover, Tone=solid", "Size=sm, State=default, Tone=solid"]) && same(mains(c.insts), c.ids) &&
        same(defsOf(c.set).Tone?.variantOptions, ["solid"]) && rowOf(addCol).removed === undefined);

      const n = await setUp();
      const renamed = buttonSpec();
      renamed.columns = ["Scale", "State"];
      const renameCol = await write(n.w, [button(renamed)]);
      ok("[COMPONENTS] a column renamed: the variants keep their ids, the set's VARIANT property is the new name", renameCol.ok && same(kids(n.set).map((k) => k.id), n.ids) && kids(n.set)[0]?.name === "Scale=md, State=default" &&
        defsOf(n.set).Scale !== undefined && defsOf(n.set).Size === undefined && same(mains(n.insts), n.ids));

      const d = await setUp();
      const dropped = buttonSpec();
      dropped.columns = ["Size"];
      dropped.rows = [["md"], ["md-hover", { fills: [{ type: "solid", color: "#2244ee" }] }], ["sm", { edits: { Label: { font: { size: 11, color: "#ffffff" } } } }]];
      const dropCol = await write(d.w, [button(dropped)]);
      ok("[COMPONENTS] a column dropped (the combinations left unique): renamed in place, ids kept, the instances follow", dropCol.ok && same(kids(d.set).map((k) => k.id), d.ids) &&
        same(kids(d.set).map((k) => k.name), ["Size=md", "Size=md-hover", "Size=sm"]) && same(mains(d.insts), d.ids) && defsOf(d.set).State === undefined);

      const r = await setUp();
      const fewer = buttonSpec();
      fewer.rows = (fewer.rows as unknown[][]).slice(0, 2);
      const preview = await impact(r.w, [button(fewer)]);
      const warn = "removing variant 'Size=sm, State=default' of 'Button' leaves 1 instance without a main component";
      ok("[COMPONENTS] the dry run names the instances a dropped row leaves without a main", preview?.steps[0]?.change?.includes(warn) === true);
      const dropRow = await write(r.w, [button(fewer)]);
      ok("[COMPONENTS] a row dropped: its variant is removed (the others kept), and the reply warns how many instances lose their main", dropRow.ok && same(kids(r.set).map((k) => k.id), r.ids.slice(0, 2)) &&
        Array.isArray(dropRow.warnings) && dropRow.warnings.includes("ops[0]: " + warn));

      const h = await setUp();
      const handled = buttonSpec();
      handled.rows = [["md", "default", { handle: "primary" }], ["md", "hover"], ["sm", "default"]];
      const first = await write(h.w, [button(handled)]);
      ok("[COMPONENTS] a row's handle comes back with its variant's id", first.ok && isObj(rowOf(first).handles) && (rowOf(first).handles as Record<string, unknown>).primary === h.ids[0]);
      // The handle keeps md/default's node as it becomes lg/default, though a new md/default row now names it exactly.
      handled.rows = [["lg", "default", { handle: "primary" }], ["md", "hover"], ["sm", "default"], ["md", "default"]];
      const moved = await write(h.w, [button(handled)]);
      const lg = child(h.set, "Size=lg, State=default");
      const md = child(h.set, "Size=md, State=default");
      ok("[COMPONENTS] a handle pairs before the name: the handled variant is renamed in place, the new row is built beside it", moved.ok && lg?.id === h.ids[0] && md !== undefined && !h.ids.includes(String(md.id)) &&
        (h.insts[0]?.mainComponent as FakeNode | undefined)?.id === h.ids[0]);
      const twice = buttonSpec();
      twice.rows = [["md", "default", { handle: "x" }], ["md", "hover", { handle: "x" }]];
      ok("[COMPONENTS] a row's handle is checked like every handle: unique, never '__proto__'", checkTree(twice).problems.some((m) => m.includes("handle 'x' is used twice")) &&
        checkTree(JSON.parse('{"type":"COMPONENT_SET","name":"B","variant":{},"columns":["A"],"rows":[["a",{"handle":"__proto__"}]]}') as unknown).problems.some((m) => m.includes("'__proto__' cannot be a handle")));
      const baseHandle = buttonSpec();
      (baseHandle.variant as Record<string, unknown>).handle = "v";
      ok("[COMPONENTS] a handle on the base `variant` is refused (it would name every variant)", checkTree(baseHandle).problems.some((m) => m.includes("tree.variant.handle: a handle names one variant")));
    },
  },
  {
    name: "a wired field stays bound: text and hidden must equal the property's default; a re-send unwires, patches, then wires",
    async run() {
      const problems = (tree: unknown): string => checkTree(tree).problems.join("\n");
      const comp = (layer: Record<string, unknown>): Record<string, unknown> => ({ type: "COMPONENT", name: "C", props: { T: { type: "TEXT", default: "Hi" }, On: { type: "BOOLEAN", default: false } }, children: [layer] });
      ok("[COMPONENTS] a wired text other than its TEXT property's default is refused at its path", problems(comp({ name: "L", text: "Bye", propRefs: { characters: "T" } })).includes("tree.children[0]: `text` \"Bye\" differs from the default of 'T' (\"Hi\")") &&
        problems(comp({ name: "L", text: "Hi", propRefs: { characters: "T" } })) === "");
      ok("[COMPONENTS] a wired `hidden` other than !default is refused (and left out is fine)", problems(comp({ name: "L", text: "Hi", hidden: false, propRefs: { visible: "On" } })).includes("`hidden: false` differs from the default of 'On' (false)") &&
        problems(comp({ name: "L", text: "Hi", hidden: true, propRefs: { visible: "On" } })) === "" && problems(comp({ name: "L", text: "Hi", propRefs: { visible: "On" } })) === "");
      const setSpec = buttonSpec();
      setSpec.rows = [["md", "default", { edits: { Label: { text: "Other" } } }]];
      ok("[COMPONENTS] in a set the set's default is the one: a row's edit of a wired text is refused at its row", problems(setSpec).includes("tree.rows[0] (variant 'Size=md, State=default').children[1]: `text` \"Other\" differs from the default of 'Label'"));

      // A re-send that moves Label's text to a new property: unwired before the patch writes the text, wired after.
      const { w } = await kitWorld([button()]);
      const set = one(w, "COMPONENT_SET", "Button");
      const spec = buttonSpec();
      (spec.props as Record<string, unknown>).Caption = { type: "TEXT", default: "Caption" };
      const base = (spec.variant as { children: Array<Record<string, unknown>> }).children;
      if (base[1]) { base[1].text = "Caption"; base[1].propRefs = { characters: "Caption" }; }
      const r = await write(w, [button(spec)]);
      const caption = keyOf(defsOf(set), "Caption");
      ok("[COMPONENTS] rewired to a new property: the text is written while unwired, then bound to it", r.ok && caption !== undefined && kids(set).every((v) => child(v, "Label")?.characters === "Caption" && refsOf(child(v, "Label")).characters === caption));
      // The fake refuses a write to a bound field, as Figma does.
      const label = child(kids(set)[0], "Label");
      let threw = false;
      try { if (label) label.characters = "Direct"; } catch { threw = true; }
      ok("[COMPONENTS] (the fake, like Figma, refuses writing a bound text)", threw && label?.characters === "Caption");
    },
  },
  {
    name: "a failure while the dropped variants and properties are deleted: the reply names each already gone; rollback never points at a deleted property",
    async run() {
      const { w } = await kitWorld([button()]);
      const set = one(w, "COMPONENT_SET", "Button");
      const spec = buttonSpec();
      // Drop the sm row, and the Label and Show icon properties (deleted in that order: the second one fails).
      spec.rows = (spec.rows as unknown[][]).slice(0, 2);
      const props = spec.props as Record<string, unknown>;
      delete props.Label;
      delete props["Show icon"];
      (spec.variant as { children: Array<Record<string, unknown>> }).children = [{ component: "Icon/Plus", name: "Icon", propRefs: { mainComponent: "Icon" } }, { name: "Label", text: "Button", font: { color: "#ffffff" } }];
      const showKey = keyOf(defsOf(set), "Show icon");
      const real = set?.deleteComponentProperty;
      if (set && typeof real === "function") {
        set.deleteComponentProperty = (k: string) => { if (k === showKey) throw new Error("in Figma: cannot delete " + k); return (real as (k: string) => void)(k); };
      }
      const r = await write(w, [button(spec)]);
      if (set) set.deleteComponentProperty = real;
      const err = refusal(r);
      ok("[COMPONENTS] the batch fails at the second delete; the error names the variant and the property already gone", !r.ok && err.includes("cannot delete") && err.includes("cannot be brought back") &&
        err.includes("variant 'Size=sm, State=default'") && err.includes("the property 'Label' of 'Button'"));
      ok("[COMPONENTS] `applied` lists them too", r.applied.some((a) => isObj(a) && a.deleted === true) && r.applied.some((a) => isObj(a) && same(a.propsRemoved, ["Label"])));
      const defs = defsOf(set);
      const dangling = kids(set).flatMap((v) => kids(v)).flatMap((l) => Object.values(refsOf(l))).filter((k) => !Object.prototype.hasOwnProperty.call(defs, String(k)));
      ok("[COMPONENTS] rolled back: no layer references a deleted property; Show icon (not deleted) is wired again", dangling.length === 0 && keyOf(defs, "Label") === undefined && showKey !== undefined &&
        kids(set).every((v) => refsOf(child(v, "Icon")).visible === showKey));
    },
  },
];
