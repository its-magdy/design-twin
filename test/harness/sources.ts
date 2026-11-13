// Source edits (figma-plugin/src/sources.ts): a local variable's values (setVariable), a local paint, text or effect
// style (setStyle), a local main component (patch). Only this file's own: a library's is refused, naming the library.
// The dry run's file-side half (writeImpact) counts what follows.
import { argsShapeError, writeOpPreview, type WriteImpactReply, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import type { FakeCollection, FakeNode, FakeVariable } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

const KEY = (c: string): string => c.repeat(40);
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const alias = (id: string) => ({ type: "VARIABLE_ALIAS" as const, id });

/** A variable whose values change through setValueForMode, as Figma's do (an alias object is kept as given). */
function variable(id: string, name: string, resolvedType: string, coll: FakeCollection, values: Record<string, unknown>, extra: Partial<FakeVariable> = {}): FakeVariable & { setValueForMode(m: string, v: unknown): void } {
  const v: FakeVariable & { setValueForMode(m: string, v: unknown): void } = {
    id, name, resolvedType, variableCollectionId: coll.id, scopes: ["ALL_SCOPES"], codeSyntax: {}, remote: false, key: "key-" + id,
    valuesByMode: { ...values }, ...extra,
    setValueForMode(m: string, x: unknown) {
      if (!coll.modes.some((mode) => mode.modeId === m)) throw new Error("in Figma: invalid mode " + m);
      if (resolvedType === "COLOR" && !(isObj(x) && ("r" in x || x.type === "VARIABLE_ALIAS"))) throw new Error("in Figma: a colour variable takes RGB(A) or an alias");
      v.valuesByMode = Object.freeze({ ...v.valuesByMode, [m]: x }); // a fresh frozen object, as Figma hands back
    },
  };
  return v;
}

/** A file with a design system to edit:
 *   Brand (Light/Dark): brand/primary, brand/accent (an alias of primary in both modes)
 *   Spacing (one mode, Default): space/gap (FLOAT), label/cta (STRING), flag/beta (BOOLEAN)
 *   paint style Brand/Primary (2 consumers), text style Body (Inter Regular 16, its size bound to space/gap), effect style
 *   Shadow/Card; a library's paint style reachable by id; a library variable (Core Library) reachable by id and listed;
 *   a "Screens" page whose layers bind primary, accent and gap; a "Components" page with a Row main component (3
 *   instances) holding a Divider, and a library component reachable by id. */
function sourceWorld() {
  const brand: FakeCollection = { id: "VariableCollectionId:50:1", key: "brand-coll", name: "Brand", modes: [{ modeId: "50:0", name: "Light" }, { modeId: "50:1", name: "Dark" }], defaultModeId: "50:0" };
  const spacing: FakeCollection = { id: "VariableCollectionId:51:1", key: "spacing-coll", name: "Spacing", modes: [{ modeId: "51:0", name: "Default" }], defaultModeId: "51:0" };
  const core: FakeCollection = { id: "VariableCollectionId:lib/9:0", key: "core-coll", name: "Core", modes: [{ modeId: "9:0", name: "Value" }], defaultModeId: "9:0" };
  const primary = variable("VariableID:50:2", "brand/primary", "COLOR", brand, { "50:0": rgba(1, 0, 0), "50:1": rgba(0, 0, 1) });
  const accent = variable("VariableID:50:3", "brand/accent", "COLOR", brand, { "50:0": alias(primary.id), "50:1": alias(primary.id) });
  const gap = variable("VariableID:51:2", "space/gap", "FLOAT", spacing, { "51:0": 8 });
  const cta = variable("VariableID:51:3", "label/cta", "STRING", spacing, { "51:0": "Go" });
  const beta = variable("VariableID:51:4", "flag/beta", "BOOLEAN", spacing, { "51:0": false });
  // A string variable the text style's font family is bound to: changing it changes the style's font (see textFields).
  const family = variable("VariableID:51:5", "font/family", "STRING", spacing, { "51:0": "Inter" });
  const libVar = variable("VariableID:lib/9:1", "color/core", "COLOR", core, { "9:0": rgba(0, 1, 0) }, { remote: true, key: KEY("c") });

  // ---- layers that use them
  const n = (id: string, name: string, extra: FakeNode = {}): FakeNode => ({ id, type: "RECTANGLE", name, fills: [], boundVariables: {}, ...extra });
  const usesPrimary = n("2:1", "Bar", { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: { color: alias(primary.id) } }] });
  const usesAccent = n("2:2", "Link", { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, boundVariables: { color: alias(accent.id) } }] });
  const usesGap = n("2:3", "Stack", { type: "FRAME", boundVariables: { itemSpacing: alias(gap.id) } });
  const plain = n("2:4", "Plain");
  const styled = n("2:5", "Styled");
  // A layer whose fills Figma refuses to change: the batch that patches it fails while applying.
  const stuck: FakeNode = { id: "2:6", type: "RECTANGLE", name: "Stuck", boundVariables: {} };
  Object.defineProperty(stuck, "fills", { enumerable: true, get: () => [], set: () => { throw new Error("in Figma: cannot set fills"); } });
  const screenLayers = [usesPrimary, usesAccent, usesGap, plain, styled, stuck];

  // ---- styles
  const paintStyle: FakeNode = { id: "S:primary,", key: "key-primary-style", type: "PAINT", name: "Brand/Primary", description: "", remote: false,
    paints: Object.freeze([{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]),
    getStyleConsumersAsync: async () => [{ node: plain, fields: ["fills"] }, { node: styled, fields: ["fills"] }] };
  const loaded = new Set<string>();
  const fontKey = (f: unknown): string => (isObj(f) ? String(f.family) + "|" + String(f.style) : "?");
  const textFields: FakeNode = { id: "S:body,", key: "key-body", type: "TEXT", name: "Body", description: "Running text", remote: false,
    fontName: { family: "Inter", style: "Regular" }, fontSize: 16, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 },
    textCase: "ORIGINAL", textDecoration: "NONE", paragraphSpacing: 0, paragraphIndent: 0,
    boundVariables: { fontSize: alias(gap.id) },
    getStyleConsumersAsync: async () => [{ node: styled, fields: ["textStyleId"] }] };
  textFields.setBoundVariable = (field: string, v: FakeVariable | null) => {
    const b = isObj(textFields.boundVariables) ? { ...textFields.boundVariables } : {};
    if (v === null) delete b[field]; else b[field] = alias(v.id);
    textFields.boundVariables = b;
  };
  // Setting a text style's font, size or spacing needs its font loaded; a raw value unbinds a variable (as Figma's do).
  const textStyle = new Proxy<FakeNode>(textFields, {
    set(t, k, v) {
      const key = String(k);
      if (key !== "name" && key !== "description" && key !== "boundVariables" && !loaded.has(fontKey(key === "fontName" ? v : t.fontName))) throw new Error("in Figma: font " + fontKey(key === "fontName" ? v : t.fontName) + " is not loaded (setting " + key + ")");
      if (isObj(t.boundVariables) && key in t.boundVariables) { const b = { ...t.boundVariables }; delete b[key]; t.boundVariables = b; }
      t[key] = v;
      return true;
    },
  });
  const effectStyle: FakeNode = { id: "S:shadow,", key: "key-shadow", type: "EFFECT", name: "Shadow/Card", description: "", remote: false,
    effects: Object.freeze([{ type: "DROP_SHADOW", color: rgba(0, 0, 0, 0.25), offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true, blendMode: "NORMAL", showShadowBehindNode: false }]),
    getStyleConsumersAsync: async () => [] };
  const gridded = n("2:7", "Gridded");
  const gridStyle: FakeNode = { id: "S:grid,", key: "key-grid", type: "GRID", name: "Grid/12", remote: false,
    layoutGrids: [{ pattern: "COLUMNS", count: 12, gutterSize: 8, boundVariables: { gutterSize: alias(gap.id) } }],
    getStyleConsumersAsync: async () => [{ node: gridded, fields: ["gridStyleId"] }] };
  const libStyle: FakeNode = { id: "S:remote,", key: KEY("a"), type: "PAINT", name: "Core/Brand", remote: true, paints: [] };

  // ---- components
  const divider = n("3:2", "Divider", { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] });
  const row: FakeNode = { id: "3:1", type: "COMPONENT", name: "Row", key: "key-row", remote: false, children: [divider], getInstancesAsync: async () => [{ id: "I1" }, { id: "I2" }, { id: "I3" }] };
  divider.parent = row;
  const avatarDot = n("9:3", "Dot");
  const avatar: FakeNode = { id: "9:2", type: "COMPONENT", name: "Avatar", key: KEY("e"), remote: true, children: [avatarDot], getInstancesAsync: async () => [{ id: "I9" }] };
  avatarDot.parent = avatar;

  const walk = (list: readonly FakeNode[], keep: (x: FakeNode) => boolean): FakeNode[] => list.flatMap((k) => [...(keep(k) ? [k] : []), ...walk(k.children ?? [], keep)]);
  const page = (id: string, name: string, children: FakeNode[]): FakeNode & { selection: FakeNode[] } => {
    const pg: FakeNode & { selection: FakeNode[] } = { id, type: "PAGE", name, selection: [], children, loadAsync: async () => {} };
    pg.findAll = (keep: (x: FakeNode) => boolean) => walk(children, keep);
    for (const k of children) k.parent = pg;
    return pg;
  };
  const screens = page("0:10", "Screens", screenLayers);
  const components = page("0:11", "Components", [row]);
  row.parent = components;
  const nodes = Object.fromEntries([...screenLayers, divider, row, avatar, avatarDot, screens, components].map((x) => [String(x.id), x]));
  const vars = { [primary.id]: primary, [accent.id]: accent, [gap.id]: gap, [cta.id]: cta, [beta.id]: beta, [family.id]: family };
  // The text style's family follows the variable it is bound to, as Figma's does.
  const setFamily = family.setValueForMode;
  family.setValueForMode = (m: string, x: unknown) => { setFamily(m, x); textFields.fontName = { family: String(x), style: isObj(textFields.fontName) ? String(textFields.fontName.style) : "Regular" }; };
  const w = world({
    pages: [screens, components], currentPage: screens, nodes,
    variables: vars, collections: { [brand.id]: brand, [spacing.id]: spacing },
    remote: { variables: { [libVar.id]: libVar }, collections: { [core.id]: core } },
    localStyles: { paint: [paintStyle], text: [textStyle], effect: [effectStyle], grid: [gridStyle] },
    styles: { [String(paintStyle.id)]: paintStyle, [String(textStyle.id)]: textStyle, [String(effectStyle.id)]: effectStyle, [String(gridStyle.id)]: gridStyle, [String(libStyle.id)]: libStyle },
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async () => [{ name: "Core", key: "core-coll", libraryName: "Core Library" }],
      getVariablesInLibraryCollectionAsync: async () => [{ name: "color/core", key: KEY("c"), resolvedType: "COLOR" }],
    },
  }, {
    loadFontAsync: async (f: { family: string; style: string }) => { if (!["Inter", "Inter Display"].includes(f.family) || !["Regular", "Bold", "Semi Bold"].includes(f.style)) throw new Error("font not found"); loaded.add(fontKey(f)); },
    variables: {
      createVariableAlias: (v: FakeVariable) => alias(v.id),
      setBoundVariableForPaint: (p: FakeNode, field: string, v: FakeVariable | null) => ({ ...p, boundVariables: v ? { [field]: alias(v.id) } : {} }),
    },
  });
  return { ...w, primary, accent, gap, cta, beta, paintStyle, textStyle, effectStyle, divider, row, avatarDot, stuck, brand };
}
type SourceWorld = ReturnType<typeof sourceWorld>;

