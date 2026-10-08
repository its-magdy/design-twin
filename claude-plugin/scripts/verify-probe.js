// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-probe.ts
import fs5 from "node:fs";
import path5 from "node:path";
import crypto4 from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { parseArgs as parseArgs2 } from "node:util";
import { setTimeout as sleep4 } from "node:timers/promises";
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
    const frameRoot = input.framePath ? document.querySelector(input.framePath) : null;
    const paintOf = (e) => {
      const s = getComputedStyle(e), img = s.getPropertyValue("background-image").trim();
      return { color: rgba(s.getPropertyValue("background-color")), image: img !== "" && img !== "none" };
    };
    const painter = (e, via, depth, color) => {
      const dt = e.getAttribute("data-dt-node");
      return { backgroundColor: color, via, tag: e.tagName.toLowerCase(), depth, ...dt !== null ? { dt } : {} };
    };
    const paintedBy = () => {
      const near = (a, b) => Math.abs(a - b) <= 1;
      let cur = el, depth = 0;
      for (; ; ) {
        const kids2 = Array.from(cur.children);
        const only = kids2.length === 1 ? kids2[0] : void 0;
        if (!only) break;
        const r = pageRect(only.getBoundingClientRect());
        if (!(near(r.x, rect.x) && near(r.y, rect.y) && near(r.w, rect.w) && near(r.h, rect.h))) break;
        cur = only;
        depth++;
        const p = paintOf(cur);
        if (p.image) return null;
        if (!transparentColour(p.color) && p.color !== null) return painter(cur, "child", depth, p.color);
      }
      const kids = Array.from(el.children).filter((k) => {
        const p = paintOf(k);
        return p.image || !transparentColour(p.color);
      }).map((k) => pageRect(k.getBoundingClientRect()));
      if (kids.length && rect.w > 4 && rect.h > 4) {
        const l = rect.x + 2, r = rect.x + rect.w - 2, t = rect.y + 2, b = rect.y + rect.h - 2;
        const pts = [[l, t], [r, t], [l, b], [r, b], [rect.x + rect.w / 2, rect.y + rect.h / 2]];
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
    const putStroke = () => {
      const st = drawnStroke();
      if (st) {
        styles.strokeFrom = st.from;
        styles.strokeAlign = st.align;
      } else if (sides((s) => `border-${s}-width`).some((w) => w !== null && w > 0)) styles.strokeFrom = "border";
    };
    const fill2 = () => {
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
        case "backgroundColor": {
          const bg = rgba(cs.getPropertyValue("background-color"));
          put(k, bg, "no computed background-color");
          if (item.backgroundSpec && bg !== null && transparentColour(bg)) {
            const pb = paintedBy();
            if (pb !== null) styles.paintedBy = pb;
          }
          break;
        }
        case "fill": {
          const f = fill2();
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
    if (item.isText && !item.isPlaceholder) {
      const tt = typoCs.getPropertyValue("text-transform").trim();
      if (tt) styles.textTransform = tt;
    }
    return res;
  });
}
function freeHoverPoint(arg) {
  const INTERACTIVE = "a, button, input, select, textarea, [role=button], [role=link], [role=checkbox], [tabindex]:not([tabindex='-1'])";
  const owner = document.querySelector(arg.owner);
  if (!owner) return null;
  const avoidEl = document.querySelector(arg.avoid);
  const o = owner.getBoundingClientRect();
  const a = avoidEl ? avoidEl.getBoundingClientRect() : null;
  const l = o.x + 3, r = o.x + o.width - 3, t = o.y + 3, b = o.y + o.height - 3, cx = o.x + o.width / 2, cy = o.y + o.height / 2;
  const points = [[l, t], [r, t], [l, b], [r, b], [cx, t], [r, cy], [cx, b], [l, cy], [cx, cy]];
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || r < l || b < t) continue;
    if (a && a.width > 0 && a.height > 0 && x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !owner.contains(hit) || avoidEl && avoidEl.contains(hit)) continue;
    const ctl = hit.closest(INTERACTIVE);
    if (ctl && ctl !== owner && owner.contains(ctl)) continue;
    return { x: Math.round((x - o.x - owner.clientLeft) * 100) / 100, y: Math.round((y - o.y - owner.clientTop) * 100) / 100 };
  }
  return null;
}
function focusablePath(path6) {
  const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";
  const el = document.querySelector(path6);
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
function focusInfo(path6) {
  const el = document.querySelector(path6);
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
function ownerHover(spec, m, byTag) {
  const owner = spec.drawnStateFrom;
  if (owner === void 0 || owner === spec.nodeId) return { kind: "none" };
  const visible = (id) => (byTag.get(id) || []).find((c) => tagVisible(c) && !c.flags.zeroSize);
  const anc = spec.ancestorIds || [];
  const at = anc.indexOf(owner);
  const found = [];
  for (const id of [owner, ...at === -1 ? anc : anc.slice(0, at)]) {
    const c = visible(id);
    if (!c || found.some((f) => f.path === c.path)) continue;
    if (c.path === m.path) {
      if (!found.length) return { kind: "none" };
      continue;
    }
    found.push({ id, path: c.path });
  }
  const [first, ...next] = found;
  return first ? { kind: "owner", id: first.id, path: first.path, next } : { kind: "untagged", owner };
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
  const pb = raw.styles.paintedBy;
  if (isPaintedBy(pb)) styles.paintedBy = pb;
  const tt = raw.styles.textTransform;
  if (typeof tt === "string" && tt !== "") styles.textTransform = tt;
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
function isPaintedBy(x) {
  return typeof x === "object" && x !== null && "backgroundColor" in x && typeof x.backgroundColor === "string" && "via" in x && (x.via === "ancestor" || x.via === "child") && "tag" in x && typeof x.tag === "string" && "depth" in x && typeof x.depth === "number" && (!("dt" in x) || typeof x.dt === "string");
}
function census(nodes, notMeasured) {
  const c = { tag: 0, sharedPath: 0, tagAlias: 0, text: 0, textOrdinal: 0, position: 0, frame: 0, notMeasured: notMeasured.length };
  const KEY = { tag: "tag", "tag-shared-path": "sharedPath", "tag-alias": "tagAlias", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame" };
  const isMatchedBy = (v) => v !== void 0 && Object.hasOwn(KEY, v);
  for (const n of nodes) if (isMatchedBy(n.matchedBy)) c[KEY[n.matchedBy]]++;
  return c;
}

// design-to-code/verify-screen.ts
import path3 from "node:path";

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
  return isObj(x) && optArrayOf(x.heavy, (h) => isObj(h) && typeof h.file === "string" && typeof h.bytes === "number" && (h.paths === void 0 || typeof h.paths === "number") && (h.embeddedRaster === void 0 || typeof h.embeddedRaster === "number")) && optArrayOf(x.files, (f) => isObj(f) && typeof f.file === "string" && optStr(f.node));
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
var BEHAVIOUR_STATUSES = ["pass", "fail", "warn", "not-run", "unsupported"];
var isBehaviourStatus = (x) => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
function isBehaviourCheck(x) {
  return isObj(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
function isMeasuredBehaviour(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
var isRect4 = (x) => isObj(x) && isNum(x.x) && isNum(x.y) && isNum(x.w) && isNum(x.h);
function isMeasuredVisual(x) {
  return isObj(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
}
function isVerifyReferenceImage(x) {
  if (!isObj(x)) return false;
  if (x.usable === false) return (x.path === null || typeof x.path === "string") && typeof x.why === "string";
  return x.usable === true && typeof x.path === "string" && typeof x.sha256 === "string" && isObj(x.png) && isNum(x.png.w) && isNum(x.png.h) && isNum(x.scale) && x.scale > 0 && isObj(x.offset) && isNum(x.offset.x) && isNum(x.offset.y) && (x.from === "index" || x.from === "export") && isRect4(x.crop) && optStr(x.colorProfile);
}
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"],
  // the run it belongs to and the build it was served
  ["runId", (x) => typeof x === "string" && x !== "", "a run id (string) \u2014 the measurement is tied to no verify run"],
  ["build", isBuildIdentity, "a build identity {url, mode: vite-dev|static|unknown, assets, assetsSha256, gitHead, gitDirty} \u2014 read as build: unknown"],
  // the shipped probe's foreign tags
  ["tagsNotInExpectation", isTagsNotInExpectation, "a foreign-tag list {count, ids: [{id, elements}]}"],
  // the steps replayed, the page's overflow, the behaviour/a11y block
  ["reach", isProbeReach, "the probe's steps {steps[], sha256, source, url}"],
  ["page", isPageOverflow, "a page overflow {viewport:{w,h}, scrollWidth, clientWidth, overflowX, scrollable, offenders[]} \u2014 page overflow not measured"],
  ["behaviour", isMeasuredBehaviour, "a behaviour block {version: 1, ran: true, checks: [{id, status: pass|fail|warn|not-run|unsupported, detail}], \u2026} or {version: 1, ran: false, why} \u2014 behaviour/a11y not reported"],
  // the visual diff (informational)
  ["visual", isMeasuredVisual, "a visual block {version: 1, ran: true, differingPct, shiftTolerantPct, regions: [\u2026], \u2026} or {version: 1, ran: false, why} \u2014 the visual diff not reported"]
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
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"]) {
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
var TERMINAL_PHASES = ["done", "failed", "blocked"];
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
   *  permission: a directory on the way was removed while the run wrote there */
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
var RunEnded = class extends Error {
  constructor(runId, phase, detail) {
    super(`run ${runId} already ended at ${phase}${detail ? ` (${detail})` : ""} \u2014 start a new run with --new-run`);
    this.name = "RunEnded";
  }
};
function writeStatus(base, p) {
  const prev = readStatus(base);
  const same = prev && prev !== "v1" && prev.runId === p.runId ? prev : null;
  if (same && TERMINAL_PHASES.includes(same.phase)) throw new RunEnded(same.runId, same.phase, same.detail);
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
  // measured 111.83×38 against 110×36, which an inclusive 2px tolerance would let through.
  size: 1,
  // Frame-relative x/y. Loose enough for sub-pixel layout and a glyph's side-bearing, tight enough that
  // a column 18.94px out of place or a bar 130px below the frame cannot hide.
  position: 2,
  opacity: 0.02,
  // a stroke's own tolerance, inclusive — a lost 1px border (1 → 0) is a delta; the padding tolerance (1) would let it pass
  stroke: 0.5,
  // a fixed/fill-width TEXT's INK width (renderBox.w) against a Range's width (the layout advance box,
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
function resolveInside(base, rel, within = base) {
  const root = path3.resolve(within), file = path3.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path3.sep) ? file : null;
}
var KNOWN_NODE_KEYS = /* @__PURE__ */ new Set([
  "nodeId",
  "styles",
  "states",
  "matchedBy",
  "note",
  "notes",
  "selector",
  "selectorCount",
  "unmeasured",
  "textFrom",
  "textFromMixed",
  "fillSource"
]);
var KNOWN_STYLE_KEYS = /* @__PURE__ */ new Set([
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
  "fill",
  "borderColor",
  "borderWidth",
  "borderRadius",
  "gap",
  "gapVisual",
  "width",
  "height",
  "x",
  "y",
  "opacity",
  "padding",
  "text",
  "placeholderText",
  "placeholderColor",
  "tag",
  "textBox",
  "display",
  "transform",
  "rotate",
  "visible",
  // where the probe read borderWidth/borderColor (a real border, or a ring drawn by box-shadow/outline)
  "strokeFrom",
  "strokeAlign",
  // a TEXT's computed text-transform; who paints a transparent element (optional keys)
  "textTransform",
  "paintedBy",
  // free text, never read for a judgement — tolerated on either level
  "note",
  "notes"
]);
var KNOWN_MEASURED_KEYS = /* @__PURE__ */ new Set([...KNOWN_NODE_KEYS, ...KNOWN_STYLE_KEYS]);
var KEY_HINTS = {
  radius: "borderRadius",
  borderTopLeftRadius: "borderRadius",
  background: "backgroundColor",
  bg: "backgroundColor",
  w: "width",
  h: "height",
  svgFill: "fill",
  placeholder: "placeholderText",
  rowGap: "gapVisual",
  columnGap: "gap",
  // a node-level key written INSIDE styles is not read there (a styles.fillSource "img" would not exempt the fill)
  ...Object.fromEntries([...KNOWN_NODE_KEYS].filter((k) => k !== "nodeId" && k !== "styles" && k !== "note" && k !== "notes").map((k) => [k, `nodes[].${k} (beside styles, not inside)`]))
};
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
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (`fill` must be in it)
  "nodes[].styles": `computed values, EVERY key on every node \u2014 lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) \u2014 (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null \u2014 a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required for every TEXT node: its x/width are never read off the element's box",
  "nodes[].styles.display": "getComputedStyle(el).display \u2014 a FRAME/INSTANCE id on an inline element measures its text's box, not a frame's",
  "nodes[].styles.strokeFrom / strokeAlign": "where borderWidth/borderColor were read: border, or a ring (box-shadow spread / outline) and its side (inside | outside)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].styles.textTransform": "getComputedStyle(el).textTransform of a TEXT node's element (inherited) \u2014 optional; with it the build's RENDERED string is compared with the design's (spec textCase)",
  "nodes[].styles.paintedBy": "{backgroundColor, via: ancestor|child, tag, depth} \u2014 optional: when the element's own background is transparent, the nearest containing ancestor (or same-box child) that paints it",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured with the OWNER in that state (the spec's drawnStateFrom, else the node itself) \u2014 required for a node whose spec has drawnState; beside styles, never inside it; a state on a node whose spec has no drawnState is not compared (listed under Inferred, not designed)",
  "inferred[]": "{nodeId?, state, built, why?} \u2014 something the build does that the design never drew (an error message, an empty list, an open state): listed under Inferred, not designed; never graded",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} \u2014 `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} \u2014 present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find \u2014 the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against"
};
var CANONICAL_MATCH = new Set(CANONICAL_MATCHED_BY);
var INTERACTION_OUTCOMES = ["url-changed", "dialog-opened", "selector-appeared", "state-changed", "none"];
var ANY_BUT_NONE = INTERACTION_OUTCOMES.filter((o) => o !== "none");
var pctText = (n) => n > 0 && n < 0.05 ? "<0.1" : (Math.round(n * 10) / 10).toFixed(1);
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

// design-to-code/png.ts
import { crc32, deflateSync, inflateSync } from "node:zlib";
var PngError = class extends Error {
};
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunks(b) {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("not a PNG (bad signature)");
  const out = [];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    if (o + 12 + len > buf.length) throw new PngError("truncated PNG chunk");
    const type = buf.toString("latin1", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (crc32(buf.subarray(o + 4, o + 8 + len)) >>> 0 !== buf.readUInt32BE(o + 8 + len)) throw new PngError(`bad CRC in the ${type} chunk`);
    out.push({ type, data });
    o += 12 + len;
    if (type === "IEND") break;
  }
  if (!out.length || out[0]?.type !== "IHDR") throw new PngError("not a PNG (no IHDR)");
  return out;
}
var MAX_DECODE_SIDE = 4096;
var MAX_DECODE_PIXELS = MAX_DECODE_SIDE * MAX_DECODE_SIDE;
function decodePng(b) {
  const cs = chunks(b);
  const d = cs[0]?.data;
  if (!d || d.length < 13) throw new PngError("bad IHDR");
  const w = d.readUInt32BE(0), h = d.readUInt32BE(4), depth = d[8] ?? 0, ct = d[9] ?? 0, interlace = d[12] ?? 0;
  if (depth !== 8 || ct !== 2 && ct !== 6 || interlace !== 0) throw new PngError(`unsupported PNG (colour type ${ct} / depth ${depth}${interlace ? " / interlaced" : ""}) \u2014 only 8-bit RGB / RGBA, not interlaced`);
  if (!w || !h) throw new PngError("empty PNG");
  if (w * h > MAX_DECODE_PIXELS) throw new PngError(`the PNG is ${w}\xD7${h} px \u2014 over the ${MAX_DECODE_SIDE}\xD7${MAX_DECODE_SIDE} pixels this decoder reads`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data)), { maxOutputLength: (stride + 1) * h });
  } catch (e) {
    throw new PngError(`bad image data (${e instanceof Error ? e.message : String(e)})`);
  }
  if (raw.length < (stride + 1) * h) throw new PngError("truncated image data");
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0, s = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    if (f > 4) throw new PngError(`bad filter type ${f} on row ${y}`);
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i] ?? 0, a = i >= ch ? px[dst + i - ch] ?? 0 : 0, up = y ? px[prev + i] ?? 0 : 0, c = y && i >= ch ? px[prev + i - ch] ?? 0 : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + (a + up >> 1);
      else {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      px[dst + i] = v & 255;
    }
  }
  if (ch === 4) return { w, h, data: px };
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    data[j] = px[i] ?? 0;
    data[j + 1] = px[i + 1] ?? 0;
    data[j + 2] = px[i + 2] ?? 0;
    data[j + 3] = 255;
  }
  return { w, h, data };
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
function encodePng(img) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = img.w * 3 + 1, raw = Buffer.alloc(stride * img.h);
  for (let y = 0; y < img.h; y++) {
    let o = y * stride + 1, i = y * img.w * 4;
    for (let x = 0; x < img.w; x++, i += 4) {
      raw[o++] = img.data[i] ?? 0;
      raw[o++] = img.data[i + 1] ?? 0;
      raw[o++] = img.data[i + 2] ?? 0;
    }
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}
function crop(img, r) {
  const x0 = Math.max(0, Math.min(img.w, Math.round(r.x))), y0 = Math.max(0, Math.min(img.h, Math.round(r.y)));
  const w = Math.max(0, Math.min(img.w - x0, Math.round(r.w))), h = Math.max(0, Math.min(img.h - y0, Math.round(r.h)));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, data };
}
function resampleBox(img, w, h) {
  if (w <= 0 || h <= 0) return { w: Math.max(0, w), h: Math.max(0, h), data: new Uint8Array(0) };
  if (w === img.w && h === img.h) return { w, h, data: img.data.slice() };
  const spans = (n, m) => {
    const sc = n / m, out = [];
    for (let o = 0; o < m; o++) {
      const a = o * sc, b = (o + 1) * sc, list = [];
      for (let s = Math.floor(a); s < Math.min(n, Math.ceil(b)); s++) {
        const wgt = Math.min(b, s + 1) - Math.max(a, s);
        if (wgt > 1e-9) list.push([s, wgt]);
      }
      out.push(list);
    }
    return out;
  };
  const xs = spans(img.w, w), ys = spans(img.h, h);
  const tmp = new Float64Array(w * img.h * 4);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, a = 0, tw = 0;
      for (const [s, wgt] of xs[x] ?? []) {
        const i = (y * img.w + s) * 4, al = img.data[i + 3] ?? 0;
        r += (img.data[i] ?? 0) * al * wgt;
        g += (img.data[i + 1] ?? 0) * al * wgt;
        bl += (img.data[i + 2] ?? 0) * al * wgt;
        a += al * wgt;
        tw += wgt;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r / tw;
      tmp[o + 1] = g / tw;
      tmp[o + 2] = bl / tw;
      tmp[o + 3] = a / tw;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, a = 0, tw = 0;
      for (const [s, wgt] of ys[y] ?? []) {
        const i = (s * w + x) * 4;
        r += (tmp[i] ?? 0) * wgt;
        g += (tmp[i + 1] ?? 0) * wgt;
        bl += (tmp[i + 2] ?? 0) * wgt;
        a += (tmp[i + 3] ?? 0) * wgt;
        tw += wgt;
      }
      const o = (y * w + x) * 4;
      a /= tw;
      data[o + 3] = Math.round(a);
      if (a > 0) {
        data[o] = Math.round(r / tw / a);
        data[o + 1] = Math.round(g / tw / a);
        data[o + 2] = Math.round(bl / tw / a);
      }
    }
  }
  return { w, h, data };
}

