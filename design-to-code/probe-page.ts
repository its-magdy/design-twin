// probe-page.ts — the two functions verify-probe.ts hands to Playwright's page.evaluate(fn, arg).
//
// page.evaluate serialises a function with Function.prototype.toString() and runs the TEXT in the page, so
// each function here must be SELF-CONTAINED: no reference to anything outside its own body (no module
// constant, no imported helper, no other function in this file) — every helper is nested inside it, and
// its argument and return value are plain JSON. A stray outer reference is a ReferenceError in the page,
// not a type error here, which is why test/verify-probe-e2e.test.ts runs the BUILT bundle in a real
// browser. (esbuild does not hoist or rename a function's nested locals without minification; the e2e
// run is the check that it still does not.)
//
// The DOM is typed by the small module-local declarations below, not lib:dom: the test/design-to-code
// tsconfig has no DOM lib (the rest of this layer runs in Node, where `document` does not exist), and
// these declarations are erased, so nothing here reaches the bundle but the two functions.
//
// Division of labour: these functions only LOOK (element paths, rects, visibility flags, computed styles).
// Every decision — which element is a spec's, which frame root wins, what a null means — is in
// probe-match.ts, which is pure and unit-tested without a browser.

// ---------------------------------------------------------------- the page, as far as these functions use it
interface PRect { x: number; y: number; width: number; height: number }
interface PStyle { getPropertyValue(prop: string): string }
interface PNode { nodeType: number; nodeValue: string | null; textContent: string | null; childNodes: ArrayLike<PNode> }
interface PElement extends PNode {
  tagName: string;
  children: ArrayLike<PElement>;
  parentElement: PElement | null;
  placeholder?: string;
  /** the left / top border widths (the padding box's offset inside the border box) */
  clientLeft: number;
  clientTop: number;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): PRect;
  getClientRects(): ArrayLike<PRect>;
  closest(selector: string): PElement | null;
  matches(selector: string): boolean;
  contains(other: PElement): boolean;
  checkVisibility(opts?: { visibilityProperty?: boolean; checkVisibilityCSS?: boolean; opacityProperty?: boolean }): boolean;
  querySelectorAll(selector: string): ArrayLike<PElement>;
}
interface PRange { selectNodeContents(node: PNode): void; getBoundingClientRect(): PRect }
interface PCtx { fillStyle: string; clearRect(x: number, y: number, w: number, h: number): void; fillRect(x: number, y: number, w: number, h: number): void; getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } }
interface PCanvas { width: number; height: number; getContext(kind: "2d", opts?: { willReadFrequently?: boolean }): PCtx | null }
interface PDocument {
  body: PElement | null;
  documentElement: PElement;
  querySelector(selector: string): PElement | null;
  querySelectorAll(selector: string): ArrayLike<PElement>;
  createRange(): PRange;
  createElement(tag: "canvas"): PCanvas;
  activeElement: PElement | null;
  elementFromPoint(x: number, y: number): PElement | null;
}
declare const document: PDocument;
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: PElement, pseudo?: string | null): PStyle;

// ---------------------------------------------------------------- the data both sides agree on
/** Page coordinates (viewport rect + scroll), so a frame-relative value does not depend on the scroll. */
export interface Rect { x: number; y: number; w: number; h: number }
/** Why an element might not be the one a person sees (probe-match.ts decides what each one rules out). */
export interface ElemFlags {
  /** it has at least one layout box (not display:none / display:contents) */
  box: boolean;
  /** Element.checkVisibility({visibilityProperty, checkVisibilityCSS}) */
  visible: boolean;
  zeroSize: boolean;
  /** inside a <dialog> that is not open */
  inClosedDialog: boolean;
  /** inside an [inert] subtree */
  inert: boolean;
  /** it or an ancestor has opacity 0 */
  opacity0: boolean;
  /** inside [aria-hidden="true"] — recorded, never a reason to reject (decorative ≠ invisible) */
  ariaHidden: boolean;
}
/** One element the page offered: an nth-child CSS path (unique in this document), where it is, and whether it shows. */
export interface Candidate {
  path: string;
  tag: string;
  /** its own data-dt-node, if any */
  dt: string | null;
  rect: Rect;
  /** a Range over its contents (the text's ink box, for a text candidate) */
  rangeRect: Rect | null;
  flags: ElemFlags;
  /** data-dt-node values of its ancestors, nearest first */
  taggedAncestors: string[];
  /** its OWN direct text nodes, normalised (not its descendants') */
  ownText: string;
  /** document order (pre-order index over body's descendants) */
  order: number;
  /** nesting depth below <body> */
  depth: number;
}
/** A frame-root candidate found by size: an element within ±2px of the frame's w×h, with its paint. */
export interface SizedCandidate extends Candidate { background: string; backgroundImage: string; paints: boolean }
export interface CollectInput {
  frames: Array<{ nodeId: string; w: number | null; h: number | null }>;
  /** normalised texts to find (a spec's text or placeholder text) */
  texts: string[];
  /** --position: boxes in PAGE coordinates to find elements at (±2px) */
  positions: Array<{ nodeId: string; x: number; y: number; w: number; h: number }>;
}
export interface CollectOutput {
  viewport: { w: number; h: number; scrollX: number; scrollY: number };
  /** every element carrying data-dt-node, in document order */
  tagged: Candidate[];
  /** per frame id: the elements tagged with it, and the size-matched candidates (outermost first) */
  frames: Record<string, { sized: SizedCandidate[] }>;
  /** per text: the innermost elements whose normalised textContent equals it — exact, then case-insensitive */
  text: Record<string, { exact: Candidate[]; caseless: Candidate[] }>;
  /** per text: form controls whose placeholder attribute equals it */
  placeholders: Record<string, Candidate[]>;
  /** per --position node id: the innermost elements at that box */
  positions: Record<string, Candidate[]>;
}

