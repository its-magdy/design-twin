// tree-diff.ts — a keyed tree spec sent again: what to change in the result the file already holds (docs/write-plane-spec.md
// decision 11).
//
// The plugin stores, on every node a keyed spec built, that node's own spec fields as applied (figma-plugin/src/keyed.ts).
// When the same key comes back, the earlier spec is read off those nodes (an OldNode tree whose `ref` is the file's node)
// and planned against the new one here: a node whose fields changed is updated in place — through a `patch` (patch-spec.ts)
// for the fields a patch sets, directly for a few one-property fields (EXTRA_FIELDS) — so its id stays; a child the new spec
// adds is built; one it dropped is removed; a node that changed kind or component, or a field no patch can put back
// (a text's font, an instance's dropped property), is built anew beside the old one, which is then removed.
//
// Only the fields that DIFFER from the spec sent last time are touched, so whatever the designer changed by hand in
// the meantime stays unless the new spec changes that field too. A field the new spec drops goes back to what a fresh
// build leaves it at (no fills on a frame, opacity 1, no auto-layout, …).
//
// Children are matched by `handle`, then by a name that is unique among the old and the new children, then in order.
//
// Pure and dependency-free (bar pure siblings): the plugin bundle imports it, so it must type-check under
// figma-plugin/tsconfig.json (ES2019 lib, no Node types).
import type { PatchLayout, PatchSet, PatchStrokes, PatchTokens } from "./patch-spec.ts";
import { nodeKind, NUMBER_TOKEN_FIELDS, type NodeKind, type TreeNodeSpec } from "./tree-spec.ts";

/** A node of the earlier result: its own spec fields as last applied (no `children`), the file's node, its children
 *  (the ones the same key built, in the file's order). */
export interface OldNode<T> { ref: T; spec: TreeNodeSpec; children: Array<OldNode<T>> }

/** The fields a re-send sets on the node itself, one Figma property each (no patch sets them). */
export const EXTRA_FIELDS = ["x", "y", "absolute", "grow", "alignSelf", "clip", "sizeLimits", "strokesInLayout"] as const;
export type ExtraField = (typeof EXTRA_FIELDS)[number];

/** A kept node whose fields change. */
export interface NodeUpdate<T> {
  ref: T;
  /** the node's new spec (children included) */
  spec: TreeNodeSpec;
  /** the spec fields that differ and change something, in the order they are listed in the reply */
  fields: string[];
  /** what a patch sets for them (null when none goes through one) */
  set: PatchSet | null;
  /** the fields set on the node directly, read from `spec` */
  extras: ExtraField[];
  /** where it is in the new spec ("tree.children[1]") */
  path: string;
}
/** A node built from the new spec: a child it adds, or a node built anew in place of `replaces`. */
export interface NodeBuild<T> {
  /** the kept frame it is built in */
  parent: T;
  /** the whole subtree */
  spec: TreeNodeSpec;
  /** the old node it takes the place of (removed once the batch has landed), or null for a new child */
  replaces: T | null;
  path: string;
}
/** The order a kept frame's spec children end in: a kept node, or the node `builds[build]` made. */
export interface ChildOrder<T> { parent: T; order: Array<{ ref: T } | { build: number }> }
export interface Plan<T> {
  /** parents before their children */
  updates: Array<NodeUpdate<T>>;
  builds: Array<NodeBuild<T>>;
  /** old nodes the new spec no longer has (a node built anew is removed through its build's `replaces`) */
  removals: T[];
  /** every frame whose spec children change order or gain a node */
  orders: Array<ChildOrder<T>>;
  /** every kept node whose stored spec changes (a handle-only change included), with its new own spec */
  stamps: Array<{ ref: T; spec: TreeNodeSpec }>;
  /** handles the new spec gives to kept nodes that did not have them (their ids come back) */
  handles: Array<{ handle: string; ref: T }>;
}

/** A spec node's own fields: without `children`. */
export function ownSpec(s: TreeNodeSpec): TreeNodeSpec {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s)) {
    const v = (s as Record<string, unknown>)[k];
    if (k !== "children" && v !== undefined) out[k] = v;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** `v` as JSON with every object's keys sorted (and undefined left out), so two equal values compare equal. */
function canonical(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
/** `o` without `keys` (undefined when nothing is left). */
function without(o: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isObj(o)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (keys.indexOf(k) < 0 && o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}

/** The fields compared as they set something: the ones that set nothing (`handle`, `renderBox`, `reference`, a box's
 *  page coordinates, a font's numeric weight) are left out, and a frame's size is one field (`box`, or `layout`'s
 *  width/height). */
function compared(s: TreeNodeSpec, kind: NodeKind): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s)) {
    const v = (s as Record<string, unknown>)[k];
    if (v === undefined || k === "children" || k === "handle" || k === "renderBox" || k === "reference" || k === "key") continue;
    if (k === "box") { out.box = without(v, ["x", "y"]); continue; }
    if (k === "font") { out.font = without(v, ["weightValue"]); continue; }
    if (k === "layout") { out.layout = without(v, ["width", "height"]); continue; }
    out[k] = v;
  }
  if (kind === "FRAME") {
    const size = sizeOf(s);
    if (size) out.box = size;
  }
  return out;
}
/** A frame's size as the build sets it: `box`, else `layout.width`/`height` (either may be left out). */
function sizeOf(s: TreeNodeSpec): { w?: number; h?: number } | undefined {
  if (s.box) return { w: s.box.w, h: s.box.h };
  const l = s.layout;
  if (!l || (l.width === undefined && l.height === undefined)) return undefined;
  return { ...(l.width !== undefined ? { w: l.width } : {}), ...(l.height !== undefined ? { h: l.height } : {}) };
}

