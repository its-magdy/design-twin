// verify-screen.js — turn "looks right" into a per-node number, and refuse to say "pass" without one.
//
// The live run shipped three verification passes totalling ~42 minutes, all of which returned
// "pass"/"verified", against a build where an independent measurement pass then found ~35% of sampled
// values wrong (finding 102). Not rounding — real errors: a heading rendered at the page-title style
// instead of its own, an empty-state body at 16px/#d4d4d4 where the export says 14px/#a0a0a0, a status
// chip with its fill token never applied, a modal at radius 20 against a spec of 12, and two toolbar
// components never built at all. The verifiers compared screenshots and structure; nothing compared
// the numbers, so anything wrong-but-plausible passed.
//
// The root causes were all mechanical, and so are the fixes here:
//
//   (a) The spec was PARAPHRASED. The builder's own EmptyState.tsx comment asserted "heading 20/Semi
//       Bold, subtitle 16/Regular" — which contradicts the export — and that comment is presumably
//       how the bug got written. So `--expect` emits the spec as DATA, read straight off the node
//       tree. Nobody retypes a number that a file already holds.
//   (b) There was no per-node comparison at all. `--compare` diffs measured computed styles against
//       that spec, field by field, with an explicit tolerance per field.
//   (c) Verdicts were prose in a chat hand-back, so nothing could be audited or re-run (findings
//       85/92). Every run writes <screen>.report.json, and `pass` is computed from it, never asserted.
//   (d) Coverage and interactions were never checked (findings 80/101). A screen can match every
//       pixel and still be a dead mockup with two components missing.
//
// Two commands, one file, because the expectation format and the comparison must never drift:
//   node verify-screen.js --expect  <screen.json>... --out design/verify/<Screen>
//   node verify-screen.js --compare <Screen>.expected.json <measured.json> [--interactions <file>] --out design/verify/<Screen>
//
// There is NO browser in this file. `--compare` diffs two JSON files; the rendering, measuring and
// interaction-driving are the probe's job (the visual-verifier agent, or any script), and what it did
// arrives as measured.json (+ an optional --interactions file). Anything the probe did not measure is
// reported as not measured / not probed — never as passed, and never as failed (findings 127/158).
const { walkWithHidden } = require("./hidden.js");

// ---------------------------------------------------------------- tolerances
//
// Every tolerance is a deliberate claim about what a browser may legitimately do differently from
// Figma, NOT a fudge factor for sloppy building. They are tight on purpose: the live run's misses
// were 20-vs-18px font, 16-vs-14px, radius 20-vs-12, gap 23.5-vs-16, row 50-vs-48 — every one of
// them lands outside these, which is the point.
const TOLERANCE = {
  fontSize: 0.5, // a browser rounds; a different token does not
  fontWeight: 0, // 500 vs 600 is a different style, never a rendering artifact
  lineHeight: 2, // normal/unitless line-heights and font-metric rounding genuinely differ
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
};

// Colours compare exactly after normalisation. There is no "close enough" colour: the live run's
// chip was #03d5ab where the export said #007d6c, which any perceptual threshold loose enough to
// call a rendering artifact would also have let through.
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
    if (a === 0) return "transparent"; // rgba(0,0,0,0) is "no background", whatever the channels say
    const hex = (n) => Math.round(n).toString(16).padStart(2, "0");
    return "#" + hex(p[0]) + hex(p[1]) + hex(p[2]) + hex(Math.round(a * 255));
  }
  if (s === "transparent" || s === "rgba(0, 0, 0, 0)") return "transparent";
  return s;
}

// Figma names weights ("SemiBold"); CSS uses numbers. Compare on the number, because that is what a
// browser actually applies — and because "Medium" rendering as 600 is precisely the live bug.
const WEIGHTS = {
  thin: 100, extralight: 200, ultralight: 200, light: 300, normal: 400, regular: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};
function normWeight(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}

// Figma stores a family as one name; CSS reports the whole stack. A match on the FIRST family is the
// honest comparison — the fallbacks are the builder's business.
function normFamily(v) {
  if (v == null) return null;
  return String(v).split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}

function lineHeightPx(lh, fontSize) {
  if (lh == null) return null;
  if (typeof lh === "number") return lh;
  if (typeof lh === "string") {
    const s = lh.trim().toLowerCase();
    if (s === "normal") return null; // genuinely unknowable without the font metrics — not a mismatch
    const n = parseFloat(s);
    if (Number.isNaN(n)) return null;
    if (s.endsWith("%")) return fontSize ? (n / 100) * fontSize : null;
    if (s.endsWith("px")) return n;
    return fontSize ? n * fontSize : null; // unitless multiplier
  }
  if (typeof lh === "object") {
    if (lh.unit === "PERCENT" || lh.unit === "%") return fontSize ? (lh.value / 100) * fontSize : null;
    if (lh.unit === "AUTO") return null;
    return typeof lh.value === "number" ? lh.value : null;
  }
  return null;
}

// ---------------------------------------------------------------- the expectation
//
// One row per node worth checking, carrying ONLY values the export actually states. A field the
// export does not define is OMITTED, never defaulted — a spec that invents `fontWeight: 400` because
// the node didn't say produces exactly the confident-and-wrong comparison this file exists to stop.
//
// Only layers that RENDER get a row. The rule is hidden.js's one predicate (`hidden: true` on the
// node or any ancestor — never `visible === false`, which the export does not use). Before it,
// 83 of 272 Job Roles specs, 61 of 112 instances and 22 of 28 designed interactions were for layers
// the designer switched off (findings 97/126/181), and a build that correctly omitted them was graded
// on them (157/159/185/188).
const EXPECTATION_SCHEMA = "designtwin/verify-expectation@2";
const REPORT_SCHEMA = "designtwin/verify-report@2";

function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}

const firstSolid = (fills) => (fills || []).find((f) => f && f.type === "solid" && f.visible !== false);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;

// A layer drawn IN an interaction state. The designer drew one table row hovered (its fill is bound
// to `Backgrounds/Row Hover`, and only that row carries the hover-only edit button); measuring the
// build at rest and calling #121319-vs-#46464f a high-severity colour bug was 1 of 4 false highs on
// BOTH screens (findings 98/128/161/194). The export says which state it drew, through the fill's
// token name or a variant property, so the spec carries it and the probe measures that state.
const STATE_WORD = /(?:^|[^a-z])(hover(?:ed)?|pressed|focus(?:ed)?)(?:[^a-z]|$)/i;
const normState = (w) => (/^hover/i.test(w) ? "hover" : /^press/i.test(w) ? "pressed" : "focus");
function drawnStateOf(n) {
  const fillTok = (n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills) ||
    (Array.isArray(n.fills) && n.fills.map((f) => f && f.tokens && f.tokens.color).find((t) => typeof t === "string")) || null;
  let m = fillTok && STATE_WORD.exec(fillTok);
  if (m) return { state: normState(m[1]), why: `its fill is bound to '${fillTok}'` };
  for (const [k, v] of Object.entries(n.props || {})) {
    if (typeof v === "string" && /^\s*(hover(?:ed)?|pressed|focus(?:ed)?)\s*$/i.test(v)) return { state: normState(v.trim()), why: `variant ${k}=${v}` };
  }
  // `component` is the variant name, e.g. "Type=Primary, Status=Hover".
  for (const pair of String(n.component || "").split(",")) {
    const [k, v] = pair.split("=").map((s) => s && s.trim());
    if (k && v && /^(hover(?:ed)?|pressed|focus(?:ed)?)$/i.test(v)) return { state: normState(v), why: `variant ${k}=${v}` };
  }
  return null;
}

