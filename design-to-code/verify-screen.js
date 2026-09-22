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
//   node verify-screen.js --compare <Screen>.expected.json <measured.json> --out design/verify/<Screen>

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
  size: 2, // layout rounding across a whole row accumulates a pixel or two
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
function walk(node, fn, path) {
  if (!node || typeof node !== "object") return;
  fn(node, path);
  const kids = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < kids.length; i++) walk(kids[i], fn, (path ? path + " > " : "") + (kids[i].name || kids[i].type || i));
}

function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}

const firstSolid = (fills) => (fills || []).find((f) => f && f.type === "solid" && f.visible !== false);

function expectNode(n, path) {
  const spec = { nodeId: n.id, name: n.name, type: n.type, path };
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
  if (fill && n.type !== "TEXT") spec.backgroundColor = normColor(fill.color);
  if (fill && n.type === "TEXT" && !spec.color) spec.color = normColor(fill.color);

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
  if (typeof n.radius === "number") spec.borderRadius = n.radius;
  else if (n.radius && typeof n.radius === "object" && typeof n.radius.tl === "number") {
    spec.borderRadius = n.radius.tl;
    spec.radiusCorners = n.radius;
  }
  const L = n.layout;
  if (L && typeof L === "object") {
    if (typeof L.gap === "number") spec.gap = L.gap;
    else if (typeof L.itemSpacing === "number") spec.gap = L.itemSpacing;
    const pad = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => L[k]);
    if (pad.some((v) => typeof v === "number")) spec.padding = pad.map((v) => (typeof v === "number" ? v : 0));
  }
  if (n.box) {
    if (typeof n.box.w === "number") spec.width = n.box.w;
    if (typeof n.box.h === "number") spec.height = n.box.h;
  }
  if (typeof n.opacity === "number" && n.opacity !== 1) spec.opacity = n.opacity;
  // The token NAME, carried through for the report. A mismatch whose spec value is bound to a token is
  // a token bug, not a number bug, and that distinction is what tells a reader where to look.
  if (n.tokens && Object.keys(n.tokens).length) spec.tokens = n.tokens;
  return spec;
}

// Which nodes are worth a row. Everything visible that CARRIES a checkable value — a node with no
// font, no fill, no radius and no layout has nothing to be wrong about, and listing it would bury the
// rows that matter.
function checkable(spec) {
  return ["text", "fontSize", "color", "backgroundColor", "borderRadius", "gap", "padding", "borderColor"].some((k) => spec[k] !== undefined);
}

function buildExpectation(docs) {
  const nodes = [];
  const instances = [];
  const interactions = [];
  const seen = new Set();
  let screen = null, exportedAt = null, reference = null;

  for (const { doc, label } of docs) {
    if (!screen) screen = (doc && doc.screen) || label;
    if (!exportedAt) exportedAt = doc && doc.exportedAt;
    for (const root of rootsOf(doc)) {
      if (!reference && root.reference) reference = root.reference;
      walk(root, (n, path) => {
        if (n.visible === false) return;
        if (n.id && seen.has(n.id)) return;
        if (n.id) seen.add(n.id);
        const spec = expectNode(n, path);
        if (checkable(spec)) nodes.push(spec);

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
        // whole IR (finding 70) and the one nothing verified (finding 80). Emitting it as expectations
        // is what turns "the button is the right colour" into "the button does what it is for".
        // The real shape is `reactions[].actions[]` (plural on both), with `trigger` a plain string
        // — see figma-plugin/src/prototype.ts. A singular `action` is accepted too so an older export
        // still yields interactions rather than silently producing none, which is how an earlier
        // version reported "0 designed interactions" on a file full of them.
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
      }, root.name || root.type || "root");
    }
  }

  return {
    schema: "designtwin/verify-expectation@1",
    screen,
    exportedAt,
    reference,
    note:
      "Generated from the export — do NOT retype these numbers into code comments. Every row is the " +
      "value the design states; a field the export does not define is absent rather than defaulted. " +
      "Feed this to a renderer probe and compare with `verify-screen.js --compare`.",
    tolerance: TOLERANCE,
    counts: { nodes: nodes.length, instances: instances.length, interactions: interactions.length },
    nodes,
    instances,
    interactions,
  };
}

