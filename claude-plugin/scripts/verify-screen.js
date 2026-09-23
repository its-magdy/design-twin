// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/hidden.js
var require_hidden = __commonJS({
  "design-to-code/hidden.js"(exports2, module2) {
    var hiddenSelf = (node) => !!(node && typeof node === "object" && node.hidden);
    var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
    function walkWithHidden2(root, fn, opts) {
      const pathOf = opts && opts.pathOf || ((n, i) => n.name || n.type || String(i));
      (function go(node, parentHidden, path2, parent, depth) {
        if (!node || typeof node !== "object") return;
        const hidden = isHidden(node, parentHidden);
        fn(node, { hidden, parentHidden: !!parentHidden, path: path2, parent, depth });
        const kids = Array.isArray(node.children) ? node.children : [];
        for (let i = 0; i < kids.length; i++) go(kids[i], hidden, (path2 ? path2 + " > " : "") + pathOf(kids[i], i), node, depth + 1);
      })(root, false, root && pathOf(root, 0), null, 0);
    }
    function hiddenIds(roots) {
      const out = [];
      for (const r of roots || []) walkWithHidden2(r, (n, c) => {
        if (c.hidden && n.id) out.push(n.id);
      });
      return out;
    }
    function hiddenRoots(roots) {
      const out = [];
      for (const r of roots || []) walkWithHidden2(r, (n, c) => {
        if (c.hidden && !c.parentHidden) out.push(n);
      });
      return out;
    }
    module2.exports = { hiddenSelf, isHidden, walkWithHidden: walkWithHidden2, hiddenIds, hiddenRoots };
  }
});

// design-to-code/content-hash.js
var require_content_hash = __commonJS({
  "design-to-code/content-hash.js"(exports2, module2) {
    var fs = require("fs");
    var path = require("path");
    var crypto = require("crypto");
    var sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
    function stripPullTimes(v, parentKey) {
      if (Array.isArray(v)) return v.map((x) => stripPullTimes(x, parentKey));
      if (!v || typeof v !== "object") return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "exportedAt") continue;
        if (k === "at" && parentKey === "_slices") continue;
        out[k] = stripPullTimes(x, k);
      }
      return out;
    }
    function exportContentSha2562(docs) {
      const list = Array.isArray(docs) ? docs : [docs];
      return sha256(JSON.stringify(list.map((d) => stripPullTimes(d))));
    }
    function fileHashes2(files, cwd) {
      const out = {};
      for (const rel of Array.isArray(files) ? files.map(String) : []) {
        try {
          out[rel] = sha256(fs.readFileSync(path.join(cwd, rel))).slice(0, 16);
        } catch {
          out[rel] = null;
        }
      }
      return out;
    }
    function gitHead2(cwd) {
      try {
        const r = require("child_process").spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
        const h = r.status === 0 && String(r.stdout || "").trim();
        return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
      } catch {
        return null;
      }
    }
    module2.exports = { stripPullTimes, exportContentSha256: exportContentSha2562, fileHashes: fileHashes2, gitHead: gitHead2 };
  }
});

// design-to-code/catalog-input.js
var require_catalog_input = __commonJS({
  "design-to-code/catalog-input.js"(exports2, module2) {
    function isManifest(doc, payloadKey) {
      return !!(doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) && !Array.isArray(doc[payloadKey]));
    }
    function assertNotManifest(doc, givenPath, payloadKey, wantFile) {
      if (isManifest(doc, payloadKey)) {
        console.error(
          `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.
       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.
       Pass the split file instead \u2014 e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile} (relative to the export dir that holds ${givenPath}).`
        );
        process.exit(2);
      }
    }
    function readJsonFile(file, what, hint) {
      const fs2 = require("fs");
      let raw;
      try {
        raw = fs2.readFileSync(file, "utf8");
      } catch (e) {
        const why = e && e.code === "ENOENT" ? "does not exist" : e && e.code === "EISDIR" ? "is a directory, not a file" : e && e.code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${e && e.code || e})`;
        console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `
       ${hint}` : ""));
        process.exit(2);
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error(`error  ${what}: '${file}' is not valid JSON \u2014 ${e && e.message || e}`);
        process.exit(2);
      }
    }
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull --design-system` to create it.";
    module2.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
  }
});

// design-to-code/verify-screen.js
var { walkWithHidden } = require_hidden();
var { exportContentSha256, fileHashes, gitHead } = require_content_hash();
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
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("") + "ff";
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return "#" + m[1] + (m[2] || "ff");
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return s;
    const a = p.length > 3 ? p[3] : 1;
    if (a === 0) return "transparent";
    const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
    return "#" + hex(p[0]) + hex(p[1]) + hex(p[2]) + hex(Math.round(a * 255));
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
  return String(v).split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}