// An inline SVG's colour is its `fill`, not a CSS background. Comparing a vector's fills against
// `background-color` produced the other recurring false high (the moon glyph, the Union icon —
// findings 98/128/161/194).
const PAINT_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
const isPaintNode = (n) => PAINT_TYPES.has(n.type) || (typeof n.asset === "string" && /\.svg$/i.test(n.asset));

// A text layer that IS an input's placeholder. Its colour lives on `::placeholder`, which
// getComputedStyle(el) cannot see, and an empty <input> has no textContent — so comparing it as
// ordinary text/colour was two guaranteed high deltas per placeholder (findings 128/177/194).
function isPlaceholder(n) {
  if (n.type !== "TEXT") return false;
  const toks = [n.tokens && n.tokens.fills, ...(Array.isArray(n.fills) ? n.fills.map((f) => f && f.tokens && f.tokens.color) : [])];
  return toks.some((t) => typeof t === "string" && /placeholder/i.test(t)) || /placeholder/i.test(n.name || "");
}

// Position, FRAME-RELATIVE. The export's `box.x/y` are page-space and only present where the parent
// does not auto-position the node (absolute children, non-auto-layout parents); `renderBox` is the
// render bounds (for TEXT: the glyph ink). Subtracting the frame's own `box.x/y` gives the same
// coordinates a probe gets from `el.getBoundingClientRect()` minus the frame element's rect. No
// position was compared at all before (findings 164/192): a pagination bar 130px below the frame and
// an 18.94px column drift scored zero deltas.
function framePosition(n, frame) {
  if (!frame || !num(frame.x) || !num(frame.y)) return null;
  const b = n.box || {}, rb = n.renderBox;
  if (n.type === "TEXT") {
    // Ink start (renderBox.x) is what a Range's getBoundingClientRect().x reports, within a
    // side-bearing. Vertical ink depends on font metrics, so a TEXT node carries no `y`.
    if (rb && num(rb.x)) return { x: r2(rb.x - frame.x), source: "renderBox" };
    if (num(b.x)) return { x: r2(b.x - frame.x), source: "box" };
    return null;
  }
  if (num(b.x) && num(b.y)) return { x: r2(b.x - frame.x), y: r2(b.y - frame.y), source: "box" };
  // renderBox includes stroke/shadow/blur overflow; it is the layout box only when the sizes agree.
  if (rb && num(rb.x) && num(rb.y) && num(b.w) && num(b.h) && Math.abs(rb.w - b.w) <= 0.5 && Math.abs(rb.h - b.h) <= 0.5) {
    return { x: r2(rb.x - frame.x), y: r2(rb.y - frame.y), source: "renderBox" };
  }
  return null;
}

// Children that take part in the parent's flow: visible and not absolutely positioned.
const inFlowChildren = (n) => (Array.isArray(n.children) ? n.children : []).filter((c) => c && !c.hidden && !c.absolute);
const growsAlong = (c, dir) => c.grow === 1 || c.grow === true || (dir === "column" ? c.heightMode === "fill" : c.widthMode === "fill");

