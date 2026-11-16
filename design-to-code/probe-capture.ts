// probe-capture.ts — the page side of the page capture (capture-page.ts): which elements a rendered page shows, as a
// tree, with the few facts the probe's own reader (probe-page.ts measureElements) does not read — layout (display, flex,
// grid tracks, gaps), position, clipping, the media an element draws itself, background images, the text style bits a
// Figma text needs beyond its font, and what a capture cannot write (shadows, gradients, pseudo-element content,
// transforms, filters). Every visual value (fonts, colours, borders and rings, radius, padding, box, opacity, text) is
// measureElements', run on the paths this walker returns.
//
// page.evaluate serialises a function with Function.prototype.toString() and runs the TEXT in the page, so walkCapture is
// SELF-CONTAINED (see probe-page.ts's header): nothing outside its own body but the page's globals and the probe's page
// runtime, window.__dt (page-runtime.ts, installed by the init script). The DOM is typed by page-dom.ts (types only).
// test/capture-page.test.ts runs it in a real chromium against a fixture page.

import type { PageDocument, PageElement, PageNode, PageRect, PageStyle, PageWindow } from "./page-dom.ts";

declare const document: PageDocument;
declare const window: PageWindow;
declare const scrollX: number;
declare const scrollY: number;
declare function getComputedStyle(el: PageElement, pseudo?: string | null): PageStyle;

/** Page coordinates (viewport rect + scroll). */
export interface WalkRect { x: number; y: number; w: number; h: number }
/** A run of text beside an element's box children (an anonymous box's text): its shown text, its Range box, its lines. */
export interface WalkRun { kind: "run"; text: string; rect: WalkRect; lines: number }
/** What an element draws itself rather than through its children: a picture, an inline SVG, a canvas, a video, a
 *  frame, or a form control that paints its own state (a checkbox, a slider). */
export type WalkMedia = "img" | "svg" | "canvas" | "video" | "iframe" | "control";
export interface WalkEl {
  kind: "el";
  path: string;
  tag: string;
  /** a generic layer name: the tag, its id, or an image's alt text */
  name: string;
  rect: WalkRect;
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
  /** the resolved grid tracks, px (empty unless display grid) */
  gridColumns: number[];
  gridRows: number[];
  /** an item placed by grid-column / grid-row (a span or a line), which a wrapping row cannot show */
  gridPlaced: boolean;
  /** px; null when not a length (a percentage) */
  rowGap: number | null;
  columnGap: number | null;
  /** overflow hidden / clip / auto / scroll on either axis */
  clip: boolean;
  objectFit: string;
  /** the url() layers of background-image, in order */
  backgroundImages: string[];
  backgroundSize: string;
  backgroundRepeat: string;
  fontStyle: string;
  textAlign: string;
  textDecoration: string;
  direction: string;
  /** an element whose content is text and inline elements only: its text's Range box and lines; `mixed` when an inline
   *  child is styled differently (bold, a colour, a size) — the capture flattens it to the element's own font. `drawn`:
   *  its characters when part of its content is not drawn (an inline child at visibility hidden, opacity 0 or display
   *  none) — the measured `text` (the verify runtime's shownText) counts that content; absent, the measured text is it */
  text: { rect: WalkRect; lines: number; mixed: boolean; drawn?: string } | null;
  /** a text field, a textarea or a select: the string it shows (its value, or its placeholder) */
  control: { text: string; placeholder: boolean } | null;
  media: WalkMedia | null;
  /** an image's source (currentSrc), a video's poster */
  src: string | null;
  /** what the capture cannot write on this element (a shadow, a gradient, ::before/::after content, a transform, a filter,
   *  the paint of an inline child flattened into the text) */
  dropped: string[];
  /** the code component this element renders, when the component map names it (WalkInput.components): its name as it
   *  matched ("Export" or "module#Export"), its props as rendered (strings, numbers, booleans; a string `children`), and
   *  its rendered text. Nothing inside it is walked: it lands as an instance. */
  component?: { name: string; props: Record<string, string | number | boolean>; text: string };
  /** the code component the element renders when the map names none of its candidates (the outermost one) */
  codeName?: string;
  children: Array<WalkEl | WalkRun>;
}
export interface WalkInput {
  /** a CSS selector for the part to capture; null for the whole document */
  root: string | null;
  /** the most elements walked; past it the walk stops and says how many it saw */
  maxElements: number;
  /** read each element's code component (its `data-component`, else a React dev build's fibers); absent: not read */
  identity?: boolean;
  /** the code components the component map names ("Export", "module#Export"): an element that renders one is not walked */
  components?: string[];
}
export interface WalkOutput {
  root: WalkEl | null;
  /** why there is no root (the selector matched nothing visible) */
  missing?: string;
  /** the document's scroll size */
  doc: { w: number; h: number };
  /** the elements walked (beyond maxElements they are counted, not kept) */
  elements: number;
  /** counts of what was left out, and why */
  skipped: Record<string, number>;
  /** the paths of <html> and <body> (their backgrounds paint the page) */
  htmlPath: string;
  bodyPath: string | null;
}

