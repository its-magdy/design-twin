// A design system from nothing (figma-plugin/src/creates.ts): createVariables (a collection, its modes and every
// variable as one table) and createStyles (paint, text and effect styles whose values name variables). A name the file
// has is updated in place and reported as such; the batch is all or nothing and one undo step; the ops after the create
// ops name what they make. Names are the agent's: "__proto__", "constructor" and "toString" are ordinary names here.
import { argsShapeError, writeOpPreview, type WriteImpactReply, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import type { FakeCollection, FakeNode, FakeVariable, Scene } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { treeWorld } from "./writes.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const alias = (id: string) => ({ type: "VARIABLE_ALIAS" as const, id });
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A local variable whose values change through setValueForMode (a fresh frozen object each time, as Figma's). */
function variable(id: string, name: string, resolvedType: string, coll: FakeCollection, values: Record<string, unknown>): FakeVariable & { setValueForMode(m: string, v: unknown): void } {
  const v: FakeVariable & { setValueForMode(m: string, v: unknown): void } = {
    id, name, resolvedType, variableCollectionId: coll.id, scopes: ["ALL_SCOPES"], codeSyntax: {}, remote: false, key: "key-" + id, valuesByMode: { ...values },
    setValueForMode(m: string, x: unknown) {
      if (!coll.modes.some((mode) => mode.modeId === m)) throw new Error("in Figma: invalid mode " + m);
      v.valuesByMode = Object.freeze({ ...v.valuesByMode, [m]: x });
    },
  };
  return v;
}

/** A file with a little design system of its own, to update in place: the collection Brand (Light, Dark) with
 *  brand/primary and brand/accent (an alias of primary); a Spacing collection that has space/md too; a paint style
 *  Primary and an effect style Card; a library collection named Core (not local: never matched by name); and a layer
 *  whose fills Figma refuses to change (a batch that patches it fails while applying). */
async function createWorld(extra: Scene = {}) {
  const brand: FakeCollection & Record<string, unknown> = { id: "VariableCollectionId:60:1", key: "brand-coll", name: "Brand", remote: false, isExtension: false,
    modes: [{ modeId: "60:0", name: "Light" }, { modeId: "60:1", name: "Dark" }], defaultModeId: "60:0", variableIds: [] };
  const spacing: FakeCollection = { id: "VariableCollectionId:61:1", name: "Spacing", modes: [{ modeId: "61:0", name: "Default" }], defaultModeId: "61:0" };
  const core: FakeCollection = { id: "VariableCollectionId:lib/9:0", key: "core-coll", name: "Core", modes: [{ modeId: "9:0", name: "Value" }], defaultModeId: "9:0" };
  const primary = variable("VariableID:60:2", "brand/primary", "COLOR", brand, { "60:0": rgba(1, 0, 0), "60:1": rgba(0, 0, 1) });
  const accent = variable("VariableID:60:3", "brand/accent", "COLOR", brand, { "60:0": alias(primary.id), "60:1": alias(primary.id) });
  // Figma's mode API: a new mode starts with each variable's default-mode value; a removed one takes its values along.
  let added = 0;
  const inBrand = (): FakeVariable[] => Object.values(w.scene.variables).filter((v) => v.variableCollectionId === brand.id);
  brand.addMode = (name: string) => {
    const modeId = "60:" + (10 + added++);
    brand.modes = [...brand.modes, { modeId, name }];
    for (const v of inBrand()) v.valuesByMode = { ...v.valuesByMode, [modeId]: v.valuesByMode["60:0"] };
    return modeId;
  };
  brand.removeMode = (modeId: string) => {
    brand.modes = brand.modes.filter((m) => m.modeId !== modeId);
    for (const v of inBrand()) { const rest = { ...v.valuesByMode }; delete rest[modeId]; v.valuesByMode = rest; }
  };
  const gapOther = variable("VariableID:61:2", "space/md", "FLOAT", spacing, { "61:0": 12 });
  const paint: FakeNode = { id: "S:primary,", key: "key-primary", type: "PAINT", name: "Primary", description: "", remote: false,
    paints: Object.freeze([{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]), getStyleConsumersAsync: async () => [] };
  const card: FakeNode = { id: "S:card,", key: "key-card", type: "EFFECT", name: "Card", description: "", remote: false, effects: Object.freeze([]), getStyleConsumersAsync: async () => [] };
  // A layer whose fills Figma refuses to change.
  const stuck: FakeNode = { id: "8:1", type: "RECTANGLE", name: "Stuck", boundVariables: {} };
  const rect: FakeNode = { id: "8:2", type: "RECTANGLE", name: "Rect", fills: [], boundVariables: {} };
  Object.defineProperty(stuck, "fills", { enumerable: true, get: () => [], set: () => { throw new Error("in Figma: cannot set fills"); } });
  const w = await treeWorld({ extra: {
    variables: { [primary.id]: primary, [accent.id]: accent, [gapOther.id]: gapOther },
    collections: { [brand.id]: brand, [spacing.id]: spacing },
    remote: { collections: { [core.id]: core } },
    localStyles: { paint: [paint], effect: [card] },
    styles: { [String(paint.id)]: paint, [String(card.id)]: card },
    nodes: { "8:1": stuck, "8:2": rect },
    ...extra,
  } });
  const byName = (name: string, collId?: string): FakeVariable | undefined => Object.values(w.scene.variables).find((v) => v.name === name && (collId === undefined || v.variableCollectionId === collId));
  const collNamed = (name: string): FakeCollection[] => Object.values(w.scene.collections).filter((c) => c.name === name);
  return { ...w, brand, primary, accent, gapOther, paint, card, byName, collNamed };
}
type CreateWorld = Awaited<ReturnType<typeof createWorld>>;
const write = (w: CreateWorld, ops: WriteOp[]): Promise<WriteResult> => w.api.applyWrites(ops.map((o) => ({ ...o })));
const isImpact = (v: unknown): v is WriteImpactReply => isObj(v) && Array.isArray(v.steps);
async function impact(w: CreateWorld, ops: WriteOp[]): Promise<WriteImpactReply | null> {
  const posted = await w.send({ type: "bridge", id: "imp", cmd: "writeImpact", args: { ops } });
  const r = posted.find((m) => m.type === "bridge-result" && m.id === "imp");
  const result: unknown = r && r.ok ? r.result : null;
  return isImpact(result) ? result : null;
}
const valueIn = (v: FakeVariable | undefined, coll: FakeCollection | undefined, mode: string): unknown => {
  const m = coll?.modes.find((x) => x.name === mode);
  return v && m ? v.valuesByMode[m.modeId] : undefined;
};

/** The token table every case starts from: two modes, primitives and the semantic names that alias them. */
const TOKENS: WriteOp = {
  op: "createVariables", collection: "Tokens", modes: ["Light", "Dark"], variables: [
    ["color/bg", "color", { aliasOf: "gray/0" }, { aliasOf: "gray/900" }], // an alias to rows further down
    ["gray/0", "color", "#ffffff", "#ffffff"],
    ["gray/900", "color", "#111827", "#111827"],
    ["color/brand", "color", "#4f46e5", "#818cf8"],
    ["space/base", "number", 16, 16],
    ["label/cta", "string", "Go", "Go"],
    ["flag/beta", "boolean", false, true],
  ],
};

export const cases: Case[] = [{
  name: "createVariables: the collection, its modes and every variable in one op, aliases inside the table, one undo step",
  async run() {
    const w = await createWorld();
    const commits = w.undo.commits;
    const r = await write(w, [TOKENS]);
    const [coll] = w.collNamed("Tokens");
    const row = r.applied[0];
    ok("[CREATE] one op made the collection, its two modes and seven variables", r.ok && coll !== undefined && same(coll.modes.map((m) => m.name), ["Light", "Dark"])
      && Object.values(w.scene.variables).filter((v) => v.variableCollectionId === coll?.id).length === 7);
    ok("[CREATE] the reply: the collection's id, created, and each row's id with created (compact, in table order)", row?.id === coll?.id && row?.result === "created" && row?.modesAdded === undefined
      && row?.rows?.length === 7 && row.rows.every(([id, what]) => what === "created" && w.scene.variables[id] !== undefined) && w.scene.variables[row.rows[0]?.[0] ?? ""]?.name === "color/bg");
    const bg = w.byName("color/bg", coll?.id), g0 = w.byName("gray/0", coll?.id), g9 = w.byName("gray/900", coll?.id);
    ok("[CREATE] an alias to a row further down the table is a VariableAlias, per mode", same(valueIn(bg, coll, "Light"), alias(g0?.id ?? "")) && same(valueIn(bg, coll, "Dark"), alias(g9?.id ?? "")));
    ok("[CREATE] each type lands as Figma's: COLOR rgba, FLOAT, STRING, BOOLEAN", w.byName("color/brand")?.resolvedType === "COLOR" && same(valueIn(w.byName("gray/900"), coll, "Light"), rgba(0x11 / 255, 0x18 / 255, 0x27 / 255))
      && w.byName("space/base", coll?.id)?.resolvedType === "FLOAT" && valueIn(w.byName("space/base", coll?.id), coll, "Dark") === 16
      && w.byName("label/cta")?.resolvedType === "STRING" && valueIn(w.byName("flag/beta"), coll, "Dark") === true);
    ok("[CREATE] the batch is one undo step (commitUndo before and after)", w.undo.commits === commits + 2);
    // Sent again as it is: nothing changes, and the reply says so row by row.
    const again = await write(w, [TOKENS]);
    ok("[CREATE] re-sent unchanged: the same collection, every row unchanged, nothing duplicated", again.ok && w.collNamed("Tokens").length === 1 && again.applied[0]?.result === "unchanged"
      && again.applied[0]?.rows?.every(([id, what], i) => what === "unchanged" && id === row?.rows?.[i]?.[0]) === true && Object.values(w.scene.variables).filter((v) => v.variableCollectionId === coll?.id).length === 7);
    // Re-sent with a value changed, a mode added and a row added: updated in place, the new ones created.
    const changed = await write(w, [{ op: "createVariables", collection: "Tokens", modes: ["Light", "Dark", "Contrast"], variables: [
      ["color/brand", "color", "#2563eb", "#818cf8", "#1e3a8a"],
      ["space/lg", "number", 24, 24, 32],
    ] }]);
    const rows = changed.applied[0]?.rows ?? [];
    ok("[CREATE] a changed row is updated, a new row created, a new mode added (and named in the reply)", changed.ok && changed.applied[0]?.result === "updated" && same(changed.applied[0]?.modesAdded, ["Contrast"])
      && rows[0]?.[1] === "updated" && rows[0]?.[0] === w.byName("color/brand")?.id && rows[1]?.[1] === "created"
      && same(valueIn(w.byName("color/brand"), coll, "Contrast"), rgba(0x1e / 255, 0x3a / 255, 0x8a / 255)) && valueIn(w.byName("space/lg"), coll, "Contrast") === 32);
    ok("[CREATE] a mode the table leaves out keeps its values (the variables not in the table are untouched)", same(valueIn(bg, coll, "Light"), alias(g0?.id ?? "")));
  },
}, {
  name: "createVariables: names match only this file's own, per collection; a one-mode collection; an existing collection updated",
  async run() {
    const w = await createWorld();
    // The library's collection Core is not local: a local Core is made beside it.
    const core = await write(w, [{ op: "createVariables", collection: "Core", variables: [["size/base", "number", 4]] }]);
    const [mine] = w.collNamed("Core");
    ok("[CREATE] a library collection's name is not matched: a local one is made (one mode, Figma's own)", core.ok && core.applied[0]?.result === "created" && mine !== undefined && mine.id !== "VariableCollectionId:lib/9:0"
      && mine.modes.length === 1 && valueIn(w.byName("size/base", mine.id), mine, mine.modes[0]?.name ?? "") === 4);
    // The local Brand collection: brand/primary updated in place (by name within Brand), a new mode added, space/md made in
    // Brand although Spacing has one by that name.
    const brand = await write(w, [{ op: "createVariables", collection: "Brand", modes: ["Dark", "Light", "Dim"], variables: [
      ["brand/primary", "color", "#000000", "#ff0000", "#333333"],
      ["space/md", "number", 8, 8, 8],
    ] }]);
    const rows = brand.applied[0]?.rows ?? [];
    ok("[CREATE] the local collection by name is reused; its variable by name updated; modes matched by name in any order; a missing one added",
      brand.ok && brand.applied[0]?.id === w.brand.id && brand.applied[0]?.result === "updated" && same(brand.applied[0]?.modesAdded, ["Dim"])
      && rows[0]?.[0] === w.primary.id && rows[0]?.[1] === "updated" && same(w.primary.valuesByMode["60:1"], rgba(0, 0, 0)) && same(w.primary.valuesByMode["60:0"], rgba(1, 0, 0)));
    ok("[CREATE] a name another collection has is a new variable in this one; the other is untouched", rows[1]?.[1] === "created" && w.byName("space/md", w.brand.id) !== undefined && w.gapOther.valuesByMode["61:0"] === 12);
    // A multi-mode collection without `modes`, a type that would change, a mode that matches nothing: refused whole.
    const bad = await write(w, [
      { op: "createVariables", collection: "Brand", variables: [["brand/new", "color", "#ffffff"]] },
      { op: "createVariables", collection: "Spacing", variables: [["space/md", "color", "#ffffff"]] },
    ]);
    ok("[CREATE] refused whole, every problem listed: a two-mode collection needs `modes`; a variable's type cannot change",
      !bad.ok && bad.failedAt === 0 && /'Brand' has 3 modes.*list them in `modes`/.test(bad.error ?? "") && /'space\/md' is a float variable in 'Spacing'.*type cannot change/.test(bad.error ?? ""));
  },
}, {
  name: "createVariables: aliases to the file and across tables; a loop, a type mismatch and an unknown name are refused before anything runs",
  async run() {
    const w = await createWorld();
    const before = Object.keys(w.scene.variables).length;
    const r = await write(w, [
      { op: "createVariables", collection: "Primitives 2", variables: [["blue/500", "color", "#3b82f6"]] },
      { op: "createVariables", collection: "Semantic 2", modes: ["Light", "Dark"], variables: [
        ["link", "color", { aliasOf: "blue/500" }, { aliasOf: "brand/primary" }], // another table's row; a variable of the file
        ["accent", "color", { aliasOf: w.accent.id }, { aliasOf: "link" }], // by id; a row of its own table
      ] },
    ]);
    const link = w.byName("link"), blue = w.byName("blue/500");
    ok("[CREATE] an alias resolves to another table's row, a file variable by name or id, a row of its own table", r.ok && link !== undefined && blue !== undefined
      && same(Object.values(link.valuesByMode), [alias(blue.id), alias(w.primary.id)]) && same(Object.values(w.byName("accent")?.valuesByMode ?? {}), [alias(w.accent.id), alias(link.id)]));
    // brand/primary made to alias a new row that aliases brand/accent, which aliases brand/primary in the file: a loop.
    const loop = await write(w, [{ op: "createVariables", collection: "Brand", modes: ["Light", "Dark"], variables: [
      ["brand/primary", "color", { aliasOf: "brand/x" }, "#000000"],
      ["brand/x", "color", { aliasOf: "brand/accent" }, "#000000"],
    ] }]);
    ok("[CREATE] a loop through the file's aliases is refused, naming it; nothing changed", !loop.ok && /aliases 'brand\/primary' → 'brand\/x' → 'brand\/accent' → 'brand\/primary' make a loop/.test(loop.error ?? "")
      && w.byName("brand/x") === undefined && same(w.primary.valuesByMode["60:1"], rgba(0, 0, 1)));
    const typed = await write(w, [{ op: "createVariables", collection: "Mixed", variables: [["gap", "number", { aliasOf: "brand/primary" }], ["huh", "color", { aliasOf: "brand/primray" }]] }]);
    ok("[CREATE] an alias to a variable of another type, and to a name nothing has (with candidates), refused",
      !typed.ok && /variables\[0\]\[2\]\.aliasOf: variable 'brand\/primary' holds a color, and this field takes a float variable/.test(typed.error ?? "") && /'brand\/primray' matches no variable.*closest: 'brand\/primary'/.test(typed.error ?? "")
      && w.collNamed("Mixed").length === 0);
    // A row of a later table cannot be named: it runs after.
    const later = await write(w, [
      { op: "createVariables", collection: "A", variables: [["a", "color", { aliasOf: "b" }]] },
      { op: "createVariables", collection: "B", variables: [["b", "color", "#000000"]] },
    ]);
    ok("[CREATE] an alias to a row of a later table is refused (put that table first)", !later.ok && /'b' is a row of ops\[1\], which runs after this op/.test(later.error ?? ""));
    ok("[CREATE] none of the refused batches left a variable behind", Object.keys(w.scene.variables).length === before + 3);
  },
}, {
  name: "createVariables: re-sending a table that reverses an alias lands in either row order",
  async run() {
    const w = await createWorld();
    const made = await write(w, [{ op: "createVariables", collection: "Rev", variables: [["a", "number", { aliasOf: "b" }], ["b", "number", 1]] }]);
    const a = w.byName("a"), b = w.byName("b");
    ok("[ORDER] the starting table: a aliases b", made.ok && a !== undefined && b !== undefined && same(Object.values(a.valuesByMode), [alias(b.id)]));
    // b now aliases a and a becomes a value: the row for b first would pass through b → a → b unless a is set first.
    const flip = await write(w, [{ op: "createVariables", collection: "Rev", variables: [["b", "number", { aliasOf: "a" }], ["a", "number", 2]] }]);
    ok("[ORDER] the alias reversed with the aliasing row first: lands, both reported updated", flip.ok && a !== undefined && b !== undefined
      && same(Object.values(b.valuesByMode), [alias(a.id)]) && same(Object.values(a.valuesByMode), [2]) && same(flip.applied[0]?.rows?.map((x) => x[1]), ["updated", "updated"]));
    const back = await write(w, [{ op: "createVariables", collection: "Rev", variables: [["b", "number", 1], ["a", "number", { aliasOf: "b" }]] }]);
    ok("[ORDER] and back, with the value row first: lands", back.ok && a !== undefined && b !== undefined
      && same(Object.values(a.valuesByMode), [alias(b.id)]) && same(Object.values(b.valuesByMode), [1]));
    // A chain that reverses: c → b → a becomes a → b → c, the aliasing rows first (a → b while b still aliases a).
    const chain = await write(w, [{ op: "createVariables", collection: "Rev", variables: [["c", "number", { aliasOf: "b" }], ["b", "number", { aliasOf: "a" }], ["a", "number", 3]] }]);
    const rev = await write(w, [{ op: "createVariables", collection: "Rev", variables: [["a", "number", { aliasOf: "b" }], ["b", "number", { aliasOf: "c" }], ["c", "number", 4]] }]);
    const c = w.byName("c");
    ok("[ORDER] a three-row alias chain reversed: lands", chain.ok && rev.ok && a !== undefined && b !== undefined && c !== undefined
      && same(Object.values(a.valuesByMode), [alias(b.id)]) && same(Object.values(b.valuesByMode), [alias(c.id)]) && same(Object.values(c.valuesByMode), [4]));
  },
}, {
  name: "createVariables: the table's own shape is checked by the dry run, the wire and the plugin alike",
  async run() {
    const w = await createWorld();
    const cases: Array<[WriteOp, RegExp]> = [
      [{ op: "createVariables", collection: "T", modes: ["Light", "Dark"], variables: [["a", "color", "#fff"]] }, /'a' has 1 value, and `modes` lists 2/],
      [{ op: "createVariables", collection: "T", variables: [["a", "colour", "#fff"]] }, /type of 'a' must be one of color \| number \| string \| boolean; closest: 'color'/],
      [{ op: "createVariables", collection: "T", variables: [["a", "number", "#fff"]] }, /a number row takes a number/],
      [{ op: "createVariables", collection: "T", variables: [["a", "color", "#fff"], ["a", "color", "#000"]] }, /'a' is row 0 too/],
      [{ op: "createVariables", collection: "T", variables: [["a", "color", { aliasOf: "b" }], ["b", "color", { aliasOf: "a" }]] }, /the aliases 'a' → 'b' → 'a' make a loop/],
      [{ op: "createVariables", collection: "T", variables: [["a", "color", { aliasOf: "b" }], ["b", "number", 1]] }, /'b' is a number row, and 'a' is a color one/],
      [{ op: "createVariables", collection: "T", modes: ["X", "X"], variables: [["a", "color", "#fff", "#fff"]] }, /'X' is listed twice/],
      [{ op: "createVariables", collection: "T", variables: [] }, /must be a list of rows/],
      [{ op: "createStyles", styles: [{ name: "S", kind: "paint", set: { size: 12 } }] }, /fields are a text style's, and the row says paint/],
      [{ op: "createStyles", styles: [{ name: "S", kind: "text", set: { size: 12, name: "T" } }] }, /a new style is named by the row's `name`/],
      [{ op: "createStyles", styles: [{ name: "S", kind: "paint", set: { paints: [] } }, { name: "S", kind: "paint", set: { paints: [] } }] }, /is styles\[0\] too/],
      [{ op: "createStyles", styles: [{ name: "S", kind: "effect", set: { effects: [{ type: "drop_shadow", color: "#000", offset: { x: 0, y: 1 }, radius: 2, tokens: { blur: "x" } }] } }] }, /\.blur: not a field a variable binds to here; closest: 'color', 'radius'/],
    ];
    for (const [op, want] of cases) {
      const step = writeOpPreview(op, 0);
      const wire = argsShapeError("write", { ops: [op] }) ?? "";
      const r = await write(w, [op]);
      ok(`[CREATE-SHAPE] ${JSON.stringify(op).slice(0, 90)}: refused alike by the dry run, the wire and the plugin`, want.test(step.invalid ?? "") && want.test(wire) && !r.ok && want.test(r.error ?? ""));
    }
    ok("[CREATE-SHAPE] none of them made anything", w.collNamed("T").length === 0 && !Object.values(w.scene.styles).some((s) => isObj(s) && s.name === "S"));
  },
}, {
  name: "createStyles: paint, text and effect styles bound to variables; a name and kind the file has is updated in place",
  async run() {
    const w = await createWorld();
    const r = await write(w, [TOKENS, { op: "createStyles", styles: [
      { name: "Brand", kind: "paint", set: { paints: [{ type: "solid", tokens: { color: "color/brand" } }] } },
      { name: "Body", kind: "text", set: { font: "Inter", weight: "Bold", size: 16, lineHeight: { unit: "percent", value: 150 }, tokens: { fontSize: "space/base" } } },
      { name: "Card", kind: "effect", set: { effects: [{ type: "drop_shadow", color: "#00000040", offset: { x: 0, y: 2 }, radius: 8, tokens: { color: "gray/900", radius: "space/base" } }] } },
      { name: "Primary", kind: "paint", set: { description: "The main colour", paints: [{ type: "solid", color: "#00ff00" }] } },
      { name: "Primary", kind: "text", set: { size: 20 } },
    ] }]);
    const rows = r.applied[1]?.rows ?? [];
    const styleOf = (id: string | undefined): FakeNode | undefined => { const s = id === undefined ? undefined : w.scene.styles[id]; return isObj(s) ? s : undefined; };
    const brand = styleOf(rows[0]?.[0]), body = styleOf(rows[1]?.[0]), card = styleOf(rows[2]?.[0]);
    const brandVar = w.byName("color/brand"), space = w.byName("space/base");
    ok("[STYLES] each row: its id and created / updated (an existing name and kind is updated in place, the same name of another kind made)", r.ok
      && same(rows.map(([, what]) => what), ["created", "created", "updated", "updated", "created"]) && rows[2]?.[0] === w.card.id && rows[3]?.[0] === w.paint.id && rows[4]?.[0] !== w.paint.id);
    const paints = Array.isArray(brand?.paints) ? brand.paints as FakeNode[] : [];
    ok("[STYLES] a paint style's colour is bound to a variable the same batch made", brand?.name === "Brand" && brand.type === "PAINT" && same(paints[0]?.boundVariables, { color: alias(brandVar?.id ?? "") }));
    ok("[STYLES] a text style: its font, size and line height set, its size bound to a number variable of the batch", body?.type === "TEXT" && same(body.fontName, { family: "Inter", style: "Bold" })
      && same(body.lineHeight, { unit: "PERCENT", value: 150 }) && same(body.boundVariables, { fontSize: alias(space?.id ?? "") }));
    const fx = Array.isArray(card?.effects) ? card.effects as FakeNode[] : [];
    ok("[STYLES] an effect's colour and radius bound to variables, as the read writes an effect's tokens", fx[0]?.type === "DROP_SHADOW" && same(fx[0]?.boundVariables, { color: alias(w.byName("gray/900")?.id ?? ""), radius: alias(space?.id ?? "") }));
    ok("[STYLES] the existing paint style changed in place (one style named Primary of each kind)", w.paint.description === "The main colour" && w.scene.localStyles.paint.filter((s) => s.name === "Primary").length === 1);
    const again = await write(w, [{ op: "createStyles", styles: [{ name: "Primary", kind: "paint", set: { description: "The main colour", paints: [{ type: "solid", color: "#00ff00" }] } }] }]);
    ok("[STYLES] re-sent as it is: unchanged", again.ok && same(again.applied[0]?.rows, [[w.paint.id, "unchanged"]]));
  },
}, {
  name: "the ops after the create ops name what they make: a spec, a patch; a source edit of a new name is pointed at its row",
  async run() {
    const w = await createWorld();
    const r = await write(w, [
      TOKENS,
      { op: "createStyles", styles: [{ name: "Heading", kind: "text", set: { weight: "Bold", size: 24 } }] },
      { op: "createTree", tree: { name: "Screen", fills: [{ type: "solid", tokens: { color: "color/bg" } }], tokens: { itemSpacing: "space/base" }, layout: { display: "flex", flexDirection: "column" },
        children: [{ text: "Hello", styles: { text: "Heading" }, fills: [{ type: "solid", tokens: { color: "color/brand" } }] }] } },
      { op: "patch", nodeId: "8:2", set: { fills: [{ type: "solid", tokens: { color: "gray/900" } }] } },
    ]);
    const root = w.alive().find((n) => n.name === "Screen");
    const text = root?.children?.[0];
    const fills = (n: FakeNode | undefined): FakeNode[] => (Array.isArray(n?.fills) ? n.fills as FakeNode[] : []);
    const existing = w.scene.nodes["8:2"];
    ok("[SAME-BATCH] a createTree after the tables binds the new colour and number variables, and the new text style", r.ok
      && same(fills(root)[0]?.boundVariables, { color: alias(w.byName("color/bg")?.id ?? "") }) && same(isObj(root?.boundVariables) ? root.boundVariables.itemSpacing : null, alias(w.byName("space/base")?.id ?? ""))
      && text?.textStyleId === r.applied[1]?.rows?.[0]?.[0] && same(fills(text)[0]?.boundVariables, { color: alias(w.byName("color/brand")?.id ?? "") }));
    ok("[SAME-BATCH] a patch after the tables binds a new variable", same(fills(existing)[0]?.boundVariables, { color: alias(w.byName("gray/900")?.id ?? "") }));
    const w2 = await createWorld();
    const typed = await write(w2, [TOKENS, { op: "createTree", tree: { name: "S", layout: { display: "flex", flexDirection: "column" }, tokens: { itemSpacing: "color/bg" } } }]);
    ok("[SAME-BATCH] a new variable of the wrong type for its field is refused before anything runs", !typed.ok && /'color\/bg' holds a color, and this field takes a float variable/.test(typed.error ?? "") && w2.collNamed("Tokens").length === 0);
    const edit = await write(w2, [TOKENS, { op: "setVariable", variable: "color/brand", values: { Light: "#000000" } }]);
    ok("[SAME-BATCH] a setVariable of a variable the batch makes is pointed at its row", !edit.ok && /'color\/brand' is new in this batch \(ops\[0\] makes it in the new collection 'Tokens'\): give its values in that row/.test(edit.error ?? ""));
    const order = await write(w2, [{ op: "createTree", tree: { name: "S" } }, TOKENS]);
    ok("[SAME-BATCH] a create op after another op is refused: they go first", !order.ok && order.failedAt === 1 && /createVariables goes before every other op of a batch/.test(order.error ?? "") && w2.collNamed("Tokens").length === 0);
    const clash = await write(w2, [{ op: "createVariables", collection: "Other", variables: [["brand/primary", "color", "#000000"]] }, { op: "patch", nodeId: "8:2", set: { fills: [{ type: "solid", tokens: { color: "brand/primary" } }] } }]);
    ok("[SAME-BATCH] a new name the file has elsewhere would match two once the batch runs: refused for the op that names it", !clash.ok && clash.failedAt === 1 && /would match 2 variables once this batch runs/.test(clash.error ?? ""));
  },
}, {
  name: "all or nothing: a failure after the create ops puts back everything they made and changed",
  async run() {
    const w = await createWorld();
    const varsBefore = JSON.stringify(Object.keys(w.scene.variables).sort());
    const modesBefore = JSON.stringify(w.brand.modes);
    const primaryBefore = JSON.stringify(w.primary.valuesByMode);
    const paintBefore = JSON.stringify(w.paint.paints);
    const r = await write(w, [
      TOKENS,
      { op: "createVariables", collection: "Brand", modes: ["Light", "Dark", "Dim"], variables: [["brand/primary", "color", "#000000", "#000000", "#000000"], ["brand/new", "color", "#ffffff", "#ffffff", "#ffffff"]] },
      { op: "createStyles", styles: [{ name: "Primary", kind: "paint", set: { paints: [{ type: "solid", tokens: { color: "color/brand" } }] } }, { name: "New", kind: "effect", set: { effects: [{ type: "layer_blur", radius: 4 }] } }] },
      { op: "patch", nodeId: "8:1", set: { fills: [{ type: "solid", color: "#000000" }] } },
    ]);
    ok("[PUT-BACK] the patch fails while applying: the batch fails there, the create tables are listed as restored", !r.ok && r.failedAt === 3 && r.applied.length === 0 && (r.restored ?? []).length === 3);
    ok("[PUT-BACK] the new collection and its variables are gone; the new variable in Brand is gone; the added mode removed",
      w.collNamed("Tokens").length === 0 && JSON.stringify(Object.keys(w.scene.variables).sort()) === varsBefore && JSON.stringify(w.brand.modes) === modesBefore);
    ok("[PUT-BACK] the updated variable and style have their values back; the new style is gone",
      JSON.stringify(w.primary.valuesByMode) === primaryBefore && JSON.stringify(w.paint.paints) === paintBefore && !w.scene.localStyles.effect.some((s) => s.name === "New"));
    // Past the plan's mode limit: Figma refuses the mode, the error says so, nothing stays.
    const limited = await createWorld({ modeLimit: 1 });
    const lim = await write(limited, [TOKENS]);
    ok("[PUT-BACK] a mode past the file plan's limit: refused naming the mode and the plan, the new collection removed",
      !lim.ok && /Figma refused the mode 'Dark' of 'Tokens': in addMode: Limited to 1 modes only.*plan/.test(lim.error ?? "") && limited.collNamed("Tokens").length === 0 && (lim.restored ?? []).length === 1);
    // Unticked while the batch runs: nothing more changes, and the reply says what stays.
    const off = await createWorld();
    await off.allowEdits(false);
    const refused = await write(off, [TOKENS]);
    ok("[PUT-BACK] with 'Allow edits' off the batch is refused whole", refused.refused === "edits-off" && off.collNamed("Tokens").length === 0);
  },
}, {
  name: "names are the agent's: __proto__, constructor and toString are a collection, modes, variables and styles like any other",
  async run() {
    const w = await createWorld();
    const r = await write(w, [
      { op: "createVariables", collection: "__proto__", modes: ["constructor", "__proto__"], variables: [
        ["__proto__", "color", "#000000", { aliasOf: "toString" }],
        ["toString", "color", "#ffffff", "#ffffff"],
        ["constructor", "number", 1, 2],
        ["hasOwnProperty", "string", "a", "b"],
      ] },
      { op: "createStyles", styles: [{ name: "__proto__", kind: "paint", set: { paints: [{ type: "solid", tokens: { color: "__proto__" } }] } }, { name: "constructor", kind: "text", set: { tokens: { fontSize: "constructor" } } }] },
      { op: "createTree", tree: { name: "toString", fills: [{ type: "solid", tokens: { color: "toString" } }], children: [{ text: "x", styles: { text: "constructor" } }] } },
    ]);
    const [coll] = w.collNamed("__proto__");
    const proto = w.byName("__proto__"), toStr = w.byName("toString");
    ok("[PROTO] the batch lands: a collection named __proto__ with modes constructor and __proto__", r.ok && coll !== undefined && same(coll.modes.map((m) => m.name), ["constructor", "__proto__"]));
    ok("[PROTO] variables named __proto__ / toString / constructor / hasOwnProperty, the alias between them per mode", proto !== undefined && toStr !== undefined && w.byName("constructor")?.resolvedType === "FLOAT"
      && w.byName("hasOwnProperty")?.resolvedType === "STRING" && same(valueIn(proto, coll, "__proto__"), alias(toStr.id)) && same(valueIn(proto, coll, "constructor"), rgba(0, 0, 0)));
    const root = w.alive().find((n) => n.name === "toString");
    const fills = Array.isArray(root?.fills) ? root.fills as FakeNode[] : [];
    ok("[PROTO] styles named __proto__ and constructor, and a spec naming them by those names", w.scene.localStyles.paint.some((s) => s.name === "__proto__") && w.scene.localStyles.text.some((s) => s.name === "constructor")
      && same(fills[0]?.boundVariables, { color: alias(toStr?.id ?? "") }) && root?.children?.[0]?.textStyleId === r.applied[1]?.rows?.[1]?.[0]);
    const again = await write(w, [{ op: "createVariables", collection: "__proto__", modes: ["__proto__"], variables: [["__proto__", "color", { aliasOf: "constructor" }]] }]);
    ok("[PROTO] re-sent by those names: found, not duplicated (an alias of the wrong type refused by name)", !again.ok && /'constructor' holds a float/.test(again.error ?? "") && w.collNamed("__proto__").length === 1);
  },
}, {
  name: "the dry run's file-side half: what a create table would make and what it would update in place",
  async run() {
    const w = await createWorld();
    const ops: WriteOp[] = [
      { op: "createVariables", collection: "Brand", modes: ["Light", "Dark", "Dim"], variables: [["brand/primary", "color", "#000000", "#000000", "#000000"], ["brand/new", "color", "#ffffff", "#ffffff", "#ffffff"]] },
      { op: "createVariables", collection: "Tokens", variables: [["a", "number", 1]] },
      { op: "createStyles", styles: [{ name: "Primary", kind: "paint", set: { paints: [{ type: "solid", color: "#000000" }] } }, { name: "Fresh", kind: "paint", set: { paints: [{ type: "solid", color: "#000000" }] } }] },
      { op: "createVariables", collection: "Bad", variables: [["x", "color", { aliasOf: "nope/nope" }]] },
    ];
    const r = await impact(w, ops);
    const step = (i: number) => r?.steps.find((s) => s.index === i);
    ok("[DRY] an existing collection: the mode to add and the new name to create, the existing name to update", same(step(0)?.plan, { create: ["mode 'Dim'", "brand/new"], update: ["brand/primary"] }));
    ok("[DRY] a new collection: it and its rows to create", same(step(1)?.plan, { create: ["collection 'Tokens'", "a"], update: [] }));
    ok("[DRY] styles: the existing name and kind to update, the new one to create", same(step(2)?.plan, { create: ["Fresh"], update: ["Primary"] }));
    ok("[DRY] a name nothing has: the file's refusal", /'nope\/nope' matches no variable/.test(step(3)?.problem ?? ""));
    ok("[DRY] the dry run changed nothing", w.collNamed("Tokens").length === 0 && w.brand.modes.length === 2 && w.undo.commits === 0);
    const preview = writeOpPreview(TOKENS, 0);
    ok("[DRY] the preview's sentence names the collection, the modes, the counts and an example row", preview.effect === "creates"
      && /^collection 'Tokens' \(modes 'Light', 'Dark'\): 7 variables \(4 color, 1 number, 1 string, 1 boolean\), e\.g\. 'color\/bg' = alias of 'gray\/0' \/ alias of 'gray\/900'/.test(preview.change ?? ""));
  },
}];