/**
 * The spec row for one VISIBLE node, plus any design values the method cannot compare
 * (`notComparable`, each with a reason). `ctx` = { path, frame, inheritedState }.
 */
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
  // A TEXT node's fill is its TEXT colour, not a background — conflating the two is how a chip with a
  // missing background still looked "bound" (finding 100).
  if (fill && n.type !== "TEXT") {
    if (isPaintNode(n)) spec.fill = normColor(fill.color);
    else spec.backgroundColor = normColor(fill.color);
  }
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);

  if (isPlaceholder(n)) {
    spec.placeholder = true;
    if (spec.text !== undefined) { spec.placeholderText = spec.text; delete spec.text; }
    if (spec.color !== undefined) { spec.placeholderColor = spec.color; delete spec.color; }
  }

  // `strokes` is an OBJECT, not an array of paints: `{colors:[…], weight | weights:{top,right,
  // bottom,left}, align, dash, …}` (figma-plugin/src/paint.ts simplifyStrokes). Treating it as an
  // array is how this blew up on the first real export it saw.
  const st = n.strokes;
  if (st && typeof st === "object" && Array.isArray(st.colors) && st.colors.length) {
    spec.borderColor = normColor(st.colors[0]);
    if (typeof st.weight === "number") spec.borderWidth = st.weight;
    // Per-side weights (a divider with only a bottom border) have no single CSS `border-width` to
    // compare against, so record them as their own field rather than picking one arbitrarily.
    else if (st.weights && typeof st.weights === "object") spec.borderWidths = ["top", "right", "bottom", "left"].map((k) => (typeof st.weights[k] === "number" ? st.weights[k] : 0));
  }
  // Radius: one number, or per-corner. A per-corner radius with UNEQUAL corners (a table header
  // rounded only at the top) is compared corner by corner — the old code read `radius.tl` only, so
  // a card rounded at the bottom ({bl,br}) produced no radius spec at all (finding 162).
  if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object") {
    const c = ["tl", "tr", "br", "bl"].map((k) => (num(n.radius[k]) ? n.radius[k] : 0));
    if (c.every((v) => v === c[0])) spec.borderRadius = c[0];
    else spec.radiusCorners = { tl: c[0], tr: c[1], br: c[2], bl: c[3] };
  }

  const L = n.layout;
  if (L && typeof L === "object") {
    const g = typeof L.gap === "number" ? L.gap : typeof L.itemSpacing === "number" ? L.itemSpacing : undefined;
    if (g !== undefined) {
      // A stored gap is only a GAP when it separates laid-out children. Three shapes where it is not
      // (finding 194: `gap 200 → 16`, `gap 146`, `gap 160` were all Figma auto-layout slack):
      const dir = L.flexDirection === "column" ? "column" : "row";
      const flow = inFlowChildren(n);
      if (flow.length < 2) skip("gap", g, `fewer than two laid-out children (${flow.length}) — a gap has nothing to separate`);
      else if (L.justifyContent === "space-between") skip("gap", g, "space-between: Figma ignores item spacing here, so the stored value is slack, not a gap");
      else if (flow.some((c) => growsAlong(c, dir))) skip("gap", g, "a child fills the main axis, so the stored gap and that child's size trade off — placement is checked through the children's positions and sizes instead");
      else spec.gap = g;
    }
    let pad = null;
    if (Array.isArray(L.padding)) pad = L.padding.slice(0, 4);
    else if (["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].some((k) => typeof L[k] === "number")) pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => L[k]);
    if (pad && pad.some((v) => typeof v === "number" && v !== 0)) spec.padding = pad.map((v) => (typeof v === "number" ? v : 0));
  }
  if (n.box) {
    if (typeof n.box.w === "number") spec.width = n.box.w;
    if (typeof n.box.h === "number") spec.height = n.box.h;
  }
  const pos = framePosition(n, ctx.frame);
  if (pos) {
    spec.x = pos.x;
    if (pos.y !== undefined) spec.y = pos.y;
    spec.positionFrom = pos.source;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;

  const own = drawnStateOf(n);
  if (own) { spec.drawnState = own.state; spec.drawnStateWhy = own.why; spec.drawnStateOwn = true; }
  else if (ctx.inheritedState) { spec.drawnState = ctx.inheritedState.state; spec.drawnStateWhy = `inside '${ctx.inheritedState.from}', which ${ctx.inheritedState.why}`; }

  // The token NAME, carried through for the report. A mismatch whose spec value is bound to a token is
  // a token bug, not a number bug, and that distinction is what tells a reader where to look.
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  if (ctx.frameId) spec.frameId = ctx.frameId;
  // Backward-compatible return: callers that only want the row get it; buildExpectation reads both.
  Object.defineProperty(spec, "__notComparable", { value: notComparable, enumerable: false });
  return spec;
}

// Which nodes are worth a row. Everything visible that CARRIES a checkable value — a node with no
// font, no fill, no radius, no layout and no stated position has nothing to be wrong about, and listing
// it would bury the rows that matter. A stated position counts: the pagination bar that rendered 130px
// below the frame carries nothing else (finding 164).
function checkable(spec) {
  return ["text", "placeholderText", "fontSize", "color", "backgroundColor", "fill", "borderRadius", "radiusCorners", "gap", "padding", "borderColor", "x"].some((k) => spec[k] !== undefined);
}

const COORDINATES =
  "x/y are FRAME-RELATIVE: the node's page-space position minus the frame's own box.x/box.y. Measure " +
  "el.getBoundingClientRect() minus the rendered frame element's rect (the viewport origin when the frame " +
  "IS the page). A TEXT node's x is its INK start (the export's renderBox) — measure it with a Range over " +
  "the text and report it as textBox {x,w}. TEXT nodes carry no y (vertical ink depends on font metrics). " +
  "Auto-layout children carry no position (the export does not state one); their parent's is compared.";

function buildExpectation(docs) {
  const nodes = [];
  const instances = [];
  const interactions = [];
  const notComparable = [];
  const hidden = { roots: [], ids: [], specsSkipped: 0, instancesSkipped: 0, interactionsSkipped: 0 };
  const frames = [];
  const seen = new Set();
  let screen = null, exportedAt = null, reference = null;

  for (const { doc, label } of docs) {
    if (!screen) screen = (doc && doc.screen) || label;
    if (!exportedAt) exportedAt = doc && doc.exportedAt;
    for (const root of rootsOf(doc)) {
      if (!reference && root.reference) reference = root.reference;
      const b = root.box || {};
      const frame = { nodeId: root.id, name: root.name, w: b.w, h: b.h, x: b.x, y: b.y, clip: root.clip === true };
      frames.push(frame);
      const frameId = frames.length > 1 ? root.id : undefined;
      const stateOf = new WeakMap(); // node -> inherited drawn-state { state, why, from }
      walkWithHidden(root, (n, c) => {
        if (c.hidden) {
          // Counted, never specified. The ids travel with the expectation so --compare can say "you
          // drove a hidden layer" instead of crediting it (finding 187).
          if (!c.parentHidden) hidden.roots.push({ nodeId: n.id, name: n.name, path: c.path });
          if (n.id) hidden.ids.push(n.id);
          if (checkable(expectNode(n, { path: c.path }))) hidden.specsSkipped++;
          if (n.type === "INSTANCE" && n.mainComponent) hidden.instancesSkipped++;
          for (const r of Array.isArray(n.reactions) ? n.reactions : []) hidden.interactionsSkipped += (Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : []).filter((a) => a && (a.type || a.navigation)).length;
          return;
        }
        const inherited = c.parent ? stateOf.get(c.parent) : undefined;
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
            props: n.props || undefined,
          });
        }
        // The interaction graph is already in the export, keyed by node id — the richest input in the
        // whole IR (finding 70) and the one nothing verified (finding 80). The real shape is
        // `reactions[].actions[]` (plural on both), with `trigger` a plain string — see
        // figma-plugin/src/prototype.ts. A singular `action` is accepted too so an older export still
        // yields interactions rather than silently producing none.
        for (const r of Array.isArray(n.reactions) ? n.reactions : []) {
          const actions = Array.isArray(r.actions) ? r.actions : r.action ? [r.action] : [];
          const trigger = (r.trigger && (r.trigger.type || r.trigger)) || r.on || "on_click";
          for (const a of actions) {
            if (!a || !(a.type || a.navigation)) continue;
            interactions.push({
              nodeId: n.id,
              name: n.name,
              trigger: String(trigger).toLowerCase(),
              action: a.navigation || a.type,
              destinationId: a.destinationId,
              destination: a.destination,
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
    reference,
    frame: { nodeId: f0.nodeId, name: f0.name, w: f0.w, h: f0.h, clip: f0.clip },
    frames: frames.length > 1 ? frames.map((f) => ({ nodeId: f.nodeId, name: f.name, w: f.w, h: f.h, clip: f.clip })) : undefined,
    coordinates: COORDINATES,
    note:
      "Generated from the export — do NOT retype these numbers into code comments. Every row is the " +
      "value the design states; a field the export does not define is absent rather than defaulted. " +
      "Layers the designer switched off (hidden: true on the node or an ancestor) have NO row: do not build, " +
      "measure or drive them — their ids are listed under `hidden`. Feed this to a renderer probe and compare " +
      "with `verify-screen.js --compare`; the probe's field names are listed under `measuredKeys`.",
    measuredKeys: MEASURED_KEYS_DOC,
    tolerance: TOLERANCE,
    counts: {
      nodes: nodes.length, instances: instances.length, interactions: interactions.length, notComparable: notComparable.length,
      hidden: { layers: hidden.roots.length, nodes: hidden.ids.length, specsSkipped: hidden.specsSkipped, instancesSkipped: hidden.instancesSkipped, interactionsSkipped: hidden.interactionsSkipped },
    },
    nodes,
    instances,
    interactions,
    notComparable,
    hidden: { roots: hidden.roots, ids: hidden.ids },
  };
}

// ---------------------------------------------------------------- the comparison
//
// The CANONICAL measured keys. A probe that names a field differently is not silently skipped any
// more: a key in FIELDS that is present in zero measurements is printed in the headline, and keys this
// file does not read are listed (finding 182 — a probe wrote `radius`, the comparer read
// `borderRadius`, and a whole category of values passed untested for a phase).
const MEASURED_KEYS_DOC = {
  "nodes[].nodeId": "the Figma node id the measurement is FOR (from data-dt-node, or matched by text/position)",
  "nodes[].styles": "computed values: fontFamily fontSize fontWeight lineHeight letterSpacing color backgroundColor borderColor borderWidth borderRadius (number | [tl,tr,br,bl]) padding ([t,r,b,l]) gap width height x y opacity text",
  "nodes[].styles.fill": "an SVG's paint: getComputedStyle(<path|rect|circle>).fill — never background-color",
  "nodes[].styles.textBox": "{x,w} of a Range over a TEXT node's characters, frame-relative — required when the id sits on a padded container (<th>, <button>, <label>)",
  "nodes[].styles.gapVisual": "the rendered distance between consecutive children — required for a <table> (border-spacing, not gap)",
  "nodes[].styles.placeholderText / placeholderColor": "el.placeholder / the ::placeholder colour (getComputedStyle(el,'::placeholder').color or the stylesheet rule)",
  "nodes[].styles.tag": "the element's tagName, lower-case",
  "nodes[].states.<hover|pressed|focus>": "the same styles, measured WITH the element in that state — required for a node whose spec has drawnState",
  "interactions[]": "{nodeId, trigger, ok: true|false|null, selector, selectorCount, detail} — `ok:true` needs the selector you drove and how many elements it matched (>=1); ok:null = not probed",
  "components[]": "{setName|nodeId, present: true|false} — present:false is an explicit claim of absence",
  "expectationSha256": "sha256 of the .expected.json you measured against",
};
const KNOWN_MEASURED_KEYS = new Set([
  "nodeId", "styles", "states", "matchedBy", "note", "notes", "selector",
  "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "color", "backgroundColor", "fill", "borderColor",
  "borderWidth", "borderRadius", "gap", "gapVisual", "width", "height", "x", "y", "opacity", "padding", "text",
  "placeholderText", "placeholderColor", "tag", "textBox", "display", "transform", "rotate", "visible",
]);
// Suggestions only — the key is NEVER silently accepted (design note: a wrong key must be loud).
const KEY_HINTS = { radius: "borderRadius", borderTopLeftRadius: "borderRadius", background: "backgroundColor", bg: "backgroundColor", w: "width", h: "height", svgFill: "fill", placeholder: "placeholderText", rowGap: "gapVisual", columnGap: "gap" };

const FIELDS = [
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
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" },
];

// Which variable a delta is about. It used to be `Object.values(spec.tokens)[0]` whatever the field,
// so a background delta read `token: "Space 4"` (findings 98/160).
const TOKEN_KEYS = {
  color: ["fills", "color"], backgroundColor: ["fills"], fill: ["fills"], placeholderColor: ["fills"],
  borderColor: ["strokes"], borderWidth: ["strokeWeight", "strokeTopWeight"],
  fontSize: ["fontSize"], fontWeight: ["fontWeight"], fontFamily: ["fontFamily"], lineHeight: ["lineHeight"], letterSpacing: ["letterSpacing"],
  gap: ["itemSpacing", "gap"], width: ["width", "minWidth"], height: ["height", "minHeight"], opacity: ["opacity"],
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  "radius.tl": ["topLeftRadius"], "radius.tr": ["topRightRadius"], "radius.br": ["bottomRightRadius"], "radius.bl": ["bottomLeftRadius"],
  borderRadius: ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "cornerRadius"],
};
function tokenFor(spec, key) {
  const t = spec && spec.tokens;
  if (!t) return undefined;
  const names = [...new Set((TOKEN_KEYS[key] || []).map((k) => t[k]).filter((v) => typeof v === "string"))];
  return names.length ? names.join(" / ") : undefined;
}

function compareField(f, want, got) {
  const nw = f.norm ? f.norm(want) : want;
  const ng = f.norm ? f.norm(got) : got;
  if (nw == null || ng == null) return null; // one side cannot be known — not a mismatch, reported as unchecked
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

// A measured radius as four corners [tl,tr,br,bl]: a number, an array, or a CSS shorthand string.
function radiusCorners(v) {
  if (v == null) return null;
  if (num(v)) return [v, v, v, v];
  if (Array.isArray(v)) { const a = v.map(Number); return a.length === 4 && a.every(Number.isFinite) ? a : a.length === 1 && Number.isFinite(a[0]) ? [a[0], a[0], a[0], a[0]] : null; }
  const p = String(v).trim().split(/\s+/).map(parseFloat);
  if (!p.length || p.some(Number.isNaN)) return null;
  return p.length === 1 ? [p[0], p[0], p[0], p[0]] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p.slice(0, 4);
}
// CSS clamps a radius at half the shorter side, and so does Figma: `radius: 500` on a 36px box and
// `rounded-full` (33554400px) are both a circle (finding 194). Compare the radius each side can ACTUALLY
// draw, not the number either side stored.
const clampRadius = (r, w, h) => (num(w) && num(h) && w > 0 && h > 0 ? Math.min(r, Math.min(w, h) / 2) : r);

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);
// A TEXT node's id on an element that is NOT the text's own box (a <th> with padding, a <button>,
// a <label>) — its width/height/x describe the container, not the text (finding 194: `height 24 → 56`
// on a Status header that is typographically exact).
const CONTAINER_TAGS = new Set(["th", "td", "tr", "button", "label", "li", "a", "section", "article", "header", "footer", "nav", "table", "input"]);
const isContainer = (got) => (got.tag && CONTAINER_TAGS.has(String(got.tag).toLowerCase())) || (Array.isArray(got.padding) && got.padding.some((v) => Number(v) > 0));

const LIMITS = [
  "::before/::after content and any other pseudo-element are invisible to a computed-style probe; the export cannot say which layers a build draws that way, so they are compared only if the probe reports them under the node's id.",
  "::placeholder colour is compared only when the probe reports placeholderColor (getComputedStyle(el,'::placeholder') or the stylesheet rule); otherwise it is listed under `unverifiable`, never passed.",
  "A rotation applied with the CSS `rotate` property reads `transform: none` (Tailwind v4 `rotate-180`) — read `rotate` too before calling a rotation missing (finding 198).",
  "Positions are compared only where the export states one (absolute layers, render/ink boxes); auto-layout children are placed by their parent, whose position is compared.",
];

/**
 * compare(expectation, measured, opts?) -> report.
 * opts: { interactions: [...] extra interaction evidence (the --interactions file),
 *         expectationSha256, measuredSha256, artifactCheck: [{path, exists, image}] }
 */
function compare(expectation, measured, opts) {
  opts = opts || {};
  measured = measured || {};
  const hiddenSet = new Set(((expectation.hidden && expectation.hidden.ids) || []).map(String));
  const legacy = expectation.schema !== EXPECTATION_SCHEMA;
  const specs = (expectation.nodes || []).filter((s) => !hiddenSet.has(String(s.nodeId)));
  const frameOf = (spec) => (spec.frameId && (expectation.frames || []).find((f) => f.nodeId === spec.frameId)) || expectation.frame || {};

  // ---- index the measurements (first one wins; duplicates are counted, not silently merged)
  const byId = new Map();
  let duplicateNodeIds = 0;
  const unknownKeys = new Map();
  for (const m of measured.nodes || []) {
    if (!m || m.nodeId == null) continue;
    const id = String(m.nodeId);
    if (byId.has(id)) { duplicateNodeIds++; continue; }
    byId.set(id, m);
    const s = m.styles || m;
    for (const k of Object.keys(s)) if (!KNOWN_MEASURED_KEYS.has(k)) unknownKeys.set(k, (unknownKeys.get(k) || 0) + 1);
  }
  // A shared implementation (one AppShell rendered on two routes) carries the node ids of the frame it
  // was built from: `I10970:111588;1910:23337` on Job Roles is `I10970:109860;1910:23337` here — the
  // same component-internal node under a different outer instance (findings 129/139/185). Match on
  // that internal path when it is unambiguous, and say so.
  const expectedIds = new Set([...specs.map((s) => String(s.nodeId)), ...(expectation.instances || []).map((i) => String(i.nodeId))]);
  const suffix = (id) => { const i = id.indexOf(";"); return i === -1 ? null : id.slice(i + 1); };
  const foreignBySuffix = new Map();
  for (const id of byId.keys()) {
    if (expectedIds.has(id) || hiddenSet.has(id)) continue;
    const sfx = suffix(id);
    if (sfx) foreignBySuffix.set(sfx, (foreignBySuffix.get(sfx) || []).concat(id));
  }
  const viaSharedPath = (id) => { const sfx = suffix(String(id)); const c = sfx && foreignBySuffix.get(sfx); return c && c.length === 1 ? c[0] : null; };

  const deltas = [];
  const notMeasured = []; // node specs with NO measurement at all — one row per node, never per field
  const fieldsNotMeasured = []; // a measured node missing a field the spec states
  const unverifiable = []; // values the method cannot read unless the probe goes out of its way
  const census = new Map(); // field -> { expected, present } over MEASURED nodes
  const tally = (key, present) => { const c = census.get(key) || { expected: 0, present: 0 }; c.expected++; if (present) c.present++; census.set(key, c); };
  let fieldsChecked = 0, nodesMeasured = 0, nodesMatchedByComponentPath = 0;
  const gap = (spec, field, why) => fieldsNotMeasured.push({ nodeId: spec.nodeId, name: spec.name, field, why });
  const push = (spec, field, severity, bad, extra) => deltas.push(Object.assign({
    severity, nodeId: spec.nodeId, name: spec.name, path: spec.path, field,
    expected: bad.want, actual: bad.got, delta: bad.delta,
  }, extra));

  for (const spec of specs) {
    let m = byId.get(String(spec.nodeId));
    let matchedBy = m ? m.matchedBy || "id" : null;
    if (!m) {
      const alt = viaSharedPath(spec.nodeId);
      if (alt) { m = byId.get(alt); matchedBy = `shared-component-path (${alt})`; nodesMatchedByComponentPath++; }
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
    if (st) { got = Object.assign({}, base, st.styles || st); measuredIn = state; }
    const zeroAtRest = num(base.width) && num(base.height) && base.width === 0 && base.height === 0;
    const stateWhy = state && `the designer drew this ${spec.drawnStateOwn ? "layer" : "layer's container"} in its ${state} state (${spec.drawnStateWhy}) — measure it ${state === "hover" ? "hovered" : state} and report the values under states.${state}`;

    // Hover-only content measured at rest is absent by design, not missing (finding 128/194: the
    // edit button that exists only on the hovered row, "36 → 0").
    if (state && measuredIn === "rest" && zeroAtRest) {
      for (const f of FIELDS) if (spec[f.key] !== undefined) { tally(f.key, false); gap(spec, f.label, `renders 0×0 at rest: ${stateWhy}`); }
      continue;
    }
    const isText = spec.type === "TEXT";
    const container = isText && isContainer(got);
    const tb = got.textBox && typeof got.textBox === "object" ? got.textBox : null;
    const table = got.tag && TABLE_TAGS.has(String(got.tag).toLowerCase());

    for (const f of FIELDS) {
      if (spec[f.key] === undefined) continue;
      let val = got[f.key];
      let present = val !== undefined;
      if (isText && tb && (f.key === "x" || f.key === "width")) { val = f.key === "x" ? tb.x : tb.w; present = val !== undefined; }
      if (f.key === "gap" && got.gapVisual !== undefined) { val = got.gapVisual; present = true; }
      tally(f.key, present);

      if (state && measuredIn === "rest" && spec.drawnStateOwn && f.colour) { gap(spec, f.label, stateWhy); continue; }
      if (isText && f.box && container && !tb) {
        gap(spec, f.label, `this TEXT node's id sits on a <${got.tag || "container"}>${Array.isArray(got.padding) && got.padding.some((v) => Number(v) > 0) ? " with padding" : ""}, whose box is not the text's — report textBox (a Range over the text) instead`);
        continue;
      }
      if (isText && tb && f.key === "height") { continue; } // a Range's height is the font's content area, not the line box
      if (f.key === "gap" && table && got.gapVisual === undefined) {
        gap(spec, f.label, `the element is a <${got.tag}>, which spaces rows with border-spacing, not gap — report gapVisual (the distance between consecutive rows)`);
        continue;
      }
      if (val === undefined) {
        if (f.optional) { unverifiable.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, expected: spec[f.key], why: "a ::placeholder colour is not readable from getComputedStyle(el) — report placeholderColor to have it checked" }); continue; }
        gap(spec, f.label, "the probe did not report this property");
        continue;
      }
      fieldsChecked++;
      let want = spec[f.key], have = val;
      if (f.key === "borderRadius") {
        const c = radiusCorners(val);
        if (!c) { gap(spec, f.label, `could not read '${JSON.stringify(val)}' as a radius`); fieldsChecked--; continue; }
        const W = num(got.width) ? got.width : spec.width, H = num(got.height) ? got.height : spec.height;
        want = clampRadius(want, spec.width, spec.height);
        // the four corners must all match a uniform design radius
        const worst = c.map((r) => clampRadius(r, W, H)).reduce((a, r) => (Math.abs(r - want) > Math.abs(a - want) ? r : a), clampRadius(c[0], W, H));
        have = worst;
      }
      const bad = compareField(f, want, have);
      if (bad) {
        push(spec, f.label, f.high ? "high" : "medium", bad, {
          unit: f.unit, token: tokenFor(spec, f.key), measuredIn: measuredIn !== "rest" ? measuredIn : undefined,
          matchedBy: matchedBy !== "id" ? matchedBy : undefined,
          note: f.key === "borderRadius" && spec.borderRadius !== want ? `design radius ${spec.borderRadius} on a ${spec.width}×${spec.height} box draws ${want}` : undefined,
        });
      }
    }

    // ---- per-corner radius (unequal corners)
    if (spec.radiusCorners) {
      const c = radiusCorners(got.borderRadius);
      tally("borderRadius", got.borderRadius !== undefined);
      if (!c) gap(spec, "border-radius", got.borderRadius === undefined ? "the probe did not report this property" : `could not read '${JSON.stringify(got.borderRadius)}' as a radius`);
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
    if (spec.padding !== undefined) {
      tally("padding", got.padding !== undefined);
      if (got.padding === undefined) gap(spec, "padding", "the probe did not report this property");
      else if (got.tag && String(got.tag).toLowerCase() === "tr") gap(spec, "padding", "a table row's padding lives on its cells — report the first/last cell's padding under this id");
      else {
        fieldsChecked++;
        const bad = comparePadding(spec.padding, got.padding);
        const allZero = got.padding.every((v) => Number(v) === 0);
        if (bad) push(spec, "padding", "medium", bad, { unit: "px", token: tokenFor(spec, "padding"),
          note: allZero && !got.tag ? "measured 0 on every side — if this id sits on a <tr> or a wrapper, the padding lives on its cells/child: report `tag` and measure the element that carries it" : undefined });
      }
    }
    if (spec.placeholderText !== undefined) {
      tally("placeholderText", got.placeholderText !== undefined);
      if (got.placeholderText === undefined) gap(spec, "placeholder text", "this layer is an input placeholder: report el.placeholder as placeholderText (textContent of an empty input is '')");
      else {
        fieldsChecked++;
        if (String(got.placeholderText).trim() !== String(spec.placeholderText).trim()) push(spec, "placeholder text", "high", { want: spec.placeholderText, got: got.placeholderText, delta: null });
      }
    }
    if (spec.text !== undefined) {
      tally("text", got.text !== undefined && got.text !== null);
      if (got.text === null) gap(spec, "text", "the probe reported text: null — an element with child elements still has text; report its textContent");
      else if (got.text !== undefined) {
        fieldsChecked++;
        // Compare the literal characters. Figma's text-transform renders "NO. Of" from a stored "NO. of"
        // — so the STORED string is the truth and a case-only difference the CSS explains is not a bug.
        const w = String(spec.text).replace(/ /g, " ").trim();
        const g = String(got.text).replace(/ /g, " ").trim();
        if (w !== g) {
          const caseOnly = w.toLowerCase() === g.toLowerCase();
          // "Job Role▲": the designed string plus glyphs that are not letters or digits (a sort caret,
          // an icon font) — the copy is intact; name the extra glyphs rather than calling it a copy bug.
          const extraGlyphs = !caseOnly && g.startsWith(w) && !/[\p{L}\p{N}]/u.test(g.slice(w.length));
          push(spec, "text", caseOnly || extraGlyphs ? "low" : "high", { want: spec.text, got: got.text, delta: null }, {
            note: caseOnly ? "differs only in case — check for a text-transform, which Figma applies at render time while storing the original"
              : extraGlyphs ? `the designed text is intact, followed by '${g.slice(w.length).trim()}' (an icon or caret inside the same element?)` : undefined,
          });
        }
        if (/ /.test(String(spec.text))) {
          // Show the escape, not the character. Printed raw, this row reads as two identical strings
          // flagged as a mismatch — the whole point is that the difference is INVISIBLE.
          const show = (t) => String(t).replace(/ /g, "\\u00a0");
          deltas.push({
            severity: "low", nodeId: spec.nodeId, name: spec.name, field: "text (invisible character)",
            expected: show(spec.text), actual: show(got.text),
            note: "the designed string contains a non-breaking space (U+00A0) — a Figma auto-substitution. Carrying it into the DOM verbatim is usually not what anyone meant; decide deliberately.",
          });
        }
      }
    }

    // ---- placement: a designed-inside-the-frame node that renders outside it (finding 164)
    const fr = frameOf(spec);
    const bx = got;
    if (num(fr.w) && num(fr.h) && (num(bx.x) || num(bx.y))) {
      const w = num(bx.width) ? bx.width : 0, h = num(bx.height) ? bx.height : 0;
      const tol = TOLERANCE.position;
      const inDesign = (!num(spec.x) || (spec.x >= -tol && spec.x + (spec.width || 0) <= fr.w + tol)) && (!num(spec.y) || (spec.y >= -tol && spec.y + (spec.height || 0) <= fr.h + tol));
      const out = [];
      if (num(bx.y) && bx.y + h > fr.h + tol) out.push(`bottom edge at y=${r2(bx.y + h)} in a ${fr.h}-high frame`);
      if (num(bx.y) && bx.y < -tol) out.push(`top edge at y=${r2(bx.y)}`);
      if (num(bx.x) && bx.x + w > fr.w + tol) out.push(`right edge at x=${r2(bx.x + w)} in a ${fr.w}-wide frame`);
      if (num(bx.x) && bx.x < -tol) out.push(`left edge at x=${r2(bx.x)}`);
      if (inDesign && out.length && !(zeroAtRest)) {
        deltas.push({ severity: "high", nodeId: spec.nodeId, name: spec.name, path: spec.path, field: "placement", expected: "inside the frame", actual: out.join(", "), note: "the design places this node inside the frame; the build renders it outside, where the user cannot see it without scrolling" });
      }
    }
  }

  // ---- fields in FIELDS that the probe never reported under the canonical key (finding 182)
  const fieldsNeverMeasured = [];
  for (const [key, c] of census) {
    if (FIELDS.some((f) => f.key === key && f.optional)) continue; // listed under `unverifiable` instead
    if (c.expected > 0 && c.present === 0) {
      const hinted = [...unknownKeys.keys()].filter((k) => KEY_HINTS[k] === key);
      fieldsNeverMeasured.push({ field: key, expectedOn: c.expected, measuredOn: 0, probeSent: hinted.length ? hinted : undefined });
    }
  }

  // ---- component evidence. NOT presence: this is how many instance sets the probe could point at
  // (a data-dt-node id, a reported setName, or a shared-component path). A correct build that tags
  // nothing scores 0 here and a build that tags everything scores 100% without a pixel checked
  // (finding 169), so it never fails a screen on its own; only an explicit `present: false` does.
  const comps = Array.isArray(measured.components) ? measured.components : [];
  const reported = comps.filter((c) => c && c.present !== false);
  const namesSeen = new Set(reported.map((c) => String(c.setName || c.name || c)));
  const idsSeen = new Set([...reported.map((c) => c.nodeId).filter(Boolean).map(String), ...byId.keys()]);
  const bySet = new Map();
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
    if (v.nodeIds.some((id) => viaSharedPath(id))) { setsViaSharedPath++; continue; }
    untaggedInstanceSets.push(v);
  }
  const componentsAbsent = [];
  for (const c of comps.filter((c) => c && c.present === false)) {
    const set = [...bySet.values()].find((v) => v.setName === (c.setName || c.name) || v.nodeIds.includes(c.nodeId));
    if (set) componentsAbsent.push({ setName: set.setName, nodeIds: set.nodeIds, detail: c.detail || c.note });
  }

  // ---- interactions: the export says what each control does; did it? Three states, not two:
  // pass (driven, with the selector that was driven), fail (driven, did not work), not-probed
  // (nobody drove it — which is neither; finding 158 was a "not measured" detail under result "fail").
  const allEvidence = [...(Array.isArray(measured.interactions) ? measured.interactions : []), ...(Array.isArray(opts.interactions) ? opts.interactions : [])];
  const exercised = new Map();
  let interactionEvidenceOnHidden = 0;
  const expectedKeys = new Set((expectation.interactions || []).map((i) => String(i.nodeId) + "|" + i.trigger));
  for (const r of allEvidence) {
    if (!r || r.nodeId == null) continue;
    if (hiddenSet.has(String(r.nodeId))) { interactionEvidenceOnHidden++; continue; }
    exercised.set(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase(), r); // later evidence wins
  }
  const interactions = (expectation.interactions || []).filter((i) => !hiddenSet.has(String(i.nodeId))).map((i) => {
    const hit = exercised.get(String(i.nodeId) + "|" + i.trigger);
    const row = { nodeId: i.nodeId, name: i.name, trigger: i.trigger, action: i.action, destinationId: i.destinationId };
    if (!hit) return Object.assign(row, { result: "not-probed", detail: "no probe result for this node and trigger" });
    const count = Number(hit.selectorCount);
    if (hit.result === "not-probed" || hit.ok === null || hit.ok === undefined) return Object.assign(row, { result: "not-probed", detail: hit.detail });
    if (hit.ok === false) return Object.assign(row, { result: "fail", detail: hit.detail, selector: hit.selector });
    // ok:true is a claim; the evidence is the selector that was driven and proof it matched something.
    // An agent once credited two hidden popup rows with hovers it performed on unrelated controls (187).
    if (!hit.selector || !(count >= 1)) {
      return Object.assign(row, { result: "not-probed", detail: `reported ok without evidence — ${!hit.selector ? "no selector named" : `selector '${hit.selector}' matched ${Number.isFinite(count) ? count : "an unreported number of"} element(s)`}${hit.detail ? `; probe said: ${hit.detail}` : ""}` });
    }
    return Object.assign(row, { result: "pass", detail: hit.detail, selector: hit.selector, selectorCount: count });
  });
  const unexpectedInteractionEvidence = allEvidence.filter((r) => r && r.nodeId != null && !hiddenSet.has(String(r.nodeId)) && !expectedKeys.has(String(r.nodeId) + "|" + String(r.trigger || "on_click").toLowerCase())).length;
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsNotProbed = interactions.filter((i) => i.result === "not-probed");
  const interactionsPassed = interactions.filter((i) => i.result === "pass");

  const high = deltas.filter((d) => d.severity === "high").length;
  const medium = deltas.filter((d) => d.severity === "medium").length;

  // ---- what the evidence is tied to (findings 153/166/190)
  const inputs = {
    expectationSchema: expectation.schema || "(none)",
    expectationSha256: opts.expectationSha256,
    measuredSha256: opts.measuredSha256,
    measuredAgainst: measured.expectationSha256 || undefined,
  };
  const stale = !!(opts.expectationSha256 && measured.expectationSha256 && measured.expectationSha256 !== opts.expectationSha256);
  const staticOnly = measured.mode === "static-only";
  const artifactCheck = Array.isArray(opts.artifactCheck) ? opts.artifactCheck : null;
  const noRender = !!artifactCheck && !artifactCheck.some((a) => a.exists && a.image);

  // The verdict is COMPUTED. Coverage first — how much was looked at decides what the rest is worth.
  const nodesExpected = specs.length;
  const reasons = [];
  if (legacy) reasons.push(`the expectation is ${expectation.schema || "unversioned"}, which predates hidden-layer filtering — regenerate it with --expect before trusting any number here`);
  if (stale) reasons.push(`the measurements were taken against a DIFFERENT expectation (${String(measured.expectationSha256).slice(0, 12)}… vs ${String(opts.expectationSha256).slice(0, 12)}…) — re-measure`);
  if (staticOnly) reasons.push(`not rendered — the probe reported static-only${measured.reason ? ` (${measured.reason})` : ""}`);
  if (noRender) reasons.push("no screenshot of this render exists on disk — nothing ties these numbers to a picture (write design/verify/<Screen>.png and list it in artifacts)");
  for (const f of fieldsNeverMeasured) reasons.push(`field '${f.field}' was present in 0 of ${nodesMeasured} measurements${f.probeSent ? ` (the probe sent '${f.probeSent.join("', '")}' — the canonical key is '${f.field}')` : ""} — ${f.expectedOn} expectation(s) went unchecked`);
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
    hiddenLayersSkipped: (expectation.counts && expectation.counts.hidden) || undefined,
    instanceSets: bySet.size,
    instanceSetsWithEvidence: bySet.size - untaggedInstanceSets.length,
    instanceSetsViaSharedPath: setsViaSharedPath,
    interactionsExpected: interactions.length,
    interactionsPassed: interactionsPassed.length,
    interactionsFailed: interactionsFailed.length,
    interactionsNotProbed: interactionsNotProbed.length,
  };
  const mark = verdict.toUpperCase();
  const headline =
    `${mark} — ` +
    (fieldsNeverMeasured.length ? `NEVER MEASURED: ${fieldsNeverMeasured.map((f) => `'${f.field}' present in 0 of ${nodesMeasured} measurements${f.probeSent ? ` (probe sent '${f.probeSent.join("', '")}')` : ""}`).join("; ")} · ` : "") +
    `nodes measured ${nodesMeasured}/${nodesExpected} · ${fieldsChecked} values compared · ${high} high, ${medium} medium · ` +
    `interactions ${interactionsPassed.length} pass, ${interactionsFailed.length} fail, ${interactionsNotProbed.length} not-probed of ${interactions.length} · ` +
    `data-dt-node/component evidence ${coverage.instanceSetsWithEvidence}/${bySet.size} instance sets (tag coverage, not presence)`;

  return {
    schema: REPORT_SCHEMA,
    screen: expectation.screen,
    exportedAt: expectation.exportedAt,
    measuredAt: measured.measuredAt || new Date().toISOString(),
    renderer: measured.renderer || "unknown",
    viewport: measured.viewport,
    artifacts: artifactCheck || (Array.isArray(measured.artifacts) ? measured.artifacts : []),
    inputs,
    verdict,
    headline,
    why: reasons,
    coverage,
    summary: { high, medium, low: deltas.filter((d) => d.severity === "low").length, componentsAbsent: componentsAbsent.length, interactionsFailed: interactionsFailed.length, interactionsNotProbed: interactionsNotProbed.length },
    deltas: deltas.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]),
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
      measuredIdsOnHiddenLayers: [...byId.keys()].filter((id) => hiddenSet.has(id)).length,
    },
    limits: LIMITS,
  };
}

