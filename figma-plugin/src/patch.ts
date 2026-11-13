// Patch by id (writes: patch): change the fields of an existing node (docs/write-plane-spec.md decisions 2, 5, 14, 15, 16).
//
// The patch's `set` has been checked whole before this module sees it (bridge/src/patch-spec.ts checkPatch, run by
// the wire check and again by applyWrites). What is left can only be answered by the file, and is answered BEFORE the
// first op of the batch runs (resolvePatchOps): the node exists and is a kind that has each field (a text for `text`,
// an instance for `props`, auto-layout for a gap), the fonts a text change needs load, the instance's property names
// and values exist, and every variable and text style the patch names resolves — through tree-refs.ts, exactly as a
// tree spec's names do. Every problem of every op is listed in one refusal.
//
// Applying (applyPatch) first keeps what the node has now for everything the patch can touch, then sets the fields in
// PATCH_FIELDS order. The Change it returns puts all of it back, in a fixed order that Figma accepts (auto-layout before
// the sizes and sizing that need it, raw values before the variables bound to them, the text last); a patch that throws
// halfway puts itself back before the error reaches the batch, and a later op failing puts the whole patch back.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * Setting a field's raw value unbinds a variable bound to it; node.setBoundVariable(field, null) unbinds and keeps
//     the value. A paint is bound or unbound with figma.variables.setBoundVariableForPaint (a copy comes back).
//   * Setting `characters`, a text style or a range's font needs every font involved loaded first; a text style is set
//     with setTextStyleIdAsync / setRangeTextStyleIdAsync under documentAccess "dynamic-page" ("" detaches it).
//   * getStyledTextSegments splits a text into runs that share the fields asked for, so a mixed text is kept run by run.
//   * layoutSizingHorizontal/Vertical "FILL" is valid only on a child of an auto-layout frame, "HUG" only on an
//     auto-layout frame or a text; resize() fixes the size it is given.
//   * An instance's getMainComponentAsync is the async form dynamic-page requires; componentProperties holds each
//     property's current value under the key setProperties takes.
import type { AppliedWrite, WriteOp } from "../../bridge/src/commands.ts";
import { checkPatch, isPatchSet, type PatchSet } from "../../bridge/src/patch-spec.ts";
import { NUMBER_TOKEN_FIELDS, type NumberTokenField, type TreeFill } from "../../bridge/src/tree-spec.ts";
import { solid } from "./tree";
import { mapProps, patchUses, resolveRefs, variantFor, type RefResolution, type ResolvedRefs, type Use } from "./tree-refs";
import { errMsg } from "./util";
import { RestoreStopped, type Change, type OpProblem } from "./write-batch";

/** A patch op whose node, fonts and names all resolved. */
export interface PatchTarget {
  node: SceneNode;
  set: PatchSet;
  unbound: number;
  /** `props` keyed as setProperties takes them (null when the patch sets none) */
  props: Record<string, string | boolean> | null;
  refs: ResolvedRefs;
  /** the variables the node's number fields are bound to before the batch, by id: bound back on restore */
  bound: Map<string, Variable>;
}

/** A node field by name: read as unknown and written through its setter. The fields a patch keeps and puts back are
 *  listed by name (LAYOUT_PROPS, …), so they are reached the way Figma exposes them, as properties. */
const getF = (n: object, k: string): unknown => Reflect.get(n, k);
function setF(n: object, k: string, v: unknown): void {
  if (!Reflect.set(n, k, v)) throw new Error("cannot set " + k);
}
/** Bind (or, with null, unbind) a number field of `node` to a variable. */
function bindField(node: SceneNode, k: NumberTokenField, v: Variable | null): void {
  node.setBoundVariable(k, v);
}
/** The id of the variable `node`'s field `k` is bound to, or null. */
function boundId(node: SceneNode, k: string): string | null {
  const bv: unknown = "boundVariables" in node ? node.boundVariables : undefined;
  const a = bv && typeof bv === "object" ? getF(bv, k) : undefined;
  if (!a || typeof a !== "object") return null;
  const id = getF(a, "id");
  return typeof id === "string" ? id : null;
}
const has = (node: BaseNode, k: string): boolean => k in node;
const isFlex = (n: BaseNode | null): boolean => !!n && "layoutMode" in n && n.layoutMode !== "NONE";
const SPACING_FIELDS: readonly string[] = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "counterAxisSpacing"];

