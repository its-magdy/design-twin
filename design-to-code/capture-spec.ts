// capture-spec.ts — a captured page (what capture-page.ts read from the browser) as a tree spec (bridge/src/tree-spec.ts)
// for `figma_write {op:"createTree", treeFile}`. Pure: no browser, no file system; test/capture-page.test.ts runs it on
// hand-made captures.
//
// Faithful but plain: raw values, no components or variables. The mapping:
//   - the root is a FRAME `<name> @<width>` keyed `capture:<name>@<width>` (a re-send updates it in place), the document's
//     size (or the --root element's box), filled with the page's background;
//   - flex → auto-layout (direction, gap, padding, justify, align, wrap); a *-reverse direction reverses the children
//     (on one line: a reversed flex that wraps onto several keeps its children where they are, as CSS reverses each line
//     and Figma cannot); stretch → a child's `alignSelf: "stretch"`; flex-grow → `grow: 1`;
//   - grid → auto-layout: one column → a column, one row → a row, several columns → a wrapping row of fixed-width cells;
//     a grid whose items span tracks, are placed by line, or do not sit in reading order keeps its children where they
//     are (no auto-layout), noted;
//   - every auto-layout is checked against the page: the children must sit where it puts them (main axis: start,
//     padding, the sizes before, gap, justify, Figma's line breaks; cross axis: alignItems / alignSelf in the line), to
//     the px. One that does not (a margin, margin: auto, a relative offset, a grid row taller than its items, …) is not
//     written: that frame keeps its children at their x/y, counted as approximated (`flex`, `grid`);
//   - block flow → a frame without auto-layout, each child at its x/y; an absolute or fixed child of an auto-layout
//     frame → `absolute: true` at its x/y;
//   - an element whose content is text and inline elements → one TEXT (inline styles flattened to the element's own,
//     counted); text beside block children → a TEXT per run; single line hugs, wrapped text has a fixed width;
//   - borders → strokes inside (per-side weights when the sides differ), a ring → the stroke the probe read; radius;
//     opacity; overflow hidden → clip; images → image paints by file;
//   - an element with no paint, stroke, clip or padding and exactly one child of the same box is that child; an empty
//     unpainted leaf is left out (in an auto-layout parent it is kept: it takes space).
// Shadows, gradients, pseudo-element content, transforms and filters cannot be written (the tree spec has no effects):
// they are counted under `dropped`.
import type { TreeFill, TreeFont, TreeLayout, TreeNodeSpec, TreeStrokes } from "../bridge/src/tree-spec.ts";
import { MAX_TREE_DEPTH, MAX_TREE_NODES } from "../bridge/src/tree-spec.ts";
import { checkTree } from "../bridge/src/tree-check.ts";
import { mapImagePaints } from "../bridge/src/image-spec.ts";
import { formatHex } from "../bridge/src/hex-color.ts";
import { parseCssColor } from "./color.ts";
import type { WalkMedia } from "./probe-capture.ts";

// ---------------------------------------------------------------- what capture-page.ts hands over
/** Page coordinates, px. */
export interface CapRect { x: number; y: number; w: number; h: number }
/** A text's font as rendered: the family Chromium drew it with, the computed size, weight, style and colour. */
export interface CapFont {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  /** px; null for `normal` (Figma's auto) */
  lineHeight: number | null;
  letterSpacing: number;
  /** a CSS colour, rgb()/rgba() */
  color: string;
  textAlign: string;
  direction: string;
  textTransform: string;
  textDecoration: string;
}
export interface CapText {
  kind: "text";
  text: string;
  /** the text's own box (a Range over it), or a control's content box */
  rect: CapRect;
  lines: number;
  font: CapFont;
  /** inline children styled otherwise were flattened to this font */
  mixed?: boolean;
  /** a form control's value or placeholder: drawn centred in its content box, cut off at its end */
  control?: boolean;
}
/** An image saved under <out>/images: its path relative to the project, its id and size, and how it fills its node. */
export interface CapImage {
  file: string;
  sha256: string;
  w: number;
  h: number;
  /** "source": the bytes the page loaded; "screenshot": a PNG of the element (a format Figma does not take, an inline
   *  SVG, a canvas) — it shows the element's own background and border too */
  from: "source" | "screenshot";
  scaleMode: "fill" | "fit" | "tile";
  /** a tile's scale */
  scale?: number;
  /** how the CSS fit was approximated, when it was */
  note?: string;
}
export interface CapBorder {
  /** [top, right, bottom, left], px */
  widths: [number, number, number, number];
  color: string;
  from: "border" | "box-shadow" | "outline";
  align: "inside" | "outside" | "center";
}
export interface CapEl {
  kind: "el";
  path: string;
  tag: string;
  name: string;
  rect: CapRect;
  display: string;
  position: string;
  zIndex: number;
  flexDirection: string;
  flexWrap: string;
  justifyContent: string;
  alignItems: string;
  alignSelf: string;
  flexGrow: number;
  order: number;
  gridColumns: number[];
  gridRows: number[];
  gridPlaced: boolean;
  rowGap: number | null;
  columnGap: number | null;
  /** [top, right, bottom, left], px */
  padding: [number, number, number, number];
  /** a CSS colour; null when transparent */
  background: string | null;
  border: CapBorder | null;
  radius: number | [number, number, number, number] | null;
  opacity: number;
  clip: boolean;
  media: WalkMedia | null;
  /** what the element draws itself (an <img>, or a screenshot of an <svg>, a <canvas>, …) */
  image: CapImage | null;
  /** its CSS background image (or a screenshot of the element, children hidden, when the format is not one Figma takes) */
  backgroundImage: CapImage | null;
  /** its text, when its content is text and inline elements only */
  text: CapText | null;
  /** what cannot be written on it (`shadow`, `gradient`, `pseudo-element`, `transform`, `filter`, `inline-paint`, `image`) */
  dropped: string[];
  children: Array<CapEl | CapText>;
}
/** One width of a capture. */
export interface CaptureDoc {
  /** the slug the files are named by */
  name: string;
  width: number;
  url: string;
  /** the whole document (true) or the --root element */
  document: boolean;
  /** the page's background (body, else html): the root's fill when the root paints none */
  background: string | null;
  root: CapEl;
}

