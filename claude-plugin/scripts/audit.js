// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

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
      const fs = require("fs");
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
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
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull design --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull design --design-system` to create it.";
    module2.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
  }
});

// design-to-code/audit.js
var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
var TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
var PLATFORMS = Object.keys(TOUCH_MIN);
function parseHex(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
var over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1
});
function luminance(c) {
  const ch = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function toLab(c) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(c.r), G = lin(c.g), B = lin(c.b);
  const f = (t) => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
var labDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
var deltaE = (a, b) => labDist(toLab(a), toLab(b));
var INTERACTIVE_NAME = /\b(button|btn|cta|link|tab|chip|toggle|switch|checkbox|check box|radio|input|text ?field|textfield|search|select|dropdown|menu item|icon ?button|close|back|segmented|stepper|slider)\b/i;
var TAP_TRIGGER = /click|press|tap|drag/;
var CHROME_TOP = /status ?bar|9:41|battery|signal|dynamic island|notch/i;
var CHROME_BOTTOM = /home ?indicator|gesture ?bar|navigation ?handle/i;
var STATE_WORDS = {
  loading: /\b(loading|skeleton|spinner|shimmer|placeholder)\b/i,
  empty: /\b(empty|no results?|no data|nothing (here|found)|zero ?state)\b/i,
  error: /\b(error|failed|failure|offline|retry|something went wrong|not found|404|500)\b/i
};
var STATE_SYNONYMS = {
  hover: /^(hover|hovered|mouse ?over)$/,
  pressed: /^(pressed|press|active|tapped|down)$/,
  focus: /^(focus|focused|focus[- ]visible|keyboard ?focus)$/,
  disabled: /^(disabled|inactive|is ?disabled)$/,
  // Not "danger"/"destructive": those are button STYLE variants (a red button), not an error state.
  error: /^(error|invalid|has ?error|is ?invalid)$/,
  selected: /^(selected|checked|on|active|current|is ?selected)$/,
  loading: /^(loading|busy|in ?progress|is ?loading)$/
};
function requiredStates(kind, platform) {
  const pointer = platform === "web";
  switch (kind) {
    case "button":
      return pointer ? ["hover", "pressed", "focus", "disabled"] : ["pressed", "disabled"];
    case "input":
      return ["focus", "error", "disabled"];
    case "toggle":
      return ["selected", "disabled"];
    case "tab":
      return ["selected"];
    case "link":
      return pointer ? ["hover", "focus"] : ["pressed"];
    default:
      return [];
  }
}
function controlKind(name) {
  const s = String(name || "");
  if (/\b(input|text ?field|textfield|search|select|dropdown|textarea)\b/i.test(s)) return "input";
  if (/\b(checkbox|check box|radio|switch|toggle)\b/i.test(s)) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}
function rootsOf(doc, label) {
  if (!doc || typeof doc !== "object") return [];
  if (Array.isArray(doc)) return doc.flatMap((d, i) => rootsOf(d, `${label}[${i}]`));
  if (Array.isArray(doc.nodes)) return doc.nodes.map((n) => ({ tree: n, label: doc.screen || n.name || label, manifest: doc.manifest }));
  if (doc.tree && typeof doc.tree === "object") return [{ tree: doc.tree, label: doc.tree.name || label, manifest: doc.manifest }];
  if (doc.type && doc.id) return [{ tree: doc, label: doc.name || label, manifest: doc.manifest }];
  return [];
}
var r1 = (v) => Math.round(v * 100) / 100;
var hasTok = (node, ...keys) => !!(node.tokens && keys.some((k) => node.tokens[k] != null));
function audit(input, opts = {}) {
  const platform = PLATFORMS.includes(opts.platform) ? opts.platform : "web";
  const grid = opts.grid > 0 ? opts.grid : 4;
  const docs = Array.isArray(input) ? input : [input];
  const roots = docs.flatMap((d, i) => rootsOf(d && d.doc !== void 0 ? d.doc : d, d && d.label || `input${i}`));
  const catalog = opts.catalog && Array.isArray(opts.catalog.components) ? opts.catalog.components : [];
  const findings = [];
  const add = (severity, code, message, node, ctx, extra) => findings.push(Object.assign(
    { severity, code, message },
    node ? { nodeId: node.id, nodeName: node.name } : {},
    ctx ? { screen: ctx.label, path: ctx.path } : {},
    extra || {}
  ));
  const binding = { color: [0, 0], typography: [0, 0], spacing: [0, 0], radius: [0, 0], effects: [0, 0] };
  const tally = (cat, bound) => {
    binding[cat][1]++;
    if (bound) binding[cat][0]++;
  };
  const rawColors = /* @__PURE__ */ new Map();
  const usedComponents = /* @__PURE__ */ new Map();
  const stateHits = { loading: [], empty: [], error: [] };
  const annotations = [];
  for (const root of roots) {
    const m = root.manifest || {};
    if (m.truncated) add("blocker", "export-truncated", `export of '${root.label}' was truncated (${m.truncated} subtree(s) past the depth limit) \u2014 the tree is incomplete; re-export a narrower scope before building`, null, { label: root.label });
    if (m.assetsFailed) add("blocker", "assets-failed", `${m.assetsFailed} asset export(s) failed in '${root.label}' \u2014 those nodes have no file (look for \`geometry\` fallbacks)`, null, { label: root.label });
    if (root.tree.devStatus && root.tree.devStatus !== "ready_for_dev" && root.tree.devStatus !== "completed") {
      add("warning", "not-ready-for-dev", `'${root.label}' dev status is '${root.tree.devStatus}' \u2014 confirm the design is final before building`, root.tree, { label: root.label, path: root.tree.name });
    }
    walk(root.tree, [], { label: root.label, rootBox: root.tree.box });
  }
  function walk(node, ancestors, ctx) {
    if (!node || typeof node !== "object") return;
    const path = [...ancestors.map((a) => a.name), node.name].join(" > ");
    const here = { label: ctx.label, path };
    const hiddenBranch = node.hidden || ancestors.some((a) => a.hidden);
    if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: a.label || a.markdown });
    if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });
    for (const [state, re] of Object.entries(STATE_WORDS)) {
      if (re.test(node.name || "") || node.type === "TEXT" && ancestors.length <= 6 && re.test(node.text || "")) {
        stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
      }
    }
    if (node.mainComponent || node.component) {
      const mc = node.mainComponent || {};
      const name = mc.setName || node.component;
      const key = mc.setKey || mc.key || name;
      if (key && !usedComponents.has(key)) usedComponents.set(key, { name, key: mc.setKey || mc.key, remote: !!mc.remote, nodeId: node.id });
    }
    if (node.detachedFrom) add("warning", "detached-instance", `'${node.name}' is a detached component instance \u2014 map it back to the component unless the detach was deliberate`, node, here);
    if (node.missingFont) add("blocker", "missing-font", `'${node.name}' uses a font Figma couldn't load \u2014 the recorded family/weight may not match the render; confirm the font files and license`, node, here);
    if (node.layout && node.layout.mode === "absolute" && Array.isArray(node.children) && node.children.length > 1 && node.type !== "GROUP" && ancestors.length > 0) {
      add("info", "no-auto-layout", `'${node.name}' has no auto layout (${node.children.length} children placed by coordinates) \u2014 infer a flow layout and ask how it should resize`, node, here);
    }
    if (ancestors.length <= 2 && node.box && ctx.rootBox && platform !== "web") {
      const label = `${node.name || ""} ${node.component || ""} ${node.mainComponent && node.mainComponent.setName || ""}`;
      if (CHROME_TOP.test(label) && node.box.h <= 64) add("warning", "fake-status-bar", `'${node.name}' looks like a drawn status bar \u2014 don't build it; apply the system safe-area/status-bar inset instead`, node, here);
      else if (CHROME_BOTTOM.test(label) && node.box.h <= 40) add("warning", "fake-home-indicator", `'${node.name}' looks like a drawn home indicator/gesture bar \u2014 use the bottom safe-area inset instead`, node, here);
    }
    const isAssetLeaf = !!(node.asset || node.geometry);
    if (!isAssetLeaf && node.type !== "TEXT" && Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (f.type === "solid") {
          const bound = !!(f.tokens || hasTok(node, "fills") || node.styles && node.styles.fill);
          tally("color", bound);
          if (!bound) noteRaw(f.color, node);
        }
        if (f.type === "gradient" && /DIAMOND/.test(f.kind || "") && platform !== "flutter") add("info", "diamond-gradient", `'${node.name}' uses a diamond gradient \u2014 no native equivalent; use the exported asset or approximate`, node, here);
        if (f.type === "image" && (f.scaleMode === "crop" || f.scaleMode === "tile")) add("info", "image-scale-mode", `'${node.name}' image fill uses scaleMode '${f.scaleMode}' \u2014 not a plain cover/contain; read the crop transform / tile scale`, node, here);
      }
    }
    if (!isAssetLeaf && node.strokes && (node.strokes.align === "outside" || node.strokes.align === "center") && (node.strokes.weight || node.strokes.weights)) {
      const how = { web: "a CSS border is inside the box \u2014 use outline/box-shadow (no layout) or grow the box", ios: "SwiftUI .strokeBorder is inside, .stroke is centered \u2014 pad an overlay for outside", android: "Modifier.border draws inside \u2014 compensate with padding or drawBehind", "react-native": "borderWidth is inside \u2014 wrap or add padding", flutter: "use BorderSide.strokeAlign outside/center" }[platform];
      add("info", "stroke-align", `'${node.name}' has a ${node.strokes.align} stroke \u2014 ${how}; the rendered size differs from box`, node, here);
    }
    if (!isAssetLeaf && node.strokes && Array.isArray(node.strokes.colors)) {
      for (const c of node.strokes.colors) {
        const bound = !!(hasTok(node, "strokes") || node.styles && node.styles.stroke || (node.strokes.paints || []).some((p) => p.tokens));
        tally("color", bound);
        if (!bound) noteRaw(c, node);
      }
    }
    if (node.type === "TEXT") {
      const runs = Array.isArray(node.runs) && node.runs.length ? node.runs : [{ font: node.font, tokens: node.textTokens, textStyle: node.styles && node.styles.text }];
      for (const r of runs) {
        const typoBound = !!(r.textStyle || node.styles && node.styles.text || r.tokens && (r.tokens.fontSize || r.tokens.fontFamily || r.tokens.lineHeight) || node.textTokens && (node.textTokens.fontSize || node.textTokens.fontFamily));
        tally("typography", typoBound);
        if (r.font && r.font.color) {
          const cBound = !!(r.tokens && r.tokens.fills || r.fillStyle || node.textTokens && node.textTokens.fills || hasTok(node, "fills") || node.styles && node.styles.fill);
          tally("color", cBound);
          if (!cBound) noteRaw(r.font.color, node);
        }
      }
      if (!hiddenBranch) textChecks(node, ancestors, here);
    }
    if (node.layout) {
      const L = node.layout;
      const spacing = [];
      if (typeof L.gap === "number") spacing.push(["gap", L.gap, hasTok(node, "itemSpacing")]);
      if (typeof L.rowGap === "number") spacing.push(["rowGap", L.rowGap, hasTok(node, "counterAxisSpacing")]);
      if (typeof L.columnGap === "number") spacing.push(["columnGap", L.columnGap, hasTok(node, "gridColumnGap")]);
      if (Array.isArray(L.padding)) {
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, j) => {
          if (L.padding[j]) spacing.push([k, L.padding[j], hasTok(node, k)]);
        });
      }
      const offGrid = [];
      for (const [k, v, bound] of spacing) {
        tally("spacing", bound);
        if (v < 0) add("info", "negative-spacing", `'${node.name}' ${k} is ${v} (overlap) \u2014 Compose Arrangement.spacedBy rejects negatives; use offset/overlay`, node, here);
        else if (!bound && (v % grid !== 0 || !Number.isInteger(v))) offGrid.push(`${k}=${v}`);
      }
      if (offGrid.length) add("info", "off-grid-spacing", `'${node.name}' has unbound spacing off the ${grid}px grid (${offGrid.join(", ")}) \u2014 likely drift; snap to the nearest token or confirm`, node, here);
    }
    if (node.radius != null) {
      const vals = typeof node.radius === "number" ? [node.radius] : Object.values(node.radius);
      const bound = hasTok(node, "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius");
      vals.forEach(() => tally("radius", bound));
      if (node.cornerSmoothing && (platform === "android" || platform === "web" || platform === "react-native")) {
        add("info", "corner-smoothing", `'${node.name}' uses corner smoothing ${node.cornerSmoothing} (squircle) \u2014 ${platform} has no native continuous corners; plain radius or a custom shape`, node, here);
      }
    }
    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        tally("effects", !!(e.tokens || node.styles && node.styles.effect));
        if ((e.type === "drop_shadow" || e.type === "inner_shadow") && e.spread && (platform === "ios" || platform === "android")) {
          add("info", "shadow-spread", `'${node.name}' shadow has spread ${e.spread} \u2014 ${platform === "ios" ? "SwiftUI .shadow/CALayer have no spread (use shadowPath or a padded shape)" : "Modifier.shadow can't express it (use Compose 1.9+ Modifier.dropShadow)"}`, node, here);
        }
        if (e.type === "background_blur" && (platform === "android" || platform === "react-native")) add("info", "background-blur", `'${node.name}' uses a background blur \u2014 ${platform === "android" ? "no backdrop blur below API 31 / needs window blur or a library" : "needs expo-blur or a native blur view"}`, node, here);
        if (e.blurType === "progressive") add("info", "progressive-blur", `'${node.name}' uses a progressive blur \u2014 no direct equivalent on any platform; mask a blur with a gradient or use the asset`, node, here);
        if (["noise", "glass", "texture", "shader"].includes(e.type)) add("info", "exotic-effect", `'${node.name}' uses a '${e.type}' effect \u2014 no code equivalent; rasterize via the exported asset if it's load-bearing`, node, here);
      }
    }
    if (node.blendMode && (platform === "android" || platform === "react-native")) add("info", "blend-mode", `'${node.name}' uses blend mode '${node.blendMode}' \u2014 limited support on ${platform}; flag or bake into an asset`, node, here);
    const tappable = !hiddenBranch && isTappable(node);
    if (tappable && node.box && !ancestors.some((a) => a.__tappable)) {
      const min = TOUCH_MIN[platform];
      if (node.box.w < min || node.box.h < min) {
        add("warning", "small-touch-target", `'${node.name}' is ${node.box.w}\xD7${node.box.h} \u2014 below the ${min}\xD7${min} ${platform} minimum; expand the hit area (padding/hitSlop/contentShape) even if the visual stays small`, node, here, { size: { w: node.box.w, h: node.box.h }, min });
      }
    }
    if (Array.isArray(node.children)) {
      const stacks = !node.layout || node.layout.mode === "absolute";
      const beneath = [];
      const self = { name: node.name, hidden: node.hidden, fills: node.fills, __tappable: tappable, __beneath: beneath };
      const chain = [...ancestors, self];
      for (const child of node.children) {
        self.__beneath = stacks || child.absolute ? beneath : [];
        walk(child, chain, ctx);
        if (!child.hidden && Array.isArray(child.fills)) beneath.push(...child.fills);
      }
    }
  }
  function isTappable(node) {
    if (Array.isArray(node.reactions) && node.reactions.some((r) => TAP_TRIGGER.test(r.trigger || ""))) return true;
    const compName = node.mainComponent && node.mainComponent.setName || node.component || "";
    if (node.type === "INSTANCE" && controlKind(compName)) return true;
    return (node.type === "INSTANCE" || node.type === "FRAME" || node.type === "COMPONENT") && INTERACTIVE_NAME.test(node.name || "") && !/\b(group|container|list|bar|section|row)s?\b/i.test(node.name || "");
  }
  function noteRaw(hex, node) {
    const h = String(hex || "").toLowerCase();
    if (!parseHex(h)) return;
    const e = rawColors.get(h) || { count: 0, nodeId: node.id, nodeName: node.name };
    e.count++;
    rawColors.set(h, e);
  }
  function textChecks(node, ancestors, here) {
    const font = node.font || {};
    if (!node.autoResize && !node.truncate && !node.maxLines) {
      add("warning", "fixed-size-text", `'${node.name}' is a fixed-size text box with no truncation rule \u2014 it will clip under font scaling or longer translations; decide wrap / truncate / grow`, node, here);
    }
    const fg = parseHex(font.color);
    if (!fg) return;
    let bg = null, complex = false;
    for (const a of ancestors) {
      const layers = [...Array.isArray(a.fills) ? a.fills : [], ...a.__beneath || []];
      for (const f of layers) {
        if (f.type === "solid") {
          const c = parseHex(f.color);
          if (!c) continue;
          bg = bg ? over(c, bg) : c.a >= 1 ? c : over(c, { r: 255, g: 255, b: 255, a: 1 });
          if (c.a >= 1) complex = false;
        } else if (f.type === "gradient" || f.type === "image" || f.type === "video") {
          complex = true;
        }
      }
    }
    const size = typeof font.size === "number" ? font.size : null;
    const bold = font.weightValue && font.weightValue >= 700 || /bold|black|heavy/i.test(font.weight || "");
    const large = size != null && (size >= 24 || size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (complex) {
      add("info", "contrast-manual", `'${node.name}' sits on a gradient/image \u2014 check text contrast manually (needs ${need}:1)`, node, here);
      return;
    }
    const assumed = !bg;
    const base = bg || { r: 255, g: 255, b: 255, a: 1 };
    const ratio = contrastRatio(over(fg, base), base);
    if (ratio < need) {
      add(assumed ? "info" : "warning", "low-contrast", `'${node.name}' text contrast ${r1(ratio)}:1 is below WCAG AA ${need}:1 (${large ? "large" : "normal"} text, ${font.color} on ${assumed ? "an assumed white page" : "its background"})`, node, here, { ratio: r1(ratio), required: need });
    }
  }
  const raws = [...rawColors.entries()].map(([hex, e]) => ({ hex, rgb: parseHex(hex), ...e })).filter((x) => x.rgb.a >= 1);
  const labs = raws.map((x) => toLab(x.rgb));
  const seen = /* @__PURE__ */ new Set();
  for (let a = 0; a < raws.length; a++) {
    if (seen.has(raws[a].hex)) continue;
    const cluster = [raws[a]];
    for (let b = a + 1; b < raws.length; b++) {
      if (!seen.has(raws[b].hex) && labDist(labs[a], labs[b]) < 3) {
        cluster.push(raws[b]);
        seen.add(raws[b].hex);
      }
    }
    if (cluster.length > 1) add("info", "near-duplicate-colors", `unbound colors ${cluster.map((c) => `${c.hex}\xD7${c.count}`).join(", ")} are visually indistinguishable (\u0394E<3) \u2014 probably one token`, null, null, { colors: cluster.map((c) => c.hex) });
  }
  const components = [];
  const byKey = /* @__PURE__ */ new Map(), byName = /* @__PURE__ */ new Map();
  for (const c of catalog) {
    if (c.key) byKey.set(c.key, c);
    if (c.name) byName.set(c.name, c);
  }
  const candidates = usedComponents.size ? [...usedComponents.values()].map((u) => ({ use: u, def: u.key && byKey.get(u.key) || byName.get(u.name) })) : catalog.filter((c) => c.type === "COMPONENT_SET" || c.type === "COMPONENT").map((c) => ({ use: { name: c.name }, def: c }));
  for (const { use, def } of candidates) {
    const kind = controlKind(use.name) || def && controlKind(def.name);
    if (!kind) continue;
    const need = requiredStates(kind, platform);
    if (!def) {
      components.push({ name: use.name, kind, known: false, present: [], missing: [], note: "not in the component catalog \u2014 states unknown" });
      continue;
    }
    const values = [];
    for (const p of Object.values(def.props || {})) {
      if (p.type === "VARIANT" && Array.isArray(p.options)) values.push(...p.options);
      if (p.type === "BOOLEAN") values.push(String(p.key || "").split("#")[0]);
    }
    const norm = values.map((v) => String(v).trim().toLowerCase());
    const present = Object.keys(STATE_SYNONYMS).filter((s) => norm.some((v) => STATE_SYNONYMS[s].test(v)));
    const missing = need.filter((s) => !present.includes(s));
    const sampled = !!(use.remote || def.remote);
    components.push({ name: def.name, kind, known: true, sampled, present, missing });
    if (missing.length) {
      add(sampled ? "info" : "warning", "missing-component-states", `${kind} '${def.name}' has no ${missing.join("/")} state${missing.length > 1 ? "s" : ""} in its variants${sampled ? " (library component \u2014 props are sampled, so this may be incomplete rather than missing)" : ""} \u2014 ask the designer or derive from tokens, and say so`, null, null, { component: def.name, missing });
    }
  }
  const screenStates = {};
  for (const s of Object.keys(stateHits)) screenStates[s] = stateHits[s].length ? "designed" : "not-found";
  const tokenBinding = {};
  for (const [k, [b, t]] of Object.entries(binding)) tokenBinding[k] = { bound: b, total: t, pct: t ? Math.round(b / t * 100) : null };
  for (const [k, v] of Object.entries(tokenBinding)) {
    if (v.total >= 5 && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) \u2014 expect to map raw values to the nearest token and report each`, null, null, { category: k });
  }
  const questions = [];
  const STATE_QUESTION = {
    loading: "what shows while data loads (skeleton vs spinner, delay before showing)?",
    empty: "what shows when there's no data (first use vs no results vs cleared)?",
    error: "what shows when a request fails (inline vs full-screen, retry, offline)?"
  };
  for (const s of ["loading", "empty", "error"]) if (screenStates[s] === "not-found") questions.push(`No ${s} state was found in the exported layers \u2014 ${STATE_QUESTION[s]}`);
  for (const c of components.filter((c2) => c2.missing && c2.missing.length)) questions.push(`'${c.name}' has no ${c.missing.join("/")} design \u2014 use the design-system default, or is there a spec?`);
  if (findings.some((f) => f.code === "fixed-size-text")) questions.push("Several text boxes are fixed-size \u2014 at 200% font scale or in a longer language, should they wrap, truncate (how many lines), or grow?");
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    platform,
    grid,
    screens: roots.map((r) => r.label),
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    tokenBinding,
    components,
    screenStates,
    annotations,
    questions,
    findings
  };
}
function toMarkdown(res) {
  const L = [];
  L.push(`# Design audit \u2014 ${res.screens.join(", ") || "(no screens)"}`, "");
  L.push(`Platform: **${res.platform}** \xB7 grid ${res.grid}px \xB7 **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
  L.push("## Token binding", "", "| Category | Bound | Total | % |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(res.tokenBinding)) L.push(`| ${k} | ${v.bound} | ${v.total} | ${v.pct == null ? "\u2013" : v.pct + "%"} |`);
  L.push("", "## Screen states", "");
  for (const [k, v] of Object.entries(res.screenStates)) L.push(`- ${k}: ${v === "designed" ? "designed" : "**not found \u2014 ask**"}`);
  if (res.components.length) {
    L.push("", "## Component states", "", "| Component | Kind | Present | Missing |", "|---|---|---|---|");
    for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "\u2013"} | ${c.known ? c.missing.join(", ") || "none" : c.note}${c.sampled ? " (sampled)" : ""} |`);
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs = res.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs.length})`, "");
    for (const f of fs) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` \u2014 node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}`);
  }
  if (res.annotations.length) {
    L.push("", "## Designer annotations", "");
    for (const a of res.annotations) L.push(`- **${a.nodeName}** (\`${a.nodeId}\`): ${a.label}`);
  }
  if (res.questions.length) {
    L.push("", "## Questions for the designer", "");
    res.questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  }
  return L.join("\n") + "\n";
}
module.exports = { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind, TOUCH_MIN };
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const argv = process.argv.slice(2);
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return void 0;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const platform = take("--platform");
  const catalogFile = take("--catalog");
  const gridArg = take("--grid");
  const out = take("--out");
  const strip = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return false;
    argv.splice(i, 1);
    return true;
  };
  const jsonOnly = strip("--json"), gate = strip("--gate");
  const USAGE = "usage: node design-to-code/audit.js <screen.json>... [--platform web|ios|android|react-native|flutter] [--catalog components.local.json] [--grid 4] [--out design/audit] [--json] [--gate]";
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const stray = argv.filter((a) => a.startsWith("-"));
  if (stray.length || !argv.length) {
    console.error((stray.length ? `audit: unknown flag ${stray.join(", ")}
` : "") + USAGE);
    process.exit(2);
  }
  if (platform && !PLATFORMS.includes(platform)) {
    console.error(`--platform must be one of ${PLATFORMS.join(", ")}`);
    process.exit(2);
  }
  const { readJsonFile } = require_catalog_input();
  const read = (f, what) => readJsonFile(f, what);
  const inputs = argv.map((f) => ({ doc: read(f, "screen export"), label: path.basename(f, ".json") }));
  const catalog = catalogFile ? read(catalogFile, "component catalog") : void 0;
  const res = audit(inputs, { platform, catalog, grid: gridArg ? Number(gridArg) : void 0 });
  const md = jsonOnly ? "" : toMarkdown(res);
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(out + ".md", md);
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(md);
  }
  if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
}
