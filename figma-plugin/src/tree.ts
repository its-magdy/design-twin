// Tree specs (writes: createTree): one nested spec creates a whole screen (docs/write-plane-spec.md 1, 4, 13, 14, 20).
//
// The spec has been checked whole before this module sees it (bridge/src/tree-spec.ts checkTree, run by the wire
// check and again by applyWrites). What is left can only be answered by the file, and is answered BEFORE the first op
// of the batch runs (resolveTreeOps): the page the frame lands on resolves to exactly one page, every font the
// texts use loads, and every component, variable and text style the spec names resolves to one thing that fits
// (tree-refs.ts). A spec that fails any of it is refused with the rest of the batch, every problem listed. A library
// item the spec names by key is imported only after all of that passed (writes.ts runs `imports`).
//
// Building (buildTree) makes every node without an await, so the designer cannot untick "Allow edits" halfway
// through the nodes. The root is built hidden on the page Figma creates nodes on; then the texts that name a text
// style get it (setTextStyleIdAsync, the one await, with consent checked after each); and only once every node is in
// place is the root moved to its page, placed, and shown. Any throw on the way removes the root — and with it
// everything below — so a tree either lands whole or leaves no trace. Applied, it is a Change (write-batch.ts) whose
// undo removes it, so a later op of the same batch failing takes it back too.
//
// Plugin API facts this leans on (@figma/plugin-typings):
//   * figma.createFrame/createText append the new node to figma.currentPage; appendChild moves a node (reparents it).
//   * A new frame has a white fill and clipsContent true; the read export omits "no fills" and "no clip", so a spec
//     without them gets neither (the read's inverse).
//   * layoutSizingHorizontal/Vertical "FILL" is valid only on a child of an auto-layout frame (so it is set after the
//     append), "HUG" only on an auto-layout frame or a text node.
//   * Setting `characters` or any text property needs the node's font loaded (figma.loadFontAsync) first.
//   * Under documentAccess "dynamic-page" a page other than the current one must be loaded (loadAsync) before its
//     children are read or it is appended to, and a text style is set with setTextStyleIdAsync (textStyleId is
//     read-only there).
//   * A paint is bound with figma.variables.setBoundVariableForPaint (it returns a bound copy); a number field with
//     node.setBoundVariable(field, variable). Setting the raw value afterwards unbinds it, so binding comes last.
import type { AppliedWrite, WriteOp } from "../../bridge/src/commands.ts";
import { parseHexColor } from "../../bridge/src/hex-color.ts";
import { matchByName, nearestNames, quoteList } from "../../bridge/src/name-match.ts";
import { checkTree, fontOf, isTreeSpec, nodeKind, NUMBER_TOKEN_FIELDS, type TreeFill, type TreeNodeSpec, type TreeSummary } from "../../bridge/src/tree-spec.ts";
import { resolveRefs, type ResolvedRefs } from "./tree-refs";
import type { Change, OpProblem } from "./write-batch";

/** A createTree op whose page resolved, whose fonts loaded and whose design-system names resolved. */
export interface TreeTarget {
  spec: TreeNodeSpec;
  page: PageNode;
  summary: TreeSummary;
  refs: ResolvedRefs;
}

/** How far right of the rightmost existing frame a placed tree lands (Figma's usual gap between screens). */
export const PLACE_GAP = 100;

/**
 * Resolve every createTree op of a batch against the file: its page, its fonts. Every op is looked at, so the
 * refusal lists every bad page name and every missing font at once. The available-font list is read only when a font
 * fails to load (for its candidates).
 */
