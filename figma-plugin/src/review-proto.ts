// PROTOTYPE (#174, throwaway): the three review switches the owner tries in live Figma (bridge/src/review-policy.ts
// says what each choice means). This module holds the window's "Review prototype (dev)" setting, what a card adds to
// the plain lines (Show me targets, a drawing), and the select-and-zoom. The losers get deleted once one is picked.
//
// Selecting and zooming change no document state, so they add no undo step: the selection, the viewport and the
// current page are not part of Figma's undo history.
import { reviewProtoOf, REVIEW_PROTO_DEFAULT, type OpFact, type ReviewProto } from "../../bridge/src/review-policy.ts";
import { writeOpPreview, type WriteOp } from "../../bridge/src/commands.ts";
import type { TreeNodeSpec } from "../../bridge/src/tree-spec.ts";
import { followersOf, type VariableTarget, type StyleTarget } from "./sources";
import { landingSpot, type TreeTarget } from "./tree";
import type { PatchTarget } from "./patch";
import type { ReviewBox, ReviewDrawing, ReviewRow, ReviewShow } from "./messages";
import { errMsg } from "./util";

const KEY = "reviewProto";
let proto: ReviewProto = REVIEW_PROTO_DEFAULT;
const loaded: Promise<void> = (async () => {
  try { proto = reviewProtoOf(await figma.clientStorage.getAsync(KEY)); } catch { proto = REVIEW_PROTO_DEFAULT; }
})();

export async function reviewProto(): Promise<ReviewProto> {
  await loaded;
  return proto;
}
/** Set from the window only (main.ts `set-review-proto`), like the checkboxes. */
export async function setReviewProto(raw: unknown): Promise<ReviewProto> {
  await loaded;
  proto = reviewProtoOf(raw);
  try { await figma.clientStorage.setAsync(KEY, proto); } catch (e) { console.error("[export] could not save the review prototype setting:", e); }
  return proto;
}

/** The most layer ids one op keeps for Show me (the count beyond is said, not selected). */
const SHOW_CAP = 200;

/** What one op touches, for the policy (`fact`) and for Show me (`ids`, at most SHOW_CAP of `total`; `spot` where a new
 *  tree will land). */
export interface OpLayers { fact: OpFact; ids: string[]; total: number; spot?: { pageId: string; x: number; y: number } }

/** Every op's layers, read from the file as the batch resolved. A lookup that fails counts nothing (a prototype). */
export async function opLayers(list: readonly WriteOp[], trees: ReadonlyMap<number, TreeTarget>): Promise<OpLayers[]> {
  const out: OpLayers[] = [];
  for (const [i, op] of list.entries()) {
    const effect = writeOpPreview(op, i).effect;
    const own = op.nodeId && effect !== "creates" ? [op.nodeId] : [];
    try {
      if (op.op === "createTree") {
        const t = trees.get(i);
        if (t && t.update) { out.push({ fact: { effect: "overwrites", nodes: [t.update.root.id] }, ids: [t.update.root.id], total: 1 }); continue; }
        const spot = t ? landingSpot(t) : null;
        out.push({ fact: { effect }, ids: [], total: 0, ...(spot ? { spot: { pageId: spot.page.id, x: spot.x, y: spot.y } } : {}) });
        continue;
      }
      if (op.op === "patch" || op.op === "setVariable" || op.op === "setStyle") {
        const follow = await followersOf(op);
        if (follow) {
          const ids = own.concat([...follow].slice(0, SHOW_CAP));
          out.push({ fact: { effect, source: true, nodes: own, follows: follow.size }, ids, total: own.length + follow.size });
          continue;
        }
      }
    } catch (e) {
      console.error("[export] review prototype: could not read what op " + i + " touches:", errMsg(e));
    }
    out.push({ fact: { effect, nodes: own }, ids: own, total: own.length });
  }
  return out;
}

/** The card's Show me row per op: how many layers it can select (null: none, and no landing spot). */
export function showsOf(layers: readonly OpLayers[]): Array<ReviewShow | null> {
  return layers.map((l) => (l.ids.length ? { n: l.ids.length, total: l.total } : l.spot ? { n: 0, total: 0, spot: true } : null));
}

