// page-runtime.ts — the probe's one page-side runtime: the DOM readers every page-side function shares, installed in each
// document as `window.__dt` before any page script runs.
//
// Why: page.evaluate serialises a function with Function.prototype.toString() and runs the TEXT in the page, so a page-side
// function (probe-page.ts, probe-drive.ts, probe-behaviour.ts) can reach no module helper. Each one used to carry its own copy
// of the readers it needed — an element's path, a form control's shown text, the text a page shows, visibility, a short
// description — and the copies drifted (the measure pass named an element inside an open shadow root by its light-DOM
// position, the behaviour pass through the shadow root). Here each reader exists once. installPageRuntime is serialised the
// same way and runs from the probe's init script (verify-probe.ts INIT_SCRIPT, on every navigation of every probe page), so
// a page-side function may reference exactly one thing outside its own body: `window.__dt` (the PageRuntime of page-dom.ts).
//
// installPageRuntime itself is SELF-CONTAINED (every helper nested, nothing outside it but the page's globals) — a stray
// outer reference is a ReferenceError in the page, which the e2e suites (they run the BUILT bundle in a real browser) catch.
// test/verify-probe.test.ts runs it on a fake DOM.

import type { PageDocument, PageElement, PageNode, PageBox, PageRuntime, PageStyle, PageWindow, PageVisibleOpts } from "./page-dom.ts";

// ---------------------------------------------------------------- the page, as far as the runtime uses it (page-dom.ts)
declare const document: PageDocument;
declare const window: PageWindow;
declare const scrollX: number;
declare const scrollY: number;
declare const innerWidth: number;
declare const innerHeight: number;
declare function getComputedStyle(el: PageElement, pseudo?: string | null): PageStyle;

