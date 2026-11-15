// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/capture-page.ts
import fs6 from "node:fs";
import path5 from "node:path";
import { parseArgs as parseArgs2 } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

// design-to-code/probe-browser.ts
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// design-to-code/page-runtime.ts
function installPageRuntime() {
  const parent = (n) => n.assignedSlot ?? n.parentElement ?? (n.getRootNode ? n.getRootNode()?.host ?? null : null);
  const paths = () => {
    const memo = /* @__PURE__ */ new Map();
    const childIndex = /* @__PURE__ */ new Map();
    const indexIn = (owner, list, el) => {
      let idx = childIndex.get(owner);
      if (!idx) {
        const m = /* @__PURE__ */ new Map();
        Array.from(list).forEach((c, i) => m.set(c, i + 1));
        childIndex.set(owner, m);
        idx = m;
      }
      return idx.get(el) ?? 0;
    };
    return (el) => {
      const up = [];
      let cur = el;
      let base = memo.get(cur);
      while (base === void 0) {
        const host = cur.parentElement ? null : cur.getRootNode?.()?.host ?? null;
        if (cur === document.documentElement || !cur.parentElement && !host) {
          base = "html";
          memo.set(cur, base);
          break;
        }
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
  const find = (path6) => {
    const steps = /^html((?: > | )[^\s>]+:nth-child\(\d+\))*$/.test(path6) ? Array.from(path6.slice(4).matchAll(/( > | )([^\s>]+):nth-child\((\d+)\)/g)) : null;
    if (steps === null) {
      try {
        return document.querySelector(path6);
      } catch {
        return null;
      }
    }
    let cur = document.documentElement;
    for (const [, sep, tag, n] of steps) {
      if (!cur) return null;
      const list = sep === " > " ? cur.children : cur.shadowRoot?.children;
      const next = list ? list[Number(n) - 1] : void 0;
      cur = next && next.tagName.toLowerCase() === tag ? next : null;
    }
    return cur;
  };
  const controlText = (e) => {
    const tag = e.tagName.toLowerCase();
    if (tag === "textarea") return { text: e.value ?? "" };
    if (tag === "select") {
      if (e.multiple || (e.size ?? 0) > 1) return { why: "a list-box <select> (multiple, or size > 1) shows every option, not one string" };
      const o = e.selectedOptions?.[0];
      return { text: o ? o.label ?? o.text ?? o.textContent ?? "" : "" };
    }
    if (tag !== "input") return null;
    const type = (e.type || "text").toLowerCase();
    if (/^(text|search|email|url|tel|number)$/.test(type)) return { text: e.value ?? "" };
    if (/^(button|submit|reset)$/.test(type) && e.value) return { text: e.value };
    return { why: `an <input type="${type}"> draws its own text \u2014 its value is not the string shown` };
  };
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue || "").join("");
  const keepsBreaks = (e) => {
    const s = getComputedStyle(e);
    const c = s.getPropertyValue("white-space-collapse").trim();
    if (c) return c === "preserve" || c === "preserve-breaks" || c === "break-spaces";
    return /^(pre|pre-wrap|pre-line|break-spaces)$/.test(s.getPropertyValue("white-space").trim());
  };
  const shownText = (root, lines = true) => {
    let out = "";
    const walk = (e) => {
      let keep = null;
      let k = 0;
      for (const n of Array.from(e.childNodes)) {
        if (n.nodeType === 3) {
          const v = n.nodeValue || "";
          if (!/[\n\r]/.test(v)) {
            out += v;
            continue;
          }
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
  const visible = (el, o = {}) => {
    if (el.getClientRects().length === 0) return false;
    if (o.sized) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
    }
    const op = !!o.opacity;
    return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true, opacityProperty: op, checkOpacity: op });
  };
  const viewport = () => {
    const de = document.documentElement;
    return { w: Math.min(de.clientWidth || innerWidth, innerWidth), h: Math.min(de.clientHeight || innerHeight, innerHeight) };
  };
  const clickPoint = (el) => {
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
  const hitAt = (x, y) => {
    let hit = document.elementFromPoint(x, y), from = hit;
    for (let i = 0; hit && hit.shadowRoot && i < 32; i++) {
      const host = hit, sr = hit.shadowRoot;
      const deeper = sr.elementFromPoint ? sr.elementFromPoint(x, y) : null;
      let under = false;
      for (let p = deeper; p; p = parent(p)) if (p === host) {
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
        return Array.from(rg.getClientRects()).some((q) => x >= q.x && x <= q.right && y >= q.y && y <= q.bottom);
      });
      from = slotted && slotted.assignedSlot ? slotted.assignedSlot : host;
      break;
    }
    return from;
  };
  const within2 = (el, anc) => {
    for (let p = el; p; p = parent(p)) if (p === anc) return true;
    return false;
  };
  const samplePoints = (rect, o) => {
    const l = rect.x + o.inset, r = rect.x + rect.width - o.inset, t = rect.y + o.inset, b = rect.y + rect.height - o.inset;
    if (r < l || b < t) return [];
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    const ring = [[l, t], [r, t], [l, b], [r, b], [cx, t], [r, cy], [cx, b], [l, cy]];
    const all = o.order === "centre" ? [[cx, cy], ...ring] : [...ring, [cx, cy]];
    const { w: vw, h: vh } = viewport();
    return all.filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh);
  };
  const active = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const tagSel = (id) => `[data-dt-node="${id.replace(/["\\]/g, "\\$&")}"]`;
  const tagged = (id) => {
    const els = Array.from(document.querySelectorAll(tagSel(id))).filter((e) => e.closest("dialog:not([open])") === null);
    return els.length > 1 ? els.filter((e) => e.getClientRects().length > 0) : els;
  };
  const BARE = /* @__PURE__ */ new Set(["readonly", "disabled", "hidden", "open", "required"]);
  const describe = (el, keys = [], name = false) => {
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
  const ownContent = (box, ctl) => {
    const up = parent;
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
        for (let p = e; p && p !== box; p = up(p)) {
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
      while (p && css(p, "display") === "contents") p = up(p);
      return p;
    };
    const shown = (e) => {
      const b = boxed(e);
      return !!b && b.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) && !/^(hidden|collapse)$/.test(css(e, "visibility")) && !faded(b);
    };
    const holdsFixed = (p) => ["transform", "translate", "rotate", "scale", "perspective", "filter", "backdrop-filter"].some((k) => set(p, k)) || css(p, "transform-style") === "preserve-3d" || /\b(transform|translate|rotate|scale|perspective|filter|backdrop-filter)\b/.test(css(p, "will-change")) || /\b(layout|paint|strict|content)\b/.test(css(p, "contain")) || /^(auto|hidden)$/.test(css(p, "content-visibility"));
    const de = document.documentElement;
    const horizontal = !/^(vertical|sideways)/.test(css(de, "writing-mode"));
    let sx = scrollX, sy = scrollY;
    for (let p = box; p && p !== de; p = up(p)) {
      sx += Math.abs(p.scrollLeft || 0);
      sy += Math.abs(p.scrollTop || 0);
    }
    const startX = horizontal && css(de, "direction") !== "rtl" ? -sx : -Infinity, startY = horizontal ? -sy : -Infinity;
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
          const [t = "0", r = t, b = t, l = r] = (ins[1] ?? "").split(/\s+round\s+/)[0]?.trim().split(/\s+/) ?? [];
          const len = (s, size2) => s.endsWith("%") ? parseFloat(s) / 100 * size2 : parseFloat(s);
          const T = len(t, pr.height), R = len(r, pr.width), B = len(b, pr.height), L = len(l, pr.width);
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
      const r = e.getBoundingClientRect();
      return mx >= r.x && mx <= r.right && my >= r.y && my <= r.bottom;
    };
    const clear = (v) => v === "" || /^(transparent|rgba\(.*,\s*0\)|.*\/\s*0\))$/.test(v);
    for (const e of els) {
      if (inCtl(e) || !shown(e)) continue;
      if (/^(IMG|SVG|CANVAS|VIDEO|AUDIO|PICTURE|OBJECT|EMBED|IFRAME|INPUT|PROGRESS|METER)$/.test(e.tagName.toUpperCase()) && area(e, e.getBoundingClientRect()) > 1) return `<${e.tagName.toLowerCase()}>`;
      const host = boxed(e) ?? e;
      for (const ps of ["::before", "::after"]) {
        const c = css(e, "content", ps);
        if (!c || c === "none" || c === "normal" || css(e, "display", ps) === "none" || /^(hidden|collapse)$/.test(css(e, "visibility", ps)) || css(e, "opacity", ps) === "0" && outOfFlow(e, ps)) continue;
        const str3 = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        const s = str3 ? str3[1] ?? "" : null;
        const fill = !clear(css(e, "background-color", ps));
        const paints = s === null || /\S/.test(s) || set(e, "background-image", ps) || set(e, "mask-image", ps) || fill && (s !== "" || !chrome(host));
        if (paints && area(host, host.getBoundingClientRect()) > 1) return `${ps} content`;
      }
      if (/list-item/.test(css(e, "display")) && (!/^(none)?$/.test(css(e, "list-style-type")) || set(e, "list-style-image") || !/^(normal|none)?$/.test(css(e, "content", "::marker"))) && area(e, e.getBoundingClientRect()) > 1) return "a list marker";
      if ((!/^(visible|clip)$/.test(css(e, "overflow-x")) || !/^(visible|clip)$/.test(css(e, "overflow-y"))) && !/^(none|normal)?$/.test(css(e, "content", "::scroll-button(*)")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll button";
      if (!/^(none)?$/.test(css(e, "scroll-marker-group")) && area(e, e.getBoundingClientRect()) > 1) return "a scroll-marker group";
      if (e === box) {
        if (/\b(url|image|image-set|cross-fade|element|paint|[a-z-]*gradient)\(/i.test(css(e, "background-image"))) return "its own background image";
        if (set(e, "border-image-source")) return "its own border image";
        const sides2 = ["top", "right", "bottom", "left"].map((k) => ({ w: /^(none|hidden)$/.test(css(e, `border-${k}-style`)) ? 0 : parseFloat(css(e, `border-${k}-width`)) || 0, c: css(e, `border-${k}-color`) }));
        const painted = sides2.filter((d) => d.w > 0 && !clear(d.c));
        if (new Set(painted.map((d) => d.c)).size > 1) return "its own border in more than one colour";
        const ws = sides2.map((d) => d.w > 0 && !clear(d.c) ? d.w : 0);
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
    const gone = chain((p) => css(p, "opacity") === "0");
    const FOREIGN_CAP = 5e5;
    let walked = 0;
    const moved = (f) => {
      const s = getComputedStyle(f);
      return s.getPropertyValue("position") !== "static" || ["transform", "translate", "rotate", "scale"].some((k) => {
        const v = s.getPropertyValue(k);
        return v !== "" && v !== "none";
      });
    };
    const ftodo = [{ f: de, near: true }];
    for (let t = ftodo.pop(); t; t = ftodo.pop()) {
      if (++walked > FOREIGN_CAP) return `more than ${FOREIGN_CAP} boxes on the page to check for a label laid over it`;
      const f = t.f;
      if (f === box || tip(f)) continue;
      const isAnc = anc.has(f);
      const fr = t.near || isAnc || moved(f) ? f.getBoundingClientRect() : null;
      const near2 = isAnc || fr !== null && meets(fr);
      const sr = f.shadowRoot;
      for (const k of Array.from(f.children ?? [])) ftodo.push({ f: k, near: near2 });
      if (sr) for (const k of Array.from(sr.children)) ftodo.push({ f: k, near: near2 });
      if (!fr || !near2 || pinned(f) || !shown(f) || gone(f)) continue;
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
        const str3 = /^"([\s\S]*)"$/.exec(c) ?? /^'([\s\S]*)'$/.exec(c);
        if (!(str3 === null || /\S/.test(str3[1] ?? "") || set(f, "background-image", ps) || set(f, "mask-image", ps))) continue;
        let q = fr;
        if (pos === "absolute") {
          let cb = f;
          while (cb && css(cb, "position") === "static" && !holdsFixed(cb)) cb = up(cb);
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
  const dt = {
    parent,
    paths,
    path: (el) => paths()(el),
    find,
    controlText,
    ownText,
    shownText,
    visible,
    viewport,
    clickPoint,
    hitAt,
    within: within2,
    samplePoints,
    active,
    tagSel,
    tagged,
    describe,
    ownContent
  };
  Object.defineProperty(window, "__dt", { value: dt, configurable: true });
}
var PAGE_RUNTIME = `(${installPageRuntime.toString()})();`;
var PATH_ENGINE = "dtpath";
var PATH_ENGINE_SCRIPT = `(() => {
  const query = (root, path) => {
    const dt = window.__dt;
    let el = null;
    if (dt) el = dt.find(path);
    else { try { el = document.querySelector(path); } catch (e) { el = null; } }
    if (!el || root === document || root === document.documentElement) return el;
    for (let p = el; p; p = p.assignedSlot || p.parentElement || (p.getRootNode && p.getRootNode().host) || null) if (p === root) return el;
    return null;
  };
  return { query, queryAll: (root, path) => { const el = query(root, path); return el ? [el] : []; } };
})()`;
var pathEngine = false;
async function registerPathEngine(selectors) {
  try {
    await selectors.register(PATH_ENGINE, { content: PATH_ENGINE_SCRIPT });
    pathEngine = true;
  } catch (e) {
    if (e instanceof Error && /already registered/.test(e.message)) pathEngine = true;
  }
}
var byPath = (page, path6) => page.locator(pathEngine ? `${PATH_ENGINE}=${path6}` : path6);

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);
var firstLine = (e) => errMsg(e).split("\n")[0] ?? "";
var errCode = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/probe-browser.ts
var PLAYWRIGHT_PACKAGES = ["playwright", "@playwright/test", "playwright-core"];
function isPlaywrightModule(x) {
  if (typeof x !== "object" || x === null || !("chromium" in x)) return false;
  const c = x.chromium;
  return typeof c === "object" && c !== null && "launch" in c && typeof c.launch === "function";
}
function installHint(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm add -D playwright && pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn add -D playwright && yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bun add -d playwright && bunx playwright install chromium";
  return "npm i -D playwright && npx playwright install chromium";
}
function browserHint(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has("pnpm-lock.yaml")) return "pnpm exec playwright install chromium";
  if (has("yarn.lock")) return "yarn playwright install chromium";
  if (has("bun.lock") || has("bun.lockb")) return "bunx playwright install chromium";
  return "npx playwright install chromium";
}
function projectRequire(dir) {
  return createRequire(path.join(path.resolve(dir), "package.json"));
}
function packageDirInProject(dir, name) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkg = path.join(d, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(pkg, "package.json"))) return pkg;
    if (path.dirname(d) === d) return null;
  }
}
function installedInProject(dir, name, file) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const target = real(file) ?? path.resolve(file);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const pkg = real(path.join(d, "node_modules", ...name.split("/")));
    if (pkg !== null && (target === pkg || target.startsWith(pkg + path.sep))) return true;
    if (path.dirname(d) === d) return false;
  }
}
var notInProject = (name, file) => `${name}: resolved outside the project's node_modules (${file}) \u2014 not loaded`;
function resolvePlaywright(dir) {
  const abs = path.resolve(dir);
  const req = projectRequire(abs);
  const tried = [];
  for (const name of PLAYWRIGHT_PACKAGES) {
    if (packageDirInProject(abs, name) === null) {
      tried.push(`${name}: not installed`);
      continue;
    }
    let file;
    try {
      file = req.resolve(name);
    } catch {
      tried.push(`${name}: not installed`);
      continue;
    }
    if (!installedInProject(abs, name, file)) {
      tried.push(notInProject(name, file));
      continue;
    }
    let mod;
    try {
      mod = req(name);
    } catch (e) {
      tried.push(`${name}: failed to load (${firstLine(e)})`);
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
  const pnp = fs.existsSync(path.join(abs, ".pnp.cjs")) ? " \u2014 this project uses Yarn Plug'n'Play, which Bun cannot resolve packages through: ask the user to set `nodeLinker: node-modules` in .yarnrc.yml and run `yarn install`, then re-run the probe" : "";
  return { ok: false, reason: `no playwright package resolvable from ${path.join(abs, "package.json")} (${tried.join("; ")})${pnp}`, hint: installHint(abs) };
}
function rendererUnavailable(reason, hint, tool = "verify-probe", nothing = "measured or written") {
  if (hint === null) {
    console.error(`${tool}: renderer unavailable \u2014 ${reason} \u2014 nothing was ${nothing}.`);
    return 3;
  }
  console.error(`${tool}: renderer unavailable \u2014 ${reason}
  nothing was ${nothing}. Ask the user to run:  ${hint}
  (${tool} never installs a package or downloads a browser itself.)`);
  return 3;
}
var LAUNCH_ARGS = ["--disable-lcd-text"];
async function launch(r, dir, executablePath) {
  if (r.mod.selectors) await registerPathEngine(r.mod.selectors);
  try {
    return { browser: await r.mod.chromium.launch({ headless: true, args: [...LAUNCH_ARGS], ...executablePath !== void 0 ? { executablePath } : {} }) };
  } catch (e) {
    const first = (errMsg(e).split("\n").find((l) => l.trim()) || "launch failed").trim();
    return {
      error: `${r.pkg} ${r.version} resolved, but chromium did not launch${executablePath !== void 0 ? ` from --browser-path ${executablePath} (only guaranteed with the bundled Chromium)` : ""}: ${first}`,
      hint: browserHint(dir)
    };
  }
}
function browserPathError(p) {
  let ok = false;
  try {
    ok = fs.statSync(p).isFile();
    if (ok) fs.accessSync(p, fs.constants.X_OK);
  } catch {
    ok = false;
  }
  return ok ? null : `--browser-path ${p} is not an executable file (on macOS pass the binary inside the .app: \u2026/Contents/MacOS/\u2026)`;
}
var INIT_SCRIPT = `try { ${PAGE_RUNTIME} } catch (e) {}
(() => {
  try { Object.defineProperty(window, "__dtProbeDoc", { value: Math.random().toString(36).slice(2), configurable: true }); } catch (e) {}
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}";
  let sheet = null;
  const adopt = () => { try { if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(css); } if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } catch (e) {} };
  adopt();
  const add = () => { adopt(); const s = document.createElement("style"); s.setAttribute("data-dt-probe", ""); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add, { once: true }); else add();
  addEventListener("load", adopt, { once: true });
})();`;

// design-to-code/probe-capture.ts
function walkCapture(input) {
  const dt = window.__dt;
  const pathOf = dt.paths();
  const r22 = (n) => Math.round(n * 100) / 100;
  const pageRect = (r) => ({ x: r22(r.x + scrollX), y: r22(r.y + scrollY), w: r22(r.width), h: r22(r.height) });
  const pxOrNull = (v) => {
    const t = v.trim();
    if (t === "normal" || t === "") return 0;
    if (!/^-?[\d.]+px$/.test(t)) return null;
    return r22(parseFloat(t));
  };
  const skipped = {};
  const skip = (why) => {
    skipped[why] = (skipped[why] || 0) + 1;
  };
  let count2 = 0;
  const NO_BOX = /^(script|style|template|head|meta|link|title|noscript|base)$/;
  const REPLACED = /^(img|svg|video|canvas|iframe|embed|object|input|select|textarea|button|picture|audio|math)$/;
  const TEXT_FIELD = /^(text|search|email|url|tel|number|password)$/;
  const inlineMemo = /* @__PURE__ */ new Map();
  const isInline = (e) => {
    const known = inlineMemo.get(e);
    if (known !== void 0) return known;
    const tag = e.tagName.toLowerCase();
    let ok = tag === "br" || tag === "wbr";
    if (!ok && !REPLACED.test(tag) && !NO_BOX.test(tag)) {
      const d = getComputedStyle(e).getPropertyValue("display").trim();
      ok = (d === "inline" || d === "contents") && Array.from(e.children).every((c) => isInline(c));
    }
    inlineMemo.set(e, ok);
    return ok;
  };
  const linesOf = (rects) => {
    const tops = [];
    for (const r of Array.from(rects)) {
      if (!(r.width > 0 && r.height > 0)) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < Math.max(2, r.height / 2))) tops.push(r.top);
    }
    return Math.max(1, tops.length);
  };
  const rangeBox = (first, last) => {
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    const r = range.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { rect: pageRect(r), lines: linesOf(range.getClientRects()) };
  };
  const collapse = (s) => s.replace(/\s+/g, " ");
  const visible = (s) => {
    const v = s.getPropertyValue("visibility").trim();
    return v !== "hidden" && v !== "collapse";
  };
  const drawnChars = (n, shown, br) => {
    if (n.nodeType === 3) return shown ? n.nodeValue || "" : "";
    if (n.nodeType !== 1) return "";
    const el = n;
    const s = getComputedStyle(el);
    if (s.getPropertyValue("display").trim() === "none" || parseFloat(s.getPropertyValue("opacity")) === 0) return "";
    const own2 = visible(s);
    if (el.tagName.toLowerCase() === "br") return own2 ? br : "";
    return Array.from(el.childNodes).map((c) => drawnChars(c, own2, br)).join("");
  };
  const hidesSome = (e) => Array.from(e.querySelectorAll("*")).some((c) => {
    const s = getComputedStyle(c);
    return s.getPropertyValue("display").trim() === "none" || parseFloat(s.getPropertyValue("opacity")) === 0 || !visible(s);
  });
  const drawnText = (e) => collapse(drawnChars(e, true, "\uE000")).replace(/ ? ?/g, "\n").trim();
  const transparent = (c) => c === "transparent" || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(c);
  const drawsShadow = (v) => {
    const t = v.trim();
    if (!t || t === "none") return false;
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of t) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    return parts.some((p) => !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(p) && !/transparent/.test(p));
  };
  const pseudoContent = (e, which) => {
    const c = getComputedStyle(e, which).getPropertyValue("content").trim();
    return c !== "" && c !== "none" && c !== "normal";
  };
  const urlsOf = (v) => {
    const out = [];
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
    for (let m = re.exec(v); m; m = re.exec(v)) out.push(m[1] || m[2] || m[3] || "");
    return out.filter((u) => u !== "");
  };
  const tracks = (v) => {
    const t = v.replace(/\[[^\]]*\]/g, " ").trim();
    if (!t || t === "none") return [];
    return t.split(/\s+/).map((x) => /^-?[\d.]+px$/.test(x) ? r22(parseFloat(x)) : NaN).filter((n) => Number.isFinite(n));
  };
  const FONT_PROPS = ["font-weight", "font-style", "font-size", "font-family", "color", "text-decoration-line"];
  const mixedIn = (e) => {
    const own2 = getComputedStyle(e);
    const base = FONT_PROPS.map((p) => own2.getPropertyValue(p)).join("|");
    const all = Array.from(e.querySelectorAll("*"));
    return all.some((c) => FONT_PROPS.map((p) => getComputedStyle(c).getPropertyValue(p)).join("|") !== base);
  };
  const paintsInline = (e) => Array.from(e.querySelectorAll("*")).some((c) => {
    const s = getComputedStyle(c);
    const bg = s.getPropertyValue("background-color").trim();
    return bg !== "" && !transparent(bg) || s.getPropertyValue("border-top-style").trim() !== "none" && parseFloat(s.getPropertyValue("border-top-width")) > 0;
  });
  const rootEl = input.root ? document.querySelector(input.root) : document.body;
  const htmlPath = pathOf(document.documentElement);
  const bodyPath = document.body ? pathOf(document.body) : null;
  const de = document.documentElement;
  const doc = { w: r22(Math.max(de.scrollWidth, de.clientWidth)), h: r22(Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0, de.clientHeight)) };
  if (!rootEl) return { root: null, missing: input.root ? "no element matches " + input.root : "the document has no <body>", doc, elements: 0, skipped, htmlPath, bodyPath };
  if (input.root && !dt.visible(rootEl, { sized: true })) return { root: null, missing: input.root + " matches an element that is not visible (no box, display none, or visibility hidden)", doc, elements: 0, skipped, htmlPath, bodyPath };
  const rootBox = input.root ? pageRect(rootEl.getBoundingClientRect()) : { x: 0, y: 0, w: doc.w, h: doc.h };
  const element = (e, cs) => {
    const tag = e.tagName.toLowerCase();
    const get = (p) => cs.getPropertyValue(p).trim();
    const display = get("display");
    const ov = get("overflow-x") + " " + get("overflow-y");
    let media = null;
    if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video" || tag === "iframe") media = tag;
    else if (tag === "embed" || tag === "object") media = "iframe";
    else if (tag === "input" && !TEXT_FIELD.test((e.type || "text").toLowerCase()) && !/^(button|submit|reset)$/.test((e.type || "").toLowerCase())) media = "control";
    let control = null;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const c = dt.controlText(e);
      if (c !== null && "text" in c && c.text.trim()) control = { text: c.text, placeholder: false };
      else if (e.getAttribute("placeholder")) control = { text: e.getAttribute("placeholder") || "", placeholder: true };
    }
    const dropped = [];
    if (drawsShadow(get("box-shadow"))) dropped.push("shadow");
    const bgImage = get("background-image");
    if (/gradient\(/.test(bgImage)) dropped.push("gradient");
    if (!media && (pseudoContent(e, "::before") || pseudoContent(e, "::after"))) dropped.push("pseudo-element");
    if (get("transform") !== "none" && get("transform") !== "") dropped.push("transform");
    if (get("filter") !== "none" && get("filter") !== "" || get("backdrop-filter") !== "none" && get("backdrop-filter") !== "") dropped.push("filter");
    const z = parseInt(get("z-index"), 10);
    const alt = tag === "img" ? (e.getAttribute("alt") || "").trim() : "";
    return {
      kind: "el",
      path: pathOf(e),
      tag,
      name: alt ? alt.slice(0, 60) : e.id ? tag + "#" + e.id.slice(0, 40) : tag,
      rect: pageRect(e.getBoundingClientRect()),
      display,
      position: get("position"),
      zIndex: Number.isFinite(z) ? z : 0,
      flexDirection: get("flex-direction"),
      flexWrap: get("flex-wrap"),
      justifyContent: get("justify-content"),
      alignItems: get("align-items"),
      alignSelf: get("align-self"),
      flexGrow: parseFloat(get("flex-grow")) || 0,
      order: parseInt(get("order"), 10) || 0,
      gridColumns: /grid/.test(display) ? tracks(get("grid-template-columns")) : [],
      gridRows: /grid/.test(display) ? tracks(get("grid-template-rows")) : [],
      gridPlaced: !/^auto( \/ auto)?$/.test(get("grid-column")) || !/^auto( \/ auto)?$/.test(get("grid-row")),
      rowGap: pxOrNull(get("row-gap")),
      columnGap: pxOrNull(get("column-gap")),
      clip: /hidden|clip|auto|scroll/.test(ov) && tag !== "html" && tag !== "body",
      objectFit: get("object-fit"),
      backgroundImages: urlsOf(bgImage),
      backgroundSize: get("background-size"),
      backgroundRepeat: get("background-repeat"),
      fontStyle: get("font-style"),
      textAlign: get("text-align"),
      textDecoration: get("text-decoration-line"),
      direction: get("direction"),
      text: null,
      control,
      media,
      src: tag === "img" ? e.currentSrc || e.src || null : tag === "video" ? e.getAttribute("poster") : null,
      dropped,
      children: []
    };
  };
  const visit = (e, into) => {
    const tag = e.tagName.toLowerCase();
    if (NO_BOX.test(tag)) return;
    const cs = getComputedStyle(e);
    const display = cs.getPropertyValue("display").trim();
    if (display === "none") {
      skip("display none");
      return;
    }
    if (display === "contents") {
      kids(e, into);
      return;
    }
    if (e.getClientRects().length === 0) {
      skip("no box");
      return;
    }
    const vis = cs.getPropertyValue("visibility").trim();
    if (vis === "hidden" || vis === "collapse") {
      skip("visibility hidden");
      return;
    }
    if (parseFloat(cs.getPropertyValue("opacity")) === 0) {
      skip("opacity 0");
      return;
    }
    const r = pageRect(e.getBoundingClientRect());
    if (r.x >= rootBox.x + rootBox.w || r.y >= rootBox.y + rootBox.h || r.x + r.w <= rootBox.x || r.y + r.h <= rootBox.y) {
      if (r.w > 0 && r.h > 0) {
        skip("outside the captured area");
        return;
      }
    }
    count2++;
    if (count2 > input.maxElements) return;
    const el = element(e, cs);
    if (!el.media) {
      const nodes = Array.from(e.childNodes);
      const inlineOnly = Array.from(e.children).every(isInline);
      const drawn = !el.control && inlineOnly && hidesSome(e) ? drawnText(e) : null;
      const shown = el.control ? "" : drawn ?? dt.shownText(e);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!el.control && shown && first && last && inlineOnly) {
        const box = rangeBox(first, last);
        if (box) {
          el.text = { rect: box.rect, lines: box.lines, mixed: e.children.length > 0 && mixedIn(e), ...drawn !== null ? { drawn } : {} };
          if (e.children.length && paintsInline(e)) el.dropped.push("inline-paint");
        }
      } else if (!el.control) kids(e, el.children);
    }
    if (!(r.w > 0.5 && r.h > 0.5) && !el.children.length && !el.text) {
      skip("zero size");
      count2--;
      return;
    }
    into.push(el);
  };
  const kids = (e, into) => {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const runShown = visible(getComputedStyle(e));
      const text = collapse(run.map((n) => drawnChars(n, runShown, " ")).join("")).trim();
      const first = run[0], last = run[run.length - 1];
      run = [];
      if (!text || !first || !last) return;
      const box = rangeBox(first, last);
      if (!box) return;
      count2++;
      if (count2 > input.maxElements) return;
      into.push({ kind: "run", text, rect: box.rect, lines: box.lines });
    };
    const sr = e.shadowRoot;
    if (sr) {
      for (const c of Array.from(sr.children)) visit(c, into);
      return;
    }
    if (e.tagName.toLowerCase() === "slot" && e.assignedElements) {
      const assigned = e.assignedElements();
      if (assigned.length) {
        for (const c of assigned) visit(c, into);
        return;
      }
    }
    let k = 0;
    for (const n of Array.from(e.childNodes)) {
      if (n.nodeType === 3) {
        if ((n.nodeValue || "").trim() || run.length) run.push(n);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const c = e.children[k++];
      if (!c) continue;
      if (isInline(c)) {
        if (c.tagName.toLowerCase() !== "br" || run.length) run.push(c);
        continue;
      }
      flush();
      visit(c, into);
    }
    flush();
  };
  const rootCs = getComputedStyle(rootEl);
  count2++;
  const root = element(rootEl, rootCs);
  if (!input.root) {
    root.rect = rootBox;
    root.clip = true;
  }
  kids(rootEl, root.children);
  return { root, doc, elements: count2, skipped, htmlPath, bodyPath };
}
function eagerImages() {
  let loading = 0;
  for (const img of Array.from(document.querySelectorAll("img"))) {
    if (img.getAttribute("loading") === "lazy") img.setAttribute("loading", "eager");
    if (img.complete === false) loading++;
  }
  return loading;
}
function hideChildren(arg) {
  const el = window.__dt.find(arg.path);
  if (!el) return false;
  const kept = window.__dtHidden || (window.__dtHidden = /* @__PURE__ */ new WeakMap());
  if (!arg.hide) {
    for (const [e, style] of kept.get(el) || []) {
      e.setAttribute("style", style === null ? "" : style);
      if (style === null) e.removeAttribute("style");
    }
    kept.delete(el);
    return true;
  }
  if (kept.has(el)) return true;
  const saved = [];
  kept.set(el, saved);
  const set = (e, prop, value) => {
    if (!saved.some(([s]) => s === e)) saved.push([e, e.getAttribute("style")]);
    e.style.setProperty(prop, value, "important");
  };
  const cs = getComputedStyle(el);
  for (const prop of ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "background-color", "box-shadow"]) set(el, prop, cs.getPropertyValue(prop));
  for (const prop of ["color", "-webkit-text-fill-color", "-webkit-text-stroke-color", "text-decoration-color", "text-emphasis-color"]) set(el, prop, "transparent");
  set(el, "text-shadow", "none");
  const hideAll = (p) => {
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

// design-to-code/probe-page.ts
function measureElements(input) {
  const dt = window.__dt;
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const r22 = (n) => Math.round(n * 100) / 100;
  const pageRect = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
  const controlText = dt.controlText;
  const specText = (el) => {
    const c = controlText(el);
    if (c === null) return { text: dt.shownText(el) };
    return "text" in c ? { text: c.text.replace(/\r\n?/g, "\n").replace(/[ \t\f]*\n[ \t\f]*/g, "\n").replace(/[ \t\f]+/g, " ").trim() } : c;
  };
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
  const ownText = (el) => dt.ownText(el).trim();
  const elementsWithOwnText = (el) => {
    const out = [];
    const walk = (e) => {
      const t = e.tagName === "SELECT" || e.tagName === "TEXTAREA" ? controlText(e) : null;
      if (t !== null && "text" in t) {
        if (t.text.trim()) out.push(e);
        return;
      }
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
      if (ownText(cur) || controlText(cur) !== null) return { owner: cur, mixed };
      const kids = Array.from(cur.children);
      const only = kids.length === 1 ? kids[0] : void 0;
      if (!only) break;
      cur = only;
    }
    const first = owners[0];
    return first ? { owner: first, mixed } : null;
  };
  const SHAPES2 = "path, rect, circle, ellipse, polygon, polyline, line, use, text";
  return input.items.map((item) => {
    const styles = {};
    const unmeasured = {};
    const res = { nodeId: item.nodeId, found: false, styles, unmeasured };
    const el = dt.find(item.path);
    const put2 = (k, v, why) => {
      if (v === null || v === void 0) {
        styles[k] = null;
        unmeasured[k] = why;
      } else styles[k] = v;
    };
    if (!el) {
      for (const k of input.keys) put2(k, null, "the element was gone when measured");
      return res;
    }
    res.found = true;
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const rect = pageRect(el.getBoundingClientRect());
    const fr = input.frameRect;
    let typo = el, typoCs = cs;
    let textBox = null, textBoxWhy = item.isPlaceholder ? "an input placeholder: its characters are not in the DOM (see placeholderText)" : "not a TEXT node";
    if (item.isText && !item.isPlaceholder && controlText(el) !== null) textBoxWhy = `a form control (<${tag}>) draws its value itself: no Range reaches its characters`;
    else if (item.isText && !item.isPlaceholder) {
      const own2 = textOwner(el);
      if (own2) {
        typo = own2.owner;
        typoCs = getComputedStyle(typo);
        res.textFrom = typo.tagName.toLowerCase();
        if (own2.mixed) res.textFromMixed = true;
        if (controlText(typo) !== null) textBoxWhy = `its text is a form control's (<${typo.tagName.toLowerCase()}>), which draws its value itself: no Range reaches its characters`;
        let left = Infinity, right = -Infinity;
        for (const n of controlText(typo) === null ? Array.from(typo.childNodes) : []) {
          if (n.nodeType !== 3 || !(n.nodeValue || "").trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const rr = pageRect(range.getBoundingClientRect());
          if (rr.w <= 0) continue;
          left = Math.min(left, rr.x);
          right = Math.max(right, rr.x + rr.w);
        }
        if (Number.isFinite(left)) textBox = { x: r22(left - fr.x), w: r22(right - left) };
        else if (controlText(typo) === null) textBoxWhy = "the text's own characters have no rendered box";
      } else textBoxWhy = "the element holds no text";
    }
    const sides2 = (prop) => ["top", "right", "bottom", "left"].map((s) => px(cs.getPropertyValue(prop(s))));
    let strokeMemo;
    const transparentColour = (c) => c === null || c === "transparent" || /^rgba\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?%?\s*\)$/.test(c) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(c);
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
      if (sides2((s) => `border-${s}-width`).some((w) => w !== 0)) return strokeMemo;
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
          if (transparentColour(color) || blur !== 0 || lens.length < 2) continue;
          if (inset && spread === 0 && x === 0 !== (y === 0)) {
            const w = r22(Math.abs(x || y)), sides3 = [y > 0 ? w : 0, x < 0 ? w : 0, y < 0 ? w : 0, x > 0 ? w : 0];
            rings.push({ key: `${color} ${sides3.join(",")} side`, spread: w, color, inset, sides: sides3 });
            continue;
          }
          if (!(spread > 0) || x !== 0 || y !== 0) continue;
          rings.push({ key: `${color} ${spread} ${inset}`, spread: r22(spread), color, inset });
        }
      }
      const distinct = rings.filter((r, i) => rings.findIndex((o) => o.key === r.key) === i);
      const insetOnes = distinct.filter((r) => r.inset);
      const ring = distinct.length === 1 ? distinct[0] : insetOnes.length === 1 ? insetOnes[0] : void 0;
      if (ring) return strokeMemo = { width: ring.spread, color: ring.color, from: "box-shadow", align: ring.inset ? "inside" : "outside", ...ring.sides ? { sides: ring.sides } : {} };
      if (distinct.length > 1) return strokeMemo;
      const os2 = cs.getPropertyValue("outline-style").trim(), ow = px(cs.getPropertyValue("outline-width")), oo = px(cs.getPropertyValue("outline-offset"));
      const oc = rgba(cs.getPropertyValue("outline-color"));
      if (!os2 || os2 === "none" || os2 === "auto" || ow === null || !(ow > 0) || oo === null || transparentColour(oc)) return strokeMemo;
      if (oo === -ow) return strokeMemo = { width: ow, color: oc, from: "outline", align: "inside" };
      if (oo === 0) return strokeMemo = { width: ow, color: oc, from: "outline", align: "outside" };
      if (Math.abs(oo + ow / 2) < 0.01) return strokeMemo = { width: ow, color: oc, from: "outline", align: "center" };
      return strokeMemo;
    };
    const frameRoot = input.framePath ? dt.find(input.framePath) : null;
    const paintOf = (e) => {
      const s = getComputedStyle(e), img = s.getPropertyValue("background-image").trim();
      return { color: rgba(s.getPropertyValue("background-color")), image: img !== "" && img !== "none" };
    };
    const painter = (e, via, depth, color) => {
      const dt2 = e.getAttribute("data-dt-node");
      return { backgroundColor: color, via, tag: e.tagName.toLowerCase(), depth, ...dt2 !== null ? { dt: dt2 } : {} };
    };
    const paintedBy = () => {
      const near2 = (a, b) => Math.abs(a - b) <= 1;
      let cur = el, depth = 0;
      for (; ; ) {
        const kids2 = Array.from(cur.children);
        const only = kids2.length === 1 ? kids2[0] : void 0;
        if (!only) break;
        const r = pageRect(only.getBoundingClientRect());
        if (!(near2(r.x, rect.x) && near2(r.y, rect.y) && near2(r.w, rect.w) && near2(r.h, rect.h))) break;
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
      } else if (sides2((s) => `border-${s}-width`).some((w) => w !== null && w > 0)) styles.strokeFrom = "border";
    };
    const fill = () => {
      if (!item.isPaint) return { v: null, why: "not a vector/SVG node \u2014 its colour is backgroundColor" };
      if (tag === "img" || tag === "canvas" || tag === "picture") return { v: null, why: `an <${tag}>: its paint is pixels, not a CSS property`, source: "img" };
      const shapes = [...el.matches(SHAPES2) ? [el] : [], ...Array.from(el.querySelectorAll(SHAPES2))];
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
    const assetOf = () => {
      const of = (e) => e.tagName.toLowerCase() === "svg" ? { from: "svg", markup: e.outerHTML ?? "" } : { from: "img", src: e.currentSrc || e.src || "" };
      if (tag === "img" || tag === "svg") return of(el);
      const inner = Array.from(el.querySelectorAll("img, svg")).filter((e) => !e.parentElement?.closest("svg"));
      const only = inner[0];
      if (only && inner.length === 1) return of(only);
      if (inner.length > 1) return { from: "none", why: `${inner.length} images inside this node's element \u2014 tag the one that draws it` };
      const paint2 = [cs.getPropertyValue("background-image"), cs.getPropertyValue("mask-image"), cs.getPropertyValue("-webkit-mask-image")].find((v) => /url\(/.test(v));
      if (paint2) return { from: "css", why: "drawn by a CSS background or mask, not an <img> or inline <svg>" };
      return { from: "none", why: `no <img> or inline <svg> draws this <${tag}>` };
    };
    for (const k of input.keys) {
      switch (k) {
        case "fontFamily":
          put2(k, typoCs.getPropertyValue("font-family") || null, "no computed font-family");
          break;
        case "fontSize":
          put2(k, px(typoCs.getPropertyValue("font-size")), "no computed font-size");
          break;
        // parseFloat, not parseInt: a variable font's computed weight may be fractional ("650.5", CSS Fonts 4 §2.2)
        case "fontWeight": {
          const w = parseFloat(typoCs.getPropertyValue("font-weight"));
          put2(k, Number.isFinite(w) ? w : null, "no numeric font-weight");
          break;
        }
        case "lineHeight": {
          const v = typoCs.getPropertyValue("line-height");
          put2(k, v === "normal" ? null : px(v), "line-height: normal \u2014 its pixel value depends on the font's metrics");
          break;
        }
        case "letterSpacing": {
          const v = typoCs.getPropertyValue("letter-spacing");
          put2(k, v === "normal" ? 0 : px(v), "no computed letter-spacing");
          break;
        }
        case "color":
          put2(k, rgba(typoCs.getPropertyValue("color")), "no computed color");
          break;
        case "backgroundColor": {
          const bg = rgba(cs.getPropertyValue("background-color"));
          put2(k, bg, "no computed background-color");
          if (item.backgroundSpec && bg !== null && transparentColour(bg)) {
            const pb = paintedBy();
            if (pb !== null) styles.paintedBy = pb;
          }
          break;
        }
        case "fill": {
          const f = fill();
          if (f.source) res.fillSource = f.source;
          put2(k, f.v, f.why);
          break;
        }
        case "placeholderColor":
          if (!item.isPlaceholder) put2(k, null, "not an input placeholder");
          else if (!el.hasAttribute("placeholder")) put2(k, null, `the matched <${tag}> has no placeholder attribute`);
          else put2(k, rgba(getComputedStyle(el, "::placeholder").getPropertyValue("color")), "no computed ::placeholder colour");
          break;
        case "placeholderText":
          if (!item.isPlaceholder) put2(k, null, "not an input placeholder");
          else put2(k, el.getAttribute("placeholder"), `the matched <${tag}> has no placeholder attribute`);
          break;
        case "borderColor": {
          const ws = sides2((s) => `border-${s}-width`);
          const i = ws.findIndex((w) => w !== null && w > 0);
          const st = i === -1 ? drawnStroke() : null;
          put2(k, st ? st.color : i === -1 ? null : rgba(cs.getPropertyValue(`border-${["top", "right", "bottom", "left"][i]}-color`)), "no border (border-width 0 on every side) and no ring (box-shadow 0 0 0 Npx) or outline at offset 0 / -width / -width/2");
          putStroke();
          break;
        }
        case "borderWidth": {
          const ws = sides2((s) => `border-${s}-width`).filter((w) => w !== null);
          const st = drawnStroke();
          put2(k, st ? st.width : ws.length ? Math.max(...ws) : null, "no computed border width");
          putStroke();
          break;
        }
        case "borderWidths": {
          const st = drawnStroke();
          put2(k, st ? st.sides ?? [st.width, st.width, st.width, st.width] : sides2((s) => `border-${s}-width`), "");
          putStroke();
          break;
        }
        case "display":
          put2(k, cs.getPropertyValue("display").trim() || null, "no computed display");
          break;
        case "borderRadius": {
          const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c2) => {
            const v = cs.getPropertyValue(`border-${c2}-radius`).trim().split(/\s+/)[0] || "0";
            return v.endsWith("%") ? r22(parseFloat(v) / 100 * Math.min(rect.w, rect.h)) : px(v);
          });
          const [a, b, c, d] = corners;
          if (corners.some((v) => v === null)) put2(k, null, "unreadable border radius");
          else put2(k, a === b && a === c && a === d ? a : corners, "");
          break;
        }
        case "padding":
          put2(k, sides2((s) => `padding-${s}`), "");
          break;
        case "gap": {
          const display = cs.getPropertyValue("display");
          const flexish = /flex|grid/.test(display);
          if (!flexish) {
            put2(k, null, `display: ${display} \u2014 gap does not apply; spacing comes from margins`);
            break;
          }
          const column = /column/.test(cs.getPropertyValue("flex-direction")) && /flex/.test(display);
          const v = cs.getPropertyValue(column ? "row-gap" : "column-gap").trim();
          put2(k, v === "normal" ? 0 : v.endsWith("%") ? null : px(v), v.endsWith("%") ? `a percentage gap (${v}) \u2014 its px value depends on the container` : "unreadable gap");
          break;
        }
        case "gapVisual": {
          if (!/^(table|thead|tbody|tfoot)$/.test(tag)) {
            put2(k, null, "measured only for a table (row spacing is border-spacing, not gap)");
            break;
          }
          const own2 = tag === "table" ? el : el.closest("table");
          const rows = Array.from(el.querySelectorAll("tr")).filter((r) => r.closest("table") === own2).map((r) => r.getBoundingClientRect()).filter((r) => r.height > 0);
          const gaps = [];
          for (let i = 1; i < rows.length; i++) {
            const a = rows[i - 1], b = rows[i];
            if (a && b) gaps.push(r22(b.y - (a.y + a.height)));
          }
          const median = gaps.length ? gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? null : null;
          put2(k, median !== null && median < 0 ? null : median, median === null ? "fewer than two rendered rows" : `the rows are not stacked top to bottom (median distance ${median}px) \u2014 not a row gap`);
          break;
        }
        case "width":
        case "height":
        case "x":
        case "y": {
          if (item.sharesWith !== null) {
            put2(k, null, `shares the element of data-dt-node="${item.sharesWith}"; wrap the label in a tagged <span> to measure its box`);
            break;
          }
          put2(k, r22(k === "width" ? rect.w : k === "height" ? rect.h : k === "x" ? rect.x - fr.x : rect.y - fr.y), "");
          break;
        }
        case "opacity":
          put2(k, px(cs.getPropertyValue("opacity")), "no computed opacity");
          break;
        case "text": {
          if (!item.isText || item.isPlaceholder) {
            put2(k, null, item.isPlaceholder ? "an input placeholder: see placeholderText" : "not a TEXT node");
            break;
          }
          const st = specText(el);
          put2(k, "text" in st ? st.text : null, "why" in st ? st.why : "");
          break;
        }
        case "tag":
          put2(k, tag, "");
          break;
        case "textBox":
          put2(k, textBox, textBoxWhy);
          break;
        case "assetIdentity":
          put2(k, item.assetSpec ? assetOf() : null, "not an exported asset");
          break;
        default:
          put2(k, null, `verify-probe does not know how to read '${k}'`);
      }
    }
    if (item.isText && !item.isPlaceholder) {
      const tt = typoCs.getPropertyValue("text-transform").trim();
      if (tt) styles.textTransform = tt;
    }
    if (input.capture) {
      const tt = typoCs.getPropertyValue("text-transform").trim(), fs7 = typoCs.getPropertyValue("font-style").trim(), td = typoCs.getPropertyValue("text-decoration-line").trim();
      if (tt) styles.textTransform = tt;
      if (fs7) styles.fontStyle = fs7;
      if (td) styles.textDecoration = td;
    }
    return res;
  });
}

