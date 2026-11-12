// The WRITE plane (writes.ts) and parentId.
import { argsShapeError, EDITS_OFF_MESSAGE, WRITE_OP_NAMES, WRITE_OPS, writeOpPreview, type WriteOp, type WriteOpName } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeCollection, FakeNode, Scene } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

// The write targets the plane edits.
const targetsOf = () => {
  const textTarget: FakeNode = { id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }] };
  const rectTarget: FakeNode & { fills: Array<{ color: { g: number } }> } = { id: "r:1", type: "RECTANGLE", name: "Box", fills: [] };
  const groupTarget: FakeNode = { id: "g:1", type: "GROUP", name: "Wrap" }; // no `fills`
  const screenTarget = modeNode("f:1", "Screen");
  return { textTarget, rectTarget, groupTarget, screenTarget };
};

/** A node with ExplicitVariableModesMixin: `explicitVariableModes` keyed by collection id, set and cleared with the
 *  collection OBJECT. The deprecated id-string form throws, as it does under the manifest's documentAccess
 *  "dynamic-page"; a modeId the collection does not have throws, as Figma's does. */
function modeNode(id: string, name: string, start: Record<string, string> = {}): FakeNode & { explicitVariableModes: Record<string, string> } {
  const n = {
    id, type: "FRAME", name, explicitVariableModes: { ...start },
    setExplicitVariableModeForCollection(c: unknown, modeId: string) {
      if (typeof c !== "object" || c === null) throw new Error("setExplicitVariableModeForCollection: pass the collection object (the id string throws under dynamic-page)");
      const coll = c as FakeCollection;
      if (!coll.modes.some((m) => m.modeId === modeId)) throw new Error("invalid mode " + modeId);
      n.explicitVariableModes = { ...n.explicitVariableModes, [coll.id]: modeId };
    },
    clearExplicitVariableModeForCollection(c: unknown) {
      if (typeof c !== "object" || c === null) throw new Error("clearExplicitVariableModeForCollection: pass the collection object");
      const { [(c as FakeCollection).id]: _gone, ...rest } = n.explicitVariableModes;
      n.explicitVariableModes = rest;
    },
  };
  return n;
}

/** The file's variable collections for the mode cases, on top of the base file's ("Primitives", "Semantic"): a Theme
 *  with Light/Dark, two collections both named "Spacing", one whose modes share a name, a library collection the
 *  file already uses (reachable by id only), and one the team library offers but the file does not use. */
const THEME: FakeCollection = { id: "VariableCollectionId:7:1", key: "theme-key", name: "Theme", modes: [{ modeId: "7:0", name: "Light" }, { modeId: "7:1", name: "Dark" }], defaultModeId: "7:0" };
const modeScene = (): Scene => ({
  collections: {
    [THEME.id]: THEME,
    "VariableCollectionId:8:1": { id: "VariableCollectionId:8:1", name: "Spacing", modes: [{ modeId: "8:0", name: "Compact" }], defaultModeId: "8:0" },
    "VariableCollectionId:9:1": { id: "VariableCollectionId:9:1", name: "Spacing", modes: [{ modeId: "9:0", name: "Roomy" }], defaultModeId: "9:0" },
    "VariableCollectionId:10:1": { id: "VariableCollectionId:10:1", name: "Density", modes: [{ modeId: "10:0", name: "Same" }, { modeId: "10:1", name: "Same" }], defaultModeId: "10:0" },
  },
  remote: { collections: { "VariableCollectionId:abc/1:1": { id: "VariableCollectionId:abc/1:1", name: "Shared Theme", modes: [{ modeId: "1:0", name: "Day" }, { modeId: "1:1", name: "Night" }], defaultModeId: "1:0" } } },
  teamLibrary: {
    getAvailableLibraryVariableCollectionsAsync: async () => [{ name: "Brand Colors", key: "lib-brand", libraryName: "Core Library" }],
    getVariablesInLibraryCollectionAsync: async () => [],
  },
});

/** A file the plugin can write to: createFrame/createText record what they made in `created`, fonts load, and the
 *  open page accepts children. `editorType`, when given, is the editor the file is open in. "Allow edits" is
 *  still OFF (its default): a case that applies writes ticks it, the way the window does (`writableOn`). */