const write = (w: SourceWorld, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...o })));
const isImpact = (v: unknown): v is WriteImpactReply => isObj(v) && Array.isArray(v.steps);
/** The dry run's file-side half, through the bridge handler as figma_write sends it. */
async function impact(w: SourceWorld, ops: WriteOp[]): Promise<WriteImpactReply | null> {
  const posted = await w.send({ type: "bridge", id: "imp", cmd: "writeImpact", args: { ops } });
  const r = posted.find((m) => m.type === "bridge-result" && m.id === "imp");
  const result: unknown = r && r.ok ? r.result : null;
  return isImpact(result) ? result : null;
}
const val = (v: FakeVariable, mode: string): unknown => v.valuesByMode[mode];
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const cases: Case[] = [{
  name: "setVariable: a local variable's value per mode, by mode name or id, and `value` for a one-mode collection",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const r = await write(w, [{ op: "setVariable", variable: "brand/primary", values: { Light: "#00ff00", "50:1": "#00000080" } }]);
    ok("[SOURCE] by name + mode name / modeId: both modes set, the reply names them", r.ok && same(r.applied, [{ id: w.primary.id, modes: ["Light", "Dark"] }])
      && same(val(w.primary, "50:0"), rgba(0, 1, 0)) && same(val(w.primary, "50:1"), rgba(0, 0, 0, 128 / 255)));
    const one = await write(w, [{ op: "setVariable", variable: "space/gap", value: 12 }, { op: "setVariable", variable: "label/cta", value: "Start" }, { op: "setVariable", variable: "flag/beta", value: true }]);
    ok("[SOURCE] `value` sets a one-mode collection's mode (number, string, boolean)", one.ok && val(w.gap, "51:0") === 12 && val(w.cta, "51:0") === "Start" && val(w.beta, "51:0") === true);
    const byKey = await write(w, [{ op: "setVariable", variable: w.gap.key ?? "", value: 16 }]);
    ok("[SOURCE] by key", byKey.ok && val(w.gap, "51:0") === 16);
    const aliased = await write(w, [{ op: "setVariable", variable: "brand/primary", values: { Dark: { aliasOf: "brand/accent" } } }]);
    ok("[SOURCE] an alias that makes a loop is refused, naming the variable", !aliased.ok && /aliases 'brand\/primary'.*loop/.test(aliased.error ?? "") && same(val(w.primary, "50:1"), rgba(0, 0, 0, 128 / 255)));
    const ali = await write(w, [{ op: "setVariable", variable: "brand/accent", values: { Light: "#123456", Dark: { aliasOf: w.primary.id } } }]);
    ok("[SOURCE] an alias to another variable is set as a VariableAlias", ali.ok && same(val(w.accent, "50:1"), alias(w.primary.id)) && isObj(val(w.accent, "50:0")) && (val(w.accent, "50:0") as { r: number }).r > 0);
    ok("[SOURCE] the edits are one undo step each (commitUndo around each batch)", w.undo.commits >= 2);
  },
}, {
  name: "setVariable: every problem is refused before anything runs, with candidates",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const before = JSON.stringify([w.primary.valuesByMode, w.gap.valuesByMode]);
    const bad = await write(w, [
      { op: "setVariable", variable: "brand/primary", values: { Ligth: "#fff" } },
      { op: "setVariable", variable: "brand/primary", value: "#fff" },
      { op: "setVariable", variable: "space/gap", value: "#fff" },
      { op: "setVariable", variable: "brand/primray", value: "#fff" },
      { op: "setVariable", variable: "space/gap", values: { Default: 4 } },
    ]);
    const e = bad.error ?? "";
    ok("[SOURCE] refused whole, every problem listed: unknown mode (closest Light), `value` on two modes, wrong type, unknown name (closest)",
      !bad.ok && bad.failedAt === 0 && /no mode 'Ligth'; closest: 'Light'/.test(e) && /`value` sets the only mode.*has 2/.test(e)
      && /a number variable takes a number/.test(e) && /'brand\/primray' matches no variable.*closest: 'brand\/primary'/.test(e)
      && JSON.stringify([w.primary.valuesByMode, w.gap.valuesByMode]) === before);
    const shape = argsShapeError("write", { ops: [{ op: "setVariable", variable: "x", values: { A: 1 }, value: 2 }] });
    ok("[SOURCE] the wire refuses `values` with `value`, and no values at all", /not both/.test(shape ?? "") && /missing values/.test(argsShapeError("write", { ops: [{ op: "setVariable", variable: "x" }] }) ?? ""));
    ok("[SOURCE] the wire refuses a composed colour by name", /composed colour/.test(argsShapeError("write", { ops: [{ op: "setVariable", variable: "x", value: { composed: {} } }] }) ?? ""));
  },
}, {
  name: "a library's variable, style or component is refused, naming the library when Figma says which",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const byName = await write(w, [{ op: "setVariable", variable: "color/core", value: "#ffffff" }]);
    ok("[SOURCE] a library variable by name: refused, naming 'Core Library'", !byName.ok && /variable 'color\/core' lives in the library 'Core Library', not in this file/.test(byName.error ?? ""));
    const byId = await write(w, [{ op: "setVariable", variable: "VariableID:lib/9:1", value: "#ffffff" }]);
    ok("[SOURCE] a library variable the file uses, by id: refused, naming its library", !byId.ok && /lives in the library 'Core Library'/.test(byId.error ?? ""));
    const byKey = await write(w, [{ op: "setVariable", variable: KEY("c"), value: "#ffffff" }]);
    ok("[SOURCE] by key: refused, naming its library", !byKey.ok && /lives in the library 'Core Library'/.test(byKey.error ?? ""));
    const style = await write(w, [{ op: "setStyle", style: "S:remote,", set: { paints: [{ type: "solid", color: "#ffffff" }] } }]);
    ok("[SOURCE] a library style by id: refused (Figma names no library for a style)", !style.ok && /paint style 'Core\/Brand' lives in another library file/.test(style.error ?? ""));
    const comp = await write(w, [{ op: "patch", nodeId: "9:3", set: { name: "Spot" } }]);
    ok("[SOURCE] a patch inside a library component: refused, naming the component", !comp.ok && /the component 'Avatar' that 'Dot' sits in lives in another library file/.test(comp.error ?? "") && w.avatarDot.name === "Dot");
  },
}, {
  name: "setStyle: a local paint, text or effect style; its kind is checked; a missing font is refused",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const paint = await write(w, [{ op: "setStyle", style: "Brand/Primary", set: { paints: [{ type: "solid", tokens: { color: "brand/accent" } }], description: "Main brand" } }]);
    const p0 = (w.paintStyle.paints as FakeNode[])[0];
    ok("[SOURCE] a paint style's paints, bound to a variable, and its description", paint.ok && same(paint.applied, [{ id: "S:primary," }]) && isObj(p0) && same(p0.boundVariables, { color: alias(w.accent.id) }) && w.paintStyle.description === "Main brand");
    const text = await write(w, [{ op: "setStyle", style: "Body", set: { weight: "Bold", size: 18, lineHeight: { unit: "percent", value: 140 }, letterSpacing: { unit: "px", value: -0.2 }, case: "upper" } }]);
    ok("[SOURCE] a text style's font, size, line height, letter spacing and case", text.ok && same(w.textStyle.fontName, { family: "Inter", style: "Bold" }) && w.textStyle.fontSize === 18
      && same(w.textStyle.lineHeight, { unit: "PERCENT", value: 140 }) && same(w.textStyle.letterSpacing, { unit: "PIXELS", value: -0.2 }) && w.textStyle.textCase === "UPPER");
    const effect = await write(w, [{ op: "setStyle", style: "Shadow/Card", set: { effects: [{ type: "drop_shadow", color: "#00000033", offset: { x: 0, y: 8 }, radius: 16, spread: -2 }, { type: "background_blur", radius: 10 }] } }]);
    const fx = w.effectStyle.effects as FakeNode[];
    ok("[SOURCE] an effect style's shadows and blurs", effect.ok && fx.length === 2 && fx[0]?.type === "DROP_SHADOW" && fx[0]?.radius === 16 && fx[0]?.spread === -2 && same(fx[0]?.offset, { x: 0, y: 8 })
      && fx[1]?.type === "BACKGROUND_BLUR" && fx[1]?.blurType === "NORMAL");
    const bad = await write(w, [
      { op: "setStyle", style: "Body", set: { paints: [{ type: "solid", color: "#fff" }] } },
      { op: "setStyle", style: "Body", set: { font: "Comic", weight: "Regular" } },
      { op: "setStyle", style: "Brand/Primry", set: { paints: [{ type: "solid", color: "#fff" }] } },
      { op: "setStyle", style: "Grid/12", set: { name: "Grid" } },
      { op: "setStyle", style: "S:grid,", set: { name: "Grid" } },
    ]);
    const e = bad.error ?? "";
    ok("[SOURCE] refused whole: fields of another kind, a font the file lacks, an unknown name (closest), a grid style",
      !bad.ok && /'Body' is a text style, and these fields are a paint style's/.test(e) && /font 'Comic Regular' is not available/.test(e)
      && /paint style 'Brand\/Primry' matches no style.*closest: 'Brand\/Primary'/.test(e) && /'Grid\/12' matches no style|style 'Grid\/12' matches no style/.test(e)
      && /grid style, which a style edit cannot change yet/.test(e) && w.textStyle.fontSize === 18);
    ok("[SOURCE] the wire refuses fields of two kinds in one style edit", /one kind/.test(argsShapeError("write", { ops: [{ op: "setStyle", style: "x", set: { paints: [], size: 3 } }] }) ?? ""));
    ok("[SOURCE] the wire refuses an effect it cannot write, by name", /'glass' cannot be written yet/.test(argsShapeError("write", { ops: [{ op: "setStyle", style: "x", set: { effects: [{ type: "glass" }] } }] }) ?? ""));
  },
}, {
  name: "edits in one batch build on each other: a style's font, and the alias graph a loop check follows",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const fonts = await write(w, [{ op: "setStyle", style: "Body", set: { weight: "Bold" } }, { op: "setStyle", style: "Body", set: { font: "Inter" } }]);
    ok("[SOURCE] a second edit of a text style's family keeps the weight the first set", fonts.ok && same(w.textStyle.fontName, { family: "Inter", style: "Bold" }));
    // accent aliases primary in both modes; the batch replaces both with values, then aliases primary to accent.
    const order = await write(w, [
      { op: "setVariable", variable: "brand/accent", values: { Light: "#111111", Dark: "#222222" } },
      { op: "setVariable", variable: "brand/primary", values: { Dark: { aliasOf: "brand/accent" } } },
    ]);
    ok("[SOURCE] an alias whose loop an earlier op of the batch removed is accepted", order.ok && same(val(w.primary, "50:1"), alias(w.accent.id)));
    const loop = await write(w, [
      { op: "setVariable", variable: "brand/accent", values: { Light: { aliasOf: "brand/primary" } } },
      { op: "setVariable", variable: "space/gap", value: 3 },
    ]);
    ok("[SOURCE] …and one an earlier op of the batch makes is refused", !loop.ok && /aliases 'brand\/accent'.*loop/.test(loop.error ?? "") && val(w.gap, "51:0") === 8);
  },
}, {
  name: "a text style whose font an earlier variable edit changed: its live font is loaded, so a failure puts it back",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const r = await write(w, [
      { op: "setVariable", variable: "font/family", value: "Inter Display" },
      { op: "setStyle", style: "Body", set: { font: "Inter", weight: "Bold" } },
      { op: "patch", nodeId: "2:6", set: { fills: [{ type: "solid", color: "#000000" }] } },
    ]);
    ok("[SOURCE] the batch fails at the patch, and the style is back on its own font", !r.ok && r.failedAt === 2 && (r.restored ?? []).length === 2 && same(w.textStyle.fontName, { family: "Inter", style: "Regular" }));
    // The style starts on a family the file cannot load; the variable switches it to one it can, then a weight is set.
    w.textStyle.boundVariables = { ...(isObj(w.textStyle.boundVariables) ? w.textStyle.boundVariables : {}), fontFamily: alias("VariableID:51:5") };
    // A family the file cannot load (set past the fake's font rule, as the designer's own file could hold one).
    Object.defineProperty(w.textStyle, "fontName", { value: { family: "Times", style: "Regular" }, writable: true, enumerable: true, configurable: true });
    const unloadable = await write(w, [{ op: "setVariable", variable: "font/family", value: "Inter Display" }, { op: "setStyle", style: "Body", set: { weight: "Semi Bold" } }]);
    ok("[SOURCE] a font an earlier variable edit switches the style to is checked when the style edit applies, not against the old font",
      unloadable.ok && same(w.textStyle.fontName, { family: "Inter Display", style: "Semi Bold" }));
    await write(w, [{ op: "setVariable", variable: "font/family", value: "Inter" }, { op: "setStyle", style: "Body", set: { weight: "Regular" } }]);
    const bad = await write(w, [{ op: "setVariable", variable: "font/family", value: "Comic" }, { op: "setStyle", style: "Body", set: { size: 20 } }]);
    ok("[SOURCE] a font an earlier op switched the style to that the file lacks fails the style edit, and the batch is put back",
      !bad.ok && bad.failedAt === 1 && /font 'Comic Regular' is not available/.test(bad.error ?? "") && w.textStyle.fontSize === 16);
  },
}, {
  name: "a source edit that a later op's failure takes back is put back exactly (values, aliases, a text style's bindings)",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const before = { primary: JSON.stringify(w.primary.valuesByMode), accent: JSON.stringify(w.accent.valuesByMode), text: JSON.stringify([w.textStyle.fontName, w.textStyle.fontSize, w.textStyle.boundVariables, w.textStyle.name]), paint: JSON.stringify(w.paintStyle.paints) };
    const r = await write(w, [
      { op: "setVariable", variable: "brand/primary", values: { Light: "#00ff00", Dark: "#0000ff" } },
      { op: "setVariable", variable: "brand/accent", values: { Light: "#abcdef" } },
      { op: "setStyle", style: "Body", set: { weight: "Bold", size: 20, name: "Body/Large" } },
      { op: "setStyle", style: "Brand/Primary", set: { paints: [{ type: "solid", color: "#ffffff" }] } },
      { op: "patch", nodeId: "2:6", set: { fills: [{ type: "solid", color: "#000000" }] } },
    ]);
    ok("[SOURCE] the batch fails at the patch and puts every source edit back", !r.ok && r.failedAt === 4 && (r.restored ?? []).length === 4 && r.applied.length === 0
      && JSON.stringify(w.primary.valuesByMode) === before.primary && JSON.stringify(w.accent.valuesByMode) === before.accent
      && JSON.stringify([w.textStyle.fontName, w.textStyle.fontSize, w.textStyle.boundVariables, w.textStyle.name]) === before.text
      && JSON.stringify(w.paintStyle.paints) === before.paint);
  },
}, {
  name: "a local main component patched once: its instances follow, and the dry run counts them",
  async run() {
    const w = sourceWorld();
    await w.allowEdits();
    const r = await write(w, [{ op: "patch", nodeId: "3:2", set: { fills: [{ type: "solid", color: "#e4e4e7" }] } }]);
    const f = (w.divider.fills as FakeNode[])[0];
    ok("[SOURCE] the patch lands on the main component's layer", r.ok && isObj(f) && isObj(f.color) && Math.round(Number(f.color.r) * 255) === 0xe4);
    const imp = await impact(w, [{ op: "patch", nodeId: "3:2", set: { name: "Rule" } }, { op: "patch", nodeId: "3:1", set: { name: "Row" } }, { op: "patch", nodeId: "2:4", set: { name: "x" } }, { op: "patch", nodeId: "9:3", set: { name: "x" } }]);
    ok("[SOURCE] writeImpact: a layer in the component and the component itself → 3 instances; an ordinary layer has no step; a library one is refused",
      imp !== null && same(imp.steps.map((s) => [s.index, s.affects?.instances ?? null, s.problem ? "problem" : null]), [[0, 3, null], [1, 3, null], [3, null, "problem"]]));
  },
}, {
  name: "writeImpact: what a variable or style change carries to, read without changing anything",
  async run() {
    const w = sourceWorld();
    // Allow edits stays OFF: the count is a read.
    const imp = await impact(w, [
      { op: "setVariable", variable: "brand/primary", value: "#fff" },
      { op: "setVariable", variable: "space/gap", value: 4 },
      { op: "setStyle", style: "Brand/Primary", set: { paints: [{ type: "solid", color: "#fff" }] } },
      { op: "setVariable", variable: "color/core", value: "#fff" },
      { op: "createFrame", name: "x" },
    ]);
    const s = imp ? imp.steps : [];
    ok("[SOURCE] primary: 2 layers (one through the alias accent), 1 aliasing variable, no style", same(s[0], { index: 0, op: "setVariable", affects: { nodes: 2, styles: 0, variables: 1 } }));
    ok("[SOURCE] gap: its bound layer, and the layers using the text and grid styles bound to it", same(s[1], { index: 1, op: "setVariable", affects: { nodes: 3, styles: 2, variables: 0 } }));
    ok("[SOURCE] a paint style: its consumers", same(s[2], { index: 2, op: "setStyle", affects: { nodes: 2 } }));
    ok("[SOURCE] a library variable: the refusal, naming the library; a create has no step", /Core Library/.test(s[3]?.problem ?? "") && s.length === 4);
    w.paintStyle.getStyleConsumersAsync = async () => { throw new Error("in Figma: not readable"); };
    const failed = await impact(w, [{ op: "setStyle", style: "Brand/Primary", set: { paints: [] } }]);
    ok("[SOURCE] a consumer lookup Figma refuses is a warning, not a quiet zero", (failed?.warnings ?? []).some((m) => /layers using the style 'Brand\/Primary' could not be read/.test(m)));
    ok("[SOURCE] nothing changed (and Allow edits was never needed)", same(val(w.primary, "50:0"), rgba(1, 0, 0)) && val(w.gap, "51:0") === 8);
  },
}, {
  name: "the dry run's own sentence for a source edit, and the review card shows it",
  async run() {
    const v = writeOpPreview({ op: "setVariable", variable: "brand/primary", values: { Light: "#fff", Dark: { aliasOf: "brand/accent" } } }, 0);
    ok("[SOURCE] setVariable preview: overwrites, the modes and values in one sentence", v.effect === "overwrites" && v.target === "brand/primary" && /'Light' → "#fff", 'Dark' → alias of 'brand\/accent'/.test(v.change ?? ""));
    const s = writeOpPreview({ op: "setStyle", style: "Body", set: { size: 18 } }, 0);
    ok("[SOURCE] setStyle preview: the kind, one row per field", /\(a text style\): sets size/.test(s.change ?? "") && same(s.fields, [{ field: "size", to: "18" }]));
    ok("[SOURCE] an invalid edit's preview names the problem", /not a field a style edit sets; closest: 'size'/.test(writeOpPreview({ op: "setStyle", style: "Body", set: { sizee: 18 } }, 0).invalid ?? ""));
  },
}];