// design-to-code/kill-tree.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import fs3 from "node:fs";

// design-to-code/proc.ts
import { spawn, spawnSync } from "node:child_process";
import fs2 from "node:fs";
import os from "node:os";
import path2 from "node:path";

// bridge/src/stdio.ts
import { format, inspect } from "node:util";
function installQueuedConsole(o = {}) {
  trackWrites(process.stdout);
  trackWrites(process.stderr);
  const out = o.logTo === "stderr" ? process.stderr : process.stdout;
  const err = process.stderr;
  let indent = "";
  const write = (s, text) => {
    s.write((indent ? text.replace(/^/gm, indent) : text) + "\n");
  };
  const line = (s) => (...a) => {
    write(s, format(...a));
  };
  console.log = console.info = console.debug = line(out);
  console.warn = console.error = line(err);
  console.dir = (item, options) => {
    write(out, inspect(item, { customInspect: false, ...options }));
  };
  console.dirxml = line(out);
  console.table = (data) => {
    write(out, inspect(data));
  };
  console.write = (...data) => {
    let n = 0;
    for (const d of data) {
      const b = typeof d === "string" ? Buffer.from(d) : d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength);
      if (b.length) {
        out.write(b);
        n += b.length;
      }
    }
    return n;
  };
  console.clear = () => {
    if (out.isTTY) out.write("\x1B[1;1H\x1B[0J");
  };
  console.trace = (...a) => {
    const e = new Error(format(...a));
    e.name = "Trace";
    Error.captureStackTrace(e, console.trace);
    write(err, e.stack ?? `Trace: ${e.message}`);
  };
  console.assert = (cond, ...a) => {
    if (!cond) write(err, a.length ? "Assertion failed: " + format(...a) : "Assertion failed");
  };
  console.group = console.groupCollapsed = (...a) => {
    if (a.length) write(out, format(...a));
    indent += "  ";
  };
  console.groupEnd = () => {
    indent = indent.slice(0, -2);
  };
  const counts = /* @__PURE__ */ new Map();
  console.count = (label = "default") => {
    const n = (counts.get(label) ?? 0) + 1;
    counts.set(label, n);
    write(out, `${label}: ${n}`);
  };
  console.countReset = (label = "default") => {
    counts.delete(label);
  };
  const timers = /* @__PURE__ */ new Map();
  const elapsed = (label) => {
    const t = timers.get(label);
    return t === void 0 ? null : `${label}: ${(performance.now() - t).toFixed(3)}ms`;
  };
  console.time = (label = "default") => {
    timers.set(label, performance.now());
  };
  console.timeLog = (label = "default", ...a) => {
    const e = elapsed(label);
    if (e === null) write(err, `Warning: No such label '${label}' for console.timeLog()`);
    else write(out, [e, ...a.map((x) => format(x))].join(" "));
  };
  console.timeEnd = (label = "default") => {
    const e = elapsed(label);
    timers.delete(label);
    write(e === null ? err : out, e ?? `Warning: No such label '${label}' for console.timeEnd()`);
  };
}
var inFlight = /* @__PURE__ */ new Map();
function trackWrites(s) {
  if (inFlight.has(s)) return;
  const st = { n: 0, idle: [] };
  inFlight.set(s, st);
  const write = s.write.bind(s);
  const settle2 = () => {
    if (--st.n === 0) for (const r of st.idle.splice(0)) r();
  };
  s.write = (chunk, encoding, cb) => {
    const done = typeof encoding === "function" ? encoding : cb;
    const enc = typeof encoding === "function" ? void 0 : encoding;
    if (chunk.length === 0) return write(chunk, enc, done);
    st.n++;
    let called = false;
    return write(chunk, enc, (err) => {
      if (!called) {
        called = true;
        settle2();
      }
      done?.(err);
    });
  };
}
var CliExit = class extends Error {
  code;
  constructor(code) {
    super(`exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
};
var cliDepth = 0;
function exitCli(code) {
  if (cliDepth > 0) throw new CliExit(code);
  process.exit(code);
}
function runCli(main2, o, argv = process.argv.slice(2)) {
  installQueuedConsole();
  const done = o.done ?? ((code) => {
    process.exitCode = code;
  });
  const fail = (e) => {
    if (e instanceof CliExit) return done(e.code);
    console.error(o.errorLine ? o.errorLine(e) : `${o.name}: ${e instanceof Error && e.stack || String(e)}`);
    done(o.errorCode ?? 1);
  };
  cliDepth++;
  let settled = false;
  const leave = () => {
    if (!settled) {
      settled = true;
      cliDepth--;
    }
  };
  try {
    const r = main2(argv);
    if (typeof r === "number") {
      leave();
      done(r);
    } else r.then((c) => {
      leave();
      done(c);
    }, (e) => {
      leave();
      fail(e);
    });
  } catch (e) {
    leave();
    fail(e);
  }
}

// design-to-code/proc.ts
var readBytes = (f) => {
  try {
    return fs2.readFileSync(f);
  } catch {
    return Buffer.alloc(0);
  }
};
function syncOnce(cmd, args, o, attempt) {
  const t0 = Date.now();
  const opts = { cwd: o.cwd, env: o.env, input: o.input, timeout: o.timeoutMs, windowsHide: true, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024, shell: false };
  const stdin = o.input !== void 0 ? "pipe" : "ignore";
  const done = (s, stdout, stderr) => ({
    status: s.error !== void 0 && !s.pid ? null : s.status ?? null,
    signal: s.signal ?? null,
    stdout,
    stderr,
    ms: Date.now() - t0,
    ...s.error ? { error: s.error } : {},
    ...s.pid ? { pid: s.pid } : {},
    timedOut: s.error !== void 0 && "code" in s.error && s.error.code === "ETIMEDOUT",
    attempts: attempt
  });
  const piped = () => {
    const s = spawnSync(cmd, args, { ...opts, stdio: [stdin, "pipe", "pipe"] });
    const bytes = Buffer.isBuffer(s.stdout) ? s.stdout : Buffer.from(String(s.stdout ?? ""));
    return { ...done(s, bytes.toString("utf8"), String(s.stderr ?? "")), ...o.binary ? { stdoutBytes: bytes } : {} };
  };
  let dir = null;
  if (o.capture !== "pipe") try {
    dir = fs2.mkdtempSync(path2.join(os.tmpdir(), "dt-spawn-"));
  } catch {
  }
  if (dir === null) return piped();
  const outF = path2.join(dir, "out"), errF = path2.join(dir, "err");
  try {
    let out = null, err = null;
    try {
      out = fs2.openSync(outF, "wx+");
      err = fs2.openSync(errF, "wx+");
    } catch {
      if (out !== null) fs2.closeSync(out);
      return piped();
    }
    let s;
    try {
      s = spawnSync(cmd, args, { ...opts, stdio: [stdin, out, err] });
    } finally {
      fs2.closeSync(out);
      fs2.closeSync(err);
    }
    const bytes = readBytes(outF);
    return { ...done(s, bytes.toString("utf8"), readBytes(errF).toString("utf8")), ...o.binary ? { stdoutBytes: bytes } : {} };
  } finally {
    try {
      fs2.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}
function runSync(cmd, args, o = {}) {
  const valid = (r3) => o.expect === void 0 ? true : o.expect === "stdout" ? r3.stdout.length > 0 : o.expect instanceof RegExp ? o.expect.test(r3.stdout) || o.expect.test(r3.stderr) : o.expect(r3);
  let r = syncOnce(cmd, args, o, 1);
  if (!valid(r) && r.status === 0 && !r.error) {
    if (!o.quiet) process.stderr.write(`[spawn-helper] ${path2.basename(cmd)} ${args.slice(0, 2).join(" ")}: exit 0 but its output failed the check (stdout ${r.stdout.length} B) \u2014 re-running once
`);
    r = syncOnce(cmd, args, o, 2);
  }
  if (!valid(r)) r.lost = `output failed its check after ${r.attempts} run(s) (stdout ${r.stdout.length} B, status ${r.status})`;
  return r;
}
var pause = new Int32Array(new SharedArrayBuffer(4));

// design-to-code/kill-tree.ts
var taskkillCapped = (capMs) => (args) => spawnSync2("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: capMs });
var KILL_HOST = {
  platform: process.platform,
  taskkill: taskkillCapped(1e4),
  kill: (pid, s) => {
    process.kill(pid, s);
  }
};
var PROC_HOST = {
  ...KILL_HOST,
  self: process.pid,
  readdir: (dir) => fs3.readdirSync(dir),
  readFile: (file) => fs3.readFileSync(file, "utf8"),
  // pgrep -P / ps -A, captured through a file (proc.ts runSync): exit 0 says it listed something (pgrep's "none matched" is
  // exit 1), so an exit 0 with no pid in its output (Bun #46142: a lost capture) is run once more, then reported as an
  // error — never read as "no children", which would leave the browser running
  run: (cmd, args, timeoutMs) => {
    const r = runSync(cmd, args, { timeoutMs, expect: (x) => x.status !== 0 || /\d/.test(x.stdout) });
    const error = r.error ?? (r.lost !== void 0 ? new Error(`${cmd}: ${r.lost}`) : void 0);
    return { ...error !== void 0 ? { error } : {}, status: r.status, stdout: r.stdout };
  },
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
};

// design-to-code/probe-session.ts
var CUT_SETTLE_MS = 5e3;
var CLOSE_STEP_CAP_MS = 5e3;
var KILL_STEP_CAP_MS = 3e3;
var WRITE_MARGIN_MS = 2e3;
var TEARDOWN_RESERVE_MS = CUT_SETTLE_MS + 2 * CLOSE_STEP_CAP_MS + KILL_STEP_CAP_MS + WRITE_MARGIN_MS;
function contextOptions(viewport, dsf = 1) {
  return { viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: dsf, reducedMotion: "reduce" };
}
var KILL_GRACE_MS = 1e3;
var KILL_CMD_CAP_MS = KILL_STEP_CAP_MS - KILL_GRACE_MS;
var PROBE_HOST = { ...PROC_HOST, taskkill: taskkillCapped(KILL_CMD_CAP_MS) };

// bridge/src/hex-color.ts
var HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
var HEX_COLOR_HINT = "a hex colour like #1A2B3C (#rgb, #rgba, #rrggbb or #rrggbbaa)";
function parseHexColor(value) {
  if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) return null;
  let h = value.slice(1);
  if (h.length <= 4) h = h.split("").map((c2) => c2 + c2).join("");
  const chan = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  const c = { r: chan(0), g: chan(2), b: chan(4) };
  if (h.length === 8) c.a = chan(6);
  return c;
}
function formatHex(c) {
  const to = (x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0");
  const a = Math.round(c.a * 255);
  return "#" + to(c.r) + to(c.g) + to(c.b) + (a < 255 ? to(a) : "");
}

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
function parseHex(v) {
  const k = colorKey(v);
  if (k === null) return null;
  const n = (i) => parseInt(k.slice(i, i + 2), 16);
  return { r: n(1), g: n(3), b: n(5), a: n(7) / 255 };
}
var NUM = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
var PCT = `${NUM}%`;
var CH = `${NUM}%?`;
var CH_OR_NONE = `(?:${CH}|none)`;
var legacy = (ch) => `\\(\\s*(${ch})\\s*,\\s*(${ch})\\s*,\\s*(${ch})\\s*(?:,\\s*(${CH})\\s*)?\\)`;
var RGB_LEGACY = new RegExp(`^rgba?(?:${legacy(PCT)}|${legacy(NUM)})$`);
var RGB_MODERN = new RegExp(`^rgba?\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var OK = new RegExp(`^(oklab|oklch)\\(\\s*(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var SRGB = new RegExp(`^color\\(\\s*srgb\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s+(${CH_OR_NONE})\\s*(?:/\\s*(${CH_OR_NONE})\\s*)?\\)$`);
var comp = (x, pct) => x === void 0 || x === "none" ? 0 : x.endsWith("%") ? Number(x.slice(0, -1)) / 100 * pct : Number(x);
var clamp = (n, hi) => Math.min(hi, Math.max(0, n));
var alphaOf = (x) => x === void 0 ? 1 : clamp(comp(x, 1), 1);
function parseCssColor(v) {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (t === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (t.startsWith("#")) return parseHex(t);
  const leg = RGB_LEGACY.exec(t);
  const rgb = leg ? leg[1] !== void 0 ? leg.slice(1, 5) : leg.slice(5, 9) : RGB_MODERN.exec(t)?.slice(1, 5);
  if (rgb) {
    const ch = (x) => clamp(comp(x, 255), 255);
    const c = { r: ch(rgb[0]), g: ch(rgb[1]), b: ch(rgb[2]), a: alphaOf(rgb[3]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const ok = OK.exec(t);
  if (ok) {
    const L = comp(ok[2], 1);
    let a, b;
    if (ok[1] === "oklab") {
      a = comp(ok[3], 0.4);
      b = comp(ok[4], 0.4);
    } else {
      const C = comp(ok[3], 0.4), h = comp(ok[4], 1) * Math.PI / 180;
      a = C * Math.cos(h);
      b = C * Math.sin(h);
    }
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s3 = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const enc = (c2) => Math.round(255 * clamp(c2 <= 31308e-7 ? 12.92 * c2 : 1.055 * c2 ** (1 / 2.4) - 0.055, 1));
    const c = {
      r: enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s3),
      g: enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s3),
      b: enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s3),
      a: alphaOf(ok[5])
    };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  const srgb = SRGB.exec(t);
  if (srgb) {
    const ch = (x) => Math.round(clamp(comp(x, 1) * 255, 255));
    const c = { r: ch(srgb[1]), g: ch(srgb[2]), b: ch(srgb[3]), a: alphaOf(srgb[4]) };
    return Number.isFinite(c.r + c.g + c.b + c.a) ? c : null;
  }
  return null;
}

// design-to-code/verify-shared.ts
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
  const c = parseCssColor(s);
  if (c === null) return s;
  if (c.a === 0) return "transparent";
  return colorKey(formatHex(c)) ?? s;
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
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const name = s.toLowerCase().replace(/[^a-z]/g, "");
  const key = name === "italic" || name === "oblique" ? "regular" : name.replace(/(italic|oblique)$/, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}
function normFamily(v) {
  if (v == null) return null;
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}
var PAD_SIDES = ["top", "right", "bottom", "left"];
var BOX_RULES = ["leaf", "inline"];
var ASSET_IDENTITY = "asset identity";
var CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];
var field = (key, label, tol, extra = {}) => ({ spec: key, label, measured: key, census: key, parse: tol !== null && !extra.parse ? "px" : "norm", compare: "field", tol, ...extra });
var PROPERTIES = [
  { key: "fontFamily", norm: normFamily, typography: true, applies: [], shapes: [field("fontFamily", "font-family", null)] },
  { key: "fontSize", unit: "px", high: true, typography: true, applies: [], shapes: [field("fontSize", "font-size", TOLERANCE.fontSize, { nonNegative: true, paints: true })] },
  { key: "fontWeight", norm: normWeight, high: true, typography: true, applies: [], shapes: [field("fontWeight", "font-weight", TOLERANCE.fontWeight, { parse: "norm" })] },
  { key: "lineHeight", unit: "px", typography: true, applies: [], shapes: [field("lineHeight", "line-height", TOLERANCE.lineHeight, { nonNegative: true })] },
  { key: "letterSpacing", unit: "px", typography: true, applies: [], shapes: [field("letterSpacing", "letter-spacing", TOLERANCE.letterSpacing)] },
  { key: "color", norm: normColor, high: true, colour: true, typography: true, applies: ["drawnState"], shapes: [field("color", "color", null, { paints: true })] },
  { key: "backgroundColor", norm: normColor, high: true, colour: true, applies: ["drawnState", "leaf"], shapes: [field("backgroundColor", "background", null, { paints: true })] },
  { key: "fill", norm: normColor, high: true, colour: true, pixels: true, applies: ["drawnState"], shapes: [field("fill", "fill (SVG paint)", null, { paints: true, doc: "an SVG's paint" })] },
  {
    key: "placeholderColor",
    norm: normColor,
    high: true,
    colour: true,
    optional: true,
    applies: ["drawnState"],
    shapes: [field("placeholderColor", "placeholder colour", null, {
      doc: "the ::placeholder colour",
      absentWhy: "a ::placeholder colour is not readable from getComputedStyle(el) \u2014 report placeholderColor to have it checked"
    })]
  },
  { key: "borderColor", norm: normColor, colour: true, applies: ["drawnState", "leaf"], shapes: [field("borderColor", "border-color", null, { paints: true })] },
  // one border width, or four sides (a divider with only a bottom stroke) — read off a border, or a ring (box-shadow/outline)
  { key: "border", unit: "px", applies: ["leaf"], shapes: [
    field("borderWidth", "border-width", TOLERANCE.stroke, { nonNegative: true, paints: true }),
    {
      spec: "borderWidths",
      label: "border-width",
      parts: PAD_SIDES,
      measured: "borderWidths",
      census: "borderWidths",
      parse: "sides",
      compare: "sides",
      tol: TOLERANCE.stroke,
      as: "px border widths [t,r,b,l]",
      noun: "a border width",
      doc: "[t,r,b,l] \u2014 a ring's sides when it draws the stroke",
      paints: true
    }
  ] },
  // one radius, or four unequal corners (a table header rounded only at the top) — both read off borderRadius
  { key: "radius", unit: "px", applies: [...BOX_RULES, "rowTag"], shapes: [
    field("borderRadius", "border-radius", TOLERANCE.radius, { parse: "corners", as: "a px radius", noun: "a radius", doc: "number | [tl,tr,br,bl]", paints: true }),
    {
      spec: "radiusCorners",
      label: "border-radius",
      parts: CORNERS,
      measured: "borderRadius",
      census: "borderRadius",
      parse: "corners",
      compare: "corners",
      tol: TOLERANCE.radius,
      as: "a px radius",
      noun: "a radius",
      paints: true
    }
  ] },
  { key: "gap", unit: "px", applies: ["leaf", "tableGap"], shapes: [field("gap", "gap", TOLERANCE.gap, { read: "gapVisual", nonNegative: true })] },
  { key: "width", unit: "px", box: true, applies: [...BOX_RULES, "textDiffers", "textBoxAbsent", "textOnContainer"], shapes: [
    field("width", "width (text ink)", TOLERANCE.textInk, { when: "textInk", read: "textBox", nonNegative: true }),
    field("width", "width", TOLERANCE.size, { read: "textBox", nonNegative: true })
  ] },
  { key: "height", unit: "px", box: true, applies: [...BOX_RULES, "textOnContainer", "textHeight"], shapes: [field("height", "height", TOLERANCE.size, { nonNegative: true })] },
  { key: "x", unit: "px", box: true, applies: [...BOX_RULES, "textDiffers", "textBoxAbsent", "textOnContainer"], shapes: [field("x", "x (frame-relative)", TOLERANCE.position, { read: "textBox" })] },
  { key: "y", unit: "px", box: true, applies: [...BOX_RULES, "textOnContainer"], shapes: [field("y", "y (frame-relative)", TOLERANCE.position)] },
  { key: "opacity", applies: ["revealed"], shapes: [field("opacity", "opacity", TOLERANCE.opacity, { nonNegative: true, paints: true })] },
  // a fixed-width TEXT's box in a parent that hugs its width: the width of the text's own element
  {
    key: "textBoxWidth",
    unit: "px",
    applies: ["boxOnContainer"],
    shapes: [{ spec: "boxWidth", label: "width (text box)", measured: "width", census: "width", parse: "px", compare: "textBox", tol: TOLERANCE.size, nonNegative: true }]
  },
  {
    key: "padding",
    unit: "px",
    applies: ["tableRow", ...BOX_RULES],
    shapes: [{ spec: "padding", label: "padding", measured: "padding", census: "padding", parse: "sides", compare: "padding", tol: TOLERANCE.padding, as: "px padding [t,r,b,l]", noun: "padding", doc: "[t,r,b,l]" }]
  },
  { key: "placeholderText", applies: [], shapes: [{
    spec: "placeholderText",
    label: "placeholder text",
    measured: "placeholderText",
    census: "placeholderText",
    parse: "string",
    compare: "placeholder",
    tol: null,
    doc: "el.placeholder",
    absentWhy: "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')",
    paints: true
  }] },
  { key: "text", applies: [], shapes: [{
    spec: "text",
    label: "text",
    measured: "text",
    census: "text",
    parse: "string",
    compare: "copy",
    tol: null,
    absent: "unlisted",
    nullWhy: "the probe reported text: null \u2014 an element with child elements still has text; report its textContent",
    paints: true
  }] },
  // the exported file this node draws: never a CSS property, so a probe that cannot say leaves it unverified, not unmeasured
  { key: "assetIdentity", optional: true, applies: [], shapes: [{
    spec: "assetIdentity",
    label: ASSET_IDENTITY,
    measured: "assetIdentity",
    census: "assetIdentity",
    parse: "string",
    compare: "asset",
    tol: null,
    doc: "{from, src?, id?, why?} \u2014 what draws the node and its content identity (content-hash.ts assetIdentity)",
    absentWhy: "the probe did not report which file this node draws (a native or hand-written measurement) \u2014 compare the asset by eye"
  }] }
];
var SHAPES = PROPERTIES.flatMap((p) => p.shapes.map((s) => ({ p, s })));
var isFieldKey = (k) => SHAPES.some(({ s }) => s.compare === "field" && s.spec === k);
var FIELDS = SHAPES.filter(({ s }) => s.compare === "field" && !s.when).flatMap(({ p, s }) => isFieldKey(s.spec) ? [{
  key: s.spec,
  tol: s.tol,
  ...p.norm ? { norm: p.norm } : {},
  label: s.label,
  ...p.unit ? { unit: p.unit } : {},
  ...p.high ? { high: true } : {},
  ...p.colour ? { colour: true } : {},
  ...p.box ? { box: true } : {},
  ...p.optional ? { optional: true } : {}
}] : []);
var STYLE_KEYS = [...FIELDS.map((f) => f.key), "borderWidths", "padding", "gapVisual", "text", "tag", "textBox", "placeholderText", "display", "assetIdentity"];
var STYLE_KEY_SHAPE = {
  ...Object.fromEntries(SHAPES.flatMap(({ s }) => s.doc ? [[s.measured, s.doc]] : [])),
  textBox: "{x,w} of a Range over the text",
  tag: "tagName, lower-case",
  display: "getComputedStyle(el).display"
};

// bridge/src/name-match.ts
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  let last = b.length;
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let diag = i - 1;
    let left = i;
    for (const [k, up] of row.slice(1).entries()) {
      const cur = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[k] ? 0 : 1));
      next.push(cur);
      diag = up;
      left = cur;
    }
    row = next;
    last = left;
  }
  return last;
}
var MAX_CANDIDATES = 3;
function nearestNames(ref2, names, max = MAX_CANDIDATES) {
  const r = ref2.toLowerCase();
  const scored = [...new Set(names)].map((n, i) => {
    const l = n.toLowerCase();
    return { n, i, contains: l.includes(r) || r.includes(l) ? 0 : 1, d: distance(r, l) };
  });
  scored.sort((a, b) => a.contains - b.contains || a.d - b.d || a.i - b.i);
  return scored.slice(0, max).map((s) => s.n);
}
function quoteList(names) {
  return names.map((n) => "'" + n + "'").join(", ");
}

// bridge/src/component-spec.ts
var PROP_REF_TYPES = {
  characters: "TEXT",
  visible: "BOOLEAN",
  mainComponent: "INSTANCE_SWAP"
};
var PROP_REF_FIELDS = ["characters", "visible", "mainComponent"];
var RESERVED_KEY_PREFIX = "dtwin/";
var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var at = (path6, name) => path6 + "[" + JSON.stringify(name) + "]";
function componentRootOf(spec) {
  if (!isObj(spec) || spec.type !== "COMPONENT" && spec.type !== "COMPONENT_SET") return null;
  return { type: spec.type, name: typeof spec.name === "string" ? spec.name : "" };
}
function propDefsOf(spec) {
  const p = spec.props;
  if (!isObj(p)) return [];
  const out = [];
  for (const k of Object.keys(p)) {
    const d = p[k];
    if (!isObj(d) || d.type !== "TEXT" && d.type !== "BOOLEAN" && d.type !== "INSTANCE_SWAP") continue;
    const def = { type: d.type, default: typeof d.default === "boolean" ? d.default : String(d.default) };
    if (Array.isArray(d.preferredValues)) def.preferredValues = d.preferredValues.filter((x) => typeof x === "string");
    out.push([k, def]);
  }
  return out;
}
function propDefComponents(spec) {
  const out = [];
  const add = (n) => {
    if (out.indexOf(n) < 0) out.push(n);
  };
  for (const [, d] of propDefsOf(spec)) {
    if (d.type !== "INSTANCE_SWAP") continue;
    if (typeof d.default === "string") add(d.default);
    for (const p of d.preferredValues || []) add(p);
  }
  return out;
}
var DEF_FIELDS = ["type", "default", "preferredValues"];
var PROTO_NAME = "'__proto__' cannot be a property name (Figma's message passing drops that key); pick another name";
function propDefsProblems(v, path6, columns) {
  const out = [];
  if (!isObj(v)) return [path6 + ": on a component, `props` declares its properties \u2014 an object of property name \u2192 {type, default}"];
  for (const name of Object.keys(v)) {
    const d = v[name];
    if (d === void 0) continue;
    const p = at(path6, name);
    if (!name.trim()) {
      out.push(path6 + ": has an empty property name");
      continue;
    }
    if (name === "__proto__") {
      out.push(p + ": " + PROTO_NAME);
      continue;
    }
    if (name.trim() !== name || !name) {
      out.push(p + ": a property's name cannot be empty or start or end with a space");
      continue;
    }
    if (name.indexOf("#") >= 0) {
      out.push(p + ": a property's name cannot hold '#' (Figma keeps it for the property's id)");
      continue;
    }
    if (columns.indexOf(name) >= 0) {
      out.push(p + ": '" + name + "' is a column of the variant table (a VARIANT property) already; give this property another name");
      continue;
    }
    if (!isObj(d)) {
      out.push(p + ": must be a definition {type, default} (TEXT, BOOLEAN or INSTANCE_SWAP)");
      continue;
    }
    for (const k of Object.keys(d)) {
      if (d[k] === void 0 || DEF_FIELDS.indexOf(k) >= 0) continue;
      const near2 = nearestNames(k, DEF_FIELDS);
      out.push(p + "." + k + ": not a field of a property definition" + (near2.length ? "; closest: " + quoteList(near2) : "") + " (it takes type, default, preferredValues)");
    }
    const t = d.type;
    if (t === "VARIANT") {
      out.push(p + ".type: a VARIANT property comes from the variant table (a COMPONENT_SET root's `columns` and `rows`), never from `props`");
      continue;
    }
    if (t === "SLOT") {
      out.push(p + ".type: a SLOT property cannot be written yet (TEXT, BOOLEAN and INSTANCE_SWAP can)");
      continue;
    }
    if (t !== "TEXT" && t !== "BOOLEAN" && t !== "INSTANCE_SWAP") {
      out.push(p + ".type: must be one of TEXT | BOOLEAN | INSTANCE_SWAP");
      continue;
    }
    const def = d.default;
    if (def === void 0) out.push(p + ": is missing default (" + (t === "TEXT" ? "the text an instance shows unless it sets its own" : t === "BOOLEAN" ? "true or false" : "the component an instance shows: its name, key or id") + ")");
    else if (t === "TEXT" && typeof def !== "string") out.push(p + ".default: a TEXT property's default is a string");
    else if (t === "BOOLEAN" && typeof def !== "boolean") out.push(p + ".default: a BOOLEAN property's default is true or false");
    else if (t === "INSTANCE_SWAP" && (typeof def !== "string" || !def.trim())) out.push(p + ".default: an INSTANCE_SWAP property's default is a component (its exact name, key or id)");
    const pv = d.preferredValues;
    if (pv !== void 0) {
      if (t !== "INSTANCE_SWAP") out.push(p + ".preferredValues: only an INSTANCE_SWAP property suggests components");
      else if (!Array.isArray(pv) || !pv.length || !pv.every((x) => typeof x === "string" && x.trim().length > 0)) out.push(p + ".preferredValues: must be a non-empty list of components (each its exact name, key or id)");
    }
  }
  return out;
}
function propRefsShape(v) {
  if (!isObj(v)) return "must be an object {characters?, visible?, mainComponent?} of the property each field follows";
  const fields = PROP_REF_FIELDS;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x === void 0) continue;
    if (fields.indexOf(k) < 0) {
      const near2 = nearestNames(k, fields);
      return "." + k + ": not a field a property drives" + (near2.length ? "; closest: " + quoteList(near2) : "") + " (characters, visible, mainComponent)";
    }
    if (typeof x !== "string" || !x.trim()) return "." + k + " must be a property's name (as the component root's `props` declares it)";
  }
  return null;
}
function variantColumns(name) {
  return name.split(", ").map((part) => {
    const i = part.indexOf("=");
    return i > 0 ? part.slice(0, i) : part;
  });
}

// bridge/src/tree-expand.ts
var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
var REPEAT_FIELDS = ["use", "fragments", "rows", "columns", "variant"];
var NOT_EDITED = ["use", "fragments", "edits", "key"];
var VARIANT_FIXED = {
  type: "every variant is a COMPONENT",
  name: "a variant's name is its row's values",
  children: "a variant's layers come from `variant`; change one with `edits` (its layer name \u2192 fields)",
  variant: "it is the set's",
  rows: "it is the set's",
  columns: "it is the set's",
  fragments: "fragments are defined once, on the spec's root",
  use: "a variant is not a fragment",
  key: "a component's name is its key",
  props: "the set declares the properties (the root's `props`)",
  component: "a variant is not an instance"
};
function put(o, k, v) {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}
function copy(v) {
  if (Array.isArray(v)) return v.map(copy);
  if (!isObj2(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) put(out, k, copy(v[k]));
  return out;
}
function repeats(v, depth) {
  if (depth > 200) return true;
  if (Array.isArray(v)) return v.some((x) => repeats(x, depth + 1));
  if (!isObj2(v)) return false;
  for (const k of REPEAT_FIELDS) if (v[k] !== void 0) return true;
  return Array.isArray(v.children) && v.children.some((c) => repeats(c, depth + 1));
}
function layersOf(n, out) {
  if (!isObj2(n)) return out;
  out.push(n);
  if (Array.isArray(n.children)) for (const c of n.children) layersOf(c, out);
  return out;
}
var propValue = (v) => typeof v === "string" || typeof v === "boolean";
function expandTree(spec, maxNodes) {
  const labels = /* @__PURE__ */ new Map();
  const problems = [];
  const warnings = [];
  if (!isObj2(spec) || !repeats(spec, 0)) return { tree: spec, problems, warnings, labels };
  const say = (m) => {
    problems.push(m);
  };
  const fragments = {};
  const defs = spec.fragments;
  if (defs !== void 0) {
    if (!isObj2(defs)) say("tree.fragments: must be an object of fragment name \u2192 node spec");
    else for (const name of Object.keys(defs)) {
      const f = defs[name];
      const at2 = "tree.fragments[" + JSON.stringify(name) + "]";
      if (!name.trim()) say("tree.fragments: a fragment name must be a non-empty string");
      else if (!isObj2(f)) say(at2 + ": must be a node spec");
      else if (f.key !== void 0) say(at2 + ".key: a key names a whole result, so only the spec's root carries it");
      else put(fragments, name, f);
    }
  }
  const used = /* @__PURE__ */ new Set();
  let count2 = 0;
  let tooMany = false;
  const applyEdits = (layers, edits, path6, of, inWhat) => {
    if (!isObj2(edits)) {
      say(path6 + ": must be an object of a layer name " + inWhat + " \u2192 the fields it changes");
      return;
    }
    for (const layer of Object.keys(edits)) {
      const fields = edits[layer];
      const at2 = path6 + "[" + JSON.stringify(layer) + "]";
      if (!isObj2(fields)) {
        say(at2 + ": must be an object of the fields to change");
        continue;
      }
      const hits = layers.filter((l) => l.name === layer);
      if (hits.length !== 1) {
        const names = layers.map((l) => l.name).filter((x) => typeof x === "string");
        say(at2 + ": " + (hits.length ? "matches " + hits.length + " layers of " + of + "; give them different names" : "no layer of " + of + " has that name" + (nearestNames(layer, names).length ? "; closest: " + quoteList(nearestNames(layer, names)) : "")));
        continue;
      }
      const target = hits[0];
      if (!target) continue;
      for (const k of Object.keys(fields)) {
        if (NOT_EDITED.indexOf(k) >= 0) {
          say(at2 + "." + k + ": an edit changes a layer's fields; `" + k + "` cannot be edited");
          continue;
        }
        const v = fields[k];
        if (v === null) delete target[k];
        else if (v !== void 0) put(target, k, copy(v));
      }
    }
  };
  const expand = (n, path6, stack, isRoot) => {
    if (tooMany) return [];
    if (!isObj2(n)) return [n];
    if (!isRoot && n.fragments !== void 0) say(path6 + ".fragments: fragments are defined once, on the spec's root");
    if (isRoot && n.type === "COMPONENT_SET") return variants(n, path6, stack);
    if (isRoot && n.type === "COMPONENT" && (n.variant !== void 0 || n.rows !== void 0 || n.columns !== void 0)) {
      say(path6 + ': a variant table (`variant`, `columns`, `rows`) makes a COMPONENT_SET; give the root `type: "COMPONENT_SET"`, or leave the table out for one component');
      return [];
    }
    if (n.variant !== void 0) say(path6 + ".variant: the base of a variant table, which only a COMPONENT_SET root has");
    if (n.use !== void 0) return place(n, path6, stack, isRoot);
    if (n.rows !== void 0) return spread(n, path6);
    if (n.columns !== void 0) say(path6 + ".columns: names the values of each row in `rows`, which this node does not have");
    if (++count2 > maxNodes) {
      tooMany = true;
      return [];
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "fragments" && k !== "children") put(out, k, copy(n[k]));
    if (Array.isArray(n.children)) {
      const kids = [];
      n.children.forEach((c, i) => {
        for (const x of expand(c, path6 + ".children[" + i + "]", stack, false)) kids.push(x);
      });
      out.children = kids;
    } else if (n.children !== void 0) out.children = copy(n.children);
    labels.set(out, path6);
    return [out];
  };
  const place = (n, path6, stack, isRoot) => {
    const name = n.use;
    if (typeof name !== "string" || !name.trim()) {
      say(path6 + ".use: must be a fragment's name");
      return [];
    }
    if (!own(fragments, name)) {
      const near2 = nearestNames(name, Object.keys(fragments));
      say(path6 + ".use: no fragment '" + name + "'" + (near2.length ? "; closest: " + quoteList(near2) : "; define it under the root's `fragments`"));
      return [];
    }
    if (stack.indexOf(name) >= 0) {
      say(path6 + ".use: fragment '" + name + "' uses itself (" + stack.concat(name).map((s) => "'" + s + "'").join(" \u2192 ") + ")");
      return [];
    }
    used.add(name);
    if (n.children !== void 0) say(path6 + ".children: a fragment's layers come from the fragment; change one with `edits` (its layer name \u2192 fields)");
    if (n.rows !== void 0 || n.columns !== void 0) say(path6 + ": `rows` is on an instance (a node with `component`), not on a fragment");
    const body = copy(fragments[name]);
    if (!isObj2(body)) return [];
    if (n.edits !== void 0) applyEdits(layersOf(body, []), n.edits, path6 + ".edits", "fragment '" + name + "'", "in the fragment");
    for (const k of Object.keys(n)) {
      if (k === "use" || k === "edits" || k === "children" || k === "fragments" && isRoot) continue;
      if (n[k] !== void 0) put(body, k, copy(n[k]));
    }
    if (isRoot && (body.type === "COMPONENT" || body.type === "COMPONENT_SET")) {
      say(path6 + ": a component is written at the root itself (`type`, `name`, its fields), not placed from a fragment");
      return [];
    }
    return expand(body, path6 + " (fragment '" + name + "')", stack.concat(name), isRoot);
  };
  const variants = (n, path6, stack) => {
    const before = problems.length;
    const base = n.variant;
    const cols = n.columns;
    const rows = n.rows;
    if (n.children !== void 0) say(path6 + ".children: a component set's variants come from its table: `variant` (what every variant starts from), `columns` and one row of values per variant");
    if (n.use !== void 0) say(path6 + ".use: a component set is not a fragment");
    if (!isObj2(base)) say(path6 + ".variant: must be the node spec every variant starts from (a component's own fields and its `children`)");
    else {
      if (base.type !== void 0 && base.type !== "COMPONENT") say(path6 + ".variant.type: every variant is a COMPONENT, so the field is not needed");
      if (base.name !== void 0) say(path6 + ".variant.name: a variant's name is its row's values (\"Size=md, State=default\"); leave `name` out");
      if (base.handle !== void 0) say(path6 + '.variant.handle: a handle names one variant, and every variant starts from the base; give it in that row\'s object (`["md", "default", {"handle": "primary"}]`)');
      for (const k of ["key", "props", "use", "rows", "columns", "fragments", "variant", "component"]) {
        const why = VARIANT_FIXED[k];
        if (base[k] !== void 0 && why !== void 0) say(path6 + ".variant." + k + ": not on a variant \u2014 " + why);
      }
    }
    if (!Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === "string" && c.trim().length > 0)) say(path6 + '.columns: must be a non-empty list of the variant properties, e.g. ["Size", "State"]');
    else {
      if (new Set(cols).size !== cols.length) say(path6 + ".columns: names a property twice");
      const padded = cols.findIndex((c) => String(c).trim() !== c);
      if (padded >= 0) say(path6 + ".columns[" + padded + "]: a variant property's name cannot start or end with a space");
      const proto = cols.indexOf("__proto__");
      if (proto >= 0) say(path6 + ".columns[" + proto + "]: " + PROTO_NAME);
      const odd = cols.findIndex((c) => /[=,]/.test(String(c)));
      if (odd >= 0) say(path6 + ".columns[" + odd + `]: a variant property's name cannot hold '=' or ',' (Figma writes a variant's name as "Size=md, State=default")`);
    }
    if (!Array.isArray(rows) || !rows.length) say(path6 + ".rows: must be a non-empty list of rows, each its variant's values in column order (and, last, an optional object of the fields that variant changes)");
    if (problems.length !== before || !isObj2(base) || !Array.isArray(cols) || !Array.isArray(rows)) return [];
    const names = cols.map(String);
    const seen = /* @__PURE__ */ new Map();
    const kids = [];
    const table = rows;
    table.forEach((row, i) => {
      const r = path6 + ".rows[" + i + "]";
      const shape = "a list of " + names.length + " value" + (names.length === 1 ? "" : "s") + ", one per column (" + quoteList(names) + "), then optionally an object of the fields this variant changes";
      if (!Array.isArray(row)) {
        say(r + ": must be " + shape);
        return;
      }
      const cells = row;
      const last = cells[names.length];
      const over = cells.length === names.length + 1 && isObj2(last) ? last : null;
      if (cells.length !== names.length && !over) {
        say(r + ": must be " + shape);
        return;
      }
      const values = cells.slice(0, names.length);
      const bad = values.findIndex((v2) => typeof v2 !== "string" || !v2.trim() || v2.trim() !== v2 || /[=,]/.test(v2));
      if (bad >= 0) {
        const v2 = values[bad];
        say(r + "[" + bad + "]: " + (typeof v2 !== "string" ? "must be a string (the variant's value of '" + String(names[bad]) + "')" : !v2.trim() ? "must be a non-empty value" : v2.trim() !== v2 ? "cannot start or end with a space (Figma trims a variant's values)" : `cannot hold '=' or ',' (Figma writes a variant's name as "Size=md, State=default")`));
        return;
      }
      const name = names.map((c, j) => c + "=" + String(values[j])).join(", ");
      const dup = seen.get(name);
      if (dup !== void 0) {
        say(r + ": " + name + " is rows[" + dup + "]'s combination too; each variant needs its own");
        return;
      }
      seen.set(name, i);
      const v = copy(base);
      if (!isObj2(v)) return;
      put(v, "type", "COMPONENT");
      put(v, "name", name);
      if (over) {
        for (const k of Object.keys(over)) {
          const x = over[k];
          if (k === "edits" || x === void 0) continue;
          const why = own(VARIANT_FIXED, k) ? VARIANT_FIXED[k] : void 0;
          if (why !== void 0) {
            say(r + "." + k + ": a row cannot change it \u2014 " + why);
            continue;
          }
          if (x === null) delete v[k];
          else put(v, k, copy(x));
        }
        if (over.edits !== void 0) applyEdits(layersOf(v, []).slice(1), over.edits, r + ".edits", "the base `variant`", "in the base `variant`");
      }
      for (const x of expand(v, r + " (variant '" + name + "')", stack, false)) kids.push(x);
    });
    if (++count2 > maxNodes) {
      tooMany = true;
      return [];
    }
    const out = {};
    for (const k of Object.keys(n)) if (k !== "variant" && k !== "rows" && k !== "columns" && k !== "children" && k !== "fragments") put(out, k, copy(n[k]));
    out.children = kids;
    labels.set(out, path6);
    return [out];
  };
  const spread = (n, path6) => {
    const at2 = path6 + ".rows";
    if (n.component === void 0 || n.type !== void 0 && n.type !== "INSTANCE") {
      say(at2 + ": a row table is on an instance (a node with `component`); repeat other parts with a fragment (`use`)");
      return [];
    }
    if (n.handle !== void 0) say(path6 + ".handle: a handle names one node, and a row table makes several; leave it out");
    if (n.children !== void 0) say(path6 + ".children: an instance's layers come from its component");
    const cols = n.columns;
    if (cols !== void 0 && (!Array.isArray(cols) || !cols.length || !cols.every((c) => typeof c === "string" && c.trim().length > 0))) {
      say(path6 + ".columns: must be a non-empty list of property names");
      return [];
    }
    if (Array.isArray(cols) && new Set(cols).size !== cols.length) {
      say(path6 + ".columns: names a property twice");
      return [];
    }
    const rows = n.rows;
    if (!Array.isArray(rows) || !rows.length) {
      say(at2 + ": must be a non-empty list of rows" + (Array.isArray(cols) ? " (each a list of values, one per column)" : " (each an object of property name \u2192 value)"));
      return [];
    }
    if (n.props !== void 0 && !isObj2(n.props)) {
      say(path6 + ".props: must be an object of property name \u2192 value (the values every row shares)");
      return [];
    }
    const base = isObj2(n.props) ? n.props : {};
    const out = [];
    rows.forEach((row, i) => {
      const r = at2 + "[" + i + "]";
      let props = null;
      if (Array.isArray(cols)) {
        if (!Array.isArray(row) || row.length !== cols.length) {
          say(r + ": must be a list of " + cols.length + " value" + (cols.length === 1 ? "" : "s") + ", one per column (" + quoteList(cols.map(String)) + ")");
          return;
        }
        const bad = row.findIndex((v) => !propValue(v));
        if (bad >= 0) {
          say(r + "[" + bad + "]: must be a string (a variant's value, a text) or a boolean");
          return;
        }
        props = {};
        for (const [j, c] of cols.entries()) put(props, String(c), row[j]);
      } else {
        if (!isObj2(row)) {
          say(r + ": must be an object of property name \u2192 value (or give `columns` and a list of values)");
          return;
        }
        const bad = Object.keys(row).find((k) => !propValue(row[k]) || !k.trim());
        if (bad !== void 0) {
          say(r + (bad.trim() ? "." + bad + ": must be a string (a variant's value, a text) or a boolean" : ": has an empty property name"));
          return;
        }
        props = row;
      }
      if (++count2 > maxNodes) {
        tooMany = true;
        return;
      }
      const inst = {};
      for (const k of Object.keys(n)) if (k !== "rows" && k !== "columns" && k !== "props" && k !== "handle") put(inst, k, copy(n[k]));
      const merged = {};
      for (const src of [base, props]) for (const k of Object.keys(src)) put(merged, k, copy(src[k]));
      inst.props = merged;
      labels.set(inst, r);
      out.push(inst);
    });
    return out;
  };
  const [root] = expand(spec, "tree", [], true);
  if (tooMany) say("tree: more than " + maxNodes + " nodes once its fragments and rows are expanded \u2014 send a large screen as several trees");
  for (const name of Object.keys(fragments)) if (!used.has(name)) warnings.push("tree.fragments[" + JSON.stringify(name) + "]: no node uses it, so it is not built");
  return { tree: root === void 0 ? {} : root, problems, warnings, labels };
}