/** The layout direction the node has once the patch's `layout` is set ("none" without auto-layout). */
function directionAfter(node: BaseNode, set: PatchSet): "row" | "column" | "none" {
  const l = set.layout;
  if (l && l.mode === "absolute") return "none";
  if (l && l.flexDirection) return l.flexDirection;
  const now = "layoutMode" in node ? node.layoutMode : "NONE";
  if (now === "VERTICAL") return "column";
  if (now === "HORIZONTAL" || (l && l.display === "flex")) return "row";
  return "none";
}

/** Why the node cannot take this patch, field by field (empty when it can). */
function unfit(node: SceneNode, set: PatchSet): string[] {
  const out: string[] = [];
  const say = (field: string, m: string): void => { out.push("set." + field + ": " + m); };
  const what = "'" + node.name + "' is a " + node.type;
  for (const f of ["text", "styles", "autoResize"] as const) if (set[f] !== undefined && node.type !== "TEXT") say(f, "only on a TEXT node; " + what);
  if (set.props !== undefined && node.type !== "INSTANCE") say("props", "only on an INSTANCE node; " + what);
  if (set.fills !== undefined && !has(node, "fills")) say("fills", what + ", which has no fills");
  if (set.strokes !== undefined) {
    if (!has(node, "strokes")) say("strokes", what + ", which has no strokes");
    else if (set.strokes.weights !== undefined && !has(node, "strokeTopWeight")) say("strokes.weights", "per-side weights are not on a " + node.type + "; use `strokes.weight`");
  }
  if (set.radius !== undefined && !has(node, "cornerRadius")) say("radius", what + ", which has no corner radius");
  else if (set.radius !== undefined && node.type === "VECTOR") say("radius", "a vector's corner radius is set per vertex, which a patch cannot put back yet");
  else if (typeof set.radius === "object" && !has(node, "topLeftRadius")) say("radius", what + ", which has no per-corner radius; give one number");
  if (set.opacity !== undefined && !has(node, "opacity")) say("opacity", what + ", which has no opacity");
  if (set.box !== undefined && !has(node, "resize")) say("box", what + ", which cannot be resized");
  const flexAfter = directionAfter(node, set) !== "none";
  const l = set.layout;
  if (l) {
    if (!has(node, "layoutMode")) say("layout", what + ", which cannot have auto-layout (a frame, component or instance can)");
    else if (l.mode === undefined && l.display === undefined && !flexAfter) {
      const fields = Object.keys(l).filter((k) => l[k as keyof typeof l] !== undefined);
      say("layout", "'" + node.name + "' has no auto-layout, so " + fields.map((k) => "`layout." + k + "`").join(", ") + " would do nothing; add `display: \"flex\"`");
    } else if (flexAfter) {
      const wraps = l.flexWrap === "wrap" || (l.flexWrap === undefined && "layoutWrap" in node && node.layoutWrap === "WRAP" && l.display === undefined);
      for (const k of ["rowGap", "columnGap", "alignContent"] as const) if (l[k] !== undefined && !wraps) say("layout." + k, "needs wrapping: give `flexWrap: \"wrap\"` (the node does not wrap)");
      const dir = directionAfter(node, set);
      if (wraps && (dir === "column" ? l.rowGap : l.columnGap) !== undefined) say("layout." + (dir === "column" ? "rowGap" : "columnGap"), "is the main-axis gap in a wrapping " + dir + "; use `gap`");
      if (l.alignItems === "baseline" && dir === "column") say("layout.alignItems", "\"baseline\" works only in a row; the node is a column");
    }
  }
  const parent = node.parent;
  for (const axis of ["widthMode", "heightMode"] as const) {
    const m = set[axis];
    if (m === undefined) continue;
    if (!has(node, "layoutSizingHorizontal")) { say(axis, what + ", which has no sizing mode"); continue; }
    if (m === "fill") {
      if (!isFlex(parent)) say(axis, "\"fill\" needs a parent with auto-layout; '" + node.name + "''s parent has none");
      else if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") say(axis, "\"fill\" is not on an absolutely positioned child (it is out of the auto-layout flow)");
    }
    if (m === "hug" && node.type !== "TEXT" && !flexAfter) say(axis, "\"hug\" needs auto-layout on the node (or a TEXT); '" + node.name + "' has none — add `layout: {display: \"flex\"}`");
  }
  const t = set.tokens || {};
  for (const k of Object.keys(t) as Array<keyof typeof t>) {
    if (t[k] === undefined) continue;
    if (k === "fills" || k === "strokes") { if (!has(node, k)) say("tokens." + k, what + ", which has no " + k); continue; }
    if (!has(node, k)) { say("tokens." + k, what + ", which has no `" + k + "` to bind"); continue; }
    if (t[k] !== null && SPACING_FIELDS.indexOf(k) >= 0 && !flexAfter) say("tokens." + k, "needs auto-layout on the node; '" + node.name + "' has none");
  }
  if (t.fills === null && set.fills === undefined && node.type === "TEXT" && node.fills === figma.mixed) say("tokens.fills", "the text's paints differ from run to run; give `fills` to replace them instead");
  return out;
}