// The Show me targets of each card that is up, by card id (review.ts remembers and forgets them with the card).
const cards = new Map<string, readonly OpLayers[]>();
export function rememberCard(id: string, layers: readonly OpLayers[]): void { cards.set(id, layers); }
export function forgetCard(id: string): void { cards.delete(id); }

/** Show me (`index` an op, -1 all of them): select those layers and zoom to them, on their page; a new tree's line pans
 *  to where it will land. Returns what the window says. */
export async function showLayers(cardId: string, index: number): Promise<string> {
  const layers = cards.get(cardId);
  if (!layers) return "That review has ended.";
  const pick = index < 0 ? layers : layers.slice(index, index + 1);
  const ids: string[] = [];
  let total = 0;
  for (const l of pick) { for (const id of l.ids) if (ids.length < SHOW_CAP && ids.indexOf(id) < 0) ids.push(id); total += l.total; }
  if (!ids.length) {
    const spot = pick.map((l) => l.spot).find((s) => !!s);
    if (!spot) return "Nothing to show: this change has no layer yet.";
    const page = await figma.getNodeByIdAsync(spot.pageId);
    if (page && page.type === "PAGE" && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    figma.viewport.center = { x: spot.x + 200, y: spot.y + 300 };
    return "Not built yet — this is where the new frame will land (" + spot.x + ", " + spot.y + ").";
  }
  const n = await selectAndZoom(ids);
  return "Showing " + n + (total > n ? " (first " + n + " of " + total + ")" : "") + " layer" + (n === 1 ? "" : "s") + ".";
}

/** Select the nodes of `ids` that are on the first page holding one of them (switching to it) and zoom to them. */
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

// ---------------------------------------------------------------- the drawing form

const DRAW_CAP = 150;

/** A schematic of a resolved tree spec, for the window to draw as nested boxes (auto-layout → flex). */
export function schematic(spec: TreeNodeSpec): ReviewBox {
  let left = DRAW_CAP;
  const walk = (s: TreeNodeSpec): ReviewBox => {
    left--;
    const l = s.layout;
    const b: ReviewBox = {};
    if (s.name) b.name = s.name;
    if (l && l.display === "flex") { b.dir = l.flexDirection === "row" ? "row" : "column"; if (l.gap !== undefined) b.gap = l.gap; if (l.padding) b.pad = l.padding.slice(0, 4); }
    const w = s.box ? s.box.w : l && l.width; const h = s.box ? s.box.h : l && l.height;
    if (typeof w === "number") b.w = w;
    if (typeof h === "number") b.h = h;
    const fill = (s.fills || []).find((f) => f.type === "solid");
    if (fill && fill.type === "solid" && fill.color) b.fill = fill.color;
    if (s.text !== undefined) { b.text = s.text; if (s.font && s.font.size) b.size = s.font.size; if (s.font && s.font.color) b.fill = s.font.color; }
    if (s.component) b.inst = s.component;
    if (s.clone) b.inst = "copy of " + s.clone;
    if (s.radius !== undefined && typeof s.radius === "number") b.radius = s.radius;
    const kids: ReviewBox[] = [];
    for (const c of s.children || []) { if (left <= 0) { b.more = true; break; } kids.push(walk(c)); }
    if (kids.length) b.kids = kids;
    return b;
  };
  return walk(spec);
}

/** A colour as the card shows it: #rrggbb[aa]. */
function hexOf(c: RGB | RGBA, opacity?: number): string {
  const h = (v: number): string => { const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length === 1 ? "0" + s : s; };
  const a = "a" in c ? c.a : opacity;
  return "#" + h(c.r) + h(c.g) + h(c.b) + (a !== undefined && a < 1 ? h(a) : "");
}
function paintsText(p: unknown): string {
  if (!Array.isArray(p)) return p === figma.mixed ? "mixed" : "—";
  const first = p[0] as Paint | undefined;
  if (!first) return "none";
  return first.type === "SOLID" ? hexOf(first.color, first.opacity) : first.type.toLowerCase();
}
function short(v: unknown): string {
  if (v === undefined) return "—";
  if (v === figma.mixed) return "mixed";
  if (typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v) { const c = v as RGBA; return hexOf(c); }
  if (typeof v === "object" && v !== null && (v as { type?: unknown }).type === "VARIABLE_ALIAS") return "alias";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}
/** What a node holds now under a patch field, in a few words (the fields a reviewer reads most; the rest show —). */
function oldOf(node: SceneNode, field: string): string {
  const r = node as SceneNode & Partial<Record<string, unknown>>;
  switch (field) {
    case "text": return node.type === "TEXT" ? short(node.characters) : "—";
    case "fills": case "strokes": return paintsText(r[field]);
    case "radius": return short(r.cornerRadius);
    case "box": return Math.round(node.width) + "×" + Math.round(node.height);
    case "hidden": return String(!node.visible);
    default: return field in r ? short(r[field]) : "—";
  }
}
const newText = (to: string): string => { try { const v: unknown = JSON.parse(to); return Array.isArray(v) && v[0] && typeof v[0] === "object" && typeof (v[0] as { color?: unknown }).color === "string" ? String((v[0] as { color: string }).color) : short(v); } catch { return to; } };

/** A PNG of `node`, `width` px wide, or null when Figma cannot draw it. */
async function thumb(id: string, width: number): Promise<Uint8Array | null> {
  try {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !("exportAsync" in n)) return null;
    return await (n as SceneNode).exportAsync({ format: "PNG", constraint: { type: "WIDTH", value: width } });
  } catch { return null; }
}