// bridge/src/image-spec.ts
var IMAGE_HASH = /^[0-9a-f]{40}$/;
var IMAGE_ID = /^[0-9a-f]{64}$/;
var IMAGE_BYTES_REASON = "an image is a path on disk (`file`, read by the server) or the hash of an image already in the file (`hash`); its bytes never go in a spec";
var IMAGE_BYTES_KEYS = ["data", "bytes", "base64", "src", "url"];
var isObj3 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isInlineOrUrl = (v) => /^\s*data:/i.test(v) || /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(v);
var MAX_IMAGE_PATH = 1024;
var isBareBase64 = (v) => {
  const s = v.trim();
  return /^(iVBORw0KGgo|\/9j\/|R0lGOD)/.test(s) || s.length >= 64 && s.indexOf(".") < 0 && /^[A-Za-z0-9+/\s]+={0,2}$/.test(s);
};
var isImagePaint = (v) => isObj3(v) && v.type === "image";
var PAINT_LISTS = ["fills", "paints"];
function mapImagePaints(v, at2, fn) {
  const map = (x, p) => {
    if (Array.isArray(x)) {
      let copy3 = null;
      for (let i = 0; i < x.length; i++) {
        const y = map(x[i], p + "[" + i + "]");
        if (y !== x[i]) {
          if (!copy3) copy3 = x.slice();
          copy3[i] = y;
        }
      }
      return copy3 || x;
    }
    if (!isObj3(x)) return x;
    let copy2 = null;
    for (const k of Object.keys(x)) {
      const val = x[k];
      const kp = p + "." + k;
      let next = val;
      if (PAINT_LISTS.indexOf(k) >= 0 && Array.isArray(val)) {
        let list = null;
        for (let i = 0; i < val.length; i++) {
          const paint2 = val[i];
          const r = isImagePaint(paint2) ? fn(paint2, kp + "[" + i + "]") : null;
          if (r !== null) {
            if (!list) list = val.slice();
            list[i] = r;
          }
        }
        next = list || val;
      } else next = map(val, kp);
      if (next !== val) {
        if (!copy2) copy2 = { ...x };
        copy2[k] = next;
      }
    }
    return copy2 || x;
  };
  return map(v, at2);
}
function inlineImageProblem(p) {
  for (const k of IMAGE_BYTES_KEYS) if (p[k] !== void 0) return "." + k + ": " + IMAGE_BYTES_REASON;
  for (const k of ["file", "hash"]) {
    const v = p[k];
    if (typeof v === "string" && isInlineOrUrl(v)) return "." + k + ": is " + (/^\s*data:/i.test(v) ? "a data: URI" : "a URL") + "; " + IMAGE_BYTES_REASON;
  }
  const f = p.file;
  if (typeof f === "string" && isBareBase64(f)) return ".file: is base64 text, not a path; " + IMAGE_BYTES_REASON;
  if (typeof f === "string" && f.length > MAX_IMAGE_PATH) return ".file: is " + f.length + " characters, longer than a path (" + MAX_IMAGE_PATH + "); " + IMAGE_BYTES_REASON;
  return null;
}