/** Every font a text node uses now (all of them, for a mixed text). */
function fontsOf(t: TextNode): FontName[] {
  const len = t.characters.length;
  if (len > 0) return t.getRangeAllFontNames(0, len);
  return t.fontName !== figma.mixed ? [t.fontName] : [];
}

/**
 * Resolve every patch op of a batch against the file. Every op is looked at, so the refusal lists every problem at
 * once; the variables and text styles of all of them are resolved together (one lookup per name).
 */
export async function resolvePatchOps(ops: readonly WriteOp[]): Promise<{ targets: Map<number, PatchTarget>; problems: OpProblem[]; imports: RefResolution["imports"]; importCount: number }> {
  const targets = new Map<number, PatchTarget>();
  const problems: OpProblem[] = [];
  const uses: Use[] = [];
  const loaded = new Map<string, Promise<string | null>>();
  const loadFont = (f: FontName): Promise<string | null> => {
    const key = f.family + "|" + f.style;
    let p = loaded.get(key);
    if (!p) {
      p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file");
      loaded.set(key, p);
    }
    return p;
  };
  const empty: ResolvedRefs = { instances: new Map(), variables: new Map(), textStyles: new Map() };

  for (const [index, op] of ops.entries()) {
    if (op.op !== "patch") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const set = op.set;
    // Checked by writeOpError already; this is the narrowing, and a last line.
    if (!isPatchSet(set)) { bad("the patch did not pass its check"); continue; }
    uses.push(...patchUses(index, set));
    const nd = op.nodeId ? await figma.getNodeByIdAsync(op.nodeId) : null;
    if (!nd) { bad("no node with id '" + String(op.nodeId) + "' (invalid or removed)"); continue; }
    if (nd.type === "DOCUMENT" || nd.type === "PAGE") { bad("'" + nd.name + "' is a " + nd.type + "; a patch changes a layer on a page"); continue; }
    const node = nd;
    const misfits = unfit(node, set);
    for (const m of misfits) bad(m);
    // A text change keeps the text as it was, run by run, to put back: its fonts must load either way.
    if (node.type === "TEXT") {
      for (const f of fontsOf(node)) {
        const err = await loadFont(f);
        if (err) bad("'" + node.name + "' uses the " + err + ", so it cannot be changed");
      }
    }
    let props: Record<string, string | boolean> | null = null;
    if (set.props && node.type === "INSTANCE") {
      const main = await node.getMainComponentAsync();
      if (!main) { bad("set.props: the instance '" + node.name + "' has no main component to read its properties from"); continue; }
      const owner = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
      let defs: ComponentPropertyDefinitions;
      try { defs = (owner || main).componentPropertyDefinitions; } catch { defs = {}; }
      const mapped = mapProps(set.props, defs, (owner || main).name);
      if ("errors" in mapped) { for (const e of mapped.errors) bad("set.props: " + e); continue; }
      if (owner) {
        const shown = variantFor(owner, main, mapped.ok, defs);
        if ("missing" in shown) { bad("set.props: component '" + owner.name + "' has no variant " + shown.missing); continue; }
      }
      props = mapped.ok;
    }
    // The variables the node's number fields are bound to now: a raw value set by the patch unbinds one, and a
    // restore binds it back.
    const bound = new Map<string, Variable>();
    for (const k of NUMBER_TOKEN_FIELDS) {
      const id = boundId(node, k);
      if (!id || bound.has(id)) continue;
      let v: Variable | null = null;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
      if (v) bound.set(id, v);
    }
    if (misfits.length) continue;
    targets.set(index, { node, set, unbound: checkPatch(set).summary.unbound, props, refs: empty, bound });
  }
  const r = await resolveRefs(uses, loadFont);
  problems.push(...r.problems);
  for (const t of targets.values()) t.refs = r.refs;
  return { targets, problems, imports: r.imports, importCount: r.importCount };
}