/** In the page: define `window.__dt`. SELF-CONTAINED — see the file header. */
export function installPageRuntime(): void {
  // ---- the flat tree
  /** an element's parent in the flat tree: the slot it is shown in, its parent element, or its shadow root's host */
  const parent = (n: PageElement): PageElement | null => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);

  // ---- element paths
  // An nth-child CSS path from <html>: " > " between a parent and its child in one tree; " " between a shadow host and a
  // top-level element of its open shadow root (Playwright's css engine pierces open shadow roots, so page.locator resolves
  // it; find() below resolves it exactly). An element with no parent and no host — <html>, or one not in the document — is
  // "html". paths() keeps each path and each parent's child index for the rest of one synchronous call (nothing changes the
  // DOM while it runs): built from scratch per element, one long list's children were re-scanned once per element (about 4.6 of
  // 11 s at 25,000 elements with a 1,800-child list).
  const paths = (): ((el: PageElement) => string) => {
    const memo = new Map<PageElement, string>();
    const childIndex = new Map<object, Map<PageElement, number>>();
    const indexIn = (owner: object, list: ArrayLike<PageElement>, el: PageElement): number => {
      let idx = childIndex.get(owner);
      if (!idx) {
        const m = new Map<PageElement, number>();
        Array.from(list).forEach((c, i) => m.set(c, i + 1));
        childIndex.set(owner, m);
        idx = m;
      }
      return idx.get(el) ?? 0;
    };
    return (el: PageElement): string => {
      // up to the nearest element whose path is known (or the top), then down again keeping each path (a loop: no depth limit)
      const up: PageElement[] = [];
      let cur: PageElement = el;
      let base: string | undefined = memo.get(cur);
      while (base === undefined) {
        const host = cur.parentElement ? null : cur.getRootNode?.()?.host ?? null;
        if (cur === document.documentElement || (!cur.parentElement && !host)) { base = "html"; memo.set(cur, base); break; }
        up.push(cur);
        cur = cur.parentElement ?? host ?? cur;
        base = memo.get(cur);
      }
      for (let i = up.length - 1; i >= 0; i--) {
        const e = up[i];
        if (!e) break;
        const p = e.parentElement;
        const root = p ? null : e.getRootNode?.() ?? null;
        if (p) base = `${base} > ${e.tagName.toLowerCase()}:nth-child(${indexIn(p, p.children, e)})`;
        else if (root && root.children) base = `${base} ${e.tagName.toLowerCase()}:nth-child(${indexIn(root, root.children, e)})`;
        else break;
        memo.set(e, base);
      }
      return base;
    };
  };
  /** the element a path() names, or null when it is gone; any other selector goes to document.querySelector */
  const find = (path: string): PageElement | null => {
    const steps = /^html((?: > | )[^\s>]+:nth-child\(\d+\))*$/.test(path) ? Array.from(path.slice(4).matchAll(/( > | )([^\s>]+):nth-child\((\d+)\)/g)) : null;
    if (steps === null) { try { return document.querySelector(path); } catch { return null; } }
    let cur: PageElement | null = document.documentElement;
    for (const [, sep, tag, n] of steps) {
      if (!cur) return null;
      const list: ArrayLike<PageElement> | undefined = sep === " > " ? cur.children : cur.shadowRoot?.children;
      const next: PageElement | undefined = list ? list[Number(n) - 1] : undefined;
      cur = next && next.tagName.toLowerCase() === tag ? next : null;
    }
    return cur;
  };

  // ---- text
  // A form control shows its VALUE, not its children (HTML: an <input> has none; a <textarea>'s child text is its default
  // value, stale once typed in; a <select>'s is every option's). The shown string; a reason when the control's value is not
  // the string shown (a password, a date, a list box); null for any other element.
  const controlText = (e: PageElement): { text: string } | { why: string } | null => {
    const tag = e.tagName.toLowerCase();
    if (tag === "textarea") return { text: e.value ?? "" };
    if (tag === "select") {
      if (e.multiple || (e.size ?? 0) > 1) return { why: "a list-box <select> (multiple, or size > 1) shows every option, not one string" };
      const o = e.selectedOptions?.[0];
      // (HTMLOptionElement.label: its label attribute — what a collapsed <select> shows — else its text)
      return { text: o ? (o.label ?? o.text ?? o.textContent ?? "") : "" };
    }
    if (tag !== "input") return null;
    const type = (e.type || "text").toLowerCase();
    if (/^(text|search|email|url|tel|number)$/.test(type)) return { text: e.value ?? "" };
    if (/^(button|submit|reset)$/.test(type) && e.value) return { text: e.value };
    return { why: `an <input type="${type}"> draws its own text \u2014 its value is not the string shown` };
  };
  /** its OWN direct text nodes, joined as written (not its descendants') */
  const ownText = (el: PageElement): string => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("");
  // Does the element keep a newline in its text as a line break (white-space-collapse preserve / preserve-breaks /
  // break-spaces, i.e. white-space pre, pre-wrap, pre-line, break-spaces)?
  const keepsBreaks = (e: PageElement): boolean => {
    const s = getComputedStyle(e);
    const c = s.getPropertyValue("white-space-collapse").trim();
    if (c) return c === "preserve" || c === "preserve-breaks" || c === "break-spaces";
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(s.getPropertyValue("white-space").trim());
  };
  // The text the page shows for an element: textContent with each run of spaces, tabs and line breaks read as one space (HTML
  // collapses them — MDN white-space), a form control inside read as what it shows (its value, its selected option — never
  // its children: every option, a stale default; a list box, its options). With `lines` a line break the page shows stays
  // "\n": a <br>, or a newline under a white-space that keeps it (spaces beside a kept break are dropped, as pre-line renders
  // them; a non-breaking space is kept as written). Without, every break is a space and every run of white space one space —
  // the form a text is FOUND by, and no computed style is read (a child holding no <br> or control is read by its
  // textContent).
  const shownText = (root: PageElement, lines = true): string => {
    let out = "";
    const walk = (e: PageElement): void => {
      let keep: boolean | null = null;
      let k = 0; // e.children lists the element nodes of e.childNodes, in the same order
      for (const n of Array.from(e.childNodes)) {
        if (n.nodeType === 3) {
          const v = n.nodeValue || "";
          if (!/[\n\r]/.test(v)) { out += v; continue; }
          if (lines) keep ??= keepsBreaks(e);
          out += keep ? v.replace(/\r\n?/g, "\n") : v.replace(/[\n\r]/g, " ");
        } else if (n.nodeType === 1) {
          const c = e.children[k++];
          if (!c) continue;
          if (c.tagName.toLowerCase() === "br") out += lines ? "\n" : " ";
          else if (c.tagName === "SELECT" || c.tagName === "TEXTAREA") {
            const t = controlText(c);
            if (t === null || !("text" in t)) walk(c);
            else out += ` ${t.text} `;
          } else if (!lines && c.querySelectorAll("br, select, textarea").length === 0) out += c.textContent || "";
          else walk(c);
        }
      }
    };
    walk(root);
    return lines ? out.replace(/[ \t\f]*\n[ \t\f]*/g, "\n").replace(/[ \t\f]+/g, " ").trim() : out.replace(/\s+/g, " ").trim();
  };

  // ---- what shows
  /** it has a layout box, (`sized`) a non-zero size, and checkVisibility with visibility (and with `opacity`, opacity) passes */
  const visible = (el: PageElement, o: PageVisibleOpts = {}): boolean => {
    if (el.getClientRects().length === 0) return false;
    if (o.sized) { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; }
    const op = !!o.opacity;
    return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: op, checkOpacity: op });
  };
  /** the layout viewport — without the scrollbars (documentElement.clientWidth/Height), never more than the window (in quirks
   *  mode documentElement.clientHeight is the PAGE's height): what Playwright clips its click point to */
  const viewport = (): { w: number; h: number } => {
    const de = document.documentElement;
    return { w: Math.min(de.clientWidth || innerWidth, innerWidth), h: Math.min(de.clientHeight || innerHeight, innerHeight) };
  };
  /** Playwright's click point (its _clickablePoint): the middle of the element's FIRST client rect whose part inside the layout
   *  viewport has an area (> 0.99 px²), clipped to it — onScreen false (the box's centre) when none has; null when the element
   *  has no size. (Playwright uses the true transformed quad; for a rotated or skewed element partly off screen this
   *  axis-aligned rect's centre can differ slightly.) */
  const clickPoint = (el: PageElement): { x: number; y: number; onScreen: boolean } | null => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const { w: vw, h: vh } = viewport();
    for (const q of Array.from(el.getClientRects())) {
      const x0 = Math.min(Math.max(q.x, 0), vw), x1 = Math.min(Math.max(q.right, 0), vw);
      const y0 = Math.min(Math.max(q.y, 0), vh), y1 = Math.min(Math.max(q.bottom, 0), vh);
      if ((x1 - x0) * (y1 - y0) > 0.99) return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, onScreen: true };
    }
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, onScreen: false };
  };
  /** the deep active element — through open shadow roots (an iframe is one: focus inside it leaves the iframe active) */
  const active = (): PageElement | null => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  /** the attribute selector for a data-dt-node id */
  const tagSel = (id: string): string => `[data-dt-node="${id.replace(/["\\]/g, "\\$&")}"]`;
  /** the elements tagged with an id outside a closed <dialog> — several: those with a layout box */
  const tagged = (id: string): PageElement[] => {
    const els = Array.from(document.querySelectorAll(tagSel(id))).filter((e) => e.closest("dialog:not([open])") === null);
    return els.length > 1 ? els.filter((e) => e.getClientRects().length > 0) : els;
  };

  // ---- describing an element in evidence
  // `<tag k="v" …>`: each attribute of `keys` it carries with a value (a boolean one — readonly, disabled — bare when
  // present); `name`: then its aria-label, else its text (white space collapsed, ≤ 30), quoted, when it has one. null: "nothing".
  const BARE = new Set(["readonly", "disabled", "hidden", "open", "required"]);
  const describe = (el: PageElement | null, keys: readonly string[] = [], name = false): string => {
    if (!el) return "nothing";
    let s = `<${el.tagName.toLowerCase()}`;
    for (const k of keys) {
      const v = el.getAttribute(k);
      if (v === null) continue;
      if (BARE.has(k)) s += ` ${k}`;
      else if (v !== "") s += ` ${k}="${v}"`;
    }
    s += ">";
    if (!name) return s;
    const label = el.getAttribute("aria-label");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return label ? `${s} "${label}"` : text ? `${s} "${text}"` : s;
  };

  // ---- a container's own content outside its sole control
  // What the container shows of its OWN outside its one control (the drive's clickPointControl and the battery's markOpener
  // both ask), walked through the flat tree (open shadow roots and their slots) with an explicit stack, each ancestor test
  // memoised per element (an 8000-deep DOM is linear work, never a stack overflow). An element is SHOWN when the nearest box at
  // or above it (a display:contents wrapper has none) passes checkVisibility with visibility and content-visibility (hidden, and
  // auto while skipped), it is not visibility:hidden itself, and no OUT-OF-FLOW box (position absolute / fixed) from that box up
  // to the container has opacity 0 — a hover tooltip or popover shows nothing; an in-flow opacity-0 box keeps its place and is
  // about to show (a reveal-on-scroll or staggered entrance: the drive has just scrolled it in), so it counts. The
  // container's own opacity is the opener's visibility, judged before this. An AREA counts after the clipping on the element's
  // containing-block chain up to the container (CSS 2.1 §11.1.1): each box's overflow on that axis — an absolute
  // box skips the static ancestors that make no containing block, a fixed one every ancestor without a transform / translate /
  // rotate / scale / perspective / filter / backdrop-filter / preserve-3d / will-change of those / contain layout|paint|strict|
  // content / content-visibility auto|hidden — and, on every ancestor, a clip-path inset() and an absolute box's clip rect()
  // (another clip-path shape is not read: what it covers counts), overflow:clip on both axes widened by its overflow-clip-margin;
  // what lies past the document's top edge, or its left edge in a left-to-right document (an sr-only label at
  // left:-9999px), is never on screen nor scrolled to — that edge moved out by the scroll of the container and
  // every box above it (an app shell's scroller reaches what lies above its top). SHOWN CONTENT:
  // a non-blank text node whose clipped Range rects cover more than 1 px² (an sr-only label — 1 × 1 px overflow:hidden, clip
  // rect(0,0,0,0), clip-path inset(50%), off the document's start edge — and whitespace show nothing); an img / svg / canvas /
  // video / audio / picture / object / embed / iframe / input / progress / meter with a clipped box over 1 px²; a list
  // item's marker — a list-style type or image, or ::marker content (the container's own too); a ::before / ::after (not display:none, not
  // hidden, not an out-of-flow opacity 0) whose content is not none / normal and that paints — a non-blank string (an icon font's
  // glyph, a generated label), an image, counter or attr(), a background-image or mask-image under any content, "" included (a
  // CSS logo or icon), a background colour under a blank string, or under "" unless its element holds the control or lies over
  // the control's centre — with its element's clipped box over 1 px²; on a DESCENDANT with a clipped box over 1 px²: a
  // background-image (an avatar, a logo), a mask-image (a CSS-mask icon) unless it holds the control, a non-transparent
  // background colour (a swatch, a status dot: other visible content) unless it holds the control or lies over the
  // control's centre (a filled wrapper, a hover tint: the cell's own chrome). The container's own background colour, a border in
  // one colour (a 1-px divider on one side too) and padding are decoration, as is a clearfix's empty content; its own
  // background image (a gradient, a url), border image, border sides in different colours or widths 2 px or more apart (a stripe)
  // are content, and so are its own inset box-shadow offset 2 px or more or blurred, sharp box-shadow rings in
  // more than one colour (its border's included), and its own paint under a mask or a clip-path other than a rounded inset(0).
  // A scroll container's ::scroll-button (focusable, pressed like a button) and a scroll-marker group
  // are a second control: content. A label laid over the container from outside its subtree (see the walk at the end).
  // Not seen: a closed shadow root, the inside of an iframe
  // (the iframe itself counts). Bounded: past 20000 steps (elements walked, ancestor steps of the areas) it
  // answers "content". null = nothing of its own as far as the DOM shows — the caller's pixel check (probe-drive.ts
  // ownPixels) has the last word, content when EITHER says so; else what shows.
  const ownContent = (box: PageElement, ctl: PageElement): string | null => {
    const up = parent;
    const css = (e: PageElement, prop: string, pseudo: string | null = null): string => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
    const set = (e: PageElement, prop: string, pseudo: string | null = null): boolean => { const v = css(e, prop, pseudo); return v !== "" && v !== "none"; };
    // does `test` hold for the element or an ancestor below the container? memoised per element
    const chain = (test: (p: PageElement) => boolean): ((e: PageElement | null) => boolean) => {
      const memo = new Map<PageElement, boolean>();
      return (e: PageElement | null): boolean => {
        const seen: PageElement[] = [];
        let hit = false;
        for (let p = e; p && p !== box; p = up(p)) {
          const m = memo.get(p);
          if (m !== undefined) { hit = m; break; }
          seen.push(p);
          if (test(p)) { hit = true; break; }
        }
        for (const s of seen) memo.set(s, hit);
        return hit;
      };
    };
    // bounded — every element walked and every ancestor step of an area counts; past OWN_WORK_CAP the check answers
    // "content" (the control is not the opener's: the safe side) instead of spending seconds on a huge or deep container
    let work = 0;
    const OWN_WORK_CAP = 20_000;
    const tick = (): boolean => ++work > OWN_WORK_CAP;
    const inCtl = chain((p) => p === ctl);
    const outOfFlow = (e: PageElement, pseudo: string | null = null): boolean => /^(absolute|fixed)$/.test(css(e, "position", pseudo));
    const faded = chain((p) => css(p, "opacity") === "0" && outOfFlow(p));
    const boxed = (e: PageElement): PageElement | null => { let p: PageElement | null = e; while (p && css(p, "display") === "contents") p = up(p); return p; };
    const shown = (e: PageElement): boolean => {
      const b = boxed(e);
      return !!b && b.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !/^(hidden|collapse)$/.test(css(e, "visibility")) && !faded(b);
    };
    // a containing block for fixed (and absolute) descendants
    const holdsFixed = (p: PageElement): boolean => ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => set(p, k))
      || css(p, "transform-style") === "preserve-3d" || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(css(p, "will-change"))
      || /\b(layout|paint|strict|content)\b/.test(css(p, "contain")) || /^(auto|hidden)$/.test(css(p, "content-visibility"));
    const de = document.documentElement;
    const horizontal = !/^(vertical|sideways)/.test(css(de, "writing-mode"));
    // the start edge moves out by the scroll of the container and every box above it — in an app shell (a fixed
    // inset:0 scroller) what lies above the shell's top is reached by scrolling the shell, not the window
    let sx = scrollX, sy = scrollY;
    for (let p: PageElement | null = box; p && p !== de; p = up(p)) { sx += Math.abs(p.scrollLeft || 0); sy += Math.abs(p.scrollTop || 0); }
    const startX = horizontal && css(de, "direction") !== "rtl" ? -sx : -Infinity, startY = horizontal ? -sy : -Infinity;
    // the part of q (a box or text rect of e) left after that clipping (null: out of work — the caller answers "content")
    const clipped = (e: PageElement, q: PageBox): { x0: number; y0: number; x1: number; y1: number } | null => {
      let x0 = Math.max(q.x, startX), y0 = Math.max(q.y, startY), x1 = q.right, y1 = q.bottom;
      let flow: "in" | "absolute" | "fixed" = "in";
      for (let p: PageElement | null = e; p; p = p === box ? null : up(p)) {
        if (tick()) return null;
        if (css(p, "display") === "contents") continue;
        const pr = p.getBoundingClientRect();
        const pos = css(p, "position");
        // not on the containing-block chain: its overflow does not clip what escapes it
        const skip = p !== e && (flow === "fixed" ? !holdsFixed(p) : flow === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pos) && !holdsFixed(p));
        if (!skip) {
          const ox = css(p, "overflow-x"), oy = css(p, "overflow-y");
          // overflow:clip on both axes paints overflow-clip-margin past the box (from the border box here: an upper bound)
          const cm = ox === "clip" && oy === "clip" ? parseFloat(/(-?[\d.]+)px/.exec(css(p, "overflow-clip-margin"))?.[1] ?? "0") || 0 : 0;
          if (ox !== "visible") { x0 = Math.max(x0, pr.x - cm); x1 = Math.min(x1, pr.right + cm); }
          if (oy !== "visible") { y0 = Math.max(y0, pr.y - cm); y1 = Math.min(y1, pr.bottom + cm); }
          flow = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "in";
        }
        const ins = /^inset\((.*)\)$/.exec(css(p, "clip-path"));
        if (ins) {
          const [t = "0", r = t, b = t, l = r] = (ins[1] ?? "").split(/\s+round\s+/)[0]?.trim().split(/\s+/) ?? [];
          const len = (s: string, size: number): number => (s.endsWith("%") ? (parseFloat(s) / 100) * size : parseFloat(s));
          const T = len(t, pr.height), R = len(r, pr.width), B = len(b, pr.height), L = len(l, pr.width);
          if (![T, R, B, L].some(Number.isNaN)) { x0 = Math.max(x0, pr.x + L); x1 = Math.min(x1, pr.right - R); y0 = Math.max(y0, pr.y + T); y1 = Math.min(y1, pr.bottom - B); }
        }
        const rc = /^rect\((.*)\)$/.exec(css(p, "clip"));
        if (rc && /^(absolute|fixed)$/.test(pos)) {
          const v = (rc[1] ?? "").split(/[\s,]+/).filter(Boolean);
          const at = (s: string | undefined, auto: number): number => (s === undefined || s === "auto" ? auto : parseFloat(s));
          const T = at(v[0], 0), R = at(v[1], pr.width), B = at(v[2], pr.height), L = at(v[3], 0);
          if (v.length === 4 && ![T, R, B, L].some(Number.isNaN)) { x0 = Math.max(x0, pr.x + L); x1 = Math.min(x1, pr.x + R); y0 = Math.max(y0, pr.y + T); y1 = Math.min(y1, pr.y + B); }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const area = (e: PageElement, q: PageBox): number => { const c = clipped(e, q); return c ? Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0) : Infinity; };
    const els: PageElement[] = [];
    const texts: Array<{ t: PageNode; e: PageElement }> = [];
    // an explicit stack, the same order as the recursion it replaces (an element, its text, its shadow root's
    // text and elements, then its light children)
    const todo: PageElement[] = [box];
    for (let e = todo.pop(); e; e = todo.pop()) {
      if (tick()) return `more than ${OWN_WORK_CAP} boxes to check`;
      els.push(e);
      for (const t of Array.from(e.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
      const sr = e.shadowRoot;
      let kids = Array.from(e.children);
      if (sr) {
        for (const t of Array.from(sr.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
        kids = Array.from(sr.children).concat(kids);
      }
      for (let i = kids.length - 1; i >= 0; i--) { const k = kids[i]; if (k) todo.push(k); }
    }
    // the cell's own chrome: a box holding the control, or over its centre (a filled wrapper, a hover tint)
    const cr = ctl.getBoundingClientRect(), mx = cr.x + cr.width / 2, my = cr.y + cr.height / 2;
    const chrome = (e: PageElement): boolean => { if (e.contains(ctl)) return true; const r = e.getBoundingClientRect(); return mx >= r.x && mx <= r.right && my >= r.y && my <= r.bottom; };
    const clear = (v: string): boolean => v === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(v);
    for (const e of els) {
      if (inCtl(e) || !shown(e)) continue;
      if (/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(e.tagName.toUpperCase()) && area(e, e.getBoundingClientRect()) > 1) return `<${e.tagName.toLowerCase()}>`;
      const host = boxed(e) ?? e;
      for (const ps of ["::before", "::after"]) {
        const c = css(e, "content", ps);
        if (!c || c === "none" || c === "normal" || css(e, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(e, "visibility", ps)) || (css(e, "opacity", ps) === "0" && outOfFlow(e, ps))) continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        const s = str ? str[1] ?? "" : null;
        const fill = !clear(css(e, "background-color", ps));
        const paints = s === null || /\S/.test(s) || set(e, "background-image", ps) || set(e, "mask-image", ps) || (fill && (s !== "" || !chrome(host)));
        if (paints && area(host, host.getBoundingClientRect()) > 1) return `${ps} content`;
      }
      // a list item's marker (the container's own too) — a list-style type or image, or a ::marker content
      if (/list-item/.test(css(e, "display")) && (!/^(none)?$/.test(css(e, "list-style-type")) || set(e, "list-style-image") || !/^(normal|none)?$/.test(css(e, "content", "::marker")))
        && area(e, e.getBoundingClientRect()) > 1) return "a list marker";
      // a scroll container's ::scroll-button (generated when its content is set — focusable and pressed like a
      // button: a second control) and a scroll-marker group (its markers are focusable too), the container's own included
      if ((!/^(visible|clip)$/.test(css(e, "overflow-x")) || !/^(visible|clip)$/.test(css(e, "overflow-y"))) && !/^(none|normal)?$/.test(css(e, "content", "::scroll-button(*)"))
        && area(e, e.getBoundingClientRect()) > 1) return "a scroll button";
      if (!/^(none)?$/.test(css(e, "scroll-marker-group")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll-marker group";
      if (e === box) {
        // the container's OWN paint is decoration only when plain — a background image (a gradient, a url: a progress fill),
        // a border image, border sides in different colours or widths 2 px or more apart (a status stripe) are content; one colour
        // all round, or a 1-px divider on one side, stays decoration
        if (/\b(url|image|image-set|cross-fade|element|paint|[a-z-]*gradient)\(/i.test(css(e, "background-image"))) return "its own background image";
        if (set(e, "border-image-source")) return "its own border image";
        const sides = ["top", "right", "bottom", "left"].map((k) => ({ w: /^(none|hidden)$/.test(css(e, `border-${k}-style`)) ? 0 : parseFloat(css(e, `border-${k}-width`)) || 0, c: css(e, `border-${k}-color`) }));
        const painted = sides.filter((d) => d.w > 0 && !clear(d.c));
        if (new Set(painted.map((d) => d.c)).size > 1) return "its own border in more than one colour";
        const ws = sides.map((d) => (d.w > 0 && !clear(d.c) ? d.w : 0));
        if (painted.length > 0 && Math.max(...ws) - Math.min(...ws) >= 2) return "its own border stripe";
        // its own box-shadow and mask paint too — an inset layer offset 2 px or more (a stripe, a progress
        // fill) or blurred (an inner glow), sharp ring layers (blur 0) in more than one colour (the ring layers only — not its
        // border; a layer in its own background colour where that cannot show — an outer one (a ring-offset), or an inset one over
        // its own opaque border-box / padding-box background — and a transparent one do not count), and a mask or a
        // clip-path other than a rounded inset(0) over its own paint (a progress band) are content; one sharp ring colour (a
        // focus / hover ring, a ring-inset frame, a Tailwind ring-offset + ring) stays decoration, as a uniform border does
        const layers: Array<{ c: string; n: number[]; inset: boolean }> = [];
        let depth = 0, cur = "";
        for (const ch of `${css(e, "box-shadow")},`) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch !== "," || depth > 0) { cur += ch; continue; }
          const n = Array.from(cur.matchAll(/(-?[\d.]+)px/g), (m) => parseFloat(m[1] ?? "0") || 0);
          const c = cur.replace(/-?[\d.]+px/g, "").replace(/\binset\b/, "").trim();
          if (n.length >= 2 && c !== "" && c !== "none" && !clear(c)) layers.push({ c, n, inset: /\binset\b/.test(cur) });
          cur = "";
        }
        if (layers.some((l) => l.inset && (Math.max(Math.abs(l.n[0] ?? 0), Math.abs(l.n[1] ?? 0)) >= 2 || (l.n[2] ?? 0) > 0))) return "its own inset box-shadow (a stripe, a fill or a glow)";
        const ownBg = css(e, "background-color");
        const rings = layers.filter((l) => !((l.n[2] ?? 0) > 0) && (l.n[0] !== 0 || l.n[1] !== 0 || (l.n[3] ?? 0) !== 0) && !(l.c === ownBg && (!l.inset || /^rgb\(/.test(ownBg) && /^(border|padding)-box$/.test(css(e, "background-clip")))));
        if (new Set(rings.map((l) => l.c)).size > 1) return "its own box-shadow ring in more than one colour";
        const paints = !clear(css(e, "background-color")) || painted.length > 0 || layers.length > 0;
        if (paints && set(e, "mask-image")) return "its own paint under a mask";
        const cp = css(e, "clip-path");
        if (paints && cp !== "" && cp !== "none" && !/^inset\(0(px)?( 0(px)?){0,3}( round .*)?\)$/.test(cp)) return "its own paint under a clip-path";
        continue;
      }
      if (css(e, "display") === "contents") continue;
      if (set(e, "background-image") && area(e, e.getBoundingClientRect()) > 1) return "a background image";
      if (set(e, "mask-image") && !e.contains(ctl) && area(e, e.getBoundingClientRect()) > 1) return "a mask image";
      if (!clear(css(e, "background-color")) && !chrome(e) && area(e, e.getBoundingClientRect()) > 1) return "a filled box";
    }
    for (const { t, e } of texts) {
      const text = (t.nodeValue || "").trim();
      if (!text || inCtl(e) || !shown(e)) continue;
      const range = document.createRange();
      range.selectNodeContents(t);
      for (const q of Array.from(range.getClientRects())) if (area(e, q) > 1) return `text "${text.slice(0, 40)}"`;
    }
    // a label laid over the container from OUTSIDE its subtree — a positioned sibling, an ancestor's ::before / ::after —
    // is its content too when it is in the page's flow or absolute (an element with a fixed or sticky box between it and the root
    // that does not also hold the container — a toast, a banner, a sticky header — is foreign). Read: text (its clipped Range
    // rects; bare text in its open shadow root too), an img / svg / canvas / video / audio / picture / object / embed / iframe /
    // input / progress / meter, a background image, and a ::before / ::after that paints a label or an image (its box: the
    // element's, or for an absolute one its offsets in its containing block) — over the container when the part of it left after
    // clipping is over 1 px² and at least HALF of it lies inside the container's box, and it is not proven to lie under it
    // (proven: it is hit-testable — pointer-events not none — and at the middle of that overlap the container's subtree is hit
    // first, and the container's own background colour is opaque rgb() / rgba(…, 1) with no opacity below 1 or blend mode on it
    // or above it). Never foreign content — the sole control's own tooltip ([role=tooltip], or what its aria-describedby
    // names; a role-less one still counts), only when the probe's hover revealed it (not shown before: tipPreMark), and a
    // label at effective opacity 0. Not seen: an element whose box does not meet the
    // container's (a relative ::before shifted over it from a sibling lying elsewhere), an in-flow box under a parent that does not
    // meet it (text overflowing a 0-height wrapper). Bounded: past FOREIGN_CAP elements it answers "content".
    const br = box.getBoundingClientRect();
    const anc = new Set<PageElement>();
    for (let p = up(box); p; p = up(p)) anc.add(p);
    const bg = css(box, "background-color");
    // "under it" is proven only when nothing of it shows through — its background opaque, and no opacity below 1
    // or blend mode on it or above it
    let opaque = /^rgb\(/.test(bg) || /^rgba\(.*,\s*1\)$/.test(bg);
    for (let p: PageElement | null = box; p && opaque; p = up(p)) {
      const op = css(p, "opacity"), bm = css(p, "mix-blend-mode");
      if ((op !== "" && parseFloat(op) < 1) || (bm !== "" && bm !== "normal")) opaque = false;
    }
    const meets = (q: PageBox): boolean => q.right > br.x && q.x < br.right && q.bottom > br.y && q.y < br.bottom;
    const over = (f: PageElement, c: { x0: number; y0: number; x1: number; y1: number } | null, events: string): boolean => {
      if (!c) return true;
      const a = Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0);
      const ix0 = Math.max(c.x0, br.x), iy0 = Math.max(c.y0, br.y), ix1 = Math.min(c.x1, br.right), iy1 = Math.min(c.y1, br.bottom);
      if (a <= 1 || ix1 <= ix0 || iy1 <= iy0 || (ix1 - ix0) * (iy1 - iy0) < a / 2) return false;
      if (events === "none" || !opaque) return true;
      const hits = Array.from(document.elementsFromPoint((ix0 + ix1) / 2, (iy0 + iy1) / 2));
      const iF = hits.indexOf(f), iB = hits.findIndex((h) => h === box || box.contains(h));
      return iF < 0 || iB < 0 || iF < iB;
    };
    const pinned = chain((p) => !anc.has(p) && /^(fixed|sticky)$/.test(css(p, "position")));
    // The sole control's own tooltip — [role=tooltip] (MUI, Radix, Tippy, Bootstrap, Floating UI set it) or
    // what its aria-describedby names, shown by the drive's hover — is never foreign content (its subtree is skipped). Only one
    // the probe's hover revealed — not shown before the probe acted on the page (tipPreMark); a label
    // already on screen with role=tooltip, or that the control's aria-describedby names, is the card's own; no set, no exemption
    const tipIds = new Set((ctl.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    const tipPre = window.__dtTipPre;
    const tip = (f: PageElement): boolean => !!tipPre && !tipPre.has(f) && !anc.has(f) && ((f.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "tooltip" || tipIds.has(f.getAttribute("id") ?? ""));
    // a foreign label at effective opacity 0 (itself or an ancestor) shows nothing — never foreign content
    const gone = chain((p) => css(p, "opacity") === "0");
    // bounded at 500000 elements (a 150000-element table: about 0.3 s per check) — past it, "content" (refused)
    const FOREIGN_CAP = 500_000;
    let walked = 0;
    // a box is measured only when its parent's box meets the container, it holds the container, or it is moved out of its
    // parent's flow (positioned or transformed) — an in-flow box under a parent that does not meet the container is taken not to
    // meet it either (nested inline boxes make every getBoundingClientRect walk all below it: 8000 of them cost seconds)
    // (one computed style read per element: the walk visits every element of the page)
    const moved = (f: PageElement): boolean => { const s = getComputedStyle(f); return s.getPropertyValue("position") !== "static" || ["transform", "translate", "rotate", "scale"].some((k) => { const v = s.getPropertyValue(k); return v !== "" && v !== "none"; }); };
    const ftodo: Array<{ f: PageElement; near: boolean }> = [{ f: de, near: true }];
    for (let t = ftodo.pop(); t; t = ftodo.pop()) {
      if (++walked > FOREIGN_CAP) return `more than ${FOREIGN_CAP} boxes on the page to check for a label laid over it`;
      const f = t.f;
      if (f === box || tip(f)) continue;
      const isAnc = anc.has(f);
      const fr = t.near || isAnc || moved(f) ? f.getBoundingClientRect() : null;
      const near = isAnc || (fr !== null && meets(fr));
      const sr = f.shadowRoot;
      for (const k of Array.from(f.children ?? [])) ftodo.push({ f: k, near });
      if (sr) for (const k of Array.from(sr.children)) ftodo.push({ f: k, near });
      if (!fr || !near || pinned(f) || !shown(f) || gone(f)) continue;
      const events = css(f, "pointer-events");
      // its text, and bare text in its open shadow root
      for (const t of [...Array.from(f.childNodes), ...(sr ? Array.from(sr.childNodes) : [])]) {
        const text = t.nodeType === 3 ? (t.nodeValue || "").trim() : "";
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const q of Array.from(range.getClientRects())) if (over(f, clipped(f, q), events)) return `text "${text.slice(0, 40)}" laid over it from outside it`;
      }
      if (!isAnc && /^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(f.tagName.toUpperCase()) && over(f, clipped(f, fr), events)) return `<${f.tagName.toLowerCase()}> laid over it from outside it`;
      if (!isAnc && set(f, "background-image") && over(f, clipped(f, fr), events)) return "a background image laid over it from outside it";
      for (const ps of ["::before", "::after"]) {
        const c = css(f, "content", ps);
        const pos = css(f, "position", ps);
        if (!c || c === "none" || c === "normal" || pos === "fixed" || css(f, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(f, "visibility", ps)) || css(f, "opacity", ps) === "0") continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        if (!(str === null || /\S/.test(str[1] ?? "") || set(f, "background-image", ps) || set(f, "mask-image", ps))) continue;
        let q: PageBox = fr;
        if (pos === "absolute") {
          // its containing block: the closest box at or above it that is positioned or holds fixed boxes (its padding box), else the page
          let cb: PageElement | null = f;
          while (cb && css(cb, "position") === "static" && !holdsFixed(cb)) cb = up(cb);
          const cr0 = cb ? cb.getBoundingClientRect() : null;
          const n = (k: string): number => parseFloat(css(f, k, ps)) || 0;
          const x = (cr0 && cb ? cr0.x + (parseFloat(css(cb, "border-left-width")) || 0) : -scrollX) + n("left") + n("margin-left");
          const y = (cr0 && cb ? cr0.y + (parseFloat(css(cb, "border-top-width")) || 0) : -scrollY) + n("top") + n("margin-top");
          const extra = css(f, "box-sizing", ps) === "border-box" ? [0, 0] : [n("padding-left") + n("padding-right") + n("border-left-width") + n("border-right-width"), n("padding-top") + n("padding-bottom") + n("border-top-width") + n("border-bottom-width")];
          const w = n("width") + (extra[0] ?? 0), h = n("height") + (extra[1] ?? 0);
          q = { x, y, width: w, height: h, right: x + w, bottom: y + h };
        } else if (isAnc) continue;
        if (over(f, clipped(f, q), css(f, "pointer-events", ps))) return `a generated ${ps} label laid over it from outside it`;
      }
    }
    return null;
  };

  const dt: PageRuntime = {
    parent, paths, path: (el) => paths()(el), find, controlText, ownText, shownText, visible, viewport, clickPoint, active, tagSel, tagged, describe, ownContent,
  };
  Object.defineProperty(window, "__dt", { value: dt, configurable: true });
}

/** The runtime as a script: what the probe's init script runs first in every document (verify-probe.ts INIT_SCRIPT), and what
 *  a test evaluates in a page it built with setContent (no navigation, so no init script). */
export const PAGE_RUNTIME = `(${installPageRuntime.toString()})();`;