export async function resolveTreeOps(ops: readonly WriteOp[]): Promise<{ targets: Map<number, TreeTarget>; problems: OpProblem[]; imports: () => Promise<OpProblem[]>; importCount: number }> {
  const targets = new Map<number, TreeTarget>();
  const specs = new Map<number, TreeNodeSpec>();
  const problems: OpProblem[] = [];
  const loaded = new Map<string, Promise<string | null>>();
  let available: Promise<string[]> | null = null;
  const availableNames = (): Promise<string[]> => {
    if (!available) available = figma.listAvailableFontsAsync().then((fs) => fs.map((f) => f.fontName.family + " " + f.fontName.style), () => []);
    return available;
  };
  // One load per distinct font across the batch; null = loaded, else the reason it did not.
  const load = (family: string, weight: string): Promise<string | null> => {
    const key = family + "|" + weight;
    let p = loaded.get(key);
    if (!p) {
      p = figma.loadFontAsync({ family, style: weight }).then(() => null, async () => {
        const near = nearestNames(family + " " + weight, await availableNames());
        return "font '" + family + " " + weight + "' is not available in this file" + (near.length ? "; closest: " + quoteList(near) : "");
      });
      loaded.set(key, p);
    }
    return p;
  };

  for (const [index, op] of ops.entries()) {
    if (op.op !== "createTree") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    // Checked by writeOpError already; this is the narrowing, and a last line.
    const spec = op.tree;
    if (!isTreeSpec(spec)) { bad("the tree spec did not pass its check"); continue; }
    const summary = checkTree(spec).summary;
    const page = resolvePage(op.page);
    if ("error" in page) bad(page.error);
    const fontErrors = (await Promise.all(summary.fonts.map((f) => load(f.family, f.weight)))).filter((e): e is string => e !== null);
    for (const e of fontErrors) bad(e);
    const axisErrors = fontErrors.length ? [] : variationProblems(spec);
    for (const e of axisErrors) bad(e);
    specs.set(index, spec);
    if ("error" in page || fontErrors.length || axisErrors.length) continue;
    await page.ok.loadAsync(); // dynamic-page: before its children are read or it is appended to
    targets.set(index, { spec, page: page.ok, summary, refs: { instances: new Map(), variables: new Map(), textStyles: new Map() } });
  }
  // Every op's references, resolved together (one lookup per name across the batch), into one shared map.
  const r = await resolveRefs(specs, (f) => load(f.family, f.style));
  problems.push(...r.problems);
  for (const t of targets.values()) t.refs = r.refs;
  return { targets, problems, imports: r.imports, importCount: r.importCount };
}

/** Every text node of a spec, with its path (as checkTree names it). */
function textsOf(s: TreeNodeSpec, path: string, out: Array<{ s: TreeNodeSpec; path: string }>): Array<{ s: TreeNodeSpec; path: string }> {
  if (nodeKind(s) === "TEXT") out.push({ s, path });
  (s.children || []).forEach((c, i) => textsOf(c, path + ".children[" + i + "]", out));
  return out;
}

/** A `font.variationSettings` axis the family does not define makes Figma throw when the font is set: refused here,
 *  before the build, with the axes it has (getFontFamilyVariationAxes: null for a static family). */
function variationProblems(spec: TreeNodeSpec): string[] {
  const out: string[] = [];
  for (const { s, path } of textsOf(spec, "tree", [])) {
    const vs = s.font && s.font.variationSettings;
    if (!vs || !Object.keys(vs).length) continue;
    const { family } = fontOf(s.font);
    let axes: string[] | null;
    try { axes = figma.getFontFamilyVariationAxes(family); } catch { axes = null; }
    const unknown = Object.keys(vs).filter((k) => !axes || axes.indexOf(k) < 0);
    if (!unknown.length) continue;
    out.push(path + ".font.variationSettings: " + (axes ? "'" + family + "' has no axis " + quoteList(unknown) + "; its axes are " + quoteList(axes) : "'" + family + "' is not a variable font, so it has no axes to set"));
  }
  return out;
}

function resolvePage(ref: string | undefined): { ok: PageNode } | { error: string } {
  if (ref === undefined) return { ok: figma.currentPage };
  const m = matchByName(ref, figma.root.children, (p) => p.name, (p) => [p.id]);
  if (m.kind === "one") return { ok: m.item };
  if (m.kind === "many") return { error: "page '" + ref + "' matches " + m.matches.length + " pages — pass one's id: " + m.matches.slice(0, 3).map((p) => "'" + p.name + "' (" + p.id + ")").join(", ") };
  return { error: "page '" + ref + "' matches no page in this file" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "") };
}