// bridge/src/tree-spec.ts
var NUMBER_TOKEN_FIELDS = [
  "itemSpacing",
  "counterAxisSpacing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "topLeftRadius",
  "topRightRadius",
  "bottomRightRadius",
  "bottomLeftRadius",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "strokeWeight",
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
  "opacity"
];
var MAX_TREE_NODES = 500;
var MAX_TREE_DEPTH = 40;
var MAX_KEY_LENGTH = 200;
var DEFAULT_FONT = { family: "Inter", weight: "Regular" };
var NOT_YET = { refuse: "" };
var refuse = (why) => ({ refuse: why });
var isRefuse = (r) => typeof r !== "function";
var isObj4 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
var str = (v) => typeof v === "string" ? null : "must be a string";
var num = (v) => isNum(v) ? null : "must be a number";
var nonNeg = (v) => isNum(v) && v >= 0 ? null : "must be a number \u2265 0";
var MIN_SIZE = 0.01;
var size = (v) => isNum(v) && v >= MIN_SIZE ? null : "must be a number \u2265 " + MIN_SIZE;
var nonEmpty = (v) => typeof v === "string" && v.trim().length > 0 ? null : "must be a non-empty string";
var count = (v) => isNum(v) && Number.isInteger(v) && v >= 1 ? null : "must be a whole number \u2265 1";
var positive = (v) => isNum(v) && v > 0 ? null : "must be a number > 0 (leave it out for no limit)";
var unit = (v) => isNum(v) && v >= 0 && v <= 1 ? null : "must be a number from 0 to 1";
var trueOnly = (v) => v === true ? null : "must be true (omit it for false)";
var oneOf = (...vals) => (v) => typeof v === "string" && vals.includes(v) ? null : "must be one of " + vals.join(" | ");
var hex = (v) => parseHexColor(v) ? null : "is not " + HEX_COLOR_HINT;
var fourNums = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => isNum(n) && n >= 0) ? null : "must be four numbers \u2265 0 [top, right, bottom, left]";
var firstOr = (list) => {
  for (const e of list) if (e !== null) return e;
  return null;
};
var objOf = (rules) => (v) => isObj4(v) ? firstOr(objectProblems(v, rules, "")) : "must be an object";
var LAYOUT_RULES = {
  display: (v) => v === "flex" ? null : v === "grid" ? "'grid' cannot be written yet (flex can)" : 'must be "flex"',
  mode: oneOf("absolute"),
  width: size,
  height: size,
  flexDirection: oneOf("row", "column"),
  gap: num,
  padding: fourNums,
  justifyContent: oneOf("flex-start", "center", "flex-end", "space-between", "space-evenly", "space-around"),
  alignItems: oneOf("flex-start", "center", "flex-end", "baseline"),
  flexWrap: oneOf("wrap"),
  rowGap: nonNeg,
  columnGap: nonNeg,
  alignContent: oneOf("space-between"),
  reverseZ: trueOnly,
  inferred: refuse("it says the read guessed the auto-layout; a write sets a real one"),
  columns: refuse("grid layout cannot be written yet"),
  rows: refuse("grid layout cannot be written yet"),
  columnSizes: refuse("grid layout cannot be written yet"),
  rowSizes: refuse("grid layout cannot be written yet"),
  autoFlow: refuse("grid layout cannot be written yet"),
  autoTracks: refuse("grid layout cannot be written yet")
};
var LENGTH = (units, value = num) => (v) => {
  if (!isObj4(v)) return "must be an object {unit, value}";
  const bad = objOf({ unit: oneOf(...units), value })(v);
  if (bad !== null) return bad;
  return v.unit === void 0 ? "is missing unit" : v.value === void 0 ? "is missing value" : null;
};
var FONT_RULES = {
  size: (v) => v === "mixed" ? "'mixed' cannot be written (one size per text node)" : isNum(v) && v >= 1 ? null : "must be a number \u2265 1",
  family: nonEmpty,
  weight: nonEmpty,
  color: hex,
  align: oneOf("left", "center", "right", "justified"),
  valign: oneOf("center", "bottom"),
  lineHeight: (v) => {
    if (!isObj4(v) || v.unit !== "auto") return LENGTH(["px", "percent"], nonNeg)(v);
    const extra = Object.keys(v).filter((k) => k !== "unit" && v[k] !== void 0);
    return extra.length ? "." + extra[0] + ': not a field of an `auto` line height (it is `{unit:"auto"}` alone)' : null;
  },
  letterSpacing: LENGTH(["px", "percent"]),
  case: oneOf("upper", "lower", "title", "small_caps", "small_caps_forced"),
  decoration: oneOf("underline", "strikethrough"),
  // The read writes it on every text; it follows the style named in `weight`, so it is accepted and sets nothing.
  // No upper bound: Figma takes a `wght` axis past 1000 (seen live: 5000) and the read then writes that weight.
  weightValue: (v) => isNum(v) && v > 0 ? null : "must be a number > 0 (it follows `weight`, and sets nothing)",
  variationSettings: (v) => {
    if (!isObj4(v)) return 'must be an object of axis tag \u2192 number, e.g. {"wght": 560}';
    for (const [k, x] of Object.entries(v)) if (!isNum(x)) return "." + k + " must be a number";
    return null;
  },
  fontStyle: refuse('italic is part of the style name in `weight`, e.g. "Italic"'),
  decorationStyle: NOT_YET,
  decorationColor: NOT_YET,
  decorationThickness: NOT_YET,
  decorationOffset: NOT_YET,
  decorationSkipInk: NOT_YET,
  openType: NOT_YET,
  openTypeOff: NOT_YET,
  paragraphSpacing: NOT_YET,
  paragraphIndent: NOT_YET,
  listSpacing: NOT_YET,
  leadingTrim: NOT_YET,
  textWrap: NOT_YET,
  hangingList: NOT_YET,
  hangingPunctuation: NOT_YET
};
var SIDES = { top: nonNeg, right: nonNeg, bottom: nonNeg, left: nonNeg };
var STROKE_RULES = {
  colors: (v) => Array.isArray(v) && v.length > 0 ? firstOr(v.map(hex)) : "must be a non-empty list of hex colours",
  weight: nonNeg,
  weights: objOf(SIDES),
  align: oneOf("inside", "outside", "center"),
  paints: refuse("only solid stroke `colors` can be written yet"),
  // The read writes `{profile:"uniform"}` on an ordinary stroke: that default is accepted (it sets nothing); a taper is not yet.
  variableWidth: (v) => isObj4(v) && v.profile === "uniform" && Object.keys(v).every((k) => k === "profile") ? null : 'only the default {profile:"uniform"} can be written yet (a tapered or custom-width stroke cannot)',
  dash: NOT_YET,
  cap: NOT_YET,
  join: NOT_YET,
  miter: NOT_YET,
  complex: NOT_YET
};
var BOX_RULES2 = {
  w: size,
  h: size,
  // The read's page coordinates of the node's own `x`/`y` (written alongside them): accepted, and they set nothing.
  x: num,
  y: num
};
var RADIUS_RULES = { tl: nonNeg, tr: nonNeg, br: nonNeg, bl: nonNeg };
var LIMIT_RULES = { minWidth: positive, maxWidth: positive, minHeight: positive, maxHeight: positive };
var RENDER_BOX_RULES = { x: num, y: num, w: nonNeg, h: nonNeg };
var FILL_RULES = {
  type: (v) => v === "solid" || v === "image" ? null : typeof v === "string" ? "'" + v + "' cannot be written yet (solid and image can)" : 'must be "solid" or "image"',
  color: hex,
  opacity: unit,
  tokens: (v) => {
    if (!isObj4(v)) return "must be an object {color: variable}";
    const bad = firstOr(objectProblems(v, PAINT_TOKEN_RULES, ""));
    return bad !== null ? bad : v.color === void 0 ? "is missing color (the colour variable's name, key or id)" : null;
  },
  blend: NOT_YET,
  visible: refuse("an invisible paint is never written; leave it out")
};
var IMAGE_FILL_RULES = {
  type: oneOf("image"),
  file: (v) => typeof v === "string" && v.trim().length > 0 ? null : "must be the path of an image file (PNG, JPEG or GIF), relative to the directory the server was started in",
  hash: (v) => typeof v === "string" && IMAGE_HASH.test(v) ? null : "is not an image hash (40 lowercase hex characters: the `hash` an image fill has in the read)",
  // Put there by the MCP server once it has read `file` (image-file.ts): the id of the bytes it sends beside the ops.
  image: (v) => typeof v === "string" && IMAGE_ID.test(v) ? null : "is set by the server (the id of the bytes it read from `file`); leave it out",
  scaleMode: (v) => v === "crop" ? "'crop' cannot be written yet (fill, fit and tile can)" : oneOf("fill", "fit", "tile")(v),
  scale: (v) => isNum(v) && v > 0 ? null : "must be a number > 0 (the tile's scale)",
  opacity: unit,
  // The read writes it (the image's own size): accepted, and it sets nothing.
  intrinsicSize: (v) => isObj4(v) ? objOf({ w: nonNeg, h: nonNeg })(v) : "must be an object {w, h} (it sets nothing)",
  transform: refuse("an image's crop cannot be written yet"),
  rotation: NOT_YET,
  filters: NOT_YET,
  tokens: refuse("an image paint has no colour to bind to a variable"),
  color: refuse("an image paint has no colour; a solid paint has"),
  blend: NOT_YET,
  visible: refuse("an invisible paint is never written; leave it out"),
  data: refuse(IMAGE_BYTES_REASON),
  bytes: refuse(IMAGE_BYTES_REASON),
  base64: refuse(IMAGE_BYTES_REASON),
  src: refuse(IMAGE_BYTES_REASON),
  url: refuse(IMAGE_BYTES_REASON)
};
function imageFillProblem(p) {
  const inline = inlineImageProblem(p);
  if (inline !== null) return inline;
  const bad = objectProblems(p, IMAGE_FILL_RULES, "")[0];
  if (bad) return bad;
  if (p.file !== void 0 && p.hash !== void 0) return "gives both `file` and `hash`; an image is one of them";
  if (p.file === void 0 && p.hash === void 0) return p.image !== void 0 ? ".image: is set by the server (the id of the bytes it read from `file`); give `file`" : "is missing `file` (a path to a PNG, JPEG or GIF on disk) or `hash` (an image already in the file)";
  if (p.file !== void 0 && p.image === void 0) return ".file: an image file is read by figma_write on the MCP server, which sends its bytes with the batch; this one came without them";
  if (p.hash !== void 0 && p.image !== void 0) return ".image: is set by the server for a `file`; a `hash` paint has none";
  if (p.scale !== void 0 && p.scaleMode !== "tile") return `.scale: is the tile's scale; give scaleMode "tile" with it`;
  return null;
}
var fillsCheck = (v) => {
  if (!Array.isArray(v)) return 'must be a list of paints ({type:"solid", color} or {type:"image", file | hash})';
  for (const [i, p] of v.entries()) {
    if (!isObj4(p)) return "[" + i + "] must be a paint object";
    if (p.type === void 0 && (p.file !== void 0 || p.hash !== void 0)) return "[" + i + '] is missing type: "image"';
    if (p.type === "image") {
      const img = imageFillProblem(p);
      if (img !== null) return "[" + i + "]" + (img.startsWith(".") ? "" : " ") + img;
      continue;
    }
    const bad = objectProblems(p, FILL_RULES, "")[0];
    if (bad) return "[" + i + "]" + (bad.startsWith(".") ? "" : " ") + bad;
    if (p.color === void 0 && p.tokens === void 0) return "[" + i + "] is missing color (a hex colour, or a colour variable in `tokens.color`)";
  }
  return null;
};
var ref = nonEmpty;
var refs = (v) => typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? firstOr(v.map((x, i) => {
  const bad = ref(x);
  return bad === null ? null : "[" + i + "] " + bad;
})) : "must be a variable's name, key or id, or a non-empty list of them";
var PAINT_TOKEN_RULES = { color: ref };
var TOKEN_RULES = {
  ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, ref])),
  fills: refs,
  strokes: refs,
  characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
  visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
  cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius")
};
var FRAME_TOKENS = [...NUMBER_TOKEN_FIELDS, "fills", "strokes"];
var TEXT_TOKENS = ["width", "height", "opacity", "strokeWeight", "fills", "strokes"];
var INSTANCE_TOKENS = ["width", "height", "opacity"];
var STYLE_RULES = {
  text: ref,
  fill: refuse("bind the paint to a colour variable instead: `fills[].tokens.color`"),
  stroke: refuse("bind the strokes to colour variables instead: `tokens.strokes`"),
  effect: refuse("effects cannot be written yet"),
  grid: refuse("layout grids cannot be written yet")
};
var propsCheck = (v) => {
  if (!isObj4(v)) return "must be an object of property name \u2192 value";
  for (const [k, x] of Object.entries(v)) {
    if (!k.trim()) return "has an empty property name";
    if (x !== void 0 && typeof x !== "string" && typeof x !== "boolean") return "." + k + " must be a string (a variant's value, a text, a swap's component) or a boolean";
  }
  return null;
};
var DS_REF = "binding a text field to a variable cannot be written yet; name a text style in `styles.text`";
var NODE_RULES = {
  type: str,
  children: (v) => Array.isArray(v) ? null : "must be a list of nodes",
  name: str,
  // "__proto__" is refused: Figma's own main-thread → UI message copy drops a key of that name (seen live), so the
  // reply could not carry it back however the plugin builds it.
  handle: (v) => typeof v !== "string" || v.length === 0 ? "must be a non-empty string" : v === "__proto__" ? "'__proto__' cannot be a handle (Figma's message passing drops that key); pick another name" : null,
  // Stored on the node as plugin data (an entry is capped at 100 kB by Figma; a key is far below it).
  key: (v) => typeof v !== "string" || !v.trim() ? "must be a non-empty string" : v.length > MAX_KEY_LENGTH ? "must be at most " + MAX_KEY_LENGTH + " characters" : v.indexOf(RESERVED_KEY_PREFIX) === 0 ? "cannot start with '" + RESERVED_KEY_PREFIX + "' (the plugin keeps it for the components it builds)" : null,
  id: refuse("a new node gets its id from Figma; give it a `handle` to get the id back"),
  hidden: trueOnly,
  x: num,
  y: num,
  box: objOf(BOX_RULES2),
  layout: objOf(LAYOUT_RULES),
  absolute: trueOnly,
  grow: (v) => v === 0 || v === 1 ? null : "must be 0 or 1",
  alignSelf: oneOf("min", "center", "max", "stretch"),
  widthMode: oneOf("fill", "hug"),
  heightMode: oneOf("fill", "hug"),
  sizeLimits: objOf(LIMIT_RULES),
  clip: trueOnly,
  fills: fillsCheck,
  strokes: objOf(STROKE_RULES),
  radius: (v) => isNum(v) ? nonNeg(v) : objOf(RADIUS_RULES)(v),
  opacity: unit,
  text: str,
  font: objOf(FONT_RULES),
  autoResize: oneOf("width_and_height", "height", "truncate"),
  truncate: trueOnly,
  maxLines: count,
  component: ref,
  props: propsCheck,
  tokens: objOf(TOKEN_RULES),
  styles: objOf(STYLE_RULES),
  // Read fields a write does not set (yet). Each is refused by name.
  propTokens: refuse("a property bound to a variable cannot be written yet; give its value in `props`"),
  mainComponent: refuse("name the component in `component` (its name, key or id)"),
  propRefs: propRefsShape,
  overrides: NOT_YET,
  exposedInstances: NOT_YET,
  detachedFrom: NOT_YET,
  renderBox: objOf(RENDER_BOX_RULES),
  // it follows `box`: accepted, sets nothing
  layoutGrids: NOT_YET,
  scroll: NOT_YET,
  gridColumnSpan: NOT_YET,
  gridRowSpan: NOT_YET,
  gridColumnStart: NOT_YET,
  gridRowStart: NOT_YET,
  gridJustifySelf: NOT_YET,
  gridAlignSelf: NOT_YET,
  pin: NOT_YET,
  fixedChildren: NOT_YET,
  strokesInLayout: trueOnly,
  effects: NOT_YET,
  radiusFull: refuse("set `radius` to the size it should render at"),
  rotation: NOT_YET,
  flipped: NOT_YET,
  skew: NOT_YET,
  blendMode: NOT_YET,
  mask: NOT_YET,
  maskType: NOT_YET,
  cornerSmoothing: NOT_YET,
  aspectRatio: NOT_YET,
  arc: NOT_YET,
  shape: NOT_YET,
  booleanOp: NOT_YET,
  exportSettings: NOT_YET,
  overlay: NOT_YET,
  textTokens: refuse(DS_REF),
  reactions: NOT_YET,
  variableModes: refuse("set a frame's mode with a setVariableMode op after the tree lands"),
  resolvedModes: refuse("it is read-only (what the frame inherits)"),
  annotations: NOT_YET,
  devStatus: NOT_YET,
  devStatusNote: NOT_YET,
  css: refuse("it is read-only"),
  pluginData: NOT_YET,
  sharedData: NOT_YET,
  motion: NOT_YET,
  asset: refuse('an image is a fill: `fills: [{type: "image", file}]` (a path on disk) or `{type: "image", hash}` (one already in the file)'),
  assetSkipped: refuse("it is read-only"),
  assetFrom: refuse("it is read-only"),
  sourceTransform: refuse("it is read-only"),
  geometry: NOT_YET,
  tableCells: NOT_YET,
  reference: str,
  // the read's path to its reference PNG: accepted, sets nothing
  devResources: NOT_YET,
  runs: refuse("mixed-format text comes in a later write step; give one `font`"),
  href: NOT_YET,
  linkNode: NOT_YET,
  list: NOT_YET,
  indent: NOT_YET,
  textStyleOverrides: refuse("it is read-only (which fields differ from the text style)"),
  missingFont: refuse("it is read-only")
};
var settable = (rules, k) => {
  const r = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : void 0;
  return r !== void 0 && !isRefuse(r);
};
function objectProblems(o, rules, path6) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === void 0) continue;
    const at2 = path6 + "." + k;
    const rule = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : void 0;
    if (rule === void 0) {
      const near2 = nearestNames(k, Object.keys(rules).filter((r) => {
        const x = rules[r];
        return x !== void 0 && !isRefuse(x);
      }));
      out.push(at2 + ": not a field the write accepts" + (near2.length ? "; closest: " + quoteList(near2) : ""));
    } else if (isRefuse(rule)) {
      out.push(at2 + ": a read field a write cannot set yet" + (rule.refuse ? " \u2014 " + rule.refuse : ""));
    } else {
      const bad = rule(v);
      if (bad !== null) out.push(at2 + (bad.startsWith(".") || bad.startsWith("[") ? "" : " ") + bad);
    }
  }
  return out;
}
function nodeKind(n) {
  if (n.clone !== void 0) return n.type === void 0 ? "CLONE" : null;
  if (n.type === void 0) return n.component !== void 0 ? "INSTANCE" : n.text !== void 0 ? "TEXT" : "FRAME";
  if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") return "FRAME";
  return n.type === "FRAME" || n.type === "TEXT" || n.type === "INSTANCE" ? n.type : null;
}
var INSTANCE_FIELDS = /* @__PURE__ */ new Set([
  "type",
  "component",
  "props",
  "name",
  "handle",
  "hidden",
  "x",
  "y",
  "box",
  "renderBox",
  "reference",
  "absolute",
  "grow",
  "alignSelf",
  "widthMode",
  "heightMode",
  "opacity",
  "tokens",
  "propRefs"
]);
var STYLE_FONT_FIELDS = ["family", "weight", "size", "lineHeight", "letterSpacing", "case", "decoration", "variationSettings"];
var SIDE_PAD = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
var CORNERS2 = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]];
var STROKE_SIDES = [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]];
var nameList = (v) => typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
function unboundOf(n, kind) {
  const t = isObj4(n.tokens) ? n.tokens : {};
  const has = (k) => t[k] !== void 0;
  let c = 0;
  if (Array.isArray(n.fills)) {
    for (const p of n.fills) if (isObj4(p) && p.type !== "image" && p.tokens === void 0) c++;
  }
  if (kind === "TEXT") {
    const styled = isObj4(n.styles) && n.styles.text !== void 0;
    if (!styled) c++;
    if (n.fills === void 0 && !has("fills") && isObj4(n.font) && n.font.color !== void 0) c++;
  }
  const st = isObj4(n.strokes) ? n.strokes : null;
  if (st) {
    if (Array.isArray(st.colors) && !has("strokes")) c += st.colors.length;
    if (st.weight !== void 0 && !has("strokeWeight")) c++;
    if (isObj4(st.weights)) {
      for (const [side, field2] of STROKE_SIDES) if (st.weights[side] !== void 0 && !has(field2)) c++;
    }
  }
  const l = isObj4(n.layout) ? n.layout : null;
  if (l && l.display === "flex") {
    if (l.gap !== void 0 && !has("itemSpacing")) c++;
    if (Array.isArray(l.padding)) SIDE_PAD.forEach((f) => {
      if (!has(f)) c++;
    });
    const track = l.flexDirection === "column" ? l.columnGap : l.rowGap;
    if (l.flexWrap !== void 0 && track !== void 0 && !has("counterAxisSpacing")) c++;
  }
  if (typeof n.radius === "number") {
    if (!CORNERS2.every(([, f]) => has(f))) c++;
  } else if (isObj4(n.radius)) {
    for (const [k, f] of CORNERS2) if (n.radius[k] !== void 0 && !has(f)) c++;
  }
  return c;
}
var isFlex = (n) => isObj4(n.layout) && n.layout.display === "flex";
function fontOf(font) {
  return { family: font && font.family !== void 0 ? font.family : DEFAULT_FONT.family, weight: font && font.weight !== void 0 ? font.weight : DEFAULT_FONT.weight };
}
function tokenProblems(n, t, kind, flex, inFlex, say) {
  const fits = kind === "FRAME" ? FRAME_TOKENS : kind === "TEXT" ? TEXT_TOKENS : INSTANCE_TOKENS;
  const l = isObj4(n.layout) ? n.layout : {};
  for (const k of Object.keys(t)) {
    if (t[k] === void 0 || !settable(TOKEN_RULES, k)) continue;
    const at2 = "`tokens." + k + "`";
    if (fits.indexOf(k) < 0) {
      say(at2 + " is not on a" + (kind === "INSTANCE" ? "n " : " ") + kind + " node" + (kind === "INSTANCE" ? " (its content comes from its component)" : ""));
      continue;
    }
    if ((k === "itemSpacing" || k.startsWith("padding")) && !flex) say(at2 + ' needs auto-layout on the node (layout.display "flex")');
    if (k === "counterAxisSpacing" && (!flex || l.flexWrap === void 0)) say(at2 + ' is the gap between wrapped tracks: it needs `layout.flexWrap: "wrap"`');
    if (k === "width" && n.widthMode !== void 0) say(at2 + " sizes the node, which `widthMode` already does; leave one out");
    if (k === "height" && n.heightMode !== void 0) say(at2 + " sizes the node, which `heightMode` already does; leave one out");
    if ((k === "minWidth" || k === "maxWidth" || k === "minHeight" || k === "maxHeight") && !flex && !inFlex) say(at2 + " needs auto-layout on the node or its parent");
  }
  const fills = nameList(t.fills);
  if (t.fills !== void 0 && Array.isArray(n.fills)) {
    const onPaints = n.fills.map((p) => isObj4(p) && isObj4(p.tokens) ? p.tokens.color : void 0);
    for (const name of fills) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + name + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
  }
  const strokes = nameList(t.strokes);
  const colors = isObj4(n.strokes) && Array.isArray(n.strokes.colors) ? n.strokes.colors : null;
  if (t.strokes !== void 0 && colors && colors.length !== strokes.length) say("`tokens.strokes` names " + strokes.length + " variable" + (strokes.length === 1 ? "" : "s") + " for " + colors.length + " stroke colour" + (colors.length === 1 ? "" : "s") + "; give one per colour, in order (or leave `strokes.colors` out)");
}
var NODE_ID = /^[^\s:;]+:[^\s:;]+$/;
var INSTANCE_LAYER = /^I[^\s]*;/;
var CLONE_RULES = {
  clone: (v) => typeof v !== "string" ? 'must be the id of the node to copy (e.g. "12:34")' : INSTANCE_LAYER.test(v) ? "'" + v + "' is a layer inside an instance, which is not copied on its own; copy the instance or a frame that holds it" : NODE_ID.test(v) ? null : 'must be a node id (e.g. "12:34", as the read gives it); a copy names its source by id, never by name',
  edits: (v) => isObj4(v) ? null : "must be an object of a layer of the source (its exact name, or its id) \u2192 the fields it changes",
  handle: NODE_RULES.handle,
  key: NODE_RULES.key,
  x: num,
  y: num,
  absolute: trueOnly,
  grow: NODE_RULES.grow,
  alignSelf: NODE_RULES.alignSelf
};
var NOT_ON_CLONE = {
  type: "a copy's type is its source's, so the field is refused",
  children: "a copy's layers come from its source; change them with `edits` (a layer's name or id \u2192 its fields)"
};
function placeProblems(n, parentFlex, say, warn) {
  const isRoot = parentFlex === null;
  for (const axis of ["widthMode", "heightMode"]) {
    if (n[axis] === "fill" && parentFlex !== true) say("`" + axis + ': "fill"` needs a parent with auto-layout' + (isRoot ? " (this is the root)" : ""));
  }
  if (parentFlex !== true) {
    for (const k of ["absolute", "grow", "alignSelf"]) if (n[k] !== void 0) say("`" + k + "` needs a parent with auto-layout");
  }
  if (n.absolute === true && parentFlex === true) {
    for (const axis of ["widthMode", "heightMode"]) if (n[axis] === "fill") say("`" + axis + ': "fill"` is not on an `absolute` child (it is out of the auto-layout flow)');
    if (n.grow === 1) say("`grow: 1` is not on an `absolute` child (it is out of the auto-layout flow)");
    if (n.alignSelf === "stretch") say('`alignSelf: "stretch"` is not on an `absolute` child (it is out of the auto-layout flow)');
  }
  if (parentFlex === true && n.absolute !== true && (n.x !== void 0 || n.y !== void 0)) {
    warn("`x`/`y` have no effect inside auto-layout (add `absolute: true` to place it)");
  }
}
function checkTreeWith(spec, patch) {
  const problems = [];
  const summary = { frames: 0, texts: 0, instances: 0, clones: 0, sources: [], refs: { components: [], variables: [], textStyles: [] }, unbound: 0, handles: [], fonts: [], warnings: [] };
  const ex = expandTree(spec, MAX_TREE_NODES);
  if (ex.problems.length) return { problems: ex.problems, summary, expanded: null, labels: ex.labels };
  summary.warnings.push(...ex.warnings);
  const tree = ex.tree;
  const root = componentRootOf(tree);
  const variantList = root && root.type === "COMPONENT_SET" && isObj4(tree) && Array.isArray(tree.children) ? tree.children : [];
  const firstVariant = variantList[0];
  const columns = isObj4(firstVariant) && typeof firstVariant.name === "string" ? variantColumns(firstVariant.name) : [];
  const declared = isObj4(tree) ? propDefsOf(tree) : [];
  const comp2 = root && isObj4(tree) ? { ...root, defs: new Map(declared.map(([k, d]) => [k, d.type])), defaults: new Map(declared.map(([k, d]) => [k, d.default])), used: /* @__PURE__ */ new Set() } : null;
  const seenHandles = /* @__PURE__ */ new Set();
  const seenFonts = /* @__PURE__ */ new Set();
  const addRef = (list, name) => {
    if (typeof name === "string" && list.indexOf(name) < 0) list.push(name);
  };
  let count2 = 0;
  let tooMany = false;
  const handleOf = (n, say) => {
    if (typeof n.handle !== "string" || !n.handle) return;
    if (seenHandles.has(n.handle)) say("handle '" + n.handle + "' is used twice; a handle names one node");
    seenHandles.add(n.handle);
  };
  const cloneNode = (n, path6, parentFlex) => {
    const before = problems.length;
    const say = (msg) => {
      problems.push(path6 + ": " + msg);
    };
    const own2 = {};
    const set = {};
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v === void 0) continue;
      if (Object.prototype.hasOwnProperty.call(NOT_ON_CLONE, k)) problems.push(path6 + "." + k + ": not on a copy \u2014 " + NOT_ON_CLONE[k]);
      else Object.defineProperty(Object.prototype.hasOwnProperty.call(CLONE_RULES, k) ? own2 : set, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    problems.push(...objectProblems(own2, CLONE_RULES, path6));
    const self = Object.keys(set).length ? patch(set, path6) : null;
    if (self) problems.push(...self.problems);
    if (parentFlex !== null && n.key !== void 0) say("`key` names a whole result, so only the root carries it");
    else if (n.key !== void 0) say("a copy as the root cannot carry a `key` yet (a re-send would make a second copy); put the copy in a frame that carries the key");
    if (parentFlex === null && n.hidden !== void 0) say("`hidden` on the root copy: the copy shows what its source shows; hide it with a patch once it has landed");
    placeProblems(n, parentFlex, say, (m) => summary.warnings.push(path6 + ": " + m));
    const edits = [];
    if (isObj4(n.edits)) {
      const keys = Object.keys(n.edits).filter((k) => isObj4(n.edits) && n.edits[k] !== void 0);
      if (!keys.length) say("`edits` is empty; leave it out for an exact copy");
      for (const k of keys) {
        if (!k.trim()) {
          say("`edits` has an empty layer name");
          continue;
        }
        if (n.clone === k) {
          say("`edits` names the source itself ('" + k + "'); change the copy with the node's own fields");
          continue;
        }
        const r = patch(n.edits[k], path6 + ".edits[" + JSON.stringify(k) + "]");
        problems.push(...r.problems);
        edits.push(r);
      }
    }
    handleOf(n, say);
    if (problems.length !== before) return;
    summary.clones++;
    addRef(summary.sources, n.clone);
    if (typeof n.handle === "string" && n.handle) summary.handles.push(n.handle);
    for (const r of self ? [self, ...edits] : edits) {
      for (const v of r.summary.refs.variables) addRef(summary.refs.variables, v);
      for (const t of r.summary.refs.textStyles) addRef(summary.refs.textStyles, t);
      summary.unbound += r.summary.unbound;
    }
  };
  const walk = (n, at2, depth, parentFlex) => {
    if (++count2 > MAX_TREE_NODES) {
      tooMany = true;
      return;
    }
    const label = isObj4(n) ? ex.labels.get(n) : void 0;
    const path6 = label !== void 0 ? label : at2;
    if (!isObj4(n)) {
      problems.push(path6 + ": must be a node object");
      return;
    }
    if (depth > MAX_TREE_DEPTH) {
      problems.push(path6 + ": nested deeper than " + MAX_TREE_DEPTH + " levels");
      return;
    }
    if (n.clone !== void 0) {
      cloneNode(n, path6, parentFlex);
      return;
    }
    const before = problems.length;
    const isRoot = parentFlex === null;
    const compType = n.type === "COMPONENT" || n.type === "COMPONENT_SET" ? n.type : null;
    const isCompRoot = isRoot && compType !== null;
    const isVariant = depth === 1 && comp2 !== null && comp2.type === "COMPONENT_SET";
    const fields = {};
    for (const k of Object.keys(n)) if (!(isCompRoot && k === "props")) Object.defineProperty(fields, k, { value: n[k], enumerable: true, writable: true, configurable: true });
    problems.push(...objectProblems(fields, NODE_RULES, path6));
    const kind = nodeKind(n);
    if (kind === null) problems.push(path6 + ".type: '" + String(n.type) + "' cannot be written yet (FRAME, TEXT and INSTANCE can; COMPONENT and COMPONENT_SET on the root)");
    const flex = isFlex(n);
    const say = (msg) => {
      problems.push(path6 + ": " + msg);
    };
    if (compType !== null && !isRoot && !(isVariant && compType === "COMPONENT")) {
      say('`type: "' + compType + "\"` is only on the spec's root: a component is made whole, by a spec of its own (put an instance of it here, by name, once it exists)");
    }
    if (isVariant && compType !== "COMPONENT") say("a component set holds only its variants (each a COMPONENT)");
    if (isCompRoot) {
      if (typeof n.name !== "string" || !n.name.trim()) say("a component needs a `name`: a later spec uses it by that name, and sending the same name again updates it in place");
      if (n.key !== void 0) say("a component's name is its key: leave `key` out (the same name sent again updates it in place)");
      if (n.component !== void 0 && n.component !== n.name) say("`component` on a component root is only the read's echo of its own `name`; leave it out");
      if (n.props !== void 0) problems.push(...propDefsProblems(n.props, path6 + ".props", columns));
    }
    if (isVariant && n.props !== void 0) say("a variant's properties are the set's: declare them in the root's `props`");
    if (isVariant && n.key !== void 0) say("a component's name is its key: leave `key` out");
    if (n.propRefs !== void 0 && isObj4(n.propRefs) && propRefsShape(n.propRefs) === null) {
      if (!comp2) say("`propRefs` wires a layer to a property of the component it is in, so it is only inside a COMPONENT or COMPONENT_SET root");
      else if (isCompRoot || isVariant) say("`propRefs` wires a layer inside the component to one of its properties; the component itself cannot be wired");
      else {
        for (const f of PROP_REF_FIELDS) {
          const prop = n.propRefs[f];
          if (typeof prop !== "string") continue;
          const at3 = "`propRefs." + f + "`";
          const want = PROP_REF_TYPES[f];
          const has = comp2.defs.get(prop);
          if (has === void 0) {
            const near2 = nearestNames(prop, [...comp2.defs.keys()]);
            say(at3 + " names '" + prop + "', which the component does not declare in its root's `props`" + (near2.length ? "; closest: " + quoteList(near2) : comp2.defs.size ? "; it declares " + quoteList([...comp2.defs.keys()]) : " (it declares none)"));
            continue;
          }
          comp2.used.add(prop);
          if (has !== want) say(at3 + " names '" + prop + "', a " + has + " property; `" + f + "` follows a " + want + " property");
          if (f === "characters" && kind !== "TEXT") say(at3 + ": only a TEXT layer's text follows a property");
          const def = comp2.defaults.get(prop);
          if (has === want && f === "characters" && n.text !== void 0 && n.text !== def) say("`text` " + JSON.stringify(n.text) + " differs from the default of '" + prop + "' (" + JSON.stringify(def) + "), which the text follows (`propRefs.characters`); change the property's default instead");
          if (has === want && f === "visible" && n.hidden !== void 0 && typeof def === "boolean" && n.hidden !== !def) say("`hidden: " + String(n.hidden) + "` differs from the default of '" + prop + "' (" + String(def) + "), which the layer's visibility follows (`propRefs.visible`); change the property's default instead");
          if (f === "mainComponent" && kind !== "INSTANCE") say(at3 + ": only an INSTANCE swaps its component (this is a " + String(kind) + ")");
        }
      }
    }
    if (!isRoot && n.key !== void 0) say("`key` names a whole result, so only the root carries it");
    if (kind === "TEXT") {
      if (typeof n.text !== "string") say("a TEXT node needs `text`");
      for (const k of ["children", "layout", "clip", "radius", "sizeLimits", "strokesInLayout"]) if (n[k] !== void 0) say("`" + k + "` is not on a TEXT node");
      if (n.maxLines !== void 0 && n.truncate !== true) summary.warnings.push(path6 + ": `maxLines` has no effect without `truncate: true`, so it is not set");
    } else if (kind === "FRAME") {
      for (const k of ["text", "font", "autoResize", "truncate", "maxLines"]) if (n[k] !== void 0) say("`" + k + "` is only on a TEXT node (give the node `text`)");
    } else if (kind === "INSTANCE") {
      if (n.component === void 0) say("an INSTANCE node needs `component` (a component's name, key or id)");
      for (const k of Object.keys(n)) if (n[k] !== void 0 && !INSTANCE_FIELDS.has(k) && settable(NODE_RULES, k)) say("`" + k + "` is not on an INSTANCE node (its content comes from its component; set its `props`)");
    }
    if (kind !== "INSTANCE") {
      for (const k of ["component", "props"]) if (n[k] !== void 0 && !isCompRoot && !(isVariant && k === "props")) say("`" + k + "` is only on an INSTANCE node");
    }
    if (isObj4(n.styles) && n.styles.text !== void 0 && kind !== "TEXT") say("`styles.text` is only on a TEXT node");
    for (const axis of ["widthMode", "heightMode"]) {
      if (n[axis] === "hug" && !flex && kind === "FRAME") say("`" + axis + ': "hug"` needs the node itself to have auto-layout (layout.display "flex") or be TEXT');
    }
    if (isObj4(n.tokens) && kind !== null && kind !== "CLONE") tokenProblems(n, n.tokens, kind, flex, parentFlex === true, say);
    placeProblems(n, parentFlex, say, (m) => summary.warnings.push(path6 + ": " + m));
    if (n.sizeLimits !== void 0 && !flex && parentFlex !== true) say("`sizeLimits` needs auto-layout on the node or its parent");
    if (kind === "FRAME" && n.strokesInLayout === true && !flex) summary.warnings.push(path6 + ": `strokesInLayout` has no effect without auto-layout on the frame, so it is not set");
    if (isObj4(n.layout) && n.layout.display === "flex") {
      const l = n.layout;
      const column = l.flexDirection === "column";
      if (l.alignItems === "baseline" && column) say('`layout.alignItems: "baseline"` works only in a row (Figma refuses it in a column)');
      if (l.flexWrap === void 0) {
        for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== void 0) say("`layout." + k + '` needs `flexWrap: "wrap"`');
      }
      if (l.flexWrap !== void 0 && (column ? l.rowGap : l.columnGap) !== void 0) {
        say("`layout." + (column ? "rowGap" : "columnGap") + "` is the main-axis gap in a wrapping " + (column ? "column" : "row") + "; use `gap`, and `" + (column ? "columnGap" : "rowGap") + "` between the wrapped tracks");
      }
    }
    if (kind === "TEXT" && isObj4(n.strokes) && n.strokes.weights !== void 0) say("`strokes.weights` (per side) is not on a TEXT node; use `strokes.weight`");
    if (isObj4(n.sizeLimits)) {
      const m = n.sizeLimits;
      if (isNum(m.minWidth) && isNum(m.maxWidth) && m.minWidth > m.maxWidth) say("`sizeLimits.minWidth` is above `maxWidth`");
      if (isNum(m.minHeight) && isNum(m.maxHeight) && m.minHeight > m.maxHeight) say("`sizeLimits.minHeight` is above `maxHeight`");
    }
    if (isObj4(n.layout) && n.layout.mode === "absolute") {
      const l = n.layout;
      if (l.display !== void 0) say('`layout` is either `display: "flex"` or `mode: "absolute"`, not both');
      else for (const k of Object.keys(l)) if (l[k] !== void 0 && k !== "mode" && k !== "width" && k !== "height" && settable(LAYOUT_RULES, k)) say("`layout." + k + '` is an auto-layout field; `mode: "absolute"` has none (use `display: "flex"`)');
    }
    if (isObj4(n.layout) && n.layout.display === void 0 && n.layout.mode === void 0) say('`layout` needs `display: "flex"` (or `mode: "absolute"` for none)');
    handleOf(n, say);
    if (problems.length === before && kind !== null && kind !== "CLONE") {
      const styled = isObj4(n.styles) && typeof n.styles.text === "string";
      if (kind === "TEXT") {
        summary.texts++;
        if (styled) {
          const set = isObj4(n.font) ? STYLE_FONT_FIELDS.filter((k) => isObj4(n.font) && n.font[k] !== void 0) : [];
          if (set.length) summary.warnings.push(path6 + ": " + set.map((k) => "`font." + k + "`").join(", ") + " " + (set.length === 1 ? "is" : "are") + " set by the text style, so " + (set.length === 1 ? "it is" : "they are") + " not set");
        } else {
          const f = fontOf(isObj4(n.font) ? n.font : void 0);
          const key = f.family + "|" + f.weight;
          if (!seenFonts.has(key)) {
            seenFonts.add(key);
            summary.fonts.push(f);
          }
        }
      } else if (kind === "INSTANCE") summary.instances++;
      else if (compType === null) summary.frames++;
      if (typeof n.handle === "string" && n.handle) summary.handles.push(n.handle);
      if (kind === "INSTANCE") addRef(summary.refs.components, n.component);
      if (isCompRoot) for (const c of propDefComponents(n)) addRef(summary.refs.components, c);
      if (styled && isObj4(n.styles)) addRef(summary.refs.textStyles, n.styles.text);
      if (Array.isArray(n.fills)) {
        for (const p of n.fills) if (isObj4(p) && isObj4(p.tokens)) addRef(summary.refs.variables, p.tokens.color);
      }
      if (isObj4(n.tokens)) for (const v of Object.values(n.tokens)) for (const name of nameList(v)) addRef(summary.refs.variables, name);
      summary.unbound += unboundOf(n, kind);
    }
    if (Array.isArray(n.children)) n.children.forEach((c, i) => walk(c, path6 + ".children[" + i + "]", depth + 1, flex));
  };
  if (!isObj4(tree)) problems.push("tree: must be a node object (the root frame)");
  else {
    walk(tree, "tree", 0, null);
    if (comp2 && isObj4(tree)) {
      for (const name of comp2.defs.keys()) if (!comp2.used.has(name)) summary.warnings.push("tree.props[" + JSON.stringify(name) + "]: no layer uses it (wire one with `propRefs`), so an instance can set it but nothing shows it");
      summary.component = { type: comp2.type, name: comp2.name, variants: comp2.type === "COMPONENT_SET" && Array.isArray(tree.children) ? tree.children.length : 0, props: [...comp2.defs.keys()] };
    }
    const k = nodeKind(tree);
    if (k !== "FRAME" && k !== "CLONE") problems.push("tree: the root must be a FRAME (a screen)" + (k === "INSTANCE" || k === "TEXT" ? "; put the " + (k === "INSTANCE" ? "instance" : "text") + " inside one" : ""));
    if (tooMany) problems.push("tree: more than " + MAX_TREE_NODES + " nodes \u2014 send a large screen as several trees");
  }
  return { problems, summary, expanded: problems.length || !isObj4(tree) ? null : tree, labels: ex.labels };
}