// ---------------------------------------------------------------- the comparison
const FIELDS = [
  { key: "fontFamily", tol: null, norm: normFamily, label: "font-family" },
  { key: "fontSize", tol: TOLERANCE.fontSize, label: "font-size", unit: "px" },
  { key: "fontWeight", tol: TOLERANCE.fontWeight, norm: normWeight, label: "font-weight" },
  { key: "lineHeight", tol: TOLERANCE.lineHeight, label: "line-height", unit: "px" },
  { key: "letterSpacing", tol: TOLERANCE.letterSpacing, label: "letter-spacing", unit: "px" },
  { key: "color", tol: null, norm: normColor, label: "color" },
  { key: "backgroundColor", tol: null, norm: normColor, label: "background" },
  { key: "borderColor", tol: null, norm: normColor, label: "border-color" },
  { key: "borderWidth", tol: TOLERANCE.padding, label: "border-width", unit: "px" },
  { key: "borderRadius", tol: TOLERANCE.radius, label: "border-radius", unit: "px" },
  { key: "gap", tol: TOLERANCE.gap, label: "gap", unit: "px" },
  { key: "width", tol: TOLERANCE.size, label: "width", unit: "px" },
  { key: "height", tol: TOLERANCE.size, label: "height", unit: "px" },
  { key: "opacity", tol: TOLERANCE.opacity, label: "opacity" },
];

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

function compare(expectation, measured) {
  const byId = new Map();
  for (const m of (measured && measured.nodes) || []) if (m && m.nodeId) byId.set(String(m.nodeId), m);

  const deltas = [];
  const notMeasured = [];
  let fieldsChecked = 0, nodesMeasured = 0;

  for (const spec of expectation.nodes || []) {
    const m = byId.get(String(spec.nodeId));
    if (!m) {
      notMeasured.push({ nodeId: spec.nodeId, name: spec.name, path: spec.path, why: "no measurement for this node id" });
      continue;
    }
    nodesMeasured++;
    const got = m.styles || m;
    for (const f of FIELDS) {
      if (spec[f.key] === undefined) continue;
      if (got[f.key] === undefined) {
        notMeasured.push({ nodeId: spec.nodeId, name: spec.name, field: f.label, why: "the probe did not report this property" });
        continue;
      }
      fieldsChecked++;
      const bad = compareField(f, spec[f.key], got[f.key]);
      if (bad) {
        deltas.push({
          severity: f.key === "fontSize" || f.key === "fontWeight" || f.key === "color" || f.key === "backgroundColor" ? "high" : "medium",
          nodeId: spec.nodeId, name: spec.name, path: spec.path, field: f.label,
          expected: bad.want, actual: bad.got, delta: bad.delta, unit: f.unit,
          token: spec.tokens ? Object.values(spec.tokens)[0] : undefined,
        });
      }
    }
    if (spec.padding !== undefined && got.padding !== undefined) {
      fieldsChecked++;
      const bad = comparePadding(spec.padding, got.padding);
      if (bad) deltas.push({ severity: "medium", nodeId: spec.nodeId, name: spec.name, path: spec.path, field: "padding", expected: bad.want, actual: bad.got, delta: bad.delta, unit: "px" });
    }
    if (spec.text !== undefined && got.text !== undefined) {
      fieldsChecked++;
      // Compare the literal characters. Figma's text-transform renders "NO. Of" from a stored "NO. of"
      // — so the STORED string is the truth and a case-only difference the CSS explains is not a bug
      // (the live verifier got this right by hand; encoding it keeps that judgement).
      const w = String(spec.text).replace(/ /g, " ").trim();
      const g = String(got.text).replace(/ /g, " ").trim();
      if (w !== g) {
        const caseOnly = w.toLowerCase() === g.toLowerCase();
        deltas.push({
          severity: caseOnly ? "low" : "high",
          nodeId: spec.nodeId, name: spec.name, path: spec.path, field: "text",
          expected: spec.text, actual: got.text,
          note: caseOnly ? "differs only in case — check for a text-transform, which Figma applies at render time while storing the original" : undefined,
        });
      }
      if (/\u00a0/.test(String(spec.text))) {
        // Show the escape, not the character. Printed raw, this row reads as two identical strings
        // flagged as a mismatch, which is worse than not reporting it — the whole point is that the
        // difference is INVISIBLE.
        const show = (t) => String(t).replace(/\u00a0/g, "\\u00a0");
        deltas.push({
          severity: "low", nodeId: spec.nodeId, name: spec.name, field: "text (invisible character)",
          expected: show(spec.text), actual: show(got.text),
          note: "the designed string contains a non-breaking space (U+00A0) — a Figma auto-substitution. Carrying it into the DOM verbatim is usually not what anyone meant; decide deliberately.",
        });
      }
    }
  }

  // ---- component coverage: every instance on the frame needs a counterpart in the build
  const built = new Set(((measured && measured.components) || []).map((c) => String(c.setName || c.name || c)));
  const builtNodes = new Set(((measured && measured.components) || []).map((c) => String(c.nodeId)).filter(Boolean));
  const missingComponents = [];
  const bySet = new Map();
  for (const i of expectation.instances || []) {
    const k = i.setName || i.name;
    if (!bySet.has(k)) bySet.set(k, { setName: k, setKey: i.setKey, nodeIds: [], instances: 0 });
    bySet.get(k).instances++;
    bySet.get(k).nodeIds.push(i.nodeId);
  }
  for (const [k, v] of bySet) {
    if (built.has(k)) continue;
    if (v.nodeIds.some((id) => builtNodes.has(String(id)))) continue;
    missingComponents.push(v);
  }

  // ---- interactions: the export says what each control does; did it?
  const exercised = new Map();
  for (const r of (measured && measured.interactions) || []) exercised.set(String(r.nodeId) + "|" + (r.trigger || "on_click"), r);
  const interactions = (expectation.interactions || []).map((i) => {
    const hit = exercised.get(String(i.nodeId) + "|" + i.trigger) || exercised.get(String(i.nodeId) + "|on_click");
    return {
      nodeId: i.nodeId, name: i.name, trigger: i.trigger, action: i.action, destinationId: i.destinationId,
      result: !hit ? "not-tested" : hit.ok ? "pass" : "fail",
      detail: hit && hit.detail,
    };
  });
  const interactionsFailed = interactions.filter((i) => i.result === "fail");
  const interactionsUntested = interactions.filter((i) => i.result === "not-tested");

  const high = deltas.filter((d) => d.severity === "high").length;
  const medium = deltas.filter((d) => d.severity === "medium").length;

  // The verdict is COMPUTED. Nothing in this pipeline is allowed to assert "pass" in prose — that is
  // what produced a "verified" plan over a build with two missing components (finding 102).
  const reasons = [];
  if (high) reasons.push(`${high} high-severity value mismatch(es)`);
  if (medium) reasons.push(`${medium} medium-severity value mismatch(es)`);
  if (missingComponents.length) reasons.push(`${missingComponents.length} component(s) on the frame were never built`);
  if (interactionsFailed.length) reasons.push(`${interactionsFailed.length} designed interaction(s) failed`);
  if (interactionsUntested.length) reasons.push(`${interactionsUntested.length} designed interaction(s) were never exercised`);
  if (notMeasured.length) reasons.push(`${notMeasured.length} expectation(s) could not be measured at all`);

  const verdict = reasons.length === 0 ? "pass" : high || missingComponents.length || interactionsFailed.length ? "fail" : "incomplete";

  return {
    schema: "designtwin/verify-report@1",
    screen: expectation.screen,
    exportedAt: expectation.exportedAt,
    measuredAt: (measured && measured.measuredAt) || new Date().toISOString(),
    renderer: (measured && measured.renderer) || "unknown",
    viewport: measured && measured.viewport,
    artifacts: (measured && measured.artifacts) || [],
    verdict,
    why: reasons,
    coverage: {
      nodesExpected: (expectation.nodes || []).length,
      nodesMeasured,
      fieldsChecked,
      instanceSets: bySet.size,
      componentsBuilt: bySet.size - missingComponents.length,
      interactionsExpected: interactions.length,
      interactionsPassed: interactions.filter((i) => i.result === "pass").length,
    },
    summary: { high, medium, low: deltas.filter((d) => d.severity === "low").length, missingComponents: missingComponents.length },
    deltas: deltas.sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity]),
    missingComponents,
    interactions,
    notMeasured,
  };
}