/** In the page: the visible element tree under the root. SELF-CONTAINED — see the file header. */
export function walkCapture(input: WalkInput): WalkOutput {
  const dt = window.__dt;
  const pathOf = dt.paths();
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const pageRect = (r: PageRect): WalkRect => ({ x: r2(r.x + scrollX), y: r2(r.y + scrollY), w: r2(r.width), h: r2(r.height) });
  const pxOrNull = (v: string): number | null => {
    const t = v.trim();
    if (t === "normal" || t === "") return 0;
    if (!/^-?[\d.]+px$/.test(t)) return null;
    return r2(parseFloat(t));
  };
  const skipped: Record<string, number> = {};
  const skip = (why: string): void => { skipped[why] = (skipped[why] || 0) + 1; };
  let count = 0;
  const NO_BOX = /^(script|style|template|head|meta|link|title|noscript|base)$/;
  const REPLACED = /^(img|svg|video|canvas|iframe|embed|object|input|select|textarea|button|picture|audio|math)$/;
  const TEXT_FIELD = /^(text|search|email|url|tel|number|password)$/;

  // an element that flows as text: display inline, not replaced, and only inline content below it
  const inlineMemo = new Map<PageElement, boolean>();
  const isInline = (e: PageElement): boolean => {
    const known = inlineMemo.get(e);
    if (known !== undefined) return known;
    const tag = e.tagName.toLowerCase();
    let ok = tag === "br" || tag === "wbr";
    if (!ok && !REPLACED.test(tag) && !NO_BOX.test(tag)) {
      const d = getComputedStyle(e).getPropertyValue("display").trim();
      ok = (d === "inline" || d === "contents") && Array.from(e.children).every((c) => isInline(c));
    }
    inlineMemo.set(e, ok);
    return ok;
  };
  const linesOf = (rects: ArrayLike<PageRect>): number => {
    const tops: number[] = [];
    for (const r of Array.from(rects)) {
      if (!(r.width > 0 && r.height > 0)) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < Math.max(2, r.height / 2))) tops.push(r.top);
    }
    return Math.max(1, tops.length);
  };
  // a Range over `first` … `last` (nodes of one parent): its box and its lines
  const rangeBox = (first: PageNode, last: PageNode): { rect: WalkRect; lines: number } | null => {
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const r = range.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { rect: pageRect(r), lines: linesOf(range.getClientRects()) };
  };
  const collapse = (s: string): string => s.replace(/\s+/g, " ");
  // Text as the page DRAWS it: no space is added at an inline element's edges (<span>$</span><span>100</span> reads "$100");
  // an inline element at display none or opacity 0 draws nothing inside it; visibility hidden hides its own characters, but
  // a descendant that says visibility: visible shows (`shown` is the visibility a text node inherits); a <br> is `br`.
  const visible = (s: PageStyle): boolean => { const v = s.getPropertyValue("visibility").trim(); return v !== "hidden" && v !== "collapse"; };
  const drawnChars = (n: PageNode, shown: boolean, br: string): string => {
    if (n.nodeType === 3) return shown ? n.nodeValue || "" : "";
    if (n.nodeType !== 1) return "";
    const el = n as PageElement;
    const s = getComputedStyle(el);
    if (s.getPropertyValue("display").trim() === "none" || parseFloat(s.getPropertyValue("opacity")) === 0) return "";
    const own = visible(s);
    if (el.tagName.toLowerCase() === "br") return own ? br : "";
    return Array.from(el.childNodes).map((c) => drawnChars(c, own, br)).join("");
  };
  // whether an element's inline content holds something it does not draw (then its text is drawnChars, not shownText)
  const hidesSome = (e: PageElement): boolean => Array.from(e.querySelectorAll("*")).some((c) => {
    const s = getComputedStyle(c);
    return s.getPropertyValue("display").trim() === "none" || parseFloat(s.getPropertyValue("opacity")) === 0 || !visible(s);
  });
  // an inline-only element's drawn text, its <br>s as line breaks (a private-use mark survives the whitespace collapse)
  const drawnText = (e: PageElement): string => collapse(drawnChars(e, true, "")).replace(/ ? ?/g, "\n").trim();
  const transparent = (c: string): boolean => c === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(c);
  // a box-shadow that draws something: an entry whose colour is not transparent (Tailwind computes unused ones as
  // `rgba(0, 0, 0, 0) 0px 0px 0px 0px`); whether it is a ring the measurement says (strokeFrom "box-shadow")
  const drawsShadow = (v: string): boolean => {
    const t = v.trim();
    if (!t || t === "none") return false;
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (const ch of t) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    return parts.some((p) => !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(p) && !/transparent/.test(p));
  };
  const pseudoContent = (e: PageElement, which: string): boolean => {
    const c = getComputedStyle(e, which).getPropertyValue("content").trim();
    return c !== "" && c !== "none" && c !== "normal";
  };
  const urlsOf = (v: string): string[] => {
    const out: string[] = [];
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
    for (let m = re.exec(v); m; m = re.exec(v)) out.push(m[1] || m[2] || m[3] || "");
    return out.filter((u) => u !== "");
  };
  const tracks = (v: string): number[] => {
    const t = v.replace(/\[[^\]]*\]/g, " ").trim();
    if (!t || t === "none") return [];
    return t.split(/\s+/).map((x) => (/^-?[\d.]+px$/.test(x) ? r2(parseFloat(x)) : NaN)).filter((n) => Number.isFinite(n));
  };
  const FONT_PROPS = ["font-weight", "font-style", "font-size", "font-family", "color", "text-decoration-line"];
  const mixedIn = (e: PageElement): boolean => {
    const own = getComputedStyle(e);
    const base = FONT_PROPS.map((p) => own.getPropertyValue(p)).join("|");
    const all = Array.from(e.querySelectorAll("*"));
    return all.some((c) => FONT_PROPS.map((p) => getComputedStyle(c).getPropertyValue(p)).join("|") !== base);
  };
  const paintsInline = (e: PageElement): boolean => Array.from(e.querySelectorAll("*")).some((c) => {
    const s = getComputedStyle(c);
    const bg = s.getPropertyValue("background-color").trim();
    return (bg !== "" && !transparent(bg)) || s.getPropertyValue("border-top-style").trim() !== "none" && parseFloat(s.getPropertyValue("border-top-width")) > 0;
  });

  // An element's code component (WalkEl.component): `data-component` ("Export" or "module#Export") with `data-props` (a
  // JSON object), else a React dev build's fibers — the composite components (function, class, forwardRef, memo) whose
  // first host node is this element, outermost first; the first the map names wins, else the outermost is `codeName`.
  const known = new Set(input.components || []);
  const getK = (o: unknown, k: string): unknown => ((typeof o === "object" && o !== null) || typeof o === "function" ? Reflect.get(o, k) : undefined);
  const nameOf = (t: unknown, depth: number): string | null => {
    if (depth > 4 || !t || (typeof t !== "object" && typeof t !== "function")) return null;
    const d = getK(t, "displayName");
    if (typeof d === "string" && d) return d;
    if (typeof t === "function") { const n = getK(t, "name"); return typeof n === "string" && n ? n : null; }
    return nameOf(getK(t, "render"), depth + 1) || nameOf(getK(t, "type"), depth + 1);
  };
  // the string, number and boolean entries (a `children` that is a string included; elements, functions, objects not)
  const plainProps = (o: unknown): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    if (!o || typeof o !== "object" || Array.isArray(o)) return out;
    for (const k of Object.keys(o)) {
      const v = getK(o, k);
      if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") out[k] = v;
    }
    return out;
  };
  const identityOf = (e: PageElement): { hit: { name: string; props: Record<string, string | number | boolean> } | null; codeName: string | null } => {
    const dc = (e.getAttribute("data-component") || "").trim();
    if (dc) {
      let props: Record<string, string | number | boolean> = {};
      const raw = e.getAttribute("data-props");
      if (raw) { try { const parsed: unknown = JSON.parse(raw); props = plainProps(parsed); } catch { props = {}; } }
      return known.has(dc) ? { hit: { name: dc, props }, codeName: null } : { hit: null, codeName: dc };
    }
    const fk = Object.keys(e).find((k) => k.indexOf("__reactFiber$") === 0);
    if (!fk) return { hit: null, codeName: null };
    const composites: unknown[] = [];
    let cur: unknown = getK(e, fk);
    // up from the element's own fiber while each step is its parent's first child: host component, root, text, singleton end it
    for (let p = getK(cur, "return"), n = 0; p && getK(p, "child") === cur && n < 50; cur = p, p = getK(p, "return"), n++) {
      const tag = getK(p, "tag");
      if (tag === 3 || tag === 5 || tag === 6 || tag === 26 || tag === 27) break;
      if (tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15) composites.push(p);
    }
    let outer: string | null = null;
    for (const f of composites.reverse()) {
      const name = nameOf(getK(f, "type"), 0);
      if (!name) continue;
      if (outer === null) outer = name;
      if (known.has(name)) return { hit: { name, props: plainProps(getK(f, "memoizedProps")) }, codeName: null };
    }
    return { hit: null, codeName: outer };
  };
  // the element's rendered text, for a `children` string prop the code did not pass as a string
  const childrenText = (e: PageElement): string => collapse(dt.shownText(e)).trim();

  const rootEl = input.root ? document.querySelector(input.root) : document.body;
  const htmlPath = pathOf(document.documentElement);
  const bodyPath = document.body ? pathOf(document.body) : null;
  const de = document.documentElement;
  const doc = { w: r2(Math.max(de.scrollWidth, de.clientWidth)), h: r2(Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight)) };
  if (!rootEl) return { root: null, missing: input.root ? "no element matches " + input.root : "the document has no <body>", doc, elements: 0, skipped, htmlPath, bodyPath };
  if (input.root && !dt.visible(rootEl, { sized: true })) return { root: null, missing: input.root + " matches an element that is not visible (no box, display none, or visibility hidden)", doc, elements: 0, skipped, htmlPath, bodyPath };
  const rootBox: WalkRect = input.root ? pageRect(rootEl.getBoundingClientRect()) : { x: 0, y: 0, w: doc.w, h: doc.h };

  const element = (e: PageElement, cs: PageStyle): WalkEl => {
    const tag = e.tagName.toLowerCase();
    const get = (p: string): string => cs.getPropertyValue(p).trim();
    const display = get("display");
    const ov = get("overflow-x") + " " + get("overflow-y");
    let media: WalkMedia | null = null;
    if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video" || tag === "iframe") media = tag;
    else if (tag === "embed" || tag === "object") media = "iframe";
    else if (tag === "input" && !TEXT_FIELD.test((e.type || "text").toLowerCase()) && !/^(button|submit|reset)$/.test((e.type || "").toLowerCase())) media = "control";
    let control: WalkEl["control"] = null;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const c = dt.controlText(e);
      if (c !== null && "text" in c && c.text.trim()) control = { text: c.text, placeholder: false };
      else if (e.getAttribute("placeholder")) control = { text: e.getAttribute("placeholder") || "", placeholder: true };
    }
    const dropped: string[] = [];
    if (drawsShadow(get("box-shadow"))) dropped.push("shadow");
    const bgImage = get("background-image");
    if (/gradient\(/.test(bgImage)) dropped.push("gradient");
    if (!media && (pseudoContent(e, "::before") || pseudoContent(e, "::after"))) dropped.push("pseudo-element");
    if (get("transform") !== "none" && get("transform") !== "") dropped.push("transform");
    if ((get("filter") !== "none" && get("filter") !== "") || (get("backdrop-filter") !== "none" && get("backdrop-filter") !== "")) dropped.push("filter");
    const z = parseInt(get("z-index"), 10);
    const alt = tag === "img" ? (e.getAttribute("alt") || "").trim() : "";
    return {
      kind: "el", path: pathOf(e), tag,
      name: alt ? alt.slice(0, 60) : e.id ? tag + "#" + e.id.slice(0, 40) : tag,
      rect: pageRect(e.getBoundingClientRect()),
      display, position: get("position"), zIndex: Number.isFinite(z) ? z : 0,
      flexDirection: get("flex-direction"), flexWrap: get("flex-wrap"), justifyContent: get("justify-content"), alignItems: get("align-items"),
      alignSelf: get("align-self"), flexGrow: parseFloat(get("flex-grow")) || 0, order: parseInt(get("order"), 10) || 0,
      gridColumns: /grid/.test(display) ? tracks(get("grid-template-columns")) : [],
      gridRows: /grid/.test(display) ? tracks(get("grid-template-rows")) : [],
      gridPlaced: !/^auto( \/ auto)?$/.test(get("grid-column")) || !/^auto( \/ auto)?$/.test(get("grid-row")),
      rowGap: pxOrNull(get("row-gap")), columnGap: pxOrNull(get("column-gap")),
      clip: /hidden|clip|auto|scroll/.test(ov) && tag !== "html" && tag !== "body",
      objectFit: get("object-fit"), backgroundImages: urlsOf(bgImage), backgroundSize: get("background-size"), backgroundRepeat: get("background-repeat"),
      fontStyle: get("font-style"), textAlign: get("text-align"), textDecoration: get("text-decoration-line"), direction: get("direction"),
      text: null, control, media,
      src: tag === "img" ? (e.currentSrc || e.src || null) : tag === "video" ? e.getAttribute("poster") : null,
      dropped, children: [],
    };
  };

  /** The element (or, for display: contents and a zero-size box, its children) as nodes of its parent. */
  const visit = (e: PageElement, into: Array<WalkEl | WalkRun>): void => {
    const tag = e.tagName.toLowerCase();
    if (NO_BOX.test(tag)) return;
    const cs = getComputedStyle(e);
    const display = cs.getPropertyValue("display").trim();
    if (display === "none") { skip("display none"); return; }
    if (display === "contents") { kids(e, into); return; }
    if (e.getClientRects().length === 0) { skip("no box"); return; }
    const vis = cs.getPropertyValue("visibility").trim();
    if (vis === "hidden" || vis === "collapse") { skip("visibility hidden"); return; }
    if (parseFloat(cs.getPropertyValue("opacity")) === 0) { skip("opacity 0"); return; }
    const r = pageRect(e.getBoundingClientRect());
    if (r.x >= rootBox.x + rootBox.w || r.y >= rootBox.y + rootBox.h || r.x + r.w <= rootBox.x || r.y + r.h <= rootBox.y) {
      // a zero-size box can still hold children that show (absolutely placed); anything else this far out does not show
      if (r.w > 0 && r.h > 0) { skip("outside the captured area"); return; }
    }
    count++;
    if (count > input.maxElements) return;
    const el = element(e, cs);
    if (input.identity) {
      const id = identityOf(e);
      if (id.hit) el.component = { name: id.hit.name, props: id.hit.props, text: childrenText(e) };
      else if (id.codeName) el.codeName = id.codeName;
    }
    if (!el.media && !el.component) {
      // inline-only content with text: the element is a text
      const nodes = Array.from(e.childNodes);
      const inlineOnly = Array.from(e.children).every(isInline);
      const drawn = !el.control && inlineOnly && hidesSome(e) ? drawnText(e) : null;
      const shown = el.control ? "" : drawn ?? dt.shownText(e);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!el.control && shown && first && last && inlineOnly) {
        const box = rangeBox(first, last);
        if (box) {
          el.text = { rect: box.rect, lines: box.lines, mixed: e.children.length > 0 && mixedIn(e), ...(drawn !== null ? { drawn } : {}) };
          if (e.children.length && paintsInline(e)) el.dropped.push("inline-paint");
        }
      } else if (!el.control) kids(e, el.children);
    }
    if (!(r.w > 0.5 && r.h > 0.5) && !el.children.length && !el.text) { skip("zero size"); count--; return; }
    into.push(el);
  };
  /** An element's children: element boxes, and each run of text and inline elements between them as one text. */
  const kids = (e: PageElement, into: Array<WalkEl | WalkRun>): void => {
    let run: PageNode[] = [];
    const flush = (): void => {
      if (!run.length) return;
      // the run's characters as the page has them (drawnChars); a <br> breaks the line, which the one-line run shows as a space
      const runShown = visible(getComputedStyle(e));
      const text = collapse(run.map((n) => drawnChars(n, runShown, " ")).join("")).trim();
      const first = run[0], last = run[run.length - 1];
      run = [];
      if (!text || !first || !last) return;
      const box = rangeBox(first, last);
      if (!box) return;
      count++;
      if (count > input.maxElements) return;
      into.push({ kind: "run", text, rect: box.rect, lines: box.lines });
    };
    // an open shadow root's elements show in place of the host's light children (a <slot> shows what is assigned to it)
    const sr = e.shadowRoot;
    if (sr) {
      for (const c of Array.from(sr.children)) visit(c, into);
      return;
    }
    if (e.tagName.toLowerCase() === "slot" && e.assignedElements) {
      const assigned = e.assignedElements();
      if (assigned.length) { for (const c of assigned) visit(c, into); return; }
    }
    let k = 0; // e.children lists the element nodes of e.childNodes, in the same order
    for (const n of Array.from(e.childNodes)) {
      if (n.nodeType === 3) { if ((n.nodeValue || "").trim() || run.length) run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      const c = e.children[k++];
      if (!c) continue;
      if (isInline(c)) { if (c.tagName.toLowerCase() !== "br" || run.length) run.push(c); continue; }
      flush();
      visit(c, into);
    }
    flush();
  };

  const rootCs = getComputedStyle(rootEl);
  count++;
  const root = element(rootEl, rootCs);
  if (!input.root) { root.rect = rootBox; root.clip = true; }
  kids(rootEl, root.children);
  return { root, doc, elements: count, skipped, htmlPath, bodyPath };
}