/** The drawing for each op: a new tree's schematic; a patch's or source edit's "before" thumbnails (the node, or up to
 *  6 layers that follow it) beside rows of field: old → new. No "after" image is drawn. */
export async function drawings(list: readonly WriteOp[], r: { trees: ReadonlyMap<number, TreeTarget>; patches: ReadonlyMap<number, PatchTarget>; variables: ReadonlyMap<number, VariableTarget>; styles: ReadonlyMap<number, StyleTarget> }, layers: readonly OpLayers[]): Promise<Array<ReviewDrawing | null>> {
  const out: Array<ReviewDrawing | null> = [];
  let thumbsLeft = 6;
  for (const [i, op] of list.entries()) {
    const t = r.trees.get(i);
    if (op.op === "createTree" && t && !t.update) { out.push({ tree: schematic(t.spec) }); continue; }
    const rows: ReviewRow[] = [];
    const step = writeOpPreview(op, i);
    const p = r.patches.get(i);
    if (p) for (const f of step.fields || []) rows.push({ field: f.field, old: oldOf(p.node, f.field), now: newText(f.to) });
    const v = r.variables.get(i);
    if (v) for (const m of v.modes) rows.push({ field: m.name, old: short(v.variable.valuesByMode[m.modeId]), now: typeof m.value === "object" && m.value !== null && "aliasOf" in m.value ? "→ " + m.value.aliasOf : short(m.value) });
    const st = r.styles.get(i);
    if (st) for (const f of step.fields || []) rows.push({ field: f.field, old: st.style.type === "PAINT" && f.field === "paints" ? paintsText(st.style.paints) : short((st.style as BaseStyle & Partial<Record<string, unknown>>)[f.field]), now: newText(f.to) });
    if (op.op === "setFill" || op.op === "setText") {
      const n = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
      if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") rows.push(op.op === "setFill" ? { field: "fill", old: paintsText((n as SceneNode & Partial<Record<string, unknown>>).fills), now: String(op.color) } : { field: "text", old: n.type === "TEXT" ? short(n.characters) : "—", now: String(op.text) });
    }
    const l = layers[i];
    const thumbs: Uint8Array[] = [];
    for (const id of l ? l.ids : []) {
      if (thumbsLeft <= 0) break;
      const png = await thumb(id, l && l.ids.length > 1 ? 96 : 240);
      if (png) { thumbs.push(png); thumbsLeft--; }
    }
    out.push(rows.length || thumbs.length ? { rows, thumbs } : null);
  }
  return out;
}
