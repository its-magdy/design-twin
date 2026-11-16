// Binding a captured page to the file (#187): the pure binder (bridge/src/bind-values.ts), the component map read in the
// write direction (design-to-code/code-usage.ts figmaUsageOf / mapEntriesByCode), the op's wire check and dry run
// (commands.ts), and the plugin's real code on a fake file (figma-plugin/src/bind.ts through applyWrites and writeImpact).
//   bun test/write-bind.test.ts
import { check, report } from "./assert.ts";
import { treeWorld } from "./harness/writes.ts";
import type { FakeNode, FakeVariable } from "./fake-figma.ts";
import { bindSpec, canonicalHex, textStyleEntry, type BindTable, type BindVariable } from "../bridge/src/bind-values.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import type { TreeNodeSpec } from "../bridge/src/tree-spec.ts";
import { writeOpError, writeOpPreview, type WriteImpactReply, type WriteResult } from "../bridge/src/commands.ts";
import { componentRef, figmaUsageOf, mapEntriesByCode } from "../design-to-code/code-usage.ts";
import type { MapEntry } from "../design-to-code/types.ts";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const v = (ref: string, name: string, value: string | number, scopes: string[] = ["ALL_SCOPES"]): BindVariable => ({ ref, name, value, scopes });
const alias = (ref: string, name: string, to: string, scopes: string[] = ["ALL_SCOPES"]): BindVariable => ({ ref, name, aliasOf: to, scopes });
const table = (o: Partial<BindTable>): BindTable => ({ colors: [], numbers: [], textStyles: [], ...o });