/**
 * Build a resolved tree and attach it to its page. Throws (leaving nothing behind) when Figma refuses a value, or when
 * `consent` throws: it is called after each await, so "Allow edits" turned off while the text styles are set stops
 * the build and removes the hidden, unplaced root (it never showed in the file).
 */
export async function buildTree(t: TreeTarget, consent: () => void): Promise<Change> {
  // Handles are the agent's own strings: a Map, so one called "__proto__" is a key like any other.
  const made: Made = { frames: 0, texts: 0, instances: 0, handles: new Map<string, string>(), refs: t.refs, styled: [] };
  const root = figma.createFrame();
  root.visible = false; // built to the side: nothing shows until the whole tree is in place
  try {
    applyFrame(root, t.spec, null, made);
    for (const [text, style] of made.styled) {
      await text.setTextStyleIdAsync(style.id);
      consent();
    }
    const { x, y } = placement(t.page, root, t.spec);
    t.page.appendChild(root);
    root.x = x;
    root.y = y;
    root.visible = t.spec.hidden !== true;
  } catch (e) {
    try { root.remove(); } catch { /* already gone */ }
    throw e;
  }
  const applied: AppliedWrite = { id: root.id, created: made.instances ? { frames: made.frames, texts: made.texts, instances: made.instances } : { frames: made.frames, texts: made.texts } };
  if (made.handles.size) applied.handles = handleRecord(made.handles);
  if (t.summary.unbound) applied.unbound = t.summary.unbound;
  return {
    applied,
    kind: "created tree",
    what: "the tree '" + root.name + "' (" + root.id + ")",
    restore() { root.remove(); },
  };
}

/** The handles as a reply record, own properties all ("__proto__" included: defineProperty, not assignment). */
function handleRecord(m: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of m) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/** What a top-level node occupies on the page: its bounding box (rotation included), else its own x/y/size. */
function occupied(c: SceneNode): { x: number; y: number; width: number; height: number } {
  const b = "absoluteBoundingBox" in c ? c.absoluteBoundingBox : null;
  return b ? b : { x: c.x, y: c.y, width: c.width, height: c.height };
}

/** Where the root lands: its own x/y, else right of everything already on the page, top-aligned with it. */
function placement(page: PageNode, root: FrameNode, spec: TreeNodeSpec): { x: number; y: number } {
  if (spec.x !== undefined && spec.y !== undefined) return { x: spec.x, y: spec.y };
  let right: number | null = null;
  let top: number | null = null;
  for (const c of page.children) {
    if (c.id === root.id) continue; // built on the current page, which may be this one
    const b = occupied(c);
    right = right === null ? b.x + b.width : Math.max(right, b.x + b.width);
    top = top === null ? b.y : Math.min(top, b.y);
  }
  return {
    x: spec.x !== undefined ? spec.x : right === null ? 0 : Math.round(right + PLACE_GAP),
    y: spec.y !== undefined ? spec.y : top === null ? 0 : Math.round(top),
  };
}

interface Made {
  frames: number;
  texts: number;
  instances: number;
  handles: Map<string, string>;
  refs: ResolvedRefs;
  /** the texts that name a text style, set once every node is made (it awaits) */
  styled: Array<[TextNode, TextStyle]>;
}
type Parent = FrameNode;
type Built = FrameNode | TextNode | InstanceNode;

const ALIGN_MAIN = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", "space-between": "SPACE_BETWEEN", "space-evenly": "SPACE_EVENLY", "space-around": "SPACE_AROUND" } as const;
const ALIGN_CROSS = { "flex-start": "MIN", center: "CENTER", "flex-end": "MAX", baseline: "BASELINE" } as const;
const SIZING = { fill: "FILL", hug: "HUG" } as const;