// design-to-code/probe-drive.ts
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
  const roots = Array.from(document.querySelectorAll('dialog[open], [aria-modal="true" i]')).filter((el) => el.getClientRects().length > 0);
  window.__dtDrive = { before, destBefore, destPaths: destBefore.map(pathOf), roots };
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
function saveScroll(el) {
  const boxes = [];
  for (let p = el.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
  window.__dtDriveScroll = { x: scrollX, y: scrollY, boxes };
}
function restoreScroll() {
  const s = window.__dtDriveScroll;
  if (!s) return;
  for (const b of s.boxes) if (b.el.scrollLeft !== b.left || b.el.scrollTop !== b.top) b.el.scrollTo({ left: b.left, top: b.top, behavior: "instant" });
  scrollTo({ left: s.x, top: s.y, behavior: "instant" });
}
function scrollHeld() {
  const s = window.__dtDriveScroll;
  if (!s) return true;
  const near = (a, b) => Math.abs(a - b) < 1;
  return near(scrollX, s.x) && near(scrollY, s.y) && s.boxes.every((b) => near(b.el.scrollLeft, b.left) && near(b.el.scrollTop, b.top));
}
function ownMark(_arg) {
  const o = window.__dtOwn;
  if (!o || !o.box.isConnected || !o.ctl.isConnected) return null;
  const { box, ctl } = o;
  if ((box.getRootNode?.()?.host ?? null) !== null) return { ctl: "its sole control", keep: 0, why: "the opener lies inside a shadow root, where its pixels cannot be compared", scrolled: false };
  const up = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
  const active = document.activeElement;
  if (active && active !== document.body) o.focus = active;
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const r0 = box.getBoundingClientRect();
  if (r0.x < 0 || r0.y < 0 || r0.right > vw || r0.bottom > vh) {
    const boxes = [];
    for (let p = box.parentElement; p; p = p.parentElement) boxes.push({ el: p, left: p.scrollLeft, top: p.scrollTop });
    o.saved = { x: scrollX, y: scrollY, boxes };
    box.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
  const css = (e, prop) => getComputedStyle(e).getPropertyValue(prop).trim();
  const px = (v) => parseFloat(v) || 0;
  const b = box.getBoundingClientRect(), c = ctl.getBoundingClientRect();
  const x0 = b.x + px(css(box, "border-left-width")), y0 = b.y + px(css(box, "border-top-width"));
  const x1 = b.right - px(css(box, "border-right-width")), y1 = b.bottom - px(css(box, "border-bottom-width"));
  const plainBox = (e) => !/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|FRAME|FENCEDFRAME|PROGRESS|METER|INPUT|SELECT|TEXTAREA)$/.test(e.tagName.toUpperCase()) && (css(e, "clip-path") === "" || css(e, "clip-path") === "none") && css(e, "background-clip").split(",").every((v) => /^(border-box|padding-box)$/.test(v.trim())) && !/list-item/.test(css(e, "display")) && !e.shadowRoot;
  const plainFill = (e) => ["background-image", "mask-image", "box-shadow", "filter", "backdrop-filter"].every((k) => {
    const v = css(e, k);
    return v === "" || v === "none";
  }) && ["top", "right", "bottom", "left"].every((side) => px(css(e, `border-${side}-width`)) === 0 || css(e, `border-${side}-style`) === "none") && (px(css(e, "outline-width")) === 0 || css(e, "outline-style") === "none");
  box.setAttribute("data-dt-own", "");
  ctl.setAttribute("data-dt-own-ctl", "");
  for (let p = up(box); p; p = up(p)) p.setAttribute("data-dt-own-up", "");
  if (active && active !== document.body && !box.contains(active)) active.setAttribute("data-dt-own-foc", "");
  const roots = [];
  const els = [];
  const todo = [{ e: box, inCtl: false }];
  for (let t = todo.pop(); t; t = todo.pop()) {
    if (els.length >= 2e4) {
      o.roots = roots;
      return { ctl: "", keep: 0, why: "more than 20000 boxes to hide", scrolled: !!o.saved };
    }
    const inCtl = t.inCtl || t.e === ctl;
    if (t.e !== box) els.push({ e: t.e, inCtl });
    const sr = t.e.shadowRoot;
    if (sr) {
      roots.push({ root: sr, inCtl });
      for (const k of Array.from(sr.children)) todo.push({ e: k, inCtl });
    }
    for (const k of Array.from(t.e.children)) todo.push({ e: k, inCtl });
  }
  o.roots = roots;
  o.els = els;
  const all = Array.from(box.querySelectorAll("*"));
  let keep = 0;
  for (let i = 0; i < all.length && i < 2e3; i++) {
    const e = all[i];
    if (!e || e === ctl || ctl.contains(e) || css(e, "visibility") !== "visible" || !plainBox(e)) continue;
    const r = e.getBoundingClientRect();
    const hugs = e.contains(ctl) && r.x >= c.x - 8 && r.y >= c.y - 8 && r.right <= c.right + 8 && r.bottom <= c.bottom + 8;
    const covers = r.x <= x0 + 1 && r.y <= y0 + 1 && r.right >= x1 - 1 && r.bottom >= y1 - 1 && plainFill(e);
    if (hugs || covers) {
      e.setAttribute("data-dt-own-keep", "");
      keep++;
    }
  }
  const label = ctl.getAttribute("aria-label");
  return { ctl: `<${ctl.tagName.toLowerCase()}${ctl.getAttribute("type") ? ` type="${ctl.getAttribute("type") ?? ""}"` : ""}${ctl.getAttribute("role") ? ` role="${ctl.getAttribute("role") ?? ""}"` : ""}${label ? ` aria-label="${label}"` : ""}>`, keep, why: null, scrolled: !!o.saved };
}
function ownShot(arg) {
  const o = window.__dtOwn;
  const no = (why) => ({ clip: null, why, keep: [] });
  if (!o) return no("the probe lost the opener it compares");
  const hi = "#dt-own-0#dt-own-0#dt-own-0";
  const lift = (sel) => `:is(${sel}, ${hi})`;
  const H = "{ visibility: hidden !important; transition: none !important; }";
  const pseudos = (sel) => [sel, `${sel}::before`, `${sel}::after`].join(", ");
  const EXTRA_PSEUDOS = ["::placeholder", "::file-selector-button", "::details-content", "::scroll-button(*)", "::scroll-marker", "::scroll-marker-group"];
  const extra = (sel) => EXTRA_PSEUDOS.map((ps) => `${sel}${ps} { visibility: hidden !important; transition: none !important;${ps === "::placeholder" ? " color: transparent !important;" : ""} }`).join("\n");
  if (arg.shot !== "A" && Array.from(o.box.querySelectorAll(":not([data-dt-own-in])")).some((e) => !o.ctl.contains(e))) return no("the opener's content changed while it was compared (an element mounted in it during the screenshots)");
  for (const e of Array.from(o.box.querySelectorAll("*"))) if (!e.hasAttribute("data-dt-own-in")) e.setAttribute("data-dt-own-in", "");
  for (const e of Array.from(o.ctl.querySelectorAll("*"))) if (!e.hasAttribute("data-dt-own-cin")) e.setAttribute("data-dt-own-cin", "");
  const notOwn = lift(":not([data-dt-own], [data-dt-own-in], [data-dt-own-foc])");
  const own = lift("[data-dt-own]");
  const inner = lift("[data-dt-own-in]");
  const foc = lift("[data-dt-own-foc]");
  const SHOW = "{ visibility: visible !important; transition: none !important; }";
  const outside = [
    `${pseudos(notOwn)} ${H}`,
    `${foc} ${SHOW}`,
    `${foc}::before, ${foc}::after ${H}`,
    extra(foc),
    `${lift("[data-dt-own-up]")} { background: none !important; }`
  ].join("\n");
  const shown = `${own} ${SHOW}`;
  const content = [`${[inner, `${own}::before`, `${own}::after`, `${inner}::before`, `${inner}::after`].join(", ")} ${H}`, extra(inner), extra(own)].join("\n");
  const kept = `:is([data-dt-own-keep], ${hi}#dt-own-0) { visibility: visible !important; transition: none !important; }`;
  const flat = `${lift(":is([data-dt-own-up], [data-dt-own])")} { filter: none !important; clip-path: none !important; mask: none !important; backdrop-filter: none !important; }`;
  const ctl = lift("[data-dt-own-ctl]"), ctlIn = lift("[data-dt-own-cin]");
  const text = arg.shot === "A" ? `${outside}
${shown}
${[ctl, ctlIn].map(pseudos).join(", ")} ${H}
${extra(ctl)}
${extra(ctlIn)}` : arg.shot === "B" ? `${outside}
${shown}
${content}
${own}::marker { color: transparent !important; }
${kept}` : arg.shot === "K" ? `${outside}
${content}
${own} ${H}
${kept}
${flat}` : `${outside}
${content}
${own} ${H}
${flat}`;
  if (!o.sheet) {
    o.sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, o.sheet];
  }
  o.sheet.replaceSync(text);
  const roots = o.roots ?? [];
  if (roots.length && !o.rootSheet) {
    o.rootSheet = new CSSStyleSheet();
    o.rootSheet.replaceSync(`${pseudos(lift("*"))} ${H}`);
  }
  const rootSheet = o.rootSheet;
  for (const { root, inCtl } of roots) {
    if (!rootSheet) break;
    const rest = root.adoptedStyleSheets.filter((x) => x !== rootSheet);
    root.adoptedStyleSheets = arg.shot !== "A" || inCtl ? [...rest, rootSheet] : rest;
  }
  const vis = (e, pseudo = null) => getComputedStyle(e, pseudo).getPropertyValue("visibility");
  const name = (e) => `<${e.tagName.toLowerCase()}>`;
  const beat = "against the probe's hiding rule (an inline or cascade-layer !important)";
  if (o.ctl.isConnected && o.ctl.getClientRects().length > 0 && vis(o.ctl) !== "hidden") return no(`the page kept its control showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::before") !== "hidden") return no(`the page kept the opener's own ::before showing ${beat}`);
  if (arg.shot !== "A" && vis(o.box, "::after") !== "hidden") return no(`the page kept the opener's own ::after showing ${beat}`);
  if ((arg.shot === "K" || arg.shot === "N") && vis(o.box) !== "hidden") return no(`the page kept the opener showing ${beat}`);
  const st = (e, prop, pseudo = null) => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
  const generated = (e, ps) => !/^(none|normal)?$/.test(st(e, "content", ps));
  const others = (e) => ["::first-letter", ...EXTRA_PSEUDOS].filter((ps) => ps === "::first-letter" ? Array.from(e.childNodes).some((t) => t.nodeType === 3 && /\S/.test(t.nodeValue ?? "")) : ps === "::placeholder" ? /^(INPUT|TEXTAREA)$/.test(e.tagName.toUpperCase()) && e.hasAttribute("placeholder") : ps === "::file-selector-button" ? e.tagName.toUpperCase() === "INPUT" && (e.getAttribute("type") ?? "").toLowerCase() === "file" : ps === "::details-content" ? e.tagName.toUpperCase() === "DETAILS" : ps === "::scroll-marker-group" ? !/^(none)?$/.test(st(e, "scroll-marker-group")) : generated(e, ps));
  if (arg.shot !== "A") {
    for (const ps of others(o.box)) if (vis(o.box, ps) !== "hidden") return no(`the page kept the opener's own ${ps} showing ${beat}`);
  }
  for (const { e, inCtl } of o.els ?? []) {
    if (!e.isConnected || arg.shot === "A" && !inCtl || arg.shot !== "A" && arg.shot !== "N" && e.hasAttribute("data-dt-own-keep")) continue;
    if (vis(e) !== "hidden") return no(`the page kept ${name(e)} inside the opener showing ${beat}`);
    for (const ps of ["::before", "::after"]) {
      const c = getComputedStyle(e, ps).getPropertyValue("content");
      if (c !== "none" && c !== "normal" && vis(e, ps) !== "hidden") return no(`the page kept a ${ps} inside the opener showing ${beat}`);
    }
    for (const ps of others(e)) if (vis(e, ps) !== "hidden") return no(`the page kept a ${ps} inside the opener showing ${beat}`);
  }
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const r = o.box.getBoundingClientRect();
  const cx0 = Math.max(0, Math.floor(r.x)), cy0 = Math.max(0, Math.floor(r.y)), cx1 = Math.min(vw, Math.ceil(r.right)), cy1 = Math.min(vh, Math.ceil(r.bottom));
  if (cx1 - cx0 < 1 || cy1 - cy0 < 1) return no("nothing of the opener is on screen to compare");
  const keep = [];
  if (arg.shot === "K") {
    const len = (t, size) => t.endsWith("%") ? (parseFloat(t) || 0) / 100 * size : parseFloat(t) || 0;
    const shape = (p, inner2) => {
      const pr = p.getBoundingClientRect();
      const w = pr.width, h = pr.height;
      const r2 = [];
      for (const k of ["top-left", "top-right", "bottom-right", "bottom-left"]) {
        const v = st(p, `border-${k}-radius`).split(/\s+/);
        r2.push(len(v[0] ?? "0", w), len(v[1] ?? v[0] ?? "0", h));
      }
      const f = Math.min(1, ...[[0, 2, w], [6, 4, w], [1, 7, h], [3, 5, h]].map(([i = 0, j = 0, side = 0]) => {
        const sum = (r2[i] ?? 0) + (r2[j] ?? 0);
        return sum > 0 ? side / sum : 1;
      }));
      const sc = r2.map((v) => v * f);
      if (!inner2) return { x: pr.x, y: pr.y, right: pr.right, bottom: pr.bottom, r: sc };
      const bt = parseFloat(st(p, "border-top-width")) || 0, brw = parseFloat(st(p, "border-right-width")) || 0, bb = parseFloat(st(p, "border-bottom-width")) || 0, bl = parseFloat(st(p, "border-left-width")) || 0;
      const cut = [bl, bt, brw, bt, brw, bb, bl, bb];
      return { x: pr.x + bl, y: pr.y + bt, right: pr.right - brw, bottom: pr.bottom - bb, r: sc.map((v, i) => Math.max(0, v - (cut[i] ?? 0))) };
    };
    for (const e of Array.from(document.querySelectorAll("[data-dt-own-keep]"))) {
      const q = e.getBoundingClientRect();
      const shapes = [shape(e, false)];
      for (let p = e === o.box ? null : e.parentElement; p; p = p === o.box ? null : p.parentElement) {
        if (st(p, "overflow-x") !== "visible" || st(p, "overflow-y") !== "visible") shapes.push(shape(p, true));
      }
      const bg = st(e, "background-color");
      const filled = !(bg === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(bg));
      keep.push({ x: q.x, y: q.y, right: q.right, bottom: q.bottom, filled, shapes });
    }
  }
  return { clip: { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 }, why: null, keep };
}
function ownWhy(_arg) {
  return window.__dtOwnWhy ?? null;
}
function tipPreMark(_arg) {
  if (window.__dtTipPre) return false;
  const pre = /* @__PURE__ */ new WeakSet();
  const vis = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const todo = [document.documentElement];
  let n = 0;
  for (let e = todo.pop(); e; e = todo.pop()) {
    if (++n > 5e5) {
      window.__dtTipPre = null;
      return false;
    }
    for (const k of Array.from(e.children)) todo.push(k);
    const sr = e.shadowRoot;
    if (sr) for (const k of Array.from(sr.children)) todo.push(k);
    if ((e.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() !== "tooltip" && !e.getAttribute("id")) continue;
    if (!e.checkVisibility({ opacityProperty: true })) continue;
    if (vis(e)) {
      pre.add(e);
      continue;
    }
    const d = e.querySelectorAll("*");
    if (d.length > 2e3 || Array.from(d).some(vis)) pre.add(e);
  }
  window.__dtTipPre = pre;
  return true;
}
function ownClear(_arg) {
  const o = window.__dtOwn;
  if (o && o.sheet) {
    const sheet = o.sheet;
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
  }
  if (o && o.rootSheet && o.roots) {
    const sheet = o.rootSheet;
    for (const { root } of o.roots) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((x) => x !== sheet);
  }
  for (const e of Array.from(document.querySelectorAll("[data-dt-own], [data-dt-own-ctl], [data-dt-own-keep], [data-dt-own-up], [data-dt-own-foc], [data-dt-own-in], [data-dt-own-cin]"))) {
    e.removeAttribute("data-dt-own-foc");
    e.removeAttribute("data-dt-own-in");
    e.removeAttribute("data-dt-own-cin");
    e.removeAttribute("data-dt-own");
    e.removeAttribute("data-dt-own-ctl");
    e.removeAttribute("data-dt-own-keep");
    e.removeAttribute("data-dt-own-up");
  }
  if (o && o.saved) {
    for (const b of o.saved.boxes) if (b.el.scrollLeft !== b.left || b.el.scrollTop !== b.top) b.el.scrollTo({ left: b.left, top: b.top, behavior: "instant" });
    scrollTo({ left: o.saved.x, top: o.saved.y, behavior: "instant" });
  }
  if (o && o.focus && o.focus.isConnected && document.activeElement !== o.focus) o.focus.focus({ preventScroll: true });
  window.__dtOwn = null;
  return true;
}
function syntheticClick(path6) {
  const el = document.querySelector(path6);
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
function clickPointControl(el, arg) {
  const mark = !!arg && arg.mark;
  if (mark) {
    window.__dtOwn = null;
    window.__dtOwnWhy = null;
  }
  const FOC = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const BTN = "button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]";
  const ACT = `${BTN}, [role=checkbox i], [role=switch i], [role=radio i], [role=option i], [role=menuitemcheckbox i], [role=menuitemradio i], input[type=checkbox i], input[type=radio i], input[type=submit i], input[type=button i], input[type=image i], input[type=reset i], input[type=file i]`;
  const self = el.matches(FOC);
  const ownContent = (box, ctl) => {
    const up2 = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
    const css = (e, prop, pseudo = null) => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
    const set = (e, prop, pseudo = null) => {
      const v = css(e, prop, pseudo);
      return v !== "" && v !== "none";
    };
    const chain = (test) => {
      const memo = /* @__PURE__ */ new Map();
      return (e) => {
        const seen = [];
        let hit = false;
        for (let p = e; p && p !== box; p = up2(p)) {
          const m = memo.get(p);
          if (m !== void 0) {
            hit = m;
            break;
          }
          seen.push(p);
          if (test(p)) {
            hit = true;
            break;
          }
        }
        for (const s of seen) memo.set(s, hit);
        return hit;
      };
    };
    let work = 0;
    const OWN_WORK_CAP = 2e4;
    const tick = () => ++work > OWN_WORK_CAP;
    const inCtl = chain((p) => p === ctl);
    const outOfFlow = (e, pseudo = null) => /^(absolute|fixed)$/.test(css(e, "position", pseudo));
    const faded = chain((p) => css(p, "opacity") === "0" && outOfFlow(p));
    const boxed = (e) => {
      let p = e;
      while (p && css(p, "display") === "contents") p = up2(p);
      return p;
    };
    const shown = (e) => {
      const b = boxed(e);
      return !!b && b.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !/^(hidden|collapse)$/.test(css(e, "visibility")) && !faded(b);
    };
    const holdsFixed = (p) => ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => set(p, k)) || css(p, "transform-style") === "preserve-3d" || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(css(p, "will-change")) || /\b(layout|paint|strict|content)\b/.test(css(p, "contain")) || /^(auto|hidden)$/.test(css(p, "content-visibility"));
    const de2 = document.documentElement;
    const horizontal = !/^(vertical|sideways)/.test(css(de2, "writing-mode"));
    let sx = scrollX, sy = scrollY;
    for (let p = box; p && p !== de2; p = up2(p)) {
      sx += Math.abs(p.scrollLeft || 0);
      sy += Math.abs(p.scrollTop || 0);
    }
    const startX = horizontal && css(de2, "direction") !== "rtl" ? -sx : -Infinity, startY = horizontal ? -sy : -Infinity;
    const clipped = (e, q) => {
      let x0 = Math.max(q.x, startX), y0 = Math.max(q.y, startY), x1 = q.right, y1 = q.bottom;
      let flow = "in";
      for (let p = e; p; p = p === box ? null : up2(p)) {
        if (tick()) return null;
        if (css(p, "display") === "contents") continue;
        const pr = p.getBoundingClientRect();
        const pos = css(p, "position");
        const skip = p !== e && (flow === "fixed" ? !holdsFixed(p) : flow === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pos) && !holdsFixed(p));
        if (!skip) {
          const ox = css(p, "overflow-x"), oy = css(p, "overflow-y");
          const cm = ox === "clip" && oy === "clip" ? parseFloat(/(-?[\d.]+)px/.exec(css(p, "overflow-clip-margin"))?.[1] ?? "0") || 0 : 0;
          if (ox !== "visible") {
            x0 = Math.max(x0, pr.x - cm);
            x1 = Math.min(x1, pr.right + cm);
          }
          if (oy !== "visible") {
            y0 = Math.max(y0, pr.y - cm);
            y1 = Math.min(y1, pr.bottom + cm);
          }
          flow = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "in";
        }
        const ins = /^inset\((.*)\)$/.exec(css(p, "clip-path"));
        if (ins) {
          const [t = "0", r2 = t, b = t, l = r2] = (ins[1] ?? "").split(/\s+round\s+/)[0]?.trim().split(/\s+/) ?? [];
          const len = (s, size) => s.endsWith("%") ? parseFloat(s) / 100 * size : parseFloat(s);
          const T = len(t, pr.height), R = len(r2, pr.width), B = len(b, pr.height), L = len(l, pr.width);
          if (![T, R, B, L].some(Number.isNaN)) {
            x0 = Math.max(x0, pr.x + L);
            x1 = Math.min(x1, pr.right - R);
            y0 = Math.max(y0, pr.y + T);
            y1 = Math.min(y1, pr.bottom - B);
          }
        }
        const rc = /^rect\((.*)\)$/.exec(css(p, "clip"));
        if (rc && /^(absolute|fixed)$/.test(pos)) {
          const v = (rc[1] ?? "").split(/[\s,]+/).filter(Boolean);
          const at2 = (s, auto) => s === void 0 || s === "auto" ? auto : parseFloat(s);
          const T = at2(v[0], 0), R = at2(v[1], pr.width), B = at2(v[2], pr.height), L = at2(v[3], 0);
          if (v.length === 4 && ![T, R, B, L].some(Number.isNaN)) {
            x0 = Math.max(x0, pr.x + L);
            x1 = Math.min(x1, pr.x + R);
            y0 = Math.max(y0, pr.y + T);
            y1 = Math.min(y1, pr.y + B);
          }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const area = (e, q) => {
      const c = clipped(e, q);
      return c ? Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0) : Infinity;
    };
    const els = [];
    const texts = [];
    const todo = [box];
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
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k) todo.push(k);
      }
    }
    const cr = ctl.getBoundingClientRect(), mx = cr.x + cr.width / 2, my = cr.y + cr.height / 2;
    const chrome = (e) => {
      if (e.contains(ctl)) return true;
      const r2 = e.getBoundingClientRect();
      return mx >= r2.x && mx <= r2.right && my >= r2.y && my <= r2.bottom;
    };
    const clear = (v) => v === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(v);
    for (const e of els) {
      if (inCtl(e) || !shown(e)) continue;
      if (/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(e.tagName.toUpperCase()) && area(e, e.getBoundingClientRect()) > 1) return `<${e.tagName.toLowerCase()}>`;
      const host = boxed(e) ?? e;
      for (const ps of ["::before", "::after"]) {
        const c = css(e, "content", ps);
        if (!c || c === "none" || c === "normal" || css(e, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(e, "visibility", ps)) || css(e, "opacity", ps) === "0" && outOfFlow(e, ps)) continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        const s = str ? str[1] ?? "" : null;
        const fill2 = !clear(css(e, "background-color", ps));
        const paints2 = s === null || /\S/.test(s) || set(e, "background-image", ps) || set(e, "mask-image", ps) || fill2 && (s !== "" || !chrome(host));
        if (paints2 && area(host, host.getBoundingClientRect()) > 1) return `${ps} content`;
      }
      if (/list-item/.test(css(e, "display")) && (!/^(none)?$/.test(css(e, "list-style-type")) || set(e, "list-style-image") || !/^(normal|none)?$/.test(css(e, "content", "::marker"))) && area(e, e.getBoundingClientRect()) > 1) return "a list marker";
      if ((!/^(visible|clip)$/.test(css(e, "overflow-x")) || !/^(visible|clip)$/.test(css(e, "overflow-y"))) && !/^(none|normal)?$/.test(css(e, "content", "::scroll-button(*)")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll button";
      if (!/^(none)?$/.test(css(e, "scroll-marker-group")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll-marker group";
      if (e === box) {
        if (/\b(url|image|image-set|cross-fade|element|paint|[a-z-]*gradient)\(/i.test(css(e, "background-image"))) return "its own background image";
        if (set(e, "border-image-source")) return "its own border image";
        const sides = ["top", "right", "bottom", "left"].map((k) => ({ w: /^(none|hidden)$/.test(css(e, `border-${k}-style`)) ? 0 : parseFloat(css(e, `border-${k}-width`)) || 0, c: css(e, `border-${k}-color`) }));
        const painted = sides.filter((d) => d.w > 0 && !clear(d.c));
        if (new Set(painted.map((d) => d.c)).size > 1) return "its own border in more than one colour";
        const ws = sides.map((d) => d.w > 0 && !clear(d.c) ? d.w : 0);
        if (painted.length > 0 && Math.max(...ws) - Math.min(...ws) >= 2) return "its own border stripe";
        const layers = [];
        let depth = 0, cur = "";
        for (const ch of `${css(e, "box-shadow")},`) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch !== "," || depth > 0) {
            cur += ch;
            continue;
          }
          const n = Array.from(cur.matchAll(/(-?[\d.]+)px/g), (m) => parseFloat(m[1] ?? "0") || 0);
          const c = cur.replace(/-?[\d.]+px/g, "").replace(/\binset\b/, "").trim();
          if (n.length >= 2 && c !== "" && c !== "none" && !clear(c)) layers.push({ c, n, inset: /\binset\b/.test(cur) });
          cur = "";
        }
        if (layers.some((l) => l.inset && (Math.max(Math.abs(l.n[0] ?? 0), Math.abs(l.n[1] ?? 0)) >= 2 || (l.n[2] ?? 0) > 0))) return "its own inset box-shadow (a stripe, a fill or a glow)";
        const ownBg = css(e, "background-color");
        const rings = layers.filter((l) => !((l.n[2] ?? 0) > 0) && (l.n[0] !== 0 || l.n[1] !== 0 || (l.n[3] ?? 0) !== 0) && !(l.c === ownBg && (!l.inset || /^rgb\(/.test(ownBg) && /^(border|padding)-box$/.test(css(e, "background-clip")))));
        if (new Set(rings.map((l) => l.c)).size > 1) return "its own box-shadow ring in more than one colour";
        const paints2 = !clear(css(e, "background-color")) || painted.length > 0 || layers.length > 0;
        if (paints2 && set(e, "mask-image")) return "its own paint under a mask";
        const cp = css(e, "clip-path");
        if (paints2 && cp !== "" && cp !== "none" && !/^inset\(0(px)?( 0(px)?){0,3}( round .*)?\)$/.test(cp)) return "its own paint under a clip-path";
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
    const br = box.getBoundingClientRect();
    const anc = /* @__PURE__ */ new Set();
    for (let p = up2(box); p; p = up2(p)) anc.add(p);
    const bg = css(box, "background-color");
    let opaque = /^rgb\(/.test(bg) || /^rgba\(.*,\s*1\)$/.test(bg);
    for (let p = box; p && opaque; p = up2(p)) {
      const op = css(p, "opacity"), bm = css(p, "mix-blend-mode");
      if (op !== "" && parseFloat(op) < 1 || bm !== "" && bm !== "normal") opaque = false;
    }
    const meets = (q) => q.right > br.x && q.x < br.right && q.bottom > br.y && q.y < br.bottom;
    const over = (f, c, events) => {
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
    const tipIds = new Set((ctl.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    const tipPre = window.__dtTipPre;
    const tip = (f) => !!tipPre && !tipPre.has(f) && !anc.has(f) && ((f.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "tooltip" || tipIds.has(f.getAttribute("id") ?? ""));
    const gone2 = chain((p) => css(p, "opacity") === "0");
    const FOREIGN_CAP = 5e5;
    let walked = 0;
    const moved = (f) => {
      const s = getComputedStyle(f);
      return s.getPropertyValue("position") !== "static" || ["transform", "translate", "rotate", "scale"].some((k) => {
        const v = s.getPropertyValue(k);
        return v !== "" && v !== "none";
      });
    };
    const ftodo = [{ f: de2, near: true }];
    for (let t = ftodo.pop(); t; t = ftodo.pop()) {
      if (++walked > FOREIGN_CAP) return `more than ${FOREIGN_CAP} boxes on the page to check for a label laid over it`;
      const f = t.f;
      if (f === box || tip(f)) continue;
      const isAnc = anc.has(f);
      const fr = t.near || isAnc || moved(f) ? f.getBoundingClientRect() : null;
      const near = isAnc || fr !== null && meets(fr);
      const sr = f.shadowRoot;
      for (const k of Array.from(f.children ?? [])) ftodo.push({ f: k, near });
      if (sr) for (const k of Array.from(sr.children)) ftodo.push({ f: k, near });
      if (!fr || !near || pinned(f) || !shown(f) || gone2(f)) continue;
      const events = css(f, "pointer-events");
      for (const t2 of [...Array.from(f.childNodes), ...sr ? Array.from(sr.childNodes) : []]) {
        const text = t2.nodeType === 3 ? (t2.nodeValue || "").trim() : "";
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(t2);
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
        let q = fr;
        if (pos === "absolute") {
          let cb = f;
          while (cb && css(cb, "position") === "static" && !holdsFixed(cb)) cb = up2(cb);
          const cr0 = cb ? cb.getBoundingClientRect() : null;
          const n = (k) => parseFloat(css(f, k, ps)) || 0;
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
  const inner = Array.from(el.querySelectorAll(FOC));
  const up = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
  const framed = (e) => /^(IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME)$/.test(e.tagName.toUpperCase());
  const pick = (e) => e.tagName.toUpperCase() === "LABEL" ? e.control ?? null : e.matches(FOC) || e.matches(ACT) || framed(e) ? e : null;
  const presses = (e) => !!e && (e.matches(ACT) || framed(e));
  let at = null;
  if (onScreen) {
    let hit = document.elementFromPoint(cx, cy), from = hit;
    for (let i = 0; hit && hit.shadowRoot && i < 32; i++) {
      const host = hit, sr = hit.shadowRoot;
      const deeper = sr.elementFromPoint ? sr.elementFromPoint(cx, cy) : null;
      let under = false;
      for (let p = deeper; p; p = up(p)) if (p === host) {
        under = true;
        break;
      }
      if (deeper && deeper !== host && under) {
        hit = deeper;
        from = deeper;
        continue;
      }
      const slotted = Array.from(host.childNodes).find((t) => {
        if (t.nodeType !== 3 || !t.assignedSlot) return false;
        const rg = document.createRange();
        rg.selectNodeContents(t);
        return Array.from(rg.getClientRects()).some((q) => cx >= q.x && cx <= q.right && cy >= q.y && cy <= q.bottom);
      });
      from = slotted && slotted.assignedSlot ? slotted.assignedSlot : host;
      break;
    }
    let found = null;
    for (let p = from; p; p = up(p)) {
      if (p === el) {
        at = found;
        break;
      }
      if (presses(found)) continue;
      const k = pick(p);
      if (k && (!found || presses(k))) found = k;
    }
  } else {
    const holds = Array.from(el.querySelectorAll(`${FOC}, ${ACT}, label, frame, object, embed, fencedframe`)).filter((c) => {
      const b = c.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && cx >= b.x && cx <= b.right && cy >= b.y && cy <= b.bottom;
    });
    for (const h of holds) {
      const k = pick(h);
      if (k && (!presses(at) || presses(k))) at = k;
    }
  }
  if (!presses(at)) return null;
  if (!self && inner.length === 1 && inner[0] === at && at.matches(BTN)) {
    const own = ownContent(el, at);
    if (own === null) {
      if (mark) window.__dtOwn = { box: el, ctl: at };
      return null;
    }
    if (mark) window.__dtOwnWhy = `its own content: ${own}`;
  }
  const label = at.getAttribute("aria-label");
  return `<${at.tagName.toLowerCase()}${at.getAttribute("type") ? ` type="${at.getAttribute("type") ?? ""}"` : ""}${at.getAttribute("role") ? ` role="${at.getAttribute("role") ?? ""}"` : ""}${label ? ` aria-label="${label}"` : ""}>`;
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
function shapeDistance(q, px, py) {
  const hw = (q.right - q.x) / 2, hh = (q.bottom - q.y) / 2, dx = px - (q.x + hw), dy = py - (q.y + hh);
  const i = dy < 0 ? dx < 0 ? 0 : 1 : dx < 0 ? 3 : 2;
  const rx = q.r[2 * i] ?? 0, ry = q.r[2 * i + 1] ?? 0;
  const ax = Math.abs(dx), ay = Math.abs(dy), qx = ax - (hw - rx), qy = ay - (hh - ry);
  if (rx > 0 && ry > 0 && qx > 0 && qy > 0) {
    const f = (qx / rx) ** 2 + (qy / ry) ** 2 - 1, g = 2 * Math.hypot(qx / (rx * rx), qy / (ry * ry));
    return g > 0 ? f / g : -Math.min(rx, ry);
  }
  return Math.max(ax - hw, ay - hh);
}
var KEPT_EDGE_PX = 1.5;
function plainKept(k, n, clip, keep) {
  if (k.w !== n.w || k.h !== n.h) return "the two screenshots differ in size";
  const filled = keep.filter((r) => r.filled).map((r) => ({
    // pixel columns / rows, clip-relative, that can hold a part of it: [ox0, ox1) × [oy0, oy1)
    ox0: Math.floor(r.x - clip.x) - 2,
    ox1: Math.ceil(r.right - clip.x) + 2,
    oy0: Math.floor(r.y - clip.y) - 2,
    oy1: Math.ceil(r.bottom - clip.y) + 2,
    shapes: r.shapes,
    mx: Math.floor((r.x + r.right) / 2 - clip.x),
    my: Math.floor((r.y + r.bottom) / 2 - clip.y)
  }));
  const at = (img, x, y, c) => img.data[(y * k.w + x) * 4 + c] ?? 0;
  const near = (x, y, col, tol) => [0, 1, 2].every((c) => Math.abs(at(k, x, y, c) - (col[c] ?? 0)) <= tol);
  const f0 = filled[0];
  const C = f0 ? [0, 1, 2].map((c) => at(k, Math.min(k.w - 1, Math.max(0, f0.mx)), Math.min(k.h - 1, Math.max(0, f0.my)), c)) : [];
  for (let y = 0; y < k.h; y++) {
    for (let x = 0; x < k.w; x++) {
      const N = [0, 1, 2].map((c) => at(n, x, y, c));
      let zone = "out";
      for (const f of filled) {
        if (x < f.ox0 || x >= f.ox1 || y < f.oy0 || y >= f.oy1) continue;
        const px = x + 0.5 + clip.x, py = y + 0.5 + clip.y;
        let sd = -Infinity;
        for (const q of f.shapes) sd = Math.max(sd, shapeDistance(q, px, py));
        if (sd <= -KEPT_EDGE_PX) {
          zone = "core";
          break;
        }
        if (sd < KEPT_EDGE_PX) zone = "band";
      }
      if (zone === "out") {
        if (!near(x, y, N, 1)) return `a kept box paints outside itself (at ${x}, ${y} of the opener)`;
        continue;
      }
      if (zone === "core") {
        if (!near(x, y, C, 1)) return `a kept box does not paint one plain colour (at ${x}, ${y} of the opener)`;
        continue;
      }
      const d = [0, 1, 2].map((c) => (C[c] ?? 0) - (N[c] ?? 0));
      const big = [0, 1, 2].reduce((m, c) => Math.abs(d[c] ?? 0) > Math.abs(d[m] ?? 0) ? c : m, 0);
      const db = d[big] ?? 0;
      if (Math.abs(db) <= 3) {
        if (!near(x, y, N, 3)) return `a kept box's edge is not a blend of its colour (at ${x}, ${y} of the opener)`;
        continue;
      }
      const t = (at(k, x, y, big) - (N[big] ?? 0)) / db;
      if (t < -0.02 || t > 1.02 || ![0, 1, 2].every((c) => Math.abs((N[c] ?? 0) + t * (d[c] ?? 0) - at(k, x, y, c)) <= 3)) return `a kept box's edge is not a blend of its colour (at ${x}, ${y} of the opener)`;
    }
  }
  return null;
}
var OWN_SHOT_MS = 5e3;
async function ownPixels(page, o) {
  let ctl = "its sole control";
  try {
    const m = await page.evaluate(ownMark, null);
    if (m === null) return null;
    if (m.why !== null) return { ctl, why: m.why };
    ctl = m.ctl;
    if (o.park) await page.mouse.move(0, 0);
    const shot = async (s, want) => {
      const arg = { shot: s };
      const r = await page.evaluate(ownShot, arg);
      if (r.clip === null) return r.why ?? "nothing of the opener is on screen to compare";
      if (want && JSON.stringify(r.clip) !== JSON.stringify(want)) return "the opener moved between the screenshots";
      if (s === "A" && (o.park || m.scrolled)) await raf2(page);
      return { png: await page.screenshot({ clip: r.clip, animations: "disabled", caret: "hide", scale: "css", timeout: OWN_SHOT_MS }), clip: r.clip, keep: r.keep };
    };
    const a = await shot("A");
    if (typeof a === "string") return { ctl, why: a };
    const b = await shot("B", a.clip);
    if (typeof b === "string") return { ctl, why: b };
    if (!a.png.equals(b.png)) return { ctl, why: "the opener paints something of its own beside it (its screenshot with only that control hidden differs from the one with all its content hidden)" };
    if (m.keep === 0) return { ctl, why: null };
    const k = await shot("K", a.clip);
    if (typeof k === "string") return { ctl, why: k };
    const n = await shot("N", a.clip);
    if (typeof n === "string") return { ctl, why: n };
    const plain = plainKept(decodePng(k.png), decodePng(n.png), k.clip, k.keep);
    return { ctl, why: plain === null ? null : `a box kept as the opener's decoration is not a plain fill \u2014 ${plain} (alone it must paint one uniform colour)` };
  } catch (e) {
    return { ctl, why: `its own content could not be compared by pixels (${firstLine(e)})` };
  } finally {
    await page.evaluate(ownClear, null).catch(() => void 0);
  }
}
var RESTORE_CAP_MS = 3e3;
async function restoreSettled(page) {
  const t0 = Date.now();
  let held = 0;
  while (held < 2 && Date.now() - t0 < RESTORE_CAP_MS) {
    await page.evaluate(restoreScroll);
    await raf2(page);
    held = await page.evaluate(scrollHeld) ? held + 1 : 0;
  }
}
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
    await page.evaluate(tipPreMark, null).catch(() => false);
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
    await page.locator(openerPath).first().hover({ timeout: 2e3, force: true }).catch(() => void 0);
    await raf2(page);
    const submitsHovered = await page.locator(openerPath).first().evaluate(submitGuard);
    if (submitsHovered !== null) return { ...base, ok: null, ...revealedBy !== void 0 ? { revealedBy } : {}, detail: `opener would submit a form (${submitsHovered}) \u2014 not driven` };
    const notOwn = (ctl, why) => ({
      ...base,
      ok: null,
      ...revealedBy !== void 0 ? { revealedBy } : {},
      detail: `the opener's click point is another control inside it (${ctl}) \u2014 tag that control or the opener's own clickable element \u2014 not driven${why !== void 0 ? ` (${why})` : ""}`
    });
    const inner = await page.locator(openerPath).first().evaluate(clickPointControl, { mark: true });
    if (inner !== null) return notOwn(inner, await page.evaluate(ownWhy, null).catch(() => null) ?? void 0);
    const px = await ownPixels(page, { park: revealedBy === void 0 });
    if (px !== null && px.why !== null) return notOwn(px.ctl, px.why);
    const contract = [...DIALOG_CONTRACT];
    await page.evaluate(armDetector, { destId, contract });
    const tokenBefore = String(await page.evaluate("window.__dtProbeDoc || ''"));
    const loadsBefore = loads();
    let activation = "mouse", clickWhy = "";
    await page.locator(openerPath).first().evaluate(saveScroll);
    try {
      await page.locator(openerPath).first().click({ timeout: 2e3 });
    } catch (e) {
      const m = errMsg(e);
      if (CLOSED.test(m)) throw e;
      if (!NAVIGATED.test(m)) {
        clickWhy = (/intercepts pointer events|not visible|not enabled|not stable|outside of the viewport/.exec(m) || [firstLine(e)])[0] ?? "";
        activation = "synthetic";
        await restoreSettled(page);
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

// design-to-code/probe-behaviour.ts
import { setTimeout as sleep2 } from "node:timers/promises";
var CUT_SETTLE_MS2 = 5e3;
var CLOSE_STEP_CAP_MS = 5e3;
var PS_CAP_MS = 3e3;
var WRITE_MARGIN_MS = 2e3;
var BEHAVIOUR_CAP_MS = 9e4;
var BEHAVIOUR_RESERVE_MS = CUT_SETTLE_MS2 + 2 * CLOSE_STEP_CAP_MS + PS_CAP_MS + WRITE_MARGIN_MS;
function behaviourBudget(now, deadline, capMs = BEHAVIOUR_CAP_MS, reserveMs = BEHAVIOUR_RESERVE_MS) {
  return Math.max(0, Math.min(capMs, deadline - now - reserveMs));
}
var UNIT_FLOOR_MS = 15e3;
function unitCap(leftMs, unitsLeft, floorMs = UNIT_FLOOR_MS) {
  return Math.max(0, Math.min(leftMs, Math.max(floorMs, leftMs / Math.max(1, unitsLeft))));
}
var WRITE_BLOCK_SCOPE = "per unit, from its first key press, click, scroll, hover or resize on, no request but GET/HEAD/OPTIONS leaves the browser (the page, its frames, workers, shared workers and service workers alike), no WebSocket message leaves the page and a WebSocket the page opens then never reaches the server \u2014 a blocked write makes every check of that unit from its first action on not-run; not blocked: the page's load and --steps, a GET with a side effect, a WebSocket opened inside a worker, and the drive of the interactions (no write block there: it never clicks an opener that would submit, nor one whose click point is another activating control (also under a focusable glyph or editable label inside it), a label's control or a nested page (an iframe, object or embed) \u2014 open shadow roots included \u2014 unless it is the sole button-like control of a container showing nothing of its own (no text, image, icon, CSS mask, generated content, filled block, progress bar, meter or list marker; a label at opacity 0 in flow counts, an out-of-flow tooltip at opacity 0 does not) by its DOM nor by its pixels (the container with only that control hidden against it with all its content hidden \u2014 the content of its open shadow roots, its own marker and its other pseudo-elements (a first letter, a placeholder, a file button, a details' content, scroll buttons and markers) too \u2014 everything outside it, its ancestors included, hidden in both, the opener hovered first so a control shown on hover is at its click point \u2014 any painted difference counts, a stripe or a 1-px divider too; decoration: its own background colour, a border in one colour (a 1-px divider on one side too) and its shadow, and a fill over all of it or a wrapper within 8 px of the control only when, alone (ancestor and own filters, clip-paths and masks off), they paint one plain colour (pixel-verified against their real rounded outline, a 1.5-px anti-aliased edge allowed; a progress ring, a wrapper with its own shadow or a frame in another colour is not plain, so refused); content too: its own background image (a gradient, a url), a border in two colours or a stripe, a scroll button, and a label, image or generated label laid at least half over it from outside its element (a sibling, an ancestor's ::after) unless fixed or sticky (a toast, a banner: ignored) or proven to lie under its opaque background; an ancestor's own paint (a row's gradient behind a transparent cell) is not its own; a page rule keeping something showing against the probe's (an inline or cascade-layer !important) refuses; not seen: the inside of an iframe, a closed shadow root, foreign content inside an ancestor's shadow root, a shadow root attached after the check starts, a part of the container still outside the viewport once scrolled in, content revealed after a delay, a generated label of an element lying elsewhere; the probe's init CSS is lost when a page replaces document.adoptedStyleSheets after load under a strict style CSP; an sr-only label at right:-9999px in a right-to-left page counts, so that cell is refused; the hover runs on every opener, so a mouseenter side effect also fires on one it then refuses); the same exemption, content too \u2014 its own inset box-shadow offset 2 px or more or blurred (a stripe, a fill, a glow), sharp box-shadow ring layers in more than one colour (not its border, not a layer in its own background colour where that cannot show \u2014 an outer one, a ring-offset, or an inset one over an opaque border-box / padding-box background) and its own paint under a mask or a clip-path other than a rounded inset(0); never foreign \u2014 a tooltip revealed by the probe's hover (a [role=tooltip] element, or the control's aria-describedby target, not shown before the hover; one already on screen is its own label and refuses) and a label at effective opacity 0; under it only with no opacity below 1 or blend mode on it or above it; an element the page mounts in it during the screenshots refuses; refused by rule: a page of more than 500,000 elements, an opener whose content is re-created while it is compared (an empty spacer a framework re-creates, marks a morphdom-style patch strips, a placeholder mounted on mouseleave; it can differ between runs), an opener inside a shadow root, a role-less tooltip or other popover laid over it (with a show delay the result can differ between runs), a cell whose sole control has a tooltip pre-mounted but hidden by transform scale(0) or moved off-screen (it counts as shown before the hover), a label under an oklch() / lab() / color() background (never proven opaque); not seen (known misses, the drive can write): a sibling's relative ::before shifted over it from elsewhere, text overflowing a 0-height wrapper beside it, a display: contents [role=tooltip] or aria-describedby target laid over it, a label the page re-creates as a new element on the hover with tooltip semantics (role=tooltip, or the control's aria-describedby target), and a page that defines window.__dtTipPre itself first turns the record of what was shown before the hover off (an adversarial page); the focused element outside it stays shown in both shots; a refusal names its reason; it does not see a control in a closed shadow root or one that is only a click listener with no role (a bare svg onclick), and clicks those); not seen: a write the page defers past the unit's end (an undo window over about 1 s) \u2014 it never leaves (the unit's context is closed first), but the check that caused it is judged as if nothing was written and the scroll unit may press that key again";
var WRITE_SETTLE_MS = 500;
function taintedPhases(trace) {
  const first = trace.actions[0];
  const from = first ? first.seq : 0;
  return [...new Set(trace.phases.filter((p) => p.seq >= from).flatMap((p) => p.keys))];
}
function fingerprintDiff(measured, unit, uses = []) {
  const m = new Set(measured), u = new Set(unit);
  if (!m.size) return null;
  const missing = [...m].filter((x) => !u.has(x)), extra = [...u].filter((x) => !m.has(x));
  const seen = (/* @__PURE__ */ new Set([...m, ...u])).size;
  const list = (xs) => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? ` +${xs.length - 5} more` : ""}`;
  if (missing.length < m.size && missing.length + extra.length <= Math.max(5, 0.2 * seen)) {
    const gone2 = [...new Set(uses)].filter((x) => m.has(x) && !u.has(x));
    return gone2.length ? `${list(gone2)} \u2014 used by this check, shown on the measured page \u2014 not shown` : null;
  }
  return `${missing.length} of ${m.size} measured tag(s) not shown${missing.length ? `: ${list(missing)}` : ""}${extra.length ? `; ${extra.length} not on the measured page: ${list(extra)}` : ""}`;
}
var NAMES_COMPUTED_BY = "Playwright (Chromium) \u2014 computed, not screen-reader verified";
var LANDMARK_ROLES = /* @__PURE__ */ new Set(["banner", "main", "navigation", "complementary", "contentinfo", "region", "form", "search"]);
var unescapeQuoted = (s) => s.replace(/\\(.)/g, "$1");
function parseAriaLandmarkTree(yaml) {
  if (typeof yaml !== "string") return null;
  const lines = yaml.split("\n");
  if (!lines.some((l) => /^\s*- /.test(l))) return yaml.trim() === "" ? { landmarks: [], parent: [] } : null;
  const landmarks = [];
  const parent = [];
  const stack = [];
  for (const line of lines) {
    const item = /^(\s*)- /.exec(line);
    if (!item) continue;
    const depth = Math.floor((item[1] ?? "").length / 2);
    for (let top = stack.at(-1); top !== void 0 && (landmarks[top]?.depth ?? -1) >= depth; top = stack.at(-1)) stack.pop();
    const m = /^(\s*)- (banner|main|navigation|complementary|contentinfo|region|form|search)(?: "((?:[^"\\]|\\.)*)")?(?=$|[:\s[])/.exec(line);
    if (!m || !LANDMARK_ROLES.has(m[2] ?? "")) continue;
    const name = m[3] !== void 0 ? unescapeQuoted(m[3]) : null;
    landmarks.push({ role: m[2] ?? "", name: name === "" ? null : name, depth });
    parent.push(stack.at(-1) ?? null);
    stack.push(landmarks.length - 1);
  }
  return { landmarks, parent };
}
var lmName = (l) => `${l.role}${l.name !== null ? ` "${l.name}"` : ""}`;
function landmarkFindings(tree, unnamedRegions2 = []) {
  const id = "a11y.landmarks";
  if (tree === null) return [{ id, status: "not-run", detail: "the accessibility snapshot could not be parsed (Playwright's aria snapshot format is unversioned)" }];
  const lms = tree.landmarks;
  const rows = [];
  const mains = lms.filter((l) => l.role === "main");
  if (mains.length > 1) rows.push({ id, status: "fail", detail: `${mains.length} main landmarks \u2014 a page has one <main> (the others: section / div)`, evidence: { count: mains.length } });
  if (mains.length === 0) rows.push({ id, status: "warn", detail: "no main landmark \u2014 wrap the screen's primary content in <main>" });
  const regions = lms.filter((l) => l.role === "region");
  if (regions.length > 6) rows.push({ id, status: "warn", detail: `${regions.length} region landmarks \u2014 named <section>s become landmarks; keep the few a screen-reader user jumps to`, evidence: { count: regions.length } });
  lms.forEach((l, i) => {
    if (l.role !== "region" || l.name === null) return;
    let p = tree.parent[i] ?? null;
    while (p !== null && lms[p]?.role !== "region") p = tree.parent[p] ?? null;
    const pl = p !== null ? lms[p] : void 0;
    if (pl && pl.name !== null && l.name.toLowerCase().startsWith(pl.name.toLowerCase())) {
      rows.push({ id, status: "warn", target: lmName(l), detail: `region "${l.name}" sits inside region "${pl.name}" and repeats its name \u2014 one landmark is enough (drop the inner section's name or role)` });
    }
  });
  const seen = /* @__PURE__ */ new Map();
  for (const l of lms) {
    if (l.role === "main" || l.role === "navigation" && l.name === null) continue;
    const k = `${l.role}|${l.name ?? ""}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) {
    if (n < 2) continue;
    const [role, name] = k.split("|");
    rows.push({ id, status: "warn", target: `${role ?? ""}${name ? ` "${name}"` : ""}`, detail: `${n} ${role ?? ""} landmarks named ${name ? `"${name}"` : "nothing"} \u2014 give each a distinct name (aria-label)`, evidence: { count: n } });
  }
  const navs = lms.filter((l) => l.role === "navigation");
  if (navs.length > 1 && navs.some((l) => l.name === null)) rows.push({ id, status: "warn", detail: `${navs.length} navigation landmarks, ${navs.filter((l) => l.name === null).length} unnamed \u2014 name each (aria-label) so they can be told apart` });
  if (unnamedRegions2.length) rows.push({ id, status: "warn", target: unnamedRegions2[0] ?? "", detail: `${unnamedRegions2.length} element(s) with role="region" and no accessible name \u2014 a region needs a name (aria-label / aria-labelledby), or drop the role`, evidence: { count: unnamedRegions2.length, paths: unnamedRegions2.slice(0, 5) } });
  if (!rows.length) rows.push({ id, status: "pass", detail: `${lms.length} landmark(s): ${lms.map(lmName).join(", ") || "none"}` });
  return rows;
}
function parseAriaName(snapshot) {
  const line = (typeof snapshot === "string" ? snapshot.split("\n")[0] : "") ?? "";
  const m = /^- (\w+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
  if (!m || m[1] === "text") return { role: null, name: null };
  const name = m[2] !== void 0 ? unescapeQuoted(m[2]) : null;
  return { role: m[1] ?? null, name: name !== null && name.trim() !== "" ? name : null };
}
var NAME_REQUIRED = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "img",
  "dialog",
  "alertdialog",
  "iframe",
  "tree",
  "grid",
  "menu",
  "tablist",
  "radiogroup",
  "scrollbar",
  "meter",
  "progressbar"
]);
function nameStatus(snapshot, stop) {
  const n = parseAriaName(snapshot);
  if (stop.tag === "iframe" || stop.tag === "frame") return { status: stop.domName ? "pass" : "fail", role: "iframe", name: stop.domName };
  if (stop.tag === "summary" && (n.role === null || n.role === "summary")) return { status: stop.domName ? "pass" : "fail", role: "summary", name: stop.domName };
  if (n.role === null) return { status: "warn", role: null, name: null };
  if (n.name === null && NAME_REQUIRED.has(n.role)) return { status: "fail", role: n.role, name: null };
  return { status: "pass", role: n.role, name: n.name };
}
function parseColor(s) {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(t);
  if (hex) {
    const h = hex[1] ?? "";
    const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
    if (full.length !== 6 && full.length !== 8) return null;
    const at = (i) => parseInt(full.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
  }
  const alpha = (x) => x === void 0 || x === "none" ? 1 : x.endsWith("%") ? Number(x.slice(0, -1)) / 100 : Number(x);
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?|none))?\s*\)$/.exec(t);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: alpha(fn[4]) };
  const num = "(-?[\\d.]+(?:e-?\\d+)?%?|none)";
  const ok = new RegExp(`^(oklab|oklch)\\(\\s*${num}\\s+${num}\\s+${num}(?:\\s*/\\s*([\\d.]+%?|none))?\\s*\\)$`).exec(t);
  if (ok) {
    const v = (x, pct2) => x === void 0 || x === "none" ? 0 : x.endsWith("%") ? Number(x.slice(0, -1)) / 100 * pct2 : Number(x);
    const L = v(ok[2], 1);
    let a, b;
    if (ok[1] === "oklab") {
      a = v(ok[3], 0.4);
      b = v(ok[4], 0.4);
    } else {
      const C = v(ok[3], 0.4), h = v(ok[4], 1) * Math.PI / 180;
      a = C * Math.cos(h);
      b = C * Math.sin(h);
    }
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s3];
    const [r, g, bb] = lin.map((c) => Math.round(255 * Math.min(1, Math.max(0, c <= 31308e-7 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))));
    return { r: r ?? 0, g: g ?? 0, b: bb ?? 0, a: alpha(ok[5]) };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?|none))?\s*\)$/.exec(t);
  if (srgb) return { r: Math.round(Number(srgb[1]) * 255), g: Math.round(Number(srgb[2]) * 255), b: Math.round(Number(srgb[3]) * 255), a: alpha(srgb[4]) };
  return null;
}
function scrimMatches(expected, actual) {
  const e = expected === null ? null : parseColor(expected);
  const a = actual === null ? null : parseColor(actual);
  const none = (c) => c === null || c.a <= 0.05;
  if (expected !== null && e === null) return false;
  if (none(e)) return none(a);
  if (none(a) || e === null || a === null) return false;
  return Math.abs(e.r - a.r) <= 8 && Math.abs(e.g - a.g) <= 8 && Math.abs(e.b - a.b) <= 8 && Math.abs(e.a - a.a) <= 0.05;
}
function centredIn(rect, vp, tol = 1) {
  const h = Math.abs(rect.x + rect.w / 2 - vp.w / 2) <= tol;
  const v = rect.h >= vp.h - 2 ? null : Math.abs(rect.y + rect.h / 2 - vp.h / 2) <= tol;
  return { h, v, centred: h && v !== false };
}
function overlayCentred(ov) {
  return !!ov && (ov.from === "default" || String(ov.position).toLowerCase() === "center");
}
function safeCloseName(name, ariaLabel) {
  if (/^(cancel|close|dismiss|no|not now|×|x|✕)$/i.test(name.trim())) return true;
  const l = (ariaLabel ?? "").trim();
  return /^(close|dismiss)$/i.test(l) || /^(close|dismiss)\b.*\b(dialog|modal|panel|popup|pop-up|window|drawer|sheet|overlay|form)$/i.test(l);
}
function axeStatus(violations) {
  if (violations.some((v) => v.impact === "critical" || v.impact === "serious")) return "fail";
  return violations.length ? "warn" : "pass";
}
function focusReturnStatus(r) {
  if (!r.connected) {
    return !r.activeIsBody && r.activeVisible ? { status: "pass", detail: `the opener left the document on close; focus went to ${r.activeDesc} (a visible element) \u2014 note: not the opener` } : { status: "fail", detail: `the opener left the document on close and focus fell to ${r.activeIsBody ? "<body>" : `${r.activeDesc} (not visible)`} \u2014 move focus to a sensible visible element` };
  }
  if (r.onOpener && r.openerVisible && !r.opacity0) return { status: "pass", detail: "focus returned to the opener" };
  if (r.onOpener && r.openerVisible) return { status: "warn", detail: "focus returned to the opener, but it is invisible (opacity 0) while focused with the pointer away \u2014 reveal it on focus too (e.g. group-focus-within:opacity-100), never only on hover" };
  if (r.onOpener) return { status: "fail", detail: "focus returned to the opener, but it is hidden (visibility/display) with the pointer away \u2014 a keyboard user sees no focus; reveal hover-only actions with opacity + :focus-within, never visibility:hidden" };
  return { status: "fail", detail: `focus went to ${r.activeIsBody ? "<body>" : r.activeDesc}, not back to the opener${r.openerVisible ? "" : " (the opener is hidden with the pointer away \u2014 hover-only visibility:hidden)"}` };
}
var STATUS_ORDER = { fail: 0, warn: 1, "not-run": 2, unsupported: 3, pass: 4 };
var PER_ELEMENT_CAP = 20;
function perElement(id, nonPass, passCount, total, what, variant) {
  const sorted = [...nonPass].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const rows = sorted.slice(0, PER_ELEMENT_CAP);
  const rest = sorted.slice(PER_ELEMENT_CAP);
  for (const st of ["fail", "warn", "not-run", "unsupported"]) {
    const n = rest.filter((r) => r.status === st).length;
    if (n) rows.push({ id, status: st, ...variant !== void 0 ? { variant } : {}, detail: `+${n} more ${st} \u2014 the first ${PER_ELEMENT_CAP} are listed`, evidence: { count: n, more: true } });
  }
  if (passCount > 0) rows.push({ id, status: "pass", ...variant !== void 0 ? { variant } : {}, detail: `${passCount} of ${total} ${what}`, evidence: { count: passCount, of: total } });
  return rows;
}
function batteryRows(exp, driven) {
  const battery = [], skipped = [];
  for (const row of drivable(exp)) {
    const ev = (driven || []).find((e) => e.nodeId === row.nodeId && e.trigger === row.trigger);
    let why = null;
    if (!ev) why = "the overlay was not driven (no drive evidence)";
    else if (ev.cut === "budget") why = "the drive was cut by its time budget";
    else if (ev.activation === "synthetic") why = "the opener opened only on a synthetic click (headless) \u2014 never used for the battery";
    else if (!ev.opened) why = `the drive opened nothing (${(ev.detail ?? "").replace(/^not-run: /, "") || "no detail"})`;
    else if ((ev.navEvents ?? 0) !== 0) why = "the drive saw a document load";
    else if (ev.detectedBy === ":popover-open") why = `the drive opened a popover, not a modal dialog \u2014 ${NOT_MODAL}`;
    if (why === null) battery.push(row);
    else skipped.push({ row, why });
  }
  return { battery, skipped };
}
var NOT_MODAL = "the battery runs only on a modal dialog (:modal / dialog[open] / aria-modal=true)";
var DIALOG_IDS = ["dialog.focus-on-open", "dialog.focus-trap", "dialog.escape-closes", "dialog.focus-return", "dialog.nested-escape", "dialog.scroll-open", "dialog.scrim", "dialog.click-outside"];
function sentinelInsert(_arg) {
  const prev = window.__dtBeh;
  const st = prev ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  st.stops = [];
  st.stopVisible = [];
  if (st.sentinel && st.sentinel.isConnected) st.sentinel.remove();
  const body = document.body;
  if (!body) return false;
  const s = document.createElement("div");
  s.setAttribute("tabindex", "0");
  s.setAttribute("data-dt-sentinel", "");
  s.setAttribute("style", "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;outline:none;z-index:-1");
  body.prepend(s);
  st.sentinel = s;
  s.focus({ preventScroll: true });
  return document.activeElement === s;
}
function sentinelRemove(_arg) {
  const st = window.__dtBeh;
  if (st && st.sentinel) {
    st.sentinel.remove();
    st.sentinel = null;
  }
  return true;
}
function walkStep(arg) {
  const st = window.__dtBeh;
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!st) return { end: "body", opener: false, ancestor: null, inside: null, dup: false };
  if (a !== null && a === st.sentinel) return { end: "sentinel", opener: false, ancestor: null, inside: null, dup: false };
  if (a === null || a === document.body || a === document.documentElement) return st.stops.length ? { end: "body", opener: false, ancestor: null, inside: null, dup: false } : { end: null, opener: false, ancestor: null, inside: null, dup: true };
  const o = st.opener;
  const ctrl = st.control && st.control.isConnected ? st.control : null;
  const descOf = (e) => `<${e.tagName.toLowerCase()}${e.getAttribute("tabindex") !== null ? ` tabindex="${e.getAttribute("tabindex") ?? ""}"` : ""}${e.getAttribute("role") ? ` role="${e.getAttribute("role") ?? ""}"` : ""}${e.getAttribute("aria-label") ? ` aria-label="${e.getAttribute("aria-label") ?? ""}"` : ""}>`;
  const opener = !!ctrl && a === ctrl;
  const inside = !opener && !!o && o !== a && o.contains(a) ? descOf(a) : null;
  const ancestor = !opener && !!o && a.contains(o) ? descOf(a) : null;
  if (st.stops.includes(a)) return { end: null, opener, ancestor, inside, dup: true };
  if (arg.record) {
    const r = a.getBoundingClientRect();
    st.stops.push(a);
    st.stopVisible.push(r.width > 0 && r.height > 0 && a.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true }));
  }
  return { end: null, opener, ancestor, inside, dup: false };
}
function keyTarget(_arg) {
  const st = window.__dtBeh;
  const o = st ? st.opener : null;
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { ok: false, desc: "<body>", why: "focus is on <body>" };
  const desc = `<${a.tagName.toLowerCase()}${a.getAttribute("type") ? ` type="${a.getAttribute("type") ?? ""}"` : ""}${a.hasAttribute("readonly") ? " readonly" : ""}${a.getAttribute("tabindex") !== null ? ` tabindex="${a.getAttribute("tabindex") ?? ""}"` : ""}${a.getAttribute("role") ? ` role="${a.getAttribute("role") ?? ""}"` : ""}>`;
  if (!o) return { ok: false, desc, why: "the opener is gone" };
  const ctrl = st && st.control && st.control.isConnected ? st.control : null;
  if (a !== ctrl) return { ok: false, desc, why: o.contains(a) ? "the opener is a container; its focusable child is not pressed" : a.contains(o) ? "an ancestor of the opener" : "not the opener" };
  const tag = a.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea" || a.isContentEditable === true) return { ok: false, desc, why: "a form field \u2014 Enter in it can submit its form" };
  if (!a.matches("button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]")) return { ok: false, desc, why: "not a button-like control" };
  return { ok: true, desc, why: "" };
}
function stopsCount(_arg) {
  const st = window.__dtBeh;
  return st ? { n: st.stops.length, visible: st.stopVisible.slice() } : { n: 0, visible: [] };
}
function stopsInfo(_arg) {
  const st = window.__dtBeh;
  if (!st) return [];
  const pathOf = (el) => {
    const segs = [];
    let cur = el, joiner = "";
    while (cur && cur !== document.documentElement) {
      const parent = cur.parentElement;
      if (parent) {
        segs.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})${joiner}`);
        joiner = " > ";
        cur = parent;
        continue;
      }
      const root = cur.getRootNode ? cur.getRootNode() : null;
      const host = root && root.host ? root.host : null;
      if (!root || !host || !root.children) break;
      segs.unshift(`${cur.tagName.toLowerCase()}:nth-child(${Array.from(root.children).indexOf(cur) + 1})${joiner}`);
      joiner = " ";
      cur = host;
    }
    return `html > ${segs.join("")}`;
  };
  const domName = (el) => {
    const label = (el.getAttribute("aria-label") || "").trim();
    if (label) return label;
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x) => x !== null).map((x) => (x.textContent || "").trim()).join(" ").trim();
    if (by) return by;
    const title = (el.getAttribute("title") || "").trim();
    return title || null;
  };
  return st.stops.map((el) => ({
    path: pathOf(el),
    dt: el.getAttribute("data-dt-node"),
    tag: el.tagName.toLowerCase(),
    connected: el.isConnected,
    domName: el.tagName.toLowerCase() === "iframe" || el.tagName.toLowerCase() === "frame" ? domName(el) : el.tagName.toLowerCase() === "summary" ? (el.textContent || "").trim() || null : null
  }));
}
function subjectRead(arg) {
  const st = window.__dtBeh;
  const stops = st ? st.stops : [];
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const id = arg.id;
  let els = Array.from(document.querySelectorAll(`[data-dt-node="${id.replace(/["\\]/g, "\\$&")}"]`)).filter((e) => e.closest("dialog:not([open])") === null);
  if (els.length > 1) els = els.filter((e) => e.getClientRects().length > 0);
  const el = els.length === 1 ? els[0] : void 0;
  if (!el) return { id, count: els.length, closedIn: null, hasBox: false, disabled: false, stop: -1, inside: null, visibility: "", tabindex: null, tag: "" };
  let closedIn = null;
  for (let p = el.parentElement; p && p !== document.body && closedIn === null; p = p.parentElement) {
    const desc = `<${p.tagName.toLowerCase()}${p.id ? ` id="${p.id}"` : ""}>`;
    if (p.tagName.toLowerCase() === "details" && !p.hasAttribute("open") && el.closest("summary") === null) closedIn = `a closed <details>`;
    else if (p.hasAttribute("hidden")) closedIn = `${desc} [hidden]`;
    else if (getComputedStyle(p).getPropertyValue("display") === "none") closedIn = `${desc} (display:none)`;
    else if (p.id) {
      const ctl = Array.from(document.querySelectorAll("[aria-controls]")).find((c) => (c.getAttribute("aria-controls") || "").split(/\s+/).includes(p.id) && (c.getAttribute("aria-expanded") || "").toLowerCase() === "false");
      if (ctl) closedIn = `${desc}, which its [aria-expanded=false] control ${ctl.id ? `#${ctl.id}` : `<${ctl.tagName.toLowerCase()}>`} keeps closed`;
    }
  }
  const f = el.closest(FOCUSABLE);
  const ctrl = st && st.opener === el && st.control && st.control.isConnected ? st.control : null;
  const stop = stops.findIndex((s) => s === el || s === f || s === ctrl);
  const inner = stop < 0 ? stops.find((s) => s !== el && el.contains(s)) : void 0;
  return {
    id,
    count: 1,
    closedIn,
    hasBox: el.getClientRects().length > 0,
    disabled: el.closest(':disabled, [disabled], [aria-disabled="true" i]') !== null,
    stop,
    inside: inner ? `<${inner.tagName.toLowerCase()}${inner.getAttribute("aria-label") ? ` aria-label="${inner.getAttribute("aria-label") ?? ""}"` : ""}>` : null,
    visibility: getComputedStyle(el).getPropertyValue("visibility"),
    tabindex: el.getAttribute("tabindex"),
    tag: el.tagName.toLowerCase()
  };
}
function focusBefore(arg) {
  const st = window.__dtBeh;
  if (!st) return false;
  const prev = arg.i === 0 ? st.sentinel : st.stops[arg.i - 1];
  if (!prev || !prev.isConnected) return false;
  prev.focus({ preventScroll: false });
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a === prev;
}
function focusedStop(arg) {
  const st = window.__dtBeh;
  const el = st ? st.stops[arg.i] : void 0;
  let act = document.activeElement;
  while (act && act.shadowRoot && act.shadowRoot.activeElement) act = act.shadowRoot.activeElement;
  const ok = !!el && act === el;
  const prev = st ? arg.i === 0 ? st.sentinel : st.stops[arg.i - 1] : null;
  const onPrev = !!prev && act === prev;
  if (!el) return { ok: false, onPrev, visible: false, rect: { x: 0, y: 0, w: 0, h: 0 }, vw: innerWidth, vh: innerHeight, outlineStyle: "", outlineWidth: "", boxShadow: "", focusVisible: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  let fv = false;
  try {
    fv = el.matches(":focus-visible");
  } catch {
  }
  return {
    ok,
    onPrev,
    visible: r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true }),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    vw: innerWidth,
    vh: innerHeight,
    outlineStyle: cs.getPropertyValue("outline-style"),
    outlineWidth: cs.getPropertyValue("outline-width"),
    boxShadow: cs.getPropertyValue("box-shadow"),
    focusVisible: fv
  };
}
function blurActive(_arg) {
  const a = document.activeElement;
  if (a && a !== document.body) a.blur();
  return true;
}
function unnamedRegions(_arg) {
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
  const out = [];
  for (const el of Array.from(document.querySelectorAll("[role=region i]"))) {
    if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
    const label = (el.getAttribute("aria-label") || "").trim();
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x) => x !== null);
    const byText = by.map((x) => (x.textContent || "").trim()).join(" ").trim();
    const title = (el.getAttribute("title") || "").trim();
    if (!label && !byText && !title) out.push(pathOf(el));
  }
  return out;
}
function subpixelRead(_arg) {
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
  const out = [];
  const body = document.body;
  if (!body) return out;
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (el.getAttribute("data-dt-sentinel") !== null) continue;
    const tag = el.tagName.toLowerCase();
    const cell = tag === "td" || tag === "th";
    const ownText = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("").trim();
    if (!cell && ownText === "") continue;
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "title") continue;
    if (el.closest("dialog:not([open])") !== null) continue;
    if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height > 0) {
      const tagged = el.closest("[data-dt-node]");
      out.push({ path: pathOf(el), dt: tagged ? tagged.getAttribute("data-dt-node") : null, tag, width: Math.round(r.width * 100) / 100, text: (ownText || (el.textContent || "").trim()).slice(0, 40) });
    }
  }
  return out.slice(0, 50);
}
function offendersAre2D(arg) {
  if (!arg.paths.length) return false;
  return arg.paths.every((p) => {
    const el = document.querySelector(p);
    return !!el && el.closest("table, pre, figure, img, canvas, svg, video, [role=grid], [role=table]") !== null;
  });
}
function visibleTags(_arg) {
  const out = [];
  for (const el of Array.from(document.querySelectorAll("[data-dt-node]"))) {
    if (el.getClientRects().length === 0 || el.closest("dialog:not([open])") !== null || !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
    const v = el.getAttribute("data-dt-node");
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}
function docSize(_arg) {
  const de = document.documentElement;
  return { sw: de.scrollWidth, sh: de.scrollHeight, scrollY, vh: innerHeight, vw: innerWidth };
}
function maskCandidates(arg) {
  const st = window.__dtBeh ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  st.masks = [];
  st.maskInline = [];
  const body = document.body;
  if (!body) return [];
  const out = [];
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (out.length >= arg.cap) break;
    const cs = getComputedStyle(el);
    const m = cs.getPropertyValue("mask-image"), wm = cs.getPropertyValue("-webkit-mask-image");
    if ((m === "" || m === "none") && (wm === "" || wm === "none")) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true })) continue;
    st.masks.push(el);
    st.maskInline.push({ value: el.style.getPropertyValue("visibility"), priority: el.style.getPropertyPriority("visibility") });
    const tagged = el.closest("[data-dt-node]");
    out.push({ dt: tagged ? tagged.getAttribute("data-dt-node") : null, tag: el.tagName.toLowerCase() });
  }
  return out;
}
function maskShow(arg) {
  const st = window.__dtBeh;
  const el = st ? st.masks[arg.i] : void 0;
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
}
function maskHide(arg) {
  const st = window.__dtBeh;
  const el = st ? st.masks[arg.i] : void 0;
  const prev = st ? st.maskInline[arg.i] : void 0;
  if (!el || !prev) return false;
  if (arg.hide) el.style.setProperty("visibility", "hidden", "important");
  else if (prev.value) el.style.setProperty("visibility", prev.value, prev.priority);
  else el.style.removeProperty("visibility");
  return true;
}
function scrollToY(arg) {
  window.scrollTo({ top: arg.y, left: 0, behavior: "instant" });
  return scrollY;
}
function markOpener(arg) {
  const st = window.__dtBeh ?? { stops: [], stopVisible: [], sentinel: null, opener: null, dialog: null, dialogModal: false, expander: null, masks: [], maskInline: [] };
  window.__dtBeh = st;
  window.__dtOwn = null;
  const none = { found: false, visible: false, x: 0, y: 0, inViewport: false, hits: false, hover: null, sole: false, why: null };
  let els = Array.from(document.querySelectorAll(`[data-dt-node="${arg.id.replace(/["\\]/g, "\\$&")}"]`)).filter((e) => e.closest("dialog:not([open])") === null);
  if (els.length > 1) els = els.filter((e) => e.getClientRects().length > 0);
  const el = els.length === 1 ? els[0] : void 0;
  if (!el) {
    st.opener = null;
    st.control = null;
    return none;
  }
  st.opener = el;
  const sees = (e, opacity) => {
    if (e.getClientRects().length === 0) return false;
    const r2 = e.getBoundingClientRect();
    return r2.width > 0 && r2.height > 0 && e.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: opacity, checkOpacity: opacity });
  };
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const visible = sees(el, true);
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const inViewport = x >= 0 && y >= 0 && x < vw && y < vh;
  const hit = inViewport ? document.elementFromPoint(x, y) : null;
  const FOC = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  const BTN = "button, a[href], summary, [role=button i], [role=link i], [role=menuitem i], [role=tab i]";
  const ownContent = (box, ctl) => {
    const up = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
    const css = (e, prop, pseudo = null) => getComputedStyle(e, pseudo).getPropertyValue(prop).trim();
    const set = (e, prop, pseudo = null) => {
      const v = css(e, prop, pseudo);
      return v !== "" && v !== "none";
    };
    const chain = (test) => {
      const memo = /* @__PURE__ */ new Map();
      return (e) => {
        const seen = [];
        let hit2 = false;
        for (let p = e; p && p !== box; p = up(p)) {
          const m = memo.get(p);
          if (m !== void 0) {
            hit2 = m;
            break;
          }
          seen.push(p);
          if (test(p)) {
            hit2 = true;
            break;
          }
        }
        for (const s of seen) memo.set(s, hit2);
        return hit2;
      };
    };
    let work = 0;
    const OWN_WORK_CAP = 2e4;
    const tick = () => ++work > OWN_WORK_CAP;
    const inCtl = chain((p) => p === ctl);
    const outOfFlow = (e, pseudo = null) => /^(absolute|fixed)$/.test(css(e, "position", pseudo));
    const faded = chain((p) => css(p, "opacity") === "0" && outOfFlow(p));
    const boxed = (e) => {
      let p = e;
      while (p && css(p, "display") === "contents") p = up(p);
      return p;
    };
    const shown = (e) => {
      const b = boxed(e);
      return !!b && b.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !/^(hidden|collapse)$/.test(css(e, "visibility")) && !faded(b);
    };
    const holdsFixed = (p) => ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => set(p, k)) || css(p, "transform-style") === "preserve-3d" || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(css(p, "will-change")) || /\b(layout|paint|strict|content)\b/.test(css(p, "contain")) || /^(auto|hidden)$/.test(css(p, "content-visibility"));
    const de2 = document.documentElement;
    const horizontal = !/^(vertical|sideways)/.test(css(de2, "writing-mode"));
    let sx = scrollX, sy = scrollY;
    for (let p = box; p && p !== de2; p = up(p)) {
      sx += Math.abs(p.scrollLeft || 0);
      sy += Math.abs(p.scrollTop || 0);
    }
    const startX = horizontal && css(de2, "direction") !== "rtl" ? -sx : -Infinity, startY = horizontal ? -sy : -Infinity;
    const clipped = (e, q) => {
      let x0 = Math.max(q.x, startX), y0 = Math.max(q.y, startY), x1 = q.right, y1 = q.bottom;
      let flow = "in";
      for (let p = e; p; p = p === box ? null : up(p)) {
        if (tick()) return null;
        if (css(p, "display") === "contents") continue;
        const pr = p.getBoundingClientRect();
        const pos = css(p, "position");
        const skip = p !== e && (flow === "fixed" ? !holdsFixed(p) : flow === "absolute" && !/^(relative|absolute|fixed|sticky)$/.test(pos) && !holdsFixed(p));
        if (!skip) {
          const ox = css(p, "overflow-x"), oy = css(p, "overflow-y");
          const cm = ox === "clip" && oy === "clip" ? parseFloat(/(-?[\d.]+)px/.exec(css(p, "overflow-clip-margin"))?.[1] ?? "0") || 0 : 0;
          if (ox !== "visible") {
            x0 = Math.max(x0, pr.x - cm);
            x1 = Math.min(x1, pr.right + cm);
          }
          if (oy !== "visible") {
            y0 = Math.max(y0, pr.y - cm);
            y1 = Math.min(y1, pr.bottom + cm);
          }
          flow = pos === "fixed" ? "fixed" : pos === "absolute" ? "absolute" : "in";
        }
        const ins = /^inset\((.*)\)$/.exec(css(p, "clip-path"));
        if (ins) {
          const [t = "0", r2 = t, b = t, l = r2] = (ins[1] ?? "").split(/\s+round\s+/)[0]?.trim().split(/\s+/) ?? [];
          const len = (s, size) => s.endsWith("%") ? parseFloat(s) / 100 * size : parseFloat(s);
          const T = len(t, pr.height), R = len(r2, pr.width), B = len(b, pr.height), L = len(l, pr.width);
          if (![T, R, B, L].some(Number.isNaN)) {
            x0 = Math.max(x0, pr.x + L);
            x1 = Math.min(x1, pr.right - R);
            y0 = Math.max(y0, pr.y + T);
            y1 = Math.min(y1, pr.bottom - B);
          }
        }
        const rc = /^rect\((.*)\)$/.exec(css(p, "clip"));
        if (rc && /^(absolute|fixed)$/.test(pos)) {
          const v = (rc[1] ?? "").split(/[\s,]+/).filter(Boolean);
          const at = (s, auto) => s === void 0 || s === "auto" ? auto : parseFloat(s);
          const T = at(v[0], 0), R = at(v[1], pr.width), B = at(v[2], pr.height), L = at(v[3], 0);
          if (v.length === 4 && ![T, R, B, L].some(Number.isNaN)) {
            x0 = Math.max(x0, pr.x + L);
            x1 = Math.min(x1, pr.x + R);
            y0 = Math.max(y0, pr.y + T);
            y1 = Math.min(y1, pr.y + B);
          }
        }
      }
      return { x0, y0, x1, y1 };
    };
    const area = (e, q) => {
      const c = clipped(e, q);
      return c ? Math.max(0, c.x1 - c.x0) * Math.max(0, c.y1 - c.y0) : Infinity;
    };
    const els2 = [];
    const texts = [];
    const todo = [box];
    for (let e = todo.pop(); e; e = todo.pop()) {
      if (tick()) return `more than ${OWN_WORK_CAP} boxes to check`;
      els2.push(e);
      for (const t of Array.from(e.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
      const sr = e.shadowRoot;
      let kids = Array.from(e.children);
      if (sr) {
        for (const t of Array.from(sr.childNodes)) if (t.nodeType === 3) texts.push({ t, e });
        kids = Array.from(sr.children).concat(kids);
      }
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k) todo.push(k);
      }
    }
    const cr = ctl.getBoundingClientRect(), mx = cr.x + cr.width / 2, my = cr.y + cr.height / 2;
    const chrome = (e) => {
      if (e.contains(ctl)) return true;
      const r2 = e.getBoundingClientRect();
      return mx >= r2.x && mx <= r2.right && my >= r2.y && my <= r2.bottom;
    };
    const clear = (v) => v === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(v);
    for (const e of els2) {
      if (inCtl(e) || !shown(e)) continue;
      if (/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(e.tagName.toUpperCase()) && area(e, e.getBoundingClientRect()) > 1) return `<${e.tagName.toLowerCase()}>`;
      const host = boxed(e) ?? e;
      for (const ps of ["::before", "::after"]) {
        const c = css(e, "content", ps);
        if (!c || c === "none" || c === "normal" || css(e, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(e, "visibility", ps)) || css(e, "opacity", ps) === "0" && outOfFlow(e, ps)) continue;
        const str = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        const s = str ? str[1] ?? "" : null;
        const fill2 = !clear(css(e, "background-color", ps));
        const paints2 = s === null || /\S/.test(s) || set(e, "background-image", ps) || set(e, "mask-image", ps) || fill2 && (s !== "" || !chrome(host));
        if (paints2 && area(host, host.getBoundingClientRect()) > 1) return `${ps} content`;
      }
      if (/list-item/.test(css(e, "display")) && (!/^(none)?$/.test(css(e, "list-style-type")) || set(e, "list-style-image") || !/^(normal|none)?$/.test(css(e, "content", "::marker"))) && area(e, e.getBoundingClientRect()) > 1) return "a list marker";
      if ((!/^(visible|clip)$/.test(css(e, "overflow-x")) || !/^(visible|clip)$/.test(css(e, "overflow-y"))) && !/^(none|normal)?$/.test(css(e, "content", "::scroll-button(*)")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll button";
      if (!/^(none)?$/.test(css(e, "scroll-marker-group")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll-marker group";
      if (e === box) {
        if (/\b(url|image|image-set|cross-fade|element|paint|[a-z-]*gradient)\(/i.test(css(e, "background-image"))) return "its own background image";
        if (set(e, "border-image-source")) return "its own border image";
        const sides = ["top", "right", "bottom", "left"].map((k) => ({ w: /^(none|hidden)$/.test(css(e, `border-${k}-style`)) ? 0 : parseFloat(css(e, `border-${k}-width`)) || 0, c: css(e, `border-${k}-color`) }));
        const painted = sides.filter((d) => d.w > 0 && !clear(d.c));
        if (new Set(painted.map((d) => d.c)).size > 1) return "its own border in more than one colour";
        const ws = sides.map((d) => d.w > 0 && !clear(d.c) ? d.w : 0);
        if (painted.length > 0 && Math.max(...ws) - Math.min(...ws) >= 2) return "its own border stripe";
        const layers = [];
        let depth = 0, cur = "";
        for (const ch of `${css(e, "box-shadow")},`) {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (ch !== "," || depth > 0) {
            cur += ch;
            continue;
          }
          const n = Array.from(cur.matchAll(/(-?[\d.]+)px/g), (m) => parseFloat(m[1] ?? "0") || 0);
          const c = cur.replace(/-?[\d.]+px/g, "").replace(/\binset\b/, "").trim();
          if (n.length >= 2 && c !== "" && c !== "none" && !clear(c)) layers.push({ c, n, inset: /\binset\b/.test(cur) });
          cur = "";
        }
        if (layers.some((l) => l.inset && (Math.max(Math.abs(l.n[0] ?? 0), Math.abs(l.n[1] ?? 0)) >= 2 || (l.n[2] ?? 0) > 0))) return "its own inset box-shadow (a stripe, a fill or a glow)";
        const ownBg = css(e, "background-color");
        const rings = layers.filter((l) => !((l.n[2] ?? 0) > 0) && (l.n[0] !== 0 || l.n[1] !== 0 || (l.n[3] ?? 0) !== 0) && !(l.c === ownBg && (!l.inset || /^rgb\(/.test(ownBg) && /^(border|padding)-box$/.test(css(e, "background-clip")))));
        if (new Set(rings.map((l) => l.c)).size > 1) return "its own box-shadow ring in more than one colour";
        const paints2 = !clear(css(e, "background-color")) || painted.length > 0 || layers.length > 0;
        if (paints2 && set(e, "mask-image")) return "its own paint under a mask";
        const cp = css(e, "clip-path");
        if (paints2 && cp !== "" && cp !== "none" && !/^inset\(0(px)?( 0(px)?){0,3}( round .*)?\)$/.test(cp)) return "its own paint under a clip-path";
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
    const br = box.getBoundingClientRect();
    const anc = /* @__PURE__ */ new Set();
    for (let p = up(box); p; p = up(p)) anc.add(p);
    const bg = css(box, "background-color");
    let opaque = /^rgb\(/.test(bg) || /^rgba\(.*,\s*1\)$/.test(bg);
    for (let p = box; p && opaque; p = up(p)) {
      const op = css(p, "opacity"), bm = css(p, "mix-blend-mode");
      if (op !== "" && parseFloat(op) < 1 || bm !== "" && bm !== "normal") opaque = false;
    }
    const meets = (q) => q.right > br.x && q.x < br.right && q.bottom > br.y && q.y < br.bottom;
    const over = (f, c, events) => {
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
    const tipIds = new Set((ctl.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    const tipPre = window.__dtTipPre;
    const tip = (f) => !!tipPre && !tipPre.has(f) && !anc.has(f) && ((f.getAttribute("role") ?? "").trim().split(/\s+/)[0]?.toLowerCase() === "tooltip" || tipIds.has(f.getAttribute("id") ?? ""));
    const gone2 = chain((p) => css(p, "opacity") === "0");
    const FOREIGN_CAP = 5e5;
    let walked = 0;
    const moved = (f) => {
      const s = getComputedStyle(f);
      return s.getPropertyValue("position") !== "static" || ["transform", "translate", "rotate", "scale"].some((k) => {
        const v = s.getPropertyValue(k);
        return v !== "" && v !== "none";
      });
    };
    const ftodo = [{ f: de2, near: true }];
    for (let t = ftodo.pop(); t; t = ftodo.pop()) {
      if (++walked > FOREIGN_CAP) return `more than ${FOREIGN_CAP} boxes on the page to check for a label laid over it`;
      const f = t.f;
      if (f === box || tip(f)) continue;
      const isAnc = anc.has(f);
      const fr = t.near || isAnc || moved(f) ? f.getBoundingClientRect() : null;
      const near = isAnc || fr !== null && meets(fr);
      const sr = f.shadowRoot;
      for (const k of Array.from(f.children ?? [])) ftodo.push({ f: k, near });
      if (sr) for (const k of Array.from(sr.children)) ftodo.push({ f: k, near });
      if (!fr || !near || pinned(f) || !shown(f) || gone2(f)) continue;
      const events = css(f, "pointer-events");
      for (const t2 of [...Array.from(f.childNodes), ...sr ? Array.from(sr.childNodes) : []]) {
        const text = t2.nodeType === 3 ? (t2.nodeValue || "").trim() : "";
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(t2);
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
        let q = fr;
        if (pos === "absolute") {
          let cb = f;
          while (cb && css(cb, "position") === "static" && !holdsFixed(cb)) cb = up(cb);
          const cr0 = cb ? cb.getBoundingClientRect() : null;
          const n = (k) => parseFloat(css(f, k, ps)) || 0;
          const x2 = (cr0 && cb ? cr0.x + (parseFloat(css(cb, "border-left-width")) || 0) : -scrollX) + n("left") + n("margin-left");
          const y2 = (cr0 && cb ? cr0.y + (parseFloat(css(cb, "border-top-width")) || 0) : -scrollY) + n("top") + n("margin-top");
          const extra = css(f, "box-sizing", ps) === "border-box" ? [0, 0] : [n("padding-left") + n("padding-right") + n("border-left-width") + n("border-right-width"), n("padding-top") + n("padding-bottom") + n("border-top-width") + n("border-bottom-width")];
          const w = n("width") + (extra[0] ?? 0), h = n("height") + (extra[1] ?? 0);
          q = { x: x2, y: y2, width: w, height: h, right: x2 + w, bottom: y2 + h };
        } else if (isAnc) continue;
        if (over(f, clipped(f, q), css(f, "pointer-events", ps))) return `a generated ${ps} label laid over it from outside it`;
      }
    }
    return null;
  };
  let control = null, sole = false, why = null;
  if (el.matches(FOC)) control = el;
  else {
    const anc = el.parentElement ? el.parentElement.closest(BTN) : null;
    if (anc && anc.matches(FOC) && Array.from(anc.querySelectorAll(FOC)).length === 0) control = anc;
    else {
      const inner = Array.from(el.querySelectorAll(FOC));
      const one = inner.length === 1 ? inner[0] : void 0;
      if (one && one.matches(BTN) && !one.matches("input, select, textarea, [contenteditable]")) {
        const b = one.getBoundingClientRect();
        const own = (inViewport ? !!hit && (hit === one || one.contains(hit)) : x >= b.x && x <= b.right && y >= b.y && y <= b.bottom) ? ownContent(el, one) : void 0;
        if (own === null) {
          const seen = (st.ownSeen ?? []).find((p) => p.box === el && p.ctl === one);
          if (seen) {
            control = seen.own ? null : one;
            why = seen.why ?? null;
          } else {
            control = one;
            sole = true;
            window.__dtOwn = { box: el, ctl: one };
          }
        } else if (own !== void 0) why = `its own content: ${own}`;
      }
    }
  }
  st.control = control;
  let hover = null;
  if (!visible) {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!sees(p, false)) continue;
      const pr = p.getBoundingClientRect();
      const hx = pr.x + Math.min(8, pr.width / 2), hy = pr.y + pr.height / 2;
      hover = { x: hx, y: hy, inViewport: hx >= 0 && hy >= 0 && hx < vw && hy < vh };
      break;
    }
  }
  return { found: true, visible, x, y, inViewport, hits: !!hit && (hit === el || el.contains(hit)), hover, sole, why };
}
function ownDecide(arg) {
  const st = window.__dtBeh;
  if (!st || !st.opener || !st.control) return false;
  const seen = st.ownSeen ?? [];
  seen.push({ box: st.opener, ctl: st.control, own: arg.own, why: arg.why ?? null });
  st.ownSeen = seen;
  if (arg.own) st.control = null;
  return true;
}
function focusOpener(arg) {
  const st = window.__dtBeh;
  const f = st && st.opener && st.control && st.control.isConnected ? st.control : null;
  if (!f) return false;
  f.focus({ preventScroll: arg.preventScroll });
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  return a === f;
}
function markDialog(arg) {
  const st = window.__dtBeh;
  const el = document.querySelector(arg.path);
  if (!st || !el) return { found: false, modal: false, dialogOpen: false, ariaModal: false, native: false };
  const before = window.__dtDrive ? [...window.__dtDrive.before, ...window.__dtDrive.roots ?? []] : [];
  const own = el.matches("dialog, [role=dialog i], [role=alertdialog i]");
  const anc = own ? null : el.closest('dialog[open], [aria-modal="true" i]');
  const root = anc && !before.includes(anc) ? anc : el;
  let modal = false;
  try {
    modal = root.matches(":modal");
  } catch {
  }
  const ariaModal = (root.getAttribute("aria-modal") || "").toLowerCase() === "true";
  const sized = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  };
  let box = root;
  if (!sized(root)) {
    box = el !== root && sized(el) ? el : Array.from(root.querySelectorAll("[role=dialog i], [role=alertdialog i], [data-dt-node], [class*=panel i]")).find(sized) ?? null;
  }
  st.dialog = root;
  st.box = box;
  st.dialogModal = modal || ariaModal;
  return { found: true, modal, dialogOpen: root.matches("dialog[open]"), ariaModal, native: root.tagName.toLowerCase() === "dialog" };
}
function dialogOpenNow(_arg) {
  const st = window.__dtBeh;
  const root = st ? st.dialog : null;
  if (!root || !root.isConnected) return false;
  const el = st && st.box ? st.box : root;
  if (!el.isConnected || el.getClientRects().length === 0) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true })) return false;
  if (root.tagName.toLowerCase() === "dialog") {
    let modal = false;
    try {
      modal = root.matches(":modal");
    } catch {
    }
    return root.matches("dialog[open]") && (modal || !st?.dialogModal);
  }
  return true;
}
function focusVsDialog(arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  const a = document.activeElement;
  const desc = (el) => {
    if (!el) return "nothing";
    const dt = el.getAttribute("data-dt-node");
    const label = el.getAttribute("aria-label");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `<${el.tagName.toLowerCase()}${dt !== null ? ` data-dt-node="${dt}"` : ""}${el.id ? ` id="${el.id}"` : ""}>${label ? ` "${label}"` : text ? ` "${text}"` : ""}`;
  };
  const body = a === null || a === document.body || a === document.documentElement;
  let inside = !body && !!d && !!a && (d === a || d.contains(a));
  if (!inside && !body && a && arg.destId !== null) {
    const tagged = a.closest(`[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`);
    if (tagged) inside = true;
  }
  return { inside, body, desc: desc(body ? null : a), name: a && !body ? a.getAttribute("aria-label") || (a.textContent || "").trim().slice(0, 40) : "" };
}
function dialogTabbables(_arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!d) return 0;
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]";
  let n = 0;
  for (const el of Array.from(d.querySelectorAll(FOCUSABLE))) {
    if (n > 30) break;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) < 0) continue;
    if (el.matches(":disabled")) continue;
    if (el.getClientRects().length === 0 || !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) continue;
    n++;
  }
  return n;
}
function expanderFind(_arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!st || !d) return { path: null, nativePicker: false, desc: "" };
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
  const ok = (el) => el.getClientRects().length > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true }) && !el.matches(":disabled");
  const x = Array.from(d.querySelectorAll('[aria-expanded="false" i]')).find(ok);
  st.expander = x ?? null;
  if (x) return { path: pathOf(x), nativePicker: false, desc: `<${x.tagName.toLowerCase()}${x.getAttribute("role") ? ` role="${x.getAttribute("role") ?? ""}"` : ""}> "${(x.getAttribute("aria-label") || (x.textContent || "").trim()).slice(0, 30)}"` };
  const native = Array.from(d.querySelectorAll("select, input[type=date i], input[type=time i], input[type=datetime-local i], input[type=month i], input[type=week i], input[type=color i]")).some(ok);
  return { path: null, nativePicker: native, desc: "" };
}
function expanderState(_arg) {
  const st = window.__dtBeh;
  const x = st ? st.expander : null;
  return x && x.isConnected ? x.getAttribute("aria-expanded") : null;
}
function closeCandidates(_arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  if (!d) return [];
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
  const out = [];
  for (const el of Array.from(d.querySelectorAll("button, [role=button i], a[href]"))) {
    if (out.length >= 50) break;
    if (el.tagName.toLowerCase() === "a") {
      const href = (el.getAttribute("href") || "").trim();
      if (!(href === "" || href === "#" || /^javascript:/i.test(href))) continue;
    }
    if (el.getClientRects().length === 0 || !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: true, checkOpacity: true }) || el.matches(":disabled")) continue;
    const label = el.getAttribute("aria-label");
    const by = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter((x) => x !== "").map((x) => document.getElementById(x)).filter((x) => x !== null).map((x) => (x.textContent || "").trim()).join(" ").trim();
    const value = el.tagName.toLowerCase() === "input" ? el.getAttribute("value") || "" : "";
    const name = label && label.trim() || by || (el.textContent || "").trim().replace(/\s+/g, " ") || value || el.getAttribute("title") || "";
    out.push({ path: pathOf(el), name, ariaLabel: label, button: el.tagName.toLowerCase() === "button" });
  }
  return out;
}
function focusReturnRead(_arg) {
  const st = window.__dtBeh;
  const o = st ? st.opener : null;
  const a = document.activeElement;
  const activeIsBody = a === null || a === document.body || a === document.documentElement;
  const desc = (el) => {
    if (!el) return "nothing";
    const dt = el.getAttribute("data-dt-node");
    const label = el.getAttribute("aria-label");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `<${el.tagName.toLowerCase()}${dt !== null ? ` data-dt-node="${dt}"` : ""}${el.id ? ` id="${el.id}"` : ""}>${label ? ` "${label}"` : text ? ` "${text}"` : ""}`;
  };
  const vis = (el) => {
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  };
  let opacity0 = false;
  for (let p = o; p; p = p.parentElement) if (Number(getComputedStyle(p).getPropertyValue("opacity")) === 0) {
    opacity0 = true;
    break;
  }
  const FOCUSABLE = "a[href], area[href], button, input, select, textarea, summary, [tabindex], [contenteditable]";
  const onOpener = !!o && !!a && !activeIsBody && (a === o || o.contains(a) || a === o.closest(FOCUSABLE));
  return {
    connected: !!o && o.isConnected,
    openerVisible: !!o && o.isConnected && vis(o),
    opacity0,
    onOpener,
    activeIsBody,
    activeVisible: !!a && !activeIsBody && vis(a) && a.checkVisibility({ opacityProperty: true, checkOpacity: true }),
    activeDesc: desc(activeIsBody ? null : a)
  };
}
function dialogGeometry(arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  let el = st && st.box ? st.box : d;
  let via = el !== d ? "the dialog's panel (its modal root has no box)" : "the opened element";
  if (d && arg.destId !== null) {
    const sel = `[data-dt-node="${arg.destId.replace(/["\\]/g, "\\$&")}"]`;
    const inner = d.matches(sel) ? d : Array.from(d.querySelectorAll(sel)).find((e) => e.getClientRects().length > 0) ?? null;
    if (inner) {
      el = inner;
      via = `the destination-tagged element (data-dt-node="${arg.destId}")`;
    }
  }
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  let eff = scrollY;
  for (const e of [document.body, document.documentElement]) {
    if (!e || getComputedStyle(e).getPropertyValue("position") !== "fixed") continue;
    const t = parseFloat(e.style.getPropertyValue("top") || getComputedStyle(e).getPropertyValue("top"));
    if (Number.isFinite(t)) {
      eff = -t;
      break;
    }
  }
  if (!el) return { rect: { x: 0, y: 0, w: 0, h: 0 }, vw, vh, position: "", scrollY: eff, via };
  const r = el.getBoundingClientRect();
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, vw, vh, position: getComputedStyle(st && st.box ? st.box : el).getPropertyValue("position"), scrollY: eff, via };
}
function effScroll(_arg) {
  for (const e of [document.body, document.documentElement]) {
    if (!e || getComputedStyle(e).getPropertyValue("position") !== "fixed") continue;
    const t = parseFloat(e.style.getPropertyValue("top") || getComputedStyle(e).getPropertyValue("top"));
    if (Number.isFinite(t)) return -t;
  }
  return scrollY;
}
async function settleDialog(_arg) {
  const st = window.__dtBeh;
  const root = st ? st.dialog : null;
  const box = st && st.box ? st.box : root;
  if (!root || !box) return { animations: 0, stable: false };
  const frame = () => new Promise((r) => {
    requestAnimationFrame(() => r());
  });
  const cap = (ms) => new Promise((r) => {
    setTimeout(r, ms);
  });
  const running = (root.getAnimations ? root.getAnimations({ subtree: true }) : []).filter((a) => a.playState === "running");
  if (running.length) await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => void 0))), cap(1e3)]);
  const sig = () => {
    const r = box.getBoundingClientRect();
    return `${r.x},${r.y},${r.width},${r.height}`;
  };
  const t = Date.now();
  let last = sig(), same = 0;
  while (Date.now() - t < 1e3) {
    await frame();
    const now = sig();
    same = now === last ? same + 1 : 0;
    last = now;
    if (same >= 2) return { animations: running.length, stable: true };
  }
  return { animations: running.length, stable: false };
}
function scrimRead(_arg) {
  const st = window.__dtBeh;
  const d = st ? st.dialog : null;
  const box = st && st.box ? st.box : d;
  let backdrop = null;
  const native = !!d && d.tagName.toLowerCase() === "dialog";
  if (d && native) {
    let modal = false;
    try {
      modal = d.matches(":modal");
    } catch {
    }
    if (modal) backdrop = getComputedStyle(d, "::backdrop").getPropertyValue("background-color");
  }
  const de = document.documentElement;
  const vw = Math.min(de.clientWidth || innerWidth, innerWidth), vh = Math.min(de.clientHeight || innerHeight, innerHeight);
  const br = box ? box.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const dist = (x, y) => Math.hypot(Math.max(br.x - x, 0, x - br.right), Math.max(br.y - y, 0, y - br.bottom));
  const CONTROL = 'a[href], button, input, select, textarea, summary, label, [role=button i], [role=link i], [role=menuitem i], [role=option i], [role=checkbox i], [role=tab i], [onclick], [tabindex]:not([tabindex^="-"])';
  const covers = (e) => {
    const r = e.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, vw) - Math.max(r.x, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.y, 0)) >= 0.9 * vw * vh;
  };
  const layered = (e) => {
    const pos = getComputedStyle(e).getPropertyValue("position");
    if (pos === "fixed") return true;
    if (pos !== "absolute") return false;
    for (let p = e.parentElement; p && p !== de; p = p.parentElement) if (getComputedStyle(p).getPropertyValue("position") === "fixed") return true;
    return false;
  };
  const alpha = (c) => {
    const t = c.trim().toLowerCase();
    if (t === "transparent") return 0;
    const m = /^(rgba?|oklab|oklch|lab|lch|color)\(([^)]*)\)$/.exec(t);
    if (!m) return null;
    const body = m[2] ?? "";
    const slash = body.lastIndexOf("/");
    const a = slash >= 0 ? body.slice(slash + 1).trim() : m[1] === "rgba" || m[1] === "rgb" ? (body.split(",")[3] ?? "").trim() : "";
    if (a === "") return 1;
    if (a === "none") return 0;
    const n = a.endsWith("%") ? Number(a.slice(0, -1)) / 100 : Number(a);
    return Number.isFinite(n) ? n : null;
  };
  const pts = [];
  for (const x of [4, Math.round(vw / 2), vw - 5]) for (const y of [4, Math.round(vh / 2), vh - 5]) if (!(x === Math.round(vw / 2) && y === Math.round(vh / 2))) pts.push({ x, y });
  pts.sort((a, b) => dist(b.x, b.y) - dist(a.x, a.y));
  let cover = null, point = null, hitDesc = "nothing", unreadable = null;
  for (const pt of pts) {
    if (dist(pt.x, pt.y) <= 0) continue;
    const stack = document.elementsFromPoint(pt.x, pt.y);
    const top = stack[0];
    if (top && hitDesc === "nothing") hitDesc = `<${top.tagName.toLowerCase()}${top.id ? ` id="${top.id}"` : ""}>`;
    let safe = true, found = false;
    for (const e of stack) {
      if (native && e === d) {
        found = true;
        break;
      }
      if (box && (e === box || box.contains(e))) {
        safe = false;
        break;
      }
      if (e.matches(CONTROL) || e.closest(CONTROL) !== null) {
        safe = false;
        break;
      }
      if (!covers(e) || !layered(e)) {
        safe = false;
        break;
      }
      const bg = getComputedStyle(e).getPropertyValue("background-color");
      const a = alpha(bg);
      if (a === null) {
        unreadable = unreadable ?? bg;
        safe = false;
        break;
      }
      if (a > 0.05) {
        found = true;
        if (cover === null) cover = bg;
        break;
      }
    }
    if (found && safe) {
      point = pt;
      break;
    }
  }
  return { backdrop, cover, point, hitDesc, unreadable };
}
var WALK_CAP = 150;
var NAVIGATED2 = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
var firstLine2 = (e) => errMsg(e).split("\n")[0] ?? "";
var UnitNavigated = class extends Error {
};
var AxeTimeout = class extends Error {
};
var AXE_CAP_MS = 2e4;
var AXE_TIMED_OUT = /* @__PURE__ */ Symbol("axe timed out");
var BatteryStop = class extends Error {
};
var raf22 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
var park = async (page) => {
  await page.mouse.move(0, 0);
  await raf22(page);
};
async function markOpenerSeen(page, id, act) {
  await page.evaluate(tipPreMark, null).catch(() => false);
  const r = await page.evaluate(markOpener, { id });
  if (!r.sole) return r;
  act();
  const px = await ownPixels(page, { park: false });
  const own = px === null || px.why !== null;
  const why = own ? px === null ? "its pixels could not be compared" : px.why : null;
  await page.evaluate(ownDecide, { own, why });
  return { ...r, why };
}
async function safeCloseOn(page, closedAfter, act) {
  const cands = await page.evaluate(closeCandidates, null);
  for (const c of cands) {
    if (!safeCloseName(c.name, c.ariaLabel)) continue;
    const loc = page.locator(c.path).first();
    if (await loc.evaluate(submitGuard) !== null) continue;
    const before = page.url();
    act();
    await loc.click({ timeout: 2e3 });
    const closed = await closedAfter();
    if (page.url() !== before) return { closed: false, name: c.name, why: `the close control "${c.name}" navigated (${before} \u2192 ${page.url()})` };
    return closed ? { closed: true, name: c.name, why: "" } : { closed: false, name: c.name, why: `the close control "${c.name}" did not close it` };
  }
  return { closed: false, name: "", why: "no visible Cancel / Close / Dismiss / No / Not now / \xD7 button in the dialog (the probe never clicks Save, Delete, a submit or a link)" };
}
async function pressOnOpener(page, key, act) {
  const k = await page.evaluate(keyTarget, null);
  if (!k.ok) return `${k.desc}: ${k.why}`;
  const submits = await page.locator(":focus").last().evaluate(submitGuard, void 0, { timeout: 2e3 }).catch(() => "the focused element could not be checked");
  if (submits !== null) return `${k.desc} would submit a form (${submits})`;
  act();
  await page.keyboard.press(key === " " ? "Space" : key);
  return null;
}
var TRIED_CAP = 20;
function logTried(log, method, url, cap = TRIED_CAP) {
  if (log.list.length < cap) {
    log.list.push({ method, url });
    return true;
  }
  log.more++;
  return false;
}
function blockedOf(log, phases) {
  return log.list.map((w, i) => ({ method: w.method, url: w.url, phases, ...i === log.list.length - 1 && log.more > 0 ? { more: log.more } : {} }));
}
var READ_METHODS = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
var phaseOf = (c) => `${c.id}|${c.variant ?? ""}`;
function judgeWrites(rows, blocked) {
  return rows.map((c) => {
    const hits = blocked.filter((b) => b.phases.includes(phaseOf(c)) || b.phases.includes(`${c.id}|`));
    if (!hits.length) return c;
    const first = hits[0];
    const extra = hits.length - 1 + hits.reduce((n, b) => n + (b.more ?? 0), 0);
    return {
      ...c,
      status: "not-run",
      detail: `not-run: the page tried to write (${first ? `${first.method} ${new URL(first.url).pathname}` : "?"}${extra > 0 ? ` +${extra} more` : ""}) \u2014 blocked; not judged`,
      evidence: { ...c.evidence ?? {}, blockedWrites: hits.slice(0, 5).map((b) => ({ method: b.method, url: b.url })), was: c.status }
    };
  });
}
var originPath = (url) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};
async function openWriteBlock(browser) {
  const cdp = await browser.newBrowserCDPSession();
  let current = null;
  cdp.on("Fetch.requestPaused", (ev) => {
    const method = ev.request.method.toUpperCase();
    if (READ_METHODS.has(method) || current === null || !current.armed) {
      cdp.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => void 0);
      return;
    }
    current.write(method, originPath(ev.request.url));
    cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" }).catch(() => void 0);
  });
  try {
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  } catch (e) {
    await cdp.detach().catch(() => void 0);
    throw e;
  }
  return { unit: (n) => {
    current = n;
  }, close: () => {
    cdp.detach().catch(() => void 0);
  } };
}
async function openUnitPage(browser, o, onContext, net) {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  onContext(context);
  let loads = 0;
  const failed = [];
  try {
    await context.routeWebSocket(/.*/, (ws) => {
      const url = originPath(ws.url());
      if (net.armed) {
        const kept = net.write("WebSocket", url);
        ws.onMessage(() => {
          net.write("WebSocket", url);
        });
        if (kept) ws.close().catch(() => void 0);
        return;
      }
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        if (net.armed) net.write("WebSocket", url);
        else server.send(m);
      });
      server.onMessage((m) => {
        ws.send(m);
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout);
    await page.addInitScript({ content: o.initScript });
    page.on("load", () => {
      loads++;
    });
    page.on("requestfailed", (r) => {
      if (!net.armed && failed.length < 5) failed.push(`${r.method()} ${new URL(originPath(r.url()), "http://x").pathname} (${r.failure()?.errorText ?? "failed"})`);
    });
    await o.reach(page);
    return { context, page, loads: () => loads, failed };
  } catch (e) {
    await context.close().catch(() => void 0);
    throw e;
  }
}
var sameKey = (d, p) => d.id === p.id && (d.nodeId === void 0 || d.nodeId === p.nodeId) && (d.trigger === void 0 || d.trigger === p.trigger) && (d.variant === void 0 || d.variant === p.variant);
function fill(out, produced, declared, why) {
  for (const d of declared) {
    if (produced.some((p) => sameKey(d, p))) continue;
    out.push({ id: d.id, status: "not-run", ...d.nodeId !== void 0 ? { nodeId: d.nodeId } : {}, ...d.trigger !== void 0 ? { trigger: d.trigger } : {}, ...d.variant !== void 0 ? { variant: d.variant } : {}, detail: `not-run: ${why}` });
  }
}
async function runBehaviour(browser, o) {
  const t0 = Date.now();
  const opening = openWriteBlock(browser);
  const late = /* @__PURE__ */ Symbol("no answer");
  const block = await Promise.race([opening, sleep2(Math.min(WRITE_BLOCK_SETUP_MS, o.budgetMs), late, { ref: false })]);
  if (block === late) {
    opening.then((b) => {
      b.close();
    }, () => void 0);
    throw new Error(`the write block could not be set up (the browser did not answer within ${Math.round(Math.min(WRITE_BLOCK_SETUP_MS, o.budgetMs) / 1e3)} s)`);
  }
  try {
    return await runUnits(browser, o, block, t0);
  } finally {
    block.close();
  }
}
var WRITE_BLOCK_SETUP_MS = 5e3;
async function runUnits(browser, o, block, t0) {
  const end = t0 + o.budgetMs;
  const checks = [];
  let cut = false;
  let landmarks = null;
  let axe = "why" in o.axe ? { ran: false, why: o.axe.why } : { ran: false, why: "axe did not run (the a11y unit was not reached)" };
  const widths = [];
  let forced = null;
  const keyOpens = /* @__PURE__ */ new Map();
  const nonModal = /* @__PURE__ */ new Set();
  let batteryLeft = 0;
  const runUnit = async (unit) => {
    const tu = Date.now();
    try {
      await runUnitInner(unit);
    } finally {
      if (process.env.DT_BEHAVIOUR_DEBUG) console.error(`[behaviour] ${unit.name} ${Date.now() - tu}ms`);
    }
  };
  const runUnitInner = async (unit) => {
    const produced = [];
    const budgetLeft = end - Date.now();
    const left = unit.battery ? unitCap(budgetLeft, batteryLeft) : budgetLeft;
    if (unit.battery) batteryLeft--;
    if (left <= 0) {
      cut = true;
      fill(checks, [], unit.declared, "time budget");
      return;
    }
    const unitEnd = Date.now() + left;
    let closed = false;
    const held = {};
    let loadsAt = 0;
    let loadsNow = () => 0;
    const trace = { phases: [{ seq: 0, keys: ["reach|"] }], actions: [] };
    const tried = { list: [], more: 0 };
    const net = { armed: false, write: (method, url) => {
      const kept = logTried(tried, method, url);
      if (kept && process.env.DT_BEHAVIOUR_DEBUG) console.error(`[behaviour] ${unit.name}: blocked ${method} ${url} (in ${trace.phases.at(-1)?.keys.join(" ") ?? "?"})`);
      return kept;
    } };
    const api = (page) => ({
      page,
      add: (c) => {
        if (!closed) produced.push(c);
      },
      phase: (...keys) => {
        trace.phases.push({ seq: trace.phases.length, keys: keys.map((k) => k.includes("|") ? k : `${k}|`) });
      },
      act: () => {
        net.armed = true;
        trace.actions.push({ at: Date.now(), seq: trace.phases.length - 1 });
      },
      guard: () => {
        if (loadsNow() !== loadsAt) throw new UnitNavigated("the page loaded a new document");
      }
    });
    const blocked = () => blockedOf(tried, taintedPhases(trace));
    block.unit(net);
    let timer;
    const cutP = new Promise((resolve) => {
      timer = setTimeout(() => resolve("cut"), left);
    });
    const work = (async () => {
      let reached;
      try {
        reached = await openUnitPage(browser, o, (c) => {
          held.ctx = c;
        }, net);
      } catch (e) {
        return e instanceof StepError ? `the steps failed \u2014 ${e.message}` : `could not reach the screen \u2014 ${firstLine2(e)}`;
      }
      try {
        loadsAt = reached.loads();
        loadsNow = reached.loads;
        if (o.measuredTags && o.measuredTags.length) {
          const diff = fingerprintDiff(o.measuredTags, await reached.page.evaluate(visibleTags, null), unit.uses);
          if (diff !== null) throw new BatteryStop(`the page reached for this check differs from the measured page (${diff}${reached.failed.length ? `; failed while loading: ${reached.failed.slice(0, 3).join(", ")}` : ""})`);
        }
        await reached.page.evaluate(tipPreMark, null).catch(() => false);
        await unit.run(api(reached.page));
        return null;
      } finally {
        const last = trace.actions.at(-1);
        const wait = last ? Math.min(WRITE_SETTLE_MS - (Date.now() - last.at), unitEnd - Date.now()) : 0;
        if (wait > 0) await sleep2(wait, void 0, { ref: false });
        await reached.context.close().catch(() => void 0);
      }
    })().catch((e) => {
      if (e instanceof UnitNavigated || NAVIGATED2.test(errMsg(e))) return "the page loaded a new document";
      if (e instanceof BatteryStop) return e.message;
      return `the check could not run \u2014 ${firstLine2(e)}`;
    });
    const r = await Promise.race([work, cutP]);
    clearTimeout(timer);
    if (r === "cut") {
      closed = true;
      cut = true;
      const ctx = held.ctx;
      await Promise.race([(async () => {
        if (ctx) await ctx.close().catch(() => void 0);
        await work;
      })(), sleep2(CUT_SETTLE_MS2, void 0, { ref: false })]);
      block.unit(null);
      checks.push(...judgeWrites(produced, blocked()));
      fill(checks, produced, unit.declared, left < budgetLeft ? `time budget (this unit's share: ${Math.round(left / 1e3)} s)` : "time budget");
      return;
    }
    block.unit(null);
    closed = true;
    checks.push(...judgeWrites(produced, blocked()));
    if (r !== null) fill(checks, produced, unit.declared, r);
    else fill(checks, produced, unit.declared, "the unit ended before this check");
  };
  const exp = o.expectation;
  const hidden = new Set(exp.hidden && exp.hidden.ids || []);
  const subjectIds = [...new Set((exp.interactions || []).filter((r) => !hidden.has(r.nodeId) && /^on_(click|press)$/i.test(String(r.trigger))).map((r) => r.nodeId))];
  await runUnit({
    name: "a11y",
    declared: [{ id: "a11y.landmarks" }, { id: "a11y.axe" }, { id: "keyboard.reachable" }, { id: "keyboard.focus-visible" }, { id: "a11y.name" }],
    run: async (u) => {
      const { page } = u;
      await park(page);
      u.phase("a11y.landmarks");
      let yaml = null;
      try {
        yaml = await page.locator("body").ariaSnapshot({ timeout: Math.min(o.timeout, 1e4) });
      } catch (e) {
        if (NAVIGATED2.test(errMsg(e))) throw e;
      }
      const tree = yaml === null ? null : parseAriaLandmarkTree(yaml);
      landmarks = tree ? tree.landmarks : null;
      for (const c of landmarkFindings(tree, tree ? await page.evaluate(unnamedRegions, null) : [])) u.add(c);
      u.guard();
      u.phase("a11y.axe");
      if ("why" in o.axe) u.add({ id: "a11y.axe", status: "not-run", detail: `not-run: ${o.axe.why}` });
      else {
        try {
          await page.evaluate(o.axe.source);
          const axeCap = Math.max(1e3, Math.min(AXE_CAP_MS, end - Date.now()));
          const res = await Promise.race([
            page.evaluate(`(async () => { const r = await axe.run(document, { resultTypes: ["violations"], iframes: false }); return { version: axe.version, violations: r.violations.map((v) => ({ id: v.id, impact: v.impact == null ? null : String(v.impact), nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 3).map((n) => Array.isArray(n.target) ? n.target.map(String).join(" ") : String(n.target)) })) }; })()`),
            sleep2(axeCap, AXE_TIMED_OUT, { ref: false })
          ]);
          if (res === AXE_TIMED_OUT) throw new AxeTimeout(`axe timed out after ${Math.round(axeCap / 1e3)} s`);
          const parsed = readAxeResult(res, o.axe.version);
          axe = parsed;
          if (parsed.ran) {
            const st = axeStatus(parsed.violations);
            const list = parsed.violations.map((v) => `${v.id} (${v.impact ?? "?"}, ${v.nodes} node${v.nodes === 1 ? "" : "s"})`).join(", ");
            u.add({ id: "a11y.axe", status: st, detail: st === "pass" ? `axe-core ${parsed.version}: no violations (main frame; iframes not scanned)` : `axe-core ${parsed.version}: ${parsed.violations.length} violation(s) \u2014 ${list} (critical/serious = fail, moderate/minor = warn; main frame; iframes not scanned)`, evidence: { version: parsed.version, violations: parsed.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes, help: v.help, targets: v.targets })) } });
          }
        } catch (e) {
          if (NAVIGATED2.test(errMsg(e))) throw e;
          axe = { ran: false, why: e instanceof AxeTimeout ? e.message : `axe-core ${o.axe.version} failed in the page: ${firstLine2(e)}` };
          u.add({ id: "a11y.axe", status: "not-run", detail: `not-run: ${axe.why}` });
        }
      }
      u.guard();
      await park(page);
      u.phase("keyboard.reachable", "keyboard.focus-visible", "a11y.name");
      await page.evaluate(sentinelInsert, null);
      let walkEnd = "cap";
      for (let i = 0; i < WALK_CAP; i++) {
        u.act();
        await page.keyboard.press("Tab");
        const s = await page.evaluate(walkStep, { record: true });
        if (s.end !== null) {
          walkEnd = s.end;
          break;
        }
      }
      u.guard();
      const { n: nStops, visible: stopVisible } = await page.evaluate(stopsCount, null);
      const visibleAt = (i) => stopVisible[i] === true;
      const subs = [];
      for (const id of subjectIds) {
        const mo = await markOpenerSeen(page, id, u.act);
        subs.push({ ...await page.evaluate(subjectRead, { id }), why: mo.why });
      }
      const reachRows = [];
      let reachedOk = 0, reachTotal = 0;
      for (const s of subs) {
        if (s.count !== 1) continue;
        reachTotal++;
        const ev = { visibility: s.visibility, tabindex: s.tabindex, tag: s.tag };
        if (!s.hasBox) {
          reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: "not-run: display:none at rest (no layout box) \u2014 nothing to reach", evidence: ev });
          continue;
        }
        if (s.disabled) {
          reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: "not-run: disabled", evidence: ev });
          continue;
        }
        if (s.stop < 0) {
          if (s.closedIn !== null) {
            reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: inside a closed container (${s.closedIn}) \u2014 reachable once it is opened`, evidence: ev });
            continue;
          }
          if (walkEnd === "cap") {
            reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: the Tab walk stopped at ${WALK_CAP} Tab presses (${nStops} stops) before reaching it`, evidence: ev });
            continue;
          }
          if (s.inside !== null) {
            reachRows.push({ id: "keyboard.reachable", status: "not-run", nodeId: s.id, detail: `not-run: the opener is a container; Tab reaches ${s.inside} inside it, which is not the opener's own control${s.why !== null ? ` \u2014 ${s.why}` : ""} (keyboard.activation reports it)`, evidence: ev });
            continue;
          }
          reachRows.push({ id: "keyboard.reachable", status: "fail", nodeId: s.id, detail: `not reached by Tab (computed visibility ${s.visibility || "?"}, tabindex ${s.tabindex ?? "none"}, <${s.tag}>) \u2014 a keyboard user cannot reach this control; hover-only actions must stay focusable (opacity + :focus-within, never visibility:hidden), and a clickable non-button needs tabindex="0" or a <button>`, evidence: ev });
          continue;
        }
        if (!visibleAt(s.stop)) {
          reachRows.push({ id: "keyboard.reachable", status: "warn", nodeId: s.id, detail: "reached by Tab but invisible while focused (opacity 0 / hidden) \u2014 reveal it on focus too (e.g. group-focus-within:opacity-100)", evidence: { ...ev, stop: s.stop } });
          continue;
        }
        reachedOk++;
      }
      for (const c of perElement("keyboard.reachable", reachRows, reachedOk, reachTotal, "interactive element(s) reached by Tab and visible while focused")) u.add(c);
      if (reachTotal === 0) u.add({ id: "keyboard.reachable", status: "not-run", detail: "not-run: the expectation lists no click/press interaction tagged exactly once on the screen" });
      const fvRows = [];
      let fvOk = 0;
      const fvN = Math.min(nStops, 60);
      const shot = (clip) => page.screenshot({ clip, animations: "disabled", caret: "hide" });
      u.phase("keyboard.focus-visible");
      const fvRes = [];
      for (let i = 0; i < fvN; i++) {
        u.guard();
        if (!await page.evaluate(focusBefore, { i })) {
          fvRes.push({ i, status: "not-run", detail: "not-run: could not focus the stop before it" });
          continue;
        }
        u.act();
        await page.keyboard.press("Tab");
        await raf22(page);
        let f = await page.evaluate(focusedStop, { i });
        for (let k = 0; k < 10 && !f.ok && f.onPrev; k++) {
          u.act();
          await page.keyboard.press("Tab");
          await raf22(page);
          f = await page.evaluate(focusedStop, { i });
        }
        if (!f.ok) {
          fvRes.push({ i, status: "not-run", detail: "not-run: a Tab from the previous stop did not land on it again" });
          continue;
        }
        if (!f.visible) {
          fvRes.push({ i, status: "not-run", detail: "not-run: invisible while focused (keyboard.reachable reports it when it is an interaction)" });
          continue;
        }
        const M = 8;
        const x0 = Math.max(0, Math.floor(f.rect.x - M)), y0 = Math.max(0, Math.floor(f.rect.y - M));
        const x1 = Math.min(f.vw, Math.ceil(f.rect.x + f.rect.w + M)), y1 = Math.min(f.vh, Math.ceil(f.rect.y + f.rect.h + M));
        if (x1 - x0 < 1 || y1 - y0 < 1) {
          fvRes.push({ i, status: "not-run", detail: "not-run: off screen while focused" });
          continue;
        }
        const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        const focusedPng = await shot(clip);
        await page.evaluate(blurActive, null);
        await raf22(page);
        const blurredPng = await shot(clip);
        const evidence = { outlineStyle: f.outlineStyle, outlineWidth: f.outlineWidth, boxShadow: f.boxShadow, focusVisible: f.focusVisible };
        if (focusedPng.equals(blurredPng)) fvRes.push({ i, status: "fail", detail: `no visible focus indicator: focused and unfocused look identical (\xB18 px around it) \u2014 outline-style ${f.outlineStyle || "?"}, box-shadow ${f.boxShadow || "?"}; a utility that hides the outline needs a visible replacement on :focus-visible (e.g. Tailwind v4 focus-visible:outline-solid, or a ring)`, evidence });
        else {
          fvRes.push({ i, status: "pass", detail: "", evidence });
          fvOk++;
        }
      }
      await page.evaluate(sentinelRemove, null);
      const info = await page.evaluate(stopsInfo, null);
      for (const r of fvRes) {
        if (r.status === "pass") continue;
        const s = info[r.i];
        fvRows.push({ id: "keyboard.focus-visible", status: r.status, ...s && s.dt !== null ? { nodeId: s.dt } : {}, ...s ? { target: s.path } : {}, detail: r.detail, ...r.evidence ? { evidence: r.evidence } : {} });
      }
      if (nStops > 60) fvRows.push({ id: "keyboard.focus-visible", status: "not-run", detail: `not-run: ${nStops - 60} Tab stop(s) after the first 60`, evidence: { count: nStops - 60 } });
      for (const c of perElement("keyboard.focus-visible", fvRows, fvOk, fvN, "Tab stop(s) show a visible focus indicator")) u.add(c);
      if (nStops === 0) u.add({ id: "keyboard.focus-visible", status: "not-run", detail: "not-run: Tab reached no focusable element" });
      u.phase("a11y.name");
      const nameRows = [];
      let nameOk = 0;
      for (const [i, s] of info.entries()) {
        u.guard();
        if (!s.connected) {
          nameRows.push({ id: "a11y.name", status: "not-run", ...s.dt !== null ? { nodeId: s.dt } : {}, target: s.path, detail: "not-run: left the document during the walk" });
          continue;
        }
        let snap = "";
        try {
          snap = await page.locator(s.path).first().ariaSnapshot({ timeout: 2e3 });
        } catch (e) {
          if (NAVIGATED2.test(errMsg(e))) throw e;
          nameRows.push({ id: "a11y.name", status: "not-run", ...s.dt !== null ? { nodeId: s.dt } : {}, target: s.path, detail: `not-run: no accessibility snapshot (${firstLine2(e)})` });
          continue;
        }
        const n = nameStatus(snap, s);
        const ev = { snapshot: (snap.split("\n")[0] ?? "").slice(0, 120), tag: s.tag, stop: i, ...s.domName !== null ? { domName: s.domName } : {} };
        if (n.status === "warn") nameRows.push({ id: "a11y.name", status: "warn", ...s.dt !== null ? { nodeId: s.dt } : {}, target: s.path, detail: `a focusable <${s.tag}> with no role \u2014 give it a role (or use a native control) and a name; names computed by ${NAMES_COMPUTED_BY}`, evidence: ev });
        else if (n.status === "fail") nameRows.push({ id: "a11y.name", status: "fail", ...s.dt !== null ? { nodeId: s.dt } : {}, target: s.path, detail: `${n.role} with no accessible name \u2014 an icon-only control needs aria-label (or visible text); names computed by ${NAMES_COMPUTED_BY}`, evidence: ev });
        else nameOk++;
      }
      for (const c of perElement("a11y.name", nameRows, nameOk, info.length, `Tab stop(s) have a role and an accessible name (${NAMES_COMPUTED_BY})`)) u.add(c);
      if (info.length === 0) u.add({ id: "a11y.name", status: "not-run", detail: "not-run: Tab reached no focusable element" });
    }
  });
  const designW = o.viewport.w, designH = o.viewport.h;
  const mid = designW >= 1280, narrow = designW > 320;
  await runUnit({
    name: "render",
    declared: [
      { id: "forced-colors.visible" },
      { id: "layout.subpixel", variant: "design" },
      ...mid ? [{ id: "overflow.mid" }, { id: "layout.subpixel", variant: `1024x${designH}` }] : [],
      ...narrow ? [{ id: "overflow.narrow" }, { id: "layout.subpixel", variant: `320x${designH}` }] : []
    ],
    run: async (u) => {
      const { page } = u;
      await park(page);
      u.phase("forced-colors.visible");
      if ((o.browserName ?? "chromium") !== "chromium") u.add({ id: "forced-colors.visible", status: "unsupported", detail: "forced colours are emulated in Chromium only" });
      else {
        const cands = await page.evaluate(maskCandidates, { cap: 40 });
        const pairs = [];
        const toggle = async (i) => {
          u.act();
          const r = await page.evaluate(maskShow, { i });
          if (!r) return null;
          await raf22(page);
          const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y)), x1 = Math.min(r.vw, Math.ceil(r.x + r.w)), y1 = Math.min(r.vh, Math.ceil(r.y + r.h));
          if (x1 - x0 < 1 || y1 - y0 < 1) return null;
          const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          const a = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
          await page.evaluate(maskHide, { i, hide: true });
          await raf22(page);
          const b = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
          await page.evaluate(maskHide, { i, hide: false });
          return { differs: !a.equals(b), clip };
        };
        for (let i = 0; i < cands.length; i++) {
          u.guard();
          const t = await toggle(i);
          pairs.push({ normalDiffers: t ? t.differs : false, clip: t ? t.clip : null });
        }
        u.act();
        await page.emulateMedia({ forcedColors: "active" });
        await page.evaluate(scrollToY, { y: 0 });
        await raf22(page);
        forced = await page.screenshot({ animations: "disabled", caret: "hide" });
        const rows = [];
        let okN = 0, total = 0;
        for (let i = 0; i < cands.length; i++) {
          u.guard();
          const c = cands[i];
          const p = pairs[i];
          if (!c || !p) continue;
          const nodeId = c.dt !== null ? { nodeId: c.dt } : {};
          if (!p.normalDiffers) {
            rows.push({ id: "forced-colors.visible", status: "not-run", ...nodeId, detail: "not-run: hiding it changes nothing even in normal colours (covered or blank)" });
            continue;
          }
          total++;
          const t = await toggle(i);
          if (t === null) {
            rows.push({ id: "forced-colors.visible", status: "not-run", ...nodeId, detail: "not-run: not on screen under forced colours" });
            continue;
          }
          if (!t.differs) rows.push({ id: "forced-colors.visible", status: "fail", ...nodeId, detail: `a CSS-mask icon (<${c.tag}>${c.dt !== null ? ` in data-dt-node="${c.dt}"` : ""}) vanishes under forced colours: its background-color is forced to Canvas \u2014 add forced-color-adjust:none, or background-color:CanvasText inside @media (forced-colors: active) (an inline SVG with fill=currentColor needs nothing)` });
          else okN++;
        }
        await page.emulateMedia({ forcedColors: "none" });
        await raf22(page);
        for (const c of perElement("forced-colors.visible", rows, okN, total, "CSS-mask icon(s) stay visible under forced colours")) u.add(c);
        if (!cands.length) u.add({ id: "forced-colors.visible", status: "not-run", detail: "not-run: no CSS-mask icon on the screen (the only kind this check tests: SVG fill/stroke, <img> and url() backgrounds are not forced; plain background-colour boxes become Canvas by design)" });
      }
      u.phase("layout.subpixel", "overflow.mid", "overflow.narrow");
      const subRows = (variant, list) => {
        const rows = list.map((s) => ({ id: "layout.subpixel", status: "warn", variant, ...s.dt !== null ? { nodeId: s.dt } : {}, target: s.path, detail: `<${s.tag}>${s.text ? ` "${s.text}"` : ""} renders ${s.width}px wide \u2014 a collapsed ${s.tag === "td" || s.tag === "th" ? "table column" : "text box"} (a behaviour warning, not a fidelity delta)`, evidence: { width: s.width } }));
        if (rows.length) for (const c of perElement("layout.subpixel", rows, 0, 0, "", variant)) u.add(c);
        else u.add({ id: "layout.subpixel", status: "pass", variant, detail: "no table cell or text renders under 1px wide" });
      };
      const overflowOf = (ov) => {
        const { compatMode, ...rest } = ov;
        return { ...rest, ...compatMode !== "CSS1Compat" ? { compatMode } : {} };
      };
      u.act();
      await page.evaluate(scrollToY, { y: 0 });
      const designSub = await page.evaluate(subpixelRead, null);
      widths.push({ role: "design", overflow: overflowOf(await page.evaluate(readPageOverflow, null)), subpixel: designSub });
      subRows("design", designSub);
      const settleResize = async (w) => {
        u.act();
        await page.setViewportSize({ width: w, height: designH });
        await raf22(page);
        const t = Date.now();
        let last = "", stable = 0;
        for (; ; ) {
          await sleep2(100);
          const s = await page.evaluate(docSize, null);
          const sig = `${s.sw}x${s.sh}`;
          stable = sig === last ? stable + 1 : 0;
          last = sig;
          if (stable >= 2 && Date.now() - t >= 300 || Date.now() - t >= 1500) break;
        }
      };
      const at = async (role, w) => {
        u.guard();
        await settleResize(w);
        u.guard();
        const ov = overflowOf(await page.evaluate(readPageOverflow, null));
        const sub = await page.evaluate(subpixelRead, null);
        widths.push({ role, overflow: ov, subpixel: sub });
        const variant = `${w}x${designH}`;
        const id = role === "mid" ? "overflow.mid" : "overflow.narrow";
        const note = "live resize: load-time-only layouts not reproduced";
        const evidence = { viewport: variant, scrollWidth: ov.scrollWidth, clientWidth: ov.clientWidth, overflowX: ov.overflowX, offenders: ov.offenders.map((x) => ({ path: x.path, dt: x.dt, right: x.right })), note };
        if (ov.scrollable) {
          const twoD = role === "narrow" && await page.evaluate(offendersAre2D, { paths: ov.offenders.map((x) => x.path) });
          const names = ov.offenders.slice(0, 3).map((x) => x.dt !== null ? `data-dt-node="${x.dt}"` : x.path).join(", ");
          u.add({ id, status: "warn", variant, detail: `at ${w}px the page scrolls sideways (scrollWidth ${ov.scrollWidth} > ${ov.clientWidth}; widest: ${names || "?"})${role === "narrow" ? " \u2014 WCAG 1.4.10 reflow" : ""}${twoD ? "; WCAG 1.4.10 2-D content exception may apply (every offender is inside a table/pre/figure/media/grid)" : ""} (${note})`, evidence });
        } else u.add({ id, status: "pass", variant, detail: `no sideways scroll at ${w}px (${note})`, evidence });
        subRows(variant, sub);
      };
      if (mid) await at("mid", 1024);
      if (narrow) await at("narrow", 320);
      if (!mid) u.add({ id: "overflow.mid", status: "not-run", detail: `not-run: the design is ${designW}px wide (the 1024px check runs for designs \u2265 1280px)` });
      if (!narrow) u.add({ id: "overflow.narrow", status: "not-run", detail: `not-run: the design is ${designW}px wide (not wider than 320px)` });
    }
  });
  const { battery, skipped } = batteryRows(exp, o.driven);
  for (const { row, why } of skipped) for (const id of DIALOG_IDS) checks.push({ id, status: "not-run", nodeId: row.nodeId, trigger: row.trigger, detail: `not-run: ${why}` });
  batteryLeft = battery.length * 2;
  for (const row of battery) {
    const key = `${row.nodeId}|${row.trigger}`;
    const base = { nodeId: row.nodeId, trigger: row.trigger };
    const destId = row.destinationId ?? null;
    const contract = [...DIALOG_CONTRACT];
    const uses = destId === null ? [row.nodeId] : [row.nodeId, destId];
    await runUnit({
      name: `keyboard ${key}`,
      battery: true,
      uses,
      declared: [
        { id: "keyboard.activation", ...base },
        { id: "dialog.focus-on-open", ...base },
        { id: "dialog.focus-trap", ...base },
        { id: "dialog.escape-closes", ...base },
        { id: "dialog.focus-return", ...base, variant: "escape" },
        { id: "dialog.focus-return", ...base, variant: "close" },
        { id: "dialog.nested-escape", ...base }
      ],
      run: async (u) => {
        const { page } = u;
        const add = (c2) => u.add({ ...c2, ...base });
        await park(page);
        const detect = async () => {
          const t = Date.now();
          for (; ; ) {
            const r = await page.evaluate(pollDetector, { destId, contract });
            if (r.lost) throw new UnitNavigated("the page loaded a new document");
            if (r.opened && (destId === null || r.dest !== null && r.dest.inside || Date.now() - t >= 500)) return r.opened;
            if (Date.now() - t >= 2e3) return r.opened;
            await sleep2(100);
          }
        };
        const keyOpen = async (key2) => {
          await page.evaluate(armDetector, { destId, contract });
          const blocked = await pressOnOpener(page, key2, u.act);
          return blocked !== null ? { opened: null, blocked } : { opened: await detect(), blocked: null };
        };
        const mouseOpen = async () => {
          let st = await page.evaluate(openerState, { id: row.nodeId });
          if (st.count !== 1 || st.path === null) return { opened: null, why: `the opener matched ${st.count} element(s)` };
          if (st.disabled) return { opened: null, why: "the opener is disabled" };
          if (!st.visible && st.hoverPath !== null) {
            await page.mouse.move(0, 0);
            u.act();
            await page.locator(st.hoverPath).first().hover({ timeout: 2e3 }).catch(() => void 0);
            await raf22(page);
            st = await page.evaluate(openerState, { id: row.nodeId });
          }
          if (!st.visible || st.path === null) return { opened: null, why: "the opener is not visible even on hover" };
          const loc = page.locator(st.path).first();
          if (await loc.evaluate(submitGuard) !== null) return { opened: null, why: "the opener would submit a form" };
          await markOpenerSeen(page, row.nodeId, u.act);
          await page.evaluate(armDetector, { destId, contract });
          u.act();
          await loc.click({ timeout: 2e3 });
          return { opened: await detect() };
        };
        u.phase("keyboard.activation");
        const marked = await markOpenerSeen(page, row.nodeId, u.act);
        await page.evaluate(sentinelInsert, null);
        let reachedOpener = false;
        let ancestorStop = null, insideStop = null;
        for (let i = 0; i < WALK_CAP; i++) {
          u.act();
          await page.keyboard.press("Tab");
          const s = await page.evaluate(walkStep, { record: true });
          if (s.opener) {
            reachedOpener = true;
            break;
          }
          if (s.ancestor !== null && ancestorStop === null) ancestorStop = s.ancestor;
          if (s.inside !== null && insideStop === null) insideStop = s.inside;
          if (s.end !== null) break;
        }
        await page.evaluate(sentinelRemove, null);
        u.guard();
        let opened = null;
        let via = null;
        const notSelf = (what) => `not-run: the Tab stop at the opener is not the opener itself (${what}) \u2014 no key is pressed there`;
        if (!reachedOpener) add({ id: "keyboard.activation", status: "not-run", detail: insideStop !== null ? notSelf(`the opener is a container; its focusable child ${insideStop} is not pressed${marked.why !== null ? ` \u2014 ${marked.why}` : ""}`) : ancestorStop !== null ? notSelf(`${ancestorStop}, an ancestor of it`) : "not-run: Tab never reaches the opener (keyboard.reachable reports it)" });
        else {
          const e1 = await keyOpen("Enter");
          if (e1.blocked !== null) add({ id: "keyboard.activation", status: "not-run", detail: notSelf(e1.blocked) });
          else {
            opened = e1.opened;
            let spaceBlocked = null;
            if (opened) via = "Enter";
            else {
              u.guard();
              const e2 = await keyOpen(" ");
              spaceBlocked = e2.blocked;
              opened = e2.opened;
              if (opened) via = " ";
            }
            add(via === "Enter" ? { id: "keyboard.activation", status: "pass", detail: "Tab reaches the opener and Enter opens the dialog" } : via === " " ? { id: "keyboard.activation", status: "warn", detail: "only Space opens it, Enter does not \u2014 a button opens on both (a <button> does this by itself)" } : { id: "keyboard.activation", status: "fail", detail: `Tab reaches the opener but ${spaceBlocked === null ? "neither Enter nor Space opens" : `Enter does not open (Space not pressed: ${spaceBlocked})`} the dialog \u2014 a div with only onclick? use <button> (or handle Enter and Space)` });
          }
        }
        keyOpens.set(key, via);
        u.guard();
        const open = async () => {
          if (via !== null) {
            await markOpenerSeen(page, row.nodeId, u.act);
            await page.evaluate(focusOpener, { preventScroll: false });
            const r = await keyOpen(via);
            if (r.blocked === null) return { opened: r.opened };
          }
          return mouseOpen();
        };
        if (!opened) {
          u.phase("dialog.focus-on-open");
          const m = await mouseOpen();
          opened = m.opened;
          if (!opened) throw new BatteryStop(`the dialog did not open in the battery's page (${m.why ?? "nothing opened within 2 s"})`);
        }
        const kind = await page.evaluate(markDialog, { path: opened.selector });
        if (!kind.found) throw new BatteryStop("the opened element could not be found again");
        if (!(kind.modal || kind.dialogOpen || kind.ariaModal)) {
          nonModal.add(key);
          throw new BatteryStop(`the opened element is not a modal dialog \u2014 ${NOT_MODAL}`);
        }
        const modal = kind.modal || kind.ariaModal;
        u.phase("dialog.focus-on-open");
        await park(page);
        const f0 = await page.evaluate(focusVsDialog, { destId });
        add(f0.inside ? { id: "dialog.focus-on-open", status: "pass", detail: `focus moved into the dialog (initial target ${f0.desc}; recorded, not graded)`, evidence: { initial: f0.desc } } : { id: "dialog.focus-on-open", status: "fail", detail: `focus stayed ${f0.body ? "on <body>" : `on ${f0.desc}, outside the dialog`} when it opened \u2014 move focus into the dialog (its first control or its heading)`, evidence: { active: f0.desc } });
        u.guard();
        u.phase("dialog.focus-trap");
        if (!modal) add({ id: "dialog.focus-trap", status: "not-run", detail: "not-run: a non-modal dialog[open] (show()) does not trap focus" });
        else {
          const n = await page.evaluate(dialogTabbables, null);
          if (n > 30) add({ id: "dialog.focus-trap", status: "not-run", detail: "not-run: too many tabbables to prove a trap (more than 30 in the dialog)" });
          let escaped = n > 30 ? "" : null;
          for (const k of ["Tab", "Shift+Tab"]) {
            for (let i = 0; i < n + 2 && escaped === null; i++) {
              u.act();
              await page.keyboard.press(k);
              const f = await page.evaluate(focusVsDialog, { destId });
              if (!f.inside && !f.body) escaped = `${k} \xD7${i + 1} moved focus to ${f.desc}`;
            }
          }
          if (n <= 30) add(escaped === null ? { id: "dialog.focus-trap", status: "pass", detail: `Tab and Shift+Tab \xD7${n + 2} each stay inside the dialog (${n} tabbable element(s))` } : { id: "dialog.focus-trap", status: "fail", detail: `focus left the modal dialog: ${escaped} \u2014 trap Tab inside a modal (showModal() does, a div needs a focus trap)` });
        }
        u.guard();
        u.phase("dialog.escape-closes", "dialog.focus-return|escape");
        u.act();
        await page.keyboard.press("Escape");
        const closedAfter = async () => {
          const t = Date.now();
          for (; ; ) {
            await raf22(page);
            if (!await page.evaluate(dialogOpenNow, null)) return true;
            if (Date.now() - t >= 1e3) return false;
            await sleep2(100);
          }
        };
        const escClosed = await closedAfter();
        add(escClosed ? { id: "dialog.escape-closes", status: "pass", detail: "Escape closes the dialog" } : { id: "dialog.escape-closes", status: modal ? "fail" : "warn", detail: `Escape left the ${modal ? "modal " : ""}dialog open \u2014 close it on Escape (showModal() does; a div dialog needs a keydown handler)` });
        let closedBy = "";
        const focusReturn = async (variant) => {
          await park(page);
          const r = await page.evaluate(focusReturnRead, null);
          const s = focusReturnStatus(r);
          add({
            id: "dialog.focus-return",
            status: s.status,
            variant,
            detail: `after ${variant === "escape" ? "Escape" : `the close control "${closedBy}"`}: ${s.detail}`,
            evidence: { active: r.activeDesc, openerVisible: r.openerVisible, opacity0: r.opacity0, connected: r.connected, ...variant === "close" ? { closedBy } : {} }
          });
        };
        const safeClose = async () => {
          const r = await safeCloseOn(page, closedAfter, u.act);
          closedBy = r.name;
          return r;
        };
        let closeDone = false;
        if (escClosed) await focusReturn("escape");
        else {
          add({ id: "dialog.focus-return", status: "not-run", variant: "escape", detail: "not-run: Escape did not close the dialog" });
          u.phase("dialog.focus-return|close");
          const c2 = await safeClose();
          if (!c2.closed) {
            add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: ${c2.why ?? "the dialog stayed open"}` });
            throw new BatteryStop(`the dialog could not be closed for a fresh open (${c2.why ?? "?"})`);
          }
          await focusReturn("close");
          closeDone = true;
        }
        u.guard();
        u.phase("dialog.nested-escape");
        const o2 = await open();
        if (!o2.opened) throw new BatteryStop(`the dialog did not open again (${o2.why ?? "nothing opened within 2 s"})`);
        await page.evaluate(markDialog, { path: o2.opened.selector });
        const x = await page.evaluate(expanderFind, null);
        let stillOpen = true;
        if (x.path === null) {
          add(x.nativePicker ? { id: "dialog.nested-escape", status: "not-run", synthetic: true, detail: "not-run: native picker: synthetic (headless), not a real-browser observation \u2014 the dialog holds only a native <select>/date control, whose popup headless Chromium does not open" } : { id: "dialog.nested-escape", status: "not-run", detail: "not-run: no expandable control ([aria-expanded]) in the dialog" });
        } else {
          const loc = page.locator(x.path).first();
          if (await loc.evaluate(submitGuard) !== null) add({ id: "dialog.nested-escape", status: "not-run", detail: "not-run: the expandable control would submit a form" });
          else {
            u.act();
            await loc.click({ timeout: 2e3 });
            let expanded = false;
            const t = Date.now();
            while (Date.now() - t < 1e3) {
              if (await page.evaluate(expanderState, null) === "true") {
                expanded = true;
                break;
              }
              await sleep2(100);
            }
            if (!expanded) add({ id: "dialog.nested-escape", status: "not-run", detail: `not-run: ${x.desc} never reported aria-expanded="true" within 1 s of a click` });
            else {
              u.act();
              await page.keyboard.press("Escape");
              await raf22(page);
              await sleep2(150);
              await raf22(page);
              const dlgOpen = await page.evaluate(dialogOpenNow, null);
              const ctl = await page.evaluate(expanderState, null);
              stillOpen = dlgOpen;
              add(!dlgOpen ? { id: "dialog.nested-escape", status: "fail", detail: `Escape on the open ${x.desc} closed the whole dialog \u2014 the inner control must handle Escape (collapse it, preventDefault + stopPropagation) so the dialog stays open` } : ctl === "true" ? { id: "dialog.nested-escape", status: "warn", detail: `Escape left ${x.desc} expanded (the dialog stayed open) \u2014 Escape should collapse it first` } : { id: "dialog.nested-escape", status: "pass", detail: `Escape collapsed ${x.desc} and the dialog stayed open` });
            }
          }
        }
        u.guard();
        if (closeDone) return;
        u.phase("dialog.focus-return|close");
        if (!stillOpen || !await page.evaluate(dialogOpenNow, null)) {
          const o3 = await open();
          if (!o3.opened) {
            add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: the dialog did not open again (${o3.why ?? "nothing opened"})` });
            return;
          }
          await page.evaluate(markDialog, { path: o3.opened.selector });
        }
        const c = await safeClose();
        if (!c.closed) {
          add({ id: "dialog.focus-return", status: "not-run", variant: "close", detail: `not-run: ${c.why ?? "the dialog stayed open"}` });
          return;
        }
        await focusReturn("close");
      }
    });
    if (keyOpens.get(key) !== null && checks.some((c) => c.id === "keyboard.activation" && c.nodeId === row.nodeId && c.trigger === row.trigger && c.status === "not-run")) keyOpens.set(key, null);
    await runUnit({
      name: `scroll ${key}`,
      battery: true,
      uses,
      declared: [{ id: "dialog.scroll-open", ...base }, { id: "dialog.scrim", ...base }, { id: "dialog.click-outside", ...base }],
      run: async (u) => {
        if (nonModal.has(key)) throw new BatteryStop(`the opened element is not a modal dialog \u2014 ${NOT_MODAL}`);
        const { page } = u;
        const add = (c) => u.add({ ...c, ...base });
        const ov = row.overlay;
        const centre = overlayCentred(ov);
        const keyVia = keyOpens.get(key) ?? null;
        await park(page);
        const detect = async () => {
          const t = Date.now();
          for (; ; ) {
            const r = await page.evaluate(pollDetector, { destId, contract });
            if (r.lost) throw new UnitNavigated("the page loaded a new document");
            if (r.opened && (destId === null || r.dest !== null && r.dest.inside || Date.now() - t >= 500)) return r.opened;
            if (Date.now() - t >= 2e3) return r.opened;
            await sleep2(100);
          }
        };
        const openStill = async () => {
          await page.mouse.move(0, 0);
          let p = await markOpenerSeen(page, row.nodeId, u.act);
          if (!p.found) return { why: "the opener is not on the page" };
          if (!p.visible && p.hover && p.hover.inViewport) {
            u.act();
            await page.mouse.move(p.hover.x, p.hover.y);
            await raf22(page);
            p = await markOpenerSeen(page, row.nodeId, u.act);
          }
          if (p.visible && p.inViewport && p.hits) {
            await page.evaluate(armDetector, { destId, contract });
            u.act();
            await page.mouse.click(p.x, p.y);
            return { opened: await detect(), how: "a mouse click at its on-screen point" };
          }
          if (keyVia !== null) {
            await page.evaluate(focusOpener, { preventScroll: true });
            await page.evaluate(armDetector, { destId, contract });
            const blocked = await pressOnOpener(page, keyVia, u.act);
            if (blocked !== null) return { why: `the opener is off screen at this scroll and the key is not pressed there (${blocked})` };
            return { opened: await detect(), how: `focus({preventScroll}) + ${keyVia === " " ? "Space" : "Enter"}` };
          }
          return { why: "the opener is off screen at this scroll and opens only by mouse (keyboard.activation did not pass)" };
        };
        const closedAfter = async () => {
          const t = Date.now();
          for (; ; ) {
            await raf22(page);
            if (!await page.evaluate(dialogOpenNow, null)) return true;
            if (Date.now() - t >= 1e3) return false;
            await sleep2(100);
          }
        };
        const closeAny = async () => (await safeCloseOn(page, closedAfter, u.act)).closed;
        const size = await page.evaluate(docSize, null);
        const max = Math.max(0, size.sh - size.vh);
        const ys = max > 1 ? max > 150 ? [{ y: 150, variant: "y=150" }, { y: max, variant: "y=max" }] : [{ y: max, variant: "y=max" }] : [{ y: 0, variant: "y=0" }];
        let stuck = false;
        for (const { y, variant } of ys) {
          u.phase(`dialog.scroll-open|${variant}`);
          u.guard();
          if (stuck) {
            add({ id: "dialog.scroll-open", status: "not-run", variant, detail: "not-run: the dialog did not close after the previous scroll position" });
            continue;
          }
          u.act();
          await page.evaluate(scrollToY, { y });
          await raf22(page);
          const y0 = await page.evaluate(effScroll, null);
          const op2 = await openStill();
          if ("why" in op2) {
            add({ id: "dialog.scroll-open", status: "not-run", variant, detail: `not-run: ${op2.why}` });
            continue;
          }
          if (!op2.opened) {
            add({ id: "dialog.scroll-open", status: "not-run", variant, detail: `not-run: nothing opened after ${op2.how}` });
            continue;
          }
          const k = await page.evaluate(markDialog, { path: op2.opened.selector });
          if (k.found && !(k.modal || k.dialogOpen || k.ariaModal)) throw new BatteryStop(`the opened element is not a modal dialog \u2014 ${NOT_MODAL}`);
          const settled = await page.evaluate(settleDialog, null);
          const g = await page.evaluate(dialogGeometry, { destId });
          const problems = [];
          if (Math.abs(g.scrollY - y0) > 1) problems.push(`opening it scrolled the page from y=${Math.round(y0)} to y=${Math.round(g.scrollY)}`);
          const rect = { x: Math.round(g.rect.x), y: Math.round(g.rect.y), w: Math.round(g.rect.w), h: Math.round(g.rect.h) };
          if (centre) {
            const c = centredIn(g.rect, { w: g.vw, h: g.vh });
            if (!c.centred) problems.push(`it is not centred in the viewport (${g.via} at ${rect.x},${rect.y} ${rect.w}\xD7${rect.h} in ${g.vw}\xD7${g.vh}; position ${g.position || "?"}) \u2014 the design centres it (overlay ${ov?.from === "default" ? "default = center" : "position center"}); a fixed / top-layer dialog stays centred at any scroll`);
          } else if (g.rect.x < -1 || g.rect.y < -1 || g.rect.x + g.rect.w > g.vw + 1 || g.rect.y + g.rect.h > g.vh + 1) problems.push(`it leaves the viewport (${g.via} at ${rect.x},${rect.y} ${rect.w}\xD7${rect.h} in ${g.vw}\xD7${g.vh})`);
          u.act();
          await page.keyboard.press("Escape");
          const closed = await closedAfter();
          await raf22(page);
          const after = await page.evaluate(effScroll, null);
          if (closed && Math.abs(after - y0) > 1) problems.push(`closing it scrolled the page from y=${Math.round(y0)} to y=${Math.round(after)}`);
          if (!closed && !await closeAny()) stuck = true;
          const evidence = {
            y: Math.round(y0),
            afterOpen: Math.round(g.scrollY),
            afterClose: closed ? Math.round(after) : null,
            rect,
            viewport: { w: g.vw, h: g.vh },
            position: g.position,
            openedBy: op2.how,
            animations: settled.animations,
            stable: settled.stable
          };
          add(problems.length ? { id: "dialog.scroll-open", status: "fail", variant, detail: `opened at scroll y=${Math.round(y0)} by ${op2.how}: ${problems.join("; ")}`, evidence } : { id: "dialog.scroll-open", status: "pass", variant, detail: `opened at scroll y=${Math.round(y0)} by ${op2.how}: the page did not move${centre ? ", the dialog is centred" : ", the dialog is inside the viewport"}`, evidence });
        }
        u.guard();
        u.phase("dialog.scrim", "dialog.click-outside");
        if (!ov) {
          add({ id: "dialog.scrim", status: "not-run", detail: "not-run: the expectation has no overlay settings for this row (a plan row, or the destination was not exported)" });
          add({ id: "dialog.click-outside", status: "not-run", detail: "not-run: the expectation has no overlay settings for this row" });
          return;
        }
        if (stuck) {
          for (const id of ["dialog.scrim", "dialog.click-outside"]) add({ id, status: "not-run", detail: "not-run: the dialog could not be closed for a fresh open" });
          return;
        }
        u.act();
        await page.evaluate(scrollToY, { y: 0 });
        await raf22(page);
        const op = await openStill();
        if ("why" in op || !op.opened) {
          for (const id of ["dialog.scrim", "dialog.click-outside"]) add({ id, status: "not-run", detail: `not-run: ${"why" in op ? op.why : "nothing opened"}` });
          return;
        }
        const kd = await page.evaluate(markDialog, { path: op.opened.selector });
        await page.evaluate(settleDialog, null);
        const sr = await page.evaluate(scrimRead, null);
        const built = sr.backdrop ?? sr.cover;
        const want = ov.background;
        const unread = sr.backdrop === null && sr.unreadable !== null ? sr.unreadable : built !== null && parseColor(built) === null ? built : want !== null && parseColor(want) === null ? want : null;
        if (unread !== null) {
          add({ id: "dialog.scrim", status: "not-run", detail: `not-run: the scrim colour ${unread} is in a colour space the probe does not read`, evidence: { built, designed: want } });
        } else {
          const match = scrimMatches(want, built);
          add({ id: "dialog.scrim", status: match ? "pass" : "warn", detail: match ? `the scrim matches the design (${want ?? "no scrim"} vs ${built ?? "none"})` : `the scrim is ${built ?? "none"}${sr.backdrop !== null ? " (::backdrop)" : ""}, the design's overlay background is ${want ?? "none (no scrim)"}${ov.from === "default" ? " (Figma's default)" : ""}`, evidence: { built: built ?? null, designed: want, via: sr.backdrop !== null ? "::backdrop" : sr.cover !== null ? "fixed cover" : "none" } });
        }
        const pt = sr.point;
        if (pt === null) add({ id: "dialog.click-outside", status: "not-run", detail: sr.unreadable !== null ? `not-run: a layer over the page has a colour the probe does not read (${sr.unreadable}) \u2014 no point is known to be the backdrop` : `not-run: no backdrop to click \u2014 nothing covers the page outside the dialog (the furthest point hits ${sr.hitDesc}); a click there would land on the page` });
        else {
          u.phase("dialog.click-outside");
          u.act();
          await page.mouse.click(pt.x, pt.y);
          const closed = await closedAfter();
          const want2 = ov.closeOnClickOutside;
          const hint = closed ? "" : kd.native ? " (a native <dialog>: close it on a click whose event.target is the dialog)" : " (close it from the scrim's click)";
          add(closed === want2 ? { id: "dialog.click-outside", status: "pass", detail: `a click on the backdrop (${pt.x},${pt.y}) ${closed ? "closed" : "did not close"} it, as designed (closeOnClickOutside ${String(want2)})` } : { id: "dialog.click-outside", status: "warn", detail: `a click on the backdrop (${pt.x},${pt.y}) ${closed ? "closed" : "did not close"} it \u2014 the design says closeOnClickOutside ${String(want2)}${ov.from === "default" ? " (Figma's default)" : ""}${hint}`, evidence: { x: pt.x, y: pt.y, closed, designed: want2 } });
        }
      }
    });
  }
  return {
    behaviour: {
      version: 1,
      ran: true,
      browser: { name: o.browserName ?? "chromium", version: browser.version() },
      namesComputedBy: NAMES_COMPUTED_BY,
      budgetMs: o.budgetMs,
      elapsedMs: Date.now() - t0,
      cut,
      checks,
      landmarks,
      axe,
      widths,
      artifacts: forced ? [o.forcedPng] : [],
      writeBlock: WRITE_BLOCK_SCOPE
    },
    forcedPng: forced
  };
}
function readAxeResult(x, fallbackVersion) {
  if (typeof x !== "object" || x === null || !("violations" in x) || !Array.isArray(x.violations)) return { ran: false, why: "axe-core returned no result" };
  const version = "version" in x && typeof x.version === "string" ? x.version : fallbackVersion;
  const violations = [];
  for (const v of x.violations) {
    if (typeof v !== "object" || v === null) continue;
    const id = "id" in v && typeof v.id === "string" ? v.id : "?";
    const impact = "impact" in v && typeof v.impact === "string" ? v.impact : null;
    const nodes = "nodes" in v && typeof v.nodes === "number" ? v.nodes : 0;
    const help = "help" in v && typeof v.help === "string" ? v.help : "";
    const targets = "targets" in v && Array.isArray(v.targets) ? v.targets.filter((t) => typeof t === "string").slice(0, 3) : [];
    violations.push({ id, impact, nodes, help, targets });
  }
  return { ran: true, package: "axe-core", version, violations };
}