// ---------------------------------------------------------------- keeping and putting back

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Set `k` back to `v` when it differs (an unchanged field is not touched: setting some fields is only valid in some
 *  states, and a field the batch did not change needs no setting). */
function putBack(n: object, k: string, v: unknown): void {
  if (!same(getF(n, k), v)) setF(n, k, v);
}
const LAYOUT_PROPS = ["layoutMode", "layoutWrap", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems",
  "counterAxisAlignItems", "counterAxisSpacing", "counterAxisAlignContent", "itemReverseZIndex"] as const;
const STROKE_PROPS = ["strokes", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeAlign"] as const;
const CORNER_PROPS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] as const;
const SEGMENT_FIELDS = ["fontName", "fontSize", "textStyleId", "fills", "fillStyleId", "lineHeight", "letterSpacing", "textCase", "textDecoration",
  "paragraphSpacing", "paragraphIndent", "boundVariables"] as const;
type Segment = Pick<StyledTextSegment, (typeof SEGMENT_FIELDS)[number] | "start" | "end">;
const TEXT_BINDABLE: readonly VariableBindableTextField[] = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
/** A restore: puts a change back, asking `allowed` after every await (RestoreStopped once "Allow edits" is off). */
export type Restore = (allowed: () => boolean) => Promise<void>;
const checker = (allowed: () => boolean) => (): void => { if (!allowed()) throw new RestoreStopped("'Allow edits' was turned off"); };

/** The props of `n` named in `keys` that it has, as they are now. */
function keep(n: object, keys: readonly string[]): Array<[string, unknown]> {
  return keys.filter((k) => k in n).map((k): [string, unknown] => [k, getF(n, k)]);
}
/** The variables `ids` name, by id (one that does not resolve is left out). */
async function variablesById(ids: Iterable<string>): Promise<Map<string, Variable>> {
  const out = new Map<string, Variable>();
  for (const id of ids) {
    if (out.has(id)) continue;
    let v: Variable | null = null;
    try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
    if (v) out.set(id, v);
  }
  return out;
}

/** A text as it is now, run by run, and how to put it back: its characters; then each run's text style, the formatting
 *  on top of it (or the raw formatting of an unstyled run: font, size, line height, letter spacing, case, decoration,
 *  paragraph spacing and indent), its paints and paint style; then, last, the variables its runs were bound to (a raw
 *  value set above unbinds one). Every font involved must be loaded by the caller. */
export async function keepText(t: TextNode): Promise<Restore> {
  const chars = t.characters;
  const runs: Segment[] = chars.length ? t.getStyledTextSegments([...SEGMENT_FIELDS]) : [];
  const whole = chars.length ? null : { fontName: t.fontName, fontSize: t.fontSize, textStyleId: t.textStyleId, fills: t.fills, fillStyleId: t.fillStyleId };
  const ids: string[] = [];
  for (const r of runs) for (const f of TEXT_BINDABLE) { const a = r.boundVariables && r.boundVariables[f]; if (a) ids.push(a.id); }
  const vars = await variablesById(ids);
  return async (allowed) => {
    const check = checker(allowed);
    if (t.characters !== chars) t.characters = chars;
    if (whole) {
      // An empty text has one formatting: its style (kept when it already matches), then the rest.
      const style = typeof whole.textStyleId === "string" ? whole.textStyleId : null;
      if (style !== null && t.textStyleId !== style) { await t.setTextStyleIdAsync(style); check(); }
      if (whole.fontName !== figma.mixed) putBack(t, "fontName", whole.fontName);
      if (whole.fontSize !== figma.mixed) putBack(t, "fontSize", whole.fontSize);
      if (whole.fills !== figma.mixed) putBack(t, "fills", whole.fills);
      if (typeof whole.fillStyleId === "string" && whole.fillStyleId && t.fillStyleId !== whole.fillStyleId) { await t.setFillStyleIdAsync(whole.fillStyleId); check(); }
      return;
    }
    if (same(t.getStyledTextSegments([...SEGMENT_FIELDS]), runs)) return;
    for (const r of runs) {
      const s = r.start, e = r.end;
      if (t.getRangeTextStyleId(s, e) !== r.textStyleId) { await t.setRangeTextStyleIdAsync(s, e, r.textStyleId); check(); }
      if (!same(t.getRangeFontName(s, e), r.fontName)) t.setRangeFontName(s, e, r.fontName);
      if (!same(t.getRangeFontSize(s, e), r.fontSize)) t.setRangeFontSize(s, e, r.fontSize);
      if (!same(t.getRangeLineHeight(s, e), r.lineHeight)) t.setRangeLineHeight(s, e, r.lineHeight);
      if (!same(t.getRangeLetterSpacing(s, e), r.letterSpacing)) t.setRangeLetterSpacing(s, e, r.letterSpacing);
      if (!same(t.getRangeTextCase(s, e), r.textCase)) t.setRangeTextCase(s, e, r.textCase);
      if (!same(t.getRangeTextDecoration(s, e), r.textDecoration)) t.setRangeTextDecoration(s, e, r.textDecoration);
      if (!same(t.getRangeParagraphSpacing(s, e), r.paragraphSpacing)) t.setRangeParagraphSpacing(s, e, r.paragraphSpacing);
      if (!same(t.getRangeParagraphIndent(s, e), r.paragraphIndent)) t.setRangeParagraphIndent(s, e, r.paragraphIndent);
      if (!same(t.getRangeFills(s, e), r.fills)) t.setRangeFills(s, e, r.fills);
      if (r.fillStyleId && t.getRangeFillStyleId(s, e) !== r.fillStyleId) { await t.setRangeFillStyleIdAsync(s, e, r.fillStyleId); check(); }
    }
    for (const r of runs) for (const f of TEXT_BINDABLE) {
      const want = r.boundVariables && r.boundVariables[f];
      const have = t.getRangeBoundVariable(r.start, r.end, f);
      const haveId = have && have !== figma.mixed ? have.id : null;
      if (want) {
        const v = vars.get(want.id);
        if (v && haveId !== want.id) t.setRangeBoundVariable(r.start, r.end, f, v);
      } else if (have !== null) t.setRangeBoundVariable(r.start, r.end, f, null);
    }
  };
}