/** Why a matched node is built anew instead of updated, or null when it can be updated in place. */
function rebuildReason(kind: NodeKind, a: TreeNodeSpec, b: TreeNodeSpec, changed: readonly string[]): string | null {
  if (nodeKind(a) !== kind) return "its type changed";
  if (kind === "INSTANCE") {
    if (a.component !== b.component) return "its component changed";
    if (changed.indexOf("name") >= 0 && b.name === undefined) return "its name was dropped";
    if (changed.indexOf("box") >= 0 && b.box === undefined) return "its size was dropped";
    const gone = Object.keys(a.props || {}).filter((k) => !b.props || !(k in b.props));
    if (gone.length) return "a property it set was dropped";
  }
  if (kind === "TEXT") {
    for (const f of ["font", "truncate", "maxLines", "widthMode", "heightMode"]) if (changed.indexOf(f) >= 0) return "`" + f + "` changed";
    if (changed.indexOf("styles") >= 0 && !(b.styles && b.styles.text !== undefined)) return "its text style was dropped";
    if (changed.indexOf("strokes") >= 0 && a.strokes && a.strokes.align !== undefined && !(b.strokes && b.strokes.align !== undefined)) return "its stroke alignment was dropped";
  }
  return null;
}

const SIDES = ["top", "right", "bottom", "left"] as const;

