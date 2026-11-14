// Writes (code -> design): minimal, EXPLICIT, safe command set (no eval).
import { errMsg } from "./util";
import { ifDefined } from "../../bridge/src/json-util.ts";
import { parseHexColor, HEX_COLOR_HINT } from "../../bridge/src/hex-color.ts";
import { EDITS_OFF_MESSAGE, rejectedMessage, unreviewedMessage, writeOpError, type AppliedWrite, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { REVIEW_WAIT_MS } from "../../bridge/src/timeouts.ts";
import { editsAllowed, editsAllowedNow } from "./edits";
import { awaitReview, reviewWrites, type ReviewOutcome } from "./review";
import { applyMode, resolveModeOps, type ModeTarget } from "./variable-modes";
import { buildTree, resolveTreeOps, type TreeTarget } from "./tree";
import { applyUpdate, checkRemoval, removalCount, removalsOf, resolveKeyed, touchedBy } from "./keyed";
import { applyPatch, changesBefore, keepText, resolvePatchOps, type PatchTarget } from "./patch";
import { markCreated } from "./session";
import { applyStyle, applyVariable, resolveSourceOps, type StyleTarget, type VariableTarget } from "./sources";
import { applyCreates, CreateFailed, isCreateOp, resolveCreateOps } from "./creates";
import { setBatchPlan } from "./batch-plan";
import { applyDelete, applyMove, checkDelete, idsDeletedWith, resolveStructureOps, type DeleteTarget, type MoveTarget } from "./structure";
import { batchRefusal, countChanges, restoreChanges, RestoreStopped, type Change, type OpProblem } from "./write-batch";
import type { WritesMsg } from "./messages";

// Hex colours (#rgb, #rgba, #rrggbb, #rrggbbaa) are the only form accepted; the 4th pair is alpha,
// which Figma carries as paint.opacity (not in .color). Anything else throws, so the batch reports
// the failed op instead of painting a wrong colour: a write can arrive from any bridge client, not only
// through the MCP schema.
function solidPaint(hex: string | undefined, what: string): SolidPaint {
  const c = parseHexColor(hex);
  if (!c) throw new Error(what + ": '" + String(hex) + "' is not a valid colour — expected " + HEX_COLOR_HINT);
  const p: { type: "SOLID"; color: RGB; opacity?: number } = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
  if (c.a !== undefined) p.opacity = c.a;
  return p;
}

// Load every font a text node uses before mutating .characters — node.fontName is figma.mixed for
// multi-font text, and loadFontAsync(figma.mixed) throws.
async function loadNodeFonts(node: TextNode): Promise<void> {
  const len = node.characters.length;
  const fonts = len > 0 ? node.getRangeAllFontNames(0, len) : node.fontName !== figma.mixed ? [node.fontName] : [];
  await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
}

// Resolve an explicit parentId to a container, or throw. Same contract as setFill/setText below: a
// write that didn't land where it was asked to must NOT report success.
//
// This is resolved BEFORE the node is created, deliberately. getNodeByIdAsync resolves to null for an
// invalid or removed id — and for invisible instance children when skipInvisibleInstanceChildren is
// on (which the design-system read toggles) — so a stale id is ordinary, not exotic. The old code
// silently fell back to currentPage: an agent composing a tree (createFrame root -> createFrame
// parentId:root -> children) got ok:true and a flat pile of nodes on the canvas. Validating first
// also means a bad parent fails WITHOUT leaving an orphan node the caller can't see in `applied`.
async function resolveParent(parentId?: string): Promise<ChildrenMixin & BaseNode> {
  if (!parentId) return figma.currentPage;
  const p = await figma.getNodeByIdAsync(parentId);
  if (!p) throw new Error("parent '" + parentId + "' not found (invalid or removed id)");
  if (!("appendChild" in p)) throw new Error("parent '" + p.name + "' (" + p.type + ") cannot have children");
  for (let a: BaseNode | null = p; a; a = a.parent) {
    if (a.type === "INSTANCE") throw new Error("parent '" + p.name + "' is " + (a === p ? "an instance" : "inside the instance '" + a.name + "'") + ", which cannot take new children");
  }
  // manifest documentAccess is "dynamic-page": appendChild on a PageNode requires the page to be
  // loaded first, or it throws. The read plane already does this (collect.ts / components.ts).
  if (p.type === "PAGE") await p.loadAsync();
  return p as ChildrenMixin & BaseNode;
}

// WriteOp (the args of one op), AppliedWrite and WriteResult are the bridge's wire contract, so they
// are imported from it rather than re-declared here. WriteOp's optionals are `T | undefined`;
// applyWrite tests each for truthiness / `!= null`, so absent and undefined behave the same. applyWrites
// has already checked every op against its WRITE_OPS row (a known op, typed fields, the required ones
// present); the default branch below still refuses anything else, as a last line.
// The designer can untick "Allow edits" while a batch is running: the window's message is handled at any await
// below (a node lookup, a font load). So consent is re-checked right before each mutation, not only once per
// batch, and a revoked one stops the batch there (gatedWrites reports the applied prefix as refused).
class EditsRevoked extends Error {}
function consent(): void {
  if (!editsAllowedNow()) throw new EditsRevoked("'Allow edits' was turned off in the Design Twin plugin partway through this batch — the ops before this one were applied. Tick 'Allow edits' in the plugin window, then retry the rest.");
}

// What an op resolved to before the batch ran: a variable-mode op's node/collection/mode (variable-modes.ts
// resolveModeOps), a createTree op's page and fonts (tree.ts resolveTreeOps), a patch's node and names (patch.ts
// resolvePatchOps), a move's node and new parent (structure.ts).
interface Resolved {
  mode?: ModeTarget | undefined; tree?: TreeTarget | undefined; patch?: PatchTarget | undefined; move?: MoveTarget | undefined;
  variable?: VariableTarget | undefined; style?: StyleTarget | undefined;
}

/** A node an op just created, as a Change whose undo removes it. */
function createdNode(n: SceneNode): Change {
  markCreated(n);
  return { applied: { id: n.id }, kind: "created node", what: "the new node '" + n.name + "' (" + n.id + ")", restore() { n.remove(); } };
}

// Every op that changes the file pushes the Change it made onto `changes` (a node created, a value overwritten, a mode
// set, a tree built, a node moved), so a later failure can undo all of them.
async function applyWrite(op: WriteOp, { mode, tree, patch, move, variable, style }: Resolved, changes: Change[]): Promise<AppliedWrite> {
  switch (op.op) {
    case "createFrame": {
      const parent = await resolveParent(op.parentId); // before createFrame — no orphan on a bad parent
      const fill = op.fill ? solidPaint(op.fill, "createFrame fill") : null; // likewise: a bad colour leaves no node
      consent();
      const f = figma.createFrame();
      // On the list before anything else can throw: a failure below removes the node with the rest of the batch.
      const change = createdNode(f);
      changes.push(change);
      if (op.name) f.name = op.name;
      if (op.width && op.height) f.resize(op.width, op.height);
      if (op.layoutMode) f.layoutMode = op.layoutMode; // HORIZONTAL | VERTICAL
      if (op.itemSpacing != null) f.itemSpacing = op.itemSpacing;
      if (op.padding) {
        f.paddingTop = op.padding[0];
        f.paddingRight = op.padding[1];
        f.paddingBottom = op.padding[2];
        f.paddingLeft = op.padding[3];
      }
      if (fill) f.fills = [fill];
      parent.appendChild(f);
      return change.applied;
    }
    case "createText": {
      const parent = await resolveParent(op.parentId); // before createText — no orphan on a bad parent
      const fill = op.fill ? solidPaint(op.fill, "createText fill") : null; // likewise: a bad colour leaves no node
      consent();
      const t = figma.createText();
      const change = createdNode(t);
      changes.push(change);
      try { await figma.loadFontAsync(t.fontName as FontName); } catch (e) {
        // The font did not load: take back the empty node (unless edits are off by now: then it stays, and is reported).
        if (editsAllowedNow()) { t.remove(); changes.pop(); }
        throw e;
      }
      // Revoked during the font load: take back the empty node this op just made, so it leaves nothing.
      if (!editsAllowedNow()) { t.remove(); changes.pop(); consent(); }
      t.characters = op.text || "";
      if (op.fontSize) t.fontSize = op.fontSize;
      if (fill) t.fills = [fill];
      parent.appendChild(t);
      return change.applied;
    }
    // setFill/setText THROW rather than no-op. getNodeByIdAsync resolves to null for an invalid or
    // removed id (and for invisible instance children when skipInvisibleInstanceChildren is on), and
    // not every node type carries fills/characters. Returning {id} in those cases reported a write
    // that never happened — over MCP the agent reads that as success and builds on a false premise.
    case "setFill": {
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) throw new Error("setFill: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (!("fills" in nd)) throw new Error("setFill: node '" + nd.name + "' (" + nd.type + ") has no fills");
      const paint = solidPaint(op.color, "setFill color");
      consent();
      // A text's paints and paint-style links can differ from run to run even when the paints look the same: kept run by
      // run (keepText loads the fonts that needs).
      if (nd.type === "TEXT") {
        const restore = await keepText(nd);
        consent();
        nd.fills = [paint];
        const change: Change = { applied: ifDefined("id", op.nodeId), kind: "fill change", what: "the fill of '" + nd.name + "' (" + nd.id + ")", restore };
        changes.push(change);
        return change.applied;
      }
      const target = nd as SceneNode & MinimalFillsMixin;
      const old = target.fills;
      const oldStyle = target.fillStyleId;
      target.fills = [paint];
      const change: Change = {
        applied: ifDefined("id", op.nodeId), kind: "fill change", what: "the fill of '" + nd.name + "' (" + nd.id + ")",
        // The paints, then the paint style they came from (setting paints detaches it).
        async restore(allowed) {
          target.fills = old;
          if (typeof oldStyle === "string" && oldStyle && target.fillStyleId !== oldStyle) {
            await target.setFillStyleIdAsync(oldStyle);
            if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off");
          }
        },
      };
      changes.push(change);
      return change.applied;
    }
    case "setText": {
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
      await loadNodeFonts(nd);
      consent();
      const restore = await keepText(nd);
      consent();
      nd.characters = op.text || "";
      const change: Change = { applied: ifDefined("id", op.nodeId), kind: "text change", what: "the text of '" + nd.name + "' (" + nd.id + ")", restore };
      changes.push(change);
      return change.applied;
    }
    // Resolved up front with the rest of the batch: here the target is known to exist and the names to match.
    case "setVariableMode":
    case "clearVariableMode": {
      if (!mode) throw new Error(op.op + ": the op was not resolved before the batch ran");
      consent();
      const change = applyMode(mode);
      changes.push(change);
      return change.applied;
    }
    // Resolved up front: its page exists, its fonts are loaded and its names resolved, so the build makes every node
    // without an await; only setting text styles awaits, and consent is checked after each (tree.ts buildTree). The
    // tree lands whole or not at all.
    case "createTree": {
      if (!tree) throw new Error("createTree: the op was not resolved before the batch ran");
      consent();
      // A key the file already has a result for: that result is updated in place (keyed.ts); its changes go on the list
      // one by one, as they land.
      if (tree.update) return applyUpdate(tree, tree.update, consent, editsAllowedNow, changes);
      const change = await buildTree(tree, consent);
      changes.push(change);
      return change.applied;
    }
    // Resolved up front: the node exists and has every field, the names resolved and the fonts loaded. The values it
    // replaces are kept; it puts itself back if it throws partway (patch.ts).
    case "patch": {
      if (!patch) throw new Error("patch: the op was not resolved before the batch ran");
      consent();
      return (await applyPatch(patch, consent, editsAllowedNow, changes)).applied;
    }
    case "move": {
      if (!move) throw new Error("move: the op was not resolved before the batch ran");
      consent();
      const change = applyMove(move);
      changes.push(change);
      return change.applied;
    }
    // Source edits (sources.ts), resolved up front: a local variable or style, its modes, values, fonts and names. Each
    // keeps what it replaces and puts itself back if it throws partway.
    case "setVariable": {
      if (!variable) throw new Error("setVariable: the op was not resolved before the batch ran");
      consent();
      const change = applyVariable(variable, consent);
      changes.push(change);
      return change.applied;
    }
    case "setStyle": {
      if (!style) throw new Error("setStyle: the op was not resolved before the batch ran");
      consent();
      const change = await applyStyle(style, consent);
      changes.push(change);
      return change.applied;
    }
    // Deletes are not run here: gatedWrites runs them after every other op (a deleted node cannot be brought back).
    case "delete":
      throw new Error("delete: deletes run after the rest of the batch");
    // Nor are the create tables: gatedWrites runs them before every other op (creates.ts applyCreates).
    case "createVariables":
    case "createStyles":
      throw new Error(op.op + ": the create tables run before the rest of the batch");
    default:
      throw new Error("unknown write op: " + op.op);
  }
}

// Apply a batch whole or not at all (docs/write-plane-spec.md decisions 14, 16). Everything is resolved before the
// first op runs; then each op keeps what it replaces, and when op N fails the changes of ops 0..N-1 are put back, newest
// first — values restored, nodes the batch created removed, moved nodes returned — and listed as `restored`. Deletes run
// last, once everything else has landed, since a deleted node cannot be brought back. `applied` lists only what stays:
// all of it on success; on a failure, whatever could not be put back (the designer turned "Allow edits" off, or a
// restore failed), so the caller can always find what is in the file.
export async function applyWrites(ops: WriteOp[]): Promise<WriteResult> {
  const list = Array.isArray(ops) ? ops : [];
  // One batch is one Cmd-Z step. Figma keeps every plugin action in a single undo step until commitUndo(), so
  // without these the designer's first Cmd-Z undid every batch since the plugin started (seen live: it removed a
  // frame an earlier batch had created). Commit before, so the batch never joins earlier work, and after, so
  // the next one never joins it. Committing with nothing pending is a no-op.
  if (list.length) commitUndo();
  const r = await gatedWrites(list);
  if (list.length) commitUndo();
  announce(r);
  return r;
}

function commitUndo(): void {
  try { figma.commitUndo(); } catch (e) { console.error("[export] figma.commitUndo failed:", e); }
}

// A write is never silent: whatever changed the file (or was refused from changing it) is said in Figma's own
// toast AND on the plugin window's status line (ui.template.html `writes`). An empty batch changed nothing and
// says nothing.
function announce(r: WriteResult): void {
  const n = r.applied.length;
  const edits = n + " edit" + (n === 1 ? "" : "s");
  let text: string | null = null;
  if (r.refused === "edits-off") text = n
    ? "Design Twin applied " + edits + ", then stopped — 'Allow edits' was turned off."
    : "Design Twin refused an edit request — 'Allow edits' is off.";
  else if (r.refused === "rejected") text = "Design Twin did not apply the edit request — it was rejected. Nothing changed.";
  else if (r.refused === "unreviewed") text = "Design Twin did not apply an edit request: " + (r.error || "nobody reviewed it.");
  else if (r.ok && n) text = "Design Twin applied " + edits + " to this file.";
  else if (!r.ok && n) text = "Design Twin applied " + edits + " that could not be put back after one failed: " + (r.error || "unknown error");
  else if (!r.ok && r.restored && r.restored.length) text = "Design Twin undid " + r.restored.length + " earlier change" + (r.restored.length === 1 ? "" : "s") + " after an edit failed: " + (r.error || "unknown error");
  if (text === null) return;
  try { figma.notify(text, r.ok ? undefined : { error: true }); } catch (e) { console.error("[export] figma.notify failed:", e); }
  const m: WritesMsg = { type: "writes", applied: n, ok: r.ok, text };
  figma.ui.postMessage(m);
}

// The plan of what the batch's create ops make (batch-plan.ts) lives exactly as long as the batch.
async function gatedWrites(list: WriteOp[]): Promise<WriteResult> {
  try { return await batchWrites(list); } finally { setBatchPlan(null); }
}

async function batchWrites(list: WriteOp[]): Promise<WriteResult> {
  const applied: AppliedWrite[] = [];
  // The designer's consent (edits.ts): with "Allow edits" off the whole batch is refused before any op is
  // checked or run, with the refusal named so figma_write can tell the agent to ask the person at the window.
  // First, so it is the answer whatever else is wrong. Here, not in bridge.ts, so every caller of applyWrites —
  // the __designExport test surface included — meets the same gate.
  if (list.length && !(await editsAllowed())) {
    return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
  }
  // Dev Mode (manifest editorType "dev") is read-only: every op below would throw its own opaque
  // Plugin-API error, the first one partway into the batch. Refuse the whole batch up front, with the
  // fix, in the same shape a mid-batch failure reports.
  if (list.length && figma.editorType === "dev") {
    const first = list[0];
    return {
      ok: false,
      applied,
      failedAt: 0,
      ...ifDefined("failedOp", first && first.op),
      error: "the file is open in Dev Mode, which is read-only for plugins — switch to Design mode (Shift+D) and re-run the plugin to write. Reads and exports work in Dev Mode.",
    };
  }
  // Every op is checked against its WRITE_OPS row (commands.ts writeOpError, the row figma_write's dry run reads)
  // BEFORE the first one runs: a batch the preview calls invalid is refused whole, never half-applied up to its bad
  // op. Over the bridge, handleBridge has already refused such a batch with the same check (parseCommandRequest);
  // this is that check for the callers that reach applyWrites directly (the __designExport surface, the harness).
  for (const [i, op] of list.entries()) {
    const bad = writeOpError(op, i);
    if (bad !== null) return { ok: false, applied, failedAt: i, ...ifDefined("failedOp", op && op.op), error: bad };
  }
  // Every name an op carries is resolved against the file before the first op runs (spec decisions 14, 15): a
  // collection, mode, page, component, variable or style that matches nothing or several things, a missing node, a node
  // that cannot take a field, a font that does not load, a node this session did not create — the batch is refused
  // whole, every problem listed in op order.
  const resolveBatch = async () => {
    // The create tables first (they run first): what they make is the plan the other ops' names resolve against.
    setBatchPlan(null);
    const creates = await resolveCreateOps(list);
    setBatchPlan(creates.plan);
    const modes = await resolveModeOps(list);
    const trees = await resolveTreeOps(list);
    // A createTree whose key names a result the file holds becomes an update of it (keyed.ts).
    const keyed = await resolveKeyed(list, trees.targets);
    const patches = await resolvePatchOps(list);
    const structure = await resolveStructureOps(list, (i) => changesBefore(list, i));
    // A variable or style edit, and a patch's library check (a library's component cannot be changed here).
    const sources = await resolveSourceOps(list);
    const problems = [...creates.problems, ...modes.problems, ...trees.problems, ...keyed.problems, ...patches.problems, ...structure.problems, ...sources.problems, ...deleteConflicts(list, structure.deletes, structure.moves),
      ...removalConflicts(list, trees.targets, structure.moves), ...keyedDeleteConflicts(trees.targets, structure.deletes, structure.moves)].sort((a, b) => a.index - b.index);
    return { creates, modes, trees, patches, structure, sources, problems };
  };
  let { creates, modes, trees, patches, structure, sources, problems } = await resolveBatch();
  const firstProblem = problems[0];
  if (firstProblem) return { ok: false, applied, failedAt: firstProblem.index, failedOp: firstProblem.op, error: batchRefusal(problems) };
  // The designer's review (review.ts, spec decision 18), when "Review each write" is ticked: here, once the whole batch
  // resolved (a batch that would be refused never puts a card up) and before anything touches the file (the library
  // imports below included). Anything but Apply refuses the batch whole, saying why.
  if (list.length && (await reviewWrites())) {
    // Unticked while the batch resolved: refused now, with no card (main.ts ends only a card that is already up).
    if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    const review = await awaitReview(list);
    if (review.end !== "approved") return reviewRefusal(review);
    // Unticked while the card was up: main.ts ends the card as edits-off then, and this is the same check for a click
    // that raced it.
    if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    // The designer may have changed the file while the card was up (a node removed, a binding added), so nothing
    // resolved before the wait is used: the batch is resolved again against the file as it is now, and what a
    // failure puts back is what is there now. A batch the file no longer accepts is refused whole, as before review.
    ({ creates, modes, trees, patches, structure, sources, problems } = await resolveBatch());
    const changed = problems[0];
    if (changed) return { ok: false, applied, failedAt: changed.index, failedOp: changed.op, error: "the file changed while the write waited for review: " + batchRefusal(problems) };
    if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    // The batch is still one Cmd-Z step of its own: whatever happened while the card was up is not part of it.
    commitUndo();
  }
  const changes: Change[] = [];
  // In op order: each op's applied row, filled as it lands (the deletes last).
  const rows: Array<AppliedWrite | undefined> = list.map(() => undefined);
  const fail = async (i: number, op: WriteOp, e: unknown): Promise<WriteResult> => {
    const revoked = e instanceof EditsRevoked;
    // Undo the changes this batch made (newest first). Not when the designer has turned edits off — whether that is
    // what stopped the batch or the op failed for its own reason after the box was unticked (a font load that rejects
    // late): after that the plugin changes nothing, not even to undo its own work, and the reply says what stayed.
    const off = revoked || !editsAllowedNow();
    const { restored, failed } = off ? { restored: [], failed: [] } : await restoreChanges(changes, editsAllowedNow);
    const back = new Set(restored);
    const kept = !revoked && off && changes.length
      ? "; 'Allow edits' was turned off before the batch could put back its " + countChanges(changes) + ", so they stay applied"
      : "";
    return {
      ok: false,
      // What stays: every change not put back (a patch stopped partway included), and the deletes already run.
      applied: [...changes.filter((c) => !back.has(c)).map((c) => c.applied), ...rows.filter((a): a is AppliedWrite => a !== undefined && a.deleted === true)],
      failedAt: i,
      failedOp: op && op.op,
      error: errMsg(e) + (failed.length ? "; " + failed.join("; ") : "") + kept,
      ...(revoked ? { refused: "edits-off" as const } : {}),
      ...(restored.length ? { restored: restored.map((c) => c.applied).reverse() } : {}),
    };
  };
  // A problem the imports reveal once the create tables have run: those are put back, and the batch is refused whole.
  const refuseLate = async (late: OpProblem[]): Promise<WriteResult> => {
    const firstLate = late[0];
    const { restored, failed } = await restoreChanges(changes, editsAllowedNow);
    const back = new Set(restored);
    return {
      ok: false, applied: changes.filter((c) => !back.has(c)).map((c) => c.applied),
      ...(firstLate ? { failedAt: firstLate.index, failedOp: firstLate.op } : {}),
      error: batchRefusal(late) + (failed.length ? "; " + failed.join("; ") : ""),
      ...(restored.length ? { restored: restored.map((c) => c.applied).reverse() } : {}),
    };
  };
  // Unticked once the create tables ran: nothing more changes, not even to put them back, and the reply says what stays.
  const revokedAfterCreates = (): WriteResult => ({
    ok: false, applied: changes.map((c) => c.applied), refused: "edits-off",
    error: "'Allow edits' was turned off in the Design Twin plugin once this batch's create tables had run: they stay applied (listed in `applied`), and nothing else ran. Tick 'Allow edits' in the plugin window, then retry the rest.",
  });
  // The create tables run first (creates.ts), before the other ops' imports: a name they make is what those resolve to.
  // The library variables the tables themselves name are imported just before them.
  if (creates.targets.size) {
    if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    if (creates.importCount) {
      const { problems: late, revoked } = await creates.imports(editsAllowedNow);
      if (revoked) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const firstLate = late[0];
      if (firstLate) return { ok: false, applied, failedAt: firstLate.index, failedOp: firstLate.op, error: batchRefusal(late) };
    }
    try {
      for (const [i, row] of await applyCreates(creates, consent, changes)) rows[i] = row;
    } catch (e) {
      const at = e instanceof CreateFailed ? e.index : list.findIndex(isCreateOp);
      const op = list[at];
      if (op) return fail(at, op, e instanceof CreateFailed ? e.reason : e);
      throw e;
    }
  }
  // A library item a spec or patch names by key (or a library variable it names) is imported only now: the whole batch
  // resolved, and "Allow edits" is still on (the window may have changed it at any await above). An import cannot be
  // put back, but it only makes the item available in the file; a problem it reveals still refuses the whole batch.
  // (A name a create table made resolves here too, as an import: tree-refs.ts.)
  for (const step of [trees, patches, sources]) {
    if (!step.importCount) continue;
    if (!editsAllowedNow()) return changes.length ? revokedAfterCreates() : { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    const { problems: late, revoked } = await step.imports(editsAllowedNow);
    // Unticked between imports: the ones before stay (an import cannot be put back, and it only makes the item
    // available), nothing else runs.
    if (revoked) return changes.length ? revokedAfterCreates() : { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    if (late.length) return refuseLate(late);
  }
  const warnings = [...trees.targets].reduce<string[]>((all, [i, t]) => all.concat(t.summary.warnings.map((w) => "ops[" + i + "]." + w)), []);
  for (const [i, op] of list.entries()) {
    if (op.op === "delete" || isCreateOp(op)) continue;
    try {
      rows[i] = await applyWrite(op, {
        mode: modes.targets.get(i), tree: trees.targets.get(i), patch: patches.targets.get(i), move: structure.moves.get(i),
        variable: sources.variables.get(i), style: sources.styles.get(i),
      }, changes);
    } catch (e) {
      return fail(i, op, e);
    }
  }
  // Every delete is checked before the first one runs: a deleted node cannot be brought back, so a check that fails
  // must fail while the batch can still be put back whole.
  for (const [i, t] of structure.deletes) {
    const op = list[i];
    if (!op) continue;
    try { checkDelete(t); } catch (e) { return fail(i, op, e); }
  }
  // …and so is every node a keyed re-send removes (it must still hold only what its key built), before any delete runs.
  for (const [i, t] of trees.targets) {
    const op = list[i];
    if (!op || !t.update) continue;
    try { for (const n of removalsOf(t.update)) checkRemoval(t.update, n); } catch (e) { return fail(i, op, e); }
  }
  for (const [i, t] of structure.deletes) {
    const op = list[i];
    if (!op) continue;
    try {
      consent();
      rows[i] = applyDelete(t);
    } catch (e) {
      const r = await fail(i, op, e);
      const gone = rows.filter((a): a is AppliedWrite => a !== undefined && a.deleted === true).length;
      return gone ? { ...r, error: r.error + "; " + gone + " node(s) deleted before it cannot be brought back" } : r;
    }
  }
  // The nodes a keyed re-send no longer has (or built anew) go last, with the deletes: a removed node cannot be brought back.
  for (const [i, t] of trees.targets) {
    const op = list[i];
    if (!op || !t.update) continue;
    // The reply counts what is removed now, after every other op (a later op may have moved a node out).
    const row = rows[i];
    if (row) { const n = removalCount(t.update); if (n) row.removed = n; else delete row.removed; }
    try {
      for (const n of removalsOf(t.update)) {
        if (n.removed) continue;
        consent();
        n.remove();
      }
    } catch (e) {
      return fail(i, op, e);
    }
  }
  const done: AppliedWrite[] = rows.filter((a): a is AppliedWrite => a !== undefined);
  return { ok: true, applied: done, ...(warnings.length ? { warnings } : {}) };
}

/** A batch the review did not apply, refused whole: nothing in the file changed. */
function reviewRefusal(o: ReviewOutcome): WriteResult {
  if (o.end === "rejected") return { ok: false, applied: [], refused: "rejected", error: rejectedMessage(o.reason), ...(o.reason !== undefined ? { reason: o.reason } : {}) };
  if (o.end === "edits-off" || o.end === "approved") return { ok: false, applied: [], refused: "edits-off", error: EDITS_OFF_MESSAGE };
  return { ok: false, applied: [], refused: "unreviewed", error: unreviewedMessage(o.end, REVIEW_WAIT_MS) };
}

/** A delete that takes a node a keyed re-send of the same batch changes, builds in or reorders (its result's root
 *  included): deletes run last, so the re-send's reply would name what is about to go. Refused up front. */
function keyedDeleteConflicts(targets: ReadonlyMap<number, TreeTarget>, deletes: ReadonlyMap<number, DeleteTarget>, moves: ReadonlyMap<number, MoveTarget>): OpProblem[] {
  const out: OpProblem[] = [];
  for (const [i, t] of targets) {
    if (!t.update) continue;
    const touched = touchedBy(t.update);
    for (const [d, del] of deletes) {
      for (const id of idsDeletedWith(del.node, moves)) {
        if (!touched.has(id)) continue;
        out.push({ index: d, op: "delete", message: "it deletes '" + id + "', part of the result the keyed re-send in ops[" + i + "] updates (deletes run after every other op); drop one of the two" });
        break;
      }
    }
  }
  return out;
}

/** An op that names a node a keyed re-send of the same batch removes (it, or anything below it), as a parent or a target:
 *  the removal runs last, so the op would act on a node about to go. Refused up front, like a delete conflict. */
function removalConflicts(list: readonly WriteOp[], targets: ReadonlyMap<number, TreeTarget>, moves: ReadonlyMap<number, MoveTarget>): OpProblem[] {
  const gone = new Map<string, number>();
  for (const [i, t] of targets) {
    if (!t.update) continue;
    for (const n of removalsOf(t.update)) for (const id of idsDeletedWith(n, moves)) if (!gone.has(id)) gone.set(id, i);
  }
  const out: OpProblem[] = [];
  if (!gone.size) return out;
  for (const [index, op] of list.entries()) {
    for (const k of ["nodeId", "parentId"] as const) {
      const id = op[k];
      const by = id === undefined ? undefined : gone.get(id);
      if (by === undefined || by === index) continue;
      out.push({ index, op: op.op, message: "`" + k + "` '" + String(id) + "' is removed by the keyed re-send in ops[" + by + "] (its spec no longer has it; removals run after every other op); drop one of the two" });
      break;
    }
  }
  return out;
}

/** An op that names a node a delete of the same batch removes (it, or anything below it), as a parent or a target:
 *  deletes run last, so the op would act on a node about to go. Refused up front, like any other problem. */
function deleteConflicts(list: readonly WriteOp[], deletes: ReadonlyMap<number, DeleteTarget>, moves: ReadonlyMap<number, MoveTarget>): OpProblem[] {
  const gone = new Map<string, number>();
  for (const [i, t] of deletes) for (const id of idsDeletedWith(t.node, moves)) if (!gone.has(id)) gone.set(id, i);
  const out: OpProblem[] = [];
  for (const [index, op] of list.entries()) {
    for (const k of ["nodeId", "parentId"] as const) {
      const id = op[k];
      const by = id === undefined ? undefined : gone.get(id);
      if (by === undefined || by === index) continue;
      out.push({ index, op: op.op, message: "`" + k + "` '" + String(id) + "' is deleted by ops[" + by + "] of this batch (deletes run after every other op); drop one of the two" });
      break;
    }
  }
  return out;
}