// ---------------------------------------------------------------- what the conversion says
export interface Tally { count: number; samples: string[] }
export interface CaptureStats {
  nodes: number;
  frames: number;
  texts: number;
  images: number;
  depth: number;
  /** every font the texts use, family + Figma style, first-use order */
  fonts: Array<{ family: string; style: string }>;
  /** what could not be written, by kind */
  dropped: Record<string, Tally>;
  /** what was written as the nearest thing the tree spec has, by kind */
  approximated: Record<string, Tally>;
}
export type CaptureResult = { ok: true; spec: TreeNodeSpec; stats: CaptureStats } | { ok: false; error: string; stats: CaptureStats };

/** How many sample paths a tally keeps. */
const SAMPLES = 3;
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** Floored to 0.01: a wrapping row's cells and gaps must add up to no more than the row's width. */
const f2 = (n: number): number => Math.floor(n * 100 + 1e-6) / 100;
const near = (a: number, b: number, tol = 1): boolean => Math.abs(a - b) <= tol;
const sameBox = (a: CapRect, b: CapRect): boolean => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const isEl = (n: CapEl | CapText): n is CapEl => n.kind === "el";

/** A CSS colour as a hex the tree spec takes (#rrggbb, #rrggbbaa); null when it is transparent or unreadable. */
export function hexOf(css: string | null): string | null {
  if (css === null) return null;
  const c = parseCssColor(css);
  if (!c || c.a <= 0) return null;
  return formatHex(c);
}

/** Figma's style names by weight (decided: the common naming; a file whose font names a style otherwise refuses it, with the
 *  closest names, and nothing is swapped). */
const WEIGHT_NAMES: Readonly<Record<number, string>> = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
/** A CSS weight and style as a Figma font style: the weight's name, "Italic" after it (400 italic is "Italic"). */
export function fontStyleName(weight: number, italic: boolean): string {
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const name = WEIGHT_NAMES[w] || "Regular";
  if (!italic) return name;
  return w === 400 ? "Italic" : name + " Italic";
}
const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|-apple-system|blinkmacsystemfont)$/i;
/** The first family of a CSS font-family list that is not a generic one (unquoted), else the first. */
export function firstFamily(stack: string): string {
  const fams = stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter((f) => f !== "");
  return fams.find((f) => !GENERIC.test(f)) || fams[0] || "";
}