/** The patch and the direct fields that bring a kept node from `a` to `b`, for the fields in `changed`. */
function translate(kind: NodeKind, a: TreeNodeSpec, b: TreeNodeSpec, changed: readonly string[]): { set: PatchSet; extras: ExtraField[]; fields: string[] } {
  const set: PatchSet = {};
  const tokens: PatchTokens = {};
  const extras: ExtraField[] = [];
  const fields: string[] = [];
  const has = (f: string): boolean => changed.indexOf(f) >= 0;
  const touch = (f: string): void => { if (fields.indexOf(f) < 0) fields.push(f); };
  const bt = b.tokens || {};
  const at = a.tokens || {};

  if (has("name")) { set.name = b.name !== undefined ? b.name : kind === "TEXT" ? b.text || "" : "Frame"; touch("name"); }
  if (has("hidden")) { set.hidden = b.hidden === true; touch("hidden"); }
  if (has("opacity")) { set.opacity = b.opacity !== undefined ? b.opacity : 1; touch("opacity"); }
  if (has("text") && b.text !== undefined) { set.text = b.text; touch("text"); }
  if (has("styles") && b.styles && b.styles.text !== undefined) { set.styles = { text: b.styles.text }; touch("styles"); }
  if (has("props") && b.props) { set.props = b.props; touch("props"); }
  if (has("layout") && kind === "FRAME") { set.layout = layoutOf(b); touch("layout"); }
  if (has("radius")) {
    const r = b.radius;
    set.radius = r === undefined ? 0 : typeof r === "number" ? r : { tl: r.tl || 0, tr: r.tr || 0, br: r.br || 0, bl: r.bl || 0 };
    touch("radius");
  }
  // The size: a frame's from `box` or `layout.width`/`height` (an axis a sizing mode decides is left to it); a text's with
  // how its box follows the text; an instance's from `box`.
  if (has("box") || (kind === "TEXT" && has("autoResize"))) {
    if (kind === "TEXT") {
      if (b.box) set.box = { w: b.box.w, h: b.box.h };
      set.autoResize = b.autoResize !== undefined ? b.autoResize : b.box ? "none" : "width_and_height";
      if (has("box")) touch("box");
      if (has("autoResize")) touch("autoResize");
    } else {
      const size = kind === "FRAME" ? sizeOf(b) : b.box;
      const box: { w?: number; h?: number } = {};
      if (size && size.w !== undefined && b.widthMode === undefined) box.w = size.w;
      if (size && size.h !== undefined && b.heightMode === undefined) box.h = size.h;
      // No size at all, and no sizing mode: a new frame's own (100 × 100).
      if (!size && b.widthMode === undefined && b.heightMode === undefined) { box.w = 100; box.h = 100; }
      if (box.w !== undefined || box.h !== undefined) { set.box = box; touch("box"); }
    }
  }
  for (const axis of ["widthMode", "heightMode"] as const) {
    if (!has(axis)) continue;
    const m = b[axis];
    set[axis] = m !== undefined ? m : "fixed";
    touch(axis);
  }
  // Paints: `fills` and `tokens.fills` are one thing (the paints and the variables they are bound to).
  if (kind !== "INSTANCE" && (has("fills") || !same(at.fills, bt.fills))) {
    if (b.fills) set.fills = b.fills;
    else if (bt.fills !== undefined) tokens.fills = bt.fills;
    else set.fills = kind === "TEXT" ? [{ type: "solid", color: b.font && b.font.color !== undefined ? b.font.color : "#000000" }] : [];
    touch("fills");
  }
  // Strokes: the colours with the variables bound to them, the weights, the alignment. A part the new spec drops goes
  // back to a new node's (weight 1, inside).
  if (kind !== "INSTANCE" && (has("strokes") || !same(at.strokes, bt.strokes))) {
    const sa = a.strokes || {};
    const sb = b.strokes || {};
    const st: PatchStrokes = {};
    if (sb.colors) st.colors = sb.colors;
    else if (bt.strokes === undefined) st.colors = [];
    if (st.colors !== undefined && st.colors.length && bt.strokes !== undefined) tokens.strokes = bt.strokes;
    else if (st.colors === undefined) tokens.strokes = bt.strokes !== undefined ? bt.strokes : null;
    if (sb.weight !== undefined) st.weight = sb.weight;
    else if (sa.weight !== undefined) st.weight = 1;
    if (kind === "FRAME" && (sb.weights !== undefined || sa.weights !== undefined)) {
      const w: { top?: number; right?: number; bottom?: number; left?: number } = {};
      for (const side of SIDES) {
        const v = sb.weights && sb.weights[side];
        if (v !== undefined) w[side] = v;
        else if (sa.weights && sa.weights[side] !== undefined) w[side] = 1;
      }
      if (Object.keys(w).length) st.weights = w;
    }
    if (sb.align !== undefined) st.align = sb.align;
    else if (sa.align !== undefined) st.align = "inside";
    if (Object.keys(st).length) set.strokes = st;
    touch("strokes");
  }
  // The variables bound to number fields: a dropped one is unbound (its value stays), a new or changed one bound. A raw
  // value the patch sets unbinds its field, so once anything is set every binding the new spec has is given again.
  const numberChanged = NUMBER_TOKEN_FIELDS.filter((k) => at[k] !== bt[k]);
  if (numberChanged.length) touch("tokens");
  for (const k of numberChanged) tokens[k] = bt[k] !== undefined ? bt[k] : null;
  if (Object.keys(set).length || numberChanged.length) for (const k of NUMBER_TOKEN_FIELDS) if (bt[k] !== undefined) tokens[k] = bt[k];
  if (Object.keys(tokens).length) set.tokens = tokens;

  for (const f of EXTRA_FIELDS) {
    if (!has(f)) continue;
    // A position the new spec drops leaves the node where it is.
    if ((f === "x" || f === "y") && b[f] === undefined) continue;
    if ((f === "clip" || f === "sizeLimits" || f === "strokesInLayout") && kind !== "FRAME") continue;
    extras.push(f);
    touch(f);
  }
  return { set, extras, fields };
}

/** A frame's auto-layout as a patch sets it whole: every field the new spec leaves out goes back to a new frame's. */
function layoutOf(b: TreeNodeSpec): PatchLayout {
  const l = b.layout;
  if (!l || l.display !== "flex") return { mode: "absolute" };
  const column = l.flexDirection === "column";
  const out: PatchLayout = {
    display: "flex",
    flexDirection: column ? "column" : "row",
    gap: l.gap !== undefined ? l.gap : 0,
    padding: l.padding ? l.padding : [0, 0, 0, 0],
    justifyContent: l.justifyContent !== undefined ? l.justifyContent : "flex-start",
    alignItems: l.alignItems !== undefined ? l.alignItems : "flex-start",
    flexWrap: l.flexWrap === "wrap" ? "wrap" : "nowrap",
    reverseZ: l.reverseZ === true,
  };
  if (l.flexWrap === "wrap") {
    // The gap between wrapped tracks: rowGap in a row, columnGap in a column.
    if (column) out.columnGap = l.columnGap !== undefined ? l.columnGap : 0;
    else out.rowGap = l.rowGap !== undefined ? l.rowGap : 0;
    out.alignContent = l.alignContent !== undefined ? l.alignContent : "auto";
  }
  return out;
}

