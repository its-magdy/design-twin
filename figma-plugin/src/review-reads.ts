// What the review of a write reads from the file (docs/write-plane-spec.md decision 18), once the batch has resolved:
// for the policy (bridge/src/review-policy.ts) the existing layers it changes and its source edits; for the card
// (bridge/src/review-card.ts) each op's layer names and the values they hold now; for the card's Show me the layers
// each op touches, or where a new frame will land. And the Show me itself: select and zoom. Reads only.
//
// Selecting, zooming and switching page change no document state, so Show me adds no undo step: the selection, the
// viewport and the current page are not part of Figma's undo history.
import type { WriteOp } from "../../bridge/src/commands.ts";
import type { OpRead } from "../../bridge/src/review-card.ts";
import { countLayers } from "../../bridge/src/review-policy.ts";
import { followersOf, mainComponentOf, type StyleTarget, type VariableTarget } from "./sources";
import type { TreeTarget } from "./tree";
import { Canvas, landing, pageHolding } from "./places";
import { changedBy } from "./keyed";
import type { PatchTarget } from "./patch";
import type { RuleTarget } from "./rules";
import type { ModeTarget } from "./variable-modes";
import type { DeleteTarget, MoveTarget } from "./structure";
import { createdThisSession } from "./session";
import { errMsg } from "./util";

/** The resolved batch, as writes.ts resolveBatch has it. */
export interface ResolvedTargets {
  trees: ReadonlyMap<number, TreeTarget>;
  patches: ReadonlyMap<number, PatchTarget>;
  rules: ReadonlyMap<number, RuleTarget>;
  modes: ReadonlyMap<number, ModeTarget>;
  moves: ReadonlyMap<number, MoveTarget>;
  deletes: ReadonlyMap<number, DeleteTarget>;
  variables: ReadonlyMap<number, VariableTarget>;
  styles: ReadonlyMap<number, StyleTarget>;
}

/** The most layer ids one op keeps for Show me (the count beyond is said, not selected). */
export const SHOW_CAP = 200;

/** Where Show me pans for a frame not built yet. */
export interface Spot { pageId: string; x: number; y: number }

/** What the review knows of one op. */
export interface OpLayers {
  read: OpRead;
  /** the existing layers it changes, and those that follow it (its own and this session's included: counted later) */
  ids: string[];
  /** the ids counted, when not `ids` (a keyed re-send: Show me starts at its root, which may not change) */
  counted?: string[];
  /** a source edit: other layers follow it */
  source: boolean;
  spot?: Spot;
}

/** Everything the review reads of a batch. */
export interface BatchReads {
  ops: OpLayers[];
  /** existing layers the batch changes, each once, the ones this plugin session created left out */
  layers: number;
  sourceEdits: number;
  /** pages or lookups that could not be read: a count may be low */
  warnings: string[];
}

/** A colour as the spec writes it: #rrggbb, with a fourth pair when not opaque. */
function hexOf(c: RGB | RGBA, opacity?: number): string {
  const h = (v: number): string => { const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length === 1 ? "0" + s : s; };
  const a = "a" in c ? c.a * (opacity === undefined ? 1 : opacity) : opacity;
  return "#" + h(c.r) + h(c.g) + h(c.b) + (a !== undefined && a < 1 ? h(a) : "");
}
/** Paints in the spec's vocabulary (a solid as its colour; any other kind by its type). */
function paintsOf(p: unknown): unknown {
  if (!Array.isArray(p)) return "mixed";
  return p.filter((x: Paint) => x.visible !== false).map((x: Paint) => (x.type === "SOLID" ? { type: "solid", color: hexOf(x.color, x.opacity) } : { type: x.type === "IMAGE" ? "image" : x.type.toLowerCase() }));
}
const isNum = (v: unknown): v is number => typeof v === "number";

