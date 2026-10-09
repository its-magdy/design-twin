// Writes (code -> design): minimal, EXPLICIT, safe command set (no eval).
import { errMsg } from "./util";
import { ifDefined } from "../../bridge/src/json-util.ts";
import { parseHexColor, HEX_COLOR_HINT } from "../../bridge/src/hex-color.ts";
import type { AppliedWrite, WriteOp, WriteResult } from "../../bridge/src/commands.ts";

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
  // manifest documentAccess is "dynamic-page": appendChild on a PageNode requires the page to be
  // loaded first, or it throws. The read plane already does this (collect.ts / components.ts).
  if (p.type === "PAGE") await p.loadAsync();
  return p as ChildrenMixin & BaseNode;
}

// WriteOp (the args of one op), AppliedWrite and WriteResult are the bridge's wire contract, so they
// are imported from it rather than re-declared here. WriteOp's optionals are `T | undefined`;
// applyWrite tests each for truthiness / `!= null`, so absent and undefined behave the same. `op` is
// typed as one of the four names, but the default branch below still refuses anything else, because
// a write can arrive from any bridge client.
async function applyWrite(op: WriteOp): Promise<AppliedWrite> {
  switch (op.op) {
    case "createFrame": {
      const parent = await resolveParent(op.parentId); // before createFrame — no orphan on a bad parent
      const fill = op.fill ? solidPaint(op.fill, "createFrame fill") : null; // likewise: a bad colour leaves no node
      const f = figma.createFrame();
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
      return { id: f.id };
    }
    case "createText": {
      const parent = await resolveParent(op.parentId); // before createText — no orphan on a bad parent
      const fill = op.fill ? solidPaint(op.fill, "createText fill") : null; // likewise: a bad colour leaves no node
      const t = figma.createText();
      await figma.loadFontAsync(t.fontName as FontName);
      t.characters = op.text || "";
      if (op.fontSize) t.fontSize = op.fontSize;
      if (fill) t.fills = [fill];
      parent.appendChild(t);
      return { id: t.id };
    }
    // setFill/setText THROW rather than no-op. getNodeByIdAsync resolves to null for an invalid or
    // removed id (and for invisible instance children when skipInvisibleInstanceChildren is on), and
    // not every node type carries fills/characters. Returning {id} in those cases reported a write
    // that never happened — over MCP the agent reads that as success and builds on a false premise.
    case "setFill": {
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) throw new Error("setFill: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (!("fills" in nd)) throw new Error("setFill: node '" + nd.name + "' (" + nd.type + ") has no fills");
      (nd as GeometryMixin).fills = [solidPaint(op.color, "setFill color")];
      return ifDefined("id", op.nodeId);
    }
    case "setText": {
      const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (!nd) throw new Error("setText: no node with id '" + op.nodeId + "' (invalid or removed)");
      if (nd.type !== "TEXT") throw new Error("setText: node '" + nd.name + "' is a " + nd.type + ", not TEXT");
      await loadNodeFonts(nd);
      nd.characters = op.text || "";
      return ifDefined("id", op.nodeId);
    }
    default:
      throw new Error("unknown write op: " + op.op);
  }
}

// Apply a batch, reporting partial progress instead of throwing it away. Ops mutate the document one
// at a time and Figma gives us no transaction to roll back, so when op N fails the first N-1 are
// ALREADY committed. Throwing here discarded the ids of everything just created, leaving orphan nodes
// the caller couldn't find or clean up. Resolve with an explicit outcome instead: `applied` always
// lists what landed, and ok:false carries the failure point so the caller can report both.
export async function applyWrites(ops: WriteOp[]): Promise<WriteResult> {
  const list = Array.isArray(ops) ? ops : [];
  const applied: AppliedWrite[] = [];
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
  for (const [i, op] of list.entries()) {
    try {
      applied.push(await applyWrite(op));
    } catch (e) {
      return {
        ok: false,
        applied,
        failedAt: i,
        failedOp: op && op.op,
        error: errMsg(e),
      };
    }
  }
  return { ok: true, applied };
}