/** Pair the new children with the old: by handle, then by a name unique on both sides, then in order. An old child with
 *  a handle pairs only by it (a new spec that gives a node a handle pairs it with an old one that had none). */
function match<T>(olds: ReadonlyArray<OldNode<T>>, news: readonly TreeNodeSpec[]): Array<OldNode<T> | null> {
  const out: Array<OldNode<T> | null> = news.map(() => null);
  const used = new Set<number>();
  news.forEach((n, i) => {
    if (n.handle === undefined) return;
    const j = olds.findIndex((o, k) => !used.has(k) && o.spec.handle === n.handle);
    if (j >= 0) { out[i] = olds[j] || null; used.add(j); }
  });
  const count = <X>(list: readonly X[], name: string | undefined, of: (x: X) => string | undefined): number => list.filter((x) => of(x) === name).length;
  news.forEach((n, i) => {
    if (out[i] || n.name === undefined) return;
    if (count(news, n.name, (x) => x.name) !== 1 || count(olds, n.name, (o) => o.spec.name) !== 1) return;
    const j = olds.findIndex((o, k) => !used.has(k) && o.spec.name === n.name && o.spec.handle === undefined);
    if (j >= 0) { out[i] = olds[j] || null; used.add(j); }
  });
  // In order: two nodes that both have names pair only when the names are the same (a different name is a different
  // node; give a node a handle to rename it in place).
  let next = 0;
  news.forEach((n, i) => {
    if (out[i]) return;
    while (next < olds.length && (used.has(next) || (olds[next] && (olds[next] as OldNode<T>).spec.handle !== undefined))) next++;
    const o = olds[next];
    if (!o) return;
    if (n.name !== undefined && o.spec.name !== undefined && n.name !== o.spec.name) return;
    out[i] = o; used.add(next); next++;
  });
  return out;
}

/** Plan the update of the result `old` (the root of the earlier spec) to the new spec `spec`. */
export function planUpdate<T>(old: OldNode<T>, spec: TreeNodeSpec): Plan<T> {
  const plan: Plan<T> = { updates: [], builds: [], removals: [], orders: [], stamps: [], handles: [] };
  visit(old, spec, "tree", plan);
  return plan;
}

function visit<T>(old: OldNode<T>, spec: TreeNodeSpec, path: string, plan: Plan<T>): void {
  const kind = nodeKind(spec) || "FRAME";
  const a = compared(old.spec, kind);
  const b = compared(spec, kind);
  const changed = Object.keys(a).concat(Object.keys(b).filter((k) => !(k in a))).filter((k) => !same(a[k], b[k]));
  if (changed.length) {
    const t = translate(kind, old.spec, spec, changed);
    if (t.fields.length) plan.updates.push({ ref: old.ref, spec, fields: t.fields, set: Object.keys(t.set).length ? t.set : null, extras: t.extras, path });
  }
  if (!same(old.spec, ownSpec(spec))) plan.stamps.push({ ref: old.ref, spec: ownSpec(spec) });
  if (spec.handle !== undefined && spec.handle !== old.spec.handle) plan.handles.push({ handle: spec.handle, ref: old.ref });
  if (kind !== "FRAME") return;
  const news = spec.children || [];
  const pairs = match(old.children, news);
  const order: Array<{ ref: T } | { build: number }> = [];
  let built = false;
  news.forEach((n, i) => {
    const at = path + ".children[" + i + "]";
    const o = pairs[i];
    const why = o ? replaceReason(o, n) : null;
    if (o && why === null) { visit(o, n, at, plan); order.push({ ref: o.ref }); return; }
    order.push({ build: plan.builds.length });
    plan.builds.push({ parent: old.ref, spec: n, replaces: o ? o.ref : null, path: at });
    built = true;
  });
  const kept = new Set(pairs.filter((p): p is OldNode<T> => p !== null).map((p) => p.ref));
  for (const o of old.children) if (!kept.has(o.ref)) plan.removals.push(o.ref);
  // The kept children in the file's order, against the new spec's order.
  const before = old.children.filter((o) => kept.has(o.ref)).map((o) => o.ref);
  const after = order.filter((e): e is { ref: T } => "ref" in e && kept.has(e.ref)).map((e) => e.ref);
  const reordered = before.some((r, i) => r !== after[i]);
  if (built || reordered) plan.orders.push({ parent: old.ref, order });
}

/** Why the old node `o` cannot become `n` in place (null when it can). */
function replaceReason<T>(o: OldNode<T>, n: TreeNodeSpec): string | null {
  const kind = nodeKind(n) || "FRAME";
  const a = compared(o.spec, kind);
  const b = compared(n, kind);
  const changed = Object.keys(a).concat(Object.keys(b).filter((k) => !(k in a))).filter((k) => !same(a[k], b[k]));
  return rebuildReason(kind, o.spec, n, changed);
}