/** The node's paints: `fills` (each bound to its `tokens.color`), else one bound paint per name in `names` (the
 *  node's `tokens.fills` / `tokens.strokes` without the raw list). */
function paints(fills: readonly TreeFill[] | undefined, names: string | string[] | undefined, made: Made): SolidPaint[] {
  if (fills) return fills.map((f) => bindPaint(solid(f.color === undefined ? "#000000" : f.color, f.opacity), f.tokens && f.tokens.color, made));
  return nameList(names).map((n) => bindPaint(solid("#000000"), n, made));
}
const nameList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : typeof v === "string" ? [v] : v);
/** `p` bound to the variable `ref` resolved to (tree-refs.ts), or `p` itself without one. */
function bindPaint(p: SolidPaint, ref: string | undefined, made: Made): SolidPaint {
  if (ref === undefined) return p;
  return figma.variables.setBoundVariableForPaint(p, "color", variable(ref, made));
}
function variable(ref: string, made: Made): Variable {
  const v = made.refs.variables.get(ref);
  if (!v) throw new Error("variable '" + ref + "' was not resolved before the batch ran");
  return v;
}
/** Bind the spec's number tokens: last, as a raw value set afterwards would unbind it. */
function bindNumbers(n: Built, s: TreeNodeSpec, made: Made): void {
  const t = s.tokens;
  if (!t) return;
  for (const k of NUMBER_TOKEN_FIELDS) {
    const ref = t[k];
    if (ref !== undefined) n.setBoundVariable(k, variable(ref, made));
  }
}
function solid(color: string, opacity?: number): SolidPaint {
  const c = parseHexColor(color);
  if (!c) throw new Error("'" + color + "' is not a hex colour"); // checkTree refused it already
  const alpha = (c.a === undefined ? 1 : c.a) * (opacity === undefined ? 1 : opacity);
  return alpha < 1 ? { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: alpha } : { type: "SOLID", color: { r: c.r, g: c.g, b: c.b } };
}

/** The props every node kind shares, then its place in the parent. Runs after the node is appended to `parent`. */
function common(n: Built, s: TreeNodeSpec, parent: Parent | null, made: Made): void {
  if (s.name !== undefined) n.name = s.name;
  if (s.hidden && parent) n.visible = false; // the root stays hidden until it is placed (buildTree)
  if (s.opacity !== undefined) n.opacity = s.opacity;
  const strokeNames = nameList(s.tokens && s.tokens.strokes);
  if (s.strokes || strokeNames.length) {
    // Each colour bound to the variable at its place (checkTree made the counts match), or one bound paint per name.
    if (s.strokes && s.strokes.colors) n.strokes = s.strokes.colors.map((c, i) => bindPaint(solid(c), strokeNames[i], made));
    else if (strokeNames.length) n.strokes = paints(undefined, strokeNames, made);
  }
  if (s.strokes) {
    if (s.strokes.weight !== undefined) n.strokeWeight = s.strokes.weight;
    const w = s.strokes.weights;
    if (w && n.type === "FRAME") {
      if (w.top !== undefined) n.strokeTopWeight = w.top;
      if (w.right !== undefined) n.strokeRightWeight = w.right;
      if (w.bottom !== undefined) n.strokeBottomWeight = w.bottom;
      if (w.left !== undefined) n.strokeLeftWeight = w.left;
    }
    if (s.strokes.align) n.strokeAlign = s.strokes.align === "inside" ? "INSIDE" : s.strokes.align === "outside" ? "OUTSIDE" : "CENTER";
  }
  if (s.handle) made.handles.set(s.handle, n.id);
  if (!parent) return;
  const inFlex = parent.layoutMode !== "NONE";
  if (inFlex) {
    if (s.absolute) n.layoutPositioning = "ABSOLUTE";
    if (s.grow !== undefined) n.layoutGrow = s.grow;
    if (s.alignSelf) n.layoutAlign = s.alignSelf === "min" ? "MIN" : s.alignSelf === "center" ? "CENTER" : s.alignSelf === "max" ? "MAX" : "STRETCH";
  }
  if (!inFlex || s.absolute) {
    if (s.x !== undefined) n.x = s.x;
    if (s.y !== undefined) n.y = s.y;
  }
}