/** A node's paint style link (fill or stroke) as it is now, when it has one: put back after its paints. */
function keepStyleLink(n: SceneNode, field: "fillStyleId" | "strokeStyleId"): ((check: () => void) => Promise<void>) | null {
  const old = field in n ? getF(n, field) : undefined;
  if (typeof old !== "string" || !old) return null;
  return async (check) => {
    if (getF(n, field) === old) return;
    if (field === "fillStyleId" && "setFillStyleIdAsync" in n) await n.setFillStyleIdAsync(old);
    else if (field === "strokeStyleId" && "setStrokeStyleIdAsync" in n) await n.setStrokeStyleIdAsync(old);
    check();
  };
}

/** Everything the patch can change on the node, as it is now, and the restore that puts it back in a fixed order. */
async function snapshot(t: PatchTarget): Promise<Restore> {
  const n = t.node;
  const set = t.set;
  const tok = set.tokens || {};
  const steps: Array<(check: () => void) => void | Promise<void>> = [];
  // 0. a field the patch binds that was unbound: unbind it first, so the raw value below is the one it had
  const before = new Map<NumberTokenField, string | null>(NUMBER_TOKEN_FIELDS.filter((k) => k in n).map((k) => [k, boundId(n, k)]));
  steps.push(() => {
    for (const [k, id] of before) if (id === null && boundId(n, k) !== null) bindField(n, k, null);
  });
  // 1. the instance's property values (a variant switch can change its layout and size, which come after)
  if (t.props && n.type === "INSTANCE") {
    const old: Record<string, string | boolean> = {};
    for (const k of Object.keys(t.props)) { const p = n.componentProperties[k]; if (p) old[k] = p.value; }
    steps.push(() => { if (Object.keys(old).some((k) => { const p = n.componentProperties[k]; return !p || p.value !== old[k]; })) n.setProperties(old); });
  }
  // 2. auto-layout, and 3. the children's places when it is turned on or off (Figma moves them)
  const sizeTouched = set.box !== undefined || set.widthMode !== undefined || set.heightMode !== undefined || set.layout !== undefined || set.props !== undefined ||
    set.autoResize !== undefined || set.text !== undefined || set.styles !== undefined || tok.width !== undefined || tok.height !== undefined;
  if (set.layout) {
    const props = keep(n, LAYOUT_PROPS);
    steps.push(() => { for (const [k, v] of props) putBack(n, k, v); });
    if ("children" in n) {
      const kids = n.children.map((k) => ({ k, at: keep(k, ["layoutPositioning", "layoutGrow", "layoutAlign"]), w: k.width, h: k.height, sizing: keep(k, ["layoutSizingHorizontal", "layoutSizingVertical"]), x: k.x, y: k.y }));
      steps.push(() => {
        const flex = isFlex(t.node);
        for (const c of kids) {
          if (flex) for (const [k, v] of c.at) putBack(c.k, k, v);
          if ((c.k.width !== c.w || c.k.height !== c.h) && "resize" in c.k) c.k.resize(c.w, c.h);
          if (flex) for (const [k, v] of c.sizing) putBack(c.k, k, v);
          putBack(c.k, "x", c.x);
          putBack(c.k, "y", c.y);
        }
      });
    }
  }
  // 4. the size and how it is decided
  if (sizeTouched && "resize" in n) {
    const w = t.node.width, h = t.node.height;
    const sizing = keep(n, ["layoutSizingHorizontal", "layoutSizingVertical"]);
    const auto = keep(n, ["textAutoResize"]);
    steps.push(() => {
      if ((n.width !== w || n.height !== h) && "resize" in n) n.resize(w, h);
      const inFlex = isFlex(t.node.parent);
      for (const [k, v] of sizing) {
        if (v === "FILL" && !inFlex) continue; // valid only in an auto-layout parent: the size above stands
        if (v === "HUG" && t.node.type !== "TEXT" && !isFlex(t.node)) continue;
        if (v === "FIXED" && !inFlex && !isFlex(t.node)) continue;
        putBack(n, k, v);
      }
      for (const [k, v] of auto) putBack(n, k, v);
    });
  }
  // 5. paints (then the paint style they came from), strokes, corners and the plain fields; the raw values of the
  // number fields it binds
  const plain: Array<[string, unknown]> = [];
  const links: Array<(check: () => void) => Promise<void>> = [];
  const textRuns = n.type === "TEXT" && (set.text !== undefined || set.styles !== undefined || ((set.fills !== undefined || tok.fills !== undefined) && n.fills === figma.mixed));
  const notMixed = ([, v]: [string, unknown]): boolean => v !== figma.mixed;
  if ((set.fills !== undefined || tok.fills !== undefined) && !textRuns) {
    plain.push(...keep(n, ["fills"]).filter(notMixed));
    const link = keepStyleLink(n, "fillStyleId");
    if (link) links.push(link);
  }
  if (set.strokes !== undefined || tok.strokes !== undefined || tok.strokeWeight !== undefined || tok.strokeTopWeight !== undefined || tok.strokeRightWeight !== undefined ||
    tok.strokeBottomWeight !== undefined || tok.strokeLeftWeight !== undefined) {
    plain.push(...keep(n, STROKE_PROPS).filter(notMixed));
    const link = keepStyleLink(n, "strokeStyleId");
    if (link) links.push(link);
  }
  // A shape with one radius (a polygon, a star) has `cornerRadius` alone; a frame or rectangle has the four corners too
  // (`cornerRadius` is mixed when they differ).
  if (set.radius !== undefined || CORNER_PROPS.some((k) => tok[k] !== undefined)) plain.push(...keep(n, ["cornerRadius", ...CORNER_PROPS]).filter(notMixed));
  if (set.opacity !== undefined || tok.opacity !== undefined) plain.push(...keep(n, ["opacity"]));
  if (set.hidden !== undefined) plain.push(...keep(n, ["visible"]));
  if (set.name !== undefined) plain.push(...keep(n, ["name"]));
  for (const k of Object.keys(tok) as NumberTokenField[]) if (k !== "width" && k !== "height" && NUMBER_TOKEN_FIELDS.indexOf(k) >= 0 && k in n) plain.push(...keep(n, [k]));
  steps.push(() => { for (const [k, v] of plain) putBack(n, k, v); });
  for (const link of links) steps.push(link);
  // 6. the text, run by run
  if (textRuns && n.type === "TEXT") {
    const text = await keepText(n);
    steps.push((check) => text(() => { check(); return true; }));
  }
  // 7. the variables that were bound, bound again where a raw value above (or the patch) unbound them
  steps.push(() => {
    for (const [k, id] of before) {
      if (id === null || boundId(n, k) === id) continue;
      const v = t.bound.get(id);
      if (v) bindField(n, k, v);
    }
  });
  return async (allowed) => {
    const check = checker(allowed);
    const failed: string[] = [];
    for (const step of steps) {
      check();
      try { await step(check); } catch (e) {
        if (e instanceof RestoreStopped) throw e;
        failed.push(errMsg(e));
      }
    }
    if (failed.length) throw new Error(failed.join("; "));
  };
}

