// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-probe.ts
import fs4 from "node:fs";
import path3 from "node:path";
import crypto3 from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { parseArgs as parseArgs2 } from "node:util";
import { setTimeout as sleep2 } from "node:timers/promises";
import { spawnSync as spawnSync2 } from "node:child_process";

// design-to-code/probe-page.ts
function collectCandidates(input) {
  const SKIP = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const norm = (s) => (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const pageRect = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const all = document.body ? [document.body, ...Array.from(document.body.querySelectorAll("*"))].filter((e) => !SKIP.has(e.tagName)) : [];
  const orderOf = /* @__PURE__ */ new Map();
  all.forEach((e, i) => orderOf.set(e, i));
  const depthOf = (el) => {
    let d = 0;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) d++;
    return el === document.body ? 0 : d + 1;
  };
  const cand = (el, withRange) => {
    const r = el.getBoundingClientRect();
    let rangeRect = null;
    if (withRange) {
      const range = document.createRange();
      range.selectNodeContents(el);
      rangeRect = pageRect(range.getBoundingClientRect());
    }
    const tagged2 = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const v = p.getAttribute("data-dt-node");
      if (v !== null) tagged2.push(v);
    }
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
        ariaHidden: el.closest('[aria-hidden="true"]') !== null
      },
      taggedAncestors: tagged2,
      ownText: norm(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("")),
      order: orderOf.get(el) ?? -1,
      depth: depthOf(el)
    };
  };
  let ctx = null;
  const alphaOf = (css) => {
    const m = /^rgba?\(([^)]*)\)$/.exec(css.trim());
    if (m) {
      const p = (m[1] || "").split(/[\s,/]+/).filter(Boolean);
      return p.length >= 4 ? Number(p[3]) : 1;
    }
    if (css.trim() === "transparent") return 0;
    if (!ctx) {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      ctx = c.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return 1;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return (ctx.getImageData(0, 0, 1, 1).data[3] ?? 255) / 255;
  };
  const tagged = Array.from(document.querySelectorAll("[data-dt-node]")).map((e) => cand(e, false));
  const frames = {};
  for (const f of input.frames) {
    const sized = [];
    if (f.w !== null && f.h !== null && document.body) {
      let level = [document.body];
      for (let depth = 0; depth <= 8 && level.length; depth++) {
        const next = [];
        for (const el of level) {
          if (SKIP.has(el.tagName)) continue;
          const r = el.getBoundingClientRect();
          if (Math.abs(r.width - f.w) <= 2 && Math.abs(r.height - f.h) <= 2) {
            const cs = getComputedStyle(el);
            const background = cs.getPropertyValue("background-color"), backgroundImage = cs.getPropertyValue("background-image");
            sized.push({ ...cand(el, false), background, backgroundImage, paints: alphaOf(background) > 0 || backgroundImage !== "" && backgroundImage !== "none" });
          }
          next.push(...Array.from(el.children));
        }
        level = next;
      }
    }
    frames[f.nodeId] = { sized };
  }
  const innermost = (els) => els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  const wanted = new Set(input.texts);
  const wantedLower = /* @__PURE__ */ new Map();
  for (const t of wanted) {
    const k = t.toLowerCase();
    wantedLower.set(k, [...wantedLower.get(k) || [], t]);
  }
  const exact = /* @__PURE__ */ new Map(), caseless = /* @__PURE__ */ new Map(), ph = /* @__PURE__ */ new Map();
  const push = (m, k, e) => {
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };
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
  const text = {}, placeholders = {};
  for (const t of wanted) {
    text[t] = { exact: innermost(exact.get(t) || []).map((e) => cand(e, true)), caseless: innermost(caseless.get(t) || []).map((e) => cand(e, true)) };
    placeholders[t] = (ph.get(t) || []).map((e) => cand(e, false));
  }
  const positions = {};
  for (const p of input.positions) {
    const hits = all.filter((el) => {
      const r = pageRect(el.getBoundingClientRect());
      return Math.abs(r.x - p.x) <= 2 && Math.abs(r.y - p.y) <= 2 && Math.abs(r.w - p.w) <= 2 && Math.abs(r.h - p.h) <= 2;
    });
    positions[p.nodeId] = innermost(hits).map((e) => cand(e, false));
  }
  return { viewport: { w: innerWidth, h: innerHeight, scrollX, scrollY }, tagged, frames, text, placeholders, positions };
}
function measureElements(input) {
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const r2 = (n) => Math.round(n * 100) / 100;
  const pageRect = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  const collapse = (s) => (s || "").replace(/[ \t\n\r\f]+/g, " ").trim();
  let ctx = null;
  const rgba = (css) => {
    const s = css.trim();
    if (!s) return null;
    if (/^rgba?\(/.test(s) || s === "transparent") return s;
    if (!ctx) {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      ctx = c.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return s;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = s;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const [r = 0, g = 0, b = 0, a = 255] = [d[0], d[1], d[2], d[3]];
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a / 255 * 1e3) / 1e3})`;
  };
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("").trim();
  const elementsWithOwnText = (el) => {
    const out = [];
    const walk = (e) => {
      if (ownText(e)) out.push(e);
      for (const c of Array.from(e.children)) walk(c);
    };
    walk(el);
    return out;
  };
  const textOwner = (el) => {
    const owners = elementsWithOwnText(el);
    const mixed = owners.length > 1;
    let cur = el;
    for (; ; ) {
      if (ownText(cur)) return { owner: cur, mixed };
      const kids = Array.from(cur.children);
      const only = kids.length === 1 ? kids[0] : void 0;
      if (!only) break;
      cur = only;
    }
    const first = owners[0];
    return first ? { owner: first, mixed } : null;
  };
  const SHAPES = "path, rect, circle, ellipse, polygon, polyline, line, use, text";
  return input.items.map((item) => {
    const styles = {};
    const unmeasured = {};
    const res = { nodeId: item.nodeId, found: false, styles, unmeasured };
    const el = document.querySelector(item.path);
    const put = (k, v, why) => {
      if (v === null || v === void 0) {
        styles[k] = null;
        unmeasured[k] = why;
      } else styles[k] = v;
    };
    if (!el) {
      for (const k of input.keys) put(k, null, "the element was gone when measured");
      return res;
    }
    res.found = true;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const rect = pageRect(el.getBoundingClientRect());
    const fr = input.frameRect;
    let typo = el, typoCs = cs;
    let textBox = null, textBoxWhy = item.isPlaceholder ? "an input placeholder: its characters are not in the DOM (see placeholderText)" : "not a TEXT node";
    if (item.isText && !item.isPlaceholder) {
      const own = textOwner(el);
      if (own) {
        typo = own.owner;
        typoCs = getComputedStyle(typo);
        res.textFrom = typo.tagName.toLowerCase();
        if (own.mixed) res.textFromMixed = true;
        let left = Infinity, right = -Infinity;
        for (const n of Array.from(typo.childNodes)) {
          if (n.nodeType !== 3 || !(n.nodeValue || "").trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const rr = pageRect(range.getBoundingClientRect());
          if (rr.w <= 0) continue;
          left = Math.min(left, rr.x);
          right = Math.max(right, rr.x + rr.w);
        }
        if (Number.isFinite(left)) textBox = { x: r2(left - fr.x), w: r2(right - left) };
        else textBoxWhy = "the text's own characters have no rendered box";
      } else textBoxWhy = "the element holds no text";
    }
    const sides = (prop) => ["top", "right", "bottom", "left"].map((s) => px(cs.getPropertyValue(prop(s))));
    let strokeMemo;
    const transparentColour = (c) => c === null || c === "transparent" || /,\s*0(?:\.0+)?\)$/.test(c) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(c);
    const splitTop = (v, sep) => {
      const out = [];
      let depth = 0, cur = "";
      for (const ch of v) {
        if (ch === "(") depth++;
        else if (ch === ")") depth = Math.max(0, depth - 1);
        if (depth === 0 && sep.test(ch)) {
          if (cur.trim()) out.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const drawnStroke = () => {
      if (strokeMemo !== void 0) return strokeMemo;
      strokeMemo = null;
      if (sides((s) => `border-${s}-width`).some((w) => w !== 0)) return strokeMemo;
      const rings = [];
      const shadow = cs.getPropertyValue("box-shadow").trim();
      if (shadow && shadow !== "none") {
        for (const entry of splitTop(shadow, /,/)) {
          const lens = [];
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
      const ring = distinct.length === 1 ? distinct[0] : insetOnes.length === 1 ? insetOnes[0] : void 0;
      if (ring) return strokeMemo = { width: ring.spread, color: ring.color, from: "box-shadow", align: ring.inset ? "inside" : "outside" };
      if (distinct.length > 1) return strokeMemo;
      const os2 = cs.getPropertyValue("outline-style").trim(), ow = px(cs.getPropertyValue("outline-width")), oo = px(cs.getPropertyValue("outline-offset"));
      const oc = rgba(cs.getPropertyValue("outline-color"));
      if (!os2 || os2 === "none" || os2 === "auto" || ow === null || !(ow > 0) || oo === null || transparentColour(oc)) return strokeMemo;
      if (oo === -ow) return strokeMemo = { width: ow, color: oc, from: "outline", align: "inside" };
      if (oo === 0) return strokeMemo = { width: ow, color: oc, from: "outline", align: "outside" };
      return strokeMemo;
    };
    const putStroke = () => {
      const st = drawnStroke();
      if (st) {
        styles.strokeFrom = st.from;
        styles.strokeAlign = st.align;
      } else if (sides((s) => `border-${s}-width`).some((w) => w !== null && w > 0)) styles.strokeFrom = "border";
    };
    const fill = () => {
      if (!item.isPaint) return { v: null, why: "not a vector/SVG node \u2014 its colour is backgroundColor" };
      if (tag === "img" || tag === "canvas" || tag === "picture") return { v: null, why: `an <${tag}>: its paint is pixels, not a CSS property`, source: "img" };
      const shapes = [...el.matches(SHAPES) ? [el] : [], ...Array.from(el.querySelectorAll(SHAPES))];
      let stroke = null;
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
      if (el.querySelectorAll("img, canvas").length > 0) return { v: null, why: "an <img>: its paint is pixels, not a CSS property", source: "img" };
      if (mask && mask !== "none") return { v: null, why: "a mask-drawn icon with a transparent background", source: "background" };
      return { v: null, why: shapes.length ? "no SVG shape has a fill" : "no SVG shape, no background: nothing paints this node", source: "css" };
    };
    for (const k of input.keys) {
      switch (k) {
        case "fontFamily":
          put(k, typoCs.getPropertyValue("font-family") || null, "no computed font-family");
          break;
        case "fontSize":
          put(k, px(typoCs.getPropertyValue("font-size")), "no computed font-size");
          break;
        case "fontWeight": {
          const w = parseInt(typoCs.getPropertyValue("font-weight"), 10);
          put(k, Number.isFinite(w) ? w : null, "no numeric font-weight");
          break;
        }
        case "lineHeight": {
          const v = typoCs.getPropertyValue("line-height");
          put(k, v === "normal" ? null : px(v), "line-height: normal \u2014 its pixel value depends on the font's metrics");
          break;
        }
        case "letterSpacing": {
          const v = typoCs.getPropertyValue("letter-spacing");
          put(k, v === "normal" ? 0 : px(v), "no computed letter-spacing");
          break;
        }
        case "color":
          put(k, rgba(typoCs.getPropertyValue("color")), "no computed color");
          break;
        case "backgroundColor":
          put(k, rgba(cs.getPropertyValue("background-color")), "no computed background-color");
          break;
        case "fill": {
          const f = fill();
          if (f.source) res.fillSource = f.source;
          put(k, f.v, f.why);
          break;
        }
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
          const ws = sides((s) => `border-${s}-width`).filter((w) => w !== null);
          const st = drawnStroke();
          put(k, st ? st.width : ws.length ? Math.max(...ws) : null, "no computed border width");
          putStroke();
          break;
        }
        case "display":
          put(k, cs.getPropertyValue("display").trim() || null, "no computed display");
          break;
        case "borderRadius": {
          const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c2) => {
            const v = cs.getPropertyValue(`border-${c2}-radius`).trim().split(/\s+/)[0] || "0";
            return v.endsWith("%") ? r2(parseFloat(v) / 100 * Math.min(rect.w, rect.h)) : px(v);
          });
          const [a, b, c, d] = corners;
          if (corners.some((v) => v === null)) put(k, null, "unreadable border radius");
          else put(k, a === b && a === c && a === d ? a : corners, "");
          break;
        }
        case "padding":
          put(k, sides((s) => `padding-${s}`), "");
          break;
        case "gap": {
          const display = cs.getPropertyValue("display");
          const flexish = /flex|grid/.test(display);
          if (!flexish) {
            put(k, null, `display: ${display} \u2014 gap does not apply; spacing comes from margins`);
            break;
          }
          const column = /column/.test(cs.getPropertyValue("flex-direction")) && /flex/.test(display);
          const v = cs.getPropertyValue(column ? "row-gap" : "column-gap").trim();
          put(k, v === "normal" ? 0 : v.endsWith("%") ? null : px(v), v.endsWith("%") ? `a percentage gap (${v}) \u2014 its px value depends on the container` : "unreadable gap");
          break;
        }
        case "gapVisual": {
          if (!/^(table|thead|tbody|tfoot)$/.test(tag)) {
            put(k, null, "measured only for a table (row spacing is border-spacing, not gap)");
            break;
          }
          const own = tag === "table" ? el : el.closest("table");
          const rows = Array.from(el.querySelectorAll("tr")).filter((r) => r.closest("table") === own).map((r) => r.getBoundingClientRect()).filter((r) => r.height > 0);
          const gaps = [];
          for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1], b = rows[i];
            if (a && b) gaps.push(r2(b.y - (a.y + a.height)));
          }
          const median = gaps.length ? gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? null : null;
          put(k, median !== null && median < 0 ? null : median, median === null ? "fewer than two rendered rows" : `the rows are not stacked top to bottom (median distance ${median}px) \u2014 not a row gap`);
          break;
        }
        case "width":
        case "height":
        case "x":
        case "y": {
          if (item.sharesWith !== null) {
            put(k, null, `shares the element of data-dt-node="${item.sharesWith}"; wrap the label in a tagged <span> to measure its box`);
            break;
          }
          put(k, r2(k === "width" ? rect.w : k === "height" ? rect.h : k === "x" ? rect.x - fr.x : rect.y - fr.y), "");
          break;
        }
        case "opacity":
          put(k, px(cs.getPropertyValue("opacity")), "no computed opacity");
          break;
        case "text":
          put(k, item.isText && !item.isPlaceholder ? collapse(el.textContent) : null, item.isPlaceholder ? "an input placeholder: see placeholderText" : "not a TEXT node");
          break;
        case "tag":
          put(k, tag, "");
          break;
        case "textBox":
          put(k, textBox, textBoxWhy);
          break;
        default:
          put(k, null, `verify-probe does not know how to read '${k}'`);
      }
    }
    return res;
  });
}
function focusablePath(path4) {
  const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";
  const el = document.querySelector(path4);
  const f = el ? el.closest(FOCUSABLE) : null;
  if (!f) return null;
  const parts = [];
  let cur = f;
  while (cur && cur !== document.documentElement) {
    const parent = cur.parentElement;
    if (!parent) break;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
    cur = parent;
  }
  parts.unshift("html");
  return parts.join(" > ");
}
function focusInfo(path4) {
  const el = document.querySelector(path4);
  const focused = !!el && document.activeElement === el;
  return { focused, focusVisible: focused && !!el && el.matches(":focus-visible") };
}

// design-to-code/probe-match.ts
var CANONICAL_MATCHED_BY = ["tag", "tag-shared-path", "tag-alias", "text", "text-ordinal", "position", "frame"];
var isMatch = (m) => "matchedBy" in m;
var normText = (s) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
var attrSelector = (id) => `[data-dt-node="${id.replace(/["\\]/g, "\\$&")}"]`;
var idSuffix = (id) => {
  const i = id.indexOf(";");
  return i === -1 ? null : id.slice(i + 1);
};
function specText(spec) {
  if (typeof spec.placeholderText === "string" && normText(spec.placeholderText)) return { text: normText(spec.placeholderText), placeholder: true };
  if (typeof spec.text === "string" && normText(spec.text)) return { text: normText(spec.text), placeholder: false };
  return null;
}
var PAINT_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
var isPaintSpec = (spec) => spec.fill !== void 0 || PAINT_TYPES.has(spec.type);
var ALPHA_ZERO = /^transparent$|^rgba\([^)]*,\s*0(?:\.0+)?\)$/;
var paints = (c) => c.paints || !ALPHA_ZERO.test(c.background.trim()) && c.background.trim() !== "" || c.backgroundImage !== "" && c.backgroundImage !== "none";
function resolveFrame(frame, tagged, sized, viewport, allowViewport) {
  const t = tagged.find((c) => c.dt === frame.nodeId && c.flags.box && c.flags.visible && !c.flags.inClosedDialog);
  if (t) return { nodeId: frame.nodeId, selector: attrSelector(frame.nodeId), via: "tag", rect: t.rect, path: t.path };
  if (frame.w !== null && frame.h !== null) {
    const fw = frame.w, fh = frame.h;
    const s = sized.filter((c) => c.flags.visible && Math.abs(c.rect.w - fw) <= 2 && Math.abs(c.rect.h - fh) <= 2 && paints(c)).sort((a, b) => a.depth - b.depth || a.order - b.order)[0];
    if (s) return { nodeId: frame.nodeId, selector: s.path, via: "size-and-fill", rect: s.rect, path: s.path };
  }
  if (!allowViewport) return null;
  return {
    nodeId: frame.nodeId,
    selector: "html",
    via: "viewport",
    rect: { x: 0, y: 0, w: viewport.w, h: viewport.h },
    path: "html",
    note: `no element is tagged data-dt-node="${frame.nodeId}" and none of the frame's size (${frame.w ?? "?"}\xD7${frame.h ?? "?"}) paints a background \u2014 positions are measured from the viewport origin; tag the frame root`
  };
}
var textKey = (t) => (t.placeholder ? "placeholder:" : "text:") + t.text;
function buildPool(collect, specs, expectedIds, frames, primaryFrameId) {
  const byTag = /* @__PURE__ */ new Map(), bySuffix = /* @__PURE__ */ new Map();
  for (const c of collect.tagged) {
    if (c.dt === null) continue;
    byTag.set(c.dt, [...byTag.get(c.dt) || [], c]);
    const sfx = idSuffix(c.dt);
    if (sfx !== null && !expectedIds.has(c.dt)) bySuffix.set(sfx, [...bySuffix.get(sfx) || [], c]);
  }
  const sameText = /* @__PURE__ */ new Map();
  for (const s of specs) {
    const t = specText(s);
    if (t) sameText.set(textKey(t), [...sameText.get(textKey(t)) || [], s]);
  }
  return { byTag, bySuffix, collect, sameText, frames, primaryFrameId, expectedIds };
}
function textUsable(c, spec) {
  const f = c.flags;
  return f.box && f.visible && !f.zeroSize && !f.inClosedDialog && !f.inert && (!f.opacity0 || spec.drawnState !== void 0);
}
var tagVisible = (c) => c.flags.box && c.flags.visible && !c.flags.inClosedDialog;
var hiddenWhy = (cs) => {
  const n = (p) => cs.filter(p).length;
  const parts = [
    [n((c) => c.flags.inClosedDialog), "in a closed <dialog>"],
    [n((c) => !c.flags.box), "not rendered (display:none)"],
    [n((c) => c.flags.box && !c.flags.visible), "visibility hidden"],
    [n((c) => c.flags.inert), "inert"],
    [n((c) => c.flags.zeroSize), "0\xD70"],
    [n((c) => c.flags.opacity0), "opacity 0"]
  ];
  return parts.filter(([k]) => k > 0).map(([k, w]) => `${k} ${w}`).join(", ");
};
function frameOfSpec(spec, pool) {
  const id = spec.frameId ?? pool.primaryFrameId;
  return { id, frame: id === null ? null : pool.frames.get(id) ?? null };
}
function chooseMatch(spec, pool, opts) {
  const id = spec.nodeId;
  const { id: frameId, frame } = frameOfSpec(spec, pool);
  if (frameId !== null && frame === null) return { nodeId: id, why: `frame ${frameId} not rendered (no data-dt-node="${frameId}" and no element of its size that paints)` };
  if (frame && id === frame.nodeId) {
    const hits2 = pool.byTag.get(id) || [];
    return { nodeId: id, matchedBy: frame.via === "tag" ? "tag" : "frame", selector: frame.selector, ...frame.via === "tag" ? { selectorCount: hits2.length } : {}, path: frame.path, cand: hits2.find(tagVisible) ?? null };
  }
  const hits = pool.byTag.get(id) || [];
  if (hits.length) {
    const vis = hits.find(tagVisible) ?? (spec.drawnState !== void 0 ? hits.find((c) => c.flags.box && !c.flags.inClosedDialog) : void 0);
    if (vis) return { nodeId: id, matchedBy: "tag", selector: attrSelector(id), selectorCount: hits.length, path: vis.path, cand: vis };
    const first = hits.find((c) => !c.flags.inClosedDialog);
    if (spec.drawnState === "hover" && first) {
      for (const a of spec.ancestorIds || []) {
        const anc = (pool.byTag.get(a) || []).find((c) => tagVisible(c) && !c.flags.zeroSize);
        if (anc) return { nodeId: id, matchedBy: "tag", selector: attrSelector(id), selectorCount: hits.length, path: first.path, cand: first, hoverVia: anc.path };
      }
    }
    return { nodeId: id, why: `hidden: data-dt-node="${id}" is on ${hits.length} element(s), none rendered (${hiddenWhy(hits)})` };
  }
  const sfx = idSuffix(id);
  if (sfx !== null) {
    const shared = (pool.bySuffix.get(sfx) || []).filter(tagVisible);
    const only = shared.length === 1 ? shared[0] : void 0;
    if (only && only.dt !== null) return { nodeId: id, matchedBy: "tag-shared-path", selector: attrSelector(only.dt), selectorCount: 1, path: only.path, cand: only };
  }
  const aliases = [...new Set(spec.aliases || [])].filter((a) => a !== id && !pool.expectedIds.has(a));
  if (aliases.length) {
    const hitsA = aliases.flatMap((a) => (pool.byTag.get(a) || []).filter(tagVisible));
    const onlyA = hitsA.length === 1 ? hitsA[0] : void 0;
    if (onlyA && onlyA.dt !== null) return { nodeId: id, matchedBy: "tag-alias", selector: attrSelector(onlyA.dt), selectorCount: 1, path: onlyA.path, cand: onlyA };
    if (hitsA.length > 1) {
      const tags = [...new Set(hitsA.map((c) => c.dt))].join(", ");
      return { nodeId: id, why: `ambiguous: ${hitsA.length} visible elements carry this node's aliases (${tags}) from other screens' exports; tag the one that is this node's with data-dt-node="${id}"` };
    }
  }
  const t = specText(spec);
  let textWhy = null;
  if (t) {
    const found = t.placeholder ? { exact: pool.collect.placeholders[t.text] || [], caseless: [] } : pool.collect.text[t.text] || { exact: [], caseless: [] };
    const nearestTagged = (spec.ancestorIds || []).find((a) => (pool.byTag.get(a) || []).some(tagVisible)) ?? null;
    const sharesAncestor = (c) => !t.placeholder && spec.type === "TEXT" && c.dt !== null && c.dt === nearestTagged && c.ownText === t.text;
    const free = (c) => t.placeholder || c.dt === null || c.dt === id || !pool.expectedIds.has(c.dt) || sharesAncestor(c);
    let all = found.exact.filter(free);
    let cands = all.filter((c) => textUsable(c, spec));
    if (!cands.length && found.caseless.length) {
      all = found.caseless.filter(free);
      cands = all.filter((c) => textUsable(c, spec));
    }
    let scope = null;
    for (const a of spec.ancestorIds || []) {
      if (!(pool.byTag.get(a) || []).some(tagVisible)) continue;
      if (cands.length) {
        const scoped = cands.filter((c) => c.dt === a && (t.placeholder || c.ownText === t.text) || c.taggedAncestors.includes(a));
        if (!scoped.length) return { nodeId: id, why: `text '${t.text}' is not inside data-dt-node="${a}" (its nearest tagged ancestor); tag it with data-dt-node="${id}"` };
        cands = scoped;
        scope = a;
      }
      break;
    }
    const one = cands.length === 1 ? cands[0] : void 0;
    if (one) return { nodeId: id, matchedBy: "text", selector: one.path, selectorCount: 1, path: one.path, cand: one, ...t.placeholder ? { placeholder: true } : {}, ...sharesAncestor(one) && one.dt !== null ? { sharesWith: one.dt } : {} };
    if (cands.length > 1) {
      if (typeof spec.x === "number" && frame) {
        const sx = spec.x, sy = spec.y;
        const dist = (c) => {
          const r = c.rangeRect ?? c.rect;
          return Math.abs(r.x - frame.rect.x - sx) + (typeof sy === "number" ? Math.abs(c.rect.y - frame.rect.y - sy) : 0);
        };
        const ranked = cands.map((c) => ({ c, d: dist(c) })).sort((a, b) => a.d - b.d);
        const [best, second] = ranked;
        if (best && second && second.d - best.d >= 8) return { nodeId: id, matchedBy: "text", selector: best.c.path, selectorCount: 1, path: best.c.path, cand: best.c };
      }
      const peers = (pool.sameText.get(textKey(t)) || []).filter((s) => (scope === null || (s.ancestorIds || []).includes(scope)) && (s.nodeId === id || !(pool.byTag.get(s.nodeId) || []).some(tagVisible)));
      const k = peers.findIndex((s) => s.nodeId === id);
      if (peers.length > 1 && peers.length === cands.length && k !== -1) {
        const c = [...cands].sort((a, b) => a.order - b.order)[k];
        if (c) return { nodeId: id, matchedBy: "text-ordinal", selector: c.path, selectorCount: 1, path: c.path, cand: c };
      }
      textWhy = `text '${t.text}' matched ${cands.length} visible elements${scope ? ` inside data-dt-node="${scope}"` : ""}; tag it with data-dt-node="${id}"`;
    } else if (all.length) {
      textWhy = `hidden: text '${t.text}' is only in ${all.length} element(s) a person cannot see (${hiddenWhy(all)}); tag the visible one with data-dt-node="${id}"`;
    } else {
      textWhy = `no data-dt-node="${id}" and no visible element holds the text '${t.text}'; tag it`;
    }
  }
  if (opts.position) {
    const at = (pool.collect.positions[id] || []).filter((c) => c.flags.box && c.flags.visible && !c.flags.inClosedDialog);
    const only = at.length === 1 ? at[0] : void 0;
    if (only) return { nodeId: id, matchedBy: "position", selector: only.path, selectorCount: 1, path: only.path, cand: only };
    if (at.length > 1 && !textWhy) return { nodeId: id, why: `${at.length} elements sit at this node's box; tag it with data-dt-node="${id}"` };
  }
  return { nodeId: id, why: textWhy ?? `no data-dt-node and no text; tag it with data-dt-node="${id}"` };
}
function claimOnce(results) {
  const byPath = /* @__PURE__ */ new Map();
  const sharers = /* @__PURE__ */ new Map();
  for (const r of results) if (isMatch(r) && r.sharesWith !== void 0) sharers.set(r.path, (sharers.get(r.path) || 0) + 1);
  const exempt = (m) => m.placeholder === true || m.sharesWith !== void 0 && sharers.get(m.path) === 1;
  for (const r of results) if (isMatch(r) && !exempt(r)) byPath.set(r.path, [...byPath.get(r.path) || [], r]);
  const owner = /* @__PURE__ */ new Map();
  for (const [p, ms] of byPath) {
    if (ms.length < 2) continue;
    owner.set(p, ms.find((m) => m.matchedBy === "tag" && m.cand?.dt === m.nodeId || m.matchedBy === "frame") ?? null);
  }
  return results.map((r) => {
    if (!isMatch(r) || exempt(r) || !owner.has(r.path)) return r;
    const o = owner.get(r.path) ?? null;
    if (o === r) return r;
    const others = (byPath.get(r.path) || []).filter((m) => m !== r).map((m) => m.nodeId);
    return { nodeId: r.nodeId, why: o ? `its element ${r.selector} is data-dt-node="${o.nodeId}"'s; tag this node's own element with data-dt-node="${r.nodeId}"` : `the same element (${r.selector}) was matched for ${others.length + 1} specs (also ${others.join(", ")}); tag it with data-dt-node="${r.nodeId}"` };
  });
}
function positionBoxes(specs, pool) {
  const out = [];
  for (const s of specs) {
    const f = pool.frames.get(s.frameId ?? pool.primaryFrameId ?? "");
    if (!f || typeof s.x !== "number" || typeof s.y !== "number" || typeof s.width !== "number" || typeof s.height !== "number") continue;
    out.push({ nodeId: s.nodeId, x: f.rect.x + s.x, y: f.rect.y + s.y, w: s.width, h: s.height });
  }
  return out;
}
function shapeNode(spec, match, raw, keys) {
  const styles = {};
  const unmeasured = {};
  for (const k of keys) {
    const v = raw.styles[k];
    if (v === void 0 || v === null) {
      styles[k] = null;
      unmeasured[k] = raw.unmeasured[k] || (raw.found ? "the page reported no value" : "the element was gone when measured");
    } else styles[k] = v;
  }
  const from = raw.styles.strokeFrom, align = raw.styles.strokeAlign;
  if (from === "border" || from === "box-shadow" || from === "outline") {
    styles.strokeFrom = from;
    if (from !== "border" && (align === "inside" || align === "outside")) styles.strokeAlign = align;
  }
  return {
    nodeId: spec.nodeId,
    matchedBy: match.matchedBy,
    selector: match.selector,
    ...match.selectorCount !== void 0 ? { selectorCount: match.selectorCount } : {},
    ...raw.textFrom !== void 0 ? { textFrom: raw.textFrom } : {},
    ...raw.textFromMixed ? { textFromMixed: true } : {},
    ...raw.fillSource !== void 0 ? { fillSource: raw.fillSource } : {},
    styles,
    ...Object.keys(unmeasured).length ? { unmeasured } : {},
    ...match.matchedBy === "position" ? { note: "matched by position (\xB12px) \u2014 low confidence; tag it with data-dt-node" } : match.matchedBy === "tag-alias" ? { note: `matched by another screen's id for this node (${match.selector}) \u2014 tag it with data-dt-node="${spec.nodeId}" to make it certain` } : {}
  };
}
function census(nodes, notMeasured) {
  const c = { tag: 0, sharedPath: 0, tagAlias: 0, text: 0, textOrdinal: 0, position: 0, frame: 0, notMeasured: notMeasured.length };
  const KEY = { tag: "tag", "tag-shared-path": "sharedPath", "tag-alias": "tagAlias", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame" };
  const isMatchedBy = (v) => v !== void 0 && Object.hasOwn(KEY, v);
  for (const n of nodes) if (isMatchedBy(n.matchedBy)) c[KEY[n.matchedBy]]++;
  return c;
}

// design-to-code/content-hash.ts
import { spawnSync } from "node:child_process";

// bridge/src/json-util.ts
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

// design-to-code/content-hash.ts
function gitHead(cwd) {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
    const h = r.status === 0 && String(r.stdout || "").trim();
    return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/read-json.ts
import fs from "node:fs";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);

// design-to-code/read-json.ts
var anyJson = (_x) => true;
function readFailure(e) {
  const code = e && typeof e === "object" && "code" in e ? e.code : void 0;
  if (code === "ENOENT") return { error: "does not exist", missing: true };
  return {
    error: code === "EISDIR" ? "is a directory, not a file" : code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${String(code || e)})`
  };
}
function readJson(file, guard) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return readFailure(e);
  }
  if (buf.length >= 2 && (buf[0] === 255 && buf[1] === 254 || buf[0] === 254 && buf[1] === 255)) {
    return { error: "is UTF-16, not UTF-8 \u2014 re-save it as UTF-8" };
  }
  let raw = buf.toString("utf8");
  if (raw.charCodeAt(0) === 65279) raw = raw.slice(1);
  let parsed;
  try {
    const value = JSON.parse(raw);
    parsed = value;
  } catch (e) {
    return { error: `is not valid JSON \u2014 ${errMsg(e)}` };
  }
  if (!guard(parsed)) return { error: `is not ${guard.expected || "the expected kind of document"}` };
  return { doc: parsed };
}
function readJsonOrNull(file, guard) {
  const r = readJson(file, guard);
  return "doc" in r ? r.doc : null;
}

// design-to-code/probe-steps.ts
import crypto from "node:crypto";

// design-to-code/plan-waivers.ts
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// design-to-code/probe-steps.ts
var STEP_KINDS = ["click", "waitFor", "goto"];
var isStepKind = (k) => STEP_KINDS.includes(k);
var REFUSED = {
  fill: "a typed value may submit a form when the steps are replayed",
  type: "a typed value may submit a form when the steps are replayed",
  press: "a key press may submit a form when the steps are replayed",
  hover: "a hover is not a navigation (hover-revealed openers are revealed by the probe itself)",
  check: "a checked box is state, not navigation",
  select: "a selected option is state, not navigation"
};
function describeStep(s, i) {
  const [k, v] = Object.entries(s)[0] ?? ["?", ""];
  return `step ${i + 1} {${k}: ${JSON.stringify(v)}}`;
}
function isSameOriginPath(v) {
  return v.startsWith("/") && !v.startsWith("//") && !/[\\\s\u0000-\u001f\u007f]/.test(v);
}
function parseSteps(x) {
  const list = Array.isArray(x) ? x : isJsonObject(x) && x.navigate !== void 0 ? x.navigate : void 0;
  if (!Array.isArray(list)) {
    return { error: isJsonObject(x) ? "holds no `navigate` list \u2014 pass a JSON array of steps, or a plan with navigate: [...]" : "is not a list of steps (a JSON array, or a plan with navigate: [...])" };
  }
  const steps = [];
  for (const [i, raw] of list.entries()) {
    const at = `step ${i + 1}`;
    if (!isJsonObject(raw)) return { error: `${at} is not an object like {"click": "<selector>"}` };
    const keys = Object.keys(raw);
    const k = keys[0];
    if (keys.length !== 1 || k === void 0) return { error: `${at} has ${keys.length ? `${keys.length} keys (${keys.join(", ")})` : "no key"} \u2014 exactly one of ${STEP_KINDS.join(" / ")}` };
    const v = raw[k];
    if (!isStepKind(k)) {
      const lk = k.toLowerCase();
      const why = Object.hasOwn(REFUSED, k) ? REFUSED[k] : Object.hasOwn(REFUSED, lk) ? REFUSED[lk] : void 0;
      return { error: `${at} {${k}: \u2026} is not a step \u2014 the vocabulary is ${STEP_KINDS.join(" / ")} (navigation only)${why ? `: ${why}` : ""}` };
    }
    if (typeof v !== "string" || v.trim() === "") return { error: `${at} {${k}: \u2026} needs a non-empty string` };
    if (k === "goto" && !isSameOriginPath(v)) return { error: `${at} {goto: ${JSON.stringify(v)}} must be a same-origin path starting with "/" (e.g. "/orders?tab=open") \u2014 never "//" or "/\\", and no backslash, whitespace or control character` };
    steps.push(k === "click" ? { click: v } : k === "waitFor" ? { waitFor: v } : { goto: v });
  }
  return { steps };
}
function stepsSha256(steps) {
  return crypto.createHash("sha256").update(canonical(steps)).digest("hex");
}
function isPlanExpect(x) {
  return x === "dialog" || x === "url" || typeof x === "string" && x.startsWith("selector:") && x.length > "selector:".length;
}

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var isObj = isJsonObject;
var optObj = (x) => x === void 0 || isObj(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isObj(x);
function isVariable(x) {
  return isObj(x) && typeof x.name === "string" && typeof x.type === "string" && isObj(x.values) && optStr(x.collection);
}
function isVariableCollection(x) {
  return isObj(x) && typeof x.name === "string" && isStringArray(x.modes);
}
function isTokensDoc(x) {
  return isObj(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection) && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === void 0 || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";
function isCatalogComponent(x) {
  return isObj(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
function isComponentsCatalog(x) {
  return isObj(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";
function isComponentDetailFile(x) {
  return isObj(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";
function isTextStylesDoc(x) {
  return isObj(x) && Array.isArray(x.styles) && x.styles.every((s) => isObj(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, \u2026}";
function isScreenAssetsDoc(x) {
  return isObj(x) && optArrayOf(x.heavy, (h) => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number") && optArrayOf(x.files, (f) => isObj(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";
function isLibrariesIndex(x) {
  return isObj(x) && Array.isArray(x.libraries) && x.libraries.every((r) => isObj(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === void 0 || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";
var SEVERITIES = ["blocker", "warning", "info"];
function isAuditOverridesDoc(x) {
  return isObj(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isObj(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity) && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";
function isAuditReport(x) {
  return isObj(x) && isObj(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isObj(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";
function isProposal(x) {
  return isObj(x) && typeof x.name === "string";
}
function isProposalList(x) {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, \u2026}";
function isIndexRowLike(x) {
  return isObj(x) && typeof x.id === "string" && typeof x.name === "string";
}
function isPagesRootIndex(x) {
  return isObj(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isObj(d) && optStr(d.dir) && optStr(d.index)) && (x.layers === void 0 || Array.isArray(x.layers) && x.layers.every(isIndexRowLike));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
function isPageIndex(x) {
  return isObj(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";
function isVerifyExpectation(x) {
  return isObj(x) && isObj(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
var isNameVersion = (x) => isObj(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
function isProbeIdentity(x) {
  return isObj(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string" && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
function isBuildIdentity(x) {
  return isObj(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.unhashed === void 0 || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
var isCountMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isTagsNotInExpectation = (x) => isObj(x) && typeof x.count === "number" && Array.isArray(x.ids) && x.ids.every((r) => isObj(r) && typeof r.id === "string" && typeof r.elements === "number");
var isReasonMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
function isProbeReach(x) {
  return isObj(x) && Array.isArray(x.steps) && x.steps.every(isObj) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
function isPageOverflow(x) {
  return isObj(x) && isObj(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth) && typeof x.overflowX === "string" && typeof x.scrollable === "boolean" && Array.isArray(x.offenders) && x.offenders.every((o) => isObj(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right)) && optStr(x.compatMode);
}
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // group 10: the run it belongs to (F-72) and the build it was served (DT-81)
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"],
  // group 11 (DT-47): the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // group 12a: the steps replayed (L-1), the page's overflow (D43), the behaviour seam (12b)
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} \u2014 page overflow not measured"],
  ["behaviour", isObj, "an object (behaviour checks)"]
];
function isMeasuredCore(x) {
  return isObj(x) && optArrayOf(x.nodes, (n) => isObj(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
function isVerifyMeasured(x) {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === void 0 || ok(x[k])) && (x.nodes === void 0 || Array.isArray(x.nodes) && x.nodes.every((n) => !isObj(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)));
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isObj(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isMeasuredComponentList(x) {
  return Array.isArray(x) && x.every((c) => isObj(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === void 0 || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";
function isVerifyReport(x) {
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && (x.integrity === void 0 || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "waivers", "descopes"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isObj)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isObj(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isObj(x.anchors) && !Object.values(x.anchors).every(isObj)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isObj(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== void 0 && x.target !== null && typeof x.target !== "string" && !isObj(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== void 0 && x.tagging !== null && !(isObj(x.tagging) && (x.tagging.off === void 0 || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return 'is not a valid plan: `tagging` must be {"off": true, "reason": "\u2026"}';
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isObj(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isObj(x.verification) && x.verification.hook !== void 0 && !isObj(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  for (const k of ["navigate", "interactions"]) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isPlanInteraction(x) {
  return isObj(x) && reqStr(x.nodeId) && reqStr(x.trigger) && isPlanExpect(x.expect) && (x.destinationId === void 0 || reqStr(x.destinationId)) && optStr(x.name);
}
isPlanInteraction.expected = "a plan interaction {nodeId, trigger, expect: dialog | url | selector:<css>, destinationId?, name?}";
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/verify-run.ts
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import crypto2 from "node:crypto";

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
var scriptCmd = (name) => `node ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;
function errCode(e) {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;
}
function joinNegativeValues(argv, options) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i], next = argv[i + 1];
    if (tok === void 0) continue;
    if (tok === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const name = tok.startsWith("--") ? tok.slice(2) : void 0;
    if (name !== void 0 && next !== void 0 && options[name]?.type === "string" && /^-\d/.test(next)) {
      out.push(`${tok}=${next}`);
      i++;
    } else out.push(tok);
  }
  return out;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  const args = joinNegativeValues(argv, options);
  try {
    return parse(args);
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
      const unknown = [...new Set(tokens.flatMap((t) => t.kind === "option" && !(t.name in options) ? [t.rawName] : []))];
      console.error(`${tool}: unknown flag ${unknown.join(", ")}
${usage}`);
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const m = /Option '(-[\w-]+|--[\w-]+)/.exec(msg);
      console.error(`${tool}: ${m ? m[1] : "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}
${usage}`);
    } else {
      console.error(`${tool}: ${e instanceof Error ? e.message : String(e)}
${usage}`);
    }
    process.exit(exitCode);
  }
}