/** What `node` holds now under a patch field, in the spec's vocabulary; undefined when the card cannot say. */
function oldOf(node: SceneNode, field: string, to: unknown): unknown {
  const r = node as SceneNode & Partial<Record<string, unknown>>;
  switch (field) {
    case "name": return node.name;
    case "hidden": return !node.visible;
    case "opacity": return isNum(r.opacity) ? r.opacity : undefined;
    case "text": return node.type === "TEXT" ? node.characters : undefined;
    case "fills": return "fills" in node ? paintsOf(r.fills) : undefined;
    case "strokes": return "strokes" in node ? paintsOf(r.strokes) : undefined;
    case "radius": return isNum(r.cornerRadius) ? r.cornerRadius : r.cornerRadius === figma.mixed ? "mixed" : undefined;
    case "box": return { w: Math.round(node.width), h: Math.round(node.height) };
    case "widthMode": return typeof r.layoutSizingHorizontal === "string" ? r.layoutSizingHorizontal.toLowerCase() : undefined;
    case "heightMode": return typeof r.layoutSizingVertical === "string" ? r.layoutSizingVertical.toLowerCase() : undefined;
    case "autoResize": return node.type === "TEXT" ? node.textAutoResize.toLowerCase() : undefined;
    case "layout": {
      // Only when every key the patch sets can be read here: a partial old value would read as a wrong one.
      if (typeof to !== "object" || to === null || !("layoutMode" in node)) return undefined;
      const f = node as FrameNode;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(to)) {
        if (k === "gap") out.gap = f.itemSpacing;
        else if (k === "padding") out.padding = [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft];
        else return undefined;
      }
      return out;
    }
    default: return undefined;
  }
}

/** A variable's value as the spec writes it: a colour as hex, an alias as {aliasOf: name}. */
async function variableValue(v: VariableValue | undefined): Promise<unknown> {
  if (v === undefined) return undefined;
  if (typeof v === "object" && "type" in v && v.type === "VARIABLE_ALIAS") {
    let to: Variable | null = null;
    try { to = await figma.variables.getVariableByIdAsync(v.id); } catch { to = null; }
    return { aliasOf: to ? to.name : v.id };
  }
  if (typeof v === "object" && "r" in v) return hexOf(v);
  return v;
}