// ---------------------------------------------------------------- applying

const ALIGN_MAIN = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", "space-between": "SPACE_BETWEEN", "space-evenly": "SPACE_EVENLY", "space-around": "SPACE_AROUND" } as const;
const ALIGN_CROSS = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", baseline: "BASELINE" } as const;
const SIZING = { fill: "FILL", hug: "HUG", fixed: "FIXED" } as const;
const AUTO_RESIZE = { width_and_height: "WIDTH_AND_HEIGHT", height: "HEIGHT", truncate: "TRUNCATE", none: "NONE" } as const;
const nameList = (v: string | string[] | null | undefined): string[] => (v === undefined || v === null ? [] : typeof v === "string" ? [v] : v);

function variable(t: PatchTarget, ref: string): Variable {
  const v = t.refs.variables.get(ref);
  if (!v) throw new Error("variable '" + ref + "' was not resolved before the batch ran");
  return v;
}
const bindPaint = (t: PatchTarget, p: SolidPaint, ref: string | undefined): SolidPaint => (ref === undefined ? p : figma.variables.setBoundVariableForPaint(p, "color", variable(t, ref)));
/** `paints` with every colour variable unbound (the colour each shows stays). */
const unbindPaints = (paints: readonly Paint[]): Paint[] => paints.map((p) => (p.type === "SOLID" && p.boundVariables && p.boundVariables.color ? figma.variables.setBoundVariableForPaint(p, "color", null) : p));
const fillPaints = (t: PatchTarget, fills: readonly TreeFill[]): SolidPaint[] => fills.map((f) => bindPaint(t, solid(f.color === undefined ? "#000000" : f.color, f.opacity), f.tokens && f.tokens.color));