function reportToMarkdown(r) {
  const L = [];
  const mark = r.verdict === "pass" ? "PASS" : r.verdict === "fail" ? "FAIL" : "INCOMPLETE";
  L.push(`# Verify — ${r.screen}`, "");
  L.push(`**${mark}** · renderer ${r.renderer}${r.viewport ? ` at ${r.viewport}` : ""} · measured ${r.measuredAt}`, "");
  if (r.why.length) {
    L.push("Why this is not a pass:", "");
    for (const w of r.why) L.push(`- ${w}`);
    L.push("");
  }
  const c = r.coverage;
  L.push("## What was actually checked", "");
  L.push("| | |", "|---|---|");
  L.push(`| node specs measured | ${c.nodesMeasured} / ${c.nodesExpected} |`);
  L.push(`| individual values compared | ${c.fieldsChecked} |`);
  L.push(`| components on the frame that exist in the build | ${c.componentsBuilt} / ${c.instanceSets} |`);
  L.push(`| designed interactions exercised and passing | ${c.interactionsPassed} / ${c.interactionsExpected} |`, "");
  if (r.deltas.length) {
    L.push(`## Value mismatches (${r.deltas.length})`, "", "| Severity | Node | Field | Expected | Actual | Token |", "|---|---|---|---|---|---|");
    for (const d of r.deltas) {
      L.push(`| ${d.severity} | ${d.name || ""} \`${d.nodeId}\` | ${d.field} | ${fmt(d.expected)}${d.unit || ""} | ${fmt(d.actual)}${d.unit || ""} | ${d.token || "—"} |`);
    }
    L.push("");
  }
  if (r.missingComponents.length) {
    L.push(`## Components on the frame with no counterpart in the build (${r.missingComponents.length})`, "");
    for (const m of r.missingComponents) L.push(`- **${m.setName}** — ${m.instances} instance(s), e.g. \`${m.nodeIds[0]}\``);
    L.push("");
  }
  const bad = r.interactions.filter((i) => i.result !== "pass");
  if (bad.length) {
    L.push(`## Designed interactions not confirmed (${bad.length})`, "");
    for (const i of bad) L.push(`- \`${i.nodeId}\` ${i.name || ""} — ${i.trigger} → ${i.action}${i.destinationId ? ` (${i.destinationId})` : ""}: **${i.result}**${i.detail ? ` — ${i.detail}` : ""}`);
    L.push("");
  }
  if (r.notMeasured.length) {
    L.push(`## Not measured (${r.notMeasured.length})`, "", "*Gaps in the probe, not clean results.*", "");
    for (const n of r.notMeasured.slice(0, 40)) L.push(`- \`${n.nodeId}\` ${n.name || ""}${n.field ? ` (${n.field})` : ""} — ${n.why}`);
    if (r.notMeasured.length > 40) L.push(`- …and ${r.notMeasured.length - 40} more`);
    L.push("");
  }
  return L.join("\n") + "\n";
}
const fmt = (v) => (Array.isArray(v) ? v.join("/") : String(v));