/**
 * In the page: every tagged element, frame-root candidates, text owners and (opt-in) position hits.
 * SELF-CONTAINED — see the file header.
 */
export function collectCandidates(input: CollectInput): CollectOutput {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const norm = (s: string | null): string => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const pageRect = (r: PRect): Rect => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  const pathOf = (el: PElement): string => {
    const parts: string[] = [];
    let cur: PElement | null = el;
    while (cur && cur !== document.documentElement) {
      const parent: PElement | null = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const all: PElement[] = document.body ? [document.body, ...Array.from(document.body.querySelectorAll("*"))].filter((e) => !SKIP.has(e.tagName)) : [];
  const orderOf = new Map<PElement, number>();
  all.forEach((e, i) => orderOf.set(e, i));
  const depthOf = (el: PElement): number => { let d = 0; for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) d++; return el === document.body ? 0 : d + 1; };
  const cand = (el: PElement, withRange: boolean): Candidate => {
    const r = el.getBoundingClientRect();
    let rangeRect: Rect | null = null;
    if (withRange) { const range = document.createRange(); range.selectNodeContents(el); rangeRect = pageRect(range.getBoundingClientRect()); }
    const tagged: string[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) { const v = p.getAttribute("data-dt-node"); if (v !== null) tagged.push(v); }
    const box = el.getClientRects().length > 0;
    return {
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      dt: el.getAttribute("data-dt-node"),
      rect: pageRect(r),
      rangeRect,
      flags: {
        box,
        visible: box && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }),
        zeroSize: r.width === 0 || r.height === 0,
        inClosedDialog: el.closest("dialog:not([open])") !== null,
        inert: el.closest("[inert]") !== null,
        opacity0: box && !el.checkVisibility({ opacityProperty: true }),
        ariaHidden: el.closest('[aria-hidden="true"]') !== null,
      },
      taggedAncestors: tagged,
      ownText: norm(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("")),
      order: orderOf.get(el) ?? -1,
      depth: depthOf(el),
    };
  };
  // "Paints": a background colour with alpha > 0, or a background image. The colour is drawn on a 1×1
  // canvas and read back, so any syntax the browser computes (rgb(), color(srgb …), oklch(…)) is judged alike.
  let ctx: PCtx | null = null;
  const alphaOf = (css: string): number => {
    const m = /^rgba?\(([^)]*)\)$/.exec(css.trim());
    if (m) { const p = (m[1] || "").split(/[\s,/]+/).filter(Boolean); return p.length >= 4 ? Number(p[3]) : 1; }
    if (css.trim() === "transparent") return 0;
    if (!ctx) { const c = document.createElement("canvas"); c.width = 1; c.height = 1; ctx = c.getContext("2d", { willReadFrequently: true }); }
    if (!ctx) return 1;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
    return (ctx.getImageData(0, 0, 1, 1).data[3] ?? 255) / 255;
  };

  const tagged = Array.from(document.querySelectorAll("[data-dt-node]")).map((e) => cand(e, false));

  const frames: CollectOutput["frames"] = {};
  for (const f of input.frames) {
    const sized: SizedCandidate[] = [];
    if (f.w !== null && f.h !== null && document.body) {
      // breadth-first from <body>, depth ≤ 8, so the OUTERMOST matching element comes first
      let level: PElement[] = [document.body];
      for (let depth = 0; depth <= 8 && level.length; depth++) {
        const next: PElement[] = [];
        for (const el of level) {
          if (SKIP.has(el.tagName)) continue;
          const r = el.getBoundingClientRect();
          if (Math.abs(r.width - f.w) <= 2 && Math.abs(r.height - f.h) <= 2) {
            const cs = getComputedStyle(el);
            const background = cs.getPropertyValue("background-color"), backgroundImage = cs.getPropertyValue("background-image");
            sized.push({ ...cand(el, false), background, backgroundImage, paints: alphaOf(background) > 0 || (backgroundImage !== "" && backgroundImage !== "none") });
          }
          next.push(...Array.from(el.children));
        }
        level = next;
      }
    }
    frames[f.nodeId] = { sized };
  }

  // Text owners: elements whose normalised textContent equals the text, keeping the INNERMOST (an element
  // that contains another hit is its wrapper, not its owner).
  const innermost = (els: PElement[]): PElement[] => els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  const wanted = new Set(input.texts);
  const wantedLower = new Map<string, string[]>();
  for (const t of wanted) { const k = t.toLowerCase(); wantedLower.set(k, [...(wantedLower.get(k) || []), t]); }
  const exact = new Map<string, PElement[]>(), caseless = new Map<string, PElement[]>(), ph = new Map<string, PElement[]>();
  const push = (m: Map<string, PElement[]>, k: string, e: PElement): void => { const l = m.get(k); if (l) l.push(e); else m.set(k, [e]); };
  if (wanted.size) {
    for (const el of all) {
      const t = norm(el.textContent);
      if (t) {
        if (wanted.has(t)) push(exact, t, el);
        for (const orig of wantedLower.get(t.toLowerCase()) || []) push(caseless, orig, el);
      }
      const p = el.getAttribute("placeholder");
      if (p !== null && wanted.has(norm(p))) push(ph, norm(p), el);
    }
  }
  const text: CollectOutput["text"] = {}, placeholders: CollectOutput["placeholders"] = {};
  for (const t of wanted) {
    text[t] = { exact: innermost(exact.get(t) || []).map((e) => cand(e, true)), caseless: innermost(caseless.get(t) || []).map((e) => cand(e, true)) };
    placeholders[t] = (ph.get(t) || []).map((e) => cand(e, false));
  }

  const positions: CollectOutput["positions"] = {};
  for (const p of input.positions) {
    const hits = all.filter((el) => {
      const r = pageRect(el.getBoundingClientRect());
      return Math.abs(r.x - p.x) <= 2 && Math.abs(r.y - p.y) <= 2 && Math.abs(r.w - p.w) <= 2 && Math.abs(r.h - p.h) <= 2;
    });
    positions[p.nodeId] = innermost(hits).map((e) => cand(e, false));
  }

  return { viewport: { w: innerWidth, h: innerHeight, scrollX, scrollY }, tagged, frames, text, placeholders, positions };
}