function lineHeightPx(lh, fontSize) {
  if (lh == null) return null;
  if (typeof lh === "number") return lh;
  if (typeof lh === "string") {
    const s = lh.trim().toLowerCase();
    if (s === "normal") return null;
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    if (s.endsWith("%")) return fontSize ? n / 100 * fontSize : null;
    if (s.endsWith("px")) return n;
    return fontSize ? n * fontSize : null;
  }
  if (typeof lh === "object") {
    if (lh.unit === "PERCENT" || lh.unit === "%") return fontSize ? lh.value / 100 * fontSize : null;
    if (lh.unit === "AUTO") return null;
    return typeof lh.value === "number" ? lh.value : null;
  }
  return null;
}
var EXPECTATION_SCHEMA = "designtwin/verify-expectation@2";
var REPORT_SCHEMA = "designtwin/verify-report@2";
function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}
var firstSolid = (fills) => (fills || []).find((f) => f && f.type === "solid" && f.visible !== false);
var num = (v) => typeof v === "number" && Number.isFinite(v);
var r2 = (v) => Math.round(v * 100) / 100;
var STATE_WORD = /(?:^|[^a-z])(hover(?:ed)?|pressed|focus(?:ed)?)(?:[^a-z]|$)/i;
var normState = (w) => /^hover/i.test(w) ? "hover" : /^press/i.test(w) ? "pressed" : "focus";
function drawnStateOf(n) {
  const fillTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills || Array.isArray(n.fills) && n.fills.map((f) => f && f.tokens && f.tokens.color).find((t) => typeof t === "string") || null;
  let m = fillTok && STATE_WORD.exec(fillTok);
  if (m) return { state: normState(m[1]), why: `its fill is bound to '${fillTok}'` };
  for (const [k, v] of Object.entries(n.props || {})) {
    if (typeof v === "string" && /^\s*(hover(?:ed)?|pressed|focus(?:ed)?)\s*$/i.test(v)) return { state: normState(v.trim()), why: `variant ${k}=${v}` };
  }
  for (const pair of String(n.component || "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s && s.trim());
    if (k && v && /^(hover(?:ed)?|pressed|focus(?:ed)?)$/i.test(v)) return { state: normState(v), why: `variant ${k}=${v}` };
  }
  return null;
}
var PAINT_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
var isPaintNode = (n) => PAINT_TYPES.has(n.type) || typeof n.asset === "string" && /\.svg$/i.test(n.asset);
function isPlaceholder(n) {
  if (n.type !== "TEXT") return false;
  const toks = [n.tokens && n.tokens.fills, ...Array.isArray(n.fills) ? n.fills.map((f) => f && f.tokens && f.tokens.color) : []];
  return toks.some((t) => typeof t === "string" && /placeholder/i.test(t)) || /placeholder/i.test(n.name || "");
}
function framePosition(n, frame) {
  if (!frame || !num(frame.x) || !num(frame.y)) return null;
  const b = n.box || {}, rb = n.renderBox;
  if (n.type === "TEXT") {
    if (rb && num(rb.x)) return { x: r2(rb.x - frame.x), source: "renderBox" };
    if (num(b.x)) return { x: r2(b.x - frame.x), source: "box" };
    return null;
  }
  if (num(b.x) && num(b.y)) return { x: r2(b.x - frame.x), y: r2(b.y - frame.y), source: "box" };
  if (rb && num(rb.x) && num(rb.y) && num(b.w) && num(b.h) && Math.abs(rb.w - b.w) <= 0.5 && Math.abs(rb.h - b.h) <= 0.5) {
    return { x: r2(rb.x - frame.x), y: r2(rb.y - frame.y), source: "renderBox" };
  }
  return null;
}
var inFlowChildren = (n) => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden && !c.absolute);
var growsAlong = (c, dir) => c.grow === 1 || c.grow === true || (dir === "column" ? c.heightMode === "fill" : c.widthMode === "fill");
function expectNode(n, ctxOrPath) {
  const ctx = typeof ctxOrPath === "string" || ctxOrPath == null ? { path: ctxOrPath } : ctxOrPath;
  const spec = { nodeId: n.id, name: n.name, type: n.type, path: ctx.path };
  const notComparable = [];
  const skip = (field, value, why) => notComparable.push({ nodeId: n.id, name: n.name, field, value, why });
  if (n.text != null) spec.text = n.text;
  else if (n.characters != null) spec.text = n.characters;
  if (n.font) {
    spec.fontFamily = n.font.family;
    if (typeof n.font.size === "number") spec.fontSize = n.font.size;
    const w = normWeight(n.font.weight);
    if (w != null) spec.fontWeight = w;
    const lh = lineHeightPx(n.font.lineHeight, n.font.size);
    if (lh != null) spec.lineHeight = lh;
    if (n.font.letterSpacing && typeof n.font.letterSpacing.value === "number" && n.font.letterSpacing.unit !== "PERCENT") {
      spec.letterSpacing = n.font.letterSpacing.value;
    }
    if (n.font.color) spec.color = normColor(n.font.color);
  }
  const fill = firstSolid(Array.isArray(n.fills) ? n.fills : null);
  if (fill && n.type !== "TEXT") {
    if (isPaintNode(n)) spec.fill = normColor(fill.color);
    else spec.backgroundColor = normColor(fill.color);
  }
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);
  if (isPlaceholder(n)) {
    spec.placeholder = true;
    if (spec.text !== void 0) {
      spec.placeholderText = spec.text;
      delete spec.text;
    }
    if (spec.color !== void 0) {
      spec.placeholderColor = spec.color;
      delete spec.color;
    }
  }
  const st = n.strokes;
  if (st && typeof st === "object" && Array.isArray(st.colors) && st.colors.length) {
    spec.borderColor = normColor(st.colors[0]);
    if (typeof st.weight === "number") spec.borderWidth = st.weight;
    else if (st.weights && typeof st.weights === "object") spec.borderWidths = ["top", "right", "bottom", "left"].map((k) => typeof st.weights[k] === "number" ? st.weights[k] : 0);
  }
  if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const c = ["tl", "tr", "br", "bl"].map((k) => num(n.radius[k]) ? n.radius[k] : 0);
    if (c.every((v) => v === c[0])) spec.borderRadius = c[0];
    else spec.radiusCorners = { tl: c[0], tr: c[1], br: c[2], bl: c[3] };
  }
  const L = n.layout;
  if (L && typeof L === "object") {
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : void 0;
    if (g !== void 0) {
      const dir = L.flexDirection === "column" ? "column" : "row";
      const flow = inFlowChildren(n);
      if (flow.length < 2) skip("gap", g, `fewer than two laid-out children (${flow.length}) \u2014 a gap has nothing to separate`);
      else if (L.justifyContent === "space-between") skip("gap", g, "space-between: Figma ignores item spacing here, so the stored value is slack, not a gap");
      else if (flow.some((c) => growsAlong(c, dir))) skip("gap", g, "a child fills the main axis, so the stored gap and that child's size trade off \u2014 placement is checked through the children's positions and sizes instead");
      else spec.gap = g;
    }
    let pad = null;
    if (Array.isArray(L.padding)) pad = L.padding.slice(0, 4);
    else if (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((k) => typeof L[k] === "number")) pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => L[k]);
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) spec.padding = pad.map((v) => typeof v === "number" ? v : 0);
  }
  if (n.box) {
    if (typeof n.box.w === "number") spec.width = n.box.w;
    if (typeof n.box.h === "number") spec.height = n.box.h;
  }
  const pos = framePosition(n, ctx.frame);
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== void 0) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;
  const own = drawnStateOf(n);
  if (own) {
    spec.drawnState = own.state;
    spec.drawnStateWhy = own.why;
    spec.drawnStateOwn = true;
  } else if (ctx.inheritedState) {
    spec.drawnState = ctx.inheritedState.state;
    spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`;
  }
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  Object.defineProperty(spec, "__notComparable", { value: notComparable, enumerable: false });
  return spec;
}
function checkable(spec) {
  return ["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"].some((k) => spec[k] !== void 0);
}
var COORDINATES = "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame IS the page). A TEXT node's x is its INK start (the export's renderBox) \u2014 measure it with a Range over the text and report it as textBox {x,w}. TEXT nodes carry no y (vertical ink depends on font metrics). Auto-layout children carry no position (the export does not state one); their parent's is compared.";
function buildExpectation(docs) {
  const nodes = [];
  const instances = [];
  const interactions = [];
  const notComparable = [];
  const hidden = { roots: [], ids: [], specsSkipped: 0, instancesSkipped: 0, interactionsSkipped: 0 };
  const frames = [];
  const seen = /* @__PURE__ */ new Set();
  let screen = null, exportedAt = null, reference = null;
  for (const { doc, label } of docs) {
    if (!screen) screen = doc && doc.screen || label;
    if (!exportedAt) exportedAt = doc && doc.exportedAt;
    for (const root of rootsOf(doc)) {
      if (!reference && root.reference) reference = root.reference;
      const b = root.box || {};
      const frame = { nodeId: root.id, name: root.name, w: b.w, h: b.h, x: b.x, y: b.y, clip: root.clip === true };
      frames.push(frame);
      const frameId = frames.length > 1 ? root.id : void 0;
      const stateOf = /* @__PURE__ */ new WeakMap();
      walkWithHidden(root, (n, c) => {
        if (c.hidden) {
          if (!c.parentHidden) hidden.roots.push({ nodeId: n.id, name: n.name, path: c.path });
          if (n.id) hidden.ids.push(n.id);
          if (checkable(expectNode(n, { path: c.path }))) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          for (const r of Array.isArray(n.reactions) ? n.reactions : []) hidden.interactionsSkipped += (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).filter((a) => a && (a.type || a.navigation)).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : void 0;
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        const spec = expectNode(n, { path: c.path, frame, inheritedState: inherited, frameId });
        if (spec.drawnState) stateOf.set(n, inherited || { state: spec.drawnState, why: spec.drawnStateWhy, from: n.name || n.id });
        if (checkable(spec)) nodes.push(spec);
        notComparable.push(...spec.__notComparable);
        if (n.type === "INSTANCE" && n.mainComponent) {
          instances.push({
            nodeId: n.id,
            name: n.name,
            setName: n.mainComponent.setName || n.mainComponent.name,
            setKey: n.mainComponent.setKey || n.mainComponent.key,
            variant: n.mainComponent.variant,
            props: n.props || void 0
          });
        }
        for (const r of Array.isArray(n.reactions) ? n.reactions : []) {
          const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
          const trigger = r.trigger && (r.trigger.type || r.trigger) || r.on || "on_click";
          for (const a of actions) {
            if (!a || !(a.type || a.navigation)) continue;
            interactions.push({
              nodeId: n.id,
              name: n.name,
              trigger: String(trigger).toLowerCase(),
              action: a.navigation || a.type,
              destinationId: a.destinationId,
              destination: a.destination
            });
          }
        }
      });
    }
  }
  const f0 = frames[0] || {};
  return {
    schema: EXPECTATION_SCHEMA,
    screen,
    exportedAt,
    // P2b round 2 (finding 314): the design's identity without the pull's timestamps, so a no-change
    // re-pull (only `exportedAt` differs) is recognised as the same design by content, not by clock.
    exportContentSha256: exportContentSha256(docs.map((d) => d.doc)),
    reference,
    frame: { nodeId: f0.nodeId, name: f0.name, w: f0.w, h: f0.h, clip: f0.clip },
    frames: frames.length > 1 ? frames.map((f) => ({ nodeId: f.nodeId, name: f.name, w: f.w, h: f.h, clip: f.clip })) : void 0,
    coordinates: COORDINATES,
    note: "Generated from the export \u2014 do NOT retype these numbers into code comments. Every row is the value the design states; a field the export does not define is absent rather than defaulted. Layers the designer switched off (hidden: true on the node or an ancestor) have NO row: do not build, measure or drive them \u2014 their ids are listed under `hidden`. Feed this to a renderer probe and compare with `verify-screen.js --compare`; the probe's field names are listed under `measuredKeys`.",
    measuredKeys: MEASURED_KEYS_DOC,
    tolerance: TOLERANCE,
    counts: {
      nodes: nodes.length,
      instances: instances.length,
      interactions: interactions.length,
      notComparable: notComparable.length,
      hidden: { layers: hidden.roots.length, nodes: hidden.ids.length, specsSkipped: hidden.specsSkipped, instancesSkipped: hidden.instancesSkipped, interactionsSkipped: hidden.interactionsSkipped }
    },
    nodes,
    instances,
    interactions,
    notComparable,
    hidden: { roots: hidden.roots, ids: hidden.ids }
  };
}
var MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  "nodes[].styles": "computed values: fontFamily fontSize fontWeight lineHeight letterSpacing color backgroundColor borderColor borderWidth borderRadius (number | [tl,tr,br,bl]) padding ([t,r,b,l]) gap width height x y opacity text",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill \u2014 never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative \u2014 required when the id sits on a padded container (<th>, <button>, <label>)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children \u2014 required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state \u2014 required for a node whose spec has drawnState",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} \u2014 `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} \u2014 present:false is an explicit claim of absence",
  "expectationSha256": "sha256 of the .expected.json you measured against"
};
var KNOWN_MEASURED_KEYS = /* @__PURE__ */ new Set([
  "nodeId",
  "styles",
  "states",
  "matchedBy",
  "note",
  "notes",
  "selector",
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
  "visible"
]);
var KEY_HINTS = { radius: "borderRadius", borderTopLeftRadius: "borderRadius", background: "backgroundColor", bg: "backgroundColor", w: "width", h: "height", svgFill: "fill", placeholder: "placeholderText", rowGap: "gapVisual", columnGap: "gap" };
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
var TOKEN_KEYS = {
  color: ["fills", "color"],
  backgroundColor: ["fills"],
  fill: ["fills"],
  placeholderColor: ["fills"],
  borderColor: ["strokes"],
  borderWidth: ["strokeWeight", "strokeTopWeight"],
  fontSize: ["fontSize"],
  fontWeight: ["fontWeight"],
  fontFamily: ["fontFamily"],
  lineHeight: ["lineHeight"],
  letterSpacing: ["letterSpacing"],
  gap: ["itemSpacing", "gap"],
  width: ["width", "minWidth"],
  height: ["height", "minHeight"],
  opacity: ["opacity"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  "radius.tl": ["topLeftRadius"],
  "radius.tr": ["topRightRadius"],
  "radius.br": ["bottomRightRadius"],
  "radius.bl": ["bottomLeftRadius"],
  borderRadius: ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerRadius"]
};
function tokenFor(spec, key) {
  const t = spec && spec.tokens;
  if (!t) return void 0;
  const names = [...new Set((TOKEN_KEYS[key] || []).map((k) => t[k]).filter((v) => typeof v === "string"))];
  return names.length ? names.join(" / ") : void 0;
}
function compareField(f, want, got) {
  const nw = f.norm ? f.norm(want) : want;
  const ng = f.norm ? f.norm(got) : got;
  if (nw == null || ng == null) return null;
  if (f.tol == null) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const a = Number(nw), b = Number(ng);
  if (Number.isNaN(a) || Number.isNaN(b)) return nw === ng ? null : { want: nw, got: ng, delta: null };
  const delta = Math.abs(a - b);
  return delta <= f.tol ? null : { want: a, got: b, delta: Number(delta.toFixed(3)) };
}
function comparePadding(want, got) {
  if (!Array.isArray(want) || !Array.isArray(got)) return null;
  const w = want.map(Number), g = got.map(Number);
  if (w.some(Number.isNaN) || g.some(Number.isNaN)) return null;
  const worst = Math.max(...w.map((v, i) => Math.abs(v - (g[i] || 0))));
  return worst <= TOLERANCE.padding ? null : { want: w, got: g, delta: Number(worst.toFixed(3)) };
}
function radiusCorners(v) {
  if (v == null) return null;
  if (num(v)) return [v, v, v, v];
  if (Array.isArray(v)) {
    const a = v.map(Number);
    return a.length === 4 && a.every(Number.isFinite) ? a : a.length === 1 && Number.isFinite(a[0]) ? [a[0], a[0], a[0], a[0]] : null;
  }
  const p = String(v).trim().split(/\s+/).map(parseFloat);
  if (!p.length || p.some(Number.isNaN)) return null;
  return p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p.slice(0, 4);
}
var clampRadius = (r, w, h) => num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r;
var TABLE_TAGS = /* @__PURE__ */ new Set(["table", "thead", "tbody", "tfoot", "tr"]);
var CONTAINER_TAGS = /* @__PURE__ */ new Set(["th", "td", "tr", "button", "label", "li", "a", "section", "article", "header", "footer", "nav", "table", "input"]);
var LEAF_TAGS = /* @__PURE__ */ new Set(["input", "textarea", "select", "img", "svg", "path", "video", "canvas"]);
var CONTAINER_TYPES = /* @__PURE__ */ new Set(["FRAME", "INSTANCE", "COMPONENT", "GROUP", "SECTION"]);
var LEAF_FIELDS = /* @__PURE__ */ new Set(["width", "height", "x", "y", "backgroundColor", "borderColor", "borderWidth", "borderRadius", "gap"]);
var isContainer = (got) => got.tag && CONTAINER_TAGS.has(String(got.tag).toLowerCase()) || Array.isArray(got.padding) && got.padding.some((v) => Number(v) > 0);
var LIMITS = [
  "::before/::after content and any other pseudo-element are invisible to a computed-style probe; the export cannot say which layers a build draws that way, so they are compared only if the probe reports them under the node's id.",
  "::placeholder colour is compared only when the probe reports placeholderColor (getComputedStyle(el,'::placeholder') or the stylesheet rule); otherwise it is listed under `unverifiable`, never passed.",
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) \u2014 read `rotate` too before calling a rotation missing (finding 198).",
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared."
];
function compare(expectation, measured, opts) {
  opts = opts || {};
  measured = measured || {};
  const hiddenSet = new Set((expectation.hidden && expectation.hidden.ids || []).map(String));
  const legacy = expectation.schema !== EXPECTATION_SCHEMA;
  const specs = (expectation.nodes || []).filter((s) => !hiddenSet.has(String(s.nodeId)));
  const frameOf = (spec) => spec.frameId && (expectation.frames || []).find((f) => f.nodeId === spec.frameId) || expectation.frame || {};
  const byId = /* @__PURE__ */ new Map();
  let duplicateNodeIds = 0;
  const unknownKeys = /* @__PURE__ */ new Map();
  for (const m of measured.nodes || []) {
    if (!m || m.nodeId == null) continue;
    const id = String(m.nodeId);
    if (byId.has(id)) {
      duplicateNodeIds++;
      continue;
    }
    byId.set(id, m);
    const s = m.styles || m;
    for (const k of Object.keys(s)) if (!KNOWN_MEASURED_KEYS.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1);
  }
  const expectedIds = /* @__PURE__ */ new Set([...specs.map((s) => String(s.nodeId)), ...(expectation.instances || []).map((i) => String(i.nodeId))]);
  const suffix = (id) => {
    const i = id.indexOf(";");
    return i === -1 ? null : id.slice(i + 1);
  };
  const foreignBySuffix = /* @__PURE__ */ new Map();
  for (const id of byId.keys()) {
    if (expectedIds.has(id) || hiddenSet.has(id)) continue;
    const sfx = suffix(id);
    if (sfx) foreignBySuffix.set(sfx, (foreignBySuffix.get(sfx) || []).concat(id));
  }
  const viaSharedPath = (id) => {
    const sfx = suffix(String(id));
    const c = sfx && foreignBySuffix.get(sfx);
    return c && c.length === 1 ? c[0] : null;
  };
  const deltas = [];
  const notMeasured = [];
  const fieldsNotMeasured = [];
  const unverifiable = [];
  const census = /* @__PURE__ */ new Map();
  const tally = (key, present) => {
    const c = census.get(key) || { expected: 0, present: 0 };
    c.expected++;
    if (present) c.present++;
    census.set(key, c);
  };
  let fieldsChecked = 0, nodesMeasured = 0, nodesMatchedByComponentPath = 0;
  const gap = (spec, field, why) => fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  const push = (spec, field, severity, bad, extra) => deltas.push(Object.assign({
    severity,
    nodeId: spec.nodeId,
    name: spec.name,
    path: spec.path,
    field,
    expected: bad.want,
    actual: bad.got,
    delta: bad.delta
  }, extra));
  for (const spec of specs) {
    let m = byId.get(String(spec.nodeId));
    let matchedBy = m ? m.matchedBy || "id" : null;
    if (!m) {
      const alt = viaSharedPath(spec.nodeId);
      if (alt) {
        m = byId.get(alt);
        matchedBy = `shared-component-path (${alt})`;
        nodesMatchedByComponentPath++;
      }
    }
    if (!m) {
      notMeasured.push({ nodeId: spec.nodeId, name: spec.name, path: spec.path, why: "no measurement for this node id" });
      continue;
    }
    nodesMeasured++;
    const base = m.styles || m;
    let got = base, measuredIn = "rest";
    const state = spec.drawnState;
    const st = state && m.states && m.states[state];
    if (st) {
      got = Object.assign({}, base, st.styles || st);
      measuredIn = state;
    }
    const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
    const stateWhy = state && `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) \u2014 measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}`;
    if (state && measuredIn === "rest" && zeroAtRest) {
      for (const f of FIELDS) if (spec[f.key] !== void 0) {
        tally(f.key, false);
        gap(spec, f.label, `renders 0\xD70 at rest: ${stateWhy}`);
      }
      continue;
    }
    const isText = spec.type === "TEXT";
    const container = isText && isContainer(got);
    const tb = got.textBox && typeof got.textBox === "object" ? got.textBox : null;
    const table = got.tag && TABLE_TAGS.has(String(got.tag).toLowerCase());
    const onLeaf = CONTAINER_TYPES.has(spec.type) && got.tag && LEAF_TAGS.has(String(got.tag).toLowerCase());
    const leafWhy = onLeaf && `this ${spec.type}'s id sits on a leaf <${String(got.tag).toLowerCase()}> inside the element that implements it (a ...rest spread?) \u2014 tag and measure the container`;
    for (const f of FIELDS) {
      if (spec[f.key] === void 0) continue;
      let val = got[f.key];
      let present = val !== void 0;
      if (isText && tb && (f.key === "x" || f.key === "width")) {
        val = f.key === "x" ? tb.x : tb.w;
        present = val !== void 0;
      }
      if (f.key === "gap" && got.gapVisual !== void 0) {
        val = got.gapVisual;
        present = true;
      }
      tally(f.key, present);
      if (state && measuredIn === "rest" && spec.drawnStateOwn && f.colour) {
        gap(spec, f.label, stateWhy);
        continue;
      }
      if (onLeaf && LEAF_FIELDS.has(f.key)) {
        gap(spec, f.label, leafWhy);
        continue;
      }
      if (isText && f.box && container && !tb) {
        gap(spec, f.label, `this TEXT node's id sits on a <${got.tag || "container"}>${Array.isArray(got.padding) && got.padding.some((v) => Number(v) > 0) ? " with padding" : ""}, whose box is not the text's \u2014 report textBox (a Range over the text) instead`);
        continue;
      }
      if (isText && tb && f.key === "height") {
        continue;
      }
      if (f.key === "gap" && table && got.gapVisual === void 0) {
        gap(spec, f.label, `the element is a <${got.tag}>, which spaces rows with border-spacing, not gap \u2014 report gapVisual (the distance between consecutive rows)`);
        continue;
      }
      if (val === void 0) {
        if (f.optional) {
          unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: spec[f.key], why: "a ::placeholder colour is not readable from getComputedStyle(el) \u2014 report placeholderColor to have it checked" });
          continue;
        }
        gap(spec, f.label, "the probe did not report this property");
        continue;
      }
      fieldsChecked++;
      let want = spec[f.key], have = val;
      if (f.key === "borderRadius") {
        const c = radiusCorners(val);
        if (!c) {
          gap(spec, f.label, `could not read '${JSON.stringify(val)}' as a radius`);
          fieldsChecked--;
          continue;
        }
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        want = clampRadius(want, spec.width, spec.height);
        const worst = c.map((r) => clampRadius(r, W, H)).reduce((a, r) => Math.abs(r - want) > Math.abs(a - want) ? r : a, clampRadius(c[0], W, H));
        have = worst;
      }
      const bad = compareField(f, want, have);
      if (bad) {
        push(spec, f.label, f.high ? "high" : "medium", bad, {
          unit: f.unit,
          token: tokenFor(spec, f.key),
          measuredIn: measuredIn !== "rest" ? measuredIn : void 0,
          matchedBy: matchedBy !== "id" ? matchedBy : void 0,
          note: f.key === "borderRadius" && spec.borderRadius !== want ? `design radius ${spec.borderRadius} on a ${spec.width}\xD7${spec.height} box draws ${want}` : void 0
        });
      }
    }
    if (spec.radiusCorners && onLeaf) gap(spec, "border-radius", leafWhy);
    else if (spec.radiusCorners) {
      const c = radiusCorners(got.borderRadius);
      tally("borderRadius", got.borderRadius !== void 0);
      if (!c) gap(spec, "border-radius", got.borderRadius === void 0 ? "the probe did not report this property" : `could not read '${JSON.stringify(got.borderRadius)}' as a radius`);
      else {
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        ["tl", "tr", "br", "bl"].forEach((k, i) => {
          fieldsChecked++;
          const want = clampRadius(spec.radiusCorners[k], spec.width, spec.height), have = clampRadius(c[i], W, H);
          const d = Math.abs(want - have);
          if (d > TOLERANCE.radius) push(spec, `border-radius (${{ tl: "top-left", tr: "top-right", br: "bottom-right", bl: "bottom-left" }[k]})`, "medium", { want, got: have, delta: Number(d.toFixed(3)) }, { unit: "px", token: tokenFor(spec, "radius." + k) });
        });
      }
    }
    if (spec.padding !== void 0) {
      tally("padding", got.padding !== void 0);
      if (got.padding === void 0) gap(spec, "padding", "the probe did not report this property");
      else if (got.tag && String(got.tag).toLowerCase() === "tr") gap(spec, "padding", "a table row's padding lives on its cells \u2014 report the first/last cell's padding under this id");
      else if (onLeaf) gap(spec, "padding", leafWhy);
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, got.padding);
        const allZero = got.padding.every((v) => Number(v) === 0);
        if (bad) push(spec, "padding", "medium", bad, {
          unit: "px",
          token: tokenFor(spec, "padding"),
          note: allZero && !got.tag ? "measured 0 on every side \u2014 if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" : void 0
        });
      }
    }
    if (spec.placeholderText !== void 0) {
      tally("placeholderText", got.placeholderText !== void 0);
      if (got.placeholderText === void 0) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')");
      else {
        fieldsChecked++;
        if (String(got.placeholderText).trim() !== String(spec.placeholderText).trim()) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
      }
    }
    if (spec.text !== void 0) {
      tally("text", got.text !== void 0 && got.text !== null);
      if (got.text === null) gap(spec, "text", "the probe reported text: null \u2014 an element with child elements still has text; report its textContent");
      else if (got.text !== void 0) {
        fieldsChecked++;
        const w = String(spec.text).replace(/ /g, " ").trim();
        const g = String(got.text).replace(/ /g, " ").trim();
        if (w !== g) {
          const caseOnly = w.toLowerCase() === g.toLowerCase();
          const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
          push(spec, "text", caseOnly || extraGlyphs ? "low" : "high", { want: spec.text, got: got.text, delta: null }, {
            note: caseOnly ? "differs only in case \u2014 check for a text-transform, which Figma applies at render time while storing the original" : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)` : void 0
          });
        }
        if (/ /.test(String(spec.text))) {
          const show = (t) => String(t).replace(/ /g, "\\u00a0");
          deltas.push({
            severity: "low",
            nodeId: spec.nodeId,
            name: spec.name,
            field: "text (invisible character)",
            expected: show(spec.text),
            actual: show(got.text),
            note: "the designed string contains a non-breaking space (U+00A0) \u2014 a Figma auto-substitution. Carrying it into the DOM verbatim is usually not what anyone meant; decide deliberately."
          });
        }
      }
    }
    const fr = frameOf(spec);
    const bx = got;
    if (num(fr.w) && num(fr.h) && (num(bx.x) || num(bx.y))) {
      const w = num(bx.width) ? bx.width : 0, h = num(bx.height) ? bx.height : 0;
      const tol = TOLERANCE.position;
      const inDesign = (!num(spec.x) || spec.x >= -tol && spec.x + (spec.width || 0) <= fr.w + tol) && (!num(spec.y) || spec.y >= -tol && spec.y + (spec.height || 0) <= fr.h + tol);
      const out = [];
      if (num(bx.y) && bx.y + h > fr.h + tol) out.push(`bottom edge at y=${r2(bx.y + h)} in a ${fr.h}-high frame`);
      if (num(bx.y) && bx.y < -tol) out.push(`top edge at y=${r2(bx.y)}`);
      if (num(bx.x) && bx.x + w > fr.w + tol) out.push(`right edge at x=${r2(bx.x + w)} in a ${fr.w}-wide frame`);
      if (num(bx.x) && bx.x < -tol) out.push(`left edge at x=${r2(bx.x)}`);
      if (inDesign && out.length && !zeroAtRest) {
        deltas.push({ severity: "high", nodeId: spec.nodeId, name: spec.name, path: spec.path, field: "placement", expected: "inside the frame", actual: out.join(", "), note: "the design places this node inside the frame; the build renders it outside, where the user cannot see it without scrolling" });
      }
    }
  }
  const fieldsNeverMeasured = [];
  for (const [key, c] of census) {
    if (FIELDS.some((f) => f.key === key && f.optional)) continue;
    if (c.expected > 0 && c.present === 0) {
      const hinted = [...unknownKeys.keys()].filter((k) => KEY_HINTS[k] === key);
      fieldsNeverMeasured.push({ field: key, expectedOn: c.expected, measuredOn: 0, probeSent: hinted.length ? hinted : void 0 });
    }
  }
  const comps = Array.isArray(measured.components) ? measured.components : [];
  const reported = comps.filter((c) => c && c.present !== false);
  const namesSeen = new Set(reported.map((c) => String(c.setName || c.name || c)));
  const idsSeen = /* @__PURE__ */ new Set([...reported.map((c) => c.nodeId).filter(Boolean).map(String), ...byId.keys()]);
  const bySet = /* @__PURE__ */ new Map();
  for (const i of expectation.instances || []) {
    if (hiddenSet.has(String(i.nodeId))) continue;
    const k = i.setName || i.name;
    if (!bySet.has(k)) bySet.set(k, { setName: k, setKey: i.setKey, nodeIds: [], instances: 0 });
    bySet.get(k).instances++;
    bySet.get(k).nodeIds.push(i.nodeId);
  }
  const untaggedInstanceSets = [];
  let setsViaSharedPath = 0;
  for (const [k, v] of bySet) {
    if (namesSeen.has(k) || v.nodeIds.some((id) => idsSeen.has(String(id)))) continue;
    if (v.nodeIds.some((id) => viaSharedPath(id))) {
      setsViaSharedPath++;
      continue;
    }
    untaggedInstanceSets.push(v);
  }
  const componentsAbsent = [];
  for (const c of comps.filter((c2) => c2 && c2.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || v.nodeIds.includes(c.nodeId));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, detail: c.detail || c.note });
  }
  const allEvidence = [...Array.isArray(measured.interactions) ? measured.interactions : [], ...Array.isArray(opts.interactions) ? opts.interactions : []];
  const exercised = /* @__PURE__ */ new Map();
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) {
      interactionEvidenceOnHidden++;
      continue;
    }
    exercised.set(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase(), r);
  }
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i) => {
    const hit = exercised.get(String(i.nodeId) + "|" + i.trigger);
    const row = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, action: i.action, destinationId: i.destinationId };
    if (!hit) return Object.assign(row, { result: "not-probed", detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === void 0) return Object.assign(row, { result: "not-probed", detail: hit.detail });
    if (hit.ok === false) return Object.assign(row, { result: "fail", detail: hit.detail, selector: hit.selector });
    if (!hit.selector || !(count >= 1)) {
      return Object.assign(row, { result: "not-probed", detail: `reported ok without evidence \u2014 ${!hit.selector ? "no selector named" : `selector '${hit.selector}' matched ${Number.isFinite(count) ? count : "an unreported number of"} element(s)`}${hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    }
    return Object.assign(row, { result: "pass", detail: hit.detail, selector: hit.selector, selectorCount: count });
  });
  const unexpectedInteractionEvidence = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase())).length;
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsNotProbed = interactions.filter((i) => i.result === "not-probed");
  const interactionsPassed = interactions.filter((i) => i.result === "pass");
  const high = deltas.filter((d) => d.severity === "high").length;
  const medium = deltas.filter((d) => d.severity === "medium").length;
  const inputs = {
    expectationSchema: expectation.schema || "(none)",
    expectationSha256: opts.expectationSha256,
    measuredSha256: opts.measuredSha256,
    measuredAgainst: measured.expectationSha256 || void 0,
    // P2b round 2 (findings 314/317): WHAT was measured, by content — the design (timestamps stripped)
    // and the code (sha256 of each file in the plan's files[], the hashes the Stop hook records).
    exportContentSha256: expectation.exportContentSha256 || void 0,
    code: opts.code || void 0
  };
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);
  const nodesExpected = specs.length;
  const reasons = [];
  if (legacy) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering \u2014 regenerate it with --expect before trusting any number here`);
  if (stale) reasons.push(`the measurements were taken against a DIFFERENT expectation (${String(measured.expectationSha256).slice(0, 12)}\u2026 vs ${String(opts.expectationSha256).slice(0, 12)}\u2026) \u2014 re-measure`);
  if (staticOnly) reasons.push(`not rendered \u2014 the probe reported static-only${measured.reason ? ` (${measured.reason})` : ""}`);
  if (noRender) reasons.push("no screenshot of this render exists on disk \u2014 nothing ties these numbers to a picture (write design/verify/<Screen>.png and list it in artifacts)");
  for (const f of fieldsNeverMeasured) reasons.push(`field '${f.field}' was present in 0 of ${nodesMeasured} measurements${f.probeSent ? ` (the probe sent '${f.probeSent.join("', '")}' \u2014 the canonical key is '${f.field}')` : ""} \u2014 ${f.expectedOn} expectation(s) went unchecked`);
  if (notMeasured.length) reasons.push(`${notMeasured.length} of ${nodesExpected} node spec(s) were never measured`);
  if (high) reasons.push(`${high} high-severity value mismatch(es)`);
  if (medium) reasons.push(`${medium} medium-severity value mismatch(es)`);
  if (componentsAbsent.length) reasons.push(`${componentsAbsent.length} component set(s) reported ABSENT from the build by the probe`);
  if (interactionsFailed.length) reasons.push(`${interactionsFailed.length} designed interaction(s) failed`);
  if (interactionsNotProbed.length) reasons.push(`${interactionsNotProbed.length} designed interaction(s) were not probed`);
  const fieldGapsOther = fieldsNotMeasured.length;
  if (fieldGapsOther) reasons.push(`${fieldGapsOther} value(s) on measured nodes were not reported by the probe`);
  const verdict = reasons.length === 0 ? "pass" : high || componentsAbsent.length || interactionsFailed.length ? "fail" : "incomplete";
  const coverage = {
    nodesExpected,
    nodesMeasured,
    nodesNotMeasured: notMeasured.length,
    nodesMatchedByComponentPath,
    fieldsChecked,
    fieldsNotMeasured: fieldsNotMeasured.length,
    fieldsNeverMeasured,
    valuesNotComparable: (expectation.notComparable || []).length,
    valuesUnverifiable: unverifiable.length,
    hiddenLayersSkipped: expectation.counts && expectation.counts.hidden || void 0,
    instanceSets: bySet.size,
    instanceSetsWithEvidence: bySet.size - untaggedInstanceSets.length,
    instanceSetsViaSharedPath: setsViaSharedPath,
    interactionsExpected: interactions.length,
    interactionsPassed: interactionsPassed.length,
    interactionsFailed: interactionsFailed.length,
    interactionsNotProbed: interactionsNotProbed.length
  };
  const mark = verdict.toUpperCase();
  const headline = `${mark} \u2014 ` + (fieldsNeverMeasured.length ? `NEVER MEASURED: ${fieldsNeverMeasured.map((f) => `'${f.field}' present in 0 of ${nodesMeasured} measurements${f.probeSent ? ` (probe sent '${f.probeSent.join("', '")}')` : ""}`).join("; ")} \xB7 ` : "") + `nodes measured ${nodesMeasured}/${nodesExpected} \xB7 ${fieldsChecked} values compared \xB7 ${high} high, ${medium} medium \xB7 interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed of ${interactions.length} \xB7 data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)`;
  return {
    schema: REPORT_SCHEMA,
    screen: expectation.screen,
    exportedAt: expectation.exportedAt,
    measuredAt: measured.measuredAt || (/* @__PURE__ */ new Date()).toISOString(),
    renderer: measured.renderer || "unknown",
    viewport: measured.viewport,
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    inputs,
    verdict,
    headline,
    why: reasons,
    coverage,
    summary: { high, medium, low: deltas.filter((d) => d.severity === "low").length, componentsAbsent: componentsAbsent.length, interactionsFailed: interactionsFailed.length, interactionsNotProbed: interactionsNotProbed.length },
    deltas: deltas.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]),
    componentsAbsent,
    untaggedInstanceSets,
    interactions,
    notMeasured,
    fieldsNotMeasured,
    unverifiable,
    notComparable: expectation.notComparable || [],
    probe: {
      unknownKeys: [...unknownKeys].map(([key, count]) => ({ key, count, canonical: KEY_HINTS[key] })),
      duplicateNodeIds,
      interactionEvidenceOnHiddenLayers: interactionEvidenceOnHidden,
      interactionEvidenceNotInExpectation: unexpectedInteractionEvidence,
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length
    },
    limits: LIMITS
  };
}
function reportToMarkdown(r) {
  const L = [];
  L.push(`# Verify \u2014 ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} \xB7 measured ${r.measuredAt}` + (r.inputs && r.inputs.expectationSha256 ? ` \xB7 against expectation ${r.inputs.expectationSha256.slice(0, 12)}\u2026` : ""), "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected}${c.nodesMatchedByComponentPath ? ` (${c.nodesMatchedByComponentPath} via a shared component's internal path)` : ""} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| values on measured nodes the probe did not report | ${c.fieldsNotMeasured} |`);
  if (c.fieldsNeverMeasured.length) L.push(`| **fields present in 0 measurements** | ${c.fieldsNeverMeasured.map((f) => `\`${f.field}\`${f.probeSent ? ` (probe sent \`${f.probeSent.join("`, `")}\`)` : ""}`).join(", ")} |`);
  L.push(`| design values excluded by method (listed below) | ${c.valuesNotComparable} |`);
  L.push(`| values the method cannot read unaided | ${c.valuesUnverifiable} |`);
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) \xB7 ${c.hiddenLayersSkipped.specsSkipped} spec(s) \xB7 ${c.hiddenLayersSkipped.instancesSkipped} instance(s) \xB7 ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence \u2014 coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected} |`, "");
  if (r.deltas.length) {
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token |", "|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      L.push(`| ${d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${fmt(d.expected)}${d.unit || ""} | ${fmt(d.actual)}${d.unit || ""} | ${d.token || "\u2014"} |`);
    }
    L.push("");
  }
  if (r.componentsAbsent.length) {
    L.push(`## Components the probe reported ABSENT (${r.componentsAbsent.length})`, "");
    for (const m of r.componentsAbsent) L.push(`- **${m.setName}** \u2014 e.g. \`${m.nodeIds[0]}\`${m.detail ? ` \u2014 ${m.detail}` : ""}`);
    L.push("");
  }
  if (r.untaggedInstanceSets.length) {
    L.push(
      `## Instance sets with no evidence in the probe (${r.untaggedInstanceSets.length})`,
      "",
      "*Tag coverage, not presence: these carry no `data-dt-node` and no reported setName. They may well be built \u2014 a repeated row rendered by one `.map()` or a shared shell is expected to leave gaps here. Not a failure on its own.*",
      ""
    );
    for (const m of r.untaggedInstanceSets.slice(0, 40)) L.push(`- ${m.setName} \u2014 ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (r.untaggedInstanceSets.length > 40) L.push(`- \u2026and ${r.untaggedInstanceSets.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result !== "pass");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} \u2014 ${i.trigger} \u2192 ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` \u2014 ${i.detail}` : ""}`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length} node specs)`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} \u2014 ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- \u2026and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  if (r.fieldsNotMeasured.length) {
    L.push(`## Values the probe did not report on measured nodes (${r.fieldsNotMeasured.length})`, "");
    for (const n of r.fieldsNotMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}) \u2014 ${n.why}`);
    if (r.fieldsNotMeasured.length > 40) L.push(`- \u2026and ${r.fieldsNotMeasured.length - 40} more`);
    L.push("");
  }
  if (r.notComparable.length || r.unverifiable.length) {
    L.push(`## Excluded by method (${r.notComparable.length + r.unverifiable.length})`, "", "*Stated so they are not mistaken for passes.*", "");
    for (const n of [...r.unverifiable, ...r.notComparable].slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}${n.value !== void 0 ? ` ${fmt(n.value)}` : ""}) \u2014 ${n.why}`);
    if (r.notComparable.length + r.unverifiable.length > 40) L.push(`- \u2026and ${r.notComparable.length + r.unverifiable.length - 40} more`);
    L.push("");
  }
  const p = r.probe || {};
  if (p.unknownKeys && p.unknownKeys.length || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}\xD7) is not read by verify-screen${k.canonical ? ` \u2014 the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] \u2014 the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored \u2014 a hidden layer cannot be driven`);
    L.push("");
  }
  L.push("## Limits of this method", "");
  for (const l of r.limits || []) L.push(`- ${l}`);
  return L.join("\n") + "\n";
}
var fmt = (v) => Array.isArray(v) ? v.join("/") : String(v);
var fs = require("fs");
var path = require("path");
function findExistingExpectedFor(dir, nodeId, ownTarget) {
  if (!nodeId || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".expected.json")) continue;
    const full = path.join(dir, f);
    if (path.resolve(full) === path.resolve(ownTarget)) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
      continue;
    }
    if (doc && doc.frame && doc.frame.nodeId === nodeId) return full;
  }
  return null;
}
module.exports = { buildExpectation, compare, reportToMarkdown, expectNode, normColor, normWeight, normFamily, lineHeightPx, tokenFor, radiusCorners, findExistingExpectedFor, TOLERANCE, FIELDS, EXPECTATION_SCHEMA, REPORT_SCHEMA };
if (require.main === module) {
  const fs2 = require("fs");
  const path2 = require("path");
  const crypto = require("crypto");
  const { readJsonFile } = require_catalog_input();
  const argv = process.argv.slice(2);
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return void 0;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const strip = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return false;
    argv.splice(i, 1);
    return true;
  };
  const sha = (file) => crypto.createHash("sha256").update(fs2.readFileSync(file)).digest("hex");
  const USAGE = "usage:\n  node design-to-code/verify-screen.js --expect <screen.json>... --out design/verify/<Screen> [--force]\n      writes <Screen>.expected.json \u2014 the design's own numbers, as data, for VISIBLE layers only.\n      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.\n      Refuses (exit 1) if the same node already has an expectation under a DIFFERENT name in this\n      directory \u2014 pass --force to write a second one anyway.\n  node design-to-code/verify-screen.js --compare <Screen>.expected.json <measured.json> [--interactions <file>] --out design/verify/<Screen>\n      writes <Screen>.report.json + .md and exits 1 unless the verdict is 'pass'. It has NO browser: it compares\n      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n      (a JSON array, or {interactions:[\u2026]}, of {nodeId, trigger, ok, selector, selectorCount, detail}).\n      --out defaults to design/verify/<the .expected.json file's own basename>.";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  const out = take("--out");
  const interactionsFile = take("--interactions");
  const force = strip("--force");
  const doExpect = strip("--expect");
  const doCompare = strip("--compare");
  if (doExpect === doCompare) {
    console.error("pass exactly one of --expect / --compare\n" + USAGE);
    process.exit(2);
  }
  if (interactionsFile !== void 0 && !doCompare) {
    console.error("--interactions only applies to --compare\n" + USAGE);
    process.exit(2);
  }
  const stray = argv.filter((a) => a.startsWith("-"));
  if (stray.length) {
    console.error(`verify-screen: unknown flag ${stray.join(", ")}