/** Set the patch's fields on the node, in PATCH_FIELDS order. */
async function setFields(t: PatchTarget, consent: () => void): Promise<void> {
  const n = t.node;
  const { set } = t;
  const tok = set.tokens || {};
  if (t.props && n.type === "INSTANCE") n.setProperties(t.props);
  if (set.name !== undefined) n.name = set.name;
  if (set.hidden !== undefined) n.visible = !set.hidden;
  if (set.opacity !== undefined) setF(n, "opacity", set.opacity);
  const l = set.layout;
  if (l && "layoutMode" in n) {
    if (l.mode === "absolute") n.layoutMode = "NONE";
    else {
      const dir = directionAfter(n, set);
      const mode = dir === "column" ? "VERTICAL" : "HORIZONTAL";
      if (n.layoutMode !== mode) n.layoutMode = mode;
      if (l.flexWrap !== undefined) setF(n, "layoutWrap", l.flexWrap === "wrap" ? "WRAP" : "NO_WRAP");
      if (l.gap !== undefined) setF(n, "itemSpacing", l.gap);
      if (l.padding) {
        setF(n, "paddingTop", l.padding[0] || 0);
        setF(n, "paddingRight", l.padding[1] || 0);
        setF(n, "paddingBottom", l.padding[2] || 0);
        setF(n, "paddingLeft", l.padding[3] || 0);
      }
      if (l.justifyContent) setF(n, "primaryAxisAlignItems", ALIGN_MAIN[l.justifyContent]);
      if (l.alignItems) setF(n, "counterAxisAlignItems", ALIGN_CROSS[l.alignItems]);
      const track = dir === "column" ? l.columnGap : l.rowGap;
      if (track !== undefined) setF(n, "counterAxisSpacing", track);
      if (l.alignContent) setF(n, "counterAxisAlignContent", l.alignContent === "space-between" ? "SPACE_BETWEEN" : "AUTO");
      if (l.reverseZ !== undefined) setF(n, "itemReverseZIndex", l.reverseZ);
    }
  }
  const box = set.box;
  if (box && "resize" in n) {
    const fixable = isFlex(n.parent) || isFlex(n);
    if (n.type === "TEXT" && set.autoResize === undefined) n.textAutoResize = box.h !== undefined ? "NONE" : "HEIGHT";
    if (fixable && box.w !== undefined) setF(n, "layoutSizingHorizontal", "FIXED");
    if (fixable && box.h !== undefined) setF(n, "layoutSizingVertical", "FIXED");
    n.resize(box.w !== undefined ? box.w : n.width, box.h !== undefined ? box.h : n.height);
  }
  for (const [axis, field] of [["widthMode", "layoutSizingHorizontal"], ["heightMode", "layoutSizingVertical"]] as const) {
    const m = set[axis];
    if (m === undefined) continue;
    // "fixed" outside any auto-layout is what the node already is: nothing to set.
    if (m === "fixed" && !isFlex(n.parent) && !isFlex(n)) continue;
    setF(n, field, SIZING[m]);
  }
  if (typeof set.radius === "number") setF(n, "cornerRadius", set.radius);
  else if (set.radius) {
    const r = set.radius;
    if (r.tl !== undefined) setF(n, "topLeftRadius", r.tl);
    if (r.tr !== undefined) setF(n, "topRightRadius", r.tr);
    if (r.br !== undefined) setF(n, "bottomRightRadius", r.br);
    if (r.bl !== undefined) setF(n, "bottomLeftRadius", r.bl);
  }
  if ("fills" in n) {
    if (set.fills) n.fills = fillPaints(t, set.fills);
    else if (tok.fills === null && n.fills !== figma.mixed) n.fills = unbindPaints(n.fills);
    else if (tok.fills !== undefined && tok.fills !== null) n.fills = nameList(tok.fills).map((ref) => bindPaint(t, solid("#000000"), ref));
  }
  const st = set.strokes;
  if ("strokes" in n) {
    const strokeNames = nameList(tok.strokes);
    if (st && st.colors) n.strokes = st.colors.map((c, i) => bindPaint(t, solid(c), strokeNames[i]));
    else if (tok.strokes === null) n.strokes = unbindPaints(n.strokes);
    else if (strokeNames.length) n.strokes = strokeNames.map((ref) => bindPaint(t, solid("#000000"), ref));
    if (st) {
      if (st.weight !== undefined) setF(n, "strokeWeight", st.weight);
      const w = st.weights;
      if (w) {
        if (w.top !== undefined) setF(n, "strokeTopWeight", w.top);
        if (w.right !== undefined) setF(n, "strokeRightWeight", w.right);
        if (w.bottom !== undefined) setF(n, "strokeBottomWeight", w.bottom);
        if (w.left !== undefined) setF(n, "strokeLeftWeight", w.left);
      }
      if (st.align) n.strokeAlign = st.align === "inside" ? "INSIDE" : st.align === "outside" ? "OUTSIDE" : "CENTER";
    }
  }
  if (n.type === "TEXT") {
    const styleRef = set.styles && set.styles.text;
    if (styleRef !== undefined) {
      const style = t.refs.textStyles.get(styleRef);
      if (!style) throw new Error("text style '" + styleRef + "' was not resolved before the batch ran");
      await n.setTextStyleIdAsync(style.id);
      consent();
    }
    if (set.text !== undefined) n.characters = set.text;
    if (set.autoResize !== undefined) n.textAutoResize = AUTO_RESIZE[set.autoResize];
  }
  // Last: a raw value set above would unbind a variable bound here.
  for (const k of NUMBER_TOKEN_FIELDS) {
    const ref = tok[k];
    if (ref === undefined) continue;
    bindField(n, k, ref === null ? null : variable(t, ref));
  }
}

/**
 * Apply a resolved patch, keeping what it replaces. Its Change is on `changes` before the first field is set, so a
 * patch stopped partway ("Allow edits" turned off during the text-style await) is still reported as applied. A patch
 * that throws puts back what it already set before the error goes on (unless `allowed` says "Allow edits" is off by
 * then: the plugin then changes nothing more). `consent` is checked after every await.
 */
export async function applyPatch(t: PatchTarget, consent: () => void, allowed: () => boolean, changes: Change[]): Promise<Change> {
  const restore = await snapshot(t);
  consent();
  const applied: AppliedWrite = { id: t.node.id };
  if (t.unbound) applied.unbound = t.unbound;
  const change: Change = { applied, kind: "patched node", what: "the changes to '" + t.node.name + "' (" + t.node.id + ")", restore };
  changes.push(change);
  try {
    await setFields(t, consent);
  } catch (e) {
    if (allowed()) {
      // Put back here so the op leaves nothing; if that fails or is stopped, the Change stays for the batch to report.
      try { await restore(allowed); changes.splice(changes.indexOf(change), 1); } catch { /* the batch's restore tries again and reports it */ }
    }
    throw e;
  }
  return change;
}