function sizing(n: Built, s: TreeNodeSpec): void {
  if (s.widthMode) n.layoutSizingHorizontal = SIZING[s.widthMode];
  if (s.heightMode) n.layoutSizingVertical = SIZING[s.heightMode];
}

function applyFrame(f: FrameNode, s: TreeNodeSpec, parent: Parent | null, made: Made): void {
  made.frames++;
  if (parent) parent.appendChild(f);
  f.fills = paints(s.fills, s.tokens && s.tokens.fills, made);
  f.clipsContent = s.clip === true;
  if (typeof s.radius === "number") f.cornerRadius = s.radius;
  else if (s.radius) {
    if (s.radius.tl !== undefined) f.topLeftRadius = s.radius.tl;
    if (s.radius.tr !== undefined) f.topRightRadius = s.radius.tr;
    if (s.radius.br !== undefined) f.bottomRightRadius = s.radius.br;
    if (s.radius.bl !== undefined) f.bottomLeftRadius = s.radius.bl;
  }
  const l = s.layout;
  if (l && l.display === "flex") {
    f.layoutMode = l.flexDirection === "column" ? "VERTICAL" : "HORIZONTAL";
    if (l.gap !== undefined) f.itemSpacing = l.gap;
    const p = l.padding;
    if (p) {
      f.paddingTop = p[0] || 0;
      f.paddingRight = p[1] || 0;
      f.paddingBottom = p[2] || 0;
      f.paddingLeft = p[3] || 0;
    }
    if (l.justifyContent) f.primaryAxisAlignItems = ALIGN_MAIN[l.justifyContent];
    if (l.alignItems) f.counterAxisAlignItems = ALIGN_CROSS[l.alignItems];
    if (l.flexWrap) f.layoutWrap = "WRAP";
    const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
    if (l.flexWrap && track !== undefined) f.counterAxisSpacing = track;
    if (l.alignContent) f.counterAxisAlignContent = "SPACE_BETWEEN";
    if (l.reverseZ) f.itemReverseZIndex = true;
    if (s.strokesInLayout) f.strokesIncludedInLayout = true; // applicable only with auto-layout (checkTree warns otherwise)
  }
  const w = s.box ? s.box.w : l && l.width;
  const h = s.box ? s.box.h : l && l.height;
  if (w !== undefined && h !== undefined) f.resize(w, h);
  else if (w !== undefined || h !== undefined) f.resize(w !== undefined ? w : f.width, h !== undefined ? h : f.height);
  // A frame's sizing is said explicitly: FIXED is the read's default, and a new auto-layout frame's own may differ.
  if (l && l.display === "flex" || parent && parent.layoutMode !== "NONE") {
    f.layoutSizingHorizontal = "FIXED";
    f.layoutSizingVertical = "FIXED";
  }
  common(f, s, parent, made);
  if (s.sizeLimits) {
    const m = s.sizeLimits;
    if (m.minWidth !== undefined) f.minWidth = m.minWidth;
    if (m.maxWidth !== undefined) f.maxWidth = m.maxWidth;
    if (m.minHeight !== undefined) f.minHeight = m.minHeight;
    if (m.maxHeight !== undefined) f.maxHeight = m.maxHeight;
  }
  for (const c of s.children || []) {
    const kind = nodeKind(c);
    if (kind === "TEXT") applyText(figma.createText(), c, f, made);
    else if (kind === "INSTANCE") applyInstance(c, f, made);
    else applyFrame(figma.createFrame(), c, f, made);
  }
  // After the children: a hugging frame sizes to them, and a fill needs the parent's layout in place (it is).
  sizing(f, s);
  bindNumbers(f, s, made);
}

