// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/verify-probe.ts
import fs3 from "node:fs";
import path2 from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { parseArgs as parseArgs2 } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

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
          put(k, i === -1 ? null : rgba(cs.getPropertyValue(`border-${["top", "right", "bottom", "left"][i]}-color`)), "no border (border-width 0 on every side) \u2014 a ring/box-shadow/outline is not read as a border");
          break;
        }
        case "borderWidth": {
          const ws = sides((s) => `border-${s}-width`).filter((w) => w !== null);
          put(k, ws.length ? Math.max(...ws) : null, "no computed border width");
          break;
        }
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
function focusablePath(path3) {
  const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex], [contenteditable]";
  const el = document.querySelector(path3);
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
function focusInfo(path3) {
  const el = document.querySelector(path3);
  const focused = !!el && document.activeElement === el;
  return { focused, focusVisible: focused && !!el && el.matches(":focus-visible") };
}

// design-to-code/probe-match.ts
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
    ...match.matchedBy === "position" ? { note: "matched by position (\xB12px) \u2014 low confidence; tag it with data-dt-node" } : {}
  };
}
function census(nodes, notMeasured) {
  const c = { tag: 0, sharedPath: 0, text: 0, textOrdinal: 0, position: 0, frame: 0, notMeasured: notMeasured.length };
  const KEY = { tag: "tag", "tag-shared-path": "sharedPath", text: "text", "text-ordinal": "textOrdinal", position: "position", frame: "frame" };
  const isMatchedBy = (v) => v !== void 0 && Object.hasOwn(KEY, v);
  for (const n of nodes) if (isMatchedBy(n.matchedBy)) c[KEY[n.matchedBy]]++;
  return c;
}