module.exports = { buildExpectation, compare, reportToMarkdown, expectNode, normColor, normWeight, normFamily, lineHeightPx, TOLERANCE };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const { readJsonFile } = require("./catalog-input.js");
  const argv = process.argv.slice(2);
  const take = (flag) => { const i = argv.indexOf(flag); if (i === -1) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const strip = (flag) => { const i = argv.indexOf(flag); if (i === -1) return false; argv.splice(i, 1); return true; };
  const USAGE =
    "usage:\n" +
    "  node design-to-code/verify-screen.js --expect <screen.json>... --out design/verify/<Screen>\n" +
    "      writes <Screen>.expected.json — the design's own numbers, as data. Read them; never retype them.\n" +
    "  node design-to-code/verify-screen.js --compare <Screen>.expected.json <measured.json> --out design/verify/<Screen>\n" +
    "      writes <Screen>.report.json + .md and exits 1 unless the verdict is 'pass'.";
  if (argv.includes("--help") || argv.includes("-h") || !argv.length) { console.log(USAGE); process.exit(argv.length ? 0 : 2); }

  const out = take("--out");
  const doExpect = strip("--expect");
  const doCompare = strip("--compare");
  if (doExpect === doCompare) { console.error("pass exactly one of --expect / --compare\n" + USAGE); process.exit(2); }
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
    write(out, exp);
    console.error(`${exp.counts.nodes} node spec(s), ${exp.counts.instances} instance(s), ${exp.counts.interactions} designed interaction(s)`);
    if (!exp.counts.interactions) console.error("note  this export declares no `reactions` — interaction coverage cannot be checked, and the report will say so rather than passing.");
    process.exit(0);
  }

  const [expFile, measuredFile] = argv;
  if (!expFile || !measuredFile) { console.error("--compare needs <expected.json> <measured.json>\n" + USAGE); process.exit(2); }
  const expectation = readJsonFile(expFile, "expectation");
  const measured = readJsonFile(measuredFile, "probe measurements",
    "Render the built screen and write {measuredAt, renderer, viewport, artifacts, nodes:[{nodeId,styles}], components:[], interactions:[]}.");
  const rep = compare(expectation, measured);
  const md = reportToMarkdown(rep);
  write(out, rep, md);
  if (!out) process.stdout.write(md);
  console.error(`${rep.verdict.toUpperCase()} — ${rep.summary.high} high, ${rep.summary.medium} medium, ${rep.summary.missingComponents} component(s) missing, ` +
    `${rep.coverage.interactionsPassed}/${rep.coverage.interactionsExpected} interactions confirmed`);
  process.exit(rep.verdict === "pass" ? 0 : 1);
}