// design-to-code/probe-visual.ts
import fs4 from "node:fs";
import path4 from "node:path";
import crypto3 from "node:crypto";
import { setTimeout as sleep3 } from "node:timers/promises";

// design-to-code/visual-diff.ts
var rgb2y = (r, g, b) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
var rgb2i = (r, g, b) => r * 0.59597799 - g * 0.2741761 - b * 0.32180189;
var rgb2q = (r, g, b) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;
var blend = (c, a) => 255 + (c - 255) * a;
function colorDelta(img1, img2, k, m, yOnly) {
  let r1 = img1[k] ?? 0, g1 = img1[k + 1] ?? 0, b1 = img1[k + 2] ?? 0, a1 = img1[k + 3] ?? 0;
  let r2 = img2[m] ?? 0, g2 = img2[m + 1] ?? 0, b2 = img2[m + 2] ?? 0, a2 = img2[m + 3] ?? 0;
  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
  if (a1 < 255) {
    a1 /= 255;
    r1 = blend(r1, a1);
    g1 = blend(g1, a1);
    b1 = blend(b1, a1);
  }
  if (a2 < 255) {
    a2 /= 255;
    r2 = blend(r2, a2);
    g2 = blend(g2, a2);
    b2 = blend(b2, a2);
  }
  const y1 = rgb2y(r1, g1, b1), y2 = rgb2y(r2, g2, b2), y = y1 - y2;
  if (yOnly) return y;
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2), q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
  const delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
  return y1 > y2 ? -delta : delta;
}
var maxDeltaOf = (threshold) => 35215 * threshold * threshold;
function antialiased(img, x1, y1, width, height, img2) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  let min = 0, max = 0, minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const delta = colorDelta(img, img, pos, (y * width + x) * 4, true);
      if (delta === 0) {
        zeroes++;
        if (zeroes > 2) return false;
      } else if (delta < min) {
        min = delta;
        minX = x;
        minY = y;
      } else if (delta > max) {
        max = delta;
        maxX = x;
        maxY = y;
      }
    }
  }
  if (min === 0 || max === 0) return false;
  return hasManySiblings(img, minX, minY, width, height) && hasManySiblings(img2, minX, minY, width, height) || hasManySiblings(img, maxX, maxY, width, height) && hasManySiblings(img2, maxX, maxY, width, height);
}
function hasManySiblings(img, x1, y1, width, height) {
  const x0 = Math.max(x1 - 1, 0), y0 = Math.max(y1 - 1, 0), x2 = Math.min(x1 + 1, width - 1), y2 = Math.min(y1 + 1, height - 1);
  const pos = (y1 * width + x1) * 4;
  let zeroes = x1 === x0 || x1 === x2 || y1 === y0 || y1 === y2 ? 1 : 0;
  for (let x = x0; x <= x2; x++) {
    for (let y = y0; y <= y2; y++) {
      if (x === x1 && y === y1) continue;
      const pos2 = (y * width + x) * 4;
      if (img[pos] === img[pos2] && img[pos + 1] === img[pos2 + 1] && img[pos + 2] === img[pos2 + 2] && img[pos + 3] === img[pos2 + 3]) zeroes++;
      if (zeroes > 2) return true;
    }
  }
  return false;
}
var MASK = { same: 0, diff: 1, aa: 2, absorbed: 3 };
function diffOptionsFor(k) {
  return { threshold: 0.2, shiftPx: Math.max(1, Math.round(k)), cellPx: Math.max(2, Math.round(8 * k)), hotFraction: 0.08, hotMinPx: 4, edgePx: Number.isInteger(k) ? 0 : 1, maxRegions: 10 };
}
function matchedNear(a, b, x, y, w, h, r, maxDelta) {
  const p = (y * w + x) * 4;
  for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      if (Math.abs(colorDelta(a, b, p, (yy * w + xx) * 4)) <= maxDelta) return true;
    }
  }
  return false;
}
function diffPixels(ref, build, o) {
  if (ref.w !== build.w || ref.h !== build.h || ref.data.length !== build.data.length) throw new Error(`image sizes do not match (${ref.w}\xD7${ref.h} vs ${build.w}\xD7${build.h})`);
  const { w, h } = ref, a = ref.data, b = build.data;
  if (a.length !== w * h * 4) throw new Error("image data size does not match width/height");
  const maxDelta = maxDeltaOf(o.threshold), r = Math.max(0, Math.round(o.shiftPx));
  const mask = new Uint8Array(w * h);
  let differing = 0, aa = 0, absorbed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pos = (y * w + x) * 4;
      const delta = colorDelta(a, b, pos, pos);
      if (Math.abs(delta) <= maxDelta) continue;
      if (antialiased(a, x, y, w, h, b) || antialiased(b, x, y, w, h, a)) {
        mask[y * w + x] = MASK.aa;
        aa++;
        continue;
      }
      differing++;
      if (r > 0 && matchedNear(a, b, x, y, w, h, r, maxDelta) && matchedNear(b, a, x, y, w, h, r, maxDelta)) {
        mask[y * w + x] = MASK.absorbed;
        absorbed++;
      } else mask[y * w + x] = MASK.diff;
    }
  }
  const cell = Math.max(1, Math.round(o.cellPx)), cw = Math.ceil(w / cell), chh = Math.ceil(h / cell);
  const count = new Uint32Array(cw * chh), e = Math.max(0, Math.round(o.edgePx));
  for (let y = e; y < h - e; y++) for (let x = e; x < w - e; x++) if (mask[y * w + x] === MASK.diff) {
    const i = Math.floor(y / cell) * cw + Math.floor(x / cell);
    count[i] = (count[i] ?? 0) + 1;
  }
  const hotCell = new Uint8Array(cw * chh), hotAt = Math.max(o.hotMinPx, o.hotFraction * cell * cell);
  for (let i = 0; i < hotCell.length; i++) if ((count[i] ?? 0) >= hotAt) hotCell[i] = 1;
  const seen = new Uint8Array(cw * chh), regions = [];
  for (let i = 0; i < hotCell.length; i++) {
    if (!hotCell[i] || seen[i]) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, pixels = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop() ?? 0, cx = c % cw, cy = Math.floor(c / cw);
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      pixels += count[c] ?? 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
        const n = ny * cw + nx;
        if (hotCell[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const rx = x0 * cell, ry = y0 * cell;
    regions.push({ x: rx, y: ry, w: Math.min(w, (x1 + 1) * cell) - rx, h: Math.min(h, (y1 + 1) * cell) - ry, pixels });
  }
  regions.sort((p, q) => q.pixels - p.pixels || p.y - q.y || p.x - q.x);
  return { compared: w * h, differing, aa, shiftTolerant: differing - absorbed, mask, hot: regions.slice(0, Math.max(0, o.maxRegions)), hotTotal: regions.length };
}
var SHAPE_TOLERANCE = 0.01;
function referenceCrop(png, scale, offset, frame) {
  const x = Math.max(0, Math.min(png.w, Math.round(-offset.x * scale))), y = Math.max(0, Math.min(png.h, Math.round(-offset.y * scale)));
  return { x, y, w: Math.max(0, Math.min(png.w - x, Math.round(frame.w * scale))), h: Math.max(0, Math.min(png.h - y, Math.round(frame.h * scale))) };
}
function planGrid(refCrop, capture, tolPx = 2) {
  const dw = capture.w - refCrop.w, dh = capture.h - refCrop.h;
  if (Math.abs(dw) <= tolPx && Math.abs(dh) <= tolPx) {
    const w = Math.min(capture.w, refCrop.w), h = Math.min(capture.h, refCrop.h);
    return { grid: "reference", w, h, note: dw || dh ? `the capture is ${capture.w}\xD7${capture.h} device px and the reference's frame ${refCrop.w}\xD7${refCrop.h} (rounding) \u2014 compared over the common ${w}\xD7${h}` : null };
  }
  const shape = refCrop.w > 0 && refCrop.h > 0 && capture.w > 0 && capture.h > 0 ? capture.w / capture.h / (refCrop.w / refCrop.h) : 0;
  if (!(Math.abs(shape - 1) <= SHAPE_TOLERANCE)) {
    return { grid: "none", why: `the capture is ${capture.w}\xD7${capture.h} device px and the reference's frame ${refCrop.w}\xD7${refCrop.h} \u2014 different shapes (aspect ratios ${shape > 0 ? `${Math.round(Math.abs(shape - 1) * 1e3) / 10} %` : "not comparable"} apart), so resampling would stretch one of them: not compared (a stale or clipped reference \u2014 re-pull the screen, then re-run --expect)` };
  }
  return { grid: "1x", why: `the capture is ${capture.w}\xD7${capture.h} device px and the reference's frame ${refCrop.w}\xD7${refCrop.h} \u2014 resampled to 1x (resampling can hide a difference)` };
}
var overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
function attribute(hot, k, built, designed) {
  const names = (list, r) => {
    const ids = [];
    for (const n of list.filter((n2) => n2.rect.w > 0 && n2.rect.h > 0 && overlap(n2.rect, r)).sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h)) {
      if (!ids.includes(n.id)) ids.push(n.id);
      if (ids.length >= 5) break;
    }
    return ids;
  };
  return hot.map((h) => {
    const x = Math.floor(h.x / k), y = Math.floor(h.y / k);
    const rect = { x, y, w: Math.ceil((h.x + h.w) / k) - x, h: Math.ceil((h.y + h.h) / k) - y };
    return { rect, pixels: h.pixels, pct: Math.round(h.pixels / Math.max(1, h.w * h.h) * 1e3) / 10, built: names(built, rect), designed: names(designed, rect) };
  });
}
function renderDiff(build, d) {
  const { w, h } = build, out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4, m = d.mask[i] ?? 0;
    let r, g, b;
    if (m === MASK.diff) {
      r = 255;
      g = 0;
      b = 0;
    } else if (m === MASK.aa) {
      r = 255;
      g = 255;
      b = 0;
    } else if (m === MASK.absorbed) {
      r = 255;
      g = 200;
      b = 140;
    } else {
      const v = blend(rgb2y(build.data[p] ?? 0, build.data[p + 1] ?? 0, build.data[p + 2] ?? 0), 0.1 * (build.data[p + 3] ?? 0) / 255);
      r = v;
      g = v;
      b = v;
    }
    out[p] = r;
    out[p + 1] = g;
    out[p + 2] = b;
    out[p + 3] = 255;
  }
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    out[p] = 255;
    out[p + 1] = 0;
    out[p + 2] = 255;
    out[p + 3] = 255;
  };
  for (const r of d.hot) {
    for (let t = 0; t < 2; t++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        put(x, r.y + t);
        put(x, r.y + r.h - 1 - t);
      }
      for (let y = r.y; y < r.y + r.h; y++) {
        put(r.x + t, y);
        put(r.x + r.w - 1 - t, y);
      }
    }
  }
  return { w, h, data: out };
}