// bridge/src/patch-spec.ts
var bool = (v) => typeof v === "boolean" ? null : "must be true or false";
var PATCH_LAYOUT_RULES = {
  ...LAYOUT_RULES,
  width: refuse("set the size with `box`"),
  height: refuse("set the size with `box`"),
  flexWrap: oneOf("wrap", "nowrap"),
  alignContent: oneOf("space-between", "auto"),
  reverseZ: bool
};
var PATCH_STROKE_RULES = {
  colors: (v) => Array.isArray(v) ? (() => {
    for (const [i, c] of v.entries()) {
      const bad = hex(c);
      if (bad !== null) return "[" + i + "] " + bad;
    }
    return null;
  })() : "must be a list of hex colours ([] removes the strokes)",
  weight: nonNeg,
  weights: objOf(SIDES),
  align: oneOf("inside", "outside", "center"),
  paints: refuse("only solid stroke `colors` can be written yet")
};
var tokenValue = (v) => v === null ? null : ref(v);
var tokenList = (v) => v === null ? null : typeof v === "string" ? ref(v) : Array.isArray(v) && v.length > 0 ? (() => {
  for (const [i, x] of v.entries()) {
    const bad = ref(x);
    if (bad !== null) return "[" + i + "] " + bad;
  }
  return null;
})() : "must be a variable's name, key or id, a non-empty list of them, or null to unbind";
var PATCH_TOKEN_RULES = {
  ...Object.fromEntries(NUMBER_TOKEN_FIELDS.map((k) => [k, tokenValue])),
  fills: tokenList,
  strokes: tokenList,
  characters: refuse("a text's content cannot be bound to a variable yet; give `text`"),
  visible: refuse("visibility cannot be bound to a variable yet; give `hidden`"),
  cornerRadius: refuse("bind each corner: topLeftRadius, topRightRadius, bottomRightRadius, bottomLeftRadius")
};
var BOX_RULES3 = {
  w: size,
  h: size,
  x: refuse("a patch does not move a node; `move` changes its parent"),
  y: refuse("a patch does not move a node; `move` changes its parent")
};
var PATCH_FIELDS = {
  props: propsCheck,
  name: str,
  hidden: bool,
  opacity: unit,
  layout: objOf(PATCH_LAYOUT_RULES),
  box: (v) => {
    if (!isObj4(v)) return "must be an object {w, h}";
    const bad = objOf(BOX_RULES3)(v);
    return bad !== null ? bad : v.w === void 0 && v.h === void 0 ? "needs `w`, `h` or both" : null;
  },
  widthMode: oneOf("fill", "hug", "fixed"),
  heightMode: oneOf("fill", "hug", "fixed"),
  radius: NODE_RULES.radius,
  fills: fillsCheck,
  strokes: (v) => {
    if (!isObj4(v)) return "must be an object";
    const bad = objOf(PATCH_STROKE_RULES)(v);
    return bad !== null ? bad : Object.keys(v).every((k) => v[k] === void 0) ? "is empty" : null;
  },
  styles: objOf(STYLE_RULES),
  text: str,
  autoResize: oneOf("width_and_height", "height", "truncate", "none"),
  tokens: objOf(PATCH_TOKEN_RULES)
};
var PATCH_FIELD_NAMES = Object.keys(PATCH_FIELDS);
var NOT_PATCHED = {
  type: "a node's type cannot change",
  children: "a patch changes one node; change each child by its own id (or `move` a node this session created)",
  handle: "a handle names a node a createTree op creates",
  key: "a key names a createTree result; send its spec again to update it",
  id: "the node is named by the op's `nodeId`",
  component: "swapping an instance's component cannot be written yet; set its `props`",
  x: "a patch does not move a node; `move` changes its parent",
  y: "a patch does not move a node; `move` changes its parent",
  font: "a text's font cannot be patched yet; name a text style in `styles.text`"
};
var settableIn = (rules) => Object.keys(rules).filter((k) => {
  const r = rules[k];
  return r !== void 0 && !isRefuse(r);
});
function checkPatch(set, path6 = "set") {
  const summary = { fields: [], refs: { variables: [], textStyles: [] }, unbound: 0 };
  if (!isObj4(set)) return { problems: [path6 + ': must be an object of the fields to change, e.g. {text: "\u2026"}'], summary };
  const problems = [];
  const say = (m) => {
    problems.push(path6 + ": " + m);
  };
  for (const [k, v] of Object.entries(set)) {
    if (v === void 0) continue;
    const at2 = path6 + "." + k;
    if (Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k)) continue;
    const why = Object.prototype.hasOwnProperty.call(NOT_PATCHED, k) ? NOT_PATCHED[k] : void 0;
    const tree = Object.prototype.hasOwnProperty.call(NODE_RULES, k) ? NODE_RULES[k] : void 0;
    if (why !== void 0) problems.push(at2 + ": a patch cannot set it \u2014 " + why);
    else if (tree !== void 0) problems.push(at2 + ": a read field a patch cannot set yet" + (isRefuse(tree) && tree.refuse ? " \u2014 " + tree.refuse : ""));
    else {
      const near2 = nearestNames(k, PATCH_FIELD_NAMES);
      problems.push(at2 + ": not a field a patch sets" + (near2.length ? "; closest: " + quoteList(near2) : ""));
    }
  }
  problems.push(...objectProblems(Object.fromEntries(Object.entries(set).filter(([k]) => Object.prototype.hasOwnProperty.call(PATCH_FIELDS, k))), PATCH_FIELDS, path6));
  const fields = PATCH_FIELD_NAMES.filter((k) => set[k] !== void 0);
  if (!fields.length && !problems.length) say("sets nothing; give at least one of " + PATCH_FIELD_NAMES.join(", "));
  if (problems.length) return { problems, summary };
  const l = isObj4(set.layout) ? set.layout : null;
  if (l) {
    if (l.mode !== void 0 && l.display !== void 0) say('`layout` is either `display: "flex"` or `mode: "absolute"`, not both');
    else if (l.mode !== void 0) {
      for (const k of Object.keys(l)) if (l[k] !== void 0 && k !== "mode" && settableIn(PATCH_LAYOUT_RULES).indexOf(k) >= 0) say("`layout." + k + '` is an auto-layout field; `mode: "absolute"` removes auto-layout');
    }
    if (l.alignItems === "baseline" && l.flexDirection === "column") say('`layout.alignItems: "baseline"` works only in a row (Figma refuses it in a column)');
    if (l.flexWrap === "nowrap") {
      for (const k of ["rowGap", "columnGap", "alignContent"]) if (l[k] !== void 0) say("`layout." + k + '` needs wrapping; `flexWrap: "nowrap"` turns it off');
    }
  }
  const box = isObj4(set.box) ? set.box : null;
  if (box && box.w !== void 0 && set.widthMode !== void 0 && set.widthMode !== "fixed") say('`box.w` gives a fixed width, which `widthMode: "' + String(set.widthMode) + '"` contradicts; leave one out');
  if (box && box.h !== void 0 && set.heightMode !== void 0 && set.heightMode !== "fixed") say('`box.h` gives a fixed height, which `heightMode: "' + String(set.heightMode) + '"` contradicts; leave one out');
  const t = isObj4(set.tokens) ? set.tokens : {};
  if (t.width !== void 0 && t.width !== null && set.widthMode !== void 0 && set.widthMode !== "fixed") say("`tokens.width` sizes the node, which `widthMode` already does; leave one out");
  if (t.height !== void 0 && t.height !== null && set.heightMode !== void 0 && set.heightMode !== "fixed") say("`tokens.height` sizes the node, which `heightMode` already does; leave one out");
  if (Array.isArray(set.fills) && t.fills !== void 0) {
    const onPaints = set.fills.map((p) => isObj4(p) && isObj4(p.tokens) ? p.tokens.color : void 0);
    if (t.fills === null) say("`tokens.fills: null` unbinds the node's paints, and `fills` replaces them; give one");
    else for (const name of typeof t.fills === "string" ? [t.fills] : Array.isArray(t.fills) ? t.fills : []) if (onPaints.indexOf(name) < 0) say("`tokens.fills` names '" + String(name) + "', which no paint in `fills` is bound to; bind the paint instead: `fills[i].tokens.color`");
  }
  const st = isObj4(set.strokes) ? set.strokes : null;
  if (st && Array.isArray(st.colors) && t.strokes !== void 0 && t.strokes !== null) {
    const n = typeof t.strokes === "string" ? 1 : Array.isArray(t.strokes) ? t.strokes.length : 0;
    if (n !== st.colors.length) say("`tokens.strokes` names " + n + " variable" + (n === 1 ? "" : "s") + " for " + st.colors.length + " stroke colour" + (st.colors.length === 1 ? "" : "s") + "; give one per colour, in order");
  }
  if (problems.length) return { problems, summary };
  summary.fields = fields;
  const add = (list, name) => {
    if (typeof name === "string" && list.indexOf(name) < 0) list.push(name);
  };
  if (Array.isArray(set.fills)) {
    for (const p of set.fills) if (isObj4(p) && isObj4(p.tokens)) add(summary.refs.variables, p.tokens.color);
  }
  for (const v of Object.values(t)) for (const name of typeof v === "string" ? [v] : Array.isArray(v) ? v : []) add(summary.refs.variables, name);
  if (isObj4(set.styles)) add(summary.refs.textStyles, set.styles.text);
  summary.unbound = unboundOf2(set, t);
  return { problems, summary };
}
function unboundOf2(set, t) {
  const has = (k) => t[k] !== void 0 && t[k] !== null;
  let c = 0;
  if (Array.isArray(set.fills)) {
    for (const p of set.fills) if (isObj4(p) && p.type !== "image" && p.tokens === void 0) c++;
  }
  const st = isObj4(set.strokes) ? set.strokes : null;
  if (st) {
    if (Array.isArray(st.colors) && !has("strokes")) c += st.colors.length;
    if (st.weight !== void 0 && !has("strokeWeight")) c++;
    if (isObj4(st.weights)) {
      for (const [side, f] of [["top", "strokeTopWeight"], ["right", "strokeRightWeight"], ["bottom", "strokeBottomWeight"], ["left", "strokeLeftWeight"]]) if (st.weights[side] !== void 0 && !has(f)) c++;
    }
  }
  const l = isObj4(set.layout) ? set.layout : null;
  if (l) {
    if (l.gap !== void 0 && !has("itemSpacing")) c++;
    if (Array.isArray(l.padding)) {
      for (const f of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) if (!has(f)) c++;
    }
  }
  const corners = [["tl", "topLeftRadius"], ["tr", "topRightRadius"], ["br", "bottomRightRadius"], ["bl", "bottomLeftRadius"]];
  if (typeof set.radius === "number") {
    if (!corners.every(([, f]) => has(f))) c++;
  } else if (isObj4(set.radius)) {
    for (const [k, f] of corners) if (set.radius[k] !== void 0 && !has(f)) c++;
  }
  return c;
}