// ---------------------------------------------------------------- the binder
console.log("the binder (bind-values.ts):");
{
  check("a hex is compared as the read writes it: #FFF, #ffffff and #ffffffff are one colour; an alpha is kept", canonicalHex("#FFF") === "#ffffff" && canonicalHex("#ffffffff") === "#ffffff" && canonicalHex("#00000080") === "#00000080" && canonicalHex("red") === null);
  const spec: TreeNodeSpec = {
    name: "Screen", box: { w: 400, h: 300 }, fills: [{ type: "solid", color: "#FFFFFF" }],
    layout: { display: "flex", flexDirection: "column", gap: 16, padding: [24, 16, 24, 16] },
    children: [
      { text: "Title", font: { family: "Inter", weight: "Bold", size: 24, color: "#111111", lineHeight: { unit: "px", value: 32 } } },
      { name: "Card", box: { w: 368, h: 80 }, radius: 8, strokes: { colors: ["#e4e4e7"], weight: 1 }, fills: [{ type: "solid", color: "#fafafa" }, { type: "image", file: "a.png", image: "a".repeat(64) }] },
      { component: "Button", props: { Label: "Go" } },
    ],
  };
  const before = JSON.stringify(spec);
  const t = table({
    colors: [v("V:bg", "color/bg", "#ffffff"), v("V:text", "color/text", "#111111"), v("V:border", "color/border", "#e4e4e7"), v("V:surface", "color/surface", "#fafafa")],
    numbers: [v("V:s16", "space/16", 16), v("V:s24", "space/24", 24.004), v("V:r8", "radius/md", 8)],
    textStyles: [textStyleEntry("S:h1", "Heading", { family: "Inter", style: "Bold", size: 24, lineHeight: { unit: "PIXELS", value: 32 }, letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE" })],
  });
  const { spec: out, outcome } = bindSpec(spec, t);
  const [title, card, button] = out.children ?? [];
  check("the spec handed in is not changed (the result is a copy)", JSON.stringify(spec) === before);
  check("a frame's paint binds through fills[i].tokens.color, its colour kept beside it", same(out.fills, [{ type: "solid", color: "#FFFFFF", tokens: { color: "V:bg" } }]));
  check("gap and each padding side bind (a number within 0.01), a side no variable equals stays raw", same(out.tokens, { itemSpacing: "V:s16", paddingTop: "V:s24", paddingRight: "V:s16", paddingBottom: "V:s24", paddingLeft: "V:s16" }));
  check("a text's font colour binds through tokens.fills; its text style binds and the fields the style sets are dropped (colour kept)",
    same(title?.tokens, { fills: "V:text" }) && same(title?.styles, { text: "S:h1" }) && same(title?.font, { color: "#111111" }));
  check("a radius binds every corner to the one variable; a stroke colour through tokens.strokes; an image paint is left alone",
    same(card?.tokens, { strokes: "V:border", topLeftRadius: "V:r8", topRightRadius: "V:r8", bottomRightRadius: "V:r8", bottomLeftRadius: "V:r8" }) && card?.fills?.[0]?.type === "solid" && (card.fills[0] as { tokens?: unknown }).tokens !== undefined && same(card.fills[1], spec.children?.[1]?.fills?.[1]));
  check("an instance is not bound into (its content is its component's)", same(button, spec.children?.[2]));
  const checked = checkTree(out);
  check(`the bound spec passes the tree spec's check (${checked.problems.join("; ")})`, checked.problems.length === 0);
  check(`outcome: each value bound counted as tree-spec counts an unbound one (${outcome.bound} bound, ${checked.summary.unbound} left)`,
    // the root's paint, gap and 4 sides; the title's colour and style; the card's radius, stroke colour and paint (its stroke
    // weight is never bound: the one value left)
    outcome.bound === 6 + 2 + 3 && checked.summary.unbound === 1 && checkTree(spec).summary.unbound === 12 && outcome.ambiguous.count === 0);
  check("…the bound spec names each variable and style it binds to (resolved like any other)", same(checked.summary.refs.textStyles, ["S:h1"]) && checked.summary.refs.variables.includes("V:bg"));
}
{
  const frame = (color: string): TreeNodeSpec => ({ name: "F", fills: [{ type: "solid", color }], layout: { display: "flex", gap: 8 } });
  const one = (t: BindTable, s: TreeNodeSpec = frame("#ffffff")) => bindSpec(s, t);
  // (1) scopes
  check("(1) a variable whose scopes leave the field out is no candidate: a text colour for a frame's fill, an empty list for nothing",
    one(table({ colors: [v("A", "a", "#ffffff", ["TEXT_FILL"]), v("B", "b", "#ffffff", [])] })).spec.fills?.[0] !== undefined && !("tokens" in (one(table({ colors: [v("A", "a", "#ffffff", ["TEXT_FILL"])] })).spec.fills?.[0] ?? {})));
  check("…FRAME_FILL / ALL_FILLS allow a frame's fill, GAP a gap",
    same(one(table({ colors: [v("A", "a", "#ffffff", ["TEXT_FILL"]), v("B", "b", "#ffffff", ["FRAME_FILL"])], numbers: [v("G", "g", 8, ["GAP"]), v("R", "r", 8, ["CORNER_RADIUS"])] })).spec.tokens, { itemSpacing: "G" }));
  // (2) the field's words
  const words = one(table({ colors: [v("A", "brand/white", "#ffffff"), v("B", "color/bg/default", "#ffffff")], numbers: [v("G", "size/8", 8), v("H", "spacing/xs", 8)] }));
  check("(2) of several, the one whose name has a word for the field: bg for a fill, spacing for a gap", (words.spec.fills?.[0] as { tokens?: { color: string } }).tokens?.color === "B" && words.spec.tokens?.itemSpacing === "H");
  check("…a word inside another word is no word: 'context' is not 'text', camelCase splits ('textPrimary' is)",
    (one(table({ colors: [v("A", "contextual", "#111111", ["ALL_SCOPES"]), v("B", "textPrimary", "#111111")] }), { name: "R", children: [{ text: "x", font: { color: "#111111" } }] }).spec.children?.[0]?.tokens?.fills) === "B");
  // (3) the semantic alias over the primitive it names, through a chain too
  const chain = one(table({ colors: [v("P", "gray/0", "#ffffff"), alias("M", "mid", "P"), alias("S", "page", "M")] }));
  check("(3) a variable another candidate aliases (directly or through a chain) is dropped: the semantic one is bound", (chain.spec.fills?.[0] as { tokens?: { color: string } }).tokens?.color === "S" && chain.outcome.ambiguous.count === 0);
  // still several: ambiguous, raw kept
  const tie = one(table({ colors: [v("A", "white", "#ffffff"), v("B", "snow", "#ffffff"), v("C", "paper", "#ffffff"), v("D", "chalk", "#ffffff")] }));
  check("still several: left raw and listed (field, path, value, up to three names)", !("tokens" in (tie.spec.fills?.[0] ?? {})) && tie.outcome.ambiguous.count === 1 && same(tie.outcome.ambiguous.samples[0], { path: "tree", field: "fills[0]", value: "#ffffff", candidates: ["white", "snow", "paper"] }));
  // broken and looping chains
  const broken = one(table({ colors: [alias("A", "a", "nowhere"), alias("B", "b", "C"), alias("C", "c", "B"), v("D", "d", "#ffffff")] }));
  check("a broken or looping alias chain has no value: never a candidate", (broken.spec.fills?.[0] as { tokens?: { color: string } }).tokens?.color === "D");
  const lib = one(table({ colors: [{ ref: "L", name: "lib/white", value: "#ffffff", scopes: ["ALL_SCOPES"], candidate: false }, alias("S", "page", "L")] }));
  check("a variable only there to be followed (candidate false) is reached through an alias, never bound itself", (lib.spec.fills?.[0] as { tokens?: { color: string } }).tokens?.color === "S");
  check("a paint with its own opacity is left raw (its colour is not the variable's)", !("tokens" in (one(table({ colors: [v("A", "a", "#ffffff")] }), { name: "F", fills: [{ type: "solid", color: "#ffffff", opacity: 0.5 }] }).spec.fills?.[0] ?? {})));
  const strokes = one(table({ colors: [v("A", "border", "#000000")] }), { name: "F", strokes: { colors: ["#000000", "#ff0000"], weight: 1 } });
  check("strokes bind all or none: one colour no variable equals leaves both raw", strokes.spec.tokens === undefined && strokes.outcome.bound === 0);
  const styleSpec: TreeNodeSpec = { name: "R", children: [{ text: "a", font: { family: "Inter", weight: "Regular", size: 16, letterSpacing: { unit: "percent", value: 10 } } }] };
  const st = (ref: string, ls: number) => textStyleEntry(ref, ref, { family: "Inter", style: "Regular", size: 16, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: ls }, textCase: "ORIGINAL", textDecoration: "NONE" });
  check("a text style matches when every font field is equal (a percent letter spacing compared in px)", bindSpec(styleSpec, table({ textStyles: [st("S1", 1.6)] })).spec.children?.[0]?.styles?.text === "S1"
    && bindSpec(styleSpec, table({ textStyles: [st("S1", 1)] })).spec.children?.[0]?.styles === undefined);
  const twoStyles = bindSpec(styleSpec, table({ textStyles: [st("S1", 1.6), st("S2", 1.6)] }));
  check("two equal text styles: ambiguous, the text left with its own font", twoStyles.spec.children?.[0]?.styles === undefined && twoStyles.outcome.ambiguous.count === 1 && twoStyles.outcome.ambiguous.samples[0]?.field === "styles.text");
  const many: TreeNodeSpec = { name: "R", children: Array.from({ length: 9 }, () => ({ name: "F", fills: [{ type: "solid", color: "#ffffff" }] } satisfies TreeNodeSpec)) };
  const lots = bindSpec(many, table({ colors: [v("A", "white", "#ffffff"), v("B", "snow", "#ffffff")] }));
  check("the ambiguous list is capped (5 samples), its count is all of them", lots.outcome.ambiguous.count === 9 && lots.outcome.ambiguous.samples.length === 5);
}

// ---------------------------------------------------------------- the component map, write direction
console.log("\nthe component map in the write direction (code-usage.ts):");
{
  const KEY = "a1".repeat(20);
  const button: MapEntry = {
    figma: { name: "Button", key: KEY }, code: { module: "@/ui/button", export: "Button" }, status: "active",
    props: {
      Variant: { kind: "enum", codeProp: "variant", values: { Primary: "primary", Ghost: "ghost", Default: null } },
      "Size#1:0": { kind: "enum", codeProp: "size", values: { Small: "sm", Medium: "md", Tiny: "sm" }, default: "Medium" },
      Disabled: { kind: "boolean", codeProp: "disabled", default: false },
      Label: { kind: "string", codeProp: "children" },
      Icon: { kind: "instance", slot: "icon" },
    },
    variantOverrides: [{ when: { Variant: "Ghost" }, code: { module: "@/ui/button", export: "GhostButton" } }],
  };
  const u = figmaUsageOf(button, { variant: "primary", disabled: true, onClick: "x" }, "Save");
  check("enum values inverted, a boolean as given, a children string from the rendered text, an unmapped code prop ignored",
    same(u.props, { Variant: "Primary", Disabled: true, Label: "Save" }) && u.component === KEY);
  check("…an instance prop (a slot) is not written: warned", u.warnings.some((w) => w.code === "slot-not-written" && w.prop === "Icon"));
  const absent = figmaUsageOf(button, {}, "");
  check("an absent code prop: the one option that maps to no code prop (null); a default the map writes out is not assumed (left out)",
    same(absent.props, { Variant: "Default" }));
  const omitted = figmaUsageOf({ ...button, props: { ...button.props, "Size#1:0": { kind: "enum", codeProp: "size", values: { Small: "sm", Medium: "md" }, default: "Medium", omitDefault: true }, Disabled: { kind: "boolean", codeProp: "disabled", default: false, omitDefault: true } } }, {}, "");
  check("…a default the map omits (omitDefault) is what an absent code prop stands for", omitted.props.Size === "Medium" && omitted.props.Disabled === false);
  const twice = figmaUsageOf(button, { size: "sm" }, "Go");
  check("two options mapping to one code value: not written (the component's default shows), warned", twice.props.Size === undefined && twice.warnings.some((w) => w.code === "ambiguous-variant-value" && w.prop === "Size"));
  const unknown = figmaUsageOf(button, { variant: "danger", disabled: "yes" });
  check("a code value in none of the values, a boolean given as text: not written, warned",
    unknown.props.Variant === undefined && unknown.warnings.some((w) => w.code === "unmapped-variant-value") && unknown.warnings.some((w) => w.code === "prop-value-mismatch" && w.prop === "Disabled"));
  check("a variantOverride whose code target is the element's component gives its `when` values", figmaUsageOf(button, {}, "Go", "GhostButton").props.Variant === "Ghost" && figmaUsageOf(button, {}, "Go", "@/ui/button#GhostButton").props.Variant === "Ghost");
  // a variantOverride whose code target the entry's own code shares says nothing; one of its own fills in, the code props win
  const shared: MapEntry = { figma: { name: "Button" }, code: { module: "ui", export: "Button" },
    props: { Tone: { kind: "enum", codeProp: "tone", values: { Primary: "primary", Ghost: "ghost" } } },
    variantOverrides: [{ when: { Tone: "Ghost" }, code: { module: "ui", export: "Button" } }] };
  check("an override sharing the entry's own code target: the decoded variant stands (not the override's `when`)",
    figmaUsageOf(shared, { tone: "primary" }, "", "ui#Button").props.Tone === "Primary" && figmaUsageOf(shared, { tone: "primary" }, "", "Button").props.Tone === "Primary");
  const own: MapEntry = { ...shared, variantOverrides: [{ when: { Tone: "Ghost" }, code: { module: "ui", export: "GhostButton" } }] };
  const clash = figmaUsageOf(own, { tone: "primary" }, "", "GhostButton");
  check("an override of its own: its `when` fills a value the code did not pass; a value the code passed wins, warned",
    figmaUsageOf(own, {}, "", "GhostButton").props.Tone === "Ghost" && clash.props.Tone === "Primary" && clash.warnings.some((w) => w.code === "conflicting-code-prop" && w.prop === "Tone"));
  // prototype keys are props like any other
  const protoEntry: MapEntry = { figma: { name: "Odd" }, code: { module: "ui", export: "Odd" },
    props: { Kind: { kind: "enum", codeProp: "__proto__", values: { Ghost: "ghost", Plain: "plain" } }, Ctor: { kind: "string", codeProp: "constructor" } } };
  const protoProps: Record<string, string> = Object.create(null) as Record<string, string>;
  Object.defineProperty(protoProps, "__proto__", { value: "ghost", enumerable: true });
  const pu = figmaUsageOf(protoEntry, protoProps, "");
  check("a code prop named __proto__ is read as given; constructor absent is absent (not Object's)", pu.props.Kind === "Ghost" && pu.props.Ctor === undefined && figmaUsageOf(protoEntry, {}, "").props.Ctor === undefined);
  check("the component reference: a 40-hex key, else the id, else the name", componentRef(button) === KEY && componentRef({ ...button, figma: { name: "B", key: "K", id: "1:2" } }) === "1:2" && componentRef({ ...button, figma: { name: "B" } }) === "B");
  const idx = mapEntriesByCode({
    components: {
      k1: button,
      k2: { figma: { name: "Card" }, code: { module: "@/ui/card", export: "Card" } },
      k3: { figma: { name: "Card (old)" }, code: { module: "@/legacy/card", export: "Card" } },
      k4: { figma: { name: "Stub" }, code: { module: "TODO: import path", export: "Stub" } },
      k5: { figma: { name: "Gone" }, code: { module: "@/ui/gone", export: "Gone" }, status: "deprecated" },
    },
  });
  const hit = idx.get("GhostButton");
  check("the index: by export and by module#export, a variantOverride's target too", hit !== null && "entry" in hit && hit.entry === button && idx.get("@/ui/button#Button") !== null && idx.names.includes("Button"));
  const card = idx.get("Card");
  check("…one bare export two entries have is ambiguous (module#export tells them apart); a placeholder or deprecated entry is left out",
    card !== null && "ambiguous" in card && card.ambiguous.length === 2 && !idx.names.includes("Card") && idx.names.includes("@/ui/card#Card") && idx.get("Stub") === null && idx.get("Gone") === null);
}

// ---------------------------------------------------------------- the op
console.log("\nthe op (commands.ts):");
{
  const tree = { name: "S", fills: [{ type: "solid", color: "#ffffff" }] };
  check("createTree takes bind: true", writeOpError({ op: "createTree", tree, bind: true }, 0) === null);
  check("…a bind that is not a boolean is refused by path", /`ops\[0\]\.bind` is not a boolean/.test(writeOpError({ op: "createTree", tree, bind: "yes" }, 0) ?? ""));
  check("…and bind on another op is refused", /only a createTree binds/.test(writeOpError({ op: "patch", nodeId: "1:2", set: { name: "x" }, bind: true }, 0) ?? ""));
  const step = writeOpPreview({ op: "createTree", tree, bind: true }, 0);
  check("the dry run with no plugin says the binding is the file's, at write time", /decided by the file when it is applied/.test(step.change ?? ""));
}

// ---------------------------------------------------------------- the plugin on a fake file
console.log("\nthe plugin (figma-plugin/src/bind.ts) on a fake file:");
const fv = (id: string, name: string, type: "COLOR" | "FLOAT", value: unknown, scopes = ["ALL_SCOPES"], coll = "VariableCollectionId:50:1"): FakeVariable =>
  ({ id, name, key: "key-" + id, resolvedType: type, variableCollectionId: coll, scopes, codeSyntax: {}, remote: false, valuesByMode: { "50:0": value, "50:1": type === "COLOR" ? { r: 0, g: 0, b: 0, a: 1 } : 0 } });
const rgba = (hex: string): { r: number; g: number; b: number; a: number } => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
const screen = (): Record<string, unknown> => ({
  name: "Captured", key: "capture:t@400", box: { w: 400, h: 300 }, fills: [{ type: "solid", color: "#ffffff" }],
  layout: { display: "flex", flexDirection: "column", gap: 16, padding: [16, 16, 16, 16] },
  children: [
    { text: "Hello", font: { family: "Inter", weight: "Bold", size: 24, color: "#111111" } },
    { name: "Panel", box: { w: 368, h: 60 }, radius: 8, fills: [{ type: "solid", color: "#f4f4f5" }] },
    { component: "Button", props: { Size: "Large", Label: "Save" } },
  ],
});
void (async () => {
  try {
    const w = await treeWorld({ kit: true });
    // the file's own variables (a Light / Dark collection: Light is the default) and a text style, beside the kit's
    w.scene.collections["VariableCollectionId:50:1"] = { id: "VariableCollectionId:50:1", name: "Theme", modes: [{ modeId: "50:0", name: "Light" }, { modeId: "50:1", name: "Dark" }], defaultModeId: "50:0" };
    Object.assign(w.scene.variables, {
      "VariableID:50:1": fv("VariableID:50:1", "gray/0", "COLOR", rgba("#ffffff")),
      "VariableID:50:2": fv("VariableID:50:2", "color/bg", "COLOR", { type: "VARIABLE_ALIAS", id: "VariableID:50:1" }),
      "VariableID:50:3": fv("VariableID:50:3", "color/text", "COLOR", rgba("#111111"), ["TEXT_FILL"]),
      "VariableID:50:4": fv("VariableID:50:4", "space/4", "FLOAT", 16, ["GAP"]),
      "VariableID:50:5": fv("VariableID:50:5", "radius/md", "FLOAT", 8, ["CORNER_RADIUS"]),
      // equal to the panel's grey in Dark only: its default mode (Light) is what counts
      "VariableID:50:6": { ...fv("VariableID:50:6", "color/muted", "COLOR", rgba("#000000")), valuesByMode: { "50:0": rgba("#000000"), "50:1": rgba("#f4f4f5") } },
    });
    const h2: FakeNode = { id: "S:h2,", name: "Heading/H2", key: "local-h2", type: "TEXT", fontName: { family: "Inter", style: "Bold" }, fontSize: 24, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, textCase: "ORIGINAL", textDecoration: "NONE" };
    w.scene.localStyles.text.push(h2);
    w.scene.styles["S:h2,"] = h2;
    // the same font with paragraph spacing: it would add a gap the capture does not have, so it never competes with H2
    const spaced: FakeNode = { ...h2, id: "S:sp,", name: "Heading/Spaced", key: "local-sp", paragraphSpacing: 32 };
    w.scene.localStyles.text.push(spaced);
    w.scene.styles["S:sp,"] = spaced;

    const impact = async (ops: ReadonlyArray<Record<string, unknown>>): Promise<WriteImpactReply | null> => {
      const posted = await w.send({ type: "bridge", id: "imp", cmd: "writeImpact", args: { ops } });
      const r = posted.find((m) => m.type === "bridge-result" && m.id === "imp");
      return r && r.ok ? (r.result as WriteImpactReply) : null;
    };
    const op = { op: "createTree", tree: screen(), bind: true };
    const dry = await impact([op]);
    const dstep = dry?.steps.find((s) => s.index === 0 && s.bind);
    check(`the dry run (writeImpact) counts what the file would bind (${JSON.stringify(dstep?.bind)})`, same(dstep?.bind, { bound: 9, instanced: 1, unbound: 1 }));

    const r: WriteResult = await w.api.applyWrites([op]);
    const row = r.applied[0];
    check(`the write lands; its reply counts bound, instanced and unbound parts, \`unbound\` not repeated (${JSON.stringify(row)})`, r.ok && same(row?.bind, { bound: 9, instanced: 1, unbound: 1 }) && row?.unbound === undefined);
    const root = w.alive().find((n) => n.name === "Captured");
    const kids = (n: FakeNode | undefined): FakeNode[] => (n?.children ?? []) as FakeNode[];
    const [title, panel, inst] = kids(root);
    const paintVar = (n: FakeNode | undefined): unknown => ((n?.fills as Array<{ boundVariables?: { color?: { id: string } } }> | undefined)?.[0]?.boundVariables?.color?.id);
    check("the root's paint is bound to the semantic variable (its alias of the primitive)", paintVar(root) === "VariableID:50:2");
    check("gap and padding are bound to the GAP-scoped variable", same(root?.boundVariables, { itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:50:4" }, paddingTop: { type: "VARIABLE_ALIAS", id: "VariableID:50:4" }, paddingRight: { type: "VARIABLE_ALIAS", id: "VariableID:50:4" }, paddingBottom: { type: "VARIABLE_ALIAS", id: "VariableID:50:4" }, paddingLeft: { type: "VARIABLE_ALIAS", id: "VariableID:50:4" } }));
    check("the title's colour (TEXT_FILL) and text style are bound (a style with paragraph spacing is not a candidate)", paintVar(title) === "VariableID:50:3" && title?.textStyleId === "S:h2,");
    check("the panel's radius is bound; its grey, equal only in a mode that is not the default, stays raw",
      (panel?.boundVariables as Record<string, unknown> | undefined)?.topLeftRadius !== undefined && paintVar(panel) === undefined);
    check("the instance is an instance of the kit's component with its props", inst?.type === "INSTANCE" && same(inst?.props, { Size: "Large", "Label#1:0": "Save" }));
    // a re-send of the same key binds the same way: nothing changes
    const again: WriteResult = await w.api.applyWrites([{ op: "createTree", tree: screen(), bind: true }]);
    check(`a re-send of the same spec binds it the same way: unchanged (${JSON.stringify(again.applied[0])})`, again.ok && again.applied[0]?.unchanged === true && again.applied[0]?.bind?.bound === 9);

    // in one batch with a create table: the table's new variables are bound by name, and resolve to what it made
    const w2 = await treeWorld();
    const table = { op: "createVariables", collection: "Kit", modes: ["Light", "Dark"], variables: [["color/page", "color", "#fafafa", "#09090b"], ["space/lg", "number", 24, 24], ["color/ink", "color", "#18181b", "#fafafa"]] };
    const spec2 = { name: "Two", box: { w: 300, h: 200 }, fills: [{ type: "solid", color: "#fafafa" }], layout: { display: "flex", gap: 24 }, children: [{ text: "Hi", font: { color: "#18181b" } }] };
    const r2: WriteResult = await w2.api.applyWrites([table, { op: "createTree", tree: spec2, bind: true }]);
    const two = w2.alive().find((n) => n.name === "Two");
    const made = (name: string): string | undefined => Object.values(w2.scene.variables).find((x) => x.name === name)?.id;
    check(`a create table of the same batch: its new variables (by their default mode, Light) are bound by name and resolve to what it made (${JSON.stringify(r2.applied[1] ?? r2.error)})`,
      r2.ok && same(r2.applied[1]?.bind, { bound: 3, instanced: 0, unbound: 1 }) && paintVar(two) === made("color/page") && (two?.boundVariables as Record<string, { id: string }> | undefined)?.itemSpacing?.id === made("space/lg") && paintVar(kids(two)[0]) === made("color/ink"));
    // the same seed-and-capture batch sent twice: the second finds the variables and the style made, and binds them as the
    // first did (by the same name), so the keyed result is unchanged
    const w3 = await treeWorld();
    const seedAndCapture = () => [
      { op: "createVariables", collection: "Kit", modes: ["Light"], variables: [["color/page", "color", "#fafafa"], ["space/lg", "number", 24]] },
      { op: "createStyles", styles: [{ name: "Body", kind: "text", set: { font: "Inter", weight: "Regular", size: 14 } }] },
      { op: "createTree", bind: true, tree: { name: "Seeded", key: "capture:seeded@300", box: { w: 300, h: 200 }, fills: [{ type: "solid", color: "#fafafa" }], layout: { display: "flex", gap: 24 }, children: [{ text: "Hi", font: { family: "Inter", weight: "Regular", size: 14 } }] } },
    ];
    const first: WriteResult = await w3.api.applyWrites(seedAndCapture());
    const second: WriteResult = await w3.api.applyWrites(seedAndCapture());
    check(`the first send binds what the batch makes (${JSON.stringify(first.applied[2] ?? first.error)})`, first.ok && first.applied[2]?.bind?.bound === 3);
    check(`the identical batch again: the keyed result is unchanged (${JSON.stringify(second.applied[2] ?? second.error)})`, second.ok && second.applied[2]?.unchanged === true && second.applied[2]?.bind?.bound === 3);
    // names the resolver reads as a ref (a 40-hex key, an id): never bound to, on the send that makes them or after
    const w4 = await treeWorld();
    const pre: WriteResult = await w4.api.applyWrites([{ op: "createVariables", collection: "Base", modes: ["Light"], variables: [["color/base", "color", "#222222"]] }]);
    const baseId = Object.values(w4.scene.variables).find((x) => x.name === "color/base")?.id ?? "";
    const HEX40 = "ab".repeat(20);
    const oddBatch = () => [
      { op: "createVariables", collection: "Odd", modes: ["Light"], variables: [[HEX40, "color", "#123456"], [baseId, "color", "#333333"]] },
      { op: "createStyles", styles: [{ name: "S:odd", kind: "text", set: { font: "Inter", weight: "Regular", size: 13 } }] },
      { op: "createTree", bind: true, tree: { name: "Odd", key: "capture:odd@300", box: { w: 300, h: 200 }, fills: [{ type: "solid", color: "#123456" }], layout: { display: "flex" }, children: [
        { name: "Box", box: { w: 10, h: 10 }, fills: [{ type: "solid", color: "#333333" }] }, { text: "Hi", font: { family: "Inter", weight: "Regular", size: 13 } }] } },
    ];
    const odd1: WriteResult = await w4.api.applyWrites(oddBatch());
    const oddRoot = w4.alive().find((n) => n.name === "Odd");
    check(`a new variable named like a key or an id, a new text style named like an id: left raw on the send that makes them, the batch lands (${JSON.stringify(odd1.applied[2] ?? odd1.error)})`,
      pre.ok && baseId !== "" && odd1.ok && odd1.applied[2]?.bind?.bound === 0 && !paintVar(oddRoot) && !paintVar(kids(oddRoot)[0]) && !kids(oddRoot)[1]?.textStyleId);
    const odd2: WriteResult = await w4.api.applyWrites(oddBatch());
    check(`…and on the re-send, once they exist: still raw, unchanged (${JSON.stringify(odd2.applied[2] ?? odd2.error)})`, odd2.ok && odd2.applied[2]?.unchanged === true && odd2.applied[2]?.bind?.bound === 0);
    // without bind nothing binds (the op is as before)
    const r3: WriteResult = await w2.api.applyWrites([{ op: "createTree", tree: { ...spec2, name: "Three" } }]);
    check("without bind: nothing is bound, the reply as before (`unbound`, no `bind`)", r3.ok && r3.applied[0]?.bind === undefined && r3.applied[0]?.unbound === 4);
  } catch (e) {
    check(`the plugin half ran to the end (${e instanceof Error ? e.stack ?? e.message : String(e)})`, false);
  } finally {
    report();
  }
})();