` + USAGE);
    process.exit(2);
  }
  const write = (base, obj, md2) => {
    if (!base) {
      process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
      return;
    }
    fs2.mkdirSync(path2.dirname(base), { recursive: true });
    fs2.writeFileSync(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md2) fs2.writeFileSync(base + ".report.md", md2);
    console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md2 ? " and " + base + ".report.md" : ""}`);
  };
  if (doExpect) {
    if (!argv.length) {
      console.error("--expect needs at least one screen export\n" + USAGE);
      process.exit(2);
    }
    const docs = argv.map((f) => ({ doc: readJsonFile(f, "screen export"), label: path2.basename(f, ".json") }));
    const exp = buildExpectation(docs);
    const outBase = out || path2.join("design", "verify", path2.basename(argv[0], ".json"));
    const target = outBase + ".expected.json";
    const dup = findExistingExpectedFor(path2.dirname(target) || ".", exp.frame && exp.frame.nodeId, target);
    if (dup && !force) {
      console.error(
        `error  node ${exp.frame.nodeId} already has an expectation at ${dup} \u2014 refusing to also write ${target} (one screen, one artefact set). Use that existing name, or pass --force to write this one anyway.`
      );
      process.exit(1);
    }
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs2.existsSync(target) ? fs2.readFileSync(target, "utf8") : null;
    write(outBase, exp);
    const h = crypto.createHash("sha256").update(next).digest("hex");
    let prevContent = null;
    try {
      prevContent = prev !== null ? JSON.parse(prev).exportContentSha256 : null;
    } catch {
    }
    if (prev !== null && prev === next) console.error(`note  ${target} was already identical (sha256 ${h.slice(0, 12)}\u2026) \u2014 unchanged`);
    else if (prev !== null && prevContent && prevContent === exp.exportContentSha256 && prev.replace(/"exportedAt": "[^"]*"/, "") === next.replace(/"exportedAt": "[^"]*"/, "")) {
      console.error(`note  ${target}: only exportedAt changed (export content sha256 ${exp.exportContentSha256.slice(0, 12)}\u2026 unchanged) \u2014 existing measurements and report still apply`);
    } else if (prev !== null) {
      console.error(`note  REPLACED an existing ${target} that differed (sha256 ${crypto.createHash("sha256").update(prev).digest("hex").slice(0, 12)}\u2026 \u2192 ${h.slice(0, 12)}\u2026)`);
      const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs2.existsSync(f));
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation \u2014 re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) \u2014 visible layers only; skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable) \xB7 expectation sha256 ${h.slice(0, 12)}\u2026`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers \u2014 interaction coverage cannot be checked, and the report will say so rather than passing.");
    process.exit(0);
  }
  const [expFile, measuredFile] = argv;
  if (!expFile || !measuredFile) {
    console.error("--compare needs <expected.json> <measured.json>\n" + USAGE);
    process.exit(2);
  }
  const expectation = readJsonFile(expFile, "expectation");
  const measured = readJsonFile(
    measuredFile,
    "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}."
  );
  let extra;
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    extra = Array.isArray(raw) ? raw : Array.isArray(raw && raw.interactions) ? raw.interactions : null;
    if (!extra) {
      console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[\u2026]}`);
      process.exit(2);
    }
  }
  const artifacts = Array.isArray(measured.artifacts) ? measured.artifacts : [];
  const artifactCheck = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists = !!p && fs2.existsSync(p);
    return { path: p, exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), sha256: exists ? sha(p) : void 0 };
  });
  let code;
  {
    const planDir = path.join("design", "plan");
    const frameId = expectation.frame && expectation.frame.nodeId;
    const stem = path.basename(expFile, ".json").replace(/\.expected$/, "");
    const hits = [];
    for (const f of fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((x) => x.endsWith(".json")).sort() : []) {
      let p;
      try {
        p = JSON.parse(fs.readFileSync(path.join(planDir, f), "utf8"));
      } catch {
        continue;
      }
      const byId = frameId && (p.nodeId === frameId || new RegExp(`__${String(frameId).replace(":", "_")}$`).test(path.basename(f, ".json")));
      const byName = path.basename(f, ".json") === stem || p.file && path.basename(String(p.file), ".json") === stem;
      if ((byId || byName) && Array.isArray(p.files)) hits.push({ f, p });
    }
    if (hits.length === 1) {
      code = { plan: path.join(planDir, hits[0].f).split(path.sep).join("/"), files: fileHashes(hits[0].p.files, process.cwd()), gitHead: gitHead(process.cwd()) };
    } else {
      console.error(hits.length ? `note  ${hits.length} plans in design/plan/ describe this frame (${hits.map((h) => h.f).join(", ")}) \u2014 the report records no code hashes, so its status cannot be tied to the code` : "note  no plan in design/plan/ describes this frame \u2014 the report records no code hashes (run from the project root), so verify-build --status cannot tie it to the code");
    }
  }
  const rep = compare(expectation, measured, { interactions: extra, expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck, code });
  const md = reportToMarkdown(rep);
  const compareBase = out || path2.join("design", "verify", path2.basename(expFile, ".json").replace(/\.expected$/, ""));
  write(compareBase, rep, md);
  console.error(rep.headline);
  process.exit(rep.verdict === "pass" ? 0 : 1);
}