// design-to-code/probe-visual.ts
var VISUAL_CAP_MS = 3e4;
function visualBudget(now, deadline, cap = VISUAL_CAP_MS, reserve = BEHAVIOUR_RESERVE_MS) {
  return Math.max(0, Math.min(cap, deadline - now - reserve));
}
var FONTS_CAP_MS = 5e3;
var BUILT_CAP = 2e3;
function referenceRoot(expected, project) {
  const dir = path4.resolve(path4.dirname(expected));
  return path4.basename(dir) === "verify" && path4.basename(path4.dirname(dir)) === "design" ? path4.dirname(path4.dirname(dir)) : project;
}
var REFERENCE_MALFORMED = "the expectation's referenceImage is malformed \u2014 re-run --expect";
function prepareVisual(exp, root) {
  const ri = exp.referenceImage;
  if (ri === void 0) {
    return { ok: false, why: typeof exp.reference === "string" && exp.reference ? "the expectation predates the visual diff (no referenceImage) \u2014 re-run --expect" : "the export has no reference image for this screen" };
  }
  if (!isVerifyReferenceImage(ri)) return { ok: false, why: REFERENCE_MALFORMED };
  if (!ri.usable) return { ok: false, why: ri.why };
  const fw = exp.frame?.w, fh = exp.frame?.h;
  if (typeof fw !== "number" || typeof fh !== "number" || fw < 1 || fh < 1) return { ok: false, why: "the expectation states no frame size" };
  const file = resolveInside(root, ri.path, path4.join(root, "design", "export"));
  if (file === null) return { ok: false, why: `the reference path ${ri.path} is outside design/export \u2014 re-run --expect` };
  let bytes;
  try {
    bytes = fs4.readFileSync(file);
  } catch {
    return { ok: false, why: `the reference PNG ${ri.path} is missing \u2014 re-pull the screen, then re-run --expect` };
  }
  if (crypto3.createHash("sha256").update(bytes).digest("hex") !== ri.sha256) return { ok: false, why: `the reference PNG changed since --expect (${ri.path}) \u2014 re-run --expect` };
  const notes = [];
  if (exp.frames && exp.frames.length > 1) notes.push(`the expectation has ${exp.frames.length} frames \u2014 only the first (${exp.frame?.nodeId ?? "?"}) is diffed`);
  if (ri.colorProfile !== void 0) notes.push(`the reference's colour profile is ${ri.colorProfile} \u2014 colours are compared as raw samples, without colour management (a colour difference may be the profile's)`);
  return { ok: true, ref: ri, bytes, frameSize: { w: fw, h: fh }, notes };
}
function readFrame(arg) {
  let count = 0, rect = null;
  if (arg.selector !== null) {
    try {
      const list = document.querySelectorAll(arg.selector);
      count = list.length;
      const el = list.item(0);
      if (count === 1 && el) {
        const r = el.getBoundingClientRect();
        rect = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      }
    } catch {
      count = 0;
    }
  }
  const de = document.documentElement, b = document.body;
  return { count, rect, doc: { w: Math.max(de.scrollWidth, b ? b.scrollWidth : 0), h: Math.max(de.scrollHeight, b ? b.scrollHeight : 0) }, token: String(window.__dtProbeDoc || "") };
}
function readBuilt(arg) {
  const out = [];
  for (const n of arg.nodes) {
    try {
      const list = document.querySelectorAll(n.selector), el = list.item(0);
      if (list.length !== 1 || !el) continue;
      const r = el.getBoundingClientRect();
      out.push({ id: n.id, rect: { x: r.left + scrollX - arg.frame.x, y: r.top + scrollY - arg.frame.y, w: r.width, h: r.height } });
    } catch {
    }
  }
  return out;
}
var raf23 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
async function captureVisual(browser, o) {
  if (o.budgetMs <= 0) return { why: "no time left within --max-time after measuring and driving" };
  const held = {};
  const work = (async () => {
    let reached;
    try {
      reached = await openReached(browser, { viewport: o.viewport, timeout: o.timeout, initScript: o.initScript, reach: o.reach }, { dsf: o.ref.scale, onContext: (c) => {
        held.ctx = c;
      } });
    } catch (e) {
      return { why: e instanceof StepError ? `the steps failed \u2014 ${e.message}` : `could not reach the screen \u2014 ${firstLine3(e)}` };
    }
    const { context, page, loads } = reached;
    try {
      const loads0 = loads();
      await Promise.race([page.evaluate("document.fonts.ready.then(() => true)"), sleep3(FONTS_CAP_MS, void 0, { ref: false })]);
      await raf23(page);
      const notes = [];
      const fr = o.frame;
      const sel = fr && fr.via !== "viewport" ? fr.selector : null;
      const read = await page.evaluate(readFrame, { selector: sel });
      let origin;
      if (!fr) {
        origin = { x: 0, y: 0 };
        notes.push("no frame root was measured \u2014 the capture starts at the page's origin");
      } else if (fr.via === "viewport") origin = { x: 0, y: 0 };
      else if (read.rect !== null) origin = { x: read.rect.x, y: read.rect.y };
      else {
        origin = { x: fr.rect.x, y: fr.rect.y };
        notes.push(`the frame's selector matched ${read.count} element(s) on the capture page \u2014 the measurement pass's position was used`);
      }
      const built0 = fr && fr.via !== "viewport" && read.rect !== null ? read.rect : fr ? fr.rect : null;
      if (built0 !== null && fr && fr.via !== "viewport" && (Math.abs(built0.h - o.frameSize.h) > 1 || Math.abs(built0.w - o.frameSize.w) > 1)) {
        notes.push(`the built frame is ${Math.round(built0.w)}\xD7${Math.round(built0.h)} CSS px and the design ${o.frameSize.w}\xD7${o.frameSize.h} \u2014 only the design-size window at the built frame's top-left is compared`);
      }
      const clip = { x: Math.round(origin.x), y: Math.round(origin.y), w: Math.floor(o.frameSize.w), h: Math.floor(o.frameSize.h) };
      const x0 = Math.max(0, clip.x), y0 = Math.max(0, clip.y);
      const shot = { x: x0, y: y0, w: Math.max(0, Math.min(clip.x + clip.w, read.doc.w) - x0), h: Math.max(0, Math.min(clip.y + clip.h, read.doc.h) - y0) };
      if (shot.w < 1 || shot.h < 1) return { why: `the frame's window (${clip.w}\xD7${clip.h} at ${clip.x},${clip.y}) lies outside the ${read.doc.w}\xD7${read.doc.h} document` };
      const nodes = [];
      for (const n of o.nodes) if (n.selectorCount === 1 && typeof n.selector === "string" && n.selector && nodes.length < BUILT_CAP) nodes.push({ id: n.nodeId, selector: n.selector });
      const built = await page.evaluate(readBuilt, { nodes, frame: origin });
      const png = await page.screenshot({ clip: { x: shot.x, y: shot.y, width: shot.w, height: shot.h }, fullPage: true, animations: "disabled", caret: "hide", scale: "device" });
      const after = await page.evaluate(readFrame, { selector: null });
      if (loads() !== loads0 || after.token !== read.token) return { why: "the page loaded a new document during the visual capture" };
      return { png, dsf: o.ref.scale, clip, shot, frame: fr ? { nodeId: fr.nodeId, via: fr.via, selector: fr.selector } : { nodeId: "", via: "none", selector: null }, built, notes };
    } finally {
      await context.close().catch(() => void 0);
    }
  })().catch((e) => ({ why: /Execution context was destroyed|frame was detached|navigation/i.test(errMsg(e)) ? "the page loaded a new document during the visual capture" : `the visual capture failed \u2014 ${firstLine3(e)}` }));
  let timer;
  const cutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve("cut"), o.budgetMs);
  });
  const r = await Promise.race([work, cutP]);
  clearTimeout(timer);
  if (r !== "cut") return r;
  const ctx = held.ctx;
  await Promise.race([(async () => {
    if (ctx) await ctx.close().catch(() => void 0);
    await work;
  })(), sleep3(CUT_SETTLE_MS2, void 0, { ref: false })]);
  return { why: `the visual capture did not finish within its budget (${Math.round(o.budgetMs / 1e3)} s)` };
}
var firstLine3 = (e) => errMsg(e).split("\n")[0] ?? "";
var pct = (n, of) => of > 0 ? Math.round(n / of * 1e4) / 100 : 0;
function designedRects(exp) {
  const first = exp.frame?.nodeId;
  const out = [];
  for (const s of exp.nodes ?? []) {
    if (first !== void 0 && s.frameId !== void 0 && s.frameId !== first) continue;
    if (s.nodeId === first) continue;
    const h = typeof s.height === "number" ? s.height : typeof s.lineHeight === "number" ? s.lineHeight : typeof s.fontSize === "number" ? s.fontSize * 1.2 : null;
    if (typeof s.x !== "number" || typeof s.y !== "number" || typeof s.width !== "number" || h === null) continue;
    out.push({ id: s.nodeId, rect: { x: s.x, y: s.y, w: s.width, h } });
  }
  return out;
}
function finishVisual(o) {
  const t0 = Date.now(), cap = o.capture;
  if ("why" in cap) return { visual: { version: 1, ran: false, why: cap.why }, diffPng: null };
  try {
    const { ref } = o.prep, s = ref.scale;
    const notes = [...o.prep.notes, ...cap.notes];
    if (ref.offset.x > 0 || ref.offset.y > 0) notes.push(`the reference's render bounds lie inside the frame box (offset ${ref.offset.x},${ref.offset.y}) \u2014 alignment unverified`);
    const refImg = decodePng(o.prep.bytes);
    const full = referenceCrop(refImg, s, ref.offset, o.prep.frameSize);
    if (full.x !== ref.crop.x || full.y !== ref.crop.y || full.w !== ref.crop.w || full.h !== ref.crop.h) notes.push(`the expectation's reference crop ${JSON.stringify(ref.crop)} differs from the one recomputed from its scale and offset ${JSON.stringify(full)} \u2014 the recomputed one is used`);
    const dx = cap.shot.x - cap.clip.x, dy = cap.shot.y - cap.clip.y;
    const sub = { x: full.x + Math.round(dx * s), y: full.y + Math.round(dy * s), w: cap.shot.w === cap.clip.w ? full.w : Math.round(cap.shot.w * s), h: cap.shot.h === cap.clip.h ? full.h : Math.round(cap.shot.h * s) };
    const notCompared = cap.shot.w * cap.shot.h < cap.clip.w * cap.clip.h ? { pct: Math.round((1 - cap.shot.w * cap.shot.h / (cap.clip.w * cap.clip.h)) * 1e3) / 10, why: `the design window ${cap.clip.w}\xD7${cap.clip.h} at ${cap.clip.x},${cap.clip.y} reaches past the built page's end (${cap.shot.w}\xD7${cap.shot.h} of it exists)` } : null;
    const refCrop = crop(refImg, sub);
    const shotImg = decodePng(cap.png);
    const plan = planGrid(refCrop, shotImg);
    if (plan.grid === "none") return { visual: { version: 1, ran: false, why: plan.why }, diffPng: null };
    let a, b, k, resampled;
    if (plan.grid === "reference") {
      a = crop(refCrop, { x: 0, y: 0, w: plan.w, h: plan.h });
      b = crop(shotImg, { x: 0, y: 0, w: plan.w, h: plan.h });
      k = s;
      resampled = "none";
      if (plan.note !== null) notes.push(plan.note);
    } else {
      a = resampleBox(refCrop, cap.shot.w, cap.shot.h);
      b = resampleBox(shotImg, cap.shot.w, cap.shot.h);
      k = 1;
      resampled = "both";
      notes.push(plan.why);
    }
    const opts = diffOptionsFor(k);
    const d = diffPixels(a, b, opts);
    const regions = attribute(d.hot, k, cap.built.filter((n) => n.id !== cap.frame.nodeId), designedRects(o.expectation));
    const diffPng = encodePng(renderDiff(b, d));
    const visual = {
      version: 1,
      ran: true,
      reference: { path: ref.path, sha256: ref.sha256, scale: s, offset: ref.offset, from: ref.from, crop: sub, ...ref.colorProfile !== void 0 ? { colorProfile: ref.colorProfile } : {} },
      capture: { dsf: cap.dsf, clip: cap.clip, frame: cap.frame, size: { w: shotImg.w, h: shotImg.h } },
      grid: plan.grid,
      resampled,
      compared: { w: a.w, h: a.h, k },
      ...notCompared !== null ? { notCompared } : {},
      threshold: opts.threshold,
      shiftPx: opts.shiftPx,
      cellPx: opts.cellPx,
      hotFraction: opts.hotFraction,
      hotMinPx: opts.hotMinPx,
      differingPct: pct(d.differing, d.compared),
      shiftTolerantPct: pct(d.shiftTolerant, d.compared),
      aaPct: pct(d.aa, d.compared),
      regions,
      regionsTotal: d.hotTotal,
      diff: o.diffPath,
      elapsedMs: o.captureMs + (Date.now() - t0),
      notes
    };
    return { visual, diffPng };
  } catch (e) {
    return { visual: { version: 1, ran: false, why: `the visual diff failed (${e instanceof PngError ? e.message : firstLine3(e)})` }, diffPng: null };
  }
}
function visualLine(v) {
  if (!v.ran) return `visual not run (${v.why})`;
  return `visual (informational \u2014 never the verdict) ${pctText(v.shiftTolerantPct)}% of pixels differ (${pctText(v.differingPct)}% before ${v.shiftPx}-px shift tolerance) \xB7 ${v.regionsTotal} hot region(s) \xB7 at the reference's ${v.reference.scale}x (${v.reference.from}) \xB7 grid ${v.grid}${v.diff !== null ? ` \xB7 ${v.diff}` : ""}`;
}

