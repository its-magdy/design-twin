// Writes (code -> design): minimal, EXPLICIT, safe command set (no eval).
import { errMsg } from "./util";
import { ifDefined } from "../../bridge/src/json-util.ts";
import { parseHexColor, HEX_COLOR_HINT } from "../../bridge/src/hex-color.ts";
import { EDITS_OFF_MESSAGE, reviewLines, waitingMessage, writeOpError, type AppliedWrite, type WriteOp, type WriteResult } from "../../bridge/src/commands.ts";
import { cardLines } from "../../bridge/src/review-card.ts";
import { previewOffered, reviewDecision } from "../../bridge/src/review-policy.ts";
import { editsAllowed, editsAllowedNow } from "./edits";
import { countUnreviewed, layersSinceApproval, openCard, outcomeOf, rememberWrite, reviewWrites, waitingTicket, type Card, type PutBack } from "./review";
import { readBatch, SHOW_CAP } from "./review-reads";
import { queueWork } from "./state";
import { toast } from "./toast";
import { applyMode, resolveModeOps, type ModeTarget } from "./variable-modes";
import { buildTree, resolveTreeOps, treeGone, type TreeTarget } from "./tree";
import { destGone, makeDest } from "./places";
import { applyUpdate, checkRemoval, removalCount, removalsOf, resolveKeyed, touchedBy } from "./keyed";
import { countPropertySteps, fileChanged, orphanWarnings, propertyUndoSteps, removeDefs } from "./component-build";
import { applyPatch, changesBefore, keepText, resolvePatchOps, type PatchTarget } from "./patch";
import { markCreated } from "./session";
import { resolveRuleOps, type RuleTarget, type ShownRule } from "./rules";
import { applyStyle, applyVariable, resolveSourceOps, type StyleTarget, type VariableTarget } from "./sources";
import { applyCreates, CreateFailed, isCreateOp, resolveCreateOps } from "./creates";
import { setBatchPlan } from "./batch-plan";
import { bindTreeOps } from "./bind";
import { applyDelete, applyMove, checkDelete, idsDeletedWith, resolveStructureOps, type DeleteTarget, type MoveTarget } from "./structure";
import { batchRefusal, countChanges, goneSentence, hasLanded, keptLine, landedResult, landedText, leftSomething, mergeLanded, refusalReason, restoreChanges, restoredRows, RestoreStopped, staying, type Change, type Landed, type OpProblem } from "./write-batch";
import type { WritesMsg } from "./messages";
import { checkImages, makeImages, setBatchImages, type MadeImage } from "./images";
import { imageTableError, type ImageTable } from "../../bridge/src/image-spec.ts";
import { inDocument, nodeById, noNode, stillInDocument, takeBack } from "./node-lookup";

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
// This is resolved BEFORE the node is created, deliberately. nodeById resolves to null for an
// invalid or removed id — and for invisible instance children when skipInvisibleInstanceChildren is
// on (which the design-system read toggles) — so a stale id is ordinary, not exotic. The old code
// silently fell back to currentPage: an agent composing a tree (createFrame root -> createFrame
// parentId:root -> children) got ok:true and a flat pile of nodes on the canvas. Validating first
// also means a bad parent fails WITHOUT leaving an orphan node the caller can't see in `applied`.
const parentGone = (parentId: string): string => "parent '" + parentId + "' not found (invalid or removed id)";
async function resolveParent(parentId?: string): Promise<ChildrenMixin & BaseNode> {
  if (!parentId) return figma.currentPage;
  const p = await nodeById(parentId);
  if (!p) throw new Error(parentGone(parentId));
  if (!("appendChild" in p)) throw new Error("parent '" + p.name + "' (" + p.type + ") cannot have children");
  for (let a: BaseNode | null = p; a; a = a.parent) {
    if (a.type === "INSTANCE") throw new Error("parent '" + p.name + "' is " + (a === p ? "an instance" : "inside the instance '" + a.name + "'") + ", which cannot take new children");
  }
  // manifest documentAccess is "dynamic-page": appendChild on a PageNode requires the page to be
  // loaded first, or it throws. The read plane already does this (collect.ts / components.ts).
  if (p.type === "PAGE") {
    await p.loadAsync();
    if (!inDocument(p)) throw new Error(parentGone(parentId)); // deleted while it loaded
  }
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
// resolveModeOps), a createTree op's page, section and fonts (tree.ts resolveTreeOps, places.ts), a patch's node and names (patch.ts
// resolvePatchOps), a move's node and new parent (structure.ts).
interface Resolved {
  mode?: ModeTarget | undefined; tree?: TreeTarget | undefined; patch?: PatchTarget | undefined; move?: MoveTarget | undefined;
  variable?: VariableTarget | undefined; style?: StyleTarget | undefined; rule?: RuleTarget | undefined;
}

/** A node an op just created, as a Change whose undo removes it. */
function createdNode(n: SceneNode): Change {
  markCreated(n);
  return { applied: { id: n.id }, kind: "created node", what: "the new node '" + n.name + "' (" + n.id + ")", on: n, made: true, owns: [n], restore(_allowed, ours) { takeBack([n], ours); } };
}

// Every op that changes the file pushes the Change it made onto `changes` (a node created, a value overwritten, a mode
// set, a tree built, a node moved), so a later failure can undo all of them.
async function applyWrite(op: WriteOp, { mode, tree, patch, move, variable, style, rule }: Resolved, changes: Change[]): Promise<AppliedWrite> {
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
        if (editsAllowedNow()) { takeBack([t]); changes.pop(); }
        throw e;
      }
      // Revoked during the font load: take back the empty node this op just made, so it leaves nothing.
      if (!editsAllowedNow()) { takeBack([t]); changes.pop(); consent(); }
      // The parent deleted during it (node-lookup.ts): likewise, and the op fails as its lookup would have. The current
      // page too, when no parent was named: the text was made on it, and it is not one the designer can see any more.
      if (!inDocument(parent)) { takeBack([t]); changes.pop(); throw new Error(op.parentId ? parentGone(op.parentId) : noNode(parent.id, "page")); }
      // The text itself deleted or detached during it: it is in no page, so nothing of the op is in the file; it fails as
      // missing, and is never written to nor put back on a page.
      if (!inDocument(t)) { changes.pop(); throw new Error(noNode(t.id)); }
      t.characters = op.text || "";
      if (op.fontSize) t.fontSize = op.fontSize;
      if (fill) t.fills = [fill];
      parent.appendChild(t);
      return change.applied;
    }
    // setFill/setText THROW rather than no-op. nodeById resolves to null for an invalid or
    // removed id (and for invisible instance children when skipInvisibleInstanceChildren is on), and
    // not every node type carries fills/characters. Returning {id} in those cases reported a write
    // that never happened — over MCP the agent reads that as success and builds on a false premise.
    case "setFill": {
      const nd = op.nodeId ? await nodeById(op.nodeId) : null;
      if (!nd) throw new Error("setFill: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (!("fills" in nd)) throw new Error("setFill: node '" + nd.name + "' (" + nd.type + ") has no fills");
      const paint = solidPaint(op.color, "setFill color");
      consent();
      // A text's paints and paint-style links can differ from run to run even when the paints look the same: kept run by
      // run (keepText loads the fonts that needs).
      if (nd.type === "TEXT") {
        // Deleted while its fonts loaded (node-lookup.ts): checked after each load, before the text is read again.
        const restore = await keepText(nd, () => stillInDocument(nd, "node", "setFill: "));
        stillInDocument(nd, "node", "setFill: ");
        consent();
        nd.fills = [paint];
        const change: Change = { applied: ifDefined("id", op.nodeId), kind: "fill change", what: "the fill of '" + nd.name + "' (" + nd.id + ")", on: nd, restore };
        changes.push(change);
        return change.applied;
      }
      const target = nd as SceneNode & MinimalFillsMixin;
      const old = target.fills;
      const oldStyle = target.fillStyleId;
      target.fills = [paint];
      const change: Change = {
        applied: ifDefined("id", op.nodeId), kind: "fill change", what: "the fill of '" + nd.name + "' (" + nd.id + ")", on: nd,
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
      const nd = op.nodeId ? await nodeById(op.nodeId) : null;
      if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
      await loadNodeFonts(nd);
      // Deleted while its fonts loaded (node-lookup.ts): checked after each load, before the text is read again.
      const still = (): void => stillInDocument(nd, "node", "setText: ");
      still();
      consent();
      const restore = await keepText(nd, still);
      still();
      consent();
      nd.characters = op.text || "";
      const change: Change = { applied: ifDefined("id", op.nodeId), kind: "text change", what: "the text of '" + nd.name + "' (" + nd.id + ")", on: nd, restore };
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
      // What it holds from before the batch ran (its page, a layer it copies, the result it updates) is still there; a
      // component it places is checked as it is placed (tree.ts treeGone).
      const gone = treeGone(tree);
      if (gone !== null) throw new Error(gone);
      consent();
      // A key the file already has a result for: that result is updated in place (keyed.ts); its changes go on the list
      // one by one, as they land.
      if (tree.update) return applyUpdate(tree, tree.update, consent, editsAllowedNow, changes);
      // The page and section it lands in that the batch makes, when this is the first op landing there (places.ts):
      // each a change of its own, so a later failure removes it after the frames in it. A page it made is held across
      // its load: deleted meanwhile, the op fails as missing.
      const made = await makeDest(tree.dest, consent, changes);
      const lost = destGone(tree.dest);
      if (lost !== null) throw new Error(lost);
      consent();
      const change = await buildTree(tree, consent, changes);
      changes.push(change);
      return made.page || made.section ? { ...change.applied, ...(made.page ? { pageCreated: made.page } : {}), ...(made.section ? { sectionCreated: made.section } : {}) } : change.applied;
    }
    // Resolved up front: the node exists and has every field, the names resolved and the fonts loaded. The values it
    // replaces are kept; it puts itself back if it throws partway (patch.ts).
    case "patch": {
      if (!patch) throw new Error("patch: the op was not resolved before the batch ran");
      consent();
      return (await applyPatch(patch, consent, editsAllowedNow, changes)).applied;
    }
    // Resolved up front (rules.ts): every layer the rule matches, each a patch whose node, fields, fonts and names
    // resolved. Each keeps what it replaces, so a failure on any of them puts back all of them with the rest of the batch.
    case "patchWhere": {
      if (!rule) throw new Error("patchWhere: the op was not resolved before the batch ran");
      const group = {};
      // Named as the batch resolved it: a node removed since has no name Figma will read.
      const named = (t: PatchTarget, e: unknown): Error => new Error("'" + t.name + "' (" + t.node.id + "), one of the " + rule.matches.length + " layers its rule matches: " + errMsg(e));
      for (const t of rule.matches) {
        consent();
        try { (await applyPatch(t, consent, editsAllowedNow, changes)).group = group; } catch (e) {
          if (e instanceof EditsRevoked) throw e;
          throw named(t, e);
        }
      }
      // Each match's patch awaits (its fonts, a text style): one deleted or detached at a later match's awaits fails the op
      // as missing (node-lookup.ts), never counted as applied.
      for (const t of rule.matches) { try { stillInDocument(t.node); } catch (e) { throw named(t, e); } }
      const first = rule.matches[0];
      return { matched: rule.matches.length, pages: rule.match.pages.length, ...(first && first.unbound ? { unbound: first.unbound } : {}) };
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
//
// A batch may wait for the designer's review (review.ts, spec decision 18). submitWrites is the first half — checked,
// resolved, and either applied at once or put on a card — and the bridge's `write` runs only it, in its run; the card
// then runs the rest as work of its own when the designer answers (the batch approved, a preview, its put-back).
// applyWrites, the test surface, waits for the card's outcome.
export async function applyWrites(ops: WriteOp[], images?: ImageTable): Promise<WriteResult> {
  const s = await submitWrites(ops, images);
  return "done" in s ? s.done : outcomeOf(s.card);
}

/** A batch as first sent: its result, or the card it waits on. */
export type Submitted = { done: WriteResult } | { card: Card };

export async function submitWrites(ops: WriteOp[], images?: ImageTable): Promise<Submitted> {
  const list = Array.isArray(ops) ? ops : [];
  const r = await runBatch(list, images, "submit", NO_EXPECT);
  return "card" in r ? r : { done: r.result };
}

/** How a batch runs: as first sent (it may wait for review), as the designer approved it, or as a preview of it. */
type Mode = "submit" | "approved" | "preview";
/** What a run leaves beside its result: the changes it made (a preview puts them back) and the existing layers it
 *  counted for the review (review-policy.ts); what it landed, and what the card's earlier previews had (`prior`). */
interface RunOut { changes: Change[]; layers: number; landed: Landed; prior?: Landed | undefined }
/** What is in the file from this batch besides its changes: what its run landed, and what earlier previews of it had. */
const landedOf = (out: RunOut): Landed => out.prior ? mergeLanded(out.prior, out.landed) : out.landed;
/** What a card showed of each patchWhere op's matches (op index → its token and the selection it looked in, rules.ts): on
 *  approval they must still match. */
type Expect = ReadonlyMap<number, ShownRule>;
const NO_EXPECT: Expect = new Map();

// `prior`: what the card's earlier previews of this batch landed (review.ts card.landed), which their put-backs left in
// the file: a refusal or failure of this run says it, as it says what this run landed itself.
async function runBatch(list: WriteOp[], images: ImageTable | undefined, mode: Mode, expect: Expect, prior?: Landed): Promise<{ result: WriteResult; changes: Change[]; landed: Landed } | { card: Card }> {
  // One batch is one Cmd-Z step. Figma keeps every plugin action in a single undo step until commitUndo(), so
  // without these the designer's first Cmd-Z undid every batch since the plugin started (seen live: it removed a
  // frame an earlier batch had created). Commit before, so the batch never joins earlier work, and after, so
  // the next one never joins it. Committing with nothing pending is a no-op.
  const out: RunOut = { changes: [], layers: 0, landed: { imported: 0, images: 0 }, prior };
  const landed = (): Landed => landedOf(out);
  if (list.length) commitUndo();
  let r: WriteResult | { card: Card };
  try {
    r = await gatedWrites(list, images, mode, out, expect);
  } catch (e) {
    // A write that throws is said too (its run's "Applying edits…" line must not stay up), then fails as it did.
    if (mode !== "preview" && list.length) announceThrown(e, out.changes.length > 0 || hasLanded(landed()));
    throw e;
  }
  if (list.length) commitUndo();
  if ("card" in r) return r;
  // A refusal after an import or an image landed tells the agent so, as the designer is told (write-batch.ts).
  const all = landed();
  r = landedResult(r, all);
  // A preview is said by its card. An empty batch says nothing.
  if (mode !== "preview" && list.length) announce(r, all);
  if (mode === "submit" && list.length && r.refused !== "waiting") {
    rememberWrite(r);
    // What a batch that did not wait changed counts toward the next forced review (review-policy.ts).
    if (r.applied.length) countUnreviewed(out.layers);
  }
  return { result: r, changes: out.changes, landed: all };
}

function commitUndo(): void {
  try { figma.commitUndo(); } catch (e) { console.error("[export] figma.commitUndo failed:", e); }
}

// A write is never silent: whatever changed the file (or was refused from changing it) is said in Figma's own
// toast AND on the plugin window's status line (ui.template.html `writes`), which it replaces — the write's run put
// "Applying edits…" there. An empty batch changed nothing and says nothing (runBatch does not call this for one).
// A batch refused in its run because another waits for review is said on the status line only: that card's toast went
// up a moment ago. One refused before any run (bridge.ts, the usual case) is said in a toast only (announceWaiting).
// `landed`: what the batch added that nothing puts back (library imports, images), so a refusal never says "nothing
// changed" after one.
function announce(r: WriteResult, landed?: Landed): void {
  const n = r.applied.length;
  const edits = n + " edit" + (n === 1 ? "" : "s");
  const some = landed && hasLanded(landed) ? landed : null;
  let text: string | null = null;
  if (r.refused === "waiting") {
    say(WAITING, 0, false, false);
    return;
  }
  // No change listed as applied or put back, but the file is not as it was: a preview put back but for what the designer
  // changed since (a section side they resized), or a batch or a preview that left what a layer they deleted had grown
  // (a section its frame grew, "Allow edits" turned off before it could go back): said to them too (keptLine).
  const kept = r.ok ? undefined : keptLine.get(r);
  if (kept) text = kept.text + (some ? " " + kept.lead + " had already " + landedText(some) + "; that stays." : "");
  else if (r.refused === "edits-off") text = n
    ? "Design Twin applied " + edits + ", then stopped — 'Allow edits' was turned off." + (some ? " It had already " + landedText(some) + "." : "")
    : "Design Twin refused an edit request — 'Allow edits' is off." + (some ? " No layer changed, but it had already " + landedText(some) + "." : "");
  // Rejected after a preview that loaded an image (or imported an item) and was put back: that stays, and is said.
  else if (r.refused === "rejected") text = some
    ? "Design Twin did not apply the edit request — it was rejected. No layer changed, but its preview had already " + landedText(some) + "."
    : "Design Twin did not apply the edit request — it was rejected. Nothing changed.";
  else if (r.refused === "unreviewed") text = "Design Twin did not apply an edit request: " + (r.error || "nobody reviewed it.");
  else if (r.ok && n) text = "Design Twin applied " + edits + " to this file.";
  else if (!r.ok && n) text = "Design Twin applied " + edits + " that could not be put back after one failed: " + (r.error || "unknown error");
  // Put back after an op failed: an image loaded (or an item imported) before it stays, and is said.
  else if (!r.ok && r.restored && r.restored.length) text = "Design Twin undid " + r.restored.length + " earlier change" + (r.restored.length === 1 ? "" : "s") + " after an edit failed"
    + (some ? ", but it had already " + landedText(some) + ": " + refusalReason(r.error) : ": " + (r.error || "unknown error"));
  // Refused before anything changed (#206): a check before the first op (an image hash the file does not have, a name
  // that resolves to nothing, a bad op, Dev Mode, a file that changed while the batch waited for review), or an op
  // that failed and put itself back before anything else had landed. No layer changed then, but a library item imported
  // or an image loaded before the refusal stays, and is said.
  else if (!r.ok) text = some
    ? "Design Twin refused an edit request — no layer changed, but it had already " + landedText(some) + ": " + refusalReason(r.error)
    : REFUSED + refusalReason(r.error);
  if (text === null) return;
  say(text, n, r.ok);
}

const REFUSED = "Design Twin refused an edit request — nothing changed: ";
const WAITING = "Design Twin refused another edit request while one waits for your review — nothing changed.";

/** A write refused before it reached the batch (bridge.ts: the wire guard), said like any other refusal. */
export function announceRefused(error: string): void {
  say(REFUSED + refusalReason(error), 0, false);
}

/** A write refused before any run because a card already waits (bridge.ts): Figma's toast only. No run began, so the
 *  window's line is still the card's "review it below", which stays; the card itself is left as it is. */
export function announceWaiting(): void {
  toast(WAITING, true);
}

/** The toast and the status line for `text` (red unless `ok`); `toasts: false` for the status line only. */
function say(text: string, applied: number, ok: boolean, toasts = true): void {
  if (toasts) toast(text, !ok);
  const m: WritesMsg = { type: "writes", applied, ok, text };
  figma.ui.postMessage(m);
}

/** A write that threw (runBatch): `landed` when it had changed the file before it did. */
function announceThrown(e: unknown, landed: boolean): void {
  say(landed
    ? "Design Twin could not finish an edit request: " + errMsg(e) + " — some of it may be in the file."
    : "Design Twin could not run an edit request — nothing changed: " + errMsg(e), 0, false);
}


// The plan of what the batch's create ops make (batch-plan.ts) lives exactly as long as the batch.
// So do the images it made (images.ts).
async function gatedWrites(list: WriteOp[], images: ImageTable | undefined, mode: Mode, out: RunOut, expect: Expect): Promise<WriteResult | { card: Card }> {
  try { return await batchWrites(list, images, mode, out, expect); } finally { setBatchPlan(null); setBatchImages(null); }
}

async function batchWrites(list: WriteOp[], images: ImageTable | undefined, mode: Mode, out: RunOut, expect: Expect): Promise<WriteResult | { card: Card }> {
  const applied: AppliedWrite[] = [];
  // One card at a time (review.ts): while a write waits for the designer, a new one is refused at once, naming it.
  const waiting = mode === "submit" && list.length ? waitingTicket() : null;
  if (waiting !== null) return { ok: false, applied, refused: "waiting", error: waitingMessage(waiting) };
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
  const badTable = imageTableError(images);
  if (badTable !== null) return { ok: false, applied, error: badTable + ". Nothing was changed." };
  // The images first (images.ts): each `hash` checked against the file, each image from disk checked for its bytes. None
  // is made yet: that waits until the batch runs (after its review, below), so a batch refused first loads no image.
  const imgs = await checkImages(list, images);
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
    // A `bind: true` spec is bound to the file's variables and text styles (and what the create tables make) first: the
    // bound spec is what resolves, builds and, for a keyed re-send, is compared with the last one (bind.ts).
    const trees = await resolveTreeOps(list, await bindTreeOps(list, creates));
    // A createTree whose key names a result the file holds becomes an update of it (keyed.ts).
    const keyed = await resolveKeyed(list, trees.targets);
    const patches = await resolvePatchOps(list);
    // A rule's matches (rules.ts): at a first send its token is checked; once approved, its matches must be the card's.
    const rules = await resolveRuleOps(list, mode === "submit" ? { kind: "submit" } : { kind: "approved", expect });
    const structure = await resolveStructureOps(list, (i) => changesBefore(list, i));
    // A variable or style edit, and a patch's library check (a library's component cannot be changed here).
    const sources = await resolveSourceOps(list);
    const problems = [...imgs.problems, ...creates.problems, ...modes.problems, ...trees.problems, ...keyed.problems, ...patches.problems, ...rules.problems, ...structure.problems, ...sources.problems, ...deleteConflicts(list, structure.deletes, structure.moves),
      ...removalConflicts(list, trees.targets, structure.moves), ...keyedDeleteConflicts(trees.targets, structure.deletes, structure.moves),
      ...ruleConflicts(rules.targets, trees.targets, structure.deletes, structure.moves)].sort((a, b) => a.index - b.index);
    return { creates, modes, trees, patches, rules, structure, sources, problems };
  };
  const { creates, modes, trees, patches, rules, structure, sources, problems } = await resolveBatch();
  const firstProblem = problems[0];
  if (firstProblem) {
    // Approved (or previewed) after a wait: the designer may have changed the file while the card was up, so the batch
    // was resolved again just now, against the file as it is; one the file no longer accepts is refused whole.
    const changedNote = mode === "submit" ? "" : "the file changed while the write waited for review: ";
    return { ok: false, applied, failedAt: firstProblem.index, failedOp: firstProblem.op, error: changedNote + batchRefusal(problems, { landed: landedOf(out) }) };
  }
  // A bulk change by rule always waits for the designer (`bulkByRule`); on approval its matches were counted again just
  // now (resolveRuleOps with the card's tokens), and a batch whose matches drifted from the card's was refused above.
  // The designer's review (review.ts, spec decision 18): decided here, once the whole batch resolved (a batch that would
  // be refused never puts a card up) and before anything touches the file (the images and library imports below included).
  if (mode === "submit" && list.length) {
    const reads = await readBatch(list, { trees: trees.targets, patches: patches.targets, rules: rules.targets, modes: modes.targets, moves: structure.moves, deletes: structure.deletes, variables: sources.variables, styles: sources.styles });
    out.layers = reads.layers;
    const bulkByRule = rules.targets.size > 0;
    const decision = reviewDecision({ checkbox: await reviewWrites(), sourceEdits: reads.sourceEdits, bulkByRule, layers: reads.layers, sinceApproval: layersSinceApproval() });
    if (decision.wait) {
      // Unticked while the batch resolved: refused now, with no card (main.ts ends only a card that is already up).
      if (!editsAllowedNow()) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const lines = cardLines(list, reads.ops.map((o) => o.read));
      const shows = lines.map((l) => {
        const ids: string[] = [];
        let total = 0;
        let spot: { pageId: string; x: number; y: number } | undefined;
        for (const i of l.ops) {
          const o = reads.ops[i];
          if (!o) continue;
          total += o.ids.length;
          for (const id of o.ids) if (ids.length < SHOW_CAP && ids.indexOf(id) < 0) ids.push(id);
          if (!spot && o.spot) spot = o.spot;
        }
        return { ids, total: Math.max(total, ids.length), ...(spot ? { spot } : {}) };
      });
      const keyedResend = [...trees.targets.values()].some((t) => !!t.update);
      // What the card shows of each rule's matches: an approval or a preview runs against exactly these.
      const shown = new Map<number, ShownRule>();
      for (const [i, t] of rules.targets) shown.set(i, { token: t.match.token, ...(t.selection ? { selection: t.selection } : {}) });
      const card = openCard({
        ops: list, lines, shows, details: reviewLines(list), why: decision.reason,
        previewable: previewOffered({ sourceEdits: reads.sourceEdits, bulkByRule, layers: reads.layers, deletes: structure.deletes.size > 0, keyedResend }),
        // Each a run of its own on the plugin's run chain, after whatever runs now: the batch is resolved again then.
        apply: (prior) => queueWork(async () => { const r = await runBatch(list, images, "approved", shown, prior); return "card" in r ? notApplied() : r.result; }),
        preview: (prior) => queueWork(async () => {
          const r = await runBatch(list, images, "preview", shown, prior);
          if ("card" in r) return { result: notApplied(), putBack: async (): Promise<PutBack> => ({ failed: null, gone: [], restored: 0 }) };
          const changes = r.changes;
          return { result: r.result, putBack: () => queueWork(() => putBack(changes)), landed: r.landed };
        }),
        announce,
      });
      return { card };
    }
  }
  // The images from disk are made only now (images.ts makeImages): the whole batch resolved, and a batch that waits for
  // the designer was approved (resolved again then, against the file as it is) or is being previewed — so a batch
  // refused, rejected or withdrawn before it runs loads none. Making one hands its bytes to Figma (no node), so "Allow
  // edits" is asked before each; unticked partway, nothing more is made. One Figma cannot open refuses the batch, and
  // the images after it are not made. Ones made before either stay (nothing removes an image), and the refusal says so
  // (runBatch: landedResult, announce). A preview needs its images to show them: it makes them, and a put-back leaves
  // them loaded, with no layer of the batch using them (review.ts says so if the card then ends unapplied).
  let madeImages: MadeImage[] = [];
  if (imgs.pending.length) {
    const m = await makeImages(imgs.pending, editsAllowedNow);
    out.landed.images += m.loaded;
    if (m.revoked) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    setBatchImages(m.made);
    madeImages = m.images;
    const firstBad = m.problems[0];
    if (firstBad) return { ok: false, applied, failedAt: firstBad.index, failedOp: firstBad.op, error: batchRefusal(m.problems, { landed: landedOf(out) }) };
  }
  const changes: Change[] = out.changes;
  countPropertySteps(changes);
  // In op order: each op's applied row, filled as it lands (the deletes last).
  const rows: Array<AppliedWrite | undefined> = list.map(() => undefined);
  const fail = async (i: number, op: WriteOp, e: unknown): Promise<WriteResult> => {
    const revoked = e instanceof EditsRevoked;
    // Undo the changes this batch made (newest first). Not when the designer has turned edits off — whether that is
    // what stopped the batch or the op failed for its own reason after the box was unticked (a font load that rejects
    // late): after that the plugin changes nothing, not even to undo its own work, and the reply says what stayed.
    const off = revoked || !editsAllowedNow();
    // A change whose layer the designer deleted while the batch ran went with it: neither put back nor applied.
    const { restored, failed, gone, stays } = off ? { restored: [], failed: [], ...staying(changes) } : await restoreChanges(changes, editsAllowedNow);
    const kept = !revoked && off && stays.length
      ? "; 'Allow edits' was turned off before the batch could put back its " + countChanges(stays) + ", so they stay applied"
      : "";
    const r: WriteResult = {
      ok: false,
      // What stays: every change not put back (a patch stopped partway included), and the deletes already run.
      applied: [...stays.map((c) => c.applied), ...rows.filter((a): a is AppliedWrite => a !== undefined && a.deleted === true)],
      failedAt: i,
      failedOp: op && op.op,
      error: errMsg(e) + [...failed, ...gone.map(goneSentence)].map((s) => "; " + s).join("") + kept,
      ...(revoked ? { refused: "edits-off" as const } : {}),
      ...(restored.length ? { restored: restoredRows(restored.slice().reverse()) } : {}),
    };
    // Nothing listed as applied or put back, but a layer the designer deleted left what it grew (a section, still that
    // size): the designer is told so, never "nothing changed" (announce).
    const left = gone.filter(leftSomething).map(goneSentence);
    if (left.length && !r.applied.length && !restored.length) {
      keptLine.set(r, {
        text: (revoked ? "Design Twin stopped — 'Allow edits' was turned off" : "Design Twin could not apply an edit request (" + errMsg(e) + ")") + ", and not all of it could be put back: " + left.join("; ") + ".",
        lead: "It",
      });
    }
    return r;
  };
  // A problem the imports reveal once the create tables have run: those are put back, and the batch is refused whole. One
  // that could not be put back stays (listed in `applied`), and the refusal says so — never that nothing was changed.
  const refuseLate = async (late: OpProblem[]): Promise<WriteResult> => {
    const firstLate = late[0];
    const { restored, failed, stays } = await restoreChanges(changes, editsAllowedNow);
    return {
      ok: false, applied: stays.map((c) => c.applied),
      ...(firstLate ? { failedAt: firstLate.index, failedOp: firstLate.op } : {}),
      error: batchRefusal(late, { landed: landedOf(out), failed }),
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
      const { problems: late, revoked, imported } = await creates.imports(editsAllowedNow);
      out.landed.imported += imported || 0;
      if (revoked) return { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
      const firstLate = late[0];
      if (firstLate) return { ok: false, applied, failedAt: firstLate.index, failedOp: firstLate.op, error: batchRefusal(late, { landed: landedOf(out) }) };
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
  for (const step of [trees, patches, rules, sources]) {
    if (!step.importCount) continue;
    if (!editsAllowedNow()) return changes.length ? revokedAfterCreates() : { ok: false, applied, refused: "edits-off", error: EDITS_OFF_MESSAGE };
    const { problems: late, revoked, imported } = await step.imports(editsAllowedNow);
    out.landed.imported += imported || 0;
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
        variable: sources.variables.get(i), style: sources.styles.get(i), rule: rules.targets.get(i),
      }, changes);
    } catch (e) {
      return fail(i, op, e);
    }
    // A bound spec's reply counts what was bound, instanced and left raw (`unbound` is then part of it).
    const bound = trees.targets.get(i);
    const row = rows[i];
    if (bound && bound.bind && row) { row.bind = bound.bind; delete row.unbound; }
    // What landing it said: a section it grew now runs into a neighbour.
    if (bound) for (const m of bound.landed) warnings.push("ops[" + i + "]: " + m);
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
      fileChanged();
    } catch (e) {
      const r = await fail(i, op, e);
      const gone = rows.filter((a): a is AppliedWrite => a !== undefined && a.deleted === true).length;
      return gone ? { ...r, error: r.error + "; " + gone + " node(s) deleted before it cannot be brought back" } : r;
    }
  }
  // The nodes a keyed re-send no longer has (or built anew) go last, with the deletes, and the property definitions a
  // component re-send dropped last of all (their references were unwired in the batch): neither can be brought back, so
  // a failure here names every one already gone, as the delete loop does.
  const gone: string[] = [];
  const goneRows: AppliedWrite[] = [];
  const lostWith = async (i: number, op: WriteOp, e: unknown): Promise<WriteResult> => {
    const r = await fail(i, op, e);
    const deleted = rows.filter((a): a is AppliedWrite => a !== undefined && a.deleted === true).length;
    const lost = (deleted ? [deleted + " node(s) deleted"] : []).concat(gone);
    return lost.length ? { ...r, applied: r.applied.concat(goneRows), error: r.error + "; already gone before it, which cannot be brought back: " + lost.join(", ") } : r;
  };
  // A variant dropped from a set's table: its instances lose their main component (said, not refused). Counted for every
  // re-send first: those are the batch's last awaits, and the designer can change the file at any of them (node-lookup.ts),
  // so what the removals hold is checked again after them, right before the first removal: the result each re-send
  // updates is still in the document, and each node it removes still holds only what its key built.
  const orphans = new Map<number, string[]>();
  for (const [i, t] of trees.targets) {
    const op = list[i];
    if (!op || !t.update) continue;
    try { orphans.set(i, await orphanWarnings(removalsOf(t.update))); } catch (e) { return lostWith(i, op, e); }
  }
  for (const [i, t] of trees.targets) {
    const op = list[i];
    if (!op || !t.update) continue;
    try {
      stillInDocument(t.update.root);
      for (const n of removalsOf(t.update)) checkRemoval(t.update, n);
    } catch (e) { return lostWith(i, op, e); }
  }
  for (const [i, t] of trees.targets) {
    const op = list[i];
    if (!op || !t.update) continue;
    // The reply counts what is removed now, after every other op (a later op may have moved a node out).
    const row = rows[i];
    if (row) { const n = removalCount(t.update); if (n) row.removed = n; else delete row.removed; }
    for (const m of orphans.get(i) || []) warnings.push("ops[" + i + "]: " + m);
    try {
      for (const n of removalsOf(t.update)) {
        // Out of the document already (the designer deleted or detached it, at the orphan count's awaits or before): it is
        // not this re-send's to remove, nor to claim (node-lookup.ts); never read.
        if (!inDocument(n)) continue;
        consent();
        const what = (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET" ? "variant '" : "'") + n.name + "' (" + n.id + ")";
        const id = n.id;
        n.remove();
        fileChanged();
        gone.push(what);
        goneRows.push({ id, deleted: true });
      }
    } catch (e) {
      return lostWith(i, op, e);
    }
  }
  for (const [i, t] of trees.targets) {
    const op = list[i];
    const comp = t.update ? t.update.component : undefined;
    if (!op || !comp || !comp.defs.remove.length) continue;
    const row = rows[i];
    const owner = comp.defs.owner;
    try {
      const names = removeDefs(comp.defs, consent, (name) => { gone.push("the property '" + name + "' of '" + owner.name + "'"); goneRows.push({ id: owner.id, propsRemoved: [name] }); });
      if (row) { if (names.length) row.propsRemoved = names; else delete row.propsRemoved; }
    } catch (e) {
      return lostWith(i, op, e);
    }
  }
  const done: AppliedWrite[] = rows.filter((a): a is AppliedWrite => a !== undefined);
  const undo = propertyUndoSteps();
  return { ok: true, applied: done, ...(warnings.length ? { warnings } : {}), ...(undo > 1 ? { undoSteps: undo, undoNote: undoNote(undo) } : {}), ...(madeImages.length ? { images: madeImages } : {}) };
}

/** A run that could not even start its batch (it cannot happen: only a first send puts a card up). */
function notApplied(): WriteResult {
  return { ok: false, applied: [], error: "the write could not run. Nothing was changed." };
}

/** Put a preview back (review.ts Put back, or a card that ended while previewing): its own Cmd-Z step, after the
 *  preview's — so the designer's undo history has two entries for a preview that was put back (a Cmd-Z after it brings
 *  the preview back; the plugin cannot remove a step). `failed` null when all of it went back, else what stays; `gone`,
 *  what went with a layer the designer deleted meanwhile (write-batch.ts goneSentence), never called put back; `restored`,
 *  how many changes were put back (none, when every layer went: the reply says nothing was). */
async function putBack(changes: readonly Change[]): Promise<PutBack> {
  commitUndo();
  const { restored, failed, stays, gone } = await restoreChanges(changes, editsAllowedNow);
  commitUndo();
  const went = gone.map(goneSentence);
  // A change that went with its layers but left something of it (a section its frame grew, still that size: "Allow
  // edits" went off before its put-back ran) is not all put back either: the file is not as it was.
  const left = gone.filter(leftSomething).map(goneSentence);
  if (!failed.length && !left.length) return { failed: null, gone: went, restored: restored.length };
  // Every change may have gone back, or with its layers, but for what the designer has changed since (a section they
  // resized) or what a deleted layer left: then nothing is listed, and that is said to them as well (announce), not
  // only to the agent — never "nothing changed".
  const r: WriteResult = { ok: false, applied: stays.map((c) => c.applied), error: "The preview of this write could not all be put back: " + [...failed, ...went].join("; ") + (stays.length ? " — what stays is listed in `applied`." : ".") };
  if (!stays.length) keptLine.set(r, { text: left.length ? "Design Twin could not put all of the preview back: " + [...left, ...failed].join("; ") + "." : "Design Twin put the preview back, but kept what you changed since: " + failed.join("; ") + ".", lead: "Its preview" });
  return { failed: r, gone: went, restored: restored.length };
}

/** What the reply says of a batch Figma split into `steps` Undos (component-build.ts countPropertySteps). */
function undoNote(steps: number): string {
  return "Figma records each component property a write declares, edits or deletes as its own undo step, so this write takes " + steps +
    " Undos (Cmd-Z) to take back fully; each Undo takes back the part of the write after the previous property call (a new component still being built when a step ended is left hidden).";
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

/** A rule op that matches a node a delete or a keyed re-send of the same batch removes (it, or anything below it): those
 *  run last, so the patch would change a node about to go. Refused up front, like the conflicts below. */
function ruleConflicts(rules: ReadonlyMap<number, RuleTarget>, trees: ReadonlyMap<number, TreeTarget>, deletes: ReadonlyMap<number, DeleteTarget>, moves: ReadonlyMap<number, MoveTarget>): OpProblem[] {
  if (!rules.size) return [];
  const gone = new Map<string, number>();
  for (const [i, t] of deletes) for (const id of idsDeletedWith(t.node, moves)) if (!gone.has(id)) gone.set(id, i);
  for (const [i, t] of trees) { if (!t.update) continue; for (const n of removalsOf(t.update)) for (const id of idsDeletedWith(n, moves)) if (!gone.has(id)) gone.set(id, i); }
  const out: OpProblem[] = [];
  if (!gone.size) return out;
  for (const [index, r] of rules) {
    for (const id of r.ids) {
      const by = gone.get(id);
      if (by === undefined) continue;
      out.push({ index, op: "patchWhere", message: "its rule matches '" + id + "', which ops[" + by + "] of this batch removes (removals run after every other op); narrow the rule or drop one of the two" });
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