// design-to-code/verify-run.ts
var STATUS_SCHEMA = "designtwin/verify-status@2";
var STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
var isPhase = (x) => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
var optStr2 = (x) => x === void 0 || typeof x === "string";
function isVerifyStatusV2(x) {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number" && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator") && optStr2(x.expectationSha256) && optStr2(x.measuredSha256) && optStr2(x.evidenceSha256) && (x.published === void 0 || Array.isArray(x.published) && x.published.every((p) => typeof p === "string"));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";
var statusFile = (base) => base + ".status.json";
var sha256Of = (data) => crypto2.createHash("sha256").update(data).digest("hex");
var CACHE_NAME = "designtwin-verify";
var shortSha = (s) => sha256Of(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs2.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs2.existsSync(p);
function realpath(p) {
  if (typeof fs2.realpathSync.native === "function") {
    try {
      return fs2.realpathSync.native(p);
    } catch {
    }
  }
  return fs2.realpathSync(p);
}
function canonical2(p) {
  const abs = path2.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path2.dirname(abs);
    return parent === abs ? abs : path2.join(canonical2(parent), path2.basename(abs));
  }
}
var hasPnp = (d) => exists(path2.join(d, ".pnp.cjs")) || exists(path2.join(d, ".pnp.js"));
function isWorkspaceRoot(d) {
  if (exists(path2.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path2.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== void 0;
}
function installRootOf(dir) {
  let P = null;
  for (let d = dir; ; d = path2.dirname(d)) {
    if (exists(path2.join(d, "package.json"))) {
      P = d;
      break;
    }
    if (exists(path2.join(d, ".git")) || path2.dirname(d) === d) return null;
  }
  if (isDir(path2.join(P, "node_modules"))) return P;
  let ws = null;
  for (let d = P; ; d = path2.dirname(d)) {
    if (isWorkspaceRoot(d)) {
      ws = d;
      break;
    }
    if (exists(path2.join(d, ".git")) || path2.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path2.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || ws !== null && hasPnp(ws)) return null;
  return P;
}
function runCacheOf(verifyDir) {
  const v = canonical2(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path2.join(root, "node_modules", ".cache", CACHE_NAME);
    const rel = path2.relative(root, v).split(path2.sep).join("/");
    return { dir: rel === "design/verify" ? cache : path2.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path2.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}
var UNWRITABLE_CODES = /* @__PURE__ */ new Set(["EACCES", "EPERM", "EROFS", "ENOENT"]);
var errCode2 = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;
var RunCacheUnwritable = class extends Error {
  cacheDir;
  root;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT is not a
   *  permission: a directory on the way was removed while the run wrote there (L-4) */
  constructor(cacheDir, root, code) {
    super(code === "ENOENT" ? `run cache ${cacheDir} disappeared \u2014 was node_modules reinstalled during the run? (a reinstall clears node_modules/.cache: the live status and the staged files with it) \u2014 start a new run once it is back` : `run cache ${cacheDir} is not ${code === "read" ? "readable" : "writable"} (sandbox write scope?) \u2014 run from ${root} or allow ${code === "read" ? "access" : "writes"} there`);
    this.name = "RunCacheUnwritable";
    this.cacheDir = cacheDir;
    this.root = root;
  }
};
function inRunCache(verifyDir, fn) {
  try {
    return fn();
  } catch (e) {
    const code = errCode2(e);
    if (code !== void 0 && UNWRITABLE_CODES.has(code)) {
      const c = runCacheOf(verifyDir);
      throw new RunCacheUnwritable(c.dir, c.root, code);
    }
    throw e;
  }
}
var liveStatusFile = (base) => path2.join(runCacheDir(path2.dirname(base)), path2.basename(base) + ".status.json");
var stageDirOf = (base, runId) => path2.join(runCacheDir(path2.dirname(base)), "stage", runId);
function writeFileAtomic(file, data) {
  fs2.mkdirSync(path2.dirname(path2.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs2.writeFileSync(tmp, data);
    fs2.renameSync(tmp, file);
  } catch (e) {
    try {
      fs2.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function readStatusFile(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  return isJsonObject(r.doc) && r.doc.schema === void 0 && typeof r.doc.phase === "string" ? "v1" : null;
}
function readStatusAt(base) {
  for (const file of [liveStatusFile(base), statusFile(base)]) {
    const status = readStatusFile(file);
    if (status !== null) return { file, status };
  }
  return null;
}
function readStatus(base) {
  const r = readStatusAt(base);
  return r ? r.status : null;
}
function writeStatus(base, p) {
  const prev = readStatus(base);
  const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
  const pick = (k) => {
    const v = p[k] ?? (same ? same[k] : void 0);
    return v !== void 0 ? { [k]: v } : {};
  };
  const published = p.published !== void 0 || same && same.published ? [.../* @__PURE__ */ new Set([...same && same.published || [], ...p.published || []])].sort() : void 0;
  const doc = {
    schema: STATUS_SCHEMA,
    screen: path2.basename(base),
    runId: p.runId,
    rev: same ? same.rev + 1 : 1,
    phase: p.phase,
    detail: p.detail ?? "",
    at: (/* @__PURE__ */ new Date()).toISOString(),
    by: p.by,
    ...pick("expectationSha256"),
    ...pick("measuredSha256"),
    ...pick("evidenceSha256"),
    ...published !== void 0 ? { published } : {}
  };
  const live = liveStatusFile(base);
  inRunCache(path2.dirname(base), () => writeFileAtomic(live, JSON.stringify(doc, null, 2) + "\n"));
  return doc;
}

// design-to-code/export-shape.ts
function isIrNode(x) {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.type === "string" && (x.children === void 0 || Array.isArray(x.children));
}
function isScreenExport(x) {
  return isJsonObject(x) && Array.isArray(x.nodes) && x.nodes.every(isIrNode);
}
function isLayerFile(x) {
  return isJsonObject(x) && !Array.isArray(x.nodes) && isIrNode(x.tree);
}
function isScreenDoc(x) {
  return isScreenExport(x) || isLayerFile(x) || isIrNode(x);
}
isScreenDoc.expected = "a screen export: {nodes:[\u2026]} whose every node has a string id and type, a layer file {tree: node}, or a bare node {id, type, \u2026}";

// design-to-code/color.ts
var HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function normHex(v) {
  if (typeof v !== "string") return null;
  const g = HEX.exec(v.trim())?.[1];
  if (g === void 0) return null;
  const h = g.toLowerCase();
  return "#" + (h.length <= 4 ? h.split("").map((c) => c + c).join("") : h);
}
function colorKey(v) {
  const h = normHex(v);
  return h === null ? null : h.length === 7 ? h + "ff" : h;
}

// bridge/src/is-main.ts
import fs3 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs3.realpathSync(argv1) === fs3.realpathSync(fileURLToPath2(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/verify-screen.ts
var TOLERANCE = {
  fontSize: 0.5,
  // a browser rounds; a different token does not
  fontWeight: 0,
  // 500 vs 600 is a different style, never a rendering artifact
  lineHeight: 2,
  // normal/unitless line-heights and font-metric rounding genuinely differ
  letterSpacing: 0.2,
  radius: 0.5,
  padding: 1,
  gap: 1,
  // 1, not 2: a 2px box error is exactly a border put on the wrong side of the box — the filter button
  // measured 111.83×38 against 110×36 and the old inclusive 2px tolerance emitted nothing (finding 193).
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place (finding 192) or a bar 130px below the frame (164) cannot hide.
  position: 2,
  opacity: 0.02,
  // DT-74 (D34): a stroke's own tolerance, inclusive — a lost 1px border (1 → 0) is a delta; the padding tolerance (1) let it pass
  stroke: 0.5,
  // DT-75 (D29): a fixed/fill-width TEXT's INK width (renderBox.w) against a Range's width (the layout advance box,
  // side bearings included). Empirical: hand-written textBox.w − renderBox.w was −0.63..+2.41 px (p5..p95, n=157)
  // in the field runs. Known miss: heavy italics/overhang can exceed it.
  textInk: 3
};
function normColor(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  const key = colorKey(s);
  if (key) return key;
  const inner = /^rgba?\(([^)]+)\)$/.exec(s)?.[1];
  if (inner !== void 0) {
    const p = inner.split(/[,\s/]+/).filter(Boolean).map(Number);
    const [r, g, b, a0] = p;
    if (r === void 0 || g === void 0 || b === void 0 || p.some((n) => Number.isNaN(n))) return s;
    const a = a0 ?? 1;
    if (a === 0) return "transparent";
    const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
    return "#" + hex(r) + hex(g) + hex(b) + hex(Math.round(a * 255));
  }
  if (s === "transparent" || s === "rgba(0, 0, 0, 0)") return "transparent";
  return s;
}
var WEIGHTS = {
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900
};
function normWeight(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}
function normFamily(v) {
  if (v == null) return null;
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}
var FIELDS = [
  { key: "fontFamily", tol: null, norm: normFamily, label: "font-family" },
  { key: "fontSize", tol: TOLERANCE.fontSize, label: "font-size", unit: "px", high: true },
  { key: "fontWeight", tol: TOLERANCE.fontWeight, norm: normWeight, label: "font-weight", high: true },
  { key: "lineHeight", tol: TOLERANCE.lineHeight, label: "line-height", unit: "px" },
  { key: "letterSpacing", tol: TOLERANCE.letterSpacing, label: "letter-spacing", unit: "px" },
  { key: "color", tol: null, norm: normColor, label: "color", high: true, colour: true },
  { key: "backgroundColor", tol: null, norm: normColor, label: "background", high: true, colour: true },
  { key: "fill", tol: null, norm: normColor, label: "fill (SVG paint)", high: true, colour: true },
  { key: "placeholderColor", tol: null, norm: normColor, label: "placeholder colour", high: true, colour: true, optional: true },
  { key: "borderColor", tol: null, norm: normColor, label: "border-color", colour: true },
  { key: "borderWidth", tol: TOLERANCE.stroke, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px", box: true },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px", box: true },
  { key: "x", tol: TOLERANCE.position, label: "x (frame-relative)", unit: "px", box: true },
  { key: "y", tol: TOLERANCE.position, label: "y (frame-relative)", unit: "px", box: true },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" }
];
var STYLE_KEYS = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display"];
var STYLE_KEY_SHAPE = {
  borderRadius: "number | [tl,tr,br,bl]",
  padding: "[t,r,b,l]",
  fill: "an SVG's paint",
  textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder",
  placeholderColor: "the ::placeholder colour",
  tag: "tagName, lower-case",
  display: "getComputedStyle(el).display"
};
var MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (DT-23: `fill` was missing)
  "nodes[].styles": `computed values, EVERY key on every node \u2014 lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) \u2014 (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null \u2014 a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required for every TEXT node: its x/width are never read off the element's box",
  "nodes[].styles.display": "getComputedStyle(el).display \u2014 a FRAME/INSTANCE id on an inline element measures its text's box, not a frame's",
  "nodes[].styles.strokeFrom / strokeAlign": "where borderWidth/borderColor were read: border, or a ring (box-shadow spread / outline) and its side (inside | outside)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state \u2014 required for a node whose spec has drawnState",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} \u2014 `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} \u2014 present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find \u2014 the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against"
};
var CANONICAL_MATCH = new Set(CANONICAL_MATCHED_BY);
var INTERACTION_OUTCOMES = ["url-changed", "dialog-opened", "selector-appeared", "state-changed", "none"];
var ANY_BUT_NONE = INTERACTION_OUTCOMES.filter((o) => o !== "none");
if (false) {
  const code = main(process.argv.slice(2));
  if (typeof code === "number") process.exitCode = code;
  else code.then((c) => {
    process.exitCode = c;
  }, (e) => {
    console.error(`verify-screen: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}

// design-to-code/probe-drive.ts
import { setTimeout as sleep } from "node:timers/promises";
function readPageOverflow(_arg) {
  const de = document.documentElement, body = document.body;
  const hs = getComputedStyle(de);
  const hx = hs.getPropertyValue("overflow-x"), hy = hs.getPropertyValue("overflow-y");
  const overflowX = hx === "visible" && hy === "visible" && body ? getComputedStyle(body).getPropertyValue("overflow-x") : hx;
  const scrollWidth = de.scrollWidth, clientWidth = de.clientWidth;
  const scrollable = scrollWidth > clientWidth + 1 && overflowX !== "hidden" && overflowX !== "clip";
  const offenders = [];
  if (scrollWidth > clientWidth + 1 && body) {
    const pathOf = (el) => {
      const parts = [];
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const parent = cur.parentElement;
        if (!parent) break;
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
        cur = parent;
      }
      parts.unshift("html");
      return parts.join(" > ");
    };
    const createsBlock = (cs) => {
      const v = (k) => cs.getPropertyValue(k);
      if (["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => {
        const x = v(k);
        return x !== "" && x !== "none";
      })) return true;
      if (v("transform-style") === "preserve-3d") return true;
      return /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(v("will-change"));
    };
    const containsAll = (cs) => /\b(layout|paint|strict|content)\b/.test(cs.getPropertyValue("contain")) || ["auto", "hidden"].includes(cs.getPropertyValue("content-visibility"));
    const contained = (el) => {
      const own = getComputedStyle(el).getPropertyValue("position");
      let mode = own === "fixed" ? "fixed" : own === "absolute" ? "absolute" : "flow";
      for (let p = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
        const cs = getComputedStyle(p);
        const pos = cs.getPropertyValue("position");
        const block = createsBlock(cs), all = containsAll(cs);
        if (mode === "fixed" && !block && !all) continue;
        if (mode === "absolute" && pos === "static" && !block && !all) continue;
        if (all || cs.getPropertyValue("overflow-x") !== "visible") return true;
        mode = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "flow";
      }
      if (mode !== "fixed") return false;
      return ![body, de].some((x) => {
        const cs = getComputedStyle(x);
        return createsBlock(cs) || containsAll(cs);
      });
    };
    const past = [];
    for (const el of Array.from(body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      const right = r.right + scrollX;
      if (r.width > 0 && right > clientWidth + 1 && !contained(el)) past.push({ el, right });
    }
    past.sort((a, b) => b.right - a.right);
    const chosen = [];
    for (const p of past) {
      if (chosen.length >= 5) break;
      if (chosen.some((c) => c.contains(p.el))) continue;
      chosen.push(p.el);
      const tagged = p.el.closest("[data-dt-node]");
      offenders.push({ path: pathOf(p.el), dt: tagged ? tagged.getAttribute("data-dt-node") : null, right: Math.round(p.right) });
    }
  }
  return { viewport: { w: innerWidth, h: innerHeight }, scrollWidth, clientWidth, overflowX, scrollable, offenders, compatMode: document.compatMode };
}
function openerState(arg) {
  const pathOf = (el2) => {
    const parts = [];
    let cur = el2;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const hasBox = (el2) => el2.getClientRects().length > 0;
  const sees = (el2, opacity) => {
    if (!hasBox(el2)) return false;
    const r = el2.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el2.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: opacity });
  };
  const sel = `[data-dt-node="${arg.id.replace(/["\\]/g, "\\$&")}"]`;
  let els = Array.from(document.querySelectorAll(sel)).filter((e) => e.closest("dialog:not([open])") === null);
  if (els.length > 1) els = els.filter(hasBox);
  const el = els.length === 1 ? els[0] : void 0;
  if (!el) return { count: els.length, path: null, visible: false, disabled: false, hoverPath: null, hoverDt: null };
  const visible = sees(el, true);
  const disabled = el.closest(':disabled, [disabled], [aria-disabled="true" i]') !== null;
  let hoverPath = null, hoverDt = null;
  if (!visible) {
    let plain = null;
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!sees(p, false)) continue;
      const dt = p.getAttribute("data-dt-node");
      if (dt !== null) {
        hoverPath = pathOf(p);
        hoverDt = dt;
        break;
      }
      if (!plain) plain = p;
    }
    if (hoverPath === null && plain) hoverPath = pathOf(plain);
  }
  return { count: 1, path: pathOf(el), visible, disabled, hoverPath, hoverDt };
}
var DIALOG_CONTRACT = [":modal", "dialog[open]", "[role=dialog]", "[role=alertdialog]", '[aria-modal="true"]', ":popover-open"];
function armDetector(arg) {
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const seen = (el) => {
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true });
  };
  const before = [];
  for (const s of arg.contract) {
    try {
      for (const el of Array.from(document.querySelectorAll(s))) if (seen(el)) before.push(el);
    } catch {
    }
  }
  const destBefore = arg.destId === null ? [] : Array.from(document.querySelectorAll(`[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`)).filter(seen);
  window.__dtDrive = { before, destBefore, destPaths: destBefore.map(pathOf) };
  return true;
}
function pollDetector(arg) {
  const st = window.__dtDrive;
  if (!st) return { lost: true, detectedBy: null, opened: null, dest: null };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (!parent) break;
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
      cur = parent;
    }
    parts.unshift("html");
    return parts.join(" > ");
  };
  const seen = (el) => {
    if (el.getClientRects().length === 0) return false;
    const r2 = el.getBoundingClientRect();
    return r2.width > 0 && r2.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true });
  };
  let opened = null, detectedBy = null;
  for (const s of arg.contract) {
    let hits = [];
    try {
      hits = Array.from(document.querySelectorAll(s)).filter((el) => seen(el) && !st.before.includes(el));
    } catch {
      continue;
    }
    const first = hits[0];
    if (first) {
      opened = first;
      detectedBy = s;
      break;
    }
  }
  let dest = null;
  if (arg.destId !== null) {
    const tags = Array.from(document.querySelectorAll(`[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`)).filter(seen);
    const fresh = tags.filter((t) => !st.destBefore.includes(t) && !st.destPaths.includes(pathOf(t)));
    const firstFresh = fresh[0];
    if (opened === null && firstFresh) opened = firstFresh;
    const o = opened;
    dest = { count: tags.length, inside: o !== null && tags.some((t) => t === o || o.contains(t) || t.contains(o) && fresh.includes(t)), newly: fresh.length > 0 };
  }
  if (!opened) return { lost: false, detectedBy: null, opened: null, dest };
  let modal = false;
  try {
    modal = opened.matches(":modal");
  } catch {
  }
  const r = opened.getBoundingClientRect();
  return {
    lost: false,
    detectedBy,
    dest,
    opened: {
      selector: pathOf(opened),
      modal,
      position: getComputedStyle(opened).getPropertyValue("position"),
      rect: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
      scrollY: Math.round(scrollY)
    }
  };
}
function syntheticClick(path4) {
  const el = document.querySelector(path4);
  if (!el) return false;
  el.click();
  return true;
}
function submitGuard(el) {
  const why = (target) => {
    const ctl = target.closest("button, input") || target;
    const tag = ctl.tagName.toLowerCase();
    const type = (ctl.getAttribute("type") || "").toLowerCase();
    if (type === "submit") return `<${tag} type=submit>`;
    if (tag === "input" && type === "image") return "<input type=image>";
    if (tag === "button" && !ctl.hasAttribute("type") && ctl.form) return "a <button> without a type inside a <form> (it submits)";
    return null;
  };
  const own = why(el);
  if (own !== null) return own;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  let onScreen = false, cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  for (const q of Array.from(el.getClientRects())) {
    const x0 = Math.min(Math.max(q.x, 0), vw), x1 = Math.min(Math.max(q.right, 0), vw);
    const y0 = Math.min(Math.max(q.y, 0), vh), y1 = Math.min(Math.max(q.bottom, 0), vh);
    if ((x1 - x0) * (y1 - y0) > 0.99) {
      onScreen = true;
      cx = (x0 + x1) / 2;
      cy = (y0 + y1) / 2;
      break;
    }
  }
  const at = [];
  const hit = onScreen ? document.elementFromPoint(cx, cy) : null;
  if (hit && hit !== el && el.contains(hit)) at.push(hit);
  else if (!hit) {
    for (const c of Array.from(el.querySelectorAll("button, input"))) {
      const b = c.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height && c.checkVisibility({ visibilityProperty: true })) at.push(c);
    }
  }
  for (const t of at) {
    const w = why(t);
    if (w !== null) return `${w} at its click point`;
  }
  return null;
}
var OVERLAY_ACTIONS = /* @__PURE__ */ new Set(["overlay", "swap"]);
var CLICK_TRIGGERS = /* @__PURE__ */ new Set(["on_click", "on_press"]);
function drivable(exp) {
  const hidden = new Set(exp.hidden && exp.hidden.ids || []);
  const keys = /* @__PURE__ */ new Set();
  const rows = (exp.interactions || []).filter((r) => {
    if (hidden.has(r.nodeId)) return false;
    const trigger = String(r.trigger).toLowerCase();
    const ok = CLICK_TRIGGERS.has(trigger) && (OVERLAY_ACTIONS.has(String(r.action).toLowerCase()) || r.source === "plan" && r.expect === "dialog");
    const key = `${r.nodeId}|${trigger}`;
    if (!ok || keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return [...rows.filter((r) => r.destinationExported !== false), ...rows.filter((r) => r.destinationExported === false)];
}
var DRIVE_CAP_MS = 6e4;
var DRIVE_RESERVE_MS = 15e3;
function driveBudget(now, deadline, capMs = DRIVE_CAP_MS, reserveMs = DRIVE_RESERVE_MS) {
  return Math.max(0, Math.min(capMs, deadline - now - reserveMs));
}
function classifyOutcome(action, read) {
  const destNew = !!(read.dest && read.dest.newly);
  if (String(action).toLowerCase() === "swap") {
    if (destNew) return { outcome: "selector-appeared", detectedBy: read.detectedBy ?? "destination-tag" };
    return read.detectedBy ? { outcome: "dialog-opened", detectedBy: read.detectedBy } : { outcome: "none" };
  }
  if (read.detectedBy) return { outcome: "dialog-opened", detectedBy: read.detectedBy };
  if (destNew && read.opened) return { outcome: "selector-appeared", detectedBy: "destination-tag" };
  return { outcome: "none" };
}
var ALLOWED = { overlay: ["dialog-opened", "selector-appeared"], swap: ["state-changed", "selector-appeared"] };
function judge(action, e) {
  const missing = [];
  const allowed = ALLOWED[String(action).toLowerCase()] ?? ALLOWED.overlay ?? [];
  if (e.selectorCount !== 1) missing.push(`the opener matched ${e.selectorCount ?? 0} element(s)`);
  if (e.outcome === void 0 || !allowed.includes(e.outcome)) missing.push(e.outcome === "none" || e.outcome === void 0 ? "nothing of the dialog contract opened within 2 s" : `outcome ${e.outcome} is not one a ${action} produces`);
  if (e.navEvents !== 0) missing.push(`${e.navEvents ?? "?"} document load(s) during the interaction`);
  if (!e.destination) missing.push("no destination frame id to look for");
  else if (!e.destination.inside) missing.push(e.destination.count ? `the destination tag data-dt-node="${e.destination.nodeId}" is not inside the opened element` : `no visible element is tagged with the destination data-dt-node="${e.destination.nodeId}" \u2014 tag the dialog's root with it`);
  if (e.activation !== "mouse") missing.push("synthetic click (headless) \u2014 not a user activation");
  return { ok: missing.length ? null : true, missing };
}
var StepError = class extends Error {
};
var raf2 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
var CLOSED = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;
var NAVIGATED = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
var firstLine = (e) => errMsg(e).split("\n")[0] ?? "";
var notRun = (row, detail, extra) => ({ nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `not-run: ${detail}`, ...extra });
async function openReached(browser, o, extra) {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: extra?.dsf ?? 1, reducedMotion: "reduce" });
  if (extra && extra.onContext) extra.onContext(context);
  let loads = 0;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout);
    await page.addInitScript({ content: o.initScript });
    page.on("load", () => {
      loads++;
    });
    await o.reach(page);
    return { context, page, loads: () => loads };
  } catch (e) {
    await context.close().catch(() => void 0);
    throw e;
  }
}
async function driveRow(browser, o, row, hooks, onContext) {
  const action = row.source === "plan" && row.expect === "dialog" ? "overlay" : String(row.action ?? "overlay").toLowerCase();
  const destId = row.destinationId ?? null;
  let opened;
  try {
    opened = await openReached(browser, { viewport: o.viewport, timeout: o.timeout, initScript: o.initScript, reach: o.reach }, { onContext });
  } catch (e) {
    if (e instanceof StepError) return notRun(row, `the steps failed \u2014 ${e.message}`, { stepsFailed: e.message });
    return notRun(row, `could not reach the screen \u2014 ${firstLine(e)}`);
  }
  const { context, page, loads } = opened;
  const selector = `[data-dt-node="${row.nodeId.replace(/["\\]/g, "\\$&")}"]`;
  try {
    let st = await page.evaluate(openerState, { id: row.nodeId });
    const base = { nodeId: row.nodeId, trigger: row.trigger, selector, selectorCount: st.count };
    if (st.count !== 1 || st.path === null) return { ...base, ok: null, detail: `the opener ${selector} matched ${st.count} element(s) outside a closed dialog \u2014 not driven` };
    if (st.disabled) return { ...base, ok: null, detail: "opener is disabled \u2014 not driven" };
    if (st.visible) await page.locator(st.path).first().scrollIntoViewIfNeeded({ timeout: 2e3 }).catch(() => void 0);
    const submits = await page.locator(st.path).first().evaluate(submitGuard);
    if (submits !== null) return { ...base, ok: null, detail: `opener would submit a form (${submits}) \u2014 not driven` };
    let revealedBy;
    if (!st.visible) {
      if (st.hoverPath !== null) {
        revealedBy = st.hoverDt !== null ? `[data-dt-node="${st.hoverDt}"]` : st.hoverPath;
        await page.mouse.move(0, 0);
        await page.locator(st.hoverPath).first().hover({ timeout: 2e3 }).catch(() => void 0);
        await raf2(page);
        st = await page.evaluate(openerState, { id: row.nodeId });
      }
      if (!st.visible || st.path === null) return { ...base, ok: null, ...revealedBy !== void 0 ? { revealedBy } : {}, detail: `opener not visible even on hover${revealedBy !== void 0 ? ` (hovered ${revealedBy})` : " (no visible ancestor to hover)"} \u2014 not driven` };
    }
    const openerPath = st.path;
    const contract = [...DIALOG_CONTRACT];
    await page.evaluate(armDetector, { destId, contract });
    const tokenBefore = String(await page.evaluate("window.__dtProbeDoc || ''"));
    const loadsBefore = loads();
    let activation = "mouse", clickWhy = "";
    try {
      await page.locator(openerPath).first().click({ timeout: 2e3 });
    } catch (e) {
      const m = errMsg(e);
      if (CLOSED.test(m)) throw e;
      if (!NAVIGATED.test(m)) {
        clickWhy = (/intercepts pointer events|not visible|not enabled|not stable|outside of the viewport/.exec(m) || [firstLine(e)])[0] ?? "";
        activation = "synthetic";
        await page.evaluate(syntheticClick, openerPath);
      }
    }
    const t0 = Date.now();
    let read = { lost: false, detectedBy: null, opened: null, dest: null };
    let detectedAt = null;
    for (; ; ) {
      try {
        read = await page.evaluate(pollDetector, { destId, contract });
      } catch (e) {
        if (CLOSED.test(errMsg(e))) throw e;
        if (!NAVIGATED.test(errMsg(e))) throw e;
        read = { lost: true, detectedBy: null, opened: null, dest: null };
      }
      if (read.lost) break;
      if (read.detectedBy !== null && detectedAt === null) detectedAt = Date.now();
      const destDone = destId === null || read.dest !== null && read.dest.inside;
      if (read.opened && destDone) break;
      if (detectedAt !== null && Date.now() - detectedAt >= 500) break;
      if (Date.now() - t0 >= 2e3) break;
      await sleep(100);
    }
    if (read.lost) await page.waitForLoadState("load", { timeout: 2e3 }).catch(() => void 0);
    let tokenAfter = "";
    try {
      tokenAfter = String(await page.evaluate("window.__dtProbeDoc || ''"));
    } catch {
      tokenAfter = "";
    }
    const navEvents = Math.max(loads() - loadsBefore, tokenAfter !== tokenBefore || read.lost ? 1 : 0);
    const { outcome, detectedBy } = read.lost ? { outcome: "none", detectedBy: void 0 } : classifyOutcome(action, read);
    const ev = {
      ...base,
      outcome,
      navEvents,
      activation,
      ...detectedBy !== void 0 ? { detectedBy } : {},
      ...revealedBy !== void 0 ? { revealedBy } : {},
      ...destId !== null ? { destination: { nodeId: destId, inside: !read.lost && !!read.dest && read.dest.inside, count: read.dest ? read.dest.count : 0 } } : {},
      ...read.opened && !read.lost ? { opened: read.opened } : {}
    };
    const j = judge(action, ev);
    const how = `${activation === "mouse" ? "clicked" : `synthetic click (${clickWhy})`}${revealedBy !== void 0 ? ` after hovering ${revealedBy}` : ""}`;
    const saw = read.lost ? "the page loaded a new document" : detectedBy !== void 0 ? `${detectedBy === "destination-tag" ? "the destination tag appeared" : `${detectedBy} opened`}` : "nothing opened";
    ev.ok = j.ok;
    ev.detail = j.ok ? `${how}: ${saw}, destination ${destId} inside` : `${how}: ${saw} \u2014 ${j.missing.join("; ")}`;
    if (hooks && hooks.afterOpen && read.opened && !read.lost) await hooks.afterOpen(page, row, read.opened);
    return ev;
  } finally {
    await context.close().catch(() => void 0);
  }
}
var CUT_SETTLE_MS = 5e3;
async function driveInteractions(browser, o, hooks) {
  const out = [];
  const end = Date.now() + o.budgetMs;
  for (const row of o.rows) {
    const left = end - Date.now();
    if (left <= 0) {
      out.push(notRun(row, "time budget", { cut: "budget" }));
      continue;
    }
    const held = {};
    let timer;
    const cut = new Promise((resolve) => {
      timer = setTimeout(() => resolve("cut"), left);
    });
    const work = driveRow(browser, o, row, hooks, (c) => {
      held.ctx = c;
    }).catch((e) => {
      if (CLOSED.test(errMsg(e))) return notRun(row, `the browser closed while driving \u2014 ${firstLine(e)}`);
      return { nodeId: row.nodeId, trigger: row.trigger, ok: null, detail: `driving failed: ${firstLine(e)}` };
    });
    const r = await Promise.race([work, cut]);
    clearTimeout(timer);
    if (r === "cut") {
      if (held.ctx) await held.ctx.close().catch(() => void 0);
      await Promise.race([work, sleep(CUT_SETTLE_MS, void 0, { ref: false })]);
      out.push(notRun(row, "time budget", { cut: "budget" }));
      continue;
    }
    out.push(r);
  }
  return out;
}