// design-to-code/verify-probe.ts
var PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];
function isPlaywrightModule(x) {
  if (typeof x !== "object" || x === null || !("chromium" in x)) return false;
  const c = x.chromium;
  return typeof c === "object" && c !== null && "launch" in c && typeof c.launch === "function";
}
function installHint(dir) {
  const has = (f) => fs5.existsSync(path5.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm add -D playwright && pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn add -D playwright && yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bun add -d playwright && bunx playwright install chromium";
  return "npm i -D playwright && npx playwright install chromium";
}
function browserHint(dir) {
  const has = (f) => fs5.existsSync(path5.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bunx playwright install chromium";
  return "npx playwright install chromium";
}
function projectRequire(dir) {
  return createRequire(path5.join(path5.resolve(dir), "package.json"));
}
function resolvePlaywright(dir) {
  const abs = path5.resolve(dir);
  const req = projectRequire(abs);
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
  const pnp = fs5.existsSync(path5.join(abs, ".pnp.cjs")) ? " \u2014 this project uses Yarn Plug'n'Play: retry the probe as `yarn node <this script> \u2026`" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path5.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}
function resolveAxe(dir) {
  const req = projectRequire(dir);
  let file;
  try {
    file = req.resolve("axe-core");
  } catch {
    return { ok: false, why: "axe-core not installed in the project (optional)" };
  }
  let mod;
  try {
    mod = req("axe-core");
  } catch (e) {
    return { ok: false, why: `axe-core failed to load (${errMsg(e).split("\n")[0]})` };
  }
  if (typeof mod !== "object" || mod === null || !("source" in mod) || typeof mod.source !== "string") return { ok: false, why: "axe-core resolved, but it exports no source" };
  let version = "version" in mod && typeof mod.version === "string" ? mod.version : "unknown";
  try {
    const pj = req("axe-core/package.json");
    if (isJsonObject(pj) && typeof pj.version === "string") version = pj.version;
  } catch {
  }
  return { ok: true, source: mod.source, version, file };
}
function rendererUnavailable(reason, hint) {
  if (hint === null) {
    console.error(`verify-probe: renderer unavailable \u2014 ${reason} \u2014 nothing was measured or written.`);
    return 3;
  }
  console.error(`verify-probe: renderer unavailable \u2014 ${reason}
  nothing was measured or written. Ask the user to run:  ${hint}
  (verify-probe never installs a package or downloads a browser itself.)`);
  return 3;
}
var LAUNCH_ARGS = ["--disable-lcd-text"];
async function launch(r, dir, executablePath) {
  try {
    return { browser: await r.mod.chromium.launch({ headless: true, args: [...LAUNCH_ARGS], ...executablePath !== void 0 ? { executablePath } : {} }) };
  } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return { error: `${r.pkg} ${r.version} resolved, but chromium did not launch${executablePath !== void 0 ? ` from --browser-path ${executablePath} (only guaranteed with the bundled Chromium)` : ""}: ${first}`, hint: browserHint(dir) };
  }
}
function browserPathError(p) {
  let ok = false;
  try {
    ok = fs5.statSync(p).isFile();
    if (ok) fs5.accessSync(p, fs5.constants.X_OK);
  } catch {
    ok = false;
  }
  return ok ? null : `--browser-path ${p} is not an executable file (on macOS pass the binary inside the .app: \u2026/Contents/MacOS/\u2026)`;
}
var SELF2 = fileURLToPath3(import.meta.url);
function probeVersion() {
  for (const p of [path5.join(path5.dirname(SELF2), "..", ".claude-plugin", "plugin.json"), path5.join(path5.dirname(SELF2), "..", "claude-plugin", ".claude-plugin", "plugin.json")]) {
    const doc = readJsonOrNull(p, isJsonObject);
    if (doc && typeof doc.version === "string") return doc.version;
  }
  return null;
}
var selfSha256 = () => crypto4.createHash("sha256").update(fs5.readFileSync(SELF2)).digest("hex");
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
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
  let sheet = null;
  const adopt = () => { try { if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); } if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) {} };
  adopt();
  const add = () => { adopt(); const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
  addEventListener("load", adopt, { once: true });
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
        await sleep4(POLL_MS);
        continue;
      }
      if (moved()) throw kept();
      if (errorKind(errMsg(e), false) === "navigated" && Date.now() < docDeadline) {
        await sleep4(POLL_MS);
        continue;
      }
      throw new UnreachableError(ready ? `--ready '${ready}' never became visible: ${errMsg(e).split("\n")[0]}` : errMsg(e).split("\n")[0]);
    }
    let mark = log.docLoads;
    let last = "", since = Date.now();
    for (; ; ) {
      await sleep4(POLL_MS);
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
    await sleep4(POLL_MS);
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
  let newest = null;
  let before = false;
  const onRequest = (r) => {
    try {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame() && r.redirectedFrom() === null) {
        newest = r;
        before = committed;
        committed = false;
      }
    } catch {
    }
  };
  const onFailed = (r) => {
    let root = r;
    for (let up = root.redirectedFrom(); up !== null; up = up.redirectedFrom()) root = up;
    if (root === newest && /net::ERR_ABORTED/.test(r.failure()?.errorText ?? "")) committed = before;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
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
    page.off("requestfailed", onFailed);
  }
}
function loadFailureWhy(message) {
  const first = message.split("\n")[0] ?? "";
  if (/Download is starting/i.test(first)) return "the URL started a file download, not a page \u2014 point it at the page that renders the screen";
  if (/net::ERR_ABORTED/.test(first)) {
    return "the browser cancelled the navigation before any page arrived (net::ERR_ABORTED) \u2014 the URL answered with no document (e.g. 204 No Content) or the page stopped its own load; point it at the page that renders the screen";
  }
  return first;
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
        throw new StepError(`${name} could not load ${target.href}: ${loadFailureWhy(errMsg(e))}`);
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
    throw new UnreachableError(`could not load ${o.url}: ${loadFailureWhy(errMsg(e))}`);
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
var raf24 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
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
    const item = (spec, m) => ({
      nodeId: spec.nodeId,
      path: m.path,
      isText: spec.type === "TEXT",
      isPaint: isPaintSpec(spec),
      isPlaceholder: spec.placeholder === true,
      sharesWith: m.sharesWith ?? null,
      ...typeof spec.backgroundColor === "string" ? { backgroundSpec: true } : {}
    });
    const frameOf = (spec) => frames.get(spec.frameId ?? frameIn[0]?.nodeId ?? "");
    const frameRectOf = (spec) => {
      const f = frameOf(spec);
      return f ? f.rect : { x: 0, y: 0, w: o.viewport.w, h: o.viewport.h };
    };
    const measureIn = (spec, items) => ({ frameRect: frameRectOf(spec), framePath: frameOf(spec)?.path ?? null, keys: STYLE_KEYS, items });
    const nodes = /* @__PURE__ */ new Map();
    const byFrame = /* @__PURE__ */ new Map();
    for (const { spec, m } of matches) if (isMatch(m)) {
      const k = spec.frameId ?? "";
      byFrame.set(k, [...byFrame.get(k) || [], { spec, m }]);
    }
    for (const group of byFrame.values()) {
      const first = group[0];
      if (!first) continue;
      const raw = await page.evaluate(measureElements, measureIn(first.spec, group.map(({ spec, m }) => item(spec, m))));
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
      const own = m.hoverVia ?? hoverTarget(m.cand, pool.byTag) ?? m.path;
      let focusPath = null;
      try {
        if (state === "hover") {
          await page.mouse.move(0, 0);
          const via = await hoverDrawnState(page, spec, m, own, pool.byTag);
          if (via.hovered !== m.path) node.hoverVia = via.hovered;
          if (via.note !== null) node.note = node.note ? `${node.note}; ${via.note}` : via.note;
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
        await raf24(page);
        const [r] = await page.evaluate(measureElements, measureIn(spec, [item(spec, m)]));
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
    if (matches.some(({ spec }) => spec.drawnState === "hover")) await raf24(page);
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
      url: reachedUrl,
      visibleTags: [...new Set(collected.tagged.flatMap((c) => c.dt !== null && c.flags.box && c.flags.visible && !c.flags.inClosedDialog ? [c.dt] : []))]
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError || e instanceof StepError) throw e;
    if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
    if (errorKind(errMsg(e), false) === "navigated") throw new NavigatedError(errMsg(e).split("\n")[0]);
    throw e;
  }
}
async function hoverDrawnState(page, spec, m, own, byTag) {
  const oh = ownerHover(spec, m, byTag);
  let note = null;
  if (oh.kind === "untagged") note = `hovered the element itself: its drawn-hovered container ${oh.owner} has no visible tagged element (tag it with data-dt-node="${oh.owner}")`;
  if (oh.kind === "owner") {
    const tried = [];
    let covered = null;
    for (const c of [{ id: oh.id, path: oh.path }, ...oh.next]) {
      const loc = page.locator(c.path).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 2e3 }).catch(() => void 0);
      const position = await page.evaluate(freeHoverPoint, { owner: c.path, avoid: m.path });
      tried.push(c.id);
      if (position === null) continue;
      try {
        await loc.hover({ position, timeout: 1e3 });
        return { hovered: c.path, note: null };
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) !== "other") throw e;
        covered ??= `the free point on ${c.id} was covered (${errMsg(e).split("\n")[0]})`;
        await page.mouse.move(0, 0);
      }
    }
    const on = `its drawn-hovered container ${tried[0]}${tried.length > 1 ? ` (nor on ${tried.slice(1).join(", ")})` : ""}`;
    note = covered !== null ? `hovered the element itself: no usable free point on ${on} \u2014 ${covered}` : `hovered the element itself: no free point on ${on}`;
  }
  await page.locator(own).first().hover({ timeout: 2e3 });
  return { hovered: own, note };
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
  await Promise.race([Promise.allSettled(reads.map((r) => r.done)), sleep4(BODY_WAIT_MS, void 0, { ref: false })]);
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
function behaviourLine(b) {
  if (!b.ran) return `behaviour not run (${b.why})`;
  const n = (st) => b.checks.filter((c) => c.status === st).length;
  return `behaviour (not the fidelity verdict) ${n("fail")} fail \xB7 ${n("warn")} warn \xB7 ${n("pass")} pass \xB7 ${n("not-run")} not run${n("unsupported") ? ` \xB7 ${n("unsupported")} unsupported` : ""} \xB7 axe ${b.axe.ran ? `axe-core ${b.axe.version}` : `not run (${b.axe.why})`} \xB7 ${Math.round(b.elapsedMs / 1e3)}s of ${Math.round(b.budgetMs / 1e3)}s${b.cut ? " \u2014 CUT by the time budget" : ""}` + (b.artifacts.length ? ` \xB7 ${b.artifacts.join(", ")}` : "");
}
var USAGE = `usage:
  ${scriptCmd("verify-probe")} --expected design/verify/<Screen>.expected.json --url <url> [--out design/verify/<Screen>]
      [--ready <selector>] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>] [--run <id>] [--max-time <ms>]
      [--steps <steps.json | plan.json>] [--behaviour on|off] [--browser-path <executable>]
      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag \u2192 shared path \u2192 alias \u2192
      text \u2192 text-ordinal \u2192 --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.
      --out defaults to the .expected.json path minus \`.expected\`; --viewport to the frame's w\xD7h; --project to cwd.
      --run <id> (from verify-screen --status \u2026 --new-run): writes the run's LIVE status (the run cache,
      node_modules/.cache/designtwin-verify/<Screen>.status.json \u2014 never the project tree a dev server watches) \u2014 \`measuring\`
      before the browser starts, \`measured\` (+ the measured file's sha256) after it is closed; an exit 3/4 bumps its rev. A run that
      already ended (done/failed/blocked) is refused before anything starts, and one that ends while the page is measured
      gets no files (exit 2 both ways: start a --new-run).
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
      Then the behaviour/accessibility checks run, each unit on a fresh page within min(90 s, what --max-time leaves less
      20 s): landmarks, axe-core (when the project has it), a Tab walk (reachable, visible focus, names), forced colours,
      1024/320 px widths, and the keyboard/scroll battery on modal overlays \u2014 measured.behaviour (+ <out>.forced-colors.png),
      never the fidelity verdict and never an exit 4. --behaviour off skips them (measured.behaviour says so).
      Before them, when the expectation carries a usable referenceImage (--expect), the frame is captured once more at the
      reference's scale and diffed against the Figma reference after the browser closes: measured.visual + <out>.diff.png
      (informational \u2014 never the verdict, never an exit 4; not skipped by --behaviour off). Its design/export/\u2026 PNG is read
      from the project that owns the expectation (the folder above design/verify/), else from --project.
      --browser-path: launch this Chromium executable instead of the one Playwright installed (a cached browser) \u2014 only
      guaranteed with the bundled Chromium; on macOS the binary inside the .app (\u2026/Contents/MacOS/\u2026). Not an executable
      file \u2192 exit 3. measured.probe.browser.executable says "custom"; the path is printed, never written to a file.
  ${scriptCmd("verify-probe")} --check [--project <dir>] [--browser-path <executable>]
      resolves the project's Playwright and launches chromium once \u2014 nothing measured, nothing written.
exit: 0 wrote \xB7 2 usage \xB7 3 renderer unavailable (ask the user to install; never installed here) \xB7 4 the page kept
      navigating / reloaded twice during measurement / was unreachable / timed out / passed --max-time / a --steps step
      failed (nothing written).`;