// ---------------------------------------------------------------- measuring
export interface MeasureItem {
  nodeId: string; path: string; isText: boolean; isPaint: boolean; isPlaceholder: boolean;
  /** a TEXT spec read on its tagged ancestor's element (`<button data-dt-node=X>label</button>`): that id — the box is X's, not the text's */
  sharesWith: string | null;
  /** F-74 / DT-48 (D111): the spec states a backgroundColor — a transparent element then says who paints it (styles.paintedBy) */
  backgroundSpec?: boolean;
}
export interface MeasureInput {
  /** the frame root's rect, PAGE coordinates — x/y/textBox are reported relative to it */
  frameRect: Rect;
  /** the frame root's element path — the highest ancestor paintedBy looks at (absent: up to <html>) */
  framePath?: string | null;
  /** every key each node's styles must carry (verify-screen.ts STYLE_KEYS) */
  keys: readonly string[];
  items: MeasureItem[];
}
export type PValue = string | number | boolean | null | PValue[] | { [k: string]: PValue };
export interface MeasureResult {
  nodeId: string;
  /** false when the path no longer resolves (the page changed under the probe) */
  found: boolean;
  styles: Record<string, PValue>;
  /** why a key is null */
  unmeasured: Record<string, string>;
  textFrom?: string;
  textFromMixed?: boolean;
  fillSource?: "svg" | "background" | "img" | "css";
}

/**
 * In the page: computed values for every requested key on each item's element (null + a reason when a
 * value cannot be read). SELF-CONTAINED — see the file header.
 */
