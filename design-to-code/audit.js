// audit.js — pre-implementation review of a Figma export: the checks a senior frontend/mobile
// engineer runs BEFORE writing code, computed deterministically so the agent doesn't do contrast
// math or walk 5,000 nodes by eye.
//
// It reports what the export can PROVE (unbound values, off-grid spacing, small touch targets, low
// contrast, fixed-height text, drawn system chrome, missing component states, risky effects for the
// target platform) and lists what it CANNOT know (loading/empty/error screens that were never drawn),
// so the skill can turn those into designer questions. It never fails a build: findings are advice.
//
// Inputs are the plugin's own shapes, read as-is:
//   screen doc   design/<screen>.json            { exportedAt, screen, nodes:[tree], manifest }
//   layer file   design/pages/<dir>/<layer>.json  a bare node tree (or { tree })
//   catalog      design/design-system/components.local.json  { components:[{type,name,props}] }
// Returns { summary, findings, tokenBinding, components, screenStates, annotations, questions }.

const SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };

// Minimum hit-area per platform. web = WCAG 2.5.8 AA (24 CSS px); 44 is the recommended AAA target.
const TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
const PLATFORMS = Object.keys(TOUCH_MIN);

// ---------------------------------------------------------------- color math (WCAG 2.2)
function parseHex(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});
function luminance(c) {
  const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// CIE76 ΔE in Lab — a coarse "these two raw colors are probably meant to be one token" signal.
function toLab(c) {
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = lin(c.r), G = lin(c.g), B = lin(c.b);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const labDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const deltaE = (a, b) => labDist(toLab(a), toLab(b));

// ---------------------------------------------------------------- vocab
const INTERACTIVE_NAME = /\b(button|btn|cta|link|tab|chip|toggle|switch|checkbox|check box|radio|input|text ?field|textfield|search|select|dropdown|menu item|icon ?button|close|back|segmented|stepper|slider)\b/i;
const TAP_TRIGGER = /click|press|tap|drag/;
const CHROME_TOP = /status ?bar|9:41|battery|signal|dynamic island|notch/i;
const CHROME_BOTTOM = /home ?indicator|gesture ?bar|navigation ?handle/i;
const STATE_WORDS = {
  loading: /\b(loading|skeleton|spinner|shimmer|placeholder)\b/i,
  empty: /\b(empty|no results?|no data|nothing (here|found)|zero ?state)\b/i,
  error: /\b(error|failed|failure|offline|retry|something went wrong|not found|404|500)\b/i,
};
// State synonyms, matched against VARIANT option values and BOOLEAN prop names (real files name the
// property "Property 1" and put the state in the value, so the value is what carries the meaning).
const STATE_SYNONYMS = {
  hover: /^(hover|hovered|mouse ?over)$/,
  pressed: /^(pressed|press|active|tapped|down)$/,
  focus: /^(focus|focused|focus[- ]visible|keyboard ?focus)$/,
  disabled: /^(disabled|inactive|is ?disabled)$/,
  // Not "danger"/"destructive": those are button STYLE variants (a red button), not an error state.
  error: /^(error|invalid|has ?error|is ?invalid)$/,
  selected: /^(selected|checked|on|active|current|is ?selected)$/,
  loading: /^(loading|busy|in ?progress|is ?loading)$/,
};
// Which states each kind of control needs. `hover` only matters where there is a pointer.
function requiredStates(kind, platform) {
  const pointer = platform === "web";
  switch (kind) {
    case "button": return pointer ? ["hover", "pressed", "focus", "disabled"] : ["pressed", "disabled"];
    case "input": return ["focus", "error", "disabled"];
    case "toggle": return ["selected", "disabled"];
    case "tab": return ["selected"];
    case "link": return pointer ? ["hover", "focus"] : ["pressed"];
    default: return [];
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

// ---------------------------------------------------------------- input normalisation
// Accept every document shape the export writes: a screen doc ({nodes}), a layer file (bare tree or
// {tree}), or an array of trees. Each root keeps a label so findings say which screen they're in.
function rootsOf(doc, label) {
  if (!doc || typeof doc !== "object") return [];
  if (Array.isArray(doc)) return doc.flatMap((d, i) => rootsOf(d, `${label}[${i}]`));
  if (Array.isArray(doc.nodes)) return doc.nodes.map((n) => ({ tree: n, label: doc.screen || n.name || label, manifest: doc.manifest }));
  if (doc.tree && typeof doc.tree === "object") return [{ tree: doc.tree, label: doc.tree.name || label, manifest: doc.manifest }];
  if (doc.type && doc.id) return [{ tree: doc, label: doc.name || label, manifest: doc.manifest }];
  return [];
}

const r1 = (v) => Math.round(v * 100) / 100;
const hasTok = (node, ...keys) => !!(node.tokens && keys.some((k) => node.tokens[k] != null));

// ---------------------------------------------------------------- the audit
function audit(input, opts = {}) {
  const platform = PLATFORMS.includes(opts.platform) ? opts.platform : "web";
  const grid = opts.grid > 0 ? opts.grid : 4;
  const docs = Array.isArray(input) ? input : [input];
  const roots = docs.flatMap((d, i) => rootsOf(d && d.doc !== undefined ? d.doc : d, (d && d.label) || `input${i}`));
  const catalog = (opts.catalog && Array.isArray(opts.catalog.components)) ? opts.catalog.components : [];

  const findings = [];
  const add = (severity, code, message, node, ctx, extra) => findings.push(Object.assign(
    { severity, code, message },
    node ? { nodeId: node.id, nodeName: node.name } : {},
    ctx ? { screen: ctx.label, path: ctx.path } : {},
    extra || {}
  ));

  const binding = { color: [0, 0], typography: [0, 0], spacing: [0, 0], radius: [0, 0], effects: [0, 0] };
  const tally = (cat, bound) => { binding[cat][1]++; if (bound) binding[cat][0]++; };
  const rawColors = new Map(); // hex -> { count, sample node }
  const usedComponents = new Map(); // setKey|key|name -> { name, kind }
  const stateHits = { loading: [], empty: [], error: [] };
  const annotations = [];

  for (const root of roots) {
    const m = root.manifest || {};
    if (m.truncated) add("blocker", "export-truncated", `export of '${root.label}' was truncated (${m.truncated} subtree(s) past the depth limit) — the tree is incomplete; re-export a narrower scope before building`, null, { label: root.label });
    if (m.assetsFailed) add("blocker", "assets-failed", `${m.assetsFailed} asset export(s) failed in '${root.label}' — those nodes have no file (look for \`geometry\` fallbacks)`, null, { label: root.label });
    if (root.tree.devStatus && root.tree.devStatus !== "ready_for_dev" && root.tree.devStatus !== "completed") {
      add("warning", "not-ready-for-dev", `'${root.label}' dev status is '${root.tree.devStatus}' — confirm the design is final before building`, root.tree, { label: root.label, path: root.tree.name });
    }
    walk(root.tree, [], { label: root.label, rootBox: root.tree.box });
  }

  function walk(node, ancestors, ctx) {
    if (!node || typeof node !== "object") return;
    const path = [...ancestors.map((a) => a.name), node.name].join(" > ");
    const here = { label: ctx.label, path };
    const hiddenBranch = node.hidden || ancestors.some((a) => a.hidden);

    // Designer intent the agent must read, collected verbatim.
    if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: a.label || a.markdown });
    if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });

    // Drawn states (a layer called "Loading" or a hidden "Error toast") — evidence the state was designed.
    for (const [state, re] of Object.entries(STATE_WORDS)) {
      if (re.test(node.name || "") || (node.type === "TEXT" && ancestors.length <= 6 && re.test(node.text || ""))) {
        stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
      }
    }

    // Component usage → state coverage later.
    if (node.mainComponent || node.component) {
      const mc = node.mainComponent || {};
      const name = mc.setName || node.component;
      const key = mc.setKey || mc.key || name;
      if (key && !usedComponents.has(key)) usedComponents.set(key, { name, key: mc.setKey || mc.key, remote: !!mc.remote, nodeId: node.id });
    }
    if (node.detachedFrom) add("warning", "detached-instance", `'${node.name}' is a detached component instance — map it back to the component unless the detach was deliberate`, node, here);
    if (node.missingFont) add("blocker", "missing-font", `'${node.name}' uses a font Figma couldn't load — the recorded family/weight may not match the render; confirm the font files and license`, node, here);
    if (node.layout && node.layout.mode === "absolute" && Array.isArray(node.children) && node.children.length > 1 && node.type !== "GROUP" && ancestors.length > 0) {
      add("info", "no-auto-layout", `'${node.name}' has no auto layout (${node.children.length} children placed by coordinates) — infer a flow layout and ask how it should resize`, node, here);
    }

    // ---- system chrome drawn into a mobile frame (top-level-ish only)
    if (ancestors.length <= 2 && node.box && ctx.rootBox && platform !== "web") {
      const label = `${node.name || ""} ${node.component || ""} ${(node.mainComponent && node.mainComponent.setName) || ""}`;
      if (CHROME_TOP.test(label) && node.box.h <= 64) add("warning", "fake-status-bar", `'${node.name}' looks like a drawn status bar — don't build it; apply the system safe-area/status-bar inset instead`, node, here);
      else if (CHROME_BOTTOM.test(label) && node.box.h <= 40) add("warning", "fake-home-indicator", `'${node.name}' looks like a drawn home indicator/gesture bar — use the bottom safe-area inset instead`, node, here);
    }

    // ---- colors: fills, strokes, text
    const isAssetLeaf = !!(node.asset || node.geometry);
    // A TEXT node's `fills` ARE its glyph color — already counted via font.color below.
    if (!isAssetLeaf && node.type !== "TEXT" && Array.isArray(node.fills)) {
      for (const f of node.fills) {
        if (f.type === "solid") {
          const bound = !!(f.tokens || hasTok(node, "fills") || (node.styles && node.styles.fill));
          tally("color", bound);
          if (!bound) noteRaw(f.color, node);
        }
        if (f.type === "gradient" && /DIAMOND/.test(f.kind || "") && platform !== "flutter") add("info", "diamond-gradient", `'${node.name}' uses a diamond gradient — no native equivalent; use the exported asset or approximate`, node, here);
        if (f.type === "image" && (f.scaleMode === "crop" || f.scaleMode === "tile")) add("info", "image-scale-mode", `'${node.name}' image fill uses scaleMode '${f.scaleMode}' — not a plain cover/contain; read the crop transform / tile scale`, node, here);
      }
    }
    if (!isAssetLeaf && node.strokes && (node.strokes.align === "outside" || node.strokes.align === "center") && (node.strokes.weight || node.strokes.weights)) {
      const how = { web: "a CSS border is inside the box — use outline/box-shadow (no layout) or grow the box", ios: "SwiftUI .strokeBorder is inside, .stroke is centered — pad an overlay for outside", android: "Modifier.border draws inside — compensate with padding or drawBehind", "react-native": "borderWidth is inside — wrap or add padding", flutter: "use BorderSide.strokeAlign outside/center" }[platform];
      add("info", "stroke-align", `'${node.name}' has a ${node.strokes.align} stroke — ${how}; the rendered size differs from box`, node, here);
    }
    if (!isAssetLeaf && node.strokes && Array.isArray(node.strokes.colors)) {
      for (const c of node.strokes.colors) {
        const bound = !!(hasTok(node, "strokes") || (node.styles && node.styles.stroke) || (node.strokes.paints || []).some((p) => p.tokens));
        tally("color", bound);
        if (!bound) noteRaw(c, node);
      }
    }
    if (node.type === "TEXT") {
      const runs = Array.isArray(node.runs) && node.runs.length ? node.runs : [{ font: node.font, tokens: node.textTokens, textStyle: node.styles && node.styles.text }];
      for (const r of runs) {
        const typoBound = !!(r.textStyle || (node.styles && node.styles.text) || (r.tokens && (r.tokens.fontSize || r.tokens.fontFamily || r.tokens.lineHeight)) || (node.textTokens && (node.textTokens.fontSize || node.textTokens.fontFamily)));
        tally("typography", typoBound);
        if (r.font && r.font.color) {
          const cBound = !!((r.tokens && r.tokens.fills) || r.fillStyle || (node.textTokens && node.textTokens.fills) || hasTok(node, "fills") || (node.styles && node.styles.fill));
          tally("color", cBound);
          if (!cBound) noteRaw(r.font.color, node);
        }
      }
      if (!hiddenBranch) textChecks(node, ancestors, here);
    }

    // ---- spacing / radius
    if (node.layout) {
      const L = node.layout;
      const spacing = [];
      if (typeof L.gap === "number") spacing.push(["gap", L.gap, hasTok(node, "itemSpacing")]);
      if (typeof L.rowGap === "number") spacing.push(["rowGap", L.rowGap, hasTok(node, "counterAxisSpacing")]);
      if (typeof L.columnGap === "number") spacing.push(["columnGap", L.columnGap, hasTok(node, "gridColumnGap")]);
      if (Array.isArray(L.padding)) {
        ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, j) => { if (L.padding[j]) spacing.push([k, L.padding[j], hasTok(node, k)]); });
      }
      const offGrid = [];
      for (const [k, v, bound] of spacing) {
        tally("spacing", bound);
        if (v < 0) add("info", "negative-spacing", `'${node.name}' ${k} is ${v} (overlap) — Compose Arrangement.spacedBy rejects negatives; use offset/overlay`, node, here);
        else if (!bound && (v % grid !== 0 || !Number.isInteger(v))) offGrid.push(`${k}=${v}`);
      }
      if (offGrid.length) add("info", "off-grid-spacing", `'${node.name}' has unbound spacing off the ${grid}px grid (${offGrid.join(", ")}) — likely drift; snap to the nearest token or confirm`, node, here);
    }
    if (node.radius != null) {
      const vals = typeof node.radius === "number" ? [node.radius] : Object.values(node.radius);
      const bound = hasTok(node, "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius");
      vals.forEach(() => tally("radius", bound));
      if (node.cornerSmoothing && (platform === "android" || platform === "web" || platform === "react-native")) {
        add("info", "corner-smoothing", `'${node.name}' uses corner smoothing ${node.cornerSmoothing} (squircle) — ${platform} has no native continuous corners; plain radius or a custom shape`, node, here);
      }
    }

    // ---- effects
    if (Array.isArray(node.effects)) {
      for (const e of node.effects) {
        tally("effects", !!(e.tokens || (node.styles && node.styles.effect)));
        if ((e.type === "drop_shadow" || e.type === "inner_shadow") && e.spread && (platform === "ios" || platform === "android")) {
          add("info", "shadow-spread", `'${node.name}' shadow has spread ${e.spread} — ${platform === "ios" ? "SwiftUI .shadow/CALayer have no spread (use shadowPath or a padded shape)" : "Modifier.shadow can't express it (use Compose 1.9+ Modifier.dropShadow)"}`, node, here);
        }
        if (e.type === "background_blur" && (platform === "android" || platform === "react-native")) add("info", "background-blur", `'${node.name}' uses a background blur — ${platform === "android" ? "no backdrop blur below API 31 / needs window blur or a library" : "needs expo-blur or a native blur view"}`, node, here);
        if (e.blurType === "progressive") add("info", "progressive-blur", `'${node.name}' uses a progressive blur — no direct equivalent on any platform; mask a blur with a gradient or use the asset`, node, here);
        if (["noise", "glass", "texture", "shader"].includes(e.type)) add("info", "exotic-effect", `'${node.name}' uses a '${e.type}' effect — no code equivalent; rasterize via the exported asset if it's load-bearing`, node, here);
      }
    }
    if (node.blendMode && (platform === "android" || platform === "react-native")) add("info", "blend-mode", `'${node.name}' uses blend mode '${node.blendMode}' — limited support on ${platform}; flag or bake into an asset`, node, here);

    // ---- touch targets
    const tappable = !hiddenBranch && isTappable(node);
    if (tappable && node.box && !ancestors.some((a) => a.__tappable)) {
      const min = TOUCH_MIN[platform];
      if (node.box.w < min || node.box.h < min) {
        add("warning", "small-touch-target", `'${node.name}' is ${node.box.w}×${node.box.h} — below the ${min}×${min} ${platform} minimum; expand the hit area (padding/hitSlop/contentShape) even if the visual stays small`, node, here, { size: { w: node.box.w, h: node.box.h }, min });
      }
    }

    if (Array.isArray(node.children)) {
      // In a parent that doesn't flow its children (no auto layout), earlier siblings paint BENEATH
      // later ones — a caption laid over a photo gets its backdrop from a sibling, not an ancestor.
      const stacks = !node.layout || node.layout.mode === "absolute";
      const beneath = [];
      // Only what descendants read off an ancestor. The walk is synchronous and nothing keeps
      // `ancestors`, so `beneath` is shared, not copied — it grows only after the child returns.
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
    const compName = (node.mainComponent && node.mainComponent.setName) || node.component || "";
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
    // Fixed text box: no autoResize means Figma's "fixed size" — it will clip once text grows
    // (localization +30–40%, Dynamic Type / font scale up to 200–310%).
    if (!node.autoResize && !node.truncate && !node.maxLines) {
      add("warning", "fixed-size-text", `'${node.name}' is a fixed-size text box with no truncation rule — it will clip under font scaling or longer translations; decide wrap / truncate / grow`, node, here);
    }
    // Contrast against the composited ancestor background.
    const fg = parseHex(font.color);
    if (!fg) return;
    let bg = null, complex = false;
    for (const a of ancestors) {
      // The ancestor's own fills, then any earlier siblings stacked under the next level down.
      const layers = [...(Array.isArray(a.fills) ? a.fills : []), ...(a.__beneath || [])];
      for (const f of layers) {
        if (f.type === "solid") {
          const c = parseHex(f.color);
          if (!c) continue;
          bg = bg ? over(c, bg) : (c.a >= 1 ? c : over(c, { r: 255, g: 255, b: 255, a: 1 }));
          if (c.a >= 1) complex = false;
        } else if (f.type === "gradient" || f.type === "image" || f.type === "video") {
          complex = true;
        }
      }
    }
    const size = typeof font.size === "number" ? font.size : null;
    const bold = (font.weightValue && font.weightValue >= 700) || /bold|black|heavy/i.test(font.weight || "");
    const large = size != null && (size >= 24 || (size >= 18.66 && bold));
    const need = large ? 3 : 4.5;
    if (complex) { add("info", "contrast-manual", `'${node.name}' sits on a gradient/image — check text contrast manually (needs ${need}:1)`, node, here); return; }
    const assumed = !bg;
    const base = bg || { r: 255, g: 255, b: 255, a: 1 };
    const ratio = contrastRatio(over(fg, base), base);
    if (ratio < need) {
      add(assumed ? "info" : "warning", "low-contrast", `'${node.name}' text contrast ${r1(ratio)}:1 is below WCAG AA ${need}:1 (${large ? "large" : "normal"} text, ${font.color} on ${assumed ? "an assumed white page" : "its background"})`, node, here, { ratio: r1(ratio), required: need });
    }
  }

  // ---- near-duplicate raw colors (likely one token typed twice)
  const raws = [...rawColors.entries()].map(([hex, e]) => ({ hex, rgb: parseHex(hex), ...e })).filter((x) => x.rgb.a >= 1);
  const labs = raws.map((x) => toLab(x.rgb)); // once per color, not once per pair
  const seen = new Set();
  for (let a = 0; a < raws.length; a++) {
    if (seen.has(raws[a].hex)) continue;
    const cluster = [raws[a]];
    for (let b = a + 1; b < raws.length; b++) {
      if (!seen.has(raws[b].hex) && labDist(labs[a], labs[b]) < 3) { cluster.push(raws[b]); seen.add(raws[b].hex); }
    }
    if (cluster.length > 1) add("info", "near-duplicate-colors", `unbound colors ${cluster.map((c) => `${c.hex}×${c.count}`).join(", ")} are visually indistinguishable (ΔE<3) — probably one token`, null, null, { colors: cluster.map((c) => c.hex) });
  }

  // ---- component state coverage
  const components = [];
  const byKey = new Map(), byName = new Map();
  for (const c of catalog) { if (c.key) byKey.set(c.key, c); if (c.name) byName.set(c.name, c); }
  const candidates = usedComponents.size
    ? [...usedComponents.values()].map((u) => ({ use: u, def: (u.key && byKey.get(u.key)) || byName.get(u.name) }))
    : catalog.filter((c) => c.type === "COMPONENT_SET" || c.type === "COMPONENT").map((c) => ({ use: { name: c.name }, def: c }));
  for (const { use, def } of candidates) {
    const kind = controlKind(use.name) || (def && controlKind(def.name));
    if (!kind) continue;
    const need = requiredStates(kind, platform);
    if (!def) {
      components.push({ name: use.name, kind, known: false, present: [], missing: [], note: "not in the component catalog — states unknown" });
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
      add(sampled ? "info" : "warning", "missing-component-states", `${kind} '${def.name}' has no ${missing.join("/")} state${missing.length > 1 ? "s" : ""} in its variants${sampled ? " (library component — props are sampled, so this may be incomplete rather than missing)" : ""} — ask the designer or derive from tokens, and say so`, null, null, { component: def.name, missing });
    }
  }

  // ---- screen-level states: what was drawn vs what must be asked
  const screenStates = {};
  for (const s of Object.keys(stateHits)) screenStates[s] = stateHits[s].length ? "designed" : "not-found";

  const tokenBinding = {};
  for (const [k, [b, t]] of Object.entries(binding)) tokenBinding[k] = { bound: b, total: t, pct: t ? Math.round((b / t) * 100) : null };
  for (const [k, v] of Object.entries(tokenBinding)) {
    if (v.total >= 5 && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) — expect to map raw values to the nearest token and report each`, null, null, { category: k });
  }

  // ---- questions the export cannot answer (always asked; the skill trims ones already answered)
  const questions = [];
  const STATE_QUESTION = {
    loading: "what shows while data loads (skeleton vs spinner, delay before showing)?",
    empty: "what shows when there's no data (first use vs no results vs cleared)?",
    error: "what shows when a request fails (inline vs full-screen, retry, offline)?",
  };
  for (const s of ["loading", "empty", "error"]) if (screenStates[s] === "not-found") questions.push(`No ${s} state was found in the exported layers — ${STATE_QUESTION[s]}`);
  for (const c of components.filter((c) => c.missing && c.missing.length)) questions.push(`'${c.name}' has no ${c.missing.join("/")} design — use the design-system default, or is there a spec?`);
  if (findings.some((f) => f.code === "fixed-size-text")) questions.push("Several text boxes are fixed-size — at 200% font scale or in a longer language, should they wrap, truncate (how many lines), or grow?");

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
    findings,
  };
}

// ---------------------------------------------------------------- markdown report
function toMarkdown(res) {
  const L = [];
  L.push(`# Design audit — ${res.screens.join(", ") || "(no screens)"}`, "");
  L.push(`Platform: **${res.platform}** · grid ${res.grid}px · **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
  L.push("## Token binding", "", "| Category | Bound | Total | % |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(res.tokenBinding)) L.push(`| ${k} | ${v.bound} | ${v.total} | ${v.pct == null ? "–" : v.pct + "%"} |`);
  L.push("", "## Screen states", "");
  for (const [k, v] of Object.entries(res.screenStates)) L.push(`- ${k}: ${v === "designed" ? "designed" : "**not found — ask**"}`);
  if (res.components.length) {
    L.push("", "## Component states", "", "| Component | Kind | Present | Missing |", "|---|---|---|---|");
    for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "–"} | ${c.known ? (c.missing.join(", ") || "none") : c.note}${c.sampled ? " (sampled)" : ""} |`);
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs = res.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs.length})`, "");
    for (const f of fs) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` — node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}`);
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

// CLI: node design-to-code/audit.js <screen.json|layer.json>... [--platform web|ios|android|react-native|flutter]
//        [--catalog design/design-system/components.local.json] [--grid 4] [--out design/audit] [--json] [--gate]
// --gate: exit 1 if any blocker was found (default is always exit 0 — findings are advice unless --gate is set).
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i === -1) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const platform = take("--platform");
  const catalogFile = take("--catalog");
  const gridArg = take("--grid");
  const out = take("--out");
  const strip = (flag) => { const i = argv.indexOf(flag); if (i === -1) return false; argv.splice(i, 1); return true; };
  const jsonOnly = strip("--json"), gate = strip("--gate");
  const USAGE = "usage: node design-to-code/audit.js <screen.json>... [--platform web|ios|android|react-native|flutter] [--catalog components.local.json] [--grid 4] [--out design/audit] [--json] [--gate]";
  if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
  const stray = argv.filter((a) => a.startsWith("-"));
  if (stray.length || !argv.length) { console.error((stray.length ? `audit: unknown flag ${stray.join(", ")}\n` : "") + USAGE); process.exit(2); }
  if (platform && !PLATFORMS.includes(platform)) { console.error(`--platform must be one of ${PLATFORMS.join(", ")}`); process.exit(2); }
  const { readJsonFile } = require("./catalog-input.js");
  const read = (f, what) => readJsonFile(f, what);
  const inputs = argv.map((f) => ({ doc: read(f, "screen export"), label: path.basename(f, ".json") }));
  const catalog = catalogFile ? read(catalogFile, "component catalog") : undefined;
  const res = audit(inputs, { platform, catalog, grid: gridArg ? Number(gridArg) : undefined });
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