function reportToMarkdown(r) {
  const L = [];
  L.push(`# Verify — ${r.screen}`, "");
  L.push(`**${r.headline || r.verdict.toUpperCase()}**`, "");
  L.push(`renderer ${r.renderer}${r.viewport ? ` at ${typeof r.viewport === "object" ? JSON.stringify(r.viewport) : r.viewport}` : ""} · measured ${r.measuredAt}` +
    (r.inputs && r.inputs.expectationSha256 ? ` · against expectation ${r.inputs.expectationSha256.slice(0, 12)}…` : ""), "");
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
  if (c.hiddenLayersSkipped) L.push(`| hidden layers skipped (not built, not measured, not driven) | ${c.hiddenLayersSkipped.layers} layer(s) · ${c.hiddenLayersSkipped.specsSkipped} spec(s) · ${c.hiddenLayersSkipped.instancesSkipped} instance(s) · ${c.hiddenLayersSkipped.interactionsSkipped} interaction(s) |`);
  L.push(`| instance sets the probe could point at (data-dt-node / component evidence — coverage, NOT presence) | ${c.instanceSetsWithEvidence} / ${c.instanceSets} |`);
  L.push(`| designed interactions: pass / fail / not-probed | ${c.interactionsPassed} / ${c.interactionsFailed} / ${c.interactionsNotProbed} of ${c.interactionsExpected} |`, "");
  if (r.deltas.length) {
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token |", "|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      L.push(`| ${d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${fmt(d.expected)}${d.unit || ""} | ${fmt(d.actual)}${d.unit || ""} | ${d.token || "—"} |`);
    }
    L.push("");
  }
  if (r.componentsAbsent.length) {
    L.push(`## Components the probe reported ABSENT (${r.componentsAbsent.length})`, "");
    for (const m of r.componentsAbsent) L.push(`- **${m.setName}** — e.g. \`${m.nodeIds[0]}\`${m.detail ? ` — ${m.detail}` : ""}`);
    L.push("");
  }
  if (r.untaggedInstanceSets.length) {
    L.push(`## Instance sets with no evidence in the probe (${r.untaggedInstanceSets.length})`, "",
      "*Tag coverage, not presence: these carry no `data-dt-node` and no reported setName. They may well be built — a repeated row rendered by one `.map()` or a shared shell is expected to leave gaps here. Not a failure on its own.*", "");
    for (const m of r.untaggedInstanceSets.slice(0, 40)) L.push(`- ${m.setName} — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    if (r.untaggedInstanceSets.length > 40) L.push(`- …and ${r.untaggedInstanceSets.length - 40} more`);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result !== "pass");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length} node specs)`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} — ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- …and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  if (r.fieldsNotMeasured.length) {
    L.push(`## Values the probe did not report on measured nodes (${r.fieldsNotMeasured.length})`, "");
    for (const n of r.fieldsNotMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}) — ${n.why}`);
    if (r.fieldsNotMeasured.length > 40) L.push(`- …and ${r.fieldsNotMeasured.length - 40} more`);
    L.push("");
  }
  if (r.notComparable.length || r.unverifiable.length) {
    L.push(`## Excluded by method (${r.notComparable.length + r.unverifiable.length})`, "", "*Stated so they are not mistaken for passes.*", "");
    for (const n of [...r.unverifiable, ...r.notComparable].slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""} (${n.field}${n.value !== undefined ? ` ${fmt(n.value)}` : ""}) — ${n.why}`);
    if (r.notComparable.length + r.unverifiable.length > 40) L.push(`- …and ${r.notComparable.length + r.unverifiable.length - 40} more`);
    L.push("");
  }
  const p = r.probe || {};
  if ((p.unknownKeys && p.unknownKeys.length) || p.duplicateNodeIds || p.interactionEvidenceOnHiddenLayers || p.measuredIdsOnHiddenLayers) {
    L.push("## About the probe's input", "");
    for (const k of p.unknownKeys || []) L.push(`- key \`${k.key}\` (${k.count}×) is not read by verify-screen${k.canonical ? ` — the canonical key is \`${k.canonical}\`` : ""}`);
    if (p.duplicateNodeIds) L.push(`- ${p.duplicateNodeIds} duplicate node id(s) in nodes[] — the first measurement of each id was used`);
    if (p.measuredIdsOnHiddenLayers) L.push(`- ${p.measuredIdsOnHiddenLayers} measurement(s) are for hidden layers and were ignored`);
    if (p.interactionEvidenceOnHiddenLayers) L.push(`- ${p.interactionEvidenceOnHiddenLayers} interaction result(s) are for hidden layers and were ignored — a hidden layer cannot be driven`);
    L.push("");
  }
  L.push("## Limits of this method", "");
  for (const l of r.limits || []) L.push(`- ${l}`);
  return L.join("\n") + "\n";
}
const fmt = (v) => (Array.isArray(v) ? v.join("/") : String(v));

module.exports = { buildExpectation, compare, reportToMarkdown, expectNode, normColor, normWeight, normFamily, lineHeightPx, tokenFor, radiusCorners, TOLERANCE, FIELDS, EXPECTATION_SCHEMA, REPORT_SCHEMA };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const { readJsonFile } = require("./catalog-input.js");
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i === -1) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const strip = (flag) => { const i = argv.indexOf(flag); if (i === -1) return false; argv.splice(i, 1); return true; };
  const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const USAGE =
    "usage:\n" +
    "  node design-to-code/verify-screen.js --expect <screen.json>... --out design/verify/<Screen>\n" +
    "      writes <Screen>.expected.json — the design's own numbers, as data, for VISIBLE layers only.\n" +
    "      Read them; never retype them. --out defaults to design/verify/<the first input file's own basename>.\n" +
    "  node design-to-code/verify-screen.js --compare <Screen>.expected.json <measured.json> [--interactions <file>] --out design/verify/<Screen>\n" +
    "      writes <Screen>.report.json + .md and exits 1 unless the verdict is 'pass'. It has NO browser: it compares\n" +
    "      two JSON files. Interaction results come from measured.json's interactions[] and/or --interactions <file>\n" +
    "      (a JSON array, or {interactions:[…]}, of {nodeId, trigger, ok, selector, selectorCount, detail}).\n" +
    "      --out defaults to design/verify/<the .expected.json file's own basename>.";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); process.exit(argv.length ? 0 : 2); }

  const out = take("--out");
  const interactionsFile = take("--interactions");
  const doExpect = strip("--expect");
  const doCompare = strip("--compare");
  if (doExpect === doCompare) { console.error("pass exactly one of --expect / --compare\n" + USAGE); process.exit(2); }
  if (interactionsFile !== undefined && !doCompare) { console.error("--interactions only applies to --compare\n" + USAGE); process.exit(2); }
  const stray = argv.filter((a) => a.startsWith("-"));
  if (stray.length) { console.error(`verify-screen: unknown flag ${stray.join(", ")}\n` + USAGE); process.exit(2); }

  const write = (base, obj, md) => {
    if (!base) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); return; }
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(base + (doExpect ? ".expected.json" : ".report.json"), JSON.stringify(obj, null, 2) + "\n");
    if (md) fs.writeFileSync(base + ".report.md", md);
    console.error(`wrote ${base}${doExpect ? ".expected.json" : ".report.json"}${md ? " and " + base + ".report.md" : ""}`);
  };

  if (doExpect) {
    if (!argv.length) { console.error("--expect needs at least one screen export\n" + USAGE); process.exit(2); }
    const docs = argv.map((f) => ({ doc: readJsonFile(f, "screen export"), label: path.basename(f, ".json") }));
    const exp = buildExpectation(docs);
    // P3 #152: `--expect` run once by base name and once by a nickname for the SAME screen wrote
    // two byte-identical files (`positions___7314_87192.expected.json` and `JobRoles.expected.json`)
    // because nothing tied the output name to the screen's own identity. Defaulting to the FIRST
    // input file's own basename — already `<LayerName>__<node-id>` by construction (write-out.js) —
    // means two runs against the same export file always land on the same name, whatever string the
    // caller typed on the command line.
    const outBase = out || path.join("design", "verify", path.basename(argv[0], ".json"));
    // Findings 153/181: re-running --expect replaced the file in place and left a measurement and a
    // report from the OLD expectation beside it, undated. The file itself stays byte-deterministic
    // (finding 154) — the notice goes to stderr, and every report records the sha it was computed on.
    const target = outBase + ".expected.json";
    const next = JSON.stringify(exp, null, 2) + "\n";
    const prev = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    write(outBase, exp);
    const h = crypto.createHash("sha256").update(next).digest("hex");
    if (prev !== null && prev === next) console.error(`note  ${target} was already identical (sha256 ${h.slice(0, 12)}…) — unchanged`);
    else if (prev !== null) {
      console.error(`note  REPLACED an existing ${target} that differed (sha256 ${crypto.createHash("sha256").update(prev).digest("hex").slice(0, 12)}… → ${h.slice(0, 12)}…)`);
      const stale = [".measured.json", ".report.json", ".report.md"].map((s) => outBase + s).filter((f) => fs.existsSync(f));
      if (stale.length) console.error(`warn  ${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} computed against the PREVIOUS expectation — re-measure and re-compare before reading ${stale.length > 1 ? "them" : "it"}.`);
    }
    const hc = exp.counts.hidden;
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s) — visible layers only; ` +
      `skipped ${hc.layers} hidden layer(s) (${hc.specsSkipped} spec(s), ${hc.instancesSkipped} instance(s), ${hc.interactionsSkipped} interaction(s)); ` +
      `${exp.counts.notComparable} design value(s) excluded by method (listed in notComparable) · expectation sha256 ${h.slice(0, 12)}…`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` on visible layers — interaction coverage cannot be checked, and the report will say so rather than passing.");
    process.exit(0);
  }

  const [expFile, measuredFile] = argv;
  if (!expFile || !measuredFile) { console.error("--compare needs <expected.json> <measured.json>\n" + USAGE); process.exit(2); }
  const expectation = readJsonFile(expFile, "expectation");
  const measured = readJsonFile(measuredFile, "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, expectationSha256, nodes:[{nodeId,styles}], components:[], interactions:[]}.");
  let extra;
  if (interactionsFile) {
    const raw = readJsonFile(interactionsFile, "interaction evidence", "Write a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}.");
    extra = Array.isArray(raw) ? raw : Array.isArray(raw && raw.interactions) ? raw.interactions : null;
    if (!extra) { console.error(`--interactions ${interactionsFile}: expected a JSON array or {interactions:[…]}`); process.exit(2); }
  }
  // Artifacts are checked on disk, relative to the working directory (the project root), so a report
  // can never cite a screenshot that does not exist (findings 166/190).
  const artifacts = Array.isArray(measured.artifacts) ? measured.artifacts : [];
  const artifactCheck = artifacts.map((a) => {
    const p = typeof a === "string" ? a : a && a.path;
    const exists = !!p && fs.existsSync(p);
    return { path: p, exists, image: !!p && /\.(png|jpe?g|webp)$/i.test(p), sha256: exists ? sha(p) : undefined };
  });
  const rep = compare(expectation, measured, { interactions: extra, expectationSha256: sha(expFile), measuredSha256: sha(measuredFile), artifactCheck });
  const md = reportToMarkdown(rep);
  // Same rule as --expect (P3 #152): default to the EXPECTATION file's own basename (stripping the
  // `.expected` suffix it was written with), so `--compare <Screen>.expected.json <measured.json>`
  // always reports under `<Screen>.report.*`, never a second name for the same screen.
  const compareBase = out || path.join("design", "verify", path.basename(expFile, ".json").replace(/\.expected$/, ""));
  write(compareBase, rep, md);
  console.error(rep.headline);
  process.exit(rep.verdict === "pass" ? 0 : 1);
}