// design-to-code/verify-probe.ts
var PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];
function isPlaywrightModule(x) {
  if (typeof x !== "object" || x === null || !("chromium" in x)) return false;
  const c = x.chromium;
  return typeof c === "object" && c !== null && "launch" in c && typeof c.launch === "function";
}
function installHint(dir) {
  const has = (f) => fs4.existsSync(path3.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm add -D playwright && pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn add -D playwright && yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bun add -d playwright && bunx playwright install chromium";
  return "npm i -D playwright && npx playwright install chromium";
}
function browserHint(dir) {
  const has = (f) => fs4.existsSync(path3.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bunx playwright install chromium";
  return "npx playwright install chromium";
}
function resolvePlaywright(dir) {
  const abs = path3.resolve(dir);
  const req = createRequire(path3.join(abs, "package.json"));
  const tried = [];
  for (const name of PLAYWRIGHT_PACKAGES) {
    let file;
    try {
      file = req.resolve(name);
    } catch {
      tried.push(`${name}: not installed`);
      continue;
    }
    let mod;
    try {
      mod = req(name);
    } catch (e) {
      tried.push(`${name}: failed to load (${errMsg(e).split("\n")[0]})`);
      continue;
    }
    if (!isPlaywrightModule(mod)) {
      tried.push(`${name}: has no chromium launcher`);
      continue;
    }
    let version = "unknown";
    try {
      const pj = req(`${name}/package.json`);
      if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version;
    } catch {
    }
    return { ok: true, pkg: name, version, mod, file };
  }
  const pnp = fs4.existsSync(path3.join(abs, ".pnp.cjs")) ? " \u2014 this project uses Yarn Plug'n'Play: retry the probe as `yarn node <this script> \u2026`" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path3.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}
function rendererUnavailable(reason, hint) {
  console.error(`verify-probe: renderer unavailable \u2014 ${reason}
  nothing was measured or written. Ask the user to run:  ${hint}
  (verify-probe never installs a package or downloads a browser itself.)`);
  return 3;
}
async function launch(r, dir) {
  try {
    return { browser: await r.mod.chromium.launch({ headless: true }) };
  } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return { error: `${r.pkg} ${r.version} resolved, but chromium did not launch: ${first}`, hint: browserHint(dir) };
  }
}
var SELF2 = fileURLToPath3(import.meta.url);
function probeVersion() {
  for (const p of [path3.join(path3.dirname(SELF2), "..", ".claude-plugin", "plugin.json"), path3.join(path3.dirname(SELF2), "..", "claude-plugin", ".claude-plugin", "plugin.json")]) {
    const doc = readJsonOrNull(p, isJsonObject);
    if (doc && typeof doc.version === "string") return doc.version;
  }
  return null;
}
var selfSha256 = () => crypto3.createHash("sha256").update(fs4.readFileSync(SELF2)).digest("hex");
var BUILD_TYPES = /* @__PURE__ */ new Set(["document", "script", "stylesheet"]);
function buildFrom(url, served, viteClient, unhashed = 0) {
  const lines = [...served].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([p, h]) => `${p} ${h}`);
  return { url, mode: viteClient ? "vite-dev" : served.size ? "static" : "unknown", assets: served.size, assetsSha256: sha256Of(lines.join("\n")), ...unhashed > 0 ? { unhashed } : {} };
}
function gitState(dir) {
  const head = gitHead(dir);
  if (!head) return { gitHead: null, gitDirty: null };
  try {
    const r = spawnSync2("git", ["status", "--porcelain", "--", ".", ":(exclude)design"], { cwd: dir, encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] });
    return { gitHead: head, gitDirty: r.status === 0 ? String(r.stdout || "").trim() !== "" : null };
  } catch {
    return { gitHead: head, gitDirty: null };
  }
}
var INIT_SCRIPT = `(() => {
  try { Object.defineProperty(window, "__dtProbeDoc", { value: Math.random().toString(36).slice(2), configurable: true }); } catch (e) {}
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
  const add = () => { const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
})();`;
var QUIET_MS = 500;
var QUIET_CAP_MS = 1e4;
var POLL_MS = 100;
var NAV_ERROR = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
var CLOSED_ERROR = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;
function errorKind(message, pageClosed) {
  if (pageClosed || CLOSED_ERROR.test(message)) return "gone";
  return NAV_ERROR.test(message) ? "navigated" : "other";
}
var NavigatedError = class extends Error {
};
var StepStateLostError = class extends NavigatedError {
};
var BrowserGoneError = class extends Error {
};
var gone = (e) => new BrowserGoneError(`the browser closed or crashed during measurement (${errMsg(e).split("\n")[0]})`);
var KeptNavigatingError = class extends Error {
};
var UnreachableError = class extends Error {
};
var docUrl = (u) => {
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
};
function isNavigationAway(requestUrl, pageUrl) {
  return docUrl(requestUrl) !== docUrl(pageUrl);
}
async function docTokenOrNull(page) {
  try {
    const v = await page.evaluate("window.__dtProbeDoc || ''");
    return String(v);
  } catch (e) {
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (errorKind(errMsg(e), false) === "navigated") return null;
    throw e;
  }
}
async function settle(page, log, ready, timeout) {
  const cap = Math.min(QUIET_CAP_MS, timeout);
  const deadline = Date.now() + cap;
  let docDeadline = deadline;
  const started = Date.now();
  const navAtStart = log.docLoads;
  let newDocs = 0;
  let loadNote = null;
  const moved = () => log.docLoads !== navAtStart || newDocs > 0;
  const kept = () => new KeptNavigatingError(`the page kept navigating for ${Math.round((Date.now() - started) / 1e3)}s${log.navs > 0 ? " after load" : ""} (${Math.max(log.docLoads - navAtStart, newDocs)} navigation(s)) and never settled`);
  const stateLost = () => {
    if (log.lost !== null) throw new StepStateLostError(log.lost);
  };
  stateLost();
  let token = await docTokenOrNull(page);
  const newDocument = async () => {
    newDocs++;
    if (log.live !== null && !log.pendingOwned && log.lost === null) log.lost = lostState(page.url(), log.live);
    stateLost();
    if (Date.now() >= deadline && newDocs > 1) throw kept();
    docDeadline = Date.now() + cap;
    loadNote = null;
    token = await docTokenOrNull(page);
  };
  const noteNow = async (tok) => {
    if (loadNote === null) return null;
    let state = null;
    try {
      state = await page.evaluate("document.readyState");
    } catch (e) {
      if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
      return loadNote;
    }
    if (state !== "complete") return loadNote;
    if (tok !== "") log.loadTimedOut.delete(tok);
    return null;
  };
  for (; ; ) {
    try {
      const known = token !== null && token !== "" ? log.loadTimedOut.get(token) : void 0;
      const state = await page.evaluate("document.readyState");
      if (state === "complete") {
        if (known !== void 0 && token !== null) log.loadTimedOut.delete(token);
      } else if (known !== void 0) loadNote = known;
      else {
        try {
          await page.waitForLoadState("load", { timeout: Math.max(1, docDeadline - Date.now()) });
        } catch (e) {
          if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
          if (errorKind(errMsg(e), false) === "navigated") throw e;
          loadNote = `the document had not finished loading after ${Math.round(cap / 1e3)}s (document.readyState "${String(state)}") \u2014 measured anyway`;
          const now = await docTokenOrNull(page);
          if (now !== null && now !== "" && (token === null || now === token)) {
            token = now;
            log.loadTimedOut.set(now, loadNote);
            log.requested = false;
          }
        }
        stateLost();
      }
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: moved() ? Math.max(1, docDeadline - Date.now()) : timeout });
    } catch (e) {
      if (e instanceof StepStateLostError || e instanceof BrowserGoneError) throw e;
      if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
      const now = await docTokenOrNull(page);
      if (now !== null && token !== null && now !== token) {
        await newDocument();
        continue;
      }
      if (token === null && now !== null) token = now;
      if (moved() && Date.now() < docDeadline) {
        await sleep2(POLL_MS);
        continue;
      }
      if (moved()) throw kept();
      if (errorKind(errMsg(e), false) === "navigated" && Date.now() < docDeadline) {
        await sleep2(POLL_MS);
        continue;
      }
      throw new UnreachableError(ready ? `--ready '${ready}' never became visible: ${errMsg(e).split("\n")[0]}` : errMsg(e).split("\n")[0]);
    }
    let mark = log.docLoads;
    let last = "", since = Date.now();
    for (; ; ) {
      await sleep2(POLL_MS);
      let tok, sig;
      try {
        const v = await page.evaluate("[window.__dtProbeDoc || '', document.getElementsByTagName('*').length + ':' + (document.body && document.body.textContent || '').length]");
        if (!Array.isArray(v)) throw new Error("the page returned no settle signature");
        tok = String(v[0]);
        sig = String(v[1]);
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
        if (errorKind(errMsg(e), false) !== "navigated") throw e;
        if (Date.now() >= docDeadline) throw kept();
        continue;
      }
      if (token === null) token = tok;
      if (tok !== token || log.docLoads !== mark && tok === "") {
        await newDocument();
        break;
      }
      stateLost();
      mark = log.docLoads;
      if (sig !== last) {
        last = sig;
        since = Date.now();
      }
      if (Date.now() - since >= QUIET_MS) return { note: await noteNow(tok), token: tok };
      if (Date.now() >= docDeadline) {
        if (moved() && newDocs === 0) throw kept();
        return { note: await noteNow(tok) ?? `the DOM was still changing after ${Math.round(cap / 1e3)}s${newDocs ? " on the document a navigation loaded" : " (no navigation)"} \u2014 measured anyway`, token: tok };
      }
    }
  }
}
var STEP_WAIT_CAP_MS = 5e3;
async function oneVisible(page, sel, wait, name, atLeastOne = false) {
  const deadline = Date.now() + wait;
  let last = { visible: 0, all: 0 };
  for (; ; ) {
    try {
      const loc = page.locator(sel);
      const all = await loc.count();
      const vis = [];
      for (let i = 0; i < all; i++) if (await loc.nth(i).isVisible()) vis.push(i);
      const only = vis[0];
      if (only !== void 0 && (vis.length === 1 || atLeastOne)) return only;
      last = { visible: vis.length, all };
    } catch (e) {
      const kind = errorKind(errMsg(e), page.isClosed());
      if (kind === "gone") throw gone(e);
      if (kind === "other") throw new StepError(`${name}: ${errMsg(e).split("\n")[0]}`);
    }
    if (Date.now() >= deadline) {
      throw new StepError(`${name} matched ${last.visible} visible element(s)${last.all !== last.visible ? ` (${last.all} in the document)` : ""} after ${Math.round(wait / 1e3)}s \u2014 ${atLeastOne ? "a waitFor needs at least one" : "a click needs exactly one"}`);
    }
    await sleep2(POLL_MS);
  }
}
function linkHref(el) {
  const a = el.closest("a[href], area[href]");
  if (a === null || typeof a.href !== "string" || a.hasAttribute("download")) return null;
  const own = typeof a.target === "string" ? a.target : "";
  const base = el.ownerDocument.querySelector("base[target]");
  const target = (own || (base ? base.getAttribute("target") || "" : "")).toLowerCase();
  if (target !== "" && target !== "_self" && target !== "_top" && target !== "_parent") return null;
  return a.href;
}
async function ownGoto(page, log, url, timeout) {
  let committed = false;
  const onResponse = (r) => {
    try {
      const st = r.status();
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame() && (st < 300 || st >= 400)) committed = true;
    } catch {
    }
  };
  const onRequest = (r) => {
    try {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame() && r.redirectedFrom() === null) committed = false;
    } catch {
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    await page.goto(url, { waitUntil: "load", timeout });
  } catch (e) {
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (/interrupted by another navigation/i.test(errMsg(e))) return;
    if (!committed || !/Timeout \d+ms exceeded/i.test(errMsg(e))) throw e;
    let state = "unknown";
    try {
      state = await page.evaluate("document.readyState");
    } catch {
    }
    const note = `the page had not finished loading when the goto gave up after ${Math.round(timeout / 1e3)}s (document.readyState "${String(state)}") \u2014 measured anyway`;
    const tok = await docTokenOrNull(page);
    if (tok !== null && tok !== "") log.loadTimedOut.set(tok, note);
    log.requested = false;
  } finally {
    page.off("response", onResponse);
    page.off("request", onRequest);
  }
}
async function runSteps(page, log, o) {
  const steps = o.steps || [];
  let origin = "";
  try {
    origin = new URL(o.url).origin;
  } catch {
  }
  for (const [i, s] of steps.entries()) {
    const name = describeStep(s, i);
    const wait = Math.min(o.timeout, STEP_WAIT_CAP_MS);
    if ("goto" in s) {
      let target;
      try {
        target = new URL(s.goto, o.url);
      } catch {
        throw new StepError(`${name} is not a path`);
      }
      if (target.origin !== origin) throw new StepError(`${name} leaves the origin ${origin} \u2014 a goto step is a same-origin path`);
      log.owner = { kind: "goto" };
      try {
        await ownGoto(page, log, target.href, o.timeout);
      } catch (e) {
        if (e instanceof BrowserGoneError) throw e;
        throw new StepError(`${name} could not load ${target.href}: ${errMsg(e).split("\n")[0]}`);
      } finally {
        log.owner = null;
      }
      log.live = null;
    } else {
      const sel = "click" in s ? s.click : s.waitFor;
      const idx = await oneVisible(page, sel, wait, name, "waitFor" in s);
      if ("click" in s) {
        const loc = page.locator(sel).nth(idx);
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: wait }).catch(() => void 0);
          const submits = await loc.evaluate(submitGuard, void 0, { timeout: wait });
          if (submits !== null) throw new StepError(`${name} would submit a form (${submits}) \u2014 a step must navigate, never submit`);
          const href = await loc.evaluate(linkHref, void 0, { timeout: wait });
          const refresh = href !== null && !href.includes("#") && docUrl(href) === docUrl(page.url());
          log.owner = { kind: refresh ? "reload" : "click" };
          log.live = name;
          try {
            await loc.click({ timeout: wait });
          } finally {
            log.owner = { kind: "click" };
          }
        } catch (e) {
          if (e instanceof StepError) throw e;
          const kind = errorKind(errMsg(e), page.isClosed());
          if (kind === "gone") throw gone(e);
          if (kind === "other") throw new StepError(`${name} could not be clicked: ${errMsg(e).split("\n")[0]}`);
        }
      }
    }
    await settle(page, log, void 0, o.timeout);
    if (log.lost !== null) throw new StepStateLostError(log.lost);
  }
}
async function reachPage(page, log, o) {
  log.owner = null;
  log.pendingOwned = false;
  log.live = null;
  log.lost = null;
  log.gotos++;
  try {
    await ownGoto(page, log, o.url, o.timeout);
  } catch (e) {
    if (e instanceof BrowserGoneError) throw e;
    throw new UnreachableError(`could not load ${o.url}: ${errMsg(e).split("\n")[0]}`);
  }
  const steps = o.steps || [];
  if (!steps.length) return settle(page, log, o.ready, o.timeout);
  try {
    await settle(page, log, void 0, o.timeout);
    await runSteps(page, log, o);
    const last = await settle(page, log, o.ready, o.timeout);
    if (log.lost !== null) throw new StepStateLostError(log.lost);
    return { note: last.note, token: last.token };
  } finally {
    log.owner = null;
  }
}
var lostState = (url, live) => `the page reloaded (${docUrl(url)} again, not a navigation) after ${live} had changed it in place \u2014 the steps' state is gone`;
function attachNavLog(page) {
  const log = { events: [], navs: 0, gotos: 0, t0: Date.now(), owner: null, pendingOwned: false, live: null, lost: null, loadTimedOut: /* @__PURE__ */ new Map(), requested: false, docLoads: 0 };
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) log.events.push({ type: "framenavigated", url: f.url(), at: Date.now() - log.t0 });
  });
  page.on("request", (r) => {
    try {
      if (!r.isNavigationRequest() || r.frame() !== page.mainFrame() || r.redirectedFrom() !== null) return;
      const o = log.owner;
      log.requested = true;
      log.pendingOwned = o !== null && (o.kind !== "click" || isNavigationAway(r.url(), page.url()));
    } catch {
    }
  });
  page.on("load", () => {
    log.navs++;
    const url = page.url();
    const fresh = log.requested;
    log.requested = false;
    if (fresh) log.docLoads++;
    if (log.pendingOwned) log.gotos++;
    else if (fresh && log.live !== null && log.lost === null) log.lost = lostState(url, log.live);
    log.events.push({ type: "load", url, at: Date.now() - log.t0 });
    log.pendingOwned = false;
    if (fresh) log.live = null;
  });
  return log;
}
function foreignTags(tagged, expectedIds, frameIds) {
  const n = /* @__PURE__ */ new Map();
  for (const c of tagged) {
    if (c.dt === null || expectedIds.has(c.dt) || frameIds.has(c.dt) || !(c.flags.box && c.flags.visible && !c.flags.inClosedDialog)) continue;
    n.set(c.dt, (n.get(c.dt) || 0) + 1);
  }
  const ids = [...n.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).slice(0, 50).map((id) => ({ id, elements: n.get(id) ?? 0 }));
  return { count: n.size, ids };
}
var raf22 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
var docToken = async (page) => {
  const v = await page.evaluate("window.__dtProbeDoc || ''");
  return String(v);
};
async function pass(page, log, o) {
  const exp = o.expectation;
  const hiddenIds = new Set(exp.hidden && exp.hidden.ids || []);
  const specs = (exp.nodes || []).filter((s) => !hiddenIds.has(s.nodeId));
  const frameRows = (exp.frames && exp.frames.length ? exp.frames : [exp.frame || {}]).filter((f) => typeof f.nodeId === "string");
  const frameIn = frameRows.map((f) => ({ nodeId: String(f.nodeId), w: typeof f.w === "number" ? f.w : null, h: typeof f.h === "number" ? f.h : null }));
  const reached = await reachPage(page, log, o);
  const settleNote = reached.note;
  try {
    const token = reached.token ?? await docToken(page);
    const navsAtReach = log.docLoads;
    const reachedUrl = page.url();
    const texts = [...new Set(specs.map(specText).filter((t) => t !== null).map((t) => t.text))];
    const collected = await page.evaluate(collectCandidates, { frames: frameIn, texts, positions: [] });
    const frames = /* @__PURE__ */ new Map();
    frameIn.forEach((f, i) => {
      const tagged = collected.tagged.filter((c) => c.dt === f.nodeId);
      frames.set(f.nodeId, resolveFrame(f, tagged, (collected.frames[f.nodeId] || { sized: [] }).sized, collected.viewport, i === 0));
    });
    const expectedIds = /* @__PURE__ */ new Set([...specs.map((s) => s.nodeId), ...(exp.instances || []).map((i) => i.nodeId), ...hiddenIds]);
    const pool = buildPool(collected, specs, expectedIds, frames, frameIn[0]?.nodeId ?? null);
    if (o.position) {
      const boxes = positionBoxes(specs.filter((s) => !(pool.byTag.get(s.nodeId) || []).length), pool);
      if (boxes.length) {
        const more = await page.evaluate(collectCandidates, { frames: [], texts: [], positions: boxes });
        pool.collect = { ...pool.collect, positions: more.positions };
      }
    }
    const matches = specs.map((spec) => ({ spec, m: chooseMatch(spec, pool, { position: o.position }) }));
    const claimed = claimOnce(matches.map(({ m }) => m));
    matches.forEach((x, i) => {
      const c = claimed[i];
      if (c) x.m = c;
    });
    const item = (spec, m) => ({ nodeId: spec.nodeId, path: m.path, isText: spec.type === "TEXT", isPaint: isPaintSpec(spec), isPlaceholder: spec.placeholder === true, sharesWith: m.sharesWith ?? null });
    const frameRectOf = (spec) => {
      const f = frames.get(spec.frameId ?? frameIn[0]?.nodeId ?? "");
      return f ? f.rect : { x: 0, y: 0, w: o.viewport.w, h: o.viewport.h };
    };
    const nodes = /* @__PURE__ */ new Map();
    const byFrame = /* @__PURE__ */ new Map();
    for (const { spec, m } of matches) if (isMatch(m)) {
      const k = spec.frameId ?? "";
      byFrame.set(k, [...byFrame.get(k) || [], { spec, m }]);
    }
    for (const group of byFrame.values()) {
      const first = group[0];
      if (!first) continue;
      const raw = await page.evaluate(measureElements, { frameRect: frameRectOf(first.spec), keys: STYLE_KEYS, items: group.map(({ spec, m }) => item(spec, m)) });
      group.forEach(({ spec, m }, i) => {
        const r = raw[i];
        if (r) nodes.set(spec.nodeId, shapeNode(spec, m, r, STYLE_KEYS));
      });
    }
    const stateNotes = /* @__PURE__ */ new Set();
    for (const { spec, m } of matches) {
      const node = nodes.get(spec.nodeId);
      const state = spec.drawnState;
      if (!node || !isMatch(m) || state !== "hover" && state !== "focus") continue;
      const target = m.hoverVia ?? hoverTarget(m.cand, pool.byTag) ?? m.path;
      let focusPath = null;
      try {
        if (state === "hover") {
          await page.mouse.move(0, 0);
          await page.locator(target).first().hover({ timeout: 2e3 });
        } else {
          focusPath = await page.evaluate(focusablePath, m.path);
          if (focusPath === null) {
            node.note = "focus state not measured: the element is not focusable (nor is any ancestor)";
            continue;
          }
          await page.locator(focusPath).first().focus({ timeout: 2e3 });
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          let info = await page.evaluate(focusInfo, focusPath);
          node.focusVia = "keyboard";
          if (!info.focused) {
            await page.locator(focusPath).first().focus({ timeout: 2e3 });
            info = await page.evaluate(focusInfo, focusPath);
            node.focusVia = "programmatic";
            stateNotes.add("a focus state was measured after a programmatic focus(), which Chromium may not match to :focus-visible");
          }
          if (!info.focused) {
            delete node.focusVia;
            node.note = "focus state not measured: the element would not take focus";
            continue;
          }
        }
        await raf22(page);
        const [r] = await page.evaluate(measureElements, { frameRect: frameRectOf(spec), keys: STYLE_KEYS, items: [item(spec, m)] });
        if (r) {
          const shaped = shapeNode(spec, m, r, STYLE_KEYS);
          node.states = { [state]: { styles: shaped.styles || {}, ...shaped.unmeasured ? { unmeasured: shaped.unmeasured } : {} } };
        }
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) !== "other") throw e;
        node.note = `${state} state not measured: ${errMsg(e).split("\n")[0]}`;
      } finally {
        if (state === "hover") await page.mouse.move(0, 0).catch(() => void 0);
        else if (focusPath !== null) await page.locator(focusPath).first().blur({ timeout: 2e3 }).catch(() => void 0);
      }
    }
    if (matches.some(({ spec }) => spec.drawnState === "hover")) await raf22(page);
    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    const { compatMode, ...overflow } = await page.evaluate(readPageOverflow, null);
    const pageOverflow = { ...overflow, compatMode };
    const tokenNow = await docToken(page);
    if (tokenNow !== token || token === "" && log.docLoads !== navsAtReach) throw new NavigatedError("the page loaded a new document during measurement");
    if (compatMode !== "CSS1Compat") stateNotes.add(`the page renders in quirks mode (document.compatMode ${compatMode}: no <!doctype html>) \u2014 its layout and page overflow measure differently from a standards-mode build`);
    const components = [];
    for (const i of exp.instances || []) {
      if (hiddenIds.has(i.nodeId)) continue;
      if ((pool.byTag.get(i.nodeId) || []).some((c) => c.flags.box && c.flags.visible)) components.push({ nodeId: i.nodeId, ...i.setName !== void 0 ? { setName: i.setName } : {} });
    }
    const notes = [settleNote, ...[...frames.values()].map((f) => f?.note ?? null), ...stateNotes].filter((n) => typeof n === "string");
    return {
      nodes: specs.map((s) => nodes.get(s.nodeId)).filter((n) => n !== void 0),
      notMeasured: matches.flatMap(({ m }) => isMatch(m) ? [] : [{ nodeId: m.nodeId, why: m.why }]),
      frames: [...frames.values()].filter((f) => f !== null),
      components,
      png,
      notes,
      tagsNotInExpectation: foreignTags(collected.tagged, expectedIds, new Set(frameIn.map((f) => f.nodeId))),
      page: pageOverflow,
      url: reachedUrl
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError || e instanceof StepError) throw e;
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (errorKind(errMsg(e), false) === "navigated") throw new NavigatedError(errMsg(e).split("\n")[0]);
    throw e;
  }
}
function hoverTarget(c, byTag) {
  if (!c || c.flags.visible && !c.flags.zeroSize) return null;
  for (const a of c.taggedAncestors) {
    const hit = (byTag.get(a) || []).find((x) => x.flags.box && x.flags.visible && !x.flags.zeroSize);
    if (hit) return hit.path;
  }
  return null;
}
var BODY_WAIT_MS = 2e3;
async function bodiesRead(reads, served) {
  await Promise.race([Promise.allSettled(reads.map((r) => r.done)), sleep2(BODY_WAIT_MS, void 0, { ref: false })]);
  const missed = /* @__PURE__ */ new Map();
  for (const r of reads) {
    if (served.has(r.path) || r.state !== "pending" && r.state !== "failed") continue;
    missed.set(r.path, r.state === "failed" ? "the request failed" : `not received within ${BODY_WAIT_MS / 1e3} s \u2014 a load cut short by another navigation`);
  }
  if (!missed.size) return null;
  const list = [...missed].slice(0, 5).map(([p, why]) => `${p} (${why})`).join(", ");
  return { note: `build identity: ${missed.size} same-origin response body(ies) not hashed \u2014 ${list}${missed.size > 5 ? ", \u2026" : ""}; measured.build.assetsSha256 leaves them out (build.unhashed)`, unhashed: missed.size };
}
async function runProbe(browser, o) {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(o.timeout);
  await page.addInitScript({ content: INIT_SCRIPT });
  let origin = "";
  try {
    origin = new URL(o.url).origin;
  } catch {
  }
  const served = /* @__PURE__ */ new Map();
  let bodies = [];
  let gen = 0, viteClient = false;
  page.on("response", (res) => {
    if (!BUILD_TYPES.has(res.request().resourceType())) return;
    let u;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.origin !== origin) return;
    if (u.pathname === "/@vite/client") viteClient = true;
    const g = gen;
    const read = { path: u.pathname, state: "pending", done: Promise.resolve() };
    const body = res.body().then((b) => {
      if (g === gen) served.set(u.pathname, sha256Of(b));
      read.state = "hashed";
    }, () => {
      read.state = "no body";
    });
    const failed = res.finished().then((err) => {
      if (!err) return body;
      read.state = "failed";
      return void 0;
    }, () => {
      read.state = "failed";
    });
    read.done = Promise.race([body, failed]);
    bodies.push(read);
  });
  const log = attachNavLog(page);
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && consoleErrors.length < 20) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (consoleErrors.length < 20) consoleErrors.push(err.message);
  });
  const nav = (reruns2) => ({ events: log.events, afterInitialLoad: Math.max(0, log.navs - log.gotos), reruns: reruns2 });
  let reruns = 0;
  try {
    for (; ; ) {
      try {
        gen++;
        served.clear();
        viteClient = false;
        bodies = [];
        const result = await pass(page, log, o);
        const unread = await bodiesRead(bodies, served);
        if (unread !== null) result.notes.push(unread.note);
        if (reruns && o.steps && o.steps.length) result.notes.push("the re-run replayed the steps in the same browser context (session and local storage from the first pass kept)");
        return { kind: "ok", result, navigation: nav(reruns), consoleErrors, build: buildFrom(o.url, served, viteClient, unread !== null ? unread.unhashed : 0) };
      } catch (e) {
        if (e instanceof BrowserGoneError) return { kind: "browser-gone", why: e.message, navigation: nav(reruns) };
        if (e instanceof KeptNavigatingError) return { kind: "navigation", why: e.message, navigation: nav(reruns) };
        if (e instanceof StepError) return { kind: "steps", why: e.message, navigation: nav(reruns) };
        if (!(e instanceof NavigatedError)) throw e;
        if (reruns >= 1) {
          if (e instanceof StepStateLostError) return { kind: "step-state", why: e.message, navigation: nav(reruns) };
          return { kind: "navigation", why: `the page reloaded during measurement twice (${e.message})`, navigation: nav(reruns) };
        }
        reruns++;
      }
    }
  } finally {
    await context.close().catch(() => void 0);
  }
}
var USAGE = `usage:
  ${scriptCmd("verify-probe")} --expected design/verify/<Screen>.expected.json --url <url> [--out design/verify/<Screen>]
      [--ready <selector>] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>] [--run <id>] [--max-time <ms>]
      [--steps <steps.json | plan.json>]
      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag \u2192 shared path \u2192 alias \u2192
      text \u2192 text-ordinal \u2192 --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.
      --out defaults to the .expected.json path minus \`.expected\`; --viewport to the frame's w\xD7h; --project to cwd.
      --run <id> (from verify-screen --status \u2026 --new-run): writes the run's LIVE status (the run cache,
      node_modules/.cache/designtwin-verify/<Screen>.status.json \u2014 never the project tree a dev server watches) \u2014 \`measuring\`
      before the browser starts, \`measured\` (+ the measured file's sha256) after it is closed; an exit 3/4 bumps its rev.
      --max-time bounds the whole run (default 180000 ms): past it the browser is closed and nothing is written (exit 4).
      --steps: a JSON list of steps (or a plan whose \`navigate\` holds them) replayed after every page load, before --ready,
      to reach a screen that is a section of the app (not a URL): {"click": "<selector>"} | {"waitFor": "<selector>"} |
      {"goto": "/same-origin/path"}. A click's selector must match exactly one visible element (a waitFor's at least one);
      a click never submits a form. A click's navigation to another URL is the step's own, however late; a reload after a
      click changed the page in place re-runs the pass once (twice: exit 4); a click on a link to the URL the page shows is
      a refresh (its load is the step's own). A step that fails while measuring is exit 4
      (nothing written). Recorded as measured.reach.
      After measuring, the expectation's overlay interactions (on_click/on_press overlay/swap, plan expect:"dialog") are
      driven, each on a fresh page: measured.interactions (evidence; ok:true or ok:null, never false).
  ${scriptCmd("verify-probe")} --check [--project <dir>]
      resolves the project's Playwright and launches chromium once \u2014 nothing measured, nothing written.
exit: 0 wrote \xB7 2 usage \xB7 3 renderer unavailable (ask the user to install; never installed here) \xB7 4 the page kept
      navigating / reloaded twice during measurement / was unreachable / timed out / passed --max-time / a --steps step
      failed (nothing written).`;