// bridge/src/tree-check.ts
function checkTree(spec) {
  return checkTreeWith(spec, checkPatch);
}

// design-to-code/capture-spec.ts
var SAMPLES = 3;
var r2 = (n) => Math.round(n * 100) / 100;
var f2 = (n) => Math.floor(n * 100 + 1e-6) / 100;
var near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
var sameBox = (a, b) => near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
var isEl = (n) => n.kind === "el";
function hexOf(css) {
  if (css === null) return null;
  const c = parseCssColor(css);
  if (!c || c.a <= 0) return null;
  return formatHex(c);
}
var WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };
function fontStyleName(weight, italic) {
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const name = WEIGHT_NAMES[w] || "Regular";
  if (!italic) return name;
  return w === 400 ? "Italic" : name + " Italic";
}
var GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|emoji|math|fangsong|-apple-system|blinkmacsystemfont)$/i;
function firstFamily(stack) {
  const fams = stack.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter((f) => f !== "");
  return fams.find((f) => !GENERIC.test(f)) || fams[0] || "";
}
function captureSpec(doc) {
  const stats = { nodes: 0, frames: 0, texts: 0, images: 0, depth: 0, fonts: [], dropped: /* @__PURE__ */ Object.create(null), approximated: /* @__PURE__ */ Object.create(null) };
  const tally = (into, kind, at2) => {
    const t = into[kind] || (into[kind] = { count: 0, samples: [] });
    t.count++;
    if (t.samples.length < SAMPLES && t.samples.indexOf(at2) < 0) t.samples.push(at2);
  };
  const drop = (kind, at2) => tally(stats.dropped, kind, at2);
  const approx = (kind, at2) => tally(stats.approximated, kind, at2);
  const fontSeen = /* @__PURE__ */ new Set();
  const contentBox = (el) => {
    const [pt, pr, pb, pl] = el.padding;
    const b = el.border && el.border.from === "border" ? el.border.widths : [0, 0, 0, 0];
    const bt = b[0] || 0, br = b[1] || 0, bb = b[2] || 0, bl = b[3] || 0;
    return { x: el.rect.x + bl + pl, y: el.rect.y + bt + pt, w: Math.max(0, el.rect.w - bl - br - pl - pr), h: Math.max(0, el.rect.h - bt - bb - pt - pb) };
  };
  const hasLook = (el) => el.background !== null || el.border !== null || el.image !== null || el.backgroundImage !== null || el.clip || el.opacity < 1;
  const padded = (el) => el.padding.some((p) => p > 0);
  const fontOf2 = (f, at2) => {
    const style = fontStyleName(f.weight, f.italic);
    if (Math.round(f.weight) % 100 !== 0) approx("font-weight", at2);
    const key = f.family + "|" + style;
    if (!fontSeen.has(key)) {
      fontSeen.add(key);
      stats.fonts.push({ family: f.family, style });
    }
    const out = { family: f.family, weight: style, size: r2(Math.max(1, f.size)) };
    const color = hexOf(f.color);
    if (color) out.color = color;
    if (f.lineHeight !== null && f.lineHeight > 0) out.lineHeight = { unit: "px", value: r2(f.lineHeight) };
    if (f.letterSpacing) out.letterSpacing = { unit: "px", value: r2(f.letterSpacing) };
    const rtl = f.direction === "rtl";
    const a = f.textAlign;
    const align = a === "center" || a === "-webkit-center" ? "center" : a === "right" || a === "-webkit-right" || a === "end" && !rtl || a === "start" && rtl ? "right" : a === "justify" ? "justified" : null;
    if (align) out.align = align;
    if (f.textTransform === "uppercase") out.case = "upper";
    else if (f.textTransform === "lowercase") out.case = "lower";
    else if (f.textTransform === "capitalize") out.case = "title";
    if (/underline/.test(f.textDecoration)) out.decoration = "underline";
    else if (/line-through/.test(f.textDecoration)) out.decoration = "strikethrough";
    return out;
  };
  const aligned = (f) => {
    const a = f.textAlign;
    return a === "center" || a === "-webkit-center" || a === "right" || a === "end" || a === "justify" || a === "start" && f.direction === "rtl";
  };
  const textNode = (t, box, origin, inFlex, fill, at2) => {
    stats.texts++;
    if (t.mixed) approx("mixed-inline", at2);
    const n = { text: t.text, font: fontOf2(t.font, at2) };
    if (t.control) {
      n.box = { w: r2(Math.max(1, box.w)), h: r2(Math.max(1, box.h)) };
      n.font = { ...n.font, valign: "center" };
      n.truncate = true;
      if (origin) {
        n.x = r2(box.x - origin.x);
        n.y = r2(box.y - origin.y);
      }
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
  const imagePaint = (img, at2) => {
    stats.images++;
    if (img.note) approx("image-fit", at2);
    const p = { type: "image", file: img.file, scaleMode: img.scaleMode };
    if (img.scaleMode === "tile" && img.scale !== void 0 && img.scale > 0) p.scale = r2(img.scale);
    return p;
  };
  const look = (n, el, at2) => {
    const shot = el.image && el.image.from === "screenshot" || el.backgroundImage && el.backgroundImage.from === "screenshot";
    const fills = [];
    const bg = hexOf(el.background);
    if (bg && !shot) fills.push({ type: "solid", color: bg });
    if (el.backgroundImage) fills.push(imagePaint(el.backgroundImage, at2));
    if (el.image) fills.push(imagePaint(el.image, at2));
    if (fills.length) n.fills = fills;
    if (el.border && !shot) {
      const [t, r, b, l] = el.border.widths;
      const color = hexOf(el.border.color);
      if (color && (t > 0 || r > 0 || b > 0 || l > 0)) {
        const s = { colors: [color], align: el.border.from === "border" ? "inside" : el.border.align };
        if (t === r && t === b && t === l) s.weight = r2(t);
        else s.weights = { top: r2(t), right: r2(r), bottom: r2(b), left: r2(l) };
        n.strokes = s;
      }
    }
    const rad = el.radius;
    if (typeof rad === "number" && rad > 0) n.radius = r2(Math.min(rad, el.rect.w / 2, el.rect.h / 2));
    else if (Array.isArray(rad) && rad.some((v) => v > 0)) {
      const cap = (v) => r2(Math.min(v, el.rect.w / 2, el.rect.h / 2));
      n.radius = { tl: cap(rad[0]), tr: cap(rad[1]), br: cap(rad[2]), bl: cap(rad[3]) };
    }
    if (el.opacity < 1) n.opacity = r2(Math.max(0, el.opacity));
    if (el.clip) n.clip = true;
    for (const d of el.dropped) drop(d, at2);
  };
  const layoutOf = (el, at2, notes) => {
    const flex = /^(inline-)?flex$/.test(el.display);
    const grid = /^(inline-)?grid$/.test(el.display);
    const pad = el.padding.some((p) => p > 0) ? el.padding.map(r2) : null;
    const gapOf = (v) => v === null ? 0 : v;
    if (flex) {
      const column = /column/.test(el.flexDirection);
      const reverse = /reverse/.test(el.flexDirection);
      const l = { display: "flex", flexDirection: column ? "column" : "row" };
      const main2 = gapOf(column ? el.rowGap : el.columnGap);
      if (main2 > 0) l.gap = r2(main2);
      if (el.flexWrap === "wrap" || el.flexWrap === "wrap-reverse") {
        l.flexWrap = "wrap";
        if (el.flexWrap === "wrap-reverse") notes.push(["wrap-reverse", at2]);
        const cross = gapOf(column ? el.columnGap : el.rowGap);
        if (cross > 0) {
          if (column) l.columnGap = r2(cross);
          else l.rowGap = r2(cross);
        }
      }
      if (pad) l.padding = pad;
      const j = el.justifyContent.replace(/^(un)?safe\s+/, "");
      const startish = j === "normal" || j === "flex-start" || j === "stretch" || j === "start" || j === "left";
      const endish = j === "flex-end" || j === "end" || j === "right";
      if (j === "center") l.justifyContent = "center";
      else if (j === "space-between" || j === "space-around" || j === "space-evenly") l.justifyContent = j;
      else if (reverse && (j === "normal" || j === "flex-start" || j === "stretch")) l.justifyContent = "flex-end";
      else if (endish && !(reverse && j === "flex-end")) l.justifyContent = "flex-end";
      else if (!startish && !endish) notes.push(["justify-content", at2]);
      const ai = el.alignItems.replace(/^(un)?safe\s+/, "");
      if (ai === "center") l.alignItems = "center";
      else if (ai === "flex-end" || ai === "end" || ai === "self-end") l.alignItems = "flex-end";
      else if (/baseline/.test(ai)) {
        if (column) notes.push(["baseline", at2]);
        else l.alignItems = "baseline";
      }
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
        approx("grid", at2);
        return { layout: null, dir: null, reverse: false, grid: true };
      }
      if (cols === 1) {
        const l2 = { display: "flex", flexDirection: "column" };
        if (rowGap > 0) l2.gap = r2(rowGap);
        if (pad) l2.padding = pad;
        return { layout: l2, dir: "column", reverse: false, grid: true };
      }
      const l = { display: "flex", flexDirection: "row" };
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
  const childList = (el, flex, reverse, at2, notes) => {
    const flat = [];
    const add = (c, p) => {
      if (isEl(c) && !(c.rect.w > 0.5 && c.rect.h > 0.5) && !c.text) {
        if (c.children.length) {
          if (flex) notes.push(["zero-size-wrapper", p]);
          for (const k of c.children) add(k, p);
        }
        return;
      }
      flat.push(c);
    };
    for (const c of el.children) add(c, isEl(c) ? c.path : at2);
    const positioned = (c) => isEl(c) && (flex ? /absolute|fixed/.test(c.position) : /absolute|fixed|relative|sticky/.test(c.position));
    const flow = flat.filter((c) => !positioned(c)).map((c, i) => ({ c, i }));
    if (flex) flow.sort((a, b) => (isEl(a.c) ? a.c.order : 0) - (isEl(b.c) ? b.c.order : 0) || a.i - b.i);
    const inFlow = flow.map((x) => x.c);
    if (reverse) inFlow.reverse();
    const out = flat.filter(positioned).map((c, i) => ({ c, i }));
    out.sort((a, b) => (isEl(a.c) ? a.c.zIndex : 0) - (isEl(b.c) ? b.c.zIndex : 0) || a.i - b.i);
    return [...inFlow, ...out.map((x) => x.c)];
  };
  const selfAlign = (src, flex, cb, isText) => {
    const row = flex.dir === "row";
    const self = src.alignSelf === "auto" || src.alignSelf === "normal" || src.alignSelf === "" ? flex.align : src.alignSelf;
    const map = (a) => a === "center" ? "center" : /end$/.test(a) ? "max" : a === "stretch" || a === "normal" ? "stretch" : "min";
    const want = map(self), base = map(flex.align);
    if (want === "stretch") {
      const full = row ? near(src.rect.h, cb.h) : near(src.rect.w, cb.w);
      return full && !(isText && row) ? "stretch" : void 0;
    }
    return want !== base && !(base === "stretch" && want === "min") ? want : void 0;
  };
  const place = (n, src, parent, isText) => {
    const abs = isEl(src) && /absolute|fixed/.test(src.position);
    if (!parent.flex || abs) {
      if (parent.flex && abs) n.absolute = true;
      if (n.x === void 0) n.x = r2(src.rect.x - parent.el.rect.x);
      if (n.y === void 0) n.y = r2(src.rect.y - parent.el.rect.y);
      return;
    }
    delete n.x;
    delete n.y;
    if (!isEl(src)) return;
    if (src.flexGrow > 0 && parent.flex.grow) n.grow = 1;
    const a = selfAlign(src, parent.flex, contentBox(parent.el), isText);
    if (a) n.alignSelf = a;
  };
  const collapsed = (outer) => {
    let el = outer;
    for (; ; ) {
      const only = el.children.length === 1 ? el.children[0] : void 0;
      if (!only || !isEl(only) || hasLook(el) || padded(el) || el.text || el.media || !sameBox(only.rect, el.rect) || el.dropped.length) return el;
      el = only;
    }
  };
  const asText = (el) => el.text !== null && !hasLook(el) && !padded(el) && !el.media;
  const runBox = (c) => {
    const lh = c.font.lineHeight;
    const lines = Math.max(1, c.lines);
    return lh !== null && lh > 0 ? { x: c.rect.x, y: c.rect.y - (lh * lines - c.rect.h) / 2, w: c.rect.w, h: lh * lines } : c.rect;
  };
  const innerOf = (el, l, strokesIn) => {
    const [pt = 0, pr = 0, pb = 0, pl = 0] = l.padding || [];
    const b = strokesIn && el.border ? el.border.widths : [0, 0, 0, 0];
    const bt = b[0] || 0, br = b[1] || 0, bb = b[2] || 0, bl = b[3] || 0;
    return { x: el.rect.x + bl + pl, y: el.rect.y + bt + pt, w: el.rect.w - bl - br - pl - pr, h: el.rect.h - bt - bb - pt - pb };
  };
  const growFits = (el, l, flow, row, strokesIn) => {
    const growers = flow.filter((c) => isEl(c) && c.flexGrow > 0);
    if (!growers.length) return true;
    if (l.flexWrap === "wrap") return false;
    const size2 = (c) => {
      const r = isEl(c) ? c.rect : runBox(c);
      return row ? r.w : r.h;
    };
    const inner = innerOf(el, l, strokesIn);
    const used = flow.reduce((a, c) => a + size2(c), 0) + (l.gap || 0) * (flow.length - 1);
    const sizes = growers.map(size2);
    return near(used, row ? inner.w : inner.h) && Math.max(...sizes) - Math.min(...sizes) <= 1;
  };
  const reproduces = (el, l, flow, flex, strokesIn) => {
    const row = flex.dir === "row";
    const inner = innerOf(el, l, strokesIn);
    const cb = contentBox(el);
    const layoutAlign = l.alignItems === "center" ? "center" : l.alignItems === "flex-end" ? "max" : l.alignItems === "baseline" ? "baseline" : "min";
    const items = flow.map((c) => {
      const rect = isEl(c) ? c.rect : runBox(c);
      const align = isEl(c) ? selfAlign(c, flex, cb, asText(collapsed(c))) ?? layoutAlign : layoutAlign;
      return { main: row ? rect.x : rect.y, size: row ? rect.w : rect.h, cross: row ? rect.y : rect.x, csize: row ? rect.h : rect.w, align };
    });
    const start = row ? inner.x : inner.y, avail = row ? inner.w : inner.h;
    const cStart = row ? inner.y : inner.x, cAvail = row ? inner.h : inner.w;
    const gap = l.gap || 0, crossGap = (row ? l.rowGap : l.columnGap) || 0;
    const wrap = l.flexWrap === "wrap";
    const lines = [];
    let cursor = 0;
    for (const it of items) {
      const line = lines[lines.length - 1];
      if (!line || wrap && cursor + gap + it.size > avail + 0.5) {
        lines.push([it]);
        cursor = it.size;
      } else {
        line.push(it);
        cursor += gap + it.size;
      }
    }
    let lineStart = cStart;
    for (const line of lines) {
      const n = line.length, sum = line.reduce((a, it) => a + it.size, 0);
      const free = avail - sum - gap * (n - 1);
      const j = l.justifyContent;
      let at2 = start, step = gap;
      if (j === "flex-end") at2 += free;
      else if (j === "center") at2 += free / 2;
      else if (j === "space-between") step = n > 1 ? (avail - sum) / (n - 1) : 0;
      else if (j === "space-around") {
        step = (avail - sum) / n;
        at2 += step / 2;
      } else if (j === "space-evenly") {
        step = (avail - sum) / (n + 1);
        at2 += step;
      }
      const lineSize = wrap ? Math.max(...line.map((it) => it.csize)) : cAvail;
      for (const it of line) {
        if (!near(it.main, at2)) return false;
        at2 += it.size + step;
        const want = it.align === "center" ? lineStart + (lineSize - it.csize) / 2 : it.align === "max" ? lineStart + lineSize - it.csize : lineStart;
        if (!near(it.cross, want)) return false;
      }
      lineStart += lineSize + crossGap;
    }
    return true;
  };
  const manyLines = (flow, row) => {
    const rs = flow.map((c) => isEl(c) ? c.rect : runBox(c));
    if (rs.length < 2) return false;
    const starts = rs.map((r) => row ? r.y : r.x), ends = rs.map((r) => row ? r.y + r.h : r.x + r.w);
    return Math.max(...starts) >= Math.min(...ends) - 0.5;
  };
  const nodeOf = (outer, parent) => {
    const el = parent ? collapsed(outer) : outer;
    const at2 = el.path;
    const pf = parent ? parent.flex : null;
    const inFlex = pf !== null && !/absolute|fixed/.test(outer.position);
    const grows = inFlex && pf !== null && outer.flexGrow > 0 && pf.grow === true && pf.dir === "row";
    const stretched = inFlex && parent !== null && pf !== null && pf.dir === "column" && near(outer.rect.w, contentBox(parent.el).w) && (outer.alignSelf === "stretch" || (outer.alignSelf === "auto" || outer.alignSelf === "normal") && (pf.align === "normal" || pf.align === "stretch"));
    if (parent && asText(el) && el.text) {
      const wider = inFlex && el.rect.w > el.text.rect.w + 1;
      const n2 = textNode(el.text, el.rect, inFlex ? null : parent.el.rect, inFlex, grows || stretched || wider, at2);
      if (el.opacity < 1) n2.opacity = r2(el.opacity);
      for (const d of el.dropped) drop(d, at2);
      place(n2, outer, parent, true);
      return n2;
    }
    const n = { name: el.name, box: { w: r2(Math.max(0.01, el.rect.w)), h: r2(Math.max(0.01, el.rect.h)) } };
    stats.frames++;
    look(n, el, at2);
    if (el.media && !el.image) drop("image", at2);
    const none = { layout: null, dir: null, reverse: false, grid: false };
    const notes = [];
    let lay = el.media || !parent && doc.document ? none : layoutOf(el, at2, notes);
    const strokesIn = lay.layout !== null && el.border !== null && el.border.from === "border" && el.border.widths.some((w) => w > 0) && !(el.image && el.image.from === "screenshot" || el.backgroundImage && el.backgroundImage.from === "screenshot");
    let self = { el, flex: lay.dir ? { dir: lay.dir, align: lay.grid ? "flex-start" : el.alignItems.replace(/^(un)?safe\s+/, "") } : null };
    let list = el.text || el.media ? [] : childList(el, self.flex !== null, lay.reverse, at2, notes);
    if (lay.layout && self.flex && !el.text && !el.media) {
      const flow = list.filter((c) => !(isEl(c) && /absolute|fixed/.test(c.position)));
      const why = lay.reverse && lay.layout.flexWrap === "wrap" && manyLines(flow, self.flex.dir === "row") ? "reverse-wrap" : !reproduces(el, lay.layout, flow, self.flex, strokesIn) ? lay.grid ? "grid" : "flex" : null;
      if (why) {
        approx(why, at2);
        lay = none;
        self = { el, flex: null };
        notes.length = 0;
        list = childList(el, false, false, at2, notes);
      } else if (self.flex) {
        self.flex.grow = growFits(el, lay.layout, flow, self.flex.dir === "row", strokesIn);
        if (!self.flex.grow) approx("flex-grow", at2);
      }
    }
    for (const [kind, p] of notes) approx(kind, p);
    if (lay.layout) {
      n.layout = lay.layout;
      if (strokesIn) n.strokesInLayout = true;
    }
    const kids = [];
    if (el.text) {
      const cb = contentBox(el);
      const t = textNode(el.text, cb, self.flex ? null : el.rect, self.flex !== null, false, at2);
      kids.push(t);
    } else if (!el.media) {
      for (const c of list) {
        if (isEl(c)) {
          const k = nodeOf(c, self);
          if (k) kids.push(k);
        } else {
          const box = runBox(c);
          const k = textNode({ ...c, rect: box }, box, self.flex ? null : el.rect, self.flex !== null, false, at2);
          place(k, { ...c, rect: box }, self, true);
          kids.push(k);
        }
      }
      if (lay.grid && lay.layout && lay.layout.flexWrap === "wrap") {
        for (const k of kids) if (k.box && !k.absolute) k.box = { w: f2(k.box.w), h: k.box.h };
      }
    }
    if (kids.length) n.children = kids;
    if (parent && !kids.length && !n.fills && !n.strokes && !inFlex) {
      stats.frames--;
      return null;
    }
    if (parent) place(n, outer, parent, false);
    return n;
  };
  const root = nodeOf(doc.root, null) || { box: { w: 1, h: 1 } };
  root.name = doc.name + " @" + doc.width;
  root.key = "capture:" + doc.name + "@" + doc.width;
  root.box = { w: r2(Math.max(1, doc.root.rect.w)), h: r2(Math.max(1, doc.root.rect.h)) };
  const first = root.fills && root.fills[0];
  if (!first || first.type !== "solid") root.fills = [{ type: "solid", color: hexOf(doc.background) || "#ffffff" }, ...root.fills || []];
  root.clip = true;
  stats.depth = depthOf(root);
  stats.nodes = countNodes(root);
  if (stats.nodes > MAX_TREE_NODES) return { ok: false, error: `the capture at ${doc.width} px is ${stats.nodes} nodes, more than the ${MAX_TREE_NODES} one spec may hold`, stats };
  if (stats.depth > MAX_TREE_DEPTH) return { ok: false, error: `the capture at ${doc.width} px nests ${stats.depth} levels deep, more than the ${MAX_TREE_DEPTH} one spec may`, stats };
  return { ok: true, spec: root, stats };
}
function depthOf(n) {
  return (n.children || []).reduce((d, c) => Math.max(d, 1 + depthOf(c)), 0);
}
function countNodes(n) {
  return 1 + (n.children || []).reduce((s, c) => s + countNodes(c), 0);
}
function checkCaptured(spec, idOf) {
  const filled = mapImagePaints(spec, "tree", (p) => {
    const id = typeof p.file === "string" ? idOf(p.file) : null;
    return id ? { ...p, image: id } : null;
  });
  return checkTree(filled).problems;
}

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// bridge/src/png.ts
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngSize(b) {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.readUInt32BE(8) < 13 || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
var MAX_DECODE_SIDE = 4096;
var MAX_DECODE_PIXELS = MAX_DECODE_SIDE * MAX_DECODE_SIDE;

// bridge/src/project-file.ts
import fs4 from "node:fs";
var OPEN_FLAGS = fs4.constants.O_RDONLY | (fs4.constants.O_NOFOLLOW ?? 0) | (fs4.constants.O_NONBLOCK ?? 0);

// bridge/src/image-file.ts
var MiB = 1024 * 1024;
var MAX_IMAGE_BYTES = 8 * MiB;
var MAX_BATCH_IMAGE_BYTES = 32 * MiB;
var MAX_IMAGE_SIDE = 4096;
var TAKES = "Figma takes PNG, JPEG or GIF";
function sniffImage(b) {
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (b.length >= 8 && b[0] === 137 && ascii(1, 4) === "PNG") {
    const s = pngSize(b);
    return s ? { format: "PNG", ...s } : { error: "is a damaged PNG (no IHDR header)" };
  }
  if (b.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    if (b.length < 10) return { error: "is a damaged GIF (its header is cut short)" };
    return { format: "GIF", w: (b[6] ?? 0) | (b[7] ?? 0) << 8, h: (b[8] ?? 0) | (b[9] ?? 0) << 8 };
  }
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    const s = jpegSize(b);
    return s ? { format: "JPEG", ...s } : { error: "is a damaged JPEG (no frame header before the image data)" };
  }
  const kind = otherKind(b);
  return { error: (kind ? "is " + kind : "is not an image Figma can take") + "; " + TAKES };
}
function jpegSize(b) {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 255) return null;
    const m = b[i + 1] ?? 0;
    if (m === 255) {
      i++;
      continue;
    }
    if (m === 216 || m === 1 || m >= 208 && m <= 215) {
      i += 2;
      continue;
    }
    if (m === 217 || m === 218) return null;
    const len = (b[i + 2] ?? 0) << 8 | (b[i + 3] ?? 0);
    if (m >= 192 && m <= 207 && m !== 196 && m !== 200 && m !== 204) {
      if (i + 8 >= b.length) return null;
      return { w: (b[i + 7] ?? 0) << 8 | (b[i + 8] ?? 0), h: (b[i + 5] ?? 0) << 8 | (b[i + 6] ?? 0) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}
function otherKind(b) {
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "a WebP image";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    return brand === "avif" || brand === "avis" ? "an AVIF image" : /^(heic|heix|hevc|mif1|msf1)$/.test(brand) ? "a HEIC image" : "an MP4/QuickTime-family file";
  }
  if (ascii(0, 2) === "BM") return "a BMP image";
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "a TIFF image";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "an ICO icon";
  if (ascii(0, 5) === "%PDF-") return "a PDF";
  const head = ascii(0, 1024).replace(/^﻿/, "").replace(/^ï»¿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "an SVG (vector) file (an icon is a component instance; a picture is a PNG, JPEG or GIF)";
  return null;
}

// bridge/src/atomic-write.ts
import crypto2 from "node:crypto";
import fs5 from "node:fs";
import path3 from "node:path";
var tmpSuffix = () => `.tmp-${process.pid}-${crypto2.randomBytes(4).toString("hex")}`;
var RENAME_RETRY_MS = 2e3;
var RENAME_TRANSIENT = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
var sleeper = new Int32Array(new SharedArrayBuffer(4));
function renameOver(from, to) {
  const t0 = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      fs5.renameSync(from, to);
      return;
    } catch (e) {
      const code = errCode(e);
      if (process.platform !== "win32" || code === void 0 || !RENAME_TRANSIENT.has(code) || Date.now() - t0 >= RENAME_RETRY_MS) throw e;
      let dir = false;
      try {
        dir = fs5.statSync(to).isDirectory();
      } catch {
      }
      if (dir) throw e;
      Atomics.wait(sleeper, 0, 0, delay);
    }
  }
}
function syncDir(dir) {
  if (process.platform === "win32") return;
  try {
    const fd = fs5.openSync(dir, "r");
    try {
      fs5.fsyncSync(fd);
    } finally {
      fs5.closeSync(fd);
    }
  } catch {
  }
}
function writeFileAtomic(file, data, opts = {}) {
  const dir = path3.dirname(path3.resolve(file));
  fs5.mkdirSync(dir, { recursive: true });
  const tmp = file + tmpSuffix();
  try {
    if (opts.sync) {
      const fd = fs5.openSync(tmp, "wx", opts.mode);
      try {
        fs5.writeFileSync(fd, data);
        fs5.fsyncSync(fd);
      } finally {
        fs5.closeSync(fd);
      }
    } else {
      fs5.writeFileSync(tmp, data, { flag: "wx", ...opts.mode === void 0 ? {} : { mode: opts.mode } });
    }
    if (opts.mode !== void 0) fs5.chmodSync(tmp, opts.mode);
    renameOver(tmp, file);
  } catch (e) {
    try {
      fs5.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
  if (opts.sync) syncDir(dir);
}

// design-to-code/pw-errors.ts
var CLOSED = /Target closed|Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target crashed|Page crashed/i;
var NAVIGATED = /Execution context was destroyed|frame was detached|Cannot find context with specified id|interrupted by another navigation/i;
var TIMED_OUT = /Timeout \d+\s*ms exceeded/i;
function pwErrorKind(e, page) {
  const name = e instanceof Error ? e.name : "";
  const m = firstLine(e);
  if (page !== void 0 && page.isClosed() || name === "TargetClosedError" || CLOSED.test(m)) return "gone";
  if (name === "TimeoutError") return "timeout";
  if (NAVIGATED.test(m)) return "navigated";
  return TIMED_OUT.test(m) ? "timeout" : "other";
}

// design-to-code/cli-args.ts
import path4 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var SCRIPT_RUNNER = "bun --no-install --no-env-file";
var scriptCmd = (name) => `${SCRIPT_RUNNER} ${shellQuote(path4.join(path4.dirname(SELF), name + path4.extname(SELF)))}`;
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
function badShortWords(args, options) {
  const shorts = /* @__PURE__ */ new Map();
  for (const o of Object.values(options)) if (o.short) shorts.set(o.short, o.type);
  const bad = [];
  let takesNext = false;
  for (const a of args) {
    if (a === "--") break;
    if (takesNext) {
      takesNext = false;
      continue;
    }
    if (a.startsWith("--")) {
      takesNext = !a.includes("=") && options[a.slice(2)]?.type === "string";
      continue;
    }
    if (!/^-[^-]/.test(a)) continue;
    let ok = true;
    for (const [i, c] of [...a.slice(1)].entries()) {
      const type = shorts.get(c);
      if (type === void 0) {
        ok = false;
        break;
      }
      if (type === "string") {
        takesNext = i === a.length - 2;
        break;
      }
    }
    if (!ok) bad.push(a);
  }
  return bad;
}
function cliParse(tool, argv, options, usage, exitCode, parse) {
  const args = joinNegativeValues(argv, options);
  const unknownFlags = () => {
    const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
    const long = tokens.flatMap((t) => t.kind === "option" && t.rawName.startsWith("--") && args[t.index]?.startsWith("--") && !(t.name in options) ? [{ name: t.rawName, at: t.index }] : []);
    const short = badShortWords(args, options);
    const hint = short.some((w) => w.length > 2) ? ' (a value starting with "-": put -- before it, or use --flag=value)' : "";
    const named = [...long, ...short.map((w) => ({ name: w, at: args.indexOf(w) }))].sort((a, b) => a.at - b.at).map((n) => n.name);
    return `${tool}: unknown flag ${[...new Set(named)].join(", ")}${hint}
${usage}`;
  };
  let failure;
  try {
    const parsed = parse(args);
    if (!badShortWords(args, options).length) return parsed;
    failure = unknownFlags();
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      failure = unknownFlags();
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const names = /Option '([^']*)'/.exec(msg)?.[1]?.match(/--?[\w-]+/g) ?? [];
      const typed = names.find((n) => args.some((a) => a === n || a.startsWith(n + "="))) ?? names.at(-1);
      failure = `${tool}: ${typed ?? "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}
${usage}`;
    } else {
      failure = `${tool}: ${errMsg(e)}
${usage}`;
    }
  }
  console.error(failure);
  exitCli(exitCode);
}

// design-to-code/capture-page.ts
var TOOL = "capture-page";
var USAGE = `usage:
  ${scriptCmd(TOOL)} --url <url> [--width 1280[,390,\u2026]] [--height 800] [--root <css selector>] [--name <slug>]
      [--out design/capture] [--project <dir>] [--ready <selector> | none] [--timeout <ms>] [--browser-path <executable>]
      opens <url> (local or remote) in the PROJECT's Playwright (chromium) at each --width (px; default 1280) with a
      --height px viewport (default 800), waits for its load, its fonts, --ready (a selector that must be visible; default
      none) and a quiet DOM, and captures the whole document's height \u2014 or only the --root element's box. It writes, under
      --out (default design/capture, inside --project, the directory the MCP server is started in; default cwd):
        <name>@<width>.json   a tree spec per width, for figma_write {op:"createTree", treeFile:"\u2026"}
        images/<sha256>.<ext> every image the spec paints (PNG, JPEG or GIF as the page loaded it; anything else as a PNG
                              screenshot of that element)
        <name>.capture.json   the report: per width the node count, frames / texts / images, every font (family + style)
                              the spec uses, what was dropped or approximated (counts and sample paths), and the ops
      and prints one summary line, then the figma_write ops as JSON (several widths: one batch, all or nothing).
      --name: the files' slug (letters, digits, . _ -; default from the URL's path, else its host). The root of each spec
      is the frame '<name> @<width>' keyed capture:<name>@<width>, so sending it again updates that frame in place.
      Faithful but plain: raw values, no components or variables. Flex and grid become auto-layout, text real text in
      the font Chromium drew it with (a font the Figma file lacks is refused when the spec lands, never swapped).
      Shadows, gradients, pseudo-element content, transforms and filters are not written (the tree spec has no effects).
      A capture over ${MAX_TREE_NODES} nodes is refused (exit 5): capture part of the page with --root <selector>.
      --browser-path: launch this Chromium executable instead of the one Playwright installed (a cached browser).
  ${scriptCmd(TOOL)} --check [--project <dir>] [--browser-path <executable>]
      resolves the project's Playwright and launches chromium once \u2014 nothing captured, nothing written.
exit: 0 wrote \xB7 2 usage \xB7 3 renderer unavailable (ask the user to install; never installed here) \xB7 4 the page could
      not be loaded or captured (unreachable, timed out, --ready or --root not found, the browser closed) \xB7 5 the capture
      is too large (over ${MAX_TREE_NODES} nodes or the nesting limit, or more than 32 MB of images over all widths: they are one
      batch) \u2014 nothing written. --timeout (default 30000) bounds the page's load, fonts, --ready, images and quiet DOM together,
      then reading what it rendered (its elements, fonts drawn and image bytes) together.`;
var MAX_WALK = 5e3;
var QUIET_MS = 500;
var QUIET_CAP_MS = 1e4;
var IMAGE_WAIT_MS = 5e3;
var CLOSE_MS = 5e3;
var CaptureError = class extends Error {
  exit;
  constructor(message, exit) {
    super(message);
    this.exit = exit;
  }
};
async function within(p, deadline, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CaptureError(`${what} did not finish within --timeout`, 4)), Math.max(0, deadline - Date.now()));
  });
  p.catch(() => void 0);
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
var ImageBudget = class {
  seen = /* @__PURE__ */ new Map();
  total = 0;
  max;
  constructor(max = MAX_BATCH_IMAGE_BYTES) {
    this.max = max;
  }
  /** Counts the image in; the refusal's reason when it would take the batch past the cap (it is then not counted). */
  add(sha, size2) {
    if (this.seen.has(sha)) return null;
    if (this.total + size2 > this.max) return `the images of the capture are more than ${this.max / (1024 * 1024)} MB together (every width is one figma_write batch): capture fewer widths, or part of the page with --root <selector>`;
    this.seen.set(sha, size2);
    this.total += size2;
    return null;
  }
};
function pastDeadline(deadline, what) {
  return Date.now() >= deadline ? new CaptureError(`${what} did not finish within --timeout`, 4) : null;
}
async function keptShot(take, keep, deadline = Infinity) {
  let b;
  try {
    b = await take();
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    const late = pastDeadline(deadline, "taking an element's screenshot");
    if (late) throw late;
    return null;
  }
  return keep(b);
}
function outputEscape(project, dirs, files) {
  const real = fs6.realpathSync(project);
  const inside = (p) => {
    const r = path5.relative(real, p);
    return r === "" || !r.startsWith("..") && !path5.isAbsolute(r);
  };
  const lexists = (p) => {
    try {
      fs6.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  for (const d of dirs) {
    let at2 = path5.resolve(d);
    while (!lexists(at2) && path5.dirname(at2) !== at2) at2 = path5.dirname(at2);
    let r;
    try {
      r = fs6.realpathSync(at2);
    } catch {
      return `${at2} is a link that leads nowhere`;
    }
    if (!inside(r)) return `${at2} leads out of --project (${project}) to ${r}`;
    if (lexists(d) && !fs6.statSync(d).isDirectory()) return `${d} is not a directory`;
  }
  for (const f of files) {
    let st = null;
    try {
      st = fs6.lstatSync(f);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) return `${f} is a symbolic link (never written through)`;
    if (st && !st.isFile()) return `${f} is not a file`;
  }
  return null;
}
function nameFromUrl(url) {
  let u = null;
  try {
    u = new URL(url);
  } catch {
    u = null;
  }
  const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const noExt = (s) => s.replace(/\.[a-z0-9]+$/i, "");
  if (!u) return clean(noExt(url)).slice(0, 60) || "page";
  const segs = u.pathname.split("/").filter((s) => s !== "" && !/^index\.html?$/i.test(s)).map((s) => clean(noExt(s))).filter((s) => s !== "");
  const host = clean(u.hostname.replace(/^www\./, ""));
  return (segs.length ? segs.join("-") : host || "page").slice(0, 60) || "page";
}
async function settle(page, url, ready, timeout) {
  const deadline = Date.now() + timeout;
  const left = () => Math.max(1, deadline - Date.now());
  const fonts = async () => await within(page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true").catch(() => void 0), deadline, `the page's fonts (document.fonts.ready, ${timeout} ms)`);
  try {
    await page.goto(url, { waitUntil: "load", timeout: left() });
  } catch (e) {
    const kind = pwErrorKind(e, page);
    throw new CaptureError(kind === "timeout" ? `${url} did not finish loading within ${timeout} ms` : `${url} could not be loaded (${firstLine(e)})`, 4);
  }
  await fonts();
  if (ready !== null) {
    try {
      await page.locator(ready).first().waitFor({ state: "visible", timeout: left() });
    } catch (e) {
      throw new CaptureError(`--ready ${ready} was not visible within ${timeout} ms (${firstLine(e)})`, 4);
    }
  }
  const end = Math.min(deadline, Date.now() + IMAGE_WAIT_MS);
  const eager = async () => await within(page.evaluate(eagerImages), deadline, `making the page's images load (${timeout} ms)`);
  for (let loading = await eager(); loading > 0 && Date.now() < end; loading = await eager()) await sleep(100);
  await within(page.evaluate(`new Promise((done) => {
    let last = Date.now();
    const o = new MutationObserver(() => { last = Date.now(); });
    o.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const start = Date.now();
    const tick = () => { if (Date.now() - last >= ${QUIET_MS} || Date.now() - start >= ${QUIET_CAP_MS}) { o.disconnect(); done(true); } else setTimeout(tick, 50); };
    tick();
  })`).catch(() => void 0), deadline, `waiting for a quiet DOM (${timeout} ms)`);
  await fonts();
}
var num2 = (v, d = 0) => typeof v === "number" && Number.isFinite(v) ? v : d;
var str2 = (v) => typeof v === "string" ? v : "";
var sides = (v) => {
  const a = Array.isArray(v) ? v : [];
  return [num2(a[0]), num2(a[1]), num2(a[2]), num2(a[3])];
};
var TRANSPARENT = /^(transparent|rgba\([^)]*,\s*0(?:\.0+)?\s*\))$/;
var paint = (v) => {
  const c = str2(v).trim();
  return c && !TRANSPARENT.test(c) ? c : null;
};
function faceStyle(face) {
  const i = face.lastIndexOf("-");
  const tail = (i < 0 ? "" : face.slice(i + 1)).replace(/(MT|PS)$/, "").toLowerCase();
  const italic = /italic|oblique/.test(tail);
  const w = tail.replace(/italic|oblique/g, "");
  const table = [
    [/^(thin|hairline)$/, 100],
    [/^(extra|ultra)light$/, 200],
    [/^light$/, 300],
    [/^(regular|roman|book|normal|)$/, 400],
    [/^medium$/, 500],
    [/^(semi|demi)bold$/, 600],
    [/^bold$/, 700],
    [/^(extra|ultra)bold$/, 800],
    [/^(black|heavy)$/, 900]
  ];
  const hit = i < 0 ? void 0 : table.find(([re]) => re.test(w));
  return { weight: hit ? hit[1] : null, italic };
}
async function renderedFamilies(context, page, paths) {
  const out = /* @__PURE__ */ new Map();
  if (!paths.length) return out;
  const s = await context.newCDPSession(page);
  try {
    await s.send("DOM.enable");
    await s.send("CSS.enable");
    const doc = await s.send("DOM.getDocument", { depth: 0 });
    for (const p of paths) {
      try {
        const q = await s.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: p });
        if (!q.nodeId) continue;
        const f = await s.send("CSS.getPlatformFontsForNode", { nodeId: q.nodeId });
        const best = [...f.fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
        if (best && best.familyName) out.set(p, { family: best.familyName, face: best.postScriptName });
      } catch {
      }
    }
  } finally {
    await s.detach().catch(() => void 0);
  }
  return out;
}
var EXT = { PNG: "png", JPEG: "jpg", GIF: "gif" };
function dataUrlBytes(u) {
  const m = /^data:([^,]*),(.*)$/s.exec(u);
  if (!m) return null;
  const meta = m[1] || "", body = m[2] || "";
  try {
    return /;base64$/i.test(meta) ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  } catch {
    return null;
  }
}
var Images = class {
  kept = /* @__PURE__ */ new Map();
  page;
  loaded;
  outRel;
  timeout;
  budget;
  /** epoch ms: every wait while the images are collected (a body that never ends, a page stuck in a script) stops here */
  deadline;
  constructor(page, loaded, outRel, timeout, budget, deadline) {
    this.page = page;
    this.loaded = loaded;
    this.outRel = outRel;
    this.timeout = timeout;
    this.budget = budget;
    this.deadline = deadline;
  }
  /** What is left of the deadline, for Playwright's own timeouts (never 0: to Playwright that is none). */
  left() {
    return Math.max(1, this.deadline - Date.now());
  }
  /** Bytes Figma takes, kept; null when they are not (a format it does not take, too big, too many pixels). */
  keep(b) {
    if (b.length > MAX_IMAGE_BYTES) return null;
    const s = sniffImage(b);
    if ("error" in s || s.w < 1 || s.h < 1 || s.w > MAX_IMAGE_SIDE || s.h > MAX_IMAGE_SIDE) return null;
    const sha = sha256Hex(b);
    const had = this.kept.get(sha);
    if (had) return had;
    const over = this.budget.add(sha, b.length);
    if (over !== null) throw new CaptureError(over, 5);
    const k = { bytes: b, ext: EXT[s.format], sha, w: s.w, h: s.h };
    this.kept.set(sha, k);
    return k;
  }
  fileOf(k) {
    return this.outRel + "/images/" + k.sha + "." + k.ext;
  }
  /** The image at `url` as the page loaded it, when Figma takes it. */
  async source(url) {
    if (!url) return null;
    let b = null;
    if (/^data:/i.test(url)) b = dataUrlBytes(url);
    else if (/^https?:/i.test(url)) {
      b = await within(this.loaded.get(url) ?? Promise.resolve(null), this.deadline, `reading the image ${url.slice(0, 120)}`);
      if (!b) {
        try {
          const r = await this.page.request.get(url, { timeout: this.left() });
          b = r.ok() ? await r.body() : null;
        } catch {
          const late = pastDeadline(this.deadline, `reading the image ${url.slice(0, 120)}`);
          if (late) throw late;
          b = null;
        }
      }
    }
    return b ? this.keep(b) : null;
  }
  /** A PNG of the element alone (its children hidden when `hide`), or null when it cannot be taken or is too big. */
  async screenshot(p, hide) {
    try {
      return await keptShot(async () => {
        if (hide) await within(this.page.evaluate(hideChildren, { path: p, hide: true }), this.deadline, "hiding an element's content for its screenshot");
        return await byPath(this.page, p).screenshot({ timeout: Math.min(this.timeout, this.left()), animations: "disabled", scale: "css" });
      }, (b) => this.keep(b), this.deadline);
    } finally {
      if (hide) {
        await within(this.page.evaluate(hideChildren, { path: p, hide: false }), this.deadline, "restoring an element after its screenshot").catch((e) => {
          if (e instanceof CaptureError) throw e;
          const late = pastDeadline(this.deadline, "restoring an element after its screenshot");
          if (late) throw late;
        });
      }
    }
  }
};
function fitOf(fit, img, box) {
  if (fit === "cover") return { scaleMode: "fill" };
  if (fit === "contain") return { scaleMode: "fit" };
  if (fit === "none" || fit === "scale-down") return { scaleMode: "fit", note: `object-fit ${fit} \u2192 fit` };
  const same = box.w > 0 && box.h > 0 && Math.abs(img.w / img.h - box.w / box.h) < 0.01 * (img.w / img.h);
  return same ? { scaleMode: "fill" } : { scaleMode: "fill", note: "a stretched image (object-fit fill) \u2192 fill (cropped)" };
}
function bgFitOf(size2, repeat, img, box) {
  const s = size2.split(",")[0]?.trim() || "auto";
  const r = repeat.split(",")[0]?.trim() || "repeat";
  if (s === "cover") return { scaleMode: "fill" };
  if (s === "contain") return { scaleMode: "fit" };
  if (!/no-repeat/.test(r) && (s === "auto" || s === "auto auto")) return { scaleMode: "tile", scale: 1 };
  const exact = Math.abs(img.w - box.w) < 1 && Math.abs(img.h - box.h) < 1;
  return exact ? { scaleMode: "fill" } : { scaleMode: "fill", note: `background-size ${s} / ${r} \u2192 fill` };
}
async function captureWidth(browser, width, o) {
  const context = await browser.newContext(contextOptions({ w: width, h: o.height }));
  try {
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();
    page.setDefaultTimeout(o.timeout);
    const loaded = /* @__PURE__ */ new Map();
    page.on("response", (r3) => {
      if (r3.request().resourceType() === "image" && r3.ok()) loaded.set(r3.url(), r3.body().catch(() => null));
    });
    await settle(page, o.url, o.ready, o.timeout);
    const deadline = Date.now() + o.timeout;
    const walked = await within(page.evaluate(walkCapture, { root: o.root, maxElements: MAX_WALK }), deadline, `reading the page's elements (${o.timeout} ms)`);
    if (!walked.root) throw new CaptureError(walked.missing ?? "nothing to capture", 4);
    if (walked.elements > MAX_WALK) throw new CaptureError(`the page at ${width} px shows more than ${MAX_WALK} elements (${walked.elements}); one spec holds ${MAX_TREE_NODES} nodes \u2014 capture part of it with --root <selector>`, 5);
    const els = [];
    const collect = (e) => {
      els.push(e);
      for (const c of e.children) if (c.kind === "el") collect(c);
    };
    collect(walked.root);
    const items = els.map((e) => ({ nodeId: e.path, path: e.path, isText: e.text !== null, isPaint: false, isPlaceholder: e.control !== null && e.control.placeholder, sharesWith: null, assetSpec: e.media === "img" }));
    for (const p of [walked.htmlPath, walked.bodyPath]) if (p) items.push({ nodeId: "page:" + p, path: p, isText: false, isPaint: false, isPlaceholder: false, sharesWith: null });
    const rootRect = walked.root.rect;
    const measured = await within(page.evaluate(measureElements, { frameRect: rootRect, framePath: walked.root.path, keys: STYLE_KEYS, items, capture: true }), deadline, `measuring the page's elements (${o.timeout} ms)`);
    const byPathM = new Map(measured.map((m) => [m.nodeId, m]));
    const notes = [];
    const gone = measured.filter((m) => !m.found).length;
    if (gone) notes.push(`${gone} element(s) were gone by the time they were measured (the page changed while it was read)`);
    const textPaths = /* @__PURE__ */ new Set();
    for (const e of els) if (e.text || e.control || e.children.some((c) => c.kind === "run")) textPaths.add(e.path);
    const families = await within(renderedFamilies(context, page, [...textPaths]), deadline, `reading the fonts the page drew (${o.timeout} ms)`);
    const images = new Images(page, loaded, o.outRel, o.timeout, o.budget, deadline);
    const styleOf = (e) => byPathM.get(e.path)?.styles ?? {};
    const fontOf2 = (e, placeholder = false) => {
      const s = styleOf(e);
      const stack = str2(s.fontFamily);
      const drawn = families.get(e.path);
      const asked = num2(s.fontWeight, 400);
      const face = drawn ? faceStyle(drawn.face) : { weight: null, italic: false };
      return {
        family: drawn ? drawn.family : firstFamily(stack),
        size: num2(s.fontSize, 16),
        weight: face.weight !== null && face.weight >= Math.round(asked / 100) * 100 ? face.weight : asked,
        italic: face.italic || /italic|oblique/.test(str2(s.fontStyle) || e.fontStyle),
        lineHeight: typeof s.lineHeight === "number" ? s.lineHeight : null,
        letterSpacing: num2(s.letterSpacing),
        color: (placeholder ? str2(s.placeholderColor) : "") || str2(s.color) || "rgb(0, 0, 0)",
        textAlign: e.textAlign,
        direction: e.direction,
        textTransform: str2(s.textTransform),
        textDecoration: str2(s.textDecoration) || e.textDecoration
      };
    };
    const borderOf = (s) => {
      const from = str2(s.strokeFrom);
      const widths = sides(s.borderWidths);
      const color = paint(s.borderColor);
      if (!color || !widths.some((w) => w > 0) || from !== "border" && from !== "box-shadow" && from !== "outline") return null;
      const align = str2(s.strokeAlign);
      return { widths, color, from, align: align === "outside" || align === "center" ? align : "inside" };
    };
    const runText = (r3, parent) => ({ kind: "text", text: r3.text, rect: r3.rect, lines: r3.lines, font: fontOf2(parent) });
    const convert = async (e, isRoot) => {
      const s = styleOf(e);
      const radius = s.borderRadius;
      const border = borderOf(s);
      const dropped = e.dropped.filter((d) => !(d === "shadow" && border !== null && border.from === "box-shadow"));
      const el = {
        kind: "el",
        path: e.path,
        tag: e.tag,
        name: e.name,
        rect: e.rect,
        display: e.display,
        position: e.position,
        zIndex: e.zIndex,
        flexDirection: e.flexDirection,
        flexWrap: e.flexWrap,
        justifyContent: e.justifyContent,
        alignItems: e.alignItems,
        alignSelf: e.alignSelf,
        flexGrow: e.flexGrow,
        order: e.order,
        gridColumns: e.gridColumns,
        gridRows: e.gridRows,
        gridPlaced: e.gridPlaced,
        rowGap: e.rowGap,
        columnGap: e.columnGap,
        padding: sides(s.padding),
        background: isRoot && o.root === null ? null : paint(s.backgroundColor),
        border,
        radius: typeof radius === "number" ? radius > 0 ? radius : null : Array.isArray(radius) ? sides(radius) : null,
        opacity: num2(s.opacity, 1),
        clip: e.clip,
        media: e.media,
        image: null,
        backgroundImage: null,
        text: null,
        dropped,
        children: []
      };
      if (e.text) {
        el.text = { kind: "text", text: e.text.drawn ?? (str2(s.text) || ""), rect: e.text.rect, lines: e.text.lines, font: fontOf2(e), ...e.text.mixed ? { mixed: true } : {} };
        if (!el.text.text) el.text = null;
      }
      if (e.control && e.control.text) el.text = { kind: "text", text: e.control.text.replace(/\s+/g, " ").trim(), rect: e.rect, lines: 1, font: fontOf2(e, e.control.placeholder), control: true };
      if (e.media) {
        let k = null, from = "source";
        if (e.media === "img") {
          const a = s.assetIdentity;
          const src = a && typeof a === "object" && !Array.isArray(a) && typeof a.src === "string" ? a.src : e.src ?? "";
          k = await images.source(src);
        }
        if (!k) {
          k = await images.screenshot(e.path, false);
          from = "screenshot";
        }
        if (k) el.image = { file: images.fileOf(k), sha256: k.sha, w: k.w, h: k.h, from, ...from === "source" ? fitOf(e.objectFit, k, e.rect) : { scaleMode: "fill" } };
      }
      const bgUrl = e.backgroundImages[0];
      if (bgUrl && !e.media) {
        const k = await images.source(bgUrl);
        if (k) el.backgroundImage = { file: images.fileOf(k), sha256: k.sha, w: k.w, h: k.h, from: "source", ...bgFitOf(e.backgroundSize, e.backgroundRepeat, k, e.rect) };
        else {
          const shot = await images.screenshot(e.path, e.children.length > 0 || e.text !== null);
          if (shot) el.backgroundImage = { file: images.fileOf(shot), sha256: shot.sha, w: shot.w, h: shot.h, from: "screenshot", scaleMode: "fill" };
          else el.dropped.push("image");
        }
      }
      for (const c of e.children) el.children.push(c.kind === "el" ? await convert(c, false) : runText(c, e));
      return el;
    };
    const root = await convert(walked.root, true);
    const late = pastDeadline(deadline, `reading the page at ${width} px (${o.timeout} ms)`);
    if (late) throw late;
    const htmlBg = paint(byPathM.get("page:" + walked.htmlPath)?.styles.backgroundColor);
    const bodyBg = walked.bodyPath ? paint(byPathM.get("page:" + walked.bodyPath)?.styles.backgroundColor) : null;
    const doc = { name: o.name, width, url: o.url, document: o.root === null, background: bodyBg ?? htmlBg, root };
    const r = captureSpec(doc);
    if (!r.ok) throw new CaptureError(`${r.error} \u2014 capture part of the page with --root <selector> (a section, the main column)`, 5);
    const ids = new Map([...images.kept.values()].map((k) => [images.fileOf(k), k.sha]));
    const problems = checkCaptured(r.spec, (f) => ids.get(f) ?? null);
    if (problems.length) throw new Error(`the spec for ${width} px fails the tree spec's own check \u2014 a bug in the capture, nothing written:
${problems.slice(0, 10).join("\n")}`);
    return { doc, spec: r.spec, stats: r.stats, images: [...images.kept.values()], skipped: walked.skipped, notes, outRel: o.outRel };
  } finally {
    await within(context.close(), Date.now() + CLOSE_MS, "closing the page").catch(() => void 0);
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
    url: { type: "string" },
    width: { type: "string" },
    height: { type: "string" },
    root: { type: "string" },
    name: { type: "string" },
    out: { type: "string" },
    project: { type: "string" },
    ready: { type: "string" },
    timeout: { type: "string" },
    "browser-path": { type: "string" },
    check: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: f } = cliParse(TOOL, argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: false }));
  const usage = (msg) => {
    console.error(`${TOOL}: ${msg}
${USAGE}`);
    return 2;
  };
  const project = path5.resolve(f.project ?? ".");
  if (!fs6.existsSync(project) || !fs6.statSync(project).isDirectory()) return usage(`--project ${project} is not a directory`);
  const timeout = f.timeout === void 0 ? 3e4 : Number(f.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return usage("--timeout must be a positive number of milliseconds");
  if (f.check) {
    for (const k of ["url", "width", "height", "root", "name", "out", "ready"]) if (f[k] !== void 0) return usage(`--${k} does not apply to --check`);
  } else if (!f.url) return usage("--url is required");
  const widths = (f.width ?? "1280").split(",").map((w) => w.trim());
  if (!widths.every((w) => /^\d+$/.test(w) && Number(w) >= 100 && Number(w) <= 4096)) return usage(`--width must be one width or a comma list, each a whole number of px from 100 to 4096 (got '${f.width ?? ""}')`);
  const widthList = [...new Set(widths.map(Number))];
  const height = f.height === void 0 ? 800 : Number(f.height);
  if (!Number.isInteger(height) || height < 100 || height > 4096) return usage("--height must be a whole number of px from 100 to 4096");
  if (f.ready !== void 0 && f.ready.trim() === "") return usage("--ready must be a selector or none");
  if (f.root !== void 0 && f.root.trim() === "") return usage("--root must be a CSS selector");
  const name = f.name ?? nameFromUrl(f.url ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(name)) return usage(`--name must be letters, digits, . _ - (at most 80, starting with a letter or digit), got '${name}'`);
  const outAbs = path5.resolve(project, f.out ?? path5.join("design", "capture"));
  const outRel = path5.relative(project, outAbs).split(path5.sep).join("/");
  if (outRel === "" || outRel.startsWith("..") || path5.isAbsolute(outRel)) return usage(`--out must be a directory inside --project (${project}), where the MCP server reads it from`);
  const fileOf = (rel) => path5.join(project, ...rel.split("/"));
  const specRel = (w) => `${outRel}/${name}@${w}.json`;
  const reportRel = `${outRel}/${name}.capture.json`;
  const outDirs = [outAbs, path5.join(outAbs, "images")];
  const escaped = f.check ? null : outputEscape(project, outDirs, [...widthList.map((w) => fileOf(specRel(w))), fileOf(reportRel)]);
  if (escaped !== null) return usage(`--out must stay inside --project on disk: ${escaped} \u2014 nothing written`);
  let url = f.url ?? "";
  if (!f.check && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    const file = path5.resolve(url);
    if (!fs6.existsSync(file)) return usage(`--url ${url} is not a URL, and no file is there`);
    url = "file://" + file.split(path5.sep).join("/").replace(/^([A-Za-z]):/, "/$1:");
  }
  const browserPath = f["browser-path"];
  if (browserPath !== void 0) {
    const bad = browserPathError(browserPath);
    if (bad !== null) return rendererUnavailable(bad, null, TOOL, "captured or written");
  }
  const res = resolvePlaywright(project);
  if (!res.ok) return rendererUnavailable(res.reason, res.hint, TOOL, "captured or written");
  const launched = await launch(res, project, browserPath);
  if ("error" in launched) return rendererUnavailable(launched.error, launched.hint, TOOL, "captured or written");
  const browser = launched.browser;
  const results = [];
  const budget = new ImageBudget();
  try {
    if (f.check) {
      console.log(`ok  ${res.pkg} ${res.version} (from ${path5.relative(project, res.file) || res.file}) \xB7 chromium ${browser.version()}${browserPath !== void 0 ? ` (--browser-path ${browserPath})` : ""} \u2014 ready to capture`);
      return 0;
    }
    const ready = f.ready === void 0 || f.ready === "none" ? null : f.ready;
    for (const w of widthList) results.push(await captureWidth(browser, w, { url, name, root: f.root ?? null, height, ready, timeout, outRel, budget }));
  } catch (e) {
    if (e instanceof CaptureError) {
      console.error(`${TOOL}: ${e.message} \u2014 nothing written.`);
      return e.exit;
    }
    if (pwErrorKind(e) === "gone") {
      console.error(`${TOOL}: the page or browser closed or crashed (${firstLine(e)}) \u2014 nothing written. Run again; if it recurs, run --check.`);
      return 4;
    }
    if (pwErrorKind(e) === "timeout") {
      console.error(`${TOOL}: timed out \u2014 ${firstLine(e)} \u2014 nothing written.`);
      return 4;
    }
    throw e;
  } finally {
    await within(browser.close(), Date.now() + CLOSE_MS, "closing the browser").catch(() => void 0);
  }
  const images = /* @__PURE__ */ new Map();
  for (const r of results) for (const k of r.images) images.set(r.outRel + "/images/" + k.sha + "." + k.ext, k);
  const ops = results.map((r) => ({ op: "createTree", treeFile: specRel(r.doc.width) }));
  const late = outputEscape(project, outDirs, [...[...images.keys(), ...ops.map((o) => o.treeFile), reportRel].map(fileOf)]);
  if (late !== null) return usage(`--out must stay inside --project on disk: ${late} \u2014 nothing written`);
  fs6.mkdirSync(path5.join(outAbs, "images"), { recursive: true });
  for (const [rel, k] of images) if (!fs6.existsSync(fileOf(rel))) writeFileAtomic(fileOf(rel), k.bytes);
  const imageFiles = new Set(images.keys());
  results.forEach((r, i) => writeFileAtomic(fileOf(ops[i]?.treeFile ?? ""), JSON.stringify(r.spec, null, 1) + "\n"));
  const fonts = [];
  for (const r of results) for (const ft of r.stats.fonts) if (!fonts.some((x) => x.family === ft.family && x.style === ft.style)) fonts.push(ft);
  const report = {
    url: f.url,
    name,
    fonts,
    fontsNote: "every family and style the specs use; a font the Figma file lacks is refused when the spec lands (with the closest names it has), never swapped",
    widths: results.map((r, i) => ({
      width: r.doc.width,
      height: r.doc.root.rect.h,
      spec: ops[i]?.treeFile,
      nodes: r.stats.nodes,
      frames: r.stats.frames,
      texts: r.stats.texts,
      images: r.stats.images,
      depth: r.stats.depth,
      fonts: r.stats.fonts,
      dropped: r.stats.dropped,
      approximated: r.stats.approximated,
      skipped: r.skipped,
      notes: r.notes
    })),
    images: [...imageFiles],
    notWritten: "shadows, gradients, pseudo-element content (::before/::after), transforms and filters: the tree spec has no effects",
    ops
  };
  writeFileAtomic(fileOf(reportRel), JSON.stringify(report, null, 2) + "\n");
  const per = results.map((r) => `${r.doc.width}: ${r.stats.nodes} nodes (${r.stats.frames} frames, ${r.stats.texts} texts, ${r.stats.images} images)`).join(" \xB7 ");
  console.log(`${TOOL}: ${name} \u2014 ${per}; ${fonts.length} font${fonts.length === 1 ? "" : "s"} \u2192 ${reportRel}`);
  console.log(JSON.stringify({ ops }));
  return 0;
}
if (import.meta.main) runCli(main, { name: TOOL, errorLine: (e) => `${TOOL}: ${errMsg(e)}` });
export {
  CaptureError,
  ImageBudget,
  captureWidth,
  faceStyle,
  keptShot,
  main,
  nameFromUrl,
  outputEscape,
  pastDeadline,
  within
};