/** The spec of one width of a capture, and what it holds. Refused (ok false) past MAX_TREE_NODES or MAX_TREE_DEPTH. */
export function captureSpec(doc: CaptureDoc): CaptureResult {
  const stats: CaptureStats = { nodes: 0, frames: 0, texts: 0, images: 0, depth: 0, fonts: [], dropped: Object.create(null) as Record<string, Tally>, approximated: Object.create(null) as Record<string, Tally> };
  const tally = (into: Record<string, Tally>, kind: string, at: string): void => {
    const t = into[kind] || (into[kind] = { count: 0, samples: [] });
    t.count++;
    if (t.samples.length < SAMPLES && t.samples.indexOf(at) < 0) t.samples.push(at);
  };
  const drop = (kind: string, at: string): void => tally(stats.dropped, kind, at);
  const approx = (kind: string, at: string): void => tally(stats.approximated, kind, at);
  const fontSeen = new Set<string>();

  /** The parent a node is placed in: its element, and the auto-layout it got (null: none). */
  interface Parent { el: CapEl; flex: { dir: "row" | "column"; align: string; grow?: boolean } | null }
  /** A note made while a frame's layout is decided: tallied only when that layout is the one written. */
  type Note = [kind: string, at: string];

  const contentBox = (el: CapEl): CapRect => {
    const [pt, pr, pb, pl] = el.padding;
    const b = el.border && el.border.from === "border" ? el.border.widths : [0, 0, 0, 0];
    const bt = b[0] || 0, br = b[1] || 0, bb = b[2] || 0, bl = b[3] || 0;
    return { x: el.rect.x + bl + pl, y: el.rect.y + bt + pt, w: Math.max(0, el.rect.w - bl - br - pl - pr), h: Math.max(0, el.rect.h - bt - bb - pt - pb) };
  };
  /** It paints, strokes, clips or fills: a frame it must stay. */
  const hasLook = (el: CapEl): boolean => el.background !== null || el.border !== null || el.image !== null || el.backgroundImage !== null || el.clip || el.opacity < 1;
  const padded = (el: CapEl): boolean => el.padding.some((p) => p > 0);

  const fontOf = (f: CapFont, at: string): TreeFont => {
    const style = fontStyleName(f.weight, f.italic);
    if (Math.round(f.weight) % 100 !== 0) approx("font-weight", at);
    const key = f.family + "|" + style;
    if (!fontSeen.has(key)) { fontSeen.add(key); stats.fonts.push({ family: f.family, style }); }
    const out: TreeFont = { family: f.family, weight: style, size: r2(Math.max(1, f.size)) };
    const color = hexOf(f.color);
    if (color) out.color = color;
    if (f.lineHeight !== null && f.lineHeight > 0) out.lineHeight = { unit: "px", value: r2(f.lineHeight) };
    if (f.letterSpacing) out.letterSpacing = { unit: "px", value: r2(f.letterSpacing) };
    const rtl = f.direction === "rtl";
    const a = f.textAlign;
    const align = a === "center" || a === "-webkit-center" ? "center" : a === "right" || a === "-webkit-right" || (a === "end" && !rtl) || (a === "start" && rtl) ? "right" : a === "justify" ? "justified" : null;
    if (align) out.align = align;
    if (f.textTransform === "uppercase") out.case = "upper";
    else if (f.textTransform === "lowercase") out.case = "lower";
    else if (f.textTransform === "capitalize") out.case = "title";
    if (/underline/.test(f.textDecoration)) out.decoration = "underline";
    else if (/line-through/.test(f.textDecoration)) out.decoration = "strikethrough";
    return out;
  };
  const aligned = (f: CapFont): boolean => {
    const a = f.textAlign;
    return a === "center" || a === "-webkit-center" || a === "right" || a === "end" || a === "justify" || (a === "start" && f.direction === "rtl");
  };

  /**
   * A TEXT node for `t`. `box` is the box it fills (the element it replaces, or its frame's content box); `inFlex`: it is
   * an auto-layout child (no x/y); `fill`: its width follows the parent (stretched or grown), so it wraps there.
   */
  const textNode = (t: CapText, box: CapRect, origin: CapRect | null, inFlex: boolean, fill: boolean, at: string): TreeNodeSpec => {
    stats.texts++;
    if (t.mixed) approx("mixed-inline", at);
    const n: TreeNodeSpec = { text: t.text, font: fontOf(t.font, at) };
    if (t.control) {
      // a control's string: its content box, centred, cut off at the end
      n.box = { w: r2(Math.max(1, box.w)), h: r2(Math.max(1, box.h)) };
      n.font = { ...n.font, valign: "center" };
      n.truncate = true;
      if (origin) { n.x = r2(box.x - origin.x); n.y = r2(box.y - origin.y); }
      return n;
    }
    const single = t.lines <= 1 && t.text.indexOf("\n") < 0;
    const hug = single && !fill && !(aligned(t.font) && box.w > t.rect.w + 1);
    const w = hug ? t.rect.w : box.w;
    n.box = { w: r2(Math.max(1, w)), h: r2(Math.max(1, single ? Math.max(box.h, t.rect.h) : box.h)) };
    n.autoResize = hug ? "width_and_height" : "height";
    if (!inFlex && origin) {
      n.x = r2((hug ? t.rect.x : box.x) - origin.x);
      n.y = r2(box.y - origin.y);
    }
    return n;
  };

  const imagePaint = (img: CapImage, at: string): TreeFill => {
    stats.images++;
    if (img.note) approx("image-fit", at);
    const p: TreeFill = { type: "image", file: img.file, scaleMode: img.scaleMode };
    if (img.scaleMode === "tile" && img.scale !== undefined && img.scale > 0) p.scale = r2(img.scale);
    return p;
  };
  /** The frame's own look: fills (its colour, then its images on top), strokes, radius, opacity, clip. */
  const look = (n: TreeNodeSpec, el: CapEl, at: string): void => {
    const shot = (el.image && el.image.from === "screenshot") || (el.backgroundImage && el.backgroundImage.from === "screenshot");
    const fills: TreeFill[] = [];
    const bg = hexOf(el.background);
    // a screenshot shows the element's own background and border: they are in the picture
    if (bg && !shot) fills.push({ type: "solid", color: bg });
    if (el.backgroundImage) fills.push(imagePaint(el.backgroundImage, at));
    if (el.image) fills.push(imagePaint(el.image, at));
    if (fills.length) n.fills = fills;
    if (el.border && !shot) {
      const [t, r, b, l] = el.border.widths;
      const color = hexOf(el.border.color);
      if (color && (t > 0 || r > 0 || b > 0 || l > 0)) {
        const s: TreeStrokes = { colors: [color], align: el.border.from === "border" ? "inside" : el.border.align };
        if (t === r && t === b && t === l) s.weight = r2(t);
        else s.weights = { top: r2(t), right: r2(r), bottom: r2(b), left: r2(l) };
        n.strokes = s;
      }
    }
    const rad = el.radius;
    if (typeof rad === "number" && rad > 0) n.radius = r2(Math.min(rad, el.rect.w / 2, el.rect.h / 2));
    else if (Array.isArray(rad) && rad.some((v) => v > 0)) {
      const cap = (v: number): number => r2(Math.min(v, el.rect.w / 2, el.rect.h / 2));
      n.radius = { tl: cap(rad[0]), tr: cap(rad[1]), br: cap(rad[2]), bl: cap(rad[3]) };
    }
    if (el.opacity < 1) n.opacity = r2(Math.max(0, el.opacity));
    if (el.clip) n.clip = true;
    for (const d of el.dropped) drop(d, at);
  };

  /** The auto-layout an element gets (null: none), its children in the order Figma lays them out, and any note. */
  const layoutOf = (el: CapEl, at: string, notes: Note[]): { layout: TreeLayout | null; dir: "row" | "column" | null; reverse: boolean; grid: boolean } => {
    const flex = /^(inline-)?flex$/.test(el.display);
    const grid = /^(inline-)?grid$/.test(el.display);
    const pad = el.padding.some((p) => p > 0) ? el.padding.map(r2) : null;
    const gapOf = (v: number | null): number => (v === null ? 0 : v);
    if (flex) {
      const column = /column/.test(el.flexDirection);
      const reverse = /reverse/.test(el.flexDirection);
      const l: TreeLayout = { display: "flex", flexDirection: column ? "column" : "row" };
      const main = gapOf(column ? el.rowGap : el.columnGap);
      if (main > 0) l.gap = r2(main);
      if (el.flexWrap === "wrap" || el.flexWrap === "wrap-reverse") {
        l.flexWrap = "wrap";
        if (el.flexWrap === "wrap-reverse") notes.push(["wrap-reverse", at]);
        const cross = gapOf(column ? el.columnGap : el.rowGap);
        if (cross > 0) { if (column) l.columnGap = r2(cross); else l.rowGap = r2(cross); }
      }
      if (pad) l.padding = pad;
      const j = el.justifyContent.replace(/^(un)?safe\s+/, "");
      const startish = j === "normal" || j === "flex-start" || j === "stretch" || j === "start" || j === "left";
      const endish = j === "flex-end" || j === "end" || j === "right";
      // a reversed flex packs flex-start at the far end; start/end follow the writing direction, not the flex one
      if (j === "center") l.justifyContent = "center";
      else if (j === "space-between" || j === "space-around" || j === "space-evenly") l.justifyContent = j;
      else if (reverse && (j === "normal" || j === "flex-start" || j === "stretch")) l.justifyContent = "flex-end";
      else if (endish && !(reverse && j === "flex-end")) l.justifyContent = "flex-end";
      else if (!startish && !endish) notes.push(["justify-content", at]);
      const ai = el.alignItems.replace(/^(un)?safe\s+/, "");
      if (ai === "center") l.alignItems = "center";
      else if (ai === "flex-end" || ai === "end" || ai === "self-end") l.alignItems = "flex-end";
      else if (/baseline/.test(ai)) { if (column) notes.push(["baseline", at]); else l.alignItems = "baseline"; }
      return { layout: l, dir: column ? "column" : "row", reverse, grid: false };
    }
    if (grid) {
      const cols = el.gridColumns.length, rows = el.gridRows.length;
      const kids = el.children.filter((c) => !isEl(c) || !/absolute|fixed/.test(c.position));
      const box = contentBox(el);
      const colGap = gapOf(el.columnGap), rowGap = gapOf(el.rowGap);
      const regular = cols >= 1 && kids.every((c, i) => {
        if (isEl(c) && c.gridPlaced) return false;
        const col = i % cols;
        const left = box.x + el.gridColumns.slice(0, col).reduce((a, b) => a + b, 0) + col * colGap;
        const track = el.gridColumns[col] || 0;
        return near(c.rect.x, left, 2) && near(c.rect.w, track, 2);
      }) && el.gridColumns.reduce((a, b) => a + b, 0) + (cols - 1) * colGap <= box.w + 0.5;
      if (!regular || cols < 1) {
        approx("grid", at);
        return { layout: null, dir: null, reverse: false, grid: true };
      }
      if (cols === 1) {
        const l: TreeLayout = { display: "flex", flexDirection: "column" };
        if (rowGap > 0) l.gap = r2(rowGap);
        if (pad) l.padding = pad;
        return { layout: l, dir: "column", reverse: false, grid: true };
      }
      const l: TreeLayout = { display: "flex", flexDirection: "row" };
      if (colGap > 0) l.gap = f2(colGap);
      if (rows > 1 || kids.length > cols) {
        l.flexWrap = "wrap";
        if (rowGap > 0) l.rowGap = r2(rowGap);
      }
      if (pad) l.padding = pad;
      return { layout: l, dir: "row", reverse: false, grid: true };
    }
    return { layout: null, dir: null, reverse: false, grid: false };
  };

  /** The children as they are placed: a zero-size wrapper's own children in its place, the flow first (in flex order,
   *  reversed for a reversed flex), then the positioned ones by z-index. */
  const childList = (el: CapEl, flex: boolean, reverse: boolean, at: string, notes: Note[]): Array<CapEl | CapText> => {
    const flat: Array<CapEl | CapText> = [];
    const add = (c: CapEl | CapText, p: string): void => {
      if (isEl(c) && !(c.rect.w > 0.5 && c.rect.h > 0.5) && !c.text) {
        if (c.children.length) { if (flex) notes.push(["zero-size-wrapper", p]); for (const k of c.children) add(k, p); }
        return;
      }
      flat.push(c);
    };
    for (const c of el.children) add(c, isEl(c) ? c.path : at);
    const positioned = (c: CapEl | CapText): boolean => isEl(c) && (flex ? /absolute|fixed/.test(c.position) : /absolute|fixed|relative|sticky/.test(c.position));
    const flow = flat.filter((c) => !positioned(c)).map((c, i) => ({ c, i }));
    if (flex) flow.sort((a, b) => ((isEl(a.c) ? a.c.order : 0) - (isEl(b.c) ? b.c.order : 0)) || a.i - b.i);
    const inFlow = flow.map((x) => x.c);
    if (reverse) inFlow.reverse();
    const out = flat.filter(positioned).map((c, i) => ({ c, i }));
    out.sort((a, b) => ((isEl(a.c) ? a.c.zIndex : 0) - (isEl(b.c) ? b.c.zIndex : 0)) || a.i - b.i);
    return [...inFlow, ...out.map((x) => x.c)];
  };

  type Align = "min" | "center" | "max" | "stretch";
  /** The alignSelf an auto-layout child of `parent` gets (undefined: the layout's alignItems). Shared by place() and the
   *  position check, so the check judges what is written. */
  const selfAlign = (src: CapEl, flex: NonNullable<Parent["flex"]>, cb: CapRect, isText: boolean): Align | undefined => {
    const row = flex.dir === "row";
    const self = src.alignSelf === "auto" || src.alignSelf === "normal" || src.alignSelf === "" ? flex.align : src.alignSelf;
    const map = (a: string): Align => (a === "center" ? "center" : /end$/.test(a) ? "max" : a === "stretch" || a === "normal" ? "stretch" : "min");
    const want = map(self), base = map(flex.align);
    if (want === "stretch") {
      const full = row ? near(src.rect.h, cb.h) : near(src.rect.w, cb.w);
      // a text stretched across a row only grows taller: its box already says how tall it is
      return full && !(isText && row) ? "stretch" : undefined;
    }
    return want !== base && !(base === "stretch" && want === "min") ? want : undefined;
  };
  /** Where a node sits in its parent: x/y (no auto-layout, or absolute), or its grow and cross-axis alignment. */
  const place = (n: TreeNodeSpec, src: CapEl | CapText, parent: Parent, isText: boolean): void => {
    const abs = isEl(src) && /absolute|fixed/.test(src.position);
    if (!parent.flex || abs) {
      if (parent.flex && abs) n.absolute = true;
      if (n.x === undefined) n.x = r2(src.rect.x - parent.el.rect.x);
      if (n.y === undefined) n.y = r2(src.rect.y - parent.el.rect.y);
      return;
    }
    delete n.x; delete n.y;
    if (!isEl(src)) return;
    if (src.flexGrow > 0 && parent.flex.grow) n.grow = 1;
    const a = selfAlign(src, parent.flex, contentBox(parent.el), isText);
    if (a) n.alignSelf = a;
  };
  /** The element a wrapper that only holds one child of its own box stands for (nodeOf writes that child in its place). */
  const collapsed = (outer: CapEl): CapEl => {
    let el = outer;
    for (;;) {
      const only = el.children.length === 1 ? el.children[0] : undefined;
      if (!only || !isEl(only) || hasLook(el) || padded(el) || el.text || el.media || !sameBox(only.rect, el.rect) || el.dropped.length) return el;
      el = only;
    }
  };
  /** It is written as a TEXT, not a frame (nodeOf's test). */
  const asText = (el: CapEl): boolean => el.text !== null && !hasLook(el) && !padded(el) && !el.media;
  /** A run's Range box is its glyphs; a Figma text's box is its line boxes, the glyphs centred in each line. */
  const runBox = (c: CapText): CapRect => {
    const lh = c.font.lineHeight;
    const lines = Math.max(1, c.lines);
    return lh !== null && lh > 0 ? { x: c.rect.x, y: c.rect.y - (lh * lines - c.rect.h) / 2, w: c.rect.w, h: lh * lines } : c.rect;
  };

  /** The box an auto-layout lays its children in: inside its padding, and its border when `strokesIn`. */
  const innerOf = (el: CapEl, l: TreeLayout, strokesIn: boolean): CapRect => {
    const [pt = 0, pr = 0, pb = 0, pl = 0] = l.padding || [];
    const b = strokesIn && el.border ? el.border.widths : [0, 0, 0, 0];
    const bt = b[0] || 0, br = b[1] || 0, bb = b[2] || 0, bl = b[3] || 0;
    return { x: el.rect.x + bl + pl, y: el.rect.y + bt + pt, w: el.rect.w - bl - br - pl - pr, h: el.rect.h - bt - bb - pt - pb };
  };
  /**
   * Whether `grow: 1` on the growing children reproduces their measured sizes. Figma splits the free space equally
   * between every filling child; CSS by flex-grow and flex-basis. So: one line, the free space used up, and every
   * grower the same size (or one grower). Else (`flex: 1` beside `flex: 2`, a wrapped line) they keep their measured
   * sizes, fixed.
   */
  const growFits = (el: CapEl, l: TreeLayout, flow: Array<CapEl | CapText>, row: boolean, strokesIn: boolean): boolean => {
    const growers = flow.filter((c): c is CapEl => isEl(c) && c.flexGrow > 0);
    if (!growers.length) return true;
    if (l.flexWrap === "wrap") return false;
    const size = (c: CapEl | CapText): number => { const r = isEl(c) ? c.rect : runBox(c); return row ? r.w : r.h; };
    const inner = innerOf(el, l, strokesIn);
    const used = flow.reduce((a, c) => a + size(c), 0) + (l.gap || 0) * (flow.length - 1);
    const sizes = growers.map(size);
    return near(used, row ? inner.w : inner.h) && Math.max(...sizes) - Math.min(...sizes) <= 1;
  };

  /**
   * Whether auto-layout `l` on `el` puts its flow children (`flow`, in Figma's order) where the page has them, to the px:
   * along the main axis from the inner start (padding, the border when `strokesIn`) by the sizes before, the gap and
   * justify, each wrapped line broken where Figma breaks it; across, by the child's alignment within its line (the
   * frame's inner size, or a wrapped line's tallest child, lines stacked by the cross gap). Checking positions rather
   * than reading margins catches every cause: a margin, margin: auto, a relative offset, an order, a taller grid track.
   */
  const reproduces = (el: CapEl, l: TreeLayout, flow: Array<CapEl | CapText>, flex: NonNullable<Parent["flex"]>, strokesIn: boolean): boolean => {
    const row = flex.dir === "row";
    const inner = innerOf(el, l, strokesIn);
    const cb = contentBox(el);
    const layoutAlign: Align | "baseline" = l.alignItems === "center" ? "center" : l.alignItems === "flex-end" ? "max" : l.alignItems === "baseline" ? "baseline" : "min";
    const items = flow.map((c) => {
      const rect = isEl(c) ? c.rect : runBox(c);
      const align = isEl(c) ? selfAlign(c, flex, cb, asText(collapsed(c))) ?? layoutAlign : layoutAlign;
      return { main: row ? rect.x : rect.y, size: row ? rect.w : rect.h, cross: row ? rect.y : rect.x, csize: row ? rect.h : rect.w, align };
    });
    const start = row ? inner.x : inner.y, avail = row ? inner.w : inner.h;
    const cStart = row ? inner.y : inner.x, cAvail = row ? inner.h : inner.w;
    const gap = l.gap || 0, crossGap = (row ? l.rowGap : l.columnGap) || 0;
    const wrap = l.flexWrap === "wrap";
    // Figma's lines: a child that does not fit after the ones before (with the gap) starts the next
    const lines: Array<typeof items> = [];
    let cursor = 0;
    for (const it of items) {
      const line = lines[lines.length - 1];
      if (!line || (wrap && cursor + gap + it.size > avail + 0.5)) { lines.push([it]); cursor = it.size; } else { line.push(it); cursor += gap + it.size; }
    }
    let lineStart = cStart;
    for (const line of lines) {
      const n = line.length, sum = line.reduce((a, it) => a + it.size, 0);
      const free = avail - sum - gap * (n - 1);
      const j = l.justifyContent;
      // space-* spread the free space with no gap of their own, as Figma does (a CSS gap with them differs: not reproduced)
      let at = start, step = gap;
      if (j === "flex-end") at += free;
      else if (j === "center") at += free / 2;
      else if (j === "space-between") step = n > 1 ? (avail - sum) / (n - 1) : 0;
      else if (j === "space-around") { step = (avail - sum) / n; at += step / 2; }
      else if (j === "space-evenly") { step = (avail - sum) / (n + 1); at += step; }
      const lineSize = wrap ? Math.max(...line.map((it) => it.csize)) : cAvail;
      for (const it of line) {
        if (!near(it.main, at)) return false;
        at += it.size + step;
        // baseline: only where it is the line's start too (a margin above an item would pass unseen otherwise)
        const want = it.align === "center" ? lineStart + (lineSize - it.csize) / 2 : it.align === "max" ? lineStart + lineSize - it.csize : lineStart;
        if (!near(it.cross, want)) return false;
      }
      lineStart += lineSize + crossGap;
    }
    return true;
  };
  /** More than one line: some child starts across from where another ends. */
  const manyLines = (flow: Array<CapEl | CapText>, row: boolean): boolean => {
    const rs = flow.map((c) => (isEl(c) ? c.rect : runBox(c)));
    if (rs.length < 2) return false;
    const starts = rs.map((r) => (row ? r.y : r.x)), ends = rs.map((r) => (row ? r.y + r.h : r.x + r.w));
    return Math.max(...starts) >= Math.min(...ends) - 0.5;
  };

  /** The node for `outer` in `parent` (null: nothing to show); the root (`parent` null) is always a frame, in no flow. */
  const nodeOf = (outer: CapEl, parent: Parent | null): TreeNodeSpec | null => {
    // a wrapper that only holds one child of its own box is that child
    const el = parent ? collapsed(outer) : outer;
    const at = el.path;
    const pf = parent ? parent.flex : null;
    const inFlex = pf !== null && !/absolute|fixed/.test(outer.position);
    const grows = inFlex && pf !== null && outer.flexGrow > 0 && pf.grow === true && pf.dir === "row";
    const stretched = inFlex && parent !== null && pf !== null && pf.dir === "column" && near(outer.rect.w, contentBox(parent.el).w) && (outer.alignSelf === "stretch" || ((outer.alignSelf === "auto" || outer.alignSelf === "normal") && (pf.align === "normal" || pf.align === "stretch")));
    // text only, and nothing a frame must keep: the element is its TEXT
    if (parent && asText(el) && el.text) {
      // a flex item wider than its text keeps its width: the flow after it depends on it
      const wider = inFlex && el.rect.w > el.text.rect.w + 1;
      const n = textNode(el.text, el.rect, inFlex ? null : parent.el.rect, inFlex, grows || stretched || wider, at);
      if (el.opacity < 1) n.opacity = r2(el.opacity);
      for (const d of el.dropped) drop(d, at);
      place(n, outer, parent, true);
      return n;
    }
    const n: TreeNodeSpec = { name: el.name, box: { w: r2(Math.max(0.01, el.rect.w)), h: r2(Math.max(0.01, el.rect.h)) } };
    stats.frames++;
    look(n, el, at);
    if (el.media && !el.image) drop("image", at);
    // the whole document is placed as it lies (its <body>'s own layout is not the page's box)
    const none: ReturnType<typeof layoutOf> = { layout: null, dir: null, reverse: false, grid: false };
    const notes: Note[] = [];
    let lay: ReturnType<typeof layoutOf> = el.media || (!parent && doc.document) ? none : layoutOf(el, at, notes);
    const strokesIn = lay.layout !== null && el.border !== null && el.border.from === "border" && el.border.widths.some((w) => w > 0) && !((el.image && el.image.from === "screenshot") || (el.backgroundImage && el.backgroundImage.from === "screenshot"));
    let self: Parent = { el, flex: lay.dir ? { dir: lay.dir, align: lay.grid ? "flex-start" : el.alignItems.replace(/^(un)?safe\s+/, "") } : null };
    let list = el.text || el.media ? [] : childList(el, self.flex !== null, lay.reverse, at, notes);
    if (lay.layout && self.flex && !el.text && !el.media) {
      // the auto-layout is written only when it puts the children where the page has them; else they keep their x/y
      const flow = list.filter((c) => !(isEl(c) && /absolute|fixed/.test(c.position)));
      const why = lay.reverse && lay.layout.flexWrap === "wrap" && manyLines(flow, self.flex.dir === "row") ? "reverse-wrap"
        : !reproduces(el, lay.layout, flow, self.flex, strokesIn) ? (lay.grid ? "grid" : "flex") : null;
      if (why) {
        approx(why, at);
        lay = none;
        self = { el, flex: null };
        notes.length = 0;
        list = childList(el, false, false, at, notes);
      } else if (self.flex) {
        // kept: grow only where Figma's equal split gives the page's sizes
        self.flex.grow = growFits(el, lay.layout, flow, self.flex.dir === "row", strokesIn);
        if (!self.flex.grow) approx("flex-grow", at);
      }
    }
    for (const [kind, p] of notes) approx(kind, p);
    if (lay.layout) {
      n.layout = lay.layout;
      if (strokesIn) n.strokesInLayout = true;
    }
    const kids: TreeNodeSpec[] = [];
    if (el.text) {
      // a painted or padded text: its frame, the TEXT inside its content box
      const cb = contentBox(el);
      const t = textNode(el.text, cb, self.flex ? null : el.rect, self.flex !== null, false, at);
      kids.push(t);
    } else if (!el.media) {
      for (const c of list) {
        if (isEl(c)) {
          const k = nodeOf(c, self);
          if (k) kids.push(k);
        } else {
          const box = runBox(c);
          const k = textNode({ ...c, rect: box }, box, self.flex ? null : el.rect, self.flex !== null, false, at);
          place(k, { ...c, rect: box }, self, true);
          kids.push(k);
        }
      }
      if (lay.grid && lay.layout && lay.layout.flexWrap === "wrap") for (const k of kids) if (k.box && !k.absolute) k.box = { w: f2(k.box.w), h: k.box.h };
    }
    if (kids.length) n.children = kids;
    // an empty, unpainted leaf shows nothing; in an auto-layout parent it still takes its space
    if (parent && !kids.length && !n.fills && !n.strokes && !inFlex) { stats.frames--; return null; }
    if (parent) place(n, outer, parent, false);
    return n;
  };

  const root = nodeOf(doc.root, null) || { box: { w: 1, h: 1 } };
  root.name = doc.name + " @" + doc.width;
  root.key = "capture:" + doc.name + "@" + doc.width;
  root.box = { w: r2(Math.max(1, doc.root.rect.w)), h: r2(Math.max(1, doc.root.rect.h)) };
  // the page's background under the root when the root paints none of its own
  const first = root.fills && root.fills[0];
  if (!first || first.type !== "solid") root.fills = [{ type: "solid", color: hexOf(doc.background) || "#ffffff" }, ...(root.fills || [])];
  root.clip = true;
  stats.depth = depthOf(root);
  stats.nodes = countNodes(root);
  if (stats.nodes > MAX_TREE_NODES) return { ok: false, error: `the capture at ${doc.width} px is ${stats.nodes} nodes, more than the ${MAX_TREE_NODES} one spec may hold`, stats };
  if (stats.depth > MAX_TREE_DEPTH) return { ok: false, error: `the capture at ${doc.width} px nests ${stats.depth} levels deep, more than the ${MAX_TREE_DEPTH} one spec may`, stats };
  return { ok: true, spec: root, stats };
}

/** How deep a spec nests below its root. */
export function depthOf(n: TreeNodeSpec): number {
  return (n.children || []).reduce((d, c) => Math.max(d, 1 + depthOf(c)), 0);
}
/** The nodes of a spec, its root included. */
export function countNodes(n: TreeNodeSpec): number {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}

/** The tree spec's own check of a captured spec (bridge/src/tree-check.ts), its image paints given the id their file has
 *  (`image`, what the MCP server sets once it has read the file): every problem, empty when it is valid. A problem is a
 *  bug in the conversion, never the page's. */
export function checkCaptured(spec: TreeNodeSpec, idOf: (file: string) => string | null): string[] {
  const filled = mapImagePaints(spec, "tree", (p) => {
    const id = typeof p.file === "string" ? idOf(p.file) : null;
    return id ? { ...p, image: id } : null;
  });
  return checkTree(filled).problems;
}