var MAX_TIME_DEFAULT = 18e4;
var CLOSE_CAP_MS = 1e4;
async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (!argv.length) {
    console.error(USAGE);
    return 2;
  }
  const OPTIONS = {
    expected: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    ready: { type: "string" },
    viewport: { type: "string" },
    project: { type: "string" },
    position: { type: "boolean" },
    timeout: { type: "string" },
    check: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    run: { type: "string" },
    "max-time": { type: "string" },
    steps: { type: "string" }
  };
  const { values: f } = cliParse("verify-probe", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: false }));
  const project = path3.resolve(f.project ?? ".");
  const timeout = f.timeout === void 0 ? 3e4 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error(`verify-probe: --timeout must be a positive number of milliseconds
${USAGE}`);
    return 2;
  }
  const maxTime = f["max-time"] === void 0 ? MAX_TIME_DEFAULT : Number(f["max-time"]);
  if (!Number.isFinite(maxTime) || maxTime <= 0) {
    console.error(`verify-probe: --max-time must be a positive number of milliseconds
${USAGE}`);
    return 2;
  }
  if (f.run !== void 0 && (f.check || !/^[\w.:-]+$/.test(f.run))) {
    console.error(`verify-probe: ${f.check ? "--run does not apply to --check" : `--run must be a run id (letters, digits, . : _ -), got '${f.run}'`}
${USAGE}`);
    return 2;
  }
  if (!f.check) {
    if (!f.expected || !f.url) {
      console.error(`verify-probe: --expected and --url are both required
${USAGE}`);
      return 2;
    }
  } else if (f.steps !== void 0) {
    console.error(`verify-probe: --steps does not apply to --check
${USAGE}`);
    return 2;
  }
  let steps = [];
  let stepsSource = null;
  if (f.steps !== void 0) {
    const r2 = readJson(f.steps, anyJson);
    if ("error" in r2) {
      console.error(`verify-probe: --steps '${f.steps}' ${r2.error}`);
      return 2;
    }
    const parsed = parseSteps(r2.doc);
    if ("error" in parsed) {
      console.error(`verify-probe: --steps '${f.steps}' ${parsed.error}
${USAGE}`);
      return 2;
    }
    steps = parsed.steps;
    stepsSource = `--steps ${(path3.relative(process.cwd(), path3.resolve(f.steps)) || f.steps).split(path3.sep).join("/")}`;
  }
  let expectation = null, expBytes = null;
  let viewport = { w: 1280, h: 800 };
  const notes = [];
  if (!f.check && f.expected) {
    const r2 = readJson(f.expected, isVerifyExpectation);
    if ("error" in r2) {
      console.error(`verify-probe: '${f.expected}' ${r2.error}`);
      return 2;
    }
    expectation = r2.doc;
    expBytes = fs4.readFileSync(f.expected);
    const fr = expectation.frame || {};
    if (f.viewport !== void 0) {
      const m = /^(\d+)x(\d+)$/i.exec(f.viewport.trim());
      if (!m) {
        console.error(`verify-probe: --viewport must be WxH (e.g. 1440x900), got '${f.viewport}'
${USAGE}`);
        return 2;
      }
      viewport = { w: Number(m[1]), h: Number(m[2]) };
    } else if (typeof fr.w === "number" && typeof fr.h === "number") viewport = { w: Math.round(fr.w), h: Math.round(fr.h) };
    else notes.push("the expectation states no frame size \u2014 measured at 1280x800; pass --viewport");
  }
  const outBase = f.out ?? (f.expected ? path3.join(path3.dirname(f.expected), path3.basename(f.expected, ".json").replace(/\.expected$/, "")) : "");
  const statusBase = f.expected ? path3.join(path3.dirname(f.expected), path3.basename(outBase)) : "";
  const expSha = expBytes ? sha256Of(expBytes) : void 0;
  const runId = f.run !== void 0 && !f.check && statusBase ? f.run : void 0;
  const status = (w) => {
    try {
      writeStatus(statusBase, w);
      return true;
    } catch (e) {
      if (!(e instanceof RunCacheUnwritable)) throw e;
      console.error(`warning  ${e.message}`);
      return false;
    }
  };
  const ended = (code) => {
    if (runId !== void 0 && (code === 3 || code === 4)) {
      status({ runId, phase: "measuring", by: "verify-probe", detail: `probe exit ${code} \u2014 nothing written`, ...expSha ? { expectationSha256: expSha } : {} });
    }
    return code;
  };
  const res = resolvePlaywright(project);
  if (!res.ok) return ended(rendererUnavailable(res.reason, res.hint));
  const measuringRecorded = runId !== void 0 && status({ runId, phase: "measuring", by: "verify-probe", detail: `verify-probe measuring ${f.url ?? ""}`, ...expSha ? { expectationSha256: expSha } : {} });
  if (measuringRecorded) console.error(`status ${shellArg(liveStatusFile(statusBase))}`);
  const held = {};
  let timer;
  const runDeadline = Date.now() + maxTime;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), maxTime);
  });
  const work = (async () => {
    const launched = await launch(res, project);
    if ("error" in launched) return rendererUnavailable(launched.error, launched.hint);
    const browser = launched.browser;
    held.browser = browser;
    const identity2 = { name: "verify-probe", version: probeVersion(), sha256: selfSha256(), playwright: { package: res.pkg, version: res.version }, browser: { name: "chromium", version: browser.version() } };
    if (f.check || !expectation || !expBytes || !f.expected || !f.url) {
      await browser.close();
      console.log(`ok  ${res.pkg} ${res.version} (from ${path3.relative(project, res.file) || res.file}) \xB7 chromium ${identity2.browser.version} \xB7 verify-probe ${identity2.version ?? "?"} (sha ${identity2.sha256.slice(0, 12)}\u2026)`);
      return 0;
    }
    let run2;
    const probeOpts = { expectation, url: f.url, ...f.ready !== void 0 ? { ready: f.ready } : {}, viewport, position: !!f.position, timeout, ...steps.length ? { steps } : {} };
    try {
      run2 = await runProbe(browser, probeOpts);
    } catch (e) {
      await browser.close().catch(() => void 0);
      if (e instanceof UnreachableError) {
        console.error(`verify-probe: ${e.message} \u2014 nothing written.`);
        return 4;
      }
      if (/Timeout .*exceeded/i.test(errMsg(e))) {
        console.error(`verify-probe: timed out \u2014 ${errMsg(e).split("\n")[0]} \u2014 nothing written.`);
        return 4;
      }
      throw e;
    }
    let driven2 = null, driveNote2 = null;
    const rows = run2.kind === "ok" ? drivable(expectation) : [];
    if (rows.length) {
      try {
        driven2 = await driveInteractions(browser, {
          rows,
          viewport,
          timeout,
          initScript: INIT_SCRIPT,
          budgetMs: driveBudget(Date.now(), runDeadline),
          reach: async (page) => {
            await reachPage(page, attachNavLog(page), probeOpts);
          }
        });
      } catch (e) {
        driveNote2 = `driving the interactions failed (${errMsg(e).split("\n")[0]}) \u2014 none recorded`;
      }
    }
    await browser.close().catch(() => void 0);
    if (held.timedOut) return 4;
    if (run2.kind === "browser-gone") {
      console.error(`verify-probe: ${run2.why} \u2014 nothing written. This is not a page reload: re-run the probe; if it recurs, run --check.`);
      return 4;
    }
    if (run2.kind === "navigation") {
      console.error(`verify-probe: ${run2.why} \u2014 nothing written.
  the page reloaded during measurement: move writes out of the dev-server watch tree (see verify.md), or serve a production build.
  navigation log:
` + run2.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    if (run2.kind === "step-state") {
      console.error(`verify-probe: ${run2.why}, on the first pass and again on the re-run (the steps replayed) \u2014 nothing written.
  a reload brings the page back without what the click built in place, so the --steps (${stepsSource ?? "?"}) cannot hold the screen: ${steps.map((s, i) => describeStep(s, i)).join(" \u2192 ")}
  if that click reloads the page itself (location.reload(), or a navigation to the URL the page is already on), it is not a
  navigation step: reach the screen by its own URL (--url, or a {"goto": "/path"} step) or by a click that navigates to
  another URL. A click whose navigation goes to another URL is the step's own, however late it starts.
  navigation log:
` + run2.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    if (run2.kind === "steps") {
      console.error(`verify-probe: ${run2.why} \u2014 nothing written.
  the --steps (${stepsSource ?? "?"}) did not reach the screen: ${steps.map((s, i) => describeStep(s, i)).join(" \u2192 ")}
  navigation log:
` + run2.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
      return 4;
    }
    return { run: run2, identity: identity2, driven: driven2, driveNote: driveNote2 };
  })();
  const first = await Promise.race([work, watchdog]);
  clearTimeout(timer);
  if (first === "timeout") {
    held.timedOut = true;
    work.catch(() => void 0);
    const b = held.browser;
    if (b) {
      const cap = () => sleep2(CLOSE_CAP_MS, void 0, { ref: false });
      await Promise.race([b.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => void 0), cap()]);
      await Promise.race([b.close().catch(() => void 0), cap()]);
    }
    console.error(`verify-probe: timed out after ${maxTime / 1e3}s (--max-time) \u2014 the browser was closed, nothing written.
  a page that never settles (a script that does not yield, a request that never ends): re-run the probe once; if it times out again, report it (status failed).`);
    return ended(4);
  }
  if (typeof first === "number") return ended(first);
  const { run, identity, driven, driveNote } = first;
  if (!expectation || !expBytes || !f.expected || !f.url) return 2;
  const png = outBase + ".png";
  const r = run.result;
  const frameOut = (fr) => ({ nodeId: fr.nodeId, selector: fr.selector, via: fr.via, rect: fr.rect });
  const firstFrame = r.frames[0];
  const measured = {
    measuredAt: (/* @__PURE__ */ new Date()).toISOString(),
    renderer: "playwright-chromium",
    viewport: `${viewport.w}x${viewport.h}`,
    artifacts: [png.split(path3.sep).join("/")],
    expectationSha256: sha256Of(expBytes),
    probe: identity,
    ...firstFrame ? { frame: frameOut(firstFrame) } : {},
    ...r.frames.length > 1 ? { frames: r.frames.map(frameOut) } : {},
    navigation: run.navigation,
    matchedByCensus: { ...census(r.nodes, r.notMeasured) },
    nodes: r.nodes,
    notMeasured: r.notMeasured,
    components: r.components,
    tagsNotInExpectation: r.tagsNotInExpectation,
    ...run.consoleErrors.length ? { consoleErrors: run.consoleErrors } : {},
    ...f.run !== void 0 ? { runId: f.run } : {},
    build: { ...run.build, ...gitState(project) },
    ...stepsSource !== null ? { reach: { steps, sha256: stepsSha256(steps), source: stepsSource, url: r.url } } : {},
    page: r.page,
    ...driven ? { interactions: driven } : {}
  };
  const allNotes = [...notes, ...r.notes, ...driveNote !== null ? [driveNote] : []];
  const measuredText = JSON.stringify(allNotes.length ? { ...measured, notes: allNotes } : measured, null, 2) + "\n";
  writeFileAtomic(png, r.png);
  writeFileAtomic(outBase + ".measured.json", measuredText);
  const statusRefused = runId !== void 0 && !status({
    runId,
    phase: "measured",
    by: "verify-probe",
    detail: `measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s)`,
    ...expSha ? { expectationSha256: expSha } : {},
    measuredSha256: sha256Of(measuredText)
  });
  const c = census(r.nodes, r.notMeasured);
  console.error(`wrote ${outBase}.measured.json and ${png}`);
  console.error(`measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s) \u2014 tag ${c.tag} \xB7 shared path ${c.sharedPath} \xB7 alias ${c.tagAlias} \xB7 text ${c.text} \xB7 ordinal ${c.textOrdinal} \xB7 position ${c.position} \xB7 frame ${c.frame} \xB7 not measured ${c.notMeasured} \xB7 frame root via ${firstFrame ? firstFrame.via : "none"} \xB7 navigations after load ${run.navigation.afterInitialLoad}, re-runs ${run.navigation.reruns}`);
  const tn = r.tagsNotInExpectation;
  if (tn.count) console.error(`note  ${tn.count} data-dt-node value(s) on visible elements are not in the expectation (e.g. ${tn.ids.slice(0, 5).map((x) => x.id).join(", ")}) \u2014 --compare classifies them`);
  if (stepsSource !== null) console.error(`reach ${steps.length} step(s) from ${stepsSource} (sha ${stepsSha256(steps).slice(0, 12)}\u2026) \u2192 ${r.url}`);
  const pg = r.page;
  console.error(`page  scrollWidth ${pg.scrollWidth} at clientWidth ${pg.clientWidth} (overflow-x ${pg.overflowX})${pg.scrollWidth > pg.clientWidth + 1 ? pg.scrollable ? ` \u2014 scrolls sideways (widest: ${pg.offenders.slice(0, 3).map((o) => o.dt ? `data-dt-node="${o.dt}"` : o.path).join(", ") || "?"})` : " \u2014 overflows but clipped" : ""}`);
  for (const ev of driven || []) console.error(`drive ${ev.nodeId} ${ev.trigger ?? ""} \u2192 ${ev.ok === true ? "ok" : "ok:null"} \xB7 ${ev.detail ?? ""}`);
  for (const n of allNotes) console.error(`note  ${n}`);
  console.error(`probe verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}\u2026) \xB7 ${res.pkg} ${res.version} \xB7 chromium ${identity.browser.version}`);
  if (statusRefused && runId !== void 0) {
    const outDir = path3.resolve(path3.dirname(outBase)), verifyDir = path3.resolve(path3.dirname(statusBase));
    const findable = outDir === verifyDir || outDir === path3.resolve(stageDirOf(statusBase, runId));
    console.error(`warning  ${outBase}.measured.json is written, but the run cache refused the probe's \`measured\` status write for run ${runId}` + (measuringRecorded ? " \u2014 the live status still says measuring, so --compare reports the run incomplete" : " (its `measuring` write was refused too) \u2014 no live status of the run exists, so --compare will report the run as unrecorded") + `. Record it, from where the run cache takes writes, with: ${scriptCmd("verify-screen")} --status ${shellArg(path3.basename(statusBase))} --phase measured --run ${runId} --dir ${shellArg(verifyDir)}` + (findable ? "" : ` \u2014 after moving ${outBase}.measured.json to ${statusBase}.measured.json (it reads the verify dir or the run's stage dir)`));
  }
  console.error(`next  ${scriptCmd("verify-screen")} --compare ${shellArg(f.expected)} ${shellArg(outBase + ".measured.json")} --out ${shellArg(outBase)}`);
  return 0;
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`verify-probe: ${errMsg(e)}`);
    process.exitCode = 1;
  });
}
export {
  BODY_WAIT_MS,
  PLAYWRIGHT_PACKAGES,
  buildFrom,
  errorKind,
  foreignTags,
  installHint,
  isNavigationAway,
  isPlaywrightModule,
  linkHref,
  main,
  resolvePlaywright,
  runProbe
};