export function measureElements(input: MeasureInput): MeasureResult[] {
  const px = (v: string): number | null => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const pageRect = (r: PRect): Rect => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  const collapse = (s: string | null): string => (s || "").replace(/[ \t\n\r\f]+/g, " ").trim();
  // Colours as rgba(): the browser may compute oklch()/color(srgb …) (Tailwind v4), which the compare's
  // colour normaliser does not read — so anything that is not already rgb()/rgba() is painted on a 1×1
  // canvas and read back as sRGB bytes.
  let ctx: PCtx | null = null;
  const rgba = (css: string): string | null => {
    const s = css.trim();
    if (!s) return null;
    if (/^rgba?\(/.test(s) || s === "transparent") return s;
    if (!ctx) { const c = document.createElement("canvas"); c.width = 1; c.height = 1; ctx = c.getContext("2d", { willReadFrequently: true }); }
    if (!ctx) return s;
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = s; ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const [r = 0, g = 0, b = 0, a = 255] = [d[0], d[1], d[2], d[3]];
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  };
  const ownText = (el: PElement): string => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("").trim();
  const elementsWithOwnText = (el: PElement): PElement[] => {
    const out: PElement[] = [];
    const walk = (e: PElement): void => { if (ownText(e)) out.push(e); for (const c of Array.from(e.children)) walk(c); };
    walk(el);
    return out;
  };
  // The element that owns a TEXT spec's characters (F-71/F-120): descend single-child chains from the matched
  // element to the first one whose OWN text nodes hold text; when the text is split over several elements,
  // the first run's owner (textFromMixed).
  const textOwner = (el: PElement): { owner: PElement; mixed: boolean } | null => {
    const owners = elementsWithOwnText(el);
    const mixed = owners.length > 1;
    let cur = el;
    for (;;) {
      if (ownText(cur)) return { owner: cur, mixed };
      const kids = Array.from(cur.children);
      const only = kids.length === 1 ? kids[0] : undefined;
      if (!only) break;
      cur = only;
    }
    const first = owners[0];
    return first ? { owner: first, mixed } : null;
  };
  const SHAPES = "path, rect, circle, ellipse, polygon, polyline, line, use, text";

  return input.items.map((item): MeasureResult => {
    const styles: Record<string, PValue> = {};
    const unmeasured: Record<string, string> = {};
    const res: MeasureResult = { nodeId: item.nodeId, found: false, styles, unmeasured };
    const el = document.querySelector(item.path);
    const put = (k: string, v: PValue | undefined, why: string): void => { if (v === null || v === undefined) { styles[k] = null; unmeasured[k] = why; } else styles[k] = v; };
    if (!el) { for (const k of input.keys) put(k, null, "the element was gone when measured"); return res; }
    res.found = true;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const rect = pageRect(el.getBoundingClientRect());
    const fr = input.frameRect;

    let typo = el, typoCs = cs;
    let textBox: PValue = null, textBoxWhy = item.isPlaceholder ? "an input placeholder: its characters are not in the DOM (see placeholderText)" : "not a TEXT node";
    if (item.isText && !item.isPlaceholder) {
      const own = textOwner(el);
      if (own) {
        typo = own.owner; typoCs = getComputedStyle(typo);
        res.textFrom = typo.tagName.toLowerCase();
        if (own.mixed) res.textFromMixed = true;
        // over the owner's OWN text nodes only — a Range over the whole element spans its icon children too
        // (<button><svg/>Filter</button> read 50.9 wide for a 28.9 label)
        let left = Infinity, right = -Infinity;
        for (const n of Array.from(typo.childNodes)) {
          if (n.nodeType !== 3 || !(n.nodeValue || "").trim()) continue;
          const range = document.createRange(); range.selectNodeContents(n);
          const rr = pageRect(range.getBoundingClientRect());
          if (rr.w <= 0) continue;
          left = Math.min(left, rr.x); right = Math.max(right, rr.x + rr.w);
        }
        if (Number.isFinite(left)) textBox = { x: r2(left - fr.x), w: r2(right - left) };
        else textBoxWhy = "the text's own characters have no rendered box";
      } else textBoxWhy = "the element holds no text";
    }

    const sides = (prop: (side: string) => string): Array<number | null> => ["top", "right", "bottom", "left"].map((s) => px(cs.getPropertyValue(prop(s))));
    // D34: a stroke drawn without a border — a ring (`box-shadow: 0 0 0 Npx <colour>`, Tailwind ring / inset-ring)
    // or an outline at offset 0 / -width — read only when every border side is 0. Parsed by CONTENT, never by
    // position: Tailwind v4 always computes FIVE comma-separated shadows, the unused ones "rgba(0, 0, 0, 0) 0px 0px
    // 0px 0px", and the ring may be any of them; Chromium writes the colour first and `inset` last. A shadow with a
    // transparent colour or spread 0 is padding; a ring is offset 0, blur 0, spread > 0 (the spread is not snapped
    // like a border width). Several distinct rings: the inset one when exactly one is inset, else none is read.
    // An outline with style auto (the UA focus ring) is no designed stroke; a centred one (any other offset) is not read.
    type Stroke = { width: number; color: string | null; from: "box-shadow" | "outline"; align: "inside" | "outside" };
    let strokeMemo: Stroke | null | undefined;
    const transparentColour = (c: string | null): boolean => c === null || c === "transparent" || /,\s*0(?:\.0+)?\)$/.test(c) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(c);
    const splitTop = (v: string, sep: RegExp): string[] => {
      const out: string[] = [];
      let depth = 0, cur = "";
      for (const ch of v) {
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        if (depth === 0 && sep.test(ch)) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const drawnStroke = (): Stroke | null => {
      if (strokeMemo !== undefined) return strokeMemo;
      strokeMemo = null;
      if (sides((s) => `border-${s}-width`).some((w) => w !== 0)) return strokeMemo;
      const rings: Array<{ key: string; spread: number; color: string | null; inset: boolean }> = [];
      const shadow = cs.getPropertyValue("box-shadow").trim();
      if (shadow && shadow !== "none") {
        for (const entry of splitTop(shadow, /,/)) {
          const lens: number[] = [];
          let inset = false, colour = "";
          for (const tok of splitTop(entry, /\s/)) {
            if (tok === "inset") inset = true;
            else if (/^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(tok)) lens.push(parseFloat(tok));
            else colour = colour ? `${colour} ${tok}` : tok;
          }
          const [x = NaN, y = NaN, blur = 0, spread = 0] = lens;
          const color = colour ? rgba(colour) : rgba(cs.getPropertyValue("color"));
          if (transparentColour(color) || !(spread > 0) || x !== 0 || y !== 0 || blur !== 0 || lens.length < 2) continue;
          rings.push({ key: `${color} ${spread} ${inset}`, spread: r2(spread), color, inset });
        }
      }
      const distinct = rings.filter((r, i) => rings.findIndex((o) => o.key === r.key) === i);
      const insetOnes = distinct.filter((r) => r.inset);
      const ring = distinct.length === 1 ? distinct[0] : insetOnes.length === 1 ? insetOnes[0] : undefined;
      if (ring) return (strokeMemo = { width: ring.spread, color: ring.color, from: "box-shadow", align: ring.inset ? "inside" : "outside" });
      if (distinct.length > 1) return strokeMemo;
      const os = cs.getPropertyValue("outline-style").trim(), ow = px(cs.getPropertyValue("outline-width")), oo = px(cs.getPropertyValue("outline-offset"));
      const oc = rgba(cs.getPropertyValue("outline-color"));
      if (!os || os === "none" || os === "auto" || ow === null || !(ow > 0) || oo === null || transparentColour(oc)) return strokeMemo;
      if (oo === -ow) return (strokeMemo = { width: ow, color: oc, from: "outline", align: "inside" });
      if (oo === 0) return (strokeMemo = { width: ow, color: oc, from: "outline", align: "outside" });
      return strokeMemo;
    };
    // F-74 / DT-48 (D111): who paints an element whose own background-color is transparent — a <td> under a `tr:hover`
    // row, a wrapper whose only child carries the fill. First a chain of only-children with the element's box (±1px): the
    // first that paints lies ON TOP of the element (an ancestor's paint would be hidden under it); else the nearest ancestor
    // that paints, up to and including the frame root, when its border box holds the element's (±1px). A background-image
    // (a gradient, a picture) on the way, or a painting ancestor that does not hold the element, ends the search with no
    // answer: its colour is not one value. L5: when the element's own children paint all of it (its 4 corners, inset 2px,
    // and its centre each lie on a painting child — a transparent row whose cells carry the hover), no ancestor's colour
    // shows on it: no answer either. Ancestor opacity/filter, ::before painters and a sibling/overlay painting over the
    // element are not looked at (known misses: an overlay may make it pass — LIMITS).
    const frameRoot = input.framePath ? document.querySelector(input.framePath) : null;
    const paintOf = (e: PElement): { color: string | null; image: boolean } => {
      const s = getComputedStyle(e), img = s.getPropertyValue("background-image").trim();
      return { color: rgba(s.getPropertyValue("background-color")), image: img !== "" && img !== "none" };
    };
    const painter = (e: PElement, via: "ancestor" | "child", depth: number, color: string): PValue => {
      const dt = e.getAttribute("data-dt-node");
      return { backgroundColor: color, via, tag: e.tagName.toLowerCase(), depth, ...(dt !== null ? { dt } : {}) };
    };
    const paintedBy = (): PValue | null => {
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
      let cur = el, depth = 0;
      for (;;) {
        const kids = Array.from(cur.children);
        const only = kids.length === 1 ? kids[0] : undefined;
        if (!only) break;
        const r = pageRect(only.getBoundingClientRect());
        if (!(near(r.x, rect.x) && near(r.y, rect.y) && near(r.w, rect.w) && near(r.h, rect.h))) break;
        cur = only; depth++;
        const p = paintOf(cur);
        if (p.image) return null;
        if (!transparentColour(p.color) && p.color !== null) return painter(cur, "child", depth, p.color);
      }
      const kids = Array.from(el.children).filter((k) => { const p = paintOf(k); return p.image || !transparentColour(p.color); }).map((k) => pageRect(k.getBoundingClientRect()));
      if (kids.length && rect.w > 4 && rect.h > 4) {
        const l = rect.x + 2, r = rect.x + rect.w - 2, t = rect.y + 2, b = rect.y + rect.h - 2;
        const pts: Array<[number, number]> = [[l, t], [r, t], [l, b], [r, b], [rect.x + rect.w / 2, rect.y + rect.h / 2]];
        if (pts.every(([x, y]) => kids.some((k) => x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h))) return null;
      }
      depth = 0;
      for (let a = el.parentElement; a; a = a.parentElement) {
        depth++;
        const p = paintOf(a);
        if (p.image || !transparentColour(p.color)) {
          const r = pageRect(a.getBoundingClientRect());
          const holds = rect.x >= r.x - 1 && rect.y >= r.y - 1 && rect.x + rect.w <= r.x + r.w + 1 && rect.y + rect.h <= r.y + r.h + 1;
          return !p.image && holds && p.color !== null ? painter(a, "ancestor", depth, p.color) : null;
        }
        if (a === frameRoot) break;
      }
      return null;
    };
    const putStroke = (): void => {
      const st = drawnStroke();
      if (st) { styles.strokeFrom = st.from; styles.strokeAlign = st.align; }
      else if (sides((s) => `border-${s}-width`).some((w) => w !== null && w > 0)) styles.strokeFrom = "border";
    };
    const fill = (): { v: string | null; why: string; source?: MeasureResult["fillSource"] } => {
      if (!item.isPaint) return { v: null, why: "not a vector/SVG node — its colour is backgroundColor" };
      if (tag === "img" || tag === "canvas" || tag === "picture") return { v: null, why: `an <${tag}>: its paint is pixels, not a CSS property`, source: "img" };
      const shapes = [...(el.matches(SHAPES) ? [el] : []), ...Array.from(el.querySelectorAll(SHAPES))];
      let stroke: string | null = null;
      for (const s of shapes) {
        const scs = getComputedStyle(s);
        const f = scs.getPropertyValue("fill").trim();
        if (f && f !== "none") {
          if (/^url\(/.test(f)) return { v: null, why: `SVG paint is a gradient/pattern (${f})`, source: "svg" };
          return { v: rgba(f), why: "", source: "svg" };
        }
        const st = scs.getPropertyValue("stroke").trim();
        if (!stroke && st && st !== "none") stroke = st;
      }
      if (stroke) return { v: null, why: `stroke-only icon (stroke ${rgba(stroke) ?? stroke})`, source: "svg" };
      const mask = (cs.getPropertyValue("mask-image") || cs.getPropertyValue("-webkit-mask-image")).trim();
      const bg = rgba(cs.getPropertyValue("background-color"));
      if (bg && bg !== "transparent" && !/,\s*0\)$/.test(bg)) return { v: bg, why: "", source: "background" };
      // a wrapper around an <img>/<canvas> (no <svg>, no painted background of its own): the paint is the image's
      if (el.querySelectorAll("img, canvas").length > 0) return { v: null, why: "an <img>: its paint is pixels, not a CSS property", source: "img" };
      if (mask && mask !== "none") return { v: null, why: "a mask-drawn icon with a transparent background", source: "background" };
      return { v: null, why: shapes.length ? "no SVG shape has a fill" : "no SVG shape, no background: nothing paints this node", source: "css" };
    };

    for (const k of input.keys) {
      switch (k) {
        case "fontFamily": put(k, typoCs.getPropertyValue("font-family") || null, "no computed font-family"); break;
        case "fontSize": put(k, px(typoCs.getPropertyValue("font-size")), "no computed font-size"); break;
        case "fontWeight": { const w = parseInt(typoCs.getPropertyValue("font-weight"), 10); put(k, Number.isFinite(w) ? w : null, "no numeric font-weight"); break; }
        case "lineHeight": { const v = typoCs.getPropertyValue("line-height"); put(k, v === "normal" ? null : px(v), "line-height: normal — its pixel value depends on the font's metrics"); break; }
        case "letterSpacing": { const v = typoCs.getPropertyValue("letter-spacing"); put(k, v === "normal" ? 0 : px(v), "no computed letter-spacing"); break; }
        case "color": put(k, rgba(typoCs.getPropertyValue("color")), "no computed color"); break;
        case "backgroundColor": {
          const bg = rgba(cs.getPropertyValue("background-color"));
          put(k, bg, "no computed background-color");
          if (item.backgroundSpec && bg !== null && transparentColour(bg)) { const pb = paintedBy(); if (pb !== null) styles.paintedBy = pb; }
          break;
        }
        case "fill": { const f = fill(); if (f.source) res.fillSource = f.source; put(k, f.v, f.why); break; }
        case "placeholderColor":
          if (!item.isPlaceholder) put(k, null, "not an input placeholder");
          else if (!el.hasAttribute("placeholder")) put(k, null, `the matched <${tag}> has no placeholder attribute`);
          else put(k, rgba(getComputedStyle(el, "::placeholder").getPropertyValue("color")), "no computed ::placeholder colour");
          break;
        case "placeholderText":
          if (!item.isPlaceholder) put(k, null, "not an input placeholder");
          else put(k, el.getAttribute("placeholder"), `the matched <${tag}> has no placeholder attribute`);
          break;
        case "borderColor": {
          const ws = sides((s) => `border-${s}-width`);
          const i = ws.findIndex((w) => w !== null && w > 0);
          const st = i === -1 ? drawnStroke() : null;
          put(k, st ? st.color : i === -1 ? null : rgba(cs.getPropertyValue(`border-${["top", "right", "bottom", "left"][i]}-color`)), "no border (border-width 0 on every side) and no ring (box-shadow 0 0 0 Npx) or outline at offset 0 / -width");
          putStroke();
          break;
        }
        case "borderWidth": {
          const ws = sides((s) => `border-${s}-width`).filter((w): w is number => w !== null);
          const st = drawnStroke();
          put(k, st ? st.width : ws.length ? Math.max(...ws) : null, "no computed border width");
          putStroke();
          break;
        }
        case "display": put(k, cs.getPropertyValue("display").trim() || null, "no computed display"); break;
        case "borderRadius": {
          const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => {
            const v = cs.getPropertyValue(`border-${c}-radius`).trim().split(/\s+/)[0] || "0";
            return v.endsWith("%") ? r2((parseFloat(v) / 100) * Math.min(rect.w, rect.h)) : px(v);
          });
          const [a, b, c, d] = corners;
          if (corners.some((v) => v === null)) put(k, null, "unreadable border radius");
          else put(k, a === b && a === c && a === d ? a : corners, "");
          break;
        }
        case "padding": put(k, sides((s) => `padding-${s}`), ""); break;
        case "gap": {
          const display = cs.getPropertyValue("display");
          const flexish = /flex|grid/.test(display);
          if (!flexish) { put(k, null, `display: ${display} — gap does not apply; spacing comes from margins`); break; }
          const column = /column/.test(cs.getPropertyValue("flex-direction")) && /flex/.test(display);
          const v = cs.getPropertyValue(column ? "row-gap" : "column-gap").trim();
          // `normal` computes to 0 in flex and grid; a percentage gap stays a percentage in the computed style (F-93)
          put(k, v === "normal" ? 0 : v.endsWith("%") ? null : px(v), v.endsWith("%") ? `a percentage gap (${v}) — its px value depends on the container` : "unreadable gap");
          break;
        }
        case "gapVisual": {
          if (!/^(table|thead|tbody|tfoot)$/.test(tag)) { put(k, null, "measured only for a table (row spacing is border-spacing, not gap)"); break; }
          // this table's own rows — a nested table's rows sit inside one of them and read as negative distances (F-93)
          const own = tag === "table" ? el : el.closest("table");
          const rows = Array.from(el.querySelectorAll("tr")).filter((r) => r.closest("table") === own).map((r) => r.getBoundingClientRect()).filter((r) => r.height > 0);
          const gaps: number[] = [];
          for (let i = 1; i < rows.length; i++) { const a = rows[i - 1], b = rows[i]; if (a && b) gaps.push(r2(b.y - (a.y + a.height))); }
          const median = gaps.length ? (gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? null) : null;
          // A negative distance is rows that are not stacked top to bottom (a nested table, rows side by side) —
          // a measuring artefact, not a gap (F-93).
          put(k, median !== null && median < 0 ? null : median, median === null ? "fewer than two rendered rows" : `the rows are not stacked top to bottom (median distance ${median}px) — not a row gap`);
          break;
        }
        case "width": case "height": case "x": case "y": {
          if (item.sharesWith !== null) { put(k, null, `shares the element of data-dt-node="${item.sharesWith}"; wrap the label in a tagged <span> to measure its box`); break; }
          put(k, r2(k === "width" ? rect.w : k === "height" ? rect.h : k === "x" ? rect.x - fr.x : rect.y - fr.y), "");
          break;
        }
        case "opacity": put(k, px(cs.getPropertyValue("opacity")), "no computed opacity"); break;
        case "text": put(k, item.isText && !item.isPlaceholder ? collapse(el.textContent) : null, item.isPlaceholder ? "an input placeholder: see placeholderText" : "not a TEXT node"); break;
        case "tag": put(k, tag, ""); break;
        case "textBox": put(k, textBox, textBoxWhy); break;
        default: put(k, null, `verify-probe does not know how to read '${k}'`);
      }
    }
    // F-69 (D114): the computed text-transform of the text's owner (inherited) — the rendered string is `text` under it.
    // Optional (not a STYLE_KEY): absent when unreadable, never a null to explain.
    if (item.isText && !item.isPlaceholder) { const tt = typoCs.getPropertyValue("text-transform").trim(); if (tt) styles.textTransform = tt; }
    return res;
  });
}

// ---------------------------------------------------------------- owner hover (F-74)
/** Where to hover the owner of a drawn state (`owner`, e.g. the row) so that IT is hovered and the measured element
 *  (`avoid`, a control inside it) is not: the first of the owner's 4 corners (inset 3px), 4 edge midpoints (inset 3px),
 *  centre that lies outside the measured element's box, whose document.elementFromPoint is the owner or inside it, and
 *  that is not over an interactive descendant (a control with its own :hover). Relative to the owner's PADDING box
 *  (Playwright's `position`); viewport points only (call it after scrolling the owner into view). SELF-CONTAINED. */
export function freeHoverPoint(arg: { owner: string; avoid: string }): { x: number; y: number } | null {
  // L2: tabindex="-1" is not a control — ARIA-grid cells carry it (roving focus); hovering one is a free point
  const INTERACTIVE = "a, button, input, select, textarea, [role=button], [role=link], [role=checkbox], [tabindex]:not([tabindex='-1'])";
  const owner = document.querySelector(arg.owner);
  if (!owner) return null;
  const avoidEl = document.querySelector(arg.avoid);
  const o = owner.getBoundingClientRect();
  const a = avoidEl ? avoidEl.getBoundingClientRect() : null;
  const l = o.x + 3, r = o.x + o.width - 3, t = o.y + 3, b = o.y + o.height - 3, cx = o.x + o.width / 2, cy = o.y + o.height / 2;
  const points: Array<[number, number]> = [[l, t], [r, t], [l, b], [r, b], [cx, t], [r, cy], [cx, b], [l, cy], [cx, cy]];
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || r < l || b < t) continue;
    if (a && a.width > 0 && a.height > 0 && x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !owner.contains(hit) || (avoidEl && avoidEl.contains(hit))) continue;
    const ctl = hit.closest(INTERACTIVE);
    if (ctl && ctl !== owner && owner.contains(ctl)) continue;
    return { x: Math.round((x - o.x - owner.clientLeft) * 100) / 100, y: Math.round((y - o.y - owner.clientTop) * 100) / 100 };
  }
  return null;
}

// ---------------------------------------------------------------- focus (D16)
/** Where focus can land for the element at `path`: itself or its closest focusable ancestor (path), or null.
 *  SELF-CONTAINED — see the file header. */
export function focusablePath(path: string): string | null {
  const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";
  const el = document.querySelector(path);
  const f = el ? el.closest(FOCUSABLE) : null;
  if (!f) return null;
  const parts: string[] = [];
  let cur: PElement | null = f;
  while (cur && cur !== document.documentElement) {
    const parent: PElement | null = cur.parentElement;
    if (!parent) break;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
    cur = parent;
  }
  parts.unshift("html");
  return parts.join(" > ");
}
/** Whether the element at `path` has focus, and whether it matches :focus-visible. SELF-CONTAINED. */
export function focusInfo(path: string): { focused: boolean; focusVisible: boolean } {
  const el = document.querySelector(path);
  const focused = !!el && document.activeElement === el;
  return { focused, focusVisible: focused && !!el && el.matches(":focus-visible") };
}