var MAX_TIME_DEFAULT = 18e4;
async function closeCapped(b, capMs = CLOSE_STEP_CAP_MS) {
  const cap = () => sleep4(capMs, void 0, { ref: false });
  await Promise.race([b.newBrowserCDPSession().then((cdp) => cdp.send("Browser.close")).catch(() => void 0), cap()]);
  await Promise.race([b.close().catch(() => void 0), cap()]);
  killBrowserChildren();
}
function killBrowserChildren() {
  if (process.platform === "win32") return;
  try {
    const r = spawnSync2("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: PS_CAP_MS });
    for (const line of String(r.stdout || "").split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[2]) !== process.pid || !/chrom|headless/i.test(m[3] ?? "")) continue;
      try {
        process.kill(Number(m[1]), "SIGKILL");
      } catch {
      }
    }
  } catch {
  }
}
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
    steps: { type: "string" },
    behaviour: { type: "string" },
    "browser-path": { type: "string" }
  };
  const { values: f } = cliParse("verify-probe", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: false }));
  const project = path5.resolve(f.project ?? ".");
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
  if (f.behaviour !== void 0 && f.behaviour !== "on" && f.behaviour !== "off") {
    console.error(`verify-probe: --behaviour must be on or off, got '${f.behaviour}'
${USAGE}`);
    return 2;
  }
  if (f.behaviour !== void 0 && f.check) {
    console.error(`verify-probe: --behaviour does not apply to --check
${USAGE}`);
    return 2;
  }
  const behaviourOn = f.behaviour !== "off";
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
    stepsSource = `--steps ${(path5.relative(process.cwd(), path5.resolve(f.steps)) || f.steps).split(path5.sep).join("/")}`;
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
    expBytes = fs5.readFileSync(f.expected);
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
  const outBase = f.out ?? (f.expected ? path5.join(path5.dirname(f.expected), path5.basename(f.expected, ".json").replace(/\.expected$/, "")) : "");
  const statusBase = f.expected ? path5.join(path5.dirname(f.expected), path5.basename(outBase)) : "";
  const expSha = expBytes ? sha256Of(expBytes) : void 0;
  const runId = f.run !== void 0 && !f.check && statusBase ? f.run : void 0;
  const endedRun = () => {
    if (runId === void 0) return false;
    const prev = readStatus(statusBase);
    if (!prev || prev === "v1" || prev.runId !== runId || !TERMINAL_PHASES.includes(prev.phase)) return false;
    console.error(`verify-probe: run ${runId} already ended at ${prev.phase}${prev.detail ? ` (${prev.detail})` : ""} \u2014 start a new run with --new-run`);
    return true;
  };
  if (endedRun()) return 2;
  let endedMeanwhile = false;
  const status = (w) => {
    try {
      writeStatus(statusBase, w);
      return true;
    } catch (e) {
      if (e instanceof RunEnded) {
        endedMeanwhile = true;
        console.error(`warning  ${e.message} \u2014 it ended while this probe ran; its status is left as it is`);
        return true;
      }
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
  const browserPath = f["browser-path"];
  if (browserPath !== void 0) {
    const bad = browserPathError(browserPath);
    if (bad !== null) return ended(rendererUnavailable(bad, null));
  }
  const res = resolvePlaywright(project);
  if (!res.ok) return ended(rendererUnavailable(res.reason, res.hint));
  const measuringRecorded = runId !== void 0 && status({ runId, phase: "measuring", by: "verify-probe", detail: `verify-probe measuring ${f.url ?? ""}`, ...expSha ? { expectationSha256: expSha } : {} });
  if (endedMeanwhile) return 2;
  if (measuringRecorded) console.error(`status ${shellArg(liveStatusFile(statusBase))}`);
  const held = {};
  let timer;
  const runDeadline = Date.now() + maxTime;
  const watchdog = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), maxTime);
  });
  const work = (async () => {
    const launched = await launch(res, project, browserPath);
    if ("error" in launched) return rendererUnavailable(launched.error, launched.hint);
    const browser = launched.browser;
    held.browser = browser;
    const identity2 = { name: "verify-probe", version: probeVersion(), sha256: selfSha256(), playwright: { package: res.pkg, version: res.version }, browser: { name: "chromium", version: browser.version(), ...browserPath !== void 0 ? { executable: "custom" } : {} } };
    const browserLine = `chromium ${identity2.browser.version}${browserPath !== void 0 ? ` (--browser-path ${browserPath})` : ""}`;
    if (f.check || !expectation || !expBytes || !f.expected || !f.url) {
      await browser.close();
      console.log(`ok  ${res.pkg} ${res.version} (from ${path5.relative(project, res.file) || res.file}) \xB7 ${browserLine} \xB7 verify-probe ${identity2.version ?? "?"} (sha ${identity2.sha256.slice(0, 12)}\u2026)`);
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
    let wedged = false;
    const rows = run2.kind === "ok" ? drivable(expectation) : [];
    if (rows.length) {
      try {
        const driveMs = driveBudget(Date.now(), runDeadline);
        const hung = /* @__PURE__ */ Symbol("drive hung");
        const hungAt = Math.max(0, Math.min(driveMs + CUT_SETTLE_MS2 + 1e3, runDeadline - Date.now() - PS_CAP_MS - WRITE_MARGIN_MS));
        const r2 = await Promise.race([driveInteractions(browser, {
          rows,
          viewport,
          timeout,
          initScript: INIT_SCRIPT,
          budgetMs: driveMs,
          reach: async (page) => {
            await reachPage(page, attachNavLog(page), probeOpts);
          }
        }), sleep4(hungAt, hung, { ref: false })]);
        if (r2 === hung) {
          wedged = true;
          driveNote2 = "driving the interactions did not finish within its budget (the browser stopped answering) \u2014 none recorded";
        } else driven2 = r2;
      } catch (e) {
        driveNote2 = `driving the interactions failed (${errMsg(e).split("\n")[0]}) \u2014 none recorded`;
      }
    }
    let prep2 = { ok: false, why: "not measured" };
    if (run2.kind === "ok") {
      try {
        prep2 = prepareVisual(expectation, referenceRoot(f.expected, project));
      } catch (e) {
        prep2 = { ok: false, why: `the reference could not be read (${errMsg(e).split("\n")[0]})` };
      }
    }
    const visualAt = Date.now();
    let visualCap2 = { why: prep2.ok ? "not captured" : prep2.why };
    if (run2.kind === "ok" && prep2.ok) {
      const fr0 = run2.result.frames[0];
      if (wedged) visualCap2 = { why: "the browser stopped answering while the interactions were driven" };
      else {
        visualCap2 = await captureVisual(browser, {
          ref: prep2.ref,
          frame: fr0 ? { nodeId: fr0.nodeId, selector: fr0.selector, via: fr0.via, rect: fr0.rect } : null,
          frameSize: prep2.frameSize,
          nodes: run2.result.nodes,
          viewport,
          timeout,
          initScript: INIT_SCRIPT,
          reach: async (page) => {
            await reachPage(page, attachNavLog(page), probeOpts);
          },
          budgetMs: visualBudget(Date.now(), runDeadline)
        });
      }
    }
    const captureMs2 = Date.now() - visualAt;
    let behaviour2 = { version: 1, ran: false, why: "--behaviour off" };
    let forcedPng2 = null;
    if (wedged && behaviourOn) behaviour2 = { version: 1, ran: false, why: "the browser stopped answering while the interactions were driven" };
    else if (run2.kind === "ok" && behaviourOn) {
      const budgetMs = behaviourBudget(Date.now(), runDeadline);
      if (budgetMs <= 0) behaviour2 = { version: 1, ran: false, why: "no time left within --max-time after measuring and driving" };
      else {
        try {
          const axe = resolveAxe(project);
          const r2 = await runBehaviour(browser, {
            expectation,
            driven: driven2,
            viewport,
            timeout,
            initScript: INIT_SCRIPT,
            budgetMs,
            measuredTags: run2.result.visibleTags,
            reach: async (page) => {
              await reachPage(page, attachNavLog(page), probeOpts);
            },
            axe: axe.ok ? { source: axe.source, version: axe.version } : { why: axe.why },
            forcedPng: (outBase + ".forced-colors.png").split(path5.sep).join("/")
          });
          behaviour2 = r2.behaviour;
          forcedPng2 = r2.forcedPng;
        } catch (e) {
          behaviour2 = { version: 1, ran: false, why: `the behaviour checks failed (${errMsg(e).split("\n")[0]})` };
        }
      }
    }
    if (wedged) {
      killBrowserChildren();
      await Promise.race([browser.close().catch(() => void 0), sleep4(1e3, void 0, { ref: false })]);
    } else await closeCapped(browser);
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
    return { run: run2, identity: identity2, driven: driven2, driveNote: driveNote2, behaviour: behaviour2, forcedPng: forcedPng2, prep: prep2, visualCap: visualCap2, captureMs: captureMs2 };
  })().catch(async (e) => {
    const b = held.browser;
    if (b && !held.timedOut) await closeCapped(b);
    throw e;
  });
  const first = await Promise.race([work, watchdog]).finally(() => clearTimeout(timer));
  if (first === "timeout") {
    held.timedOut = true;
    work.catch(() => void 0);
    const b = held.browser;
    if (b) await closeCapped(b);
    console.error(`verify-probe: timed out after ${maxTime / 1e3}s (--max-time) \u2014 the browser was closed, nothing written.
  a page that never settles (a script that does not yield, a request that never ends): re-run the probe once; if it times out again, report it (status failed).`);
    return ended(4);
  }
  if (typeof first === "number") return ended(first);
  const { run, identity, driven, driveNote, behaviour, forcedPng, prep, visualCap, captureMs } = first;
  if (!expectation || !expBytes || !f.expected || !f.url) return 2;
  const png = outBase + ".png";
  const r = run.result;
  const frameOut = (fr) => ({ nodeId: fr.nodeId, selector: fr.selector, via: fr.via, rect: fr.rect });
  const firstFrame = r.frames[0];
  const diffPath = outBase + ".diff.png";
  let visual = { version: 1, ran: false, why: prep.ok ? "not captured" : prep.why };
  let diffPng = null;
  if (prep.ok) ({ visual, diffPng } = finishVisual({ expectation, prep, capture: visualCap, diffPath: diffPath.split(path5.sep).join("/"), captureMs }));
  try {
    if (diffPng !== null) writeFileAtomic(diffPath, diffPng);
    else if (fs5.existsSync(diffPath)) fs5.rmSync(diffPath, { force: true });
  } catch (e) {
    console.error(`warning  ${diffPath}: ${errMsg(e).split("\n")[0]} \u2014 the visual diff image is not written`);
    if (visual.ran) visual = { ...visual, diff: null, notes: [...visual.notes, `the diff image could not be written (${errMsg(e).split("\n")[0]})`] };
  }
  const measured = {
    measuredAt: (/* @__PURE__ */ new Date()).toISOString(),
    renderer: "playwright-chromium",
    viewport: `${viewport.w}x${viewport.h}`,
    artifacts: [png.split(path5.sep).join("/")],
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
    ...driven ? { interactions: driven } : {},
    behaviour,
    visual
  };
  const allNotes = [...notes, ...r.notes, ...driveNote !== null ? [driveNote] : []];
  const measuredText = JSON.stringify(allNotes.length ? { ...measured, notes: allNotes } : measured, null, 2) + "\n";
  if (endedRun()) return 2;
  writeFileAtomic(png, r.png);
  const forcedPath = outBase + ".forced-colors.png";
  try {
    if (forcedPng !== null) writeFileAtomic(forcedPath, forcedPng);
    else if (fs5.existsSync(forcedPath)) fs5.rmSync(forcedPath, { force: true });
  } catch (e) {
    console.error(`warning  ${forcedPath}: ${errMsg(e).split("\n")[0]} \u2014 the behaviour screenshot is not written`);
  }
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
  console.error(behaviourLine(behaviour));
  console.error(visualLine(visual));
  for (const n of allNotes) console.error(`note  ${n}`);
  console.error(`probe verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}\u2026) \xB7 ${res.pkg} ${res.version} \xB7 chromium ${identity.browser.version}${browserPath !== void 0 ? ` (--browser-path ${browserPath})` : ""}`);
  if (statusRefused && runId !== void 0) {
    const outDir = path5.resolve(path5.dirname(outBase)), verifyDir = path5.resolve(path5.dirname(statusBase));
    const findable = outDir === verifyDir || outDir === path5.resolve(stageDirOf(statusBase, runId));
    console.error(`warning  ${outBase}.measured.json is written, but the run cache refused the probe's \`measured\` status write for run ${runId}` + (measuringRecorded ? " \u2014 the live status still says measuring, so --compare reports the run incomplete" : " (its `measuring` write was refused too) \u2014 no live status of the run exists, so --compare will report the run as unrecorded") + `. Record it, from where the run cache takes writes, with: ${scriptCmd("verify-screen")} --status ${shellArg(path5.basename(statusBase))} --phase measured --run ${runId} --dir ${shellArg(verifyDir)}` + (findable ? "" : ` \u2014 after moving ${outBase}.measured.json to ${statusBase}.measured.json (it reads the verify dir or the run's stage dir)`));
  }
  if (endedMeanwhile) return 2;
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
  INIT_SCRIPT,
  LAUNCH_ARGS,
  PLAYWRIGHT_PACKAGES,
  behaviourLine,
  browserPathError,
  buildFrom,
  closeCapped,
  errorKind,
  foreignTags,
  installHint,
  isNavigationAway,
  isPlaywrightModule,
  linkHref,
  loadFailureWhy,
  main,
  projectRequire,
  resolveAxe,
  resolvePlaywright,
  runProbe
};
/*! visual-diff.ts — colorDelta, antialiased and hasManySiblings are a port of pixelmatch v6.0.0 (index.js,
 * https://github.com/mapbox/pixelmatch/tree/v6.0.0), under its licence:
 *
 * ISC License
 *
 * Copyright (c) 2024, Mapbox
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 *
 * The colour metric is from Y. Kotsarenko and F. Ramos, "Measuring perceived color difference using YIQ NTSC
 * transmission color space in mobile applications" (2010); the anti-aliasing detector from V. Vysniauskas,
 * "Anti-aliased Pixel and Intensity Slope Detector" (2009).
 */