// bridge/src/json-util.ts
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
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
var isProbeFrame = (x) => isObj(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isObj(x.rect);
var isCountMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isObj(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isReasonMap = (x) => isObj(x) && Object.values(x).every((v) => typeof v === "string");
var MEASURED_EXTRAS = [
  ["probe", isProbeIdentity, "the shipped probe's identity {name, version, sha256, playwright:{package, version}, browser:{name, version}} \u2014 read as probe: unknown"],
  ["frame", isProbeFrame, "a probe frame {nodeId, selector, via, rect}"],
  ["frames", (x) => Array.isArray(x) && x.every(isProbeFrame), "a list of probe frames {nodeId, selector, via, rect}"],
  ["navigation", isNavigation, "a navigation log {events[], afterInitialLoad, reruns}"],
  ["matchedByCensus", isCountMap, "a {rule: count} map"],
  ["notMeasured", Array.isArray, "a list \u2014 the probe's reasons for unmatched nodes are not used"]
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
  return isObj(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "deviations", "allowedLiterals"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isObj(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isObj(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden"]) {
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
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
function isStringRecord(x) {
  return isObj(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// design-to-code/cli-args.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
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
import fs2 from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs2.realpathSync(argv1) === fs2.realpathSync(fileURLToPath2(metaUrl));
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
  opacity: 0.02
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
  { key: "borderWidth", tol: TOLERANCE.padding, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px", box: true },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px", box: true },
  { key: "x", tol: TOLERANCE.position, label: "x (frame-relative)", unit: "px", box: true },
  { key: "y", tol: TOLERANCE.position, label: "y (frame-relative)", unit: "px", box: true },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" }
];
var STYLE_KEYS = [...FIELDS.map((f) => f.key), "padding", "gapVisual", "text", "tag", "textBox", "placeholderText"];
var STYLE_KEY_SHAPE = {
  borderRadius: "number | [tl,tr,br,bl]",
  padding: "[t,r,b,l]",
  fill: "an SVG's paint",
  textBox: "{x,w} of a Range over the text",
  placeholderText: "el.placeholder",
  placeholderColor: "the ::placeholder colour",
  tag: "tagName, lower-case"
};
var MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  // GENERATED from STYLE_KEYS, so the list a probe is told to send cannot drift from the list compared (DT-23: `fill` was missing)
  "nodes[].styles": `computed values, EVERY key on every node \u2014 lengths as px numbers (a "20px" string is read as 20; %, other units and keywords are not) \u2014 (null when it cannot be read, with the reason under unmeasured): ${STYLE_KEYS.map((k) => k + (STYLE_KEY_SHAPE[k] ? ` (${STYLE_KEY_SHAPE[k]})` : "")).join(" ")}`,
  "nodes[].unmeasured": "{<styles key>: why} for every styles key reported null \u2014 a null is listed as not measured, never as checked",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required when the id sits on a padded container (<th>, <button>, <label>)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state \u2014 required for a node whose spec has drawnState",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} \u2014 `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} \u2014 present:false is an explicit claim of absence",
  "notMeasured[]": "{nodeId, why} for every spec the probe could not find \u2014 the one top-level key for it (not notFound/notFoundInDom); other unknown top-level keys are listed in the report",
  "expectationSha256": "sha256 of the .expected.json you measured against"
};
if (false) process.exitCode = main(process.argv.slice(2));

// design-to-code/verify-probe.ts
var PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];
function isPlaywrightModule(x) {
  if (typeof x !== "object" || x === null || !("chromium" in x)) return false;
  const c = x.chromium;
  return typeof c === "object" && c !== null && "launch" in c && typeof c.launch === "function";
}
function installHint(dir) {
  const has = (f) => fs3.existsSync(path2.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm add -D playwright && pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn add -D playwright && yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bun add -d playwright && bunx playwright install chromium";
  return "npm i -D playwright && npx playwright install chromium";
}
function browserHint(dir) {
  const has = (f) => fs3.existsSync(path2.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bunx playwright install chromium";
  return "npx playwright install chromium";
}
function resolvePlaywright(dir) {
  const abs = path2.resolve(dir);
  const req = createRequire(path2.join(abs, "package.json"));
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
  const pnp = fs3.existsSync(path2.join(abs, ".pnp.cjs")) ? " \u2014 this project uses Yarn Plug'n'Play: retry the probe as `yarn node <this script> \u2026`" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path2.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
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
  for (const p of [path2.join(path2.dirname(SELF2), "..", ".claude-plugin", "plugin.json"), path2.join(path2.dirname(SELF2), "..", "claude-plugin", ".claude-plugin", "plugin.json")]) {
    const doc = readJsonOrNull(p, isJsonObject);
    if (doc && typeof doc.version === "string") return doc.version;
  }
  return null;
}
var selfSha256 = () => crypto.createHash("sha256").update(fs3.readFileSync(SELF2)).digest("hex");
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
var BrowserGoneError = class extends Error {
};
var gone = (e) => new BrowserGoneError(`the browser closed or crashed during measurement (${errMsg(e).split("\n")[0]})`);
var KeptNavigatingError = class extends Error {
};
var UnreachableError = class extends Error {
};
async function settle(page, log, ready, timeout) {
  const cap = Math.min(QUIET_CAP_MS, timeout);
  const deadline = Date.now() + cap;
  const navAtStart = log.navs;
  const kept = () => new KeptNavigatingError(`the page kept navigating for ${Math.round(cap / 1e3)}s after load (${log.navs - navAtStart} navigation(s)) and never settled`);
  for (; ; ) {
    try {
      await page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      if (ready) await page.locator(ready).first().waitFor({ state: "visible", timeout: log.navs === navAtStart ? timeout : Math.max(1, deadline - Date.now()) });
    } catch (e) {
      if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
      if (log.navs !== navAtStart && Date.now() < deadline) {
        await sleep(POLL_MS);
        continue;
      }
      if (log.navs !== navAtStart) throw kept();
      if (errorKind(errMsg(e), false) === "navigated" && Date.now() < deadline) {
        await sleep(POLL_MS);
        continue;
      }
      throw new UnreachableError(ready ? `--ready '${ready}' never became visible: ${errMsg(e).split("\n")[0]}` : errMsg(e).split("\n")[0]);
    }
    const mark = log.navs;
    let last = "", since = Date.now();
    for (; ; ) {
      await sleep(POLL_MS);
      if (log.navs !== mark) {
        await page.waitForLoadState("load", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => void 0);
        if (Date.now() >= deadline) throw kept();
        break;
      }
      let sig;
      try {
        const v = await page.evaluate("[document.getElementsByTagName('*').length, (document.body && document.body.textContent || '').length].join(':')");
        sig = String(v);
      } catch (e) {
        if (errorKind(errMsg(e), page.isClosed()) === "gone") throw gone(e);
        if (errorKind(errMsg(e), false) !== "navigated") throw e;
        if (Date.now() >= deadline) throw kept();
        continue;
      }
      if (sig !== last) {
        last = sig;
        since = Date.now();
      }
      if (Date.now() - since >= QUIET_MS) return null;
      if (Date.now() >= deadline) {
        if (log.navs !== navAtStart) throw kept();
        return `the DOM was still changing after ${Math.round(cap / 1e3)}s (no navigation) \u2014 measured anyway`;
      }
    }
  }
}
var raf2 = (page) => page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))");
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
  log.gotos++;
  try {
    await page.goto(o.url, { waitUntil: "load", timeout: o.timeout });
  } catch (e) {
    if (!/interrupted by another navigation/i.test(errMsg(e))) throw new UnreachableError(`could not load ${o.url}: ${errMsg(e).split("\n")[0]}`);
  }
  const settleNote = await settle(page, log, o.ready, o.timeout);
  try {
    const token = await docToken(page);
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
        await raf2(page);
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
    if (matches.some(({ spec }) => spec.drawnState === "hover")) await raf2(page);
    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    if (await docToken(page) !== token) throw new NavigatedError("the page loaded a new document during measurement");
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
      notes
    };
  } catch (e) {
    if (e instanceof NavigatedError || e instanceof UnreachableError || e instanceof BrowserGoneError) throw e;
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
async function runProbe(browser, o) {
  const context = await browser.newContext({ viewport: { width: o.viewport.w, height: o.viewport.h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript({ content: INIT_SCRIPT });
  const log = { events: [], navs: 0, gotos: 0, t0: Date.now() };
  const consoleErrors = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      log.navs++;
      log.events.push({ type: "framenavigated", url: f.url(), at: Date.now() - log.t0 });
    }
  });
  page.on("load", () => {
    log.events.push({ type: "load", url: page.url(), at: Date.now() - log.t0 });
  });
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
        const result = await pass(page, log, o);
        return { kind: "ok", result, navigation: nav(reruns), consoleErrors };
      } catch (e) {
        if (e instanceof BrowserGoneError) return { kind: "browser-gone", why: e.message, navigation: nav(reruns) };
        if (e instanceof KeptNavigatingError) return { kind: "navigation", why: e.message, navigation: nav(reruns) };
        if (!(e instanceof NavigatedError)) throw e;
        if (reruns >= 1) return { kind: "navigation", why: `the page reloaded during measurement twice (${e.message})`, navigation: nav(reruns) };
        reruns++;
      }
    }
  } finally {
    await context.close().catch(() => void 0);
  }
}
var USAGE = `usage:
  ${scriptCmd("verify-probe")} --expected design/verify/<Screen>.expected.json --url <url> [--out design/verify/<Screen>]
      [--ready <selector>] [--viewport WxH] [--project <dir>] [--position] [--timeout <ms>]
      renders <url> in the PROJECT's Playwright (chromium), matches every expectation row (tag \u2192 shared path \u2192
      text \u2192 text-ordinal \u2192 --position), and writes <out>.measured.json + <out>.png for verify-screen --compare.
      --out defaults to the .expected.json path minus \`.expected\`; --viewport to the frame's w\xD7h; --project to cwd.
  ${scriptCmd("verify-probe")} --check [--project <dir>]
      resolves the project's Playwright and launches chromium once \u2014 nothing measured, nothing written.
exit: 0 wrote \xB7 2 usage \xB7 3 renderer unavailable (ask the user to install; never installed here) \xB7 4 the page kept
      navigating / reloaded twice during measurement / was unreachable / timed out (nothing written).`;
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
    help: { type: "boolean", short: "h" }
  };
  const { values: f } = cliParse("verify-probe", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: false }));
  const project = path2.resolve(f.project ?? ".");
  const timeout = f.timeout === void 0 ? 3e4 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error(`verify-probe: --timeout must be a positive number of milliseconds
${USAGE}`);
    return 2;
  }
  if (!f.check) {
    if (!f.expected || !f.url) {
      console.error(`verify-probe: --expected and --url are both required
${USAGE}`);
      return 2;
    }
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
    expBytes = fs3.readFileSync(f.expected);
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
  const res = resolvePlaywright(project);
  if (!res.ok) return rendererUnavailable(res.reason, res.hint);
  const launched = await launch(res, project);
  if ("error" in launched) return rendererUnavailable(launched.error, launched.hint);
  const browser = launched.browser;
  const identity = { name: "verify-probe", version: probeVersion(), sha256: selfSha256(), playwright: { package: res.pkg, version: res.version }, browser: { name: "chromium", version: browser.version() } };
  if (f.check || !expectation || !expBytes || !f.expected || !f.url) {
    await browser.close();
    console.log(`ok  ${res.pkg} ${res.version} (from ${path2.relative(project, res.file) || res.file}) \xB7 chromium ${identity.browser.version} \xB7 verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}\u2026)`);
    return 0;
  }
  let run;
  try {
    run = await runProbe(browser, { expectation, url: f.url, ...f.ready !== void 0 ? { ready: f.ready } : {}, viewport, position: !!f.position, timeout });
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
  await browser.close().catch(() => void 0);
  if (run.kind === "browser-gone") {
    console.error(`verify-probe: ${run.why} \u2014 nothing written. This is not a page reload: re-run the probe; if it recurs, run --check.`);
    return 4;
  }
  if (run.kind === "navigation") {
    console.error(`verify-probe: ${run.why} \u2014 nothing written.
  the page reloaded during measurement: move writes out of the dev-server watch tree (see verify.md), or serve a production build.
  navigation log:
` + run.navigation.events.map((ev) => `    +${ev.at}ms ${ev.type} ${ev.url}`).join("\n"));
    return 4;
  }
  const outBase = f.out ?? path2.join(path2.dirname(f.expected), path2.basename(f.expected, ".json").replace(/\.expected$/, ""));
  const png = outBase + ".png";
  const r = run.result;
  const frameOut = (fr) => ({ nodeId: fr.nodeId, selector: fr.selector, via: fr.via, rect: fr.rect });
  const firstFrame = r.frames[0];
  const measured = {
    measuredAt: (/* @__PURE__ */ new Date()).toISOString(),
    renderer: "playwright-chromium",
    viewport: `${viewport.w}x${viewport.h}`,
    artifacts: [png.split(path2.sep).join("/")],
    expectationSha256: crypto.createHash("sha256").update(expBytes).digest("hex"),
    probe: identity,
    ...firstFrame ? { frame: frameOut(firstFrame) } : {},
    ...r.frames.length > 1 ? { frames: r.frames.map(frameOut) } : {},
    navigation: run.navigation,
    matchedByCensus: { ...census(r.nodes, r.notMeasured) },
    nodes: r.nodes,
    notMeasured: r.notMeasured,
    components: r.components,
    ...run.consoleErrors.length ? { consoleErrors: run.consoleErrors } : {}
  };
  const allNotes = [...notes, ...r.notes];
  fs3.mkdirSync(path2.dirname(path2.resolve(outBase)), { recursive: true });
  fs3.writeFileSync(outBase + ".measured.json", JSON.stringify(allNotes.length ? { ...measured, notes: allNotes } : measured, null, 2) + "\n");
  fs3.writeFileSync(png, r.png);
  const c = census(r.nodes, r.notMeasured);
  console.error(`wrote ${outBase}.measured.json and ${png}`);
  console.error(`measured ${r.nodes.length} of ${r.nodes.length + r.notMeasured.length} spec(s) \u2014 tag ${c.tag} \xB7 shared path ${c.sharedPath} \xB7 text ${c.text} \xB7 ordinal ${c.textOrdinal} \xB7 position ${c.position} \xB7 frame ${c.frame} \xB7 not measured ${c.notMeasured} \xB7 frame root via ${firstFrame ? firstFrame.via : "none"} \xB7 navigations after load ${run.navigation.afterInitialLoad}, re-runs ${run.navigation.reruns}`);
  for (const n of allNotes) console.error(`note  ${n}`);
  console.error(`probe verify-probe ${identity.version ?? "?"} (sha ${identity.sha256.slice(0, 12)}\u2026) \xB7 ${res.pkg} ${res.version} \xB7 chromium ${identity.browser.version}`);
  console.error(`next  ${scriptCmd("verify-screen")} --compare ${f.expected} ${outBase}.measured.json --out ${outBase}`);
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
  PLAYWRIGHT_PACKAGES,
  errorKind,
  installHint,
  isPlaywrightModule,
  main,
  resolvePlaywright,
  runProbe
};