/** Read everything the review needs of a resolved batch. Never throws: what cannot be read is left out, and said. */
export async function readBatch(list: readonly WriteOp[], t: ResolvedTargets): Promise<BatchReads> {
  const warnings: string[] = [];
  const warn = (m: string): void => { if (warnings.indexOf(m) < 0) warnings.push(m); };
  const ops: OpLayers[] = [];
  // Where each new tree lands is planned on one canvas, in batch order, so a later op lands beside the earlier ones (places.ts):
  // the trees they land, and what they move, make or resize on a page or in a section (deletes run last: not counted).
  const canvas = new Canvas();
  /** Whether a new tree comes after op `i`: only then is what op `i` changes on the canvas read (nothing is placed after it). */
  const treeAfter = (i: number): boolean => list.slice(i + 1).some((o) => o.op === "createTree");
  /** `n`'s page, loaded (dynamic-page: before the canvas reads what is on it). */
  const loaded = async (n: BaseNode): Promise<void> => { const pg = n.type === "PAGE" ? n : pageHolding(n); if (pg) await pg.loadAsync(); };
  /** A layer a patch sets `box` on, at its size then (a side the box leaves out stays). */
  const patched = async (i: number, n: SceneNode, set: Record<string, unknown>): Promise<void> => {
    const b = set.box as { w?: number; h?: number } | undefined;
    if (!b || typeof b !== "object" || !treeAfter(i)) return;
    await loaded(n);
    canvas.reshape(n, n.x, n.y, typeof b.w === "number" ? b.w : n.width, typeof b.h === "number" ? b.h : n.height);
  };
  for (const [i, op] of list.entries()) {
    const read: OpRead = {};
    const ids: string[] = [];
    let source = false;
    let spot: Spot | undefined;
    let counted: string[] | undefined;
    const follow = async (from: Parameters<typeof followersOf>[0]): Promise<void> => {
      source = true;
      const f = await followersOf(from, warn);
      read.follows = countLayers(f, createdThisSession);
      for (const id of f) { ids.push(id); if (counted) counted.push(id); }
    };
    try {
      switch (op.op) {
        case "patch": {
          const p = t.patches.get(i);
          if (!p) break;
          read.name = p.node.name;
          ids.push(p.node.id);
          const set = p.set as Record<string, unknown>;
          const old: Record<string, unknown> = {};
          for (const k of Object.keys(set)) { const v = oldOf(p.node, k, set[k]); if (v !== undefined) old[k] = v; }
          read.old = old;
          await patched(i, p.node, set);
          const main = mainComponentOf(p.node);
          if (main) { read.component = main.name; await follow({ component: main }); }
          break;
        }
        // Every layer the rule matches (Show me selects them, up to SHOW_CAP); the old value of each field, shared by all
        // of them or "mixed".
        case "patchWhere": {
          const r = t.rules.get(i);
          if (!r) break;
          read.matched = r.match.total;
          read.pages = r.match.pages;
          for (const id of r.ids) ids.push(id);
          const set = r.matches[0] ? (r.matches[0].set as Record<string, unknown>) : {};
          const old: Record<string, unknown> = {};
          const mixed: string[] = [];
          for (const k of Object.keys(set)) {
            let shared: unknown;
            let seen = "";
            let ok = true;
            for (const p of r.matches) {
              const v = oldOf(p.node, k, set[k]);
              if (v === undefined) { ok = false; break; }
              const key = JSON.stringify(v);
              if (seen === "") { seen = key; shared = v; } else if (key !== seen) { mixed.push(k); ok = false; break; }
            }
            if (ok && seen !== "") old[k] = shared;
          }
          read.old = old;
          if (mixed.length) read.mixed = mixed;
          for (const p of r.matches) await patched(i, p.node, p.set as Record<string, unknown>);
          break;
        }
        case "setFill":
        case "setText": {
          const n = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
          if (!n || n.type === "PAGE" || n.type === "DOCUMENT") break;
          read.name = n.name;
          ids.push(n.id);
          if (op.op === "setText" && n.type === "TEXT") read.old = { text: n.characters };
          if (op.op === "setFill" && "fills" in n) {
            const paints = paintsOf((n as SceneNode & MinimalFillsMixin).fills);
            const first = Array.isArray(paints) ? paints[0] as { color?: string } | undefined : undefined;
            read.old = { fill: first && first.color ? first.color : Array.isArray(paints) && !paints.length ? "none" : "mixed" };
          }
          break;
        }
        case "setVariableMode":
        case "clearVariableMode": {
          const m = t.modes.get(i);
          if (m) { read.name = m.node.name; ids.push(m.node.id); }
          break;
        }
        case "setVariable": {
          const v = t.variables.get(i);
          if (!v) break;
          read.name = v.variable.name;
          const old: Record<string, unknown> = {};
          for (const m of v.modes) old[m.name] = await variableValue(v.variable.valuesByMode[m.modeId]);
          read.old = old;
          await follow({ variable: v.variable });
          break;
        }
        case "setStyle": {
          const st = t.styles.get(i);
          if (!st) break;
          read.name = st.style.name;
          const old: Record<string, unknown> = {};
          for (const k of Object.keys(st.set)) {
            if (k === "paints" && st.style.type === "PAINT") old.paints = paintsOf(st.style.paints);
            else { const v: unknown = Reflect.get(st.style, k); if (typeof v === "string" || typeof v === "number") old[k] = v; }
          }
          read.old = old;
          await follow({ style: st.style });
          break;
        }
        case "createTree": {
          const tt = t.trees.get(i);
          if (!tt) break;
          if (tt.update) {
            read.updates = tt.update.root.name;
            const root = tt.update.root;
            // The existing layers the update plan changes, moves or removes (keyed.ts changedBy); Show me starts at the root.
            const changed = changedBy(tt.update.plan, tt.update.key);
            ids.push(root.id);
            for (const id of changed) if (id !== root.id) ids.push(id);
            counted = changed;
            if (tt.update.component && (root.type === "COMPONENT" || root.type === "COMPONENT_SET")) await follow({ component: root });
            // Where it is after the update, so a later op is placed beside it: the x/y and size its plan sets on the root
            // (keyed.ts sets them as planned; a set that only gains variants is counted at its size now).
            const u = tt.update.plan.updates.filter((x) => x.ref === root)[0];
            if (u && treeAfter(i)) {
              const box = u.set && u.set.box;
              const moved = (f: "x" | "y"): boolean => u.extras.indexOf(f) >= 0;
              const sx = tt.spec.x, sy = tt.spec.y;
              canvas.reshape(root, moved("x") && sx !== undefined ? sx : root.x, moved("y") && sy !== undefined ? sy : root.y,
                box && box.w !== undefined ? box.w : root.width, box && box.h !== undefined ? box.h : root.height);
            }
            break;
          }
          // Where it lands (places.ts): a page or section still to make is said as new, and has no spot to pan to.
          // A copy as the root is measured by its source (its size and turn), as the write measures the copy.
          const copied = tt.clones.get(tt.spec);
          const l = landing(canvas, tt.dest, tt.spec, copied ? copied.source : null);
          read.lands = l.lands;
          if (l.spot) spot = l.spot;
          break;
        }
        case "createFrame":
        case "createText": {
          const p = op.parentId ? await figma.getNodeByIdAsync(op.parentId) : null;
          if (p && p.type !== "PAGE" && p.type !== "DOCUMENT") { read.parent = p.name; ids.push(p.id); }
          // A frame lands at 0,0 in its parent, its size given or Figma's 100 (writes.ts). A text's size is its font's:
          // known only once built, so it is not counted.
          const into = op.parentId ? p : figma.currentPage;
          if (op.op === "createFrame" && into && treeAfter(i)) {
            await loaded(into);
            const w = op.width, h = op.height;
            canvas.add(into, op.name || "Frame", w && h ? { x: 0, y: 0, width: w, height: h } : { x: 0, y: 0, width: 100, height: 100 });
          }
          break;
        }
        case "move": {
          const m = t.moves.get(i);
          if (m) {
            read.name = m.node.name; read.parent = m.parent.name; ids.push(m.node.id);
            if (treeAfter(i)) {
              await loaded(m.node);
              await loaded(m.parent);
              canvas.move(m.node, m.parent);
            }
          }
          break;
        }
        case "delete": {
          const d = t.deletes.get(i);
          if (d) { read.name = d.node.name; ids.push(d.node.id); }
          break;
        }
        // A create table makes new names and updates the ones the file has; its line says so. It reads nothing here: what
        // follows an updated variable or style is not counted (the policy's source edits are setVariable, setStyle and a
        // patch of a main component).
        case "createVariables":
        case "createStyles":
          break;
        default: {
          const never: never = op.op;
          void never;
        }
      }
    } catch (e) {
      warn("what op " + i + " changes could not all be read (" + errMsg(e) + ")");
    }
    ops.push({ read, ids, source, ...(spot ? { spot } : {}), ...(counted ? { counted } : {}) });
  }
  // The layers counted: what each op changes, minus a create's parent and a keyed re-send's root when only what is below
  // it changes (Show me shows them; nothing on them changes).
  const changed: string[] = [];
  ops.forEach((o, i) => {
    const op = list[i];
    if (!op || op.op === "createFrame" || op.op === "createText") return;
    for (const id of o.counted || o.ids) changed.push(id);
  });
  return { ops, layers: countLayers(changed, createdThisSession), sourceEdits: ops.filter((o) => o.source).length, warnings };
}