/** In the page: make every lazy image load now (the capture takes the whole height, not the first screen), and say how
 *  many images are still loading. SELF-CONTAINED. */
export function eagerImages(): number {
  let loading = 0;
  for (const img of Array.from(document.querySelectorAll("img"))) {
    if (img.getAttribute("loading") === "lazy") img.setAttribute("loading", "eager");
    if (img.complete === false) loading++;
  }
  return loading;
}

/** In the page: for a screenshot of an element's own paint, hide (true) its descendants and its own text, or put back
 *  (false) the style attribute of every element it changed, exactly as it was (none: removed again). The text goes by
 *  its glyphs' paint (color, fill, stroke, decoration, shadow transparent), with the colours that follow currentColor
 *  (borders, outline, background, box-shadow) pinned first to what they computed, so the element's own paint is the
 *  same picture without its text. SELF-CONTAINED. */
export function hideChildren(arg: { path: string; hide: boolean }): boolean {
  const el = window.__dt.find(arg.path);
  if (!el) return false;
  const kept = window.__dtHidden || (window.__dtHidden = new WeakMap());
  if (!arg.hide) {
    for (const [e, style] of kept.get(el) || []) {
      // set first, then removed: Chromium writes a changed inline style back to the attribute lazily, so a bare remove
      // after el.style changes comes back as style=""
      e.setAttribute("style", style === null ? "" : style);
      if (style === null) e.removeAttribute("style");
    }
    kept.delete(el);
    return true;
  }
  if (kept.has(el)) return true;
  const saved: Array<[PageElement, string | null]> = [];
  // registered before anything changes: a throw part way still leaves an undo list for what was set
  kept.set(el, saved);
  const set = (e: PageElement, prop: string, value: string): void => {
    if (!saved.some(([s]) => s === e)) saved.push([e, e.getAttribute("style")]);
    e.style.setProperty(prop, value, "important");
  };
  const cs = getComputedStyle(el);
  for (const prop of ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "background-color", "box-shadow"]) set(el, prop, cs.getPropertyValue(prop));
  for (const prop of ["color", "-webkit-text-fill-color", "-webkit-text-stroke-color", "text-decoration-color", "text-emphasis-color"]) set(el, prop, "transparent");
  set(el, "text-shadow", "none");
  // every descendant, not only the children: one that says visibility: visible itself would show through a hidden parent;
  // and inside every open shadow root on the way (querySelectorAll stops at one), whose elements the walk captures too
  const hideAll = (p: { children: ArrayLike<PageElement> }): void => {
    for (const c of Array.from(p.children)) {
      set(c, "visibility", "hidden");
      hideAll(c);
      if (c.shadowRoot) hideAll(c.shadowRoot);
    }
  };
  hideAll(el);
  if (el.shadowRoot) hideAll(el.shadowRoot);
  return true;
}
