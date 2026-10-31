// The WRITE plane (writes.ts) and parentId.
import { argsShapeError, EDITS_OFF_MESSAGE, WRITE_OP_NAMES, WRITE_OPS, writeOpPreview, type WriteOp, type WriteOpName } from "../../bridge/src/commands.ts";
import { ok } from "../assert.ts";
import { must } from "../fixtures.ts";
import type { FakeNode } from "../fake-figma.ts";
import type { Case } from "./helpers.ts";
import { world } from "./scene.ts";

// The write targets the plane edits.
const targetsOf = () => {
  const textTarget: FakeNode = { id: "t:1", type: "TEXT", name: "Label", characters: "old", fontName: { family: "Inter", style: "Regular" }, getRangeAllFontNames: () => [{ family: "Inter", style: "Regular" }] };
  const rectTarget: FakeNode & { fills: Array<{ color: { g: number } }> } = { id: "r:1", type: "RECTANGLE", name: "Box", fills: [] };
  const groupTarget: FakeNode = { id: "g:1", type: "GROUP", name: "Wrap" }; // no `fills`
  return { textTarget, rectTarget, groupTarget };
};

/** A file the plugin can write to: createFrame/createText record what they made in `created`, fonts load, and the
 *  open page accepts children. `editorType`, when given, is the editor the file is open in. "Allow edits" is
 *  still OFF (its default): a case that applies writes ticks it, the way the window does (`writableOn`). */
function writableWorld(nodes: Record<string, FakeNode>, editorType?: string, clientStorage?: Record<string, unknown>) {
  const created: FakeNode[] = [];
  const w = world({ nodes, ...(editorType !== undefined ? { file: { editorType } } : {}), ...(clientStorage ? { clientStorage } : {}) }, {
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
    ok("write: unknown op is rejected, naming the four", must((await api.applyWrites([{ op: "nope" }])).error, "write nope error") === "`ops[0].op` is not one of createFrame | createText | setFill | setText");
    ok("write: empty/omitted batch is a no-op success", (await api.applyWrites(undefined)).ok === true);

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
    const { textTarget, rectTarget, groupTarget } = targetsOf();
    const { api, created } = await writableOn({ "t:1": textTarget, "r:1": rectTarget, "g:1": groupTarget });
    const complete: { [K in WriteOpName]: WriteOp } = {
      createFrame: { op: "createFrame", name: "F", width: 10, height: 10, fill: "#fff" },
      createText: { op: "createText", text: "T", fontSize: 12, fill: "#000" },
      setFill: { op: "setFill", nodeId: "r:1", color: "#00f" },
      setText: { op: "setText", nodeId: "t:1", text: "x" },
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

    // Saved last session: a fresh plugin run reads it before its first write (no tick needed, no start-up race).
    const again = writableWorld(nodes, undefined, { allowEdits: true });
    const first = await again.api.applyWrites([{ op: "createFrame", name: "Next" }]);
    ok("[EDITS] an 'on' saved last session is honoured from the first write", first.ok === true && again.created.length === 1);
    // Anything but a stored `true` reads as off.
    const odd = writableWorld(nodes, undefined, { allowEdits: "true" });
    ok("[EDITS] a stored non-boolean reads as off", (await odd.api.applyWrites(batch)).refused === "edits-off");
  },
}];