/** Select the nodes of `ids` that are on the first page holding one of them (the current page when it holds any),
 *  switching to it, and zoom to them. Returns how many it selected. */
export async function selectAndZoom(ids: readonly string[]): Promise<number> {
  const byPage = new Map<PageNode, SceneNode[]>();
  for (const id of ids.slice(0, SHOW_CAP)) {
    let n: BaseNode | null = null;
    try { n = await figma.getNodeByIdAsync(id); } catch { n = null; }
    if (!n || n.type === "PAGE" || n.type === "DOCUMENT" || !("visible" in n)) continue;
    let p: BaseNode | null = n.parent;
    while (p && p.type !== "PAGE") p = p.parent;
    if (!p || p.type !== "PAGE") continue;
    const list = byPage.get(p) || [];
    list.push(n);
    byPage.set(p, list);
  }
  const here = byPage.get(figma.currentPage);
  const first = here ? figma.currentPage : [...byPage.keys()][0];
  if (!first) return 0;
  const nodes = byPage.get(first) || [];
  if (first !== figma.currentPage) await figma.setCurrentPageAsync(first);
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
  return nodes.length;
}

/** Pan to where a new frame will land (on its page). */
export async function panTo(spot: Spot): Promise<void> {
  const page = await figma.getNodeByIdAsync(spot.pageId);
  if (page && page.type === "PAGE" && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  figma.viewport.center = { x: spot.x + 200, y: spot.y + 200 };
}