function writableWorld(nodes: Record<string, FakeNode>, editorType?: string, clientStorage?: Record<string, unknown>, extra: Scene = modeScene()) {
  const created: FakeNode[] = [];
  const w = world({ ...extra, nodes, ...(editorType !== undefined ? { file: { editorType } } : {}), ...(clientStorage ? { clientStorage } : {}) }, {
    createFrame: () => { const f = { id: "new:frame", type: "FRAME", name: "", fills: [], resize() {}, appendChild() {} }; created.push(f); return f; },
    createText: () => { const t = { id: "new:text", type: "TEXT", characters: "", fills: [], fontName: { family: "Inter", style: "Regular" } }; created.push(t); return t; },
    loadFontAsync: async () => {},
  });
  w.figma.currentPage.appendChild = () => {};
  return { ...w, created };
}
/** writableWorld with "Allow edits" ticked. */
async function writableOn(nodes: Record<string, FakeNode>, editorType?: string) {
  const w = writableWorld(nodes, editorType);
  await w.allowEdits();
  return w;
}

export const cases: Case[] = [{
  name: "WRITE plane (writes.ts)",
  async run() {
    // ---- WRITE plane (writes.ts) ----
    // The two contracts that matter to an agent driving figma_write:
    // a write that didn't happen must NOT report success, and a failed batch must still surface what
    // it already applied (Figma gives no transaction, so the earlier ops are committed for good).
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    const w = await writableOn({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget });
    const { api, created } = w;

    const wOk = await api.applyWrites([{ op: "createFrame", name: "Card", fill: "#ff0000" }, { op: "setText", nodeId: "t:1", text: "new" }]);
    ok("write: successful batch -> ok:true + applied ids", wOk.ok === true && wOk.applied.length === 2 && wOk.applied[0]?.id === "new:frame");
    ok("write: setText actually mutated the node", textTarget.characters === "new");
    ok("write: setFill applies a parsed hex", (await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00ff00" }])).ok === true && Math.round(rectTarget.fills[0]?.color.g ?? NaN) === 1);

    // A missing node must FAIL, not silently report {id} (which would tell the agent it worked).
    const wMissing = await api.applyWrites([{ op: "setFill", nodeId: "nope:1", color: "#fff" }]);
    ok("write: setFill on a missing node fails (not silent success)", wMissing.ok === false && /no node with id/.test(must(wMissing.error, "wMissing.error")));
    const wWrongType = await api.applyWrites([{ op: "setText", nodeId: "r:1", text: "x" }]);
    ok("write: setText on a non-TEXT node fails", wWrongType.ok === false && /not TEXT/.test(must(wWrongType.error, "wWrongType.error")));
    const wNoFills = await api.applyWrites([{ op: "setFill", nodeId: "g:1", color: "#fff" }]);
    ok("write: setFill on a node without fills fails", wNoFills.ok === false && /has no fills/.test(must(wNoFills.error, "wNoFills.error")));

    // A colour that is not hex fails the op (the schema in front of the MCP tool is not the only way in): "red" does not
    // paint #rreedd, an unparseable channel is not 0, and a missing setFill color is not black.
    const fillBefore = created.length;
    const rectFillBefore = rectTarget.fills;
    const wRedFrame = await api.applyWrites([{ op: "createFrame", name: "Red", fill: "red" }]);
    ok("write: createFrame with a colour name fails and names the expected form",
      wRedFrame.ok === false && wRedFrame.failedOp === "createFrame" && /not a valid colour/.test(must(wRedFrame.error, "wRedFrame.error")) && /#1A2B3C/.test(must(wRedFrame.error, "wRedFrame.error")));
    const wBadText = await api.applyWrites([{ op: "createText", text: "x", fill: "#12345" }]);
    ok("write: createText with a malformed fill fails", wBadText.ok === false && /not a valid colour/.test(must(wBadText.error, "wBadText.error")));
    ok("write: a bad fill leaves no node behind", created.length === fillBefore && wRedFrame.applied.length === 0 && wBadText.applied.length === 0);
    const wBadFill = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#gg0000" }]);
    ok("write: setFill with non-hex digits fails and leaves the fills alone", wBadFill.ok === false && /not a valid colour/.test(must(wBadFill.error, "wBadFill.error")) && rectTarget.fills === rectFillBefore);
    const wNoColor = await api.applyWrites([{ op: "setFill", nodeId: "r:1" }]);
    ok("write: setFill without a color fails rather than painting black", wNoColor.ok === false && /missing color/.test(must(wNoColor.error, "wNoColor.error")) && rectTarget.fills === rectFillBefore);
    const wBare = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "ff0000" }]);
    ok("write: a colour without the # fails", wBare.ok === false);
    const wAlpha = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#0000ff80" }]);
    const alphaPaint = rectTarget.fills[0] as { color: { b: number }; opacity?: number } | undefined;
    ok("write: #rrggbbaa still paints the colour with alpha as opacity", wAlpha.ok === true && Math.round(alphaPaint?.color.b ?? NaN) === 1 && Math.abs((alphaPaint?.opacity ?? NaN) - 128 / 255) < 1e-9);
    const wShort = await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#0f0" }]);
    ok("write: #rgb still paints", wShort.ok === true && Math.round(rectTarget.fills[0]?.color.g ?? NaN) === 1);

    // Dev Mode is read-only for plugins (manifest editorType now includes "dev"): the batch is refused
    // up front with the fix, not left to throw an opaque Plugin-API error partway through.
    w.figma.editorType = "dev";
    const wDev = await api.applyWrites([{ op: "createFrame", name: "X" }]);
    const wDevErr = must(wDev.error, "wDev.error");
    ok("write: refused as a whole in Dev Mode, with the fix in the error", wDev.ok === false && wDev.applied.length === 0 && wDev.failedAt === 0 && /Dev Mode/.test(wDevErr) && /Design mode/.test(wDevErr));
    w.figma.editorType = "figma";

    // Partial failure: ops 0-1 are already committed, so their ids must come back with the error.
    const wPartial = await api.applyWrites([
      { op: "createFrame", name: "A" },
      { op: "createText", text: "B" },
      { op: "setFill", nodeId: "missing:9", color: "#fff" },
      { op: "createFrame", name: "never" },
    ]);
    ok("write: partial failure reports ok:false", wPartial.ok === false);
    ok("write: partial failure keeps the applied prefix", wPartial.applied.length === 2);
    ok("write: partial failure reports the failing index + op", wPartial.failedAt === 2 && wPartial.failedOp === "setFill");
    ok("write: ops after the failure are not applied", created.filter((n) => n.name === "never").length === 0);
    ok("write: unknown op is rejected, naming every op", must((await api.applyWrites([{ op: "nope" }])).error, "write nope error") === "`ops[0].op` is not one of createFrame | createText | setFill | setText | setVariableMode | clearVariableMode");
    ok("write: empty/omitted batch is a no-op success", (await api.applyWrites(undefined)).ok === true);

    // One batch is one Cmd-Z step: an undo checkpoint before and after every non-empty batch (a failed one included,
    // since its applied prefix stays in the file), none for an empty one. Without them Figma keeps every plugin
    // action in one undo step, and the designer's first Cmd-Z undid every batch since the plugin started.
    const commitsBefore = w.undo.commits;
    await api.applyWrites([{ op: "setFill", nodeId: "r:1", color: "#00f" }]);
    ok("write: a batch ends its own undo step (checkpoint before and after)", w.undo.commits === commitsBefore + 2);
    await api.applyWrites([{ op: "createFrame", name: "C" }, { op: "setFill", nodeId: "missing:9", color: "#fff" }]);
    ok("write: a failed batch is its own undo step too", w.undo.commits === commitsBefore + 4);
    await api.applyWrites([]);
    ok("write: an empty batch sets no undo checkpoint", w.undo.commits === commitsBefore + 4);

    // A dry run refuses a createText with no `text` ("missing text"), so applying it must refuse it too — not
    // create an empty text node the preview said would never be made.
    const beforeNoText = created.length;
    const wNoText = await api.applyWrites([{ op: "createFrame", name: "first" }, { op: "createText" }]);
    ok("write: createText without text is refused up front, before any op lands",
      wNoText.ok === false && wNoText.failedAt === 1 && wNoText.failedOp === "createText" && /missing text/.test(must(wNoText.error, "wNoText.error"))
      && wNoText.applied.length === 0 && created.length === beforeNoText);
  },
}, {
  name: "one write-op table: the dry run's invalid == the plugin's refusal == the wire's",
  async run() {
    // Every op, complete and then short of each field it sets, through all three readers of commands.ts WRITE_OPS:
    // figma_write's dry-run step (writeOpPreview), the wire check (argsShapeError) and the plugin's applyWrites in the
    // VM. A dry run that refuses what applying accepts (or the reverse) is the drift this table exists to stop.
    const { textTarget, rectTarget, groupTarget, screenTarget } = targetsOf();
    const { api, created } = await writableOn({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "f:1": screenTarget });
    const complete: { [K in WriteOpName]: WriteOp } = {
      createFrame: { op: "createFrame", name: "F", width: 10, height: 10, fill: "#fff" },
      createText: { op: "createText", text: "T", fontSize: 12, fill: "#000" },
      setFill: { op: "setFill", nodeId: "r:1", color: "#00f" },
      setText: { op: "setText", nodeId: "t:1", text: "x" },
      setVariableMode: { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      clearVariableMode: { op: "clearVariableMode", nodeId: "f:1", collection: "Theme" },
    };
    for (const name of WRITE_OP_NAMES) {
      const full = complete[name];
      const fields = Object.keys(full).filter((k) => k !== "op");
      const variants: WriteOp[] = [full, { op: name }, ...fields.map((k) => Object.fromEntries(Object.entries(full).filter(([f]) => f !== k)) as WriteOp)];
      let refusedSome = false;
      for (const v of variants) {
        const step = writeOpPreview(v, 0);
        const before = created.length;
        const applied = await api.applyWrites([{ ...v }]); // spread: the VM api takes the loose fake-figma op shape
        const wire = argsShapeError("write", { ops: [v] });
        const previewValid = step.invalid === undefined;
        refusedSome ||= !previewValid;
        ok(`[WRITE-OPS] ${JSON.stringify(v)}: preview ${previewValid ? "valid" : step.invalid} == plugin ${applied.ok ? "applied" : applied.error} == wire ${wire ?? "ok"}`,
          previewValid === applied.ok && previewValid === (wire === null)
          && (previewValid || (applied.applied.length === 0 && created.length === before && /missing/.test(applied.error ?? ""))));
        ok(`[WRITE-OPS] ${name}: the preview's effect is its row's`, step.effect === WRITE_OPS[name].effect);
      }
      ok(`[WRITE-OPS] ${name}: some variant is refused exactly when the row requires a field`, refusedSome === WRITE_OPS[name].required.length > 0);
    }
  },
}, {
  name: "variable modes (setVariableMode / clearVariableMode): names resolved up front, never guessed, put back on failure",
  async run() {
    const { rectTarget, textTarget } = targetsOf();
    const screen = modeNode("f:1", "Screen");
    const card = modeNode("f:2", "Card", { [THEME.id]: "7:0" });
    const doc: FakeNode = { id: "0:0", type: "DOCUMENT", name: "Document" }; // no ExplicitVariableModesMixin
    const w = await writableOn({ "f:1": screen, "f:2": card, "r:1": rectTarget, "t:1": textTarget, "0:0": doc });
    const { api, created } = w;
    const theme = (): string | undefined => screen.explicitVariableModes[THEME.id];

    // Set by names: the mode lands on the node, and the reply names the mode it replaced.
    const byName = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }]);
    ok("[MODES] set by names: the explicit mode is set and the reply says inherited -> Dark",
      byName.ok === true && theme() === "7:1" && JSON.stringify(byName.applied) === JSON.stringify([{ id: "f:1", collection: "Theme", from: "inherited", to: "Dark" }]));
    // Exact identifiers: the collection's id or key, the mode's modeId.
    const byId = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: THEME.id, mode: "7:0" }]);
    ok("[MODES] set by exact collection id + modeId: Dark -> Light", byId.ok === true && theme() === "7:0" && byId.applied[0]?.from === "Dark" && byId.applied[0]?.to === "Light");
    const byKey = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "theme-key", mode: "Dark" }]);
    ok("[MODES] set by the collection's key", byKey.ok === true && theme() === "7:1");
    // Clear: back to inherited (the collection leaves explicitVariableModes).
    const cleared = await api.applyWrites([{ op: "clearVariableMode", nodeId: "f:1", collection: "Theme" }]);
    ok("[MODES] clear: the explicit mode is gone, the reply says Dark -> inherited",
      cleared.ok === true && !(THEME.id in screen.explicitVariableModes) && cleared.applied[0]?.from === "Dark" && cleared.applied[0]?.to === "inherited");
    // A library collection the file already uses is a VariableCollection, reachable by its exact id.
    const remote = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "VariableCollectionId:abc/1:1", mode: "Night" }]);
    ok("[MODES] a library collection already in the file works by its exact id", remote.ok === true && screen.explicitVariableModes["VariableCollectionId:abc/1:1"] === "1:1");

    // Names that do not resolve refuse the whole batch before anything runs.
    const refused = async (ops: Array<Record<string, unknown>>, label: string, re: RegExp, failedAt = 0): Promise<void> => {
      const before = { ...screen.explicitVariableModes }, made = created.length;
      const r = await api.applyWrites(ops.map((o) => ({ op: "setVariableMode", nodeId: "f:1", ...o })));
      const err = r.error ?? "";
      ok(`[MODES] ${label}: refused whole, nothing changed (${err.split("\n")[0]})`,
        r.ok === false && re.test(err) && r.failedAt === failedAt && r.applied.length === 0 && created.length === made
        && JSON.stringify(screen.explicitVariableModes) === JSON.stringify(before) && /nothing was changed/i.test(err));
    };
    await refused([{ collection: "Them", mode: "Dark" }], "unknown collection, with candidates", /collection 'Them' matches no local variable collection; closest: 'Theme'/);
    const unknownErr = must((await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Zzzzzzzz", mode: "x" }])).error, "unknown");
    ok("[MODES] candidates are at most three", (unknownErr.match(/closest: (.*?)\. Nothing/)?.[1] ?? "").split(", ").length === 3);
    await refused([{ collection: "Spacing", mode: "Compact" }], "ambiguous collection name, listing each with its id",
      /collection 'Spacing' matches 2 local collections — pass one's id: 'Spacing' \(VariableCollectionId:8:1\), 'Spacing' \(VariableCollectionId:9:1\)/);
    await refused([{ collection: "Theme", mode: "Darkk" }], "unknown mode, with candidates", /mode 'Darkk' is not in collection 'Theme'; closest: 'Dark'/);
    await refused([{ collection: "Density", mode: "Same" }], "ambiguous mode name", /mode 'Same' appears 2 times in collection 'Density' — pass its modeId: 'Same' \(10:0\), 'Same' \(10:1\)/);
    await refused([{ collection: "theme", mode: "dark" }], "a case-only match is not taken", /collection 'theme' matches no local variable collection; closest: 'Theme'/);
    await refused([{ collection: "Brand Colors", mode: "Default" }], "a library collection not in the file is refused by name, naming its library",
      /collection 'Brand Colors' is in the library 'Core Library'.*a write cannot import one yet.*bind one of its variables in this file first/);
    await refused([{ nodeId: "gone:1", collection: "Theme", mode: "Dark" }], "missing node", /no node with id 'gone:1'/);
    await refused([{ nodeId: "0:0", collection: "Theme", mode: "Dark" }], "a node type without variable modes, named", /node 'Document' is a DOCUMENT, which cannot carry a variable mode/);
    // Every bad name in the batch, at once; ops before the first bad one are not run either.
    const many = await api.applyWrites([
      { op: "createFrame", name: "never" },
      { op: "setVariableMode", nodeId: "f:1", collection: "Them", mode: "Dark" },
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "clearVariableMode", nodeId: "gone:2", collection: "Spacing" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Dusk" },
    ]);
    const manyErr = must(many.error, "many.error");
    ok("[MODES] every bad name is listed at once and nothing runs, not even the createFrame before them",
      many.ok === false && many.failedAt === 1 && many.failedOp === "setVariableMode" && /^4 problems — nothing was changed:/.test(manyErr)
      && /ops\[1\] \(setVariableMode\): collection 'Them'/.test(manyErr) && /ops\[3\] \(clearVariableMode\): no node with id 'gone:2'/.test(manyErr)
      && /ops\[3\] \(clearVariableMode\): collection 'Spacing' matches 2/.test(manyErr) && /ops\[4\] \(setVariableMode\): mode 'Dusk'/.test(manyErr)
      && !/ops\[2\]/.test(manyErr) && created.every((n) => n.name !== "never") && theme() === undefined);

    // All or nothing: a later op failing puts the mode changes back — to an explicit mode and to inherited alike.
    const madeBefore = created.length;
    const failing = await api.applyWrites([
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "createFrame", name: "Kept" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Dark" },
      { op: "setVariableMode", nodeId: "f:2", collection: "Theme", mode: "Light" },
      { op: "clearVariableMode", nodeId: "f:2", collection: "Theme" },
      { op: "setFill", nodeId: "missing:9", color: "#fff" },
    ]);
    ok("[MODES] a later op failing: every mode change in the batch is put back (inherited stays inherited, Light stays Light)",
      failing.ok === false && failing.failedAt === 5 && theme() === undefined && card.explicitVariableModes[THEME.id] === "7:0");
    ok("[MODES] …the reply lists them as restored, in batch order, and keeps only the createFrame as applied",
      JSON.stringify(failing.applied) === JSON.stringify([{ id: "new:frame" }]) && created.length === madeBefore + 1
      && JSON.stringify((failing.restored ?? []).map((r) => [r.id, r.from, r.to])) === JSON.stringify([["f:1", "inherited", "Dark"], ["f:2", "Light", "Dark"], ["f:2", "Dark", "Light"], ["f:2", "Light", "inherited"]]));
    ok("[MODES] …and the toast says what happened", w.notified.some((t) => /applied 1 edit, then one failed/.test(t)));

    // The same gates as every overwrite: Dev Mode refuses the batch whole, and so does Allow edits off.
    w.figma.editorType = "dev";
    const dev = await api.applyWrites([{ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }]);
    ok("[MODES] Dev Mode: refused whole, mode unchanged", dev.ok === false && /Dev Mode/.test(dev.error ?? "") && theme() === undefined);
    w.figma.editorType = "figma";
    await w.allowEdits(false);
    const off = await api.applyWrites([{ op: "clearVariableMode", nodeId: "f:2", collection: "Theme" }]);
    ok("[MODES] Allow edits off: refused as edits-off, mode unchanged", off.refused === "edits-off" && off.error === EDITS_OFF_MESSAGE && card.explicitVariableModes[THEME.id] === "7:0");

    // Unticked mid-batch, then a later op fails for its own reason (a font load that rejects after the box was
    // unticked): the put-back is a write too, so it does not run — the mode change stays and the reply says so.
    await w.allowEdits(true);
    let reject: (e: Error) => void = () => {};
    w.figma.loadFontAsync = () => new Promise<void>((_res, rej) => { reject = rej; });
    const racing = api.applyWrites([
      { op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" },
      { op: "setText", nodeId: "t:1", text: "late" },
    ]);
    await new Promise((r) => setTimeout(r, 0)); // setText is now waiting on its font
    await w.allowEdits(false);
    const writesBefore = JSON.stringify(screen.explicitVariableModes);
    reject(new Error("font failed to load"));
    const raced = await racing;
    ok("[MODES] unticked, then a later op fails: no put-back runs after consent is off (the mode change stays)",
      raced.ok === false && raced.failedAt === 1 && theme() === "7:1" && JSON.stringify(screen.explicitVariableModes) === writesBefore
      && raced.restored === undefined && raced.applied.length === 1 && raced.applied[0]?.to === "Dark");
    ok("[MODES] …and the error says the earlier mode change stays applied because Allow edits was turned off",
      /font failed to load/.test(raced.error ?? "") && /'Allow edits' was turned off before the batch could put back its 1 earlier variable mode change, so they stay applied/.test(raced.error ?? ""));
    w.figma.loadFontAsync = async () => {};

    // The dry run (built offline by figma_write) says plainly what changes.
    const setStep = writeOpPreview({ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "Dark" }, 0);
    const clearStep = writeOpPreview({ op: "clearVariableMode", nodeId: "f:1", collection: "Theme" }, 1);
    ok("[MODES] dry-run row for a set: an overwrite of the node, collection, new mode and the change in words",
      setStep.effect === "overwrites" && setStep.target === "f:1" && setStep.collection === "Theme" && setStep.newMode === "Dark"
      && /^node f:1: the 'Theme' variable mode goes from its current mode to 'Dark' — the reply names the mode it replaced/.test(setStep.change ?? ""));
    ok("[MODES] dry-run row for a clear: the new mode is 'inherited'",
      clearStep.effect === "overwrites" && clearStep.newMode === "inherited" && /goes from its current mode to inherited/.test(clearStep.change ?? ""));
    // A mode can itself be named "inherited": a set to it is still a set, never described as a clear.
    const namedInherited = writeOpPreview({ op: "setVariableMode", nodeId: "f:1", collection: "Theme", mode: "inherited" }, 0);
    ok("[MODES] dry-run row for a set to a mode NAMED 'inherited' describes a set, not a clear",
      /goes from its current mode to 'inherited' — /.test(namedInherited.change ?? "") && !/whatever its parent uses/.test(namedInherited.change ?? ""));
    ok("[MODES] the other ops' rows carry no mode fields", !("change" in writeOpPreview({ op: "setFill", nodeId: "r:1", color: "#fff" }, 0)));
  },
}, {
  name: "parentId (a silent reparent must not slip through)",
  async run() {
    // ---- parentId (a silent reparent must not slip through) ----
    // The contract mirrors setFill/setText: if the node did NOT land where it was asked to go, the op
    // must fail. Falling back to currentPage and still returning {id} would leave an agent composing a
    // tree with ok:true and a flat pile of nodes on the canvas.
    const parentKids: FakeNode[] = [];
    const containerTarget = { id: "c:1", type: "FRAME", name: "Root", appendChild: (n: FakeNode) => parentKids.push(n) };
    const pageLoads = [];
    const pageTarget = { id: "pg:1", type: "PAGE", name: "Page 2", loadAsync: async () => pageLoads.push("pg:1"), appendChild: (n: FakeNode) => parentKids.push(n) };
    const leafTarget = { id: "lf:1", type: "TEXT", name: "Leaf" }; // no appendChild — cannot hold children
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    // The parentId checks run in the Figma editor with the create/font stubs installed.
    const { api, created } = await writableOn(
      { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget, "c:1": containerTarget, "pg:1": pageTarget, "lf:1": leafTarget }, "figma");

    const pOk = await api.applyWrites([{ op: "createFrame", name: "Child", parentId: "c:1" }]);
    ok("write: valid parentId -> ok:true and the node lands on that parent", pOk.ok === true && parentKids.length === 1 && parentKids[0]?.id === "new:frame");
    ok("write: valid parentId did NOT fall through to currentPage", parentKids[0] === created[created.length - 1]);

    const beforeOrphan = created.length;
    const pMissing = await api.applyWrites([{ op: "createFrame", name: "Orphan", parentId: "gone:99" }]);
    ok("write: unresolvable parentId fails (not silent reparent)", pMissing.ok === false && /not found/.test(must(pMissing.error, "pMissing.error")));
    ok("write: failed parent leaves NO orphan node behind", created.length === beforeOrphan);
    ok("write: failed parent reports nothing as applied", pMissing.applied.length === 0);

    const pLeaf = await api.applyWrites([{ op: "createFrame", parentId: "lf:1" }]);
    ok("write: parent that cannot have children fails", pLeaf.ok === false && /cannot have children/.test(must(pLeaf.error, "pLeaf.error")));

    const pText = await api.applyWrites([{ op: "createText", text: "hi", parentId: "gone:99" }]);
    ok("write: createText honours parentId failure too", pText.ok === false && /not found/.test(must(pText.error, "pText.error")));

    // documentAccess:"dynamic-page" — appendChild on a PageNode throws unless the page is loaded first.
    const pPage = await api.applyWrites([{ op: "createFrame", parentId: "pg:1" }]);
    ok("write: PAGE parent is loadAsync'd before appendChild", pPage.ok === true && pageLoads.length === 1);
  },
}, {
  name: "Allow edits (edits.ts): off by default, refused while off, applied while on, persisted",
  async run() {
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    const nodes = { "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget };
    const w = writableWorld(nodes);
    const batch = [{ op: "createFrame", name: "Card" }, { op: "setText", nodeId: "t:1", text: "changed" }];

    // Default: off — nothing saved, the window is told "off", and whoami (what the dry run reads) says so.
    const asked = await w.send({ type: "get-allow-edits" });
    ok("[EDITS] default is OFF: nothing saved, the window is told allowed:false",
      !w.storage.has("allowEdits") && asked.length === 1 && asked[0]?.type === "allow-edits" && (asked[0] as { allowed?: unknown }).allowed === false);
    const who = await w.send({ type: "bridge", id: "who1", cmd: "whoami", args: {} });
    ok("[EDITS] whoami reports editsAllowed:false by default", (who.find((m) => m.type === "bridge-result")?.result as { editsAllowed?: unknown } | undefined)?.editsAllowed === false);

    // Off: refused whole before any op runs, with the typed refusal and the actionable sentence — through the
    // __designExport surface AND through the bridge's own `write` command (no bypass either way).
    const direct = await w.api.applyWrites(batch);
    ok("[EDITS] refused while off (direct applyWrites): refused:'edits-off', the fix in the error, nothing applied",
      direct.ok === false && direct.refused === "edits-off" && direct.error === EDITS_OFF_MESSAGE && direct.applied.length === 0 && direct.failedAt === undefined);
    const viaBridge = await w.send({ type: "bridge", id: "w1", cmd: "write", args: { ops: batch } });
    const reply = viaBridge.find((m) => m.type === "bridge-result");
    ok("[EDITS] refused while off (bridge `write`): the reply carries the same refusal",
      reply?.ok === true && (reply.result as { refused?: unknown } | undefined)?.refused === "edits-off");
    ok("[EDITS] …and the document was not touched", w.created.length === 0 && textTarget.characters === "old");
    ok("[EDITS] …and the refusal is not silent: a Figma toast and a window notice",
      w.notified.some((t) => /refused an edit request/.test(t) && /Allow edits/.test(t)) && w.posted.some((m) => m.type === "writes" && m.ok === false));
    // A forged value is not consent: only a literal true turns edits on.
    await w.send({ type: "set-allow-edits", allowed: "yes" });
    ok("[EDITS] set-allow-edits with a non-boolean leaves edits off", (await w.api.applyWrites(batch)).refused === "edits-off" && w.created.length === 0);

    // On: applied, saved for next time, and announced.
    w.notified.length = 0;
    const ticked = await w.send({ type: "set-allow-edits", allowed: true });
    ok("[EDITS] ticking it is echoed to the window and saved in clientStorage",
      (ticked[0] as { allowed?: unknown } | undefined)?.allowed === true && w.storage.get("allowEdits") === true);
    const applied = await w.api.applyWrites(batch);
    ok("[EDITS] applied while on", applied.ok === true && applied.refused === undefined && applied.applied.length === 2 && textTarget.characters === "changed");
    ok("[EDITS] …and announced (toast + window notice naming the count)",
      w.notified.some((t) => /applied 2 edits/.test(t)) && w.posted.some((m) => m.type === "writes" && m.ok === true));

    // Cleared again: refused again, and the saved value follows.
    await w.allowEdits(false);
    ok("[EDITS] clearing it refuses the next write and saves false", (await w.api.applyWrites(batch)).refused === "edits-off" && w.storage.get("allowEdits") === false);

    // Unticked WHILE a batch runs (the window's message lands during a font load): the batch stops before the
    // next mutation, keeps the prefix it already applied, and reports the refusal.
    await w.allowEdits(true);
    const textBefore = textTarget.characters;
    let release: () => void = () => {};
    w.figma.loadFontAsync = () => new Promise<void>((res) => { release = res; });
    const racing = w.api.applyWrites([{ op: "createFrame", name: "First" }, { op: "setText", nodeId: "t:1", text: "late" }]);
    await new Promise((r) => setTimeout(r, 0)); // setText is now waiting on its font
    await w.allowEdits(false);
    release();
    const raced = await racing;
    ok("[EDITS] unticked mid-batch: the next mutation is refused, the applied prefix is reported",
      raced.ok === false && raced.refused === "edits-off" && raced.failedAt === 1 && raced.applied.length === 1 && textTarget.characters === textBefore);
    w.figma.loadFontAsync = async () => {};

    // Saved last session: a fresh plugin run reads it before its first write (no tick needed, no start-up race).
    const again = writableWorld(nodes, undefined, { allowEdits: true });
    const first = await again.api.applyWrites([{ op: "createFrame", name: "Next" }]);
    ok("[EDITS] an 'on' saved last session is honoured from the first write", first.ok === true && again.created.length === 1);
    // Anything but a stored `true` reads as off.
    const odd = writableWorld(nodes, undefined, { allowEdits: "true" });
    ok("[EDITS] a stored non-boolean reads as off", (await odd.api.applyWrites(batch)).refused === "edits-off");
  },
}];