/** An instance of the component the spec named (resolved by tree-refs.ts), with its property values. */
function applyInstance(s: TreeNodeSpec, parent: Parent, made: Made): void {
  const r = made.refs.instances.get(s);
  if (!r) throw new Error("component '" + String(s.component) + "' was not resolved before the batch ran");
  made.instances++;
  const inst = r.main.createInstance();
  parent.appendChild(inst);
  if (Object.keys(r.props).length) inst.setProperties(r.props);
  if (s.box) inst.resize(s.box.w, s.box.h);
  common(inst, s, parent, made);
  sizing(inst, s);
  bindNumbers(inst, s, made);
}

function applyText(t: TextNode, s: TreeNodeSpec, parent: Parent, made: Made): void {
  made.texts++;
  parent.appendChild(t);
  const font = s.font || {};
  const styleRef = s.styles && s.styles.text;
  const style = styleRef !== undefined ? made.refs.textStyles.get(styleRef) : undefined;
  if (styleRef !== undefined && !style) throw new Error("text style '" + styleRef + "' was not resolved before the batch ran");
  if (style) {
    // The style's own font (loaded by resolveTreeOps); the style itself is set once every node is made (buildTree).
    t.fontName = style.fontName;
    made.styled.push([t, style]);
  } else {
    const { family, weight } = fontOf(font);
    // Loaded by resolveTreeOps, which also checked every axis against the family. An axis left out keeps the style's.
    const vs = font.variationSettings;
    t.fontName = vs && Object.keys(vs).length ? { family, style: weight, variationSettings: vs } : { family, style: weight };
    if (font.size !== undefined) t.fontSize = font.size;
  }
  t.characters = s.text || "";
  const fillNames = s.tokens && s.tokens.fills;
  if (s.fills || fillNames !== undefined) t.fills = paints(s.fills, fillNames, made);
  else if (font.color) t.fills = [solid(font.color)];
  if (font.align) t.textAlignHorizontal = font.align === "justified" ? "JUSTIFIED" : font.align === "center" ? "CENTER" : font.align === "right" ? "RIGHT" : "LEFT";
  if (font.valign) t.textAlignVertical = font.valign === "center" ? "CENTER" : "BOTTOM";
  // A text style sets these (checkTree warned that they are not set on a styled text).
  if (!style) {
    if (font.lineHeight) t.lineHeight = font.lineHeight.unit === "auto" || font.lineHeight.value === undefined ? { unit: "AUTO" } : { unit: font.lineHeight.unit === "px" ? "PIXELS" : "PERCENT", value: font.lineHeight.value };
    if (font.letterSpacing) t.letterSpacing = { unit: font.letterSpacing.unit === "px" ? "PIXELS" : "PERCENT", value: font.letterSpacing.value };
    if (font.case) t.textCase = font.case === "small_caps" ? "SMALL_CAPS" : font.case === "small_caps_forced" ? "SMALL_CAPS_FORCED" : font.case === "upper" ? "UPPER" : font.case === "lower" ? "LOWER" : "TITLE";
    if (font.decoration) t.textDecoration = font.decoration === "underline" ? "UNDERLINE" : "STRIKETHROUGH";
  }
  // Box first (resize fixes the size), then how the box follows the text: the read writes `autoResize` only when it
  // is not NONE, so a box without it is a fixed box, and neither keeps Figma's default (grow with the text).
  if (s.box) t.resize(s.box.w, s.box.h);
  if (s.autoResize) t.textAutoResize = s.autoResize === "height" ? "HEIGHT" : s.autoResize === "truncate" ? "TRUNCATE" : "WIDTH_AND_HEIGHT";
  else if (s.box) t.textAutoResize = "NONE";
  if (s.truncate) t.textTruncation = "ENDING";
  if (s.maxLines !== undefined && s.truncate) t.maxLines = s.maxLines; // only with truncation (checkTree warns otherwise)
  common(t, s, parent, made);
  sizing(t, s);
  bindNumbers(t, s, made);
}
