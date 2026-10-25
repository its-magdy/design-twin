// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/audit.ts
import fs13 from "node:fs";
import path11 from "node:path";

// bridge/src/hex-color.ts
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
function clampOpacityPct(n) {
  return Math.min(100, Math.max(0, n));
}
function composeAlpha(alpha, opacityPct) {
  return alpha * (clampOpacityPct(opacityPct) / 100);
}
function compositeOver(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  };
}
function luminance(c) {
  const ch = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// design-to-code/visible-tree.ts
var hiddenSelf = (node) => !!(node && typeof node === "object" && "hidden" in node && node.hidden);
var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
var WHITE = { r: 255, g: 255, b: 255, a: 1 };
var NOTHING = { color: null, complex: false, token: null };
var paintToken = (p) => {
  const t = p.tokens && p.tokens.color;
  const s = Array.isArray(t) ? t[0] : t;
  return typeof s === "string" && s ? s : null;
};
function paintOver(base, n) {
  if (n.type === "TEXT") return base;
  const fills = (Array.isArray(n.fills) ? n.fills : []).filter(Boolean);
  const nodeTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills ? n.tokens.fills : null;
  if (!fills.length) return nodeTok ? { ...base, token: nodeTok } : base;
  let { color, complex, token } = base;
  for (const f of fills) {
    if (f.opacity === 0 || f.visible === false) continue;
    if (f.type !== "solid") {
      complex = true;
      token = null;
      continue;
    }
    const c = parseHex(f.color);
    const tok = paintToken(f) ?? (fills.length === 1 ? nodeTok : null);
    if (!c) {
      token = tok;
      continue;
    }
    if (c.a <= 0) continue;
    color = color ? compositeOver(c, color) : c.a >= 1 ? c : compositeOver(c, WHITE);
    if (c.a >= 1) {
      complex = false;
      token = tok;
    } else token = null;
  }
  return { color, complex, token };
}
function paintedOver(under, layers, tokenColor) {
  let color = under, complex = false, painted = false;
  for (const n of layers) {
    if (n.type === "TEXT") continue;
    const fills = (Array.isArray(n.fills) ? n.fills : []).filter(Boolean);
    const nodeTok = n.tokens && typeof n.tokens.fills === "string" && n.tokens.fills ? n.tokens.fills : null;
    const lt = !fills.length && nodeTok && tokenColor ? tokenColor(nodeTok) : null;
    if (lt && lt.a > 0) {
      color = compositeOver(lt, color);
      painted = true;
      if (lt.a >= 1) complex = false;
    }
    for (const f of fills) {
      if (f.opacity === 0 || f.visible === false) continue;
      if (f.type !== "solid") {
        complex = true;
        painted = true;
        continue;
      }
      const c = parseHex(f.color);
      if (!c || c.a <= 0) continue;
      color = compositeOver(c, color);
      painted = true;
      if (c.a >= 1) complex = false;
    }
  }
  return painted ? { color, complex } : null;
}
var INK_TYPES = /* @__PURE__ */ new Set(["VECTOR", "BOOLEAN_OPERATION", "LINE", "FRAME", "INSTANCE", "GROUP", "COMPONENT"]);
function isIconInk(n) {
  if (!(n.asset || n.geometry || n.assetSkipped) || !INK_TYPES.has(String(n.type))) return false;
  return !(Array.isArray(n.fills) && n.fills.some((f) => f.type === "image" || f.type === "gradient"));
}
function overlaps(a, b) {
  if (!a || !b || typeof a.x !== "number" || typeof a.y !== "number" || typeof b.x !== "number" || typeof b.y !== "number") return true;
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
var paintsSurface = (n) => !hiddenSelf(n) && n.type !== "TEXT" && !isIconInk(n) && Array.isArray(n.fills) && n.fills.length > 0;
function beneathOf(parent, kids, i) {
  const child = kids[i];
  if (!child) return [];
  const stacks = !parent.layout || parent.layout.mode === "absolute";
  if (!stacks && !child.absolute) return [];
  return kids.slice(0, i).filter((s) => s && typeof s === "object" && paintsSurface(s) && overlaps(s.box, child.box));
}
function memo(fn) {
  let cell = null;
  return () => (cell ??= { v: fn() }).v;
}
function walk(root, fn, prune, opts) {
  const pathOf = opts && opts.pathOf || ((n, i) => n.name || n.type || String(i));
  (function go(node, parentHidden, path12, ancestors, under, beneath) {
    if (!node || typeof node !== "object") return;
    const hidden = isHidden(node, parentHidden);
    if (hidden && prune) return;
    const backdrop = memo(() => beneath().reduce(paintOver, under()));
    const parentFrame = ancestors[ancestors.length - 1];
    const frame = { node, hidden, get backdrop() {
      return backdrop();
    }, get beneath() {
      return beneath();
    } };
    fn(node, {
      hidden,
      parentHidden: !!parentHidden,
      path: path12,
      parent: parentFrame ? parentFrame.node : null,
      depth: ancestors.length,
      ancestors,
      get backdrop() {
        return backdrop();
      },
      get beneath() {
        return beneath();
      }
    });
    const kids = Array.isArray(node.children) ? node.children : [];
    if (!kids.length) return;
    const inside2 = memo(() => paintOver(backdrop(), node));
    const chain = [...ancestors, frame];
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path12 ? path12 + " > " : "") + pathOf(kid, i), chain, inside2, memo(() => beneathOf(node, kids, i)));
  })(root, false, root ? pathOf(root, 0) : "", [], () => NOTHING, () => []);
}
function walkWithHidden(root, fn, opts) {
  walk(root, fn, false, opts);
}
function walkVisible(root, fn, opts) {
  walk(root, fn, true, opts);
}

// design-to-code/types.ts
var PLAN_VERIFICATION_RECORD_SCHEMA = "designtwin/plan-verification-record@2";
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
function screenRoots(doc) {
  if (isScreenExport(doc)) return doc.nodes;
  if (isLayerFile(doc)) return [doc.tree];
  if (isIrNode(doc)) return [doc];
  return [];
}
function screenExportOf(doc) {
  return isScreenExport(doc) ? doc : null;
}

// bridge/src/json-util.ts
function nullProto() {
  return /* @__PURE__ */ Object.create(null);
}
function isRecord(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isStringArray(x) {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}
function ifDefined(key, v) {
  const o = {};
  if (v !== void 0) o[key] = v;
  return o;
}

// design-to-code/map-util.ts
var alnumKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function getOrInit(m, k, init) {
  const have = m.get(k);
  if (have !== void 0) return have;
  const made = init();
  m.set(k, made);
  return made;
}

// design-to-code/component-match.ts
function visibleInstances(doc, label) {
  const out = [];
  const visit2 = (n) => {
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent;
      out.push({
        screen: label,
        nodeId: n.id,
        layer: n.name,
        name: mc.setName || mc.name || n.name,
        ...ifDefined("key", mc.key),
        ...ifDefined("setKey", mc.setKey),
        remote: mc.remote === true,
        variant: parseVariant(n.component) || parseVariant(mc.variant),
        props: n.props && typeof n.props === "object" ? n.props : {}
      });
    }
  };
  for (const r of screenRoots(doc)) walkVisible(r, visit2);
  return out;
}
function parseVariant(s) {
  if (isJsonObject(s)) {
    const out2 = Object.fromEntries(Object.entries(s).filter((e) => typeof e[1] === "string"));
    return Object.keys(out2).length ? out2 : null;
  }
  if (!s || typeof s !== "string" || !s.includes("=")) return null;
  const out = {};
  for (const part of s.split(/,\s*(?=[^,=]+=)/)) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}
var baseProp = (p) => String(p).split("#")[0] ?? "";
var SHARED_PAGE = /shared|style ?guide|foundation|core|global|design.?system|librar|banner|badge/i;
function signature(inst, cand) {
  const props = {};
  for (const [k, v] of Object.entries(cand.props || {})) props[baseProp(k)] = v;
  const reasons = [];
  let score = 40, verified = true;
  reasons.push("name matches catalog entry verbatim");
  const variant = inst.variant;
  if (variant) {
    const axes = Object.keys(variant);
    const known = axes.filter((k) => props[k] && props[k].type === "VARIANT");
    if (known.length === axes.length) {
      score += 25;
      reasons.push(`all ${axes.length} variant prop name(s) exist as VARIANT props`);
    } else {
      verified = false;
      score += known.length ? 10 : -15;
      reasons.push(known.length ? `${known.length}/${axes.length} variant prop names exist` : "variant prop names are NOT on this candidate");
    }
    const bad = Object.entries(variant).filter(([k, val]) => {
      const d = props[k];
      return d && d.type === "VARIANT" && !(d.options || []).includes(val);
    }).map(([k]) => k);
    if (known.length && !bad.length) {
      score += 25;
      reasons.push(`variant value(s) ${known.map((k) => `${k}=${variant[k]}`).join(", ")} are in the option list`);
    } else if (bad.length) {
      verified = false;
      score -= 20;
      reasons.push(`variant value(s) not in option list (${bad.map((k) => `${k}=${variant[k]}`).join(", ")})`);
    }
  } else if (cand.type === "COMPONENT") {
    score += 15;
    reasons.push("instance has no variant string and the catalog entry is a plain COMPONENT");
  } else {
    verified = false;
    reasons.push(`instance sets no variant but the catalog entry is a ${cand.type}`);
  }
  const own = Object.keys(inst.props || {}).filter((k) => !variant || !(baseProp(k) in variant));
  if (own.length) {
    const typed = own.filter((k) => {
      const d = props[baseProp(k)], v = inst.props[k];
      if (!d) return false;
      if (typeof v === "boolean") return d.type === "BOOLEAN";
      return d.type === "TEXT" || d.type === "INSTANCE_SWAP" || d.type === "VARIANT";
    });
    if (typed.length === own.length) {
      score += 15;
      reasons.push(`all ${own.length} non-variant prop name(s) exist on the definition`);
    } else {
      verified = false;
      score += typed.length ? 5 : -10;
      reasons.push(typed.length ? `${typed.length}/${own.length} non-variant prop names exist with a matching type` : "none of the instance prop names exist on this definition");
    }
  }
  if (SHARED_PAGE.test(String(cand.page || ""))) {
    score += 5;
    reasons.push(`lives on a shared page (${cand.page})`);
  }
  return { verified, score, reasons };
}
var sigOf = (c) => JSON.stringify(Object.entries(c.props || {}).map(([k, v]) => [baseProp(k), v.type, v.options || null]).sort());
function matchByNameAndSignature(instances, catalog, library) {
  const comps = catalog && catalog.components || [];
  const byName = /* @__PURE__ */ new Map();
  comps.forEach((c, i) => {
    getOrInit(byName, c.name, () => []).push(Object.assign({ _order: i }, c));
  });
  const catKeys = new Set(comps.map((c) => c.key).filter((k) => !!k));
  const libKeys = new Set((library && library.components || []).map((c) => c.key).filter((k) => !!k));
  const libNames = new Set((library && library.components || []).map((c) => c.name));
  const groups = /* @__PURE__ */ new Map();
  for (const inst of instances) {
    const group = groups.get(inst.name);
    if (group) group.push(inst);
    else groups.set(inst.name, [inst]);
  }
  const rows = [];
  for (const [name, list] of groups) {
    const byKey = list.some((i) => catKeys.has(i.key ?? "") || catKeys.has(i.setKey ?? ""));
    const row = {
      name,
      instances: list.length,
      nodeIds: list.map((i) => i.nodeId),
      screens: [...new Set(list.map((i) => i.screen).filter((s) => !!s))],
      instanceKeys: [...new Set(list.map((i) => i.setKey || i.key).filter((k) => !!k))],
      remote: list.every((i) => i.remote),
      byKey,
      match: null,
      alternatives: [],
      reasons: []
    };
    const cands = byName.get(name) || [];
    if (!cands.length) {
      const inLibrary = list.some((i) => libKeys.has(i.key ?? "") || libKeys.has(i.setKey ?? ""));
      row.reasons.push(`no catalog entry named ${JSON.stringify(name)}`);
      row.reasons.push(inLibrary ? "its key IS in components.library.json \u2014 a third-party library both files consume, not the design system's own component" : libNames.has(name) ? "the name appears in components.library.json \u2014 a third-party library the design system consumes, not one of its own components" : "not a component of the exported design system (typically an external icon library) \u2014 expected, not a miss");
      rows.push(row);
      continue;
    }
    if (cands.length > 1) row.candidates = cands.map((c) => ({ ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name }));
    const [firstInst, ...otherInsts] = list;
    const scored = cands.map((c) => {
      const first = signature(firstInst, c);
      const per = [first, ...otherInsts.map((i) => signature(i, c))];
      return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: first.reasons, failing: per.find((p) => !p.verified) };
    }).sort((a, b) => Number(b.verified) - Number(a.verified) || b.score - a.score || a.c._order - b.c._order);
    const best = scored[0];
    if (best === void 0) throw new Error("component-match: a non-empty candidate list scored to nothing");
    if (!best.verified) {
      row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` + (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") + " \u2014 a name alone is not a match");
      rows.push(row);
      continue;
    }
    const verifiedOnes = scored.filter((s) => s.verified);
    const runnerUp = verifiedOnes[1];
    const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
    row.match = { ...ifDefined("id", best.c.id), ...ifDefined("key", best.c.key), name: best.c.name, type: best.c.type, ...ifDefined("page", best.c.page) };
    row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
    row.reasons = best.reasons.slice();
    if (ties.length) {
      const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
      row.reasons.push(identical ? `${ties.length + 1} catalog entries named "${name}" score identically \u2014 they are duplicates of one definition (same props, same variants); the first in the catalog is used` : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures \u2014 the first in the catalog is used; confirm which one`);
      row.tie = identical ? "duplicate-definitions" : "different-signatures";
    } else if (scored.length > 1) {
      row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${runnerUp ? ` by ${best.score - runnerUp.score} pts` : " (their prop signatures do not agree)"}`);
    }
    row.alternatives = verifiedOnes.filter((s) => s !== best).map((s) => ({ ...ifDefined("id", s.c.id), ...ifDefined("key", s.c.key), ...ifDefined("page", s.c.page), score: s.score }));
    row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog \u2014 re-keyed)"));
    rows.push(row);
  }
  const proposals = rows.filter((r) => !!r.match && !r.byKey);
  return {
    rows,
    proposals,
    summary: {
      instances: instances.length,
      names: rows.length,
      byKey: rows.filter((r) => r.byKey).length,
      proposed: proposals.length,
      proposedWithSignature: proposals.filter((r) => r.evidence === "name+signature").length,
      withCandidates: rows.filter((r) => (byName.get(r.name) || []).length).length,
      unmatched: rows.filter((r) => !r.match).length,
      remote: instances.filter((i) => i.remote).length
    }
  };
}
function nameVerdict(row) {
  if (row.match && row.tie === "different-signatures") {
    return { status: "ambiguous", reason: `several catalog entries named ${JSON.stringify(row.name)} agree with the instance equally but have DIFFERENT signatures \u2014 confirm which one` };
  }
  if (row.match) return { status: "matched", reason: `name + ${row.evidence === "name+no-props" ? "no props to check (a plain component)" : "prop signature"}${row.tie === "duplicate-definitions" ? "; same-named duplicates of one definition" : ""}` };
  const n = (row.candidates || []).length;
  if (n > 1) return { status: "ambiguous", reason: `${n} catalog entries are named ${JSON.stringify(row.name)} and none agrees with the instance's prop signature \u2014 confirm which one, if any` };
  const why = (row.reasons || []).find((r) => /no catalog entry named|no prop signature agrees/.test(r));
  return { status: "unmatched", reason: why || `no catalog entry named ${JSON.stringify(row.name)} agrees with the instance` };
}
var REKEY_MIN_PROPOSALS = 3;
var REKEY_MIN_SHARE = 0.5;
function isRekeyed(result) {
  const s = result.summary;
  return s.names > 0 && s.byKey / s.names <= 0.05 && s.proposedWithSignature >= REKEY_MIN_PROPOSALS && s.withCandidates > 0 && s.proposedWithSignature / s.withCandidates >= REKEY_MIN_SHARE;
}

// design-to-code/finding-id.ts
function findingIds(findings) {
  const seen = /* @__PURE__ */ new Map();
  return findings.map((f) => {
    const base = f.nodeId ? `${f.code}@${f.nodeId}` : f.code;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

// design-to-code/screen-inputs.ts
import fs7 from "node:fs";
import path6 from "node:path";

// bridge/src/project-layout.ts
import fs from "node:fs";
import path from "node:path";
var DESIGN_DIR = "design";
var EXPORT_SUBDIR = "export";
var EXPORT_DIR = path.join(DESIGN_DIR, EXPORT_SUBDIR);
var TARGET_FILE = path.join(DESIGN_DIR, "target.json");
var MAP_FILE = path.join(DESIGN_DIR, "codeconnect.local.json");
var LEGACY_MAP_FILE = "codeconnect.local.json";
var PLAN_DIR = path.join(DESIGN_DIR, "plan");
var AUDIT_DIR = path.join(DESIGN_DIR, "audit");
var VERIFY_DIR = path.join(DESIGN_DIR, "verify");
var SNAPSHOT_DIR = path.join(DESIGN_DIR, ".sync");
var MERGED_VARIABLES_FILE = "variables.json";
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var slashed = (p) => p.split(path.sep).join("/");
var VERIFY_GITIGNORE_NOTE = `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;
var EXPORT_MARKERS = ["pages", "design-system", "design-system.json", MERGED_VARIABLES_FILE, "assets", "libraries"];
function looksLikeExportDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return EXPORT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
}
function findExportDir(cwd) {
  const modern = path.join(cwd, EXPORT_DIR);
  const legacy2 = path.join(cwd, DESIGN_DIR);
  const modernExists = looksLikeExportDir(modern);
  const legacyExists = looksLikeExportDir(legacy2);
  if (modernExists) return { dir: modern, layout: "export-subdir", rel: EXPORT_DIR, parallelLegacy: legacyExists };
  if (legacyExists) return { dir: legacy2, layout: "legacy-flat", rel: DESIGN_DIR };
  return { dir: modern, layout: "none", rel: EXPORT_DIR };
}
function findMapFile(cwd) {
  const modern = path.join(cwd, MAP_FILE);
  if (fs.existsSync(modern)) return { file: modern, rel: MAP_FILE, legacy: false };
  const legacy2 = path.join(cwd, LEGACY_MAP_FILE);
  if (fs.existsSync(legacy2)) return { file: legacy2, rel: LEGACY_MAP_FILE, legacy: true };
  return { file: modern, rel: MAP_FILE, legacy: false, missing: true };
}
function listPlans(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

// bridge/src/pages-layout.ts
function safe(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, "_");
}
var SAFE_NODE_ID_RE = /^(?:\d+_\d+|I\d+_\d+(?:_\d+_\d+)+)$/;
function nodeIdFromSafe(safeId) {
  if (!SAFE_NODE_ID_RE.test(safeId)) return null;
  return safeId.replace(/(\d+)_(\d+)/g, "$1:$2").replace(/_/g, ";");
}
function nodeIdFromStem(stem) {
  const s = String(stem || "");
  const i = s.lastIndexOf("__");
  return i < 0 ? null : nodeIdFromSafe(s.slice(i + 2));
}
function screenStem(name, id) {
  return safe(name || "layer") + "__" + safe(id);
}
var isObjectLike = (x) => !!x && typeof x === "object";
var samePage = (l, entry) => !!entry.pageId && l.pageId === entry.pageId && (l.page ?? null) === (entry.page ?? null);
var sameFigmaFile = (l, entry) => {
  if (l.sourceFile && entry.sourceFile) {
    return l.sourceFileKey && entry.sourceFileKey ? l.sourceFileKey === entry.sourceFileKey : l.sourceFile === entry.sourceFile;
  }
  if (entry.sourceFile) return !!entry.pageId && l.pageId === entry.pageId;
  return samePage(l, entry);
};
var notSameRow = (entry) => (l) => {
  if (!isObjectLike(l)) return !!l;
  if (l.file === entry.file) return false;
  if (l.id !== entry.id) return true;
  return !sameFigmaFile(l, entry);
};
var sameScreenRow = (older, newer) => isObjectLike(older) && !notSameRow(newer)(older);

// bridge/src/design-system-layout.ts
var DIR = "design-system";
var COMPONENTS_DIR = "components";
var TOKENS = "tokens.json";
var COMPONENTS_LOCAL = "components.local.json";
var COMPONENTS_LIBRARY = "components.library.json";
var HYGIENE = "hygiene.json";
var MANIFEST = "design-system.json";
var STYLE_KIND_ROWS = {
  paint: { kind: "paint", file: "styles.paint.json", key: "stylesPaint" },
  text: { kind: "text", file: "styles.text.json", key: "stylesText" },
  effect: { kind: "effect", file: "styles.effect.json", key: "stylesEffect" },
  grid: { kind: "grid", file: "styles.grid.json", key: "stylesGrid" },
  animation: { kind: "animation", file: "styles.animation.json", key: "stylesAnimation" }
  // local custom animation styles
};
var STYLE_KINDS = Object.values(STYLE_KIND_ROWS);
var DESIGN_SYSTEM_DIR = DIR;
var DESIGN_SYSTEM_FILES = { TOKENS, COMPONENTS_LOCAL, COMPONENTS_LIBRARY, COMPONENTS_DIR, HYGIENE, MANIFEST };
var DESIGN_SYSTEM_FILE_NAMES = [TOKENS, ...STYLE_KINDS.map((row) => row.file), COMPONENTS_LOCAL, COMPONENTS_LIBRARY, HYGIENE, MANIFEST];

// design-to-code/catalog-input.ts
import fs3 from "node:fs";

// bridge/src/read-json.ts
import fs2 from "node:fs";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);
var errCode = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;

// bridge/src/read-json.ts
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
    buf = fs2.readFileSync(file);
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
  const settle = () => {
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
        settle();
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
var pause = new Int32Array(new SharedArrayBuffer(4));

// design-to-code/catalog-input.ts
function isManifest(doc, payloadKey) {
  return isJsonObject(doc) && isJsonObject(doc.files) && !Array.isArray(doc[payloadKey]);
}
function assertNotManifest(doc, givenPath, payloadKey, wantFile) {
  if (isManifest(doc, payloadKey)) {
    console.error(
      `error  '${givenPath}' is the design-system MANIFEST (a pointer map), not the '${payloadKey}' catalog.
       Since the design-system split it carries only a stamp, a \`files\` map and \`counts\`.
       Pass the split file instead \u2014 e.g. ${doc.files[payloadKey === "variables" ? "tokens" : "componentsLocal"] || wantFile} (relative to the export dir that holds ${givenPath}).`
    );
    exitCli(2);
  }
}
function readJsonFile(file, what, hint) {
  return readDocFile(file, what, anyJson, hint);
}
function readDocFile(file, what, guard, hint) {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  const ioFailure = r.missing || /^(is a directory|is not readable|could not be read)/.test(r.error);
  console.error(`error  ${what}: '${file}' ${r.error}${ioFailure ? "." : ""}` + (ioFailure && hint ? `
       ${hint}` : ""));
  exitCli(2);
}
function readOptionalDoc(file, what, guard) {
  return fs3.existsSync(file) ? readDocFile(file, what, guard) : null;
}
function readSplitFile(file, what, guard, payloadKey, wantFile, hint) {
  const doc = readJsonFile(file, what, hint);
  assertNotManifest(doc, file, payloadKey, wantFile);
  if (guard(doc)) return doc;
  console.error(`error  ${what}: '${file}' is not ${guard.expected || "the expected kind of document"}`);
  exitCli(2);
}

// design-to-code/design-system-dir.ts
import fs5 from "node:fs";
import path3 from "node:path";

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var optObj = (x) => x === void 0 || isJsonObject(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isJsonObject(x);
var isAlias = (v) => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";
var isComposed = (v) => {
  if (!v || typeof v !== "object" || !("composed" in v)) return false;
  const c = v.composed;
  if (!c || typeof c !== "object" || !("color" in c) || !("opacity" in c)) return false;
  const colorOk = typeof c.color === "string" || isAlias(c.color);
  const opacityOk = typeof c.opacity === "number" || isAlias(c.opacity);
  return colorOk && opacityOk && (isAlias(c.color) || isAlias(c.opacity));
};
var NUMERIC_TEXT = /^-?\d+(?:\.\d+)?$/;
function isVariable(x) {
  return isJsonObject(x) && typeof x.name === "string" && typeof x.type === "string" && isJsonObject(x.values) && optStr(x.collection);
}
function isVariableCollection(x) {
  return isJsonObject(x) && typeof x.name === "string" && isStringArray(x.modes);
}
function isTokensDoc(x) {
  return isJsonObject(x) && optArrayOf(x.variables, isVariable) && optArrayOf(x.collections, isVariableCollection) && optArrayOf(x._slices, anyObject) && optArrayOf(x._conflicts, anyObject) && (x.hygiene === void 0 || isStringArray(x.hygiene));
}
isTokensDoc.expected = "a token catalog: an object whose `variables` (each {name, type, values}) and `collections` (each {name, modes[]}), when present, are arrays";
function isCatalogComponent(x) {
  return isJsonObject(x) && typeof x.name === "string" && optStr(x.key) && optStr(x.id) && optObj(x.props) && optArrayOf(x.variants, anyObject);
}
function isComponentsCatalog(x) {
  return isJsonObject(x) && Array.isArray(x.components) && x.components.every(isCatalogComponent);
}
isComponentsCatalog.expected = "a component catalog: an object with a `components` array of {name, type, key?, id?, props?}";
function isComponentDetailFile(x) {
  return isJsonObject(x) && typeof x.name === "string" && optArrayOf(x.variants, anyObject) && optObj(x.node);
}
isComponentDetailFile.expected = "a component detail file: an object with a `name` and `variants[]` or `node`";
function isTextStylesDoc(x) {
  return isJsonObject(x) && Array.isArray(x.styles) && x.styles.every((s) => isJsonObject(s) && typeof s.name === "string");
}
isTextStylesDoc.expected = "a text-style sheet: an object with a `styles` array of {name, \u2026}";
function isScreenAssetsDoc(x) {
  return isJsonObject(x) && optArrayOf(x.heavy, (h) => isJsonObject(h) && typeof h.file === "string" && typeof h.bytes === "number" && (h.paths === void 0 || typeof h.paths === "number") && (h.embeddedRaster === void 0 || typeof h.embeddedRaster === "number")) && optArrayOf(x.files, (f) => isJsonObject(f) && typeof f.file === "string" && optStr(f.node));
}
isScreenAssetsDoc.expected = "a screen asset manifest: an object whose `heavy` ({file, bytes}) and `files` ({file, node?}), when present, are arrays";
function isLibrariesIndex(x) {
  return isJsonObject(x) && Array.isArray(x.libraries) && x.libraries.every((r) => isJsonObject(r) && typeof r.dir === "string" && optStr(r.libraryName) && (r.collectionKeys === void 0 || isStringArray(r.collectionKeys)));
}
isLibrariesIndex.expected = "a library index: an object with a `libraries` array of {dir, libraryName?, collectionKeys?}";
var SEVERITIES = ["blocker", "warning", "info"];
function isAuditOverridesDoc(x) {
  return isJsonObject(x) && Array.isArray(x.overrides) && x.overrides.every((o) => isJsonObject(o) && typeof o.code === "string" && typeof o.severity === "string" && SEVERITIES.includes(o.severity) && typeof o.reason === "string" && o.reason.trim() !== "" && ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen", "decidedBy", "decidedAt"].every((k) => optStr(o[k])));
}
isAuditOverridesDoc.expected = "an audit overrides file: { overrides: [{ code, severity: blocker|warning|info, reason (non-empty), nodeId?, token?, component?, collection?, mode?, category?, state?, screen?, decidedBy?, decidedAt? }] }";
function isAuditReport(x) {
  return isJsonObject(x) && isJsonObject(x.summary) && Array.isArray(x.findings) && x.findings.every((f) => isJsonObject(f) && typeof f.severity === "string" && typeof f.code === "string");
}
isAuditReport.expected = "an audit report (written by the audit script's --out): an object with `summary` and a `findings` array of {severity, code, message}";
function isProposal(x) {
  return isJsonObject(x) && typeof x.name === "string";
}
function isProposalList(x) {
  return Array.isArray(x) && x.every(isProposal);
}
isProposalList.expected = "a list of component proposals: an array of {name, catalog, confirmed, \u2026}";
function isVerifyExpectation(x) {
  return isJsonObject(x) && isJsonObject(x.frame) && Array.isArray(x.nodes) && x.nodes.every((n) => isJsonObject(n) && typeof n.nodeId === "string") && optArrayOf(x.instances, anyObject) && optArrayOf(x.interactions, anyObject) && optArrayOf(x.notComparable, anyObject);
}
isVerifyExpectation.expected = "a verify expectation (the verify-screen script's --expect output): an object with `frame` and a `nodes` array of {nodeId, \u2026}";
var isNameVersion = (x) => isJsonObject(x) && typeof x.version === "string" && (typeof x.package === "string" || typeof x.name === "string");
function isProbeIdentity(x) {
  return isJsonObject(x) && typeof x.name === "string" && (x.version === null || typeof x.version === "string") && typeof x.sha256 === "string" && isNameVersion(x.playwright) && isNameVersion(x.browser);
}
function isBuildIdentity(x) {
  return isJsonObject(x) && typeof x.url === "string" && (x.mode === "vite-dev" || x.mode === "static" || x.mode === "unknown") && typeof x.assets === "number" && typeof x.assetsSha256 === "string" && (x.unhashed === void 0 || typeof x.unhashed === "number") && (x.gitHead === null || typeof x.gitHead === "string") && (x.gitDirty === null || typeof x.gitDirty === "boolean");
}
var isProbeFrame = (x) => isJsonObject(x) && typeof x.nodeId === "string" && typeof x.selector === "string" && typeof x.via === "string" && isJsonObject(x.rect);
var isCountMap = (x) => isJsonObject(x) && Object.values(x).every((v) => typeof v === "number");
var isNavigation = (x) => isJsonObject(x) && Array.isArray(x.events) && typeof x.afterInitialLoad === "number" && typeof x.reruns === "number";
var isTagsNotInExpectation = (x) => isJsonObject(x) && typeof x.count === "number" && Array.isArray(x.ids) && x.ids.every((r) => isJsonObject(r) && typeof r.id === "string" && typeof r.elements === "number");
var isReasonMap = (x) => isJsonObject(x) && Object.values(x).every((v) => typeof v === "string");
var isNum = (x) => typeof x === "number" && Number.isFinite(x);
function isProbeReach(x) {
  return isJsonObject(x) && Array.isArray(x.steps) && x.steps.every(isJsonObject) && typeof x.sha256 === "string" && typeof x.source === "string" && typeof x.url === "string";
}
function isPageOverflow(x) {
  return isJsonObject(x) && isJsonObject(x.viewport) && isNum(x.viewport.w) && isNum(x.viewport.h) && isNum(x.scrollWidth) && isNum(x.clientWidth) && typeof x.overflowX === "string" && typeof x.scrollable === "boolean" && Array.isArray(x.offenders) && x.offenders.every((o) => isJsonObject(o) && typeof o.path === "string" && (o.dt === null || typeof o.dt === "string") && isNum(o.right)) && optStr(x.compatMode);
}
var BEHAVIOUR_STATUSES = ["pass", "fail", "warn", "not-run", "unsupported"];
var isBehaviourStatus = (x) => typeof x === "string" && BEHAVIOUR_STATUSES.some((s) => s === x);
function isBehaviourCheck(x) {
  return isJsonObject(x) && typeof x.id === "string" && isBehaviourStatus(x.status) && typeof x.detail === "string";
}
function isMeasuredBehaviour(x) {
  return isJsonObject(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? Array.isArray(x.checks) && x.checks.every(isBehaviourCheck) : typeof x.why === "string");
}
function isMeasuredVisual(x) {
  return isJsonObject(x) && x.version === 1 && typeof x.ran === "boolean" && (x.ran ? isNum(x.differingPct) && isNum(x.shiftTolerantPct) && Array.isArray(x.regions) : typeof x.why === "string");
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
  return isJsonObject(x) && optArrayOf(x.nodes, (n) => isJsonObject(n) && typeof n.nodeId === "string") && optArrayOf(x.components, anyObject) && optArrayOf(x.interactions, anyObject) && (x.artifacts === void 0 || Array.isArray(x.artifacts)) && optStr(x.mode) && optStr(x.expectationSha256);
}
function isVerifyMeasured(x) {
  return isMeasuredCore(x) && MEASURED_EXTRAS.every(([k, ok]) => x[k] === void 0 || ok(x[k])) && (x.nodes === void 0 || Array.isArray(x.nodes) && x.nodes.every((n) => !isJsonObject(n) || n.unmeasured === void 0 || isReasonMap(n.unmeasured)));
}
isVerifyMeasured.expected = "probe measurements: an object whose `nodes` (each {nodeId, styles}), `components`, `interactions` and `artifacts`, when present, are arrays";
function isEvidence(x) {
  return isJsonObject(x) && typeof x.nodeId === "string";
}
function isInteractionEvidenceList(x) {
  return Array.isArray(x) && x.every(isEvidence);
}
isInteractionEvidenceList.expected = "interaction evidence: a JSON array of {nodeId, trigger, ok, selector, selectorCount, detail}";
function isMeasuredComponentList(x) {
  return Array.isArray(x) && x.every((c) => isJsonObject(c) && optStr(c.setName) && optStr(c.name) && optStr(c.nodeId) && (c.present === void 0 || typeof c.present === "boolean"));
}
isMeasuredComponentList.expected = "component evidence: a JSON array of {setName|nodeId, present: true|false}";
function isVerifyReport(x) {
  return isJsonObject(x) && optStr(x.schema) && optStr(x.verdict) && optStr(x.screen) && optStr(x.nodeId) && optStr(x.headline) && (x.why === void 0 || isStringArray(x.why)) && (x.integrity === void 0 || isStringArray(x.integrity)) && optArrayOf(x.deltas, anyObject) && optObj(x.inputs);
}
isVerifyReport.expected = "a verify report (the verify-screen script's --compare output): an object with `verdict`, `why[]`, `deltas[]`, `inputs`";
var PLAN_ARRAYS = ["files", "tokens", "components", "hidden", "anchorsSuggested", "deviations", "allowedLiterals", "waivers", "descopes"];
var PLAN_OBJECTS = ["anchors", "verification", "counts"];
var PLAN_STRINGS = ["schema", "screen", "screenName", "nodeId", "route", "file", "exportedAt", "status"];
function planProblem(x) {
  if (!isJsonObject(x)) return "is not a plan (the file holds " + (Array.isArray(x) ? "an array" : x === null ? "null" : typeof x) + ", not an object)";
  for (const k of PLAN_ARRAYS) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  for (const k of PLAN_OBJECTS) if (x[k] !== void 0 && !isJsonObject(x[k])) return `is not a valid plan: \`${k}\` must be an object`;
  for (const k of PLAN_STRINGS) if (x[k] !== void 0 && x[k] !== null && typeof x[k] !== "string") return `is not a valid plan: \`${k}\` must be a string`;
  if (x.files !== void 0 && !isStringArray(x.files)) return "is not a valid plan: `files` must be an array of paths (strings)";
  for (const k of ["tokens", "components", "allowedLiterals", "deviations", "hidden", "anchorsSuggested", "waivers", "descopes"]) {
    const list = x[k];
    if (Array.isArray(list) && !list.every(isJsonObject)) return `is not a valid plan: every \`${k}\` entry must be an object`;
  }
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isJsonObject(t) && (t.figmaName === null || optStr(t.figmaName)))) return "is not a valid plan: a `tokens` row's `figmaName` must be a string";
  if (Array.isArray(x.components) && !x.components.every((c) => isJsonObject(c) && typeof c.name === "string")) return "is not a valid plan: every `components` row needs its `name`";
  if (isJsonObject(x.anchors) && !Object.values(x.anchors).every(isJsonObject)) return "is not a valid plan: every `anchors` entry must be an object";
  if (x.auditGate !== void 0 && x.auditGate !== null && !isJsonObject(x.auditGate)) return "is not a valid plan: `auditGate` must be an object or null";
  if (x.target !== void 0 && x.target !== null && typeof x.target !== "string" && !isJsonObject(x.target)) return "is not a valid plan: `target` must be a profile name, an object or null";
  if (x.tagging !== void 0 && x.tagging !== null && !(isJsonObject(x.tagging) && (x.tagging.off === void 0 || typeof x.tagging.off === "boolean") && optStr(x.tagging.reason))) return 'is not a valid plan: `tagging` must be {"off": true, "reason": "\u2026"}';
  if (Array.isArray(x.tokens) && !x.tokens.every((t) => isJsonObject(t) && optStr(t.acknowledged))) return "is not a valid plan: a `tokens` row's `acknowledged` must be a string (the reason)";
  if (isJsonObject(x.verification) && x.verification.hook !== void 0 && !isJsonObject(x.verification.hook)) return "is not a valid plan: `verification.hook` must be an object";
  if (isJsonObject(x.verification) && x.verification.recorded !== void 0 && !isJsonObject(x.verification.recorded)) return "is not a valid plan: `verification.recorded` must be an object";
  for (const k of ["navigate", "interactions"]) if (x[k] !== void 0 && !Array.isArray(x[k])) return `is not a valid plan: \`${k}\` must be an array`;
  return null;
}
function isPlan(x) {
  return planProblem(x) === null;
}
isPlan.expected = "a plan (started by the plan-skeleton script): an object whose files/tokens/components/deviations are arrays of objects and whose anchors/verification are objects";
function parsePlan(x) {
  return isPlan(x) ? { plan: x } : { error: planProblem(x) || "is not a plan" };
}
var recIsCount = (x) => typeof x === "number" && Number.isFinite(x);
var recIsStr = (v) => typeof v === "string";
var recNeed = (ok) => ({ need: true, ok });
var recOpt = (ok) => ({ need: false, ok });
var RECORD_COUNTS = Object.fromEntries(["high", "medium", "low", "accepted", "notMeasured", "inferred"].map((k) => [k, recNeed(recIsCount)]));
var RECORD_DELTA = { nodeId: recNeed(recIsStr), field: recNeed(recIsStr), severity: recNeed((v) => v === "high" || v === "medium"), expected: recOpt(() => true), actual: recOpt(() => true) };
var RECORD_A11Y = { tool: recNeed(recIsStr), violations: recNeed(recIsCount), warnings: recNeed(recIsCount), report: recNeed(recIsStr) };
var RECORD_FIELDS = {
  schema: recNeed((v) => v === PLAN_VERIFICATION_RECORD_SCHEMA),
  by: recNeed(recIsStr),
  at: recNeed(recIsStr),
  report: recNeed(recIsStr),
  reportSha256: recNeed(recIsStr),
  verdict: recNeed(recIsStr),
  headline: recNeed(recIsStr),
  behaviourHeadline: recOpt(recIsStr),
  counts: recNeed(isJsonObject),
  mode: recNeed((v) => v === "rendered" || v === "static-only"),
  reason: recOpt(recIsStr),
  renderer: recOpt(recIsStr),
  artifacts: recNeed(isStringArray),
  deltas: recNeed(Array.isArray),
  a11y: recOpt(isJsonObject)
};
var RECORD_KEYS = Object.keys(RECORD_FIELDS);
var reqStr = (v) => typeof v === "string" && v.trim() !== "";
function isPlanWaiver(x) {
  return isJsonObject(x) && reqStr(x.nodeId) && reqStr(x.field) && x.designed !== void 0 && x.built !== void 0 && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt) && (x.tolerance === void 0 || typeof x.tolerance === "number" && x.tolerance >= 0) && optStr(x.cause);
}
isPlanWaiver.expected = "a plan waiver {nodeId, field, designed, built, exportContentSha256, reason, decidedBy, decidedAt, tolerance?, cause?}";
function isPlanDescope(x) {
  return isJsonObject(x) && reqStr(x.nodeId) && reqStr(x.trigger) && optStr(x.destinationId) && reqStr(x.exportContentSha256) && reqStr(x.reason) && reqStr(x.decidedBy) && reqStr(x.decidedAt);
}
isPlanDescope.expected = "a plan descope {nodeId, trigger, destinationId?, exportContentSha256, reason, decidedBy, decidedAt}";
function isStringRecord(x) {
  return isJsonObject(x) && Object.values(x).every((v) => typeof v === "string");
}
isStringRecord.expected = "an object of strings";

// bridge/src/export-reader.ts
import fs4 from "node:fs";
import path2 from "node:path";
var PAGES = "pages";
var INDEX = "index.json";
function resolveInside(base, rel, within = base) {
  const root = path2.resolve(within), file = path2.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path2.sep) ? file : null;
}
var inside = (root, rel) => typeof rel === "string" && rel && !path2.isAbsolute(rel) ? resolveInside(root, rel) : null;
var relOf = (root, file) => path2.relative(root, file).split(path2.sep).join("/");
var problemOf = (root, file, read) => "error" in read && !read.missing ? { file: relOf(root, file), error: read.error } : null;
var optStr2 = (x) => x === void 0 || typeof x === "string";
var isIndexRowLike = (x) => isRecord(x) && typeof x.id === "string" && typeof x.name === "string";
var isRowList = (x) => Array.isArray(x) && x.every((r) => r === null || isIndexRowLike(r));
var isPagesRootIndex = /* @__PURE__ */ Object.assign(
  (x) => isRecord(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isRecord(d) && optStr2(d.dir) && optStr2(d.index)) && (x.layers === void 0 || isRowList(x.layers)) && optStr2(x.exportedAt),
  { expected: "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})" }
);
var isPageIndex = /* @__PURE__ */ Object.assign(
  (x) => isRecord(x) && isRowList(x.layers),
  { expected: "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}" }
);
function screenSiblingFile(screenFile, kind) {
  return screenFile.replace(/\.json$/i, "") + "." + kind + ".json";
}
var rootIndexFile = (exportRoot) => path2.join(exportRoot, PAGES, INDEX);
var hasExportIndex = (exportRoot) => fs4.existsSync(rootIndexFile(exportRoot));
function pagesRootOfScreen(screenFile) {
  const pages = path2.dirname(path2.dirname(path2.resolve(screenFile)));
  return path2.basename(pages) === PAGES ? path2.dirname(pages) : null;
}
function exportRootOfScreen(screenFile) {
  const root = pagesRootOfScreen(screenFile);
  return root !== null && hasExportIndex(root) ? root : null;
}
function pageIndexFiles(root, pageDirs) {
  const files = [];
  const add = (f) => {
    if (f !== null && !files.includes(path2.resolve(f))) files.push(path2.resolve(f));
  };
  const ofDir = (dir) => dir && !/[\\/]/.test(dir) && dir !== ".." && dir !== "." ? path2.join(root, PAGES, dir, INDEX) : null;
  for (const pd of pageDirs) add(pd.index ? inside(root, pd.index) : ofDir(pd.dir));
  let dirs = [];
  try {
    dirs = fs4.readdirSync(path2.join(root, PAGES), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
  }
  for (const d of dirs) add(ofDir(d));
  return files;
}
function readExportIndex(exportRoot) {
  const root = exportRoot;
  const rootFile = rootIndexFile(root);
  const read = readJson(rootFile, isPagesRootIndex);
  const rootDoc = "doc" in read ? read.doc : null;
  const problems = [];
  const rootProblem = problemOf(root, rootFile, read);
  if (rootProblem) problems.push(rootProblem);
  const rows = [];
  const byId = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Set();
  const fromRoot = /* @__PURE__ */ new Set();
  const written = /* @__PURE__ */ new Map();
  const writtenAt = (row) => {
    let t = written.get(row);
    if (t === void 0) {
      const f = inside(root, row.file);
      try {
        t = f === null ? -1 : fs4.statSync(f).mtimeMs;
      } catch {
        t = -1;
      }
      written.set(row, t);
    }
    return t;
  };
  const hasFile = (row) => {
    const file = row.file;
    return typeof file === "string" && file !== "";
  };
  const probeOf = (row) => hasFile(row) ? row : { ...row, file: "\0no file " + rows.length };
  const sameScreen = (older, newer) => hasFile(older) && older.file === newer.file || sameScreenRow(probeOf(older), newer);
  const keep = (row, isRoot) => {
    rows.push(row);
    const bucket = byId.get(row.id);
    if (bucket) bucket.push(row);
    else byId.set(row.id, [row]);
    if (hasFile(row)) files.add(row.file);
    if (isRoot) fromRoot.add(row);
  };
  const take = (row, isRoot) => {
    const candidates = [...byId.get(row.id) ?? [], ...hasFile(row) && files.has(row.file) ? rows.filter((k) => k.file === row.file && k.id !== row.id) : []];
    if (isRoot) {
      if (!candidates.some((k) => sameScreen(row, k))) keep(row, true);
      return;
    }
    const newer = (k) => writtenAt(row) > writtenAt(k);
    const conflicts = candidates.filter((k) => fromRoot.has(k) || !newer(k) ? sameScreen(row, k) : sameScreen(k, row));
    if (!conflicts.length) {
      keep(row, false);
      return;
    }
    if (conflicts.some((k) => fromRoot.has(k) || !newer(k))) return;
    const at = Math.min(...conflicts.map((k) => rows.indexOf(k)));
    for (const k of conflicts) {
      rows.splice(rows.indexOf(k), 1);
      const bucket = byId.get(k.id) ?? [];
      bucket.splice(bucket.indexOf(k), 1);
      if (!bucket.length) byId.delete(k.id);
      if (hasFile(k) && !rows.some((r) => r.file === k.file)) files.delete(k.file);
    }
    keep(row, false);
    rows.splice(rows.length - 1, 1);
    rows.splice(at, 0, row);
  };
  for (const row of rootDoc?.layers ?? []) if (row) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    const page = readJson(f, isPageIndex);
    const problem = problemOf(root, f, page);
    if (problem) problems.push(problem);
    if ("doc" in page) {
      for (const row of page.doc.layers) if (row) take(row, false);
    }
  }
  const rootStamp = rootDoc?.exportedAt || void 0;
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: rootProblem && rootProblem.error,
    problems,
    rows,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file),
    exportedAtOf: (row) => typeof row.exportedAt === "string" && row.exportedAt || (fromRoot.has(row) ? rootStamp : void 0)
  };
}

// bridge/src/library-layout.ts
var ROOT = "libraries";
var INDEX2 = "index.json";
var { TOKENS: TOKENS2, HYGIENE: HYGIENE2 } = DESIGN_SYSTEM_FILES;
var COMPONENTS = "components.json";
var LIBRARY_FILE_NAMES = [TOKENS2, ...STYLE_KINDS.map((row) => row.file), COMPONENTS, HYGIENE2, INDEX2];

// design-to-code/design-system-dir.ts
var { TOKENS: TOKENS3, COMPONENTS_LOCAL: COMPONENTS_LOCAL2, COMPONENTS_LIBRARY: COMPONENTS_LIBRARY2 } = DESIGN_SYSTEM_FILES;
var STYLES_TEXT = STYLE_KIND_ROWS.text.file;
function designSystemFiles(dir) {
  const local = path3.join(dir, COMPONENTS_LOCAL2);
  const isLibrary = !fs5.existsSync(local) && fs5.existsSync(path3.join(dir, COMPONENTS));
  return {
    tokens: path3.join(dir, TOKENS3),
    components: isLibrary ? path3.join(dir, COMPONENTS) : local,
    componentsLibrary: path3.join(dir, COMPONENTS_LIBRARY2),
    stylesText: path3.join(dir, STYLES_TEXT),
    componentsFile: isLibrary ? COMPONENTS : COMPONENTS_LOCAL2,
    isLibrary
  };
}
function readDesignSystemDir(dir) {
  const f = designSystemFiles(dir);
  return {
    tokens: readOptionalDoc(f.tokens, "design-system tokens", isTokensDoc),
    components: readOptionalDoc(f.components, "component catalog", isComponentsCatalog),
    componentsLibrary: readOptionalDoc(f.componentsLibrary, "library component catalog", isComponentsCatalog),
    stylesText: readOptionalDoc(f.stylesText, "text styles", isTextStylesDoc),
    componentsFile: f.componentsFile,
    isLibrary: f.isLibrary
  };
}
function exportRootOf(screenFile, dsDir) {
  const roots = [];
  if (screenFile) {
    const pages = path3.dirname(path3.dirname(screenFile));
    if (path3.basename(pages) === "pages") roots.push(path3.dirname(pages));
  }
  if (dsDir) {
    const parent = path3.dirname(path3.normalize(dsDir));
    roots.push(path3.basename(parent) === ROOT ? path3.dirname(parent) : parent);
  }
  return roots.find((r) => fs5.existsSync(path3.join(r, ROOT, INDEX2))) ?? null;
}
function findLibraryExports(screenFile, dsDir) {
  const root = exportRootOf(screenFile, dsDir);
  if (!root) return [];
  const index = readJsonOrNull(path3.join(root, ROOT, INDEX2), isLibrariesIndex);
  if (!index) return [];
  return index.libraries.filter((r) => r.dir && r.dir !== "." && r.dir !== ".." && !/[\\/]/.test(r.dir)).map((r) => {
    const rel = path3.join(root, ROOT, r.dir).split(path3.sep).join("/");
    return { rel, name: r.libraryName || r.dir, collectionKeys: r.collectionKeys || [], components: readJsonOrNull(path3.join(rel, COMPONENTS), isComponentsCatalog) };
  });
}
function readFrameTexts(file) {
  const doc = readJsonOrNull(file, isScreenDoc);
  if (!doc) return null;
  const all = [], shallow = [];
  for (const r of screenRoots(doc)) walkWithHidden(r, (n, c) => {
    if (n.type === "TEXT" && typeof n.text === "string" && n.text.trim()) {
      all.push(n.text);
      if (c.depth <= 6) shallow.push(n.text);
    }
  });
  return { all, shallow };
}
function findExportNeighbours(screenFile) {
  const root = exportRootOfScreen(screenFile);
  if (root === null) return null;
  const ix = readExportIndex(root);
  if (!ix.indexed) return null;
  const layers = [...ix.rows];
  const cache = /* @__PURE__ */ new Map();
  const textsOf = (row) => {
    const f = ix.fileOf(row);
    if (f === null) return null;
    if (!cache.has(f)) cache.set(f, readFrameTexts(f));
    return cache.get(f) ?? null;
  };
  const known = new Set(layers.map((l) => safe(l.id)));
  const shots = /* @__PURE__ */ new Set();
  let files = [];
  try {
    files = fs5.readdirSync(path3.join(root, "assets"));
  } catch {
    files = [];
  }
  for (const f of files) {
    const m = /^(\d+_\d+)(?:_ref(?:-[0-9A-Za-z]+(?:_\d+)?)?|_shot@[\d.]+x)\.png$/.exec(f);
    const id = m && m[1] && !known.has(m[1]) ? nodeIdFromSafe(m[1]) : null;
    if (id) shots.add(id);
  }
  return { layers, unexportedShots: [...shots].sort(), textsOf };
}

// design-to-code/cli-args.ts
import path4 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var SCRIPT_RUNNER = "bun --no-install --no-env-file";
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
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

// design-to-code/map-validate.ts
var STATUSES = ["active", "deprecated", "needs-review"];
var KEYS = {
  root: ["version", "figmaFileKey", "components"],
  entry: ["figma", "code", "props", "variantOverrides", "childrenByLayer", "status", "note"],
  figma: ["key", "id", "name", "unstable"],
  code: ["module", "export", "targets"],
  target: ["module", "export"],
  vo: ["when", "code"],
  voCode: ["module", "export"],
  children: ["layerNamePattern", "slot"],
  prop: Object.assign(nullProto(), {
    enum: ["kind", "codeProp", "values", "default", "omitDefault"],
    boolean: ["kind", "codeProp", "default", "omitDefault"],
    string: ["kind", "codeProp"],
    instance: ["kind", "codeProp", "slot"]
  })
};
var PROP_KINDS = Object.keys(KEYS.prop);
var isStr = (v) => typeof v === "string";
var isBool = (v) => typeof v === "boolean";
var noExtra = (obj, allowed, at, err) => {
  if (!Array.isArray(allowed)) return;
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${at}.${k}`, "unknown property (additionalProperties:false)");
};
var optStrings = (obj, keys, at, err) => {
  for (const k of keys) if (obj[k] !== void 0 && !isStr(obj[k])) err(`${at}.${k}`, "must be a string");
};
function validateMap(map) {
  const errors = [];
  const err = (path12, message) => errors.push({ path: path12, message });
  if (!isRecord(map)) return { ok: false, errors: [{ path: "", message: "map must be an object" }] };
  noExtra(map, KEYS.root, "", err);
  if (map.version !== 1) err("version", "must be 1");
  if (map.figmaFileKey !== void 0 && !isStr(map.figmaFileKey)) err("figmaFileKey", "must be a string");
  if (!isRecord(map.components)) {
    err("components", "must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(map.components)) {
    const e = map.components[key];
    const at = `components.${key}`;
    if (!isRecord(e)) {
      err(at, "entry must be an object");
      continue;
    }
    noExtra(e, KEYS.entry, at, err);
    if (!isRecord(e.figma)) err(`${at}.figma`, "required object");
    else {
      noExtra(e.figma, KEYS.figma, `${at}.figma`, err);
      if (!isStr(e.figma.name)) err(`${at}.figma.name`, "required string");
      optStrings(e.figma, ["key", "id"], `${at}.figma`, err);
      if (e.figma.unstable !== void 0 && !isBool(e.figma.unstable)) err(`${at}.figma.unstable`, "must be a boolean");
    }
    if (!isRecord(e.code)) err(`${at}.code`, "required object");
    else {
      noExtra(e.code, KEYS.code, `${at}.code`, err);
      if (!isStr(e.code.module)) err(`${at}.code.module`, "required string");
      if (!isStr(e.code.export)) err(`${at}.code.export`, "required string");
      if (e.code.targets !== void 0) {
        if (!isRecord(e.code.targets)) err(`${at}.code.targets`, "must be an object");
        else for (const t of Object.keys(e.code.targets)) {
          const tv = e.code.targets[t], ta = `${at}.code.targets.${t}`;
          if (!isRecord(tv)) err(ta, "must be an object");
          else {
            noExtra(tv, KEYS.target, ta, err);
            optStrings(tv, ["module", "export"], ta, err);
          }
        }
      }
    }
    if (e.status !== void 0 && (!isStr(e.status) || !STATUSES.includes(e.status))) err(`${at}.status`, `must be one of ${STATUSES.join("|")}`);
    optStrings(e, ["note"], at, err);
    if (e.props !== void 0) {
      if (!isRecord(e.props)) err(`${at}.props`, "must be an object");
      else for (const pn of Object.keys(e.props)) validateProp(e.props[pn], `${at}.props.${pn}`, err);
    }
    if (e.variantOverrides !== void 0) {
      if (!Array.isArray(e.variantOverrides)) err(`${at}.variantOverrides`, "must be an array");
      else e.variantOverrides.forEach((vo, i) => {
        const va = `${at}.variantOverrides[${i}]`;
        if (!isRecord(vo)) {
          err(va, "must be an object");
          return;
        }
        noExtra(vo, KEYS.vo, va, err);
        if (!isRecord(vo.when)) err(`${va}.when`, "required object");
        else for (const wk of Object.keys(vo.when)) if (!isStr(vo.when[wk])) err(`${va}.when.${wk}`, "value must be a string");
        if (!isRecord(vo.code)) err(`${va}.code`, "required object");
        else {
          noExtra(vo.code, KEYS.voCode, `${va}.code`, err);
          if (!isStr(vo.code.module)) err(`${va}.code.module`, "required string");
          if (!isStr(vo.code.export)) err(`${va}.code.export`, "required string");
        }
      });
    }
    if (e.childrenByLayer !== void 0) {
      if (!isRecord(e.childrenByLayer)) err(`${at}.childrenByLayer`, "must be an object");
      else {
        noExtra(e.childrenByLayer, KEYS.children, `${at}.childrenByLayer`, err);
        optStrings(e.childrenByLayer, ["layerNamePattern", "slot"], `${at}.childrenByLayer`, err);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
function validateProp(p, at, err) {
  if (!isRecord(p)) {
    err(at, "prop must be an object");
    return;
  }
  const allowed = typeof p.kind === "string" ? KEYS.prop[p.kind] : void 0;
  if (!Array.isArray(allowed)) {
    err(`${at}.kind`, `must be one of ${PROP_KINDS.join("|")}`);
    return;
  }
  noExtra(p, allowed, at, err);
  if (p.kind !== "instance" && !isStr(p.codeProp)) err(`${at}.codeProp`, "required string");
  if (p.kind === "instance" && p.codeProp !== void 0 && !isStr(p.codeProp)) err(`${at}.codeProp`, "must be a string");
  if (p.kind === "instance" && p.slot !== void 0 && !isStr(p.slot)) err(`${at}.slot`, "must be a string");
  if (p.kind === "enum") {
    if (p.values !== void 0 && !isRecord(p.values)) err(`${at}.values`, "must be an object (VARIANT option -> code value)");
    else if (isRecord(p.values)) for (const k of Object.keys(p.values)) {
      const t = typeof p.values[k];
      if (p.values[k] !== null && !["string", "number", "boolean"].includes(t)) err(`${at}.values.${k}`, "value must be string|number|boolean|null");
    }
    if (p.default !== void 0 && !["string", "number", "boolean"].includes(typeof p.default)) err(`${at}.default`, "must be string|number|boolean");
  }
  if (p.kind === "boolean" && p.default !== void 0 && !isBool(p.default)) err(`${at}.default`, "must be a boolean");
  if ((p.kind === "enum" || p.kind === "boolean") && p.omitDefault !== void 0 && !isBool(p.omitDefault)) err(`${at}.omitDefault`, "must be a boolean");
}
function isCodeConnectMap(x) {
  return validateMap(x).ok;
}
isCodeConnectMap.expected = "a valid component map (the map-validate script lists what is wrong with it)";
if (false) runCli2(main, { name: "map-validate" });

// design-to-code/slice-sources.ts
import fs6 from "node:fs";
import path5 from "node:path";
function sourcesOf(doc, docPath) {
  const out = /* @__PURE__ */ new Map();
  const add = (key, screen) => {
    if (typeof key !== "string" || !key || !screen) return;
    const list = out.get(key) || [];
    if (!list.includes(screen)) list.push(screen);
    out.set(key, list);
  };
  const base = docPath ? path5.dirname(docPath) : ".";
  for (const sl of doc && Array.isArray(doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string") {
      const slice = readJsonOrNull(path5.join(base, sl.file.replace(/\.json$/, ".vars.json")), isTokensDoc);
      if (slice) {
        for (const v of slice.variables || []) add(v.key, sl.screen);
        read = true;
      }
    }
    if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
  }
  for (const c of doc && Array.isArray(doc._conflicts) ? doc._conflicts : []) {
    for (const vr of c && "variants" in c && c.variants || []) for (const sc of vr.screens || []) add(vr.key, sc);
  }
  if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
    for (const v of doc && doc.variables || []) add(v.key, path5.basename(docPath, ".vars.json"));
  }
  return out;
}
function variablesContext(screenFiles, varsFile, opts) {
  const invalid = [];
  const readTokens = (f) => {
    if (!f) return null;
    const r = readJson(f, isTokensDoc);
    if ("doc" in r) return r.doc;
    if (!r.missing) invalid.push({ file: f, error: r.error });
    return null;
  };
  const files = screenFiles || [];
  const own = files.map((f) => readTokens(screenSiblingFile(String(f), "vars")));
  let variablesPath = varsFile || null;
  const firstFile = files[0];
  if (!variablesPath && firstFile !== void 0) {
    const exportRoot = path5.resolve(path5.dirname(firstFile), "..", "..");
    const rootVars = path5.join(exportRoot, MERGED_VARIABLES_FILE);
    const sibling = path5.join(path5.dirname(firstFile), MERGED_VARIABLES_FILE);
    if (fs6.existsSync(rootVars)) variablesPath = rootVars;
    else if (fs6.existsSync(sibling)) variablesPath = sibling;
    else if (opts && opts.sliceFallback && files.length === 1 && own[0]) variablesPath = screenSiblingFile(String(firstFile), "vars");
  }
  const variablesDoc = readTokens(variablesPath);
  let staleLegacy = null;
  if (firstFile !== void 0) {
    const legacy2 = path5.join(path5.resolve(path5.dirname(firstFile), "..", ".."), "..", MERGED_VARIABLES_FILE);
    if (fs6.existsSync(legacy2) && path5.resolve(legacy2) !== path5.resolve(variablesPath || "")) staleLegacy = legacy2;
  }
  return { own, variablesPath, variablesDoc, sliceSources: variablesDoc ? sourcesOf(variablesDoc, variablesPath) : null, staleLegacy, invalid };
}

// design-to-code/screen-inputs.ts
function exportSiblings(files) {
  const checked = new Set(files.map((f) => path6.resolve(f)));
  const roots = /* @__PURE__ */ new Set();
  for (const f of checked) {
    const root = exportRootOfScreen(f);
    if (root !== null) roots.add(root);
  }
  if (!roots.size) return null;
  return () => {
    const out = [];
    const seen = new Set(checked);
    for (const root of roots) {
      const ix = readExportIndex(root);
      for (const row of ix.rows) {
        const file = ix.fileOf(row);
        if (file === null || seen.has(file)) continue;
        seen.add(file);
        const doc = readJsonOrNull(file, isScreenDoc);
        if (doc) out.push({ doc, label: path6.basename(file, ".json") });
      }
    }
    return out;
  };
}
function designSystemDirOf(firstFile, named) {
  if (named) return { dir: named, given: true };
  const shown = (abs) => {
    const rel = path6.relative(process.cwd(), abs);
    return rel && !rel.startsWith("..") && !path6.isAbsolute(rel) ? rel.split(path6.sep).join("/") : abs;
  };
  const root = firstFile === void 0 ? null : pagesRootOfScreen(firstFile);
  const dir = root !== null ? path6.join(root, DESIGN_SYSTEM_DIR) : path6.resolve(findExportDir(process.cwd()).rel, DESIGN_SYSTEM_DIR);
  return fs7.existsSync(dir) && fs7.statSync(dir).isDirectory() ? { dir: shown(dir), given: false } : null;
}
function readScreenInputs(files, flags = {}) {
  const ctx = variablesContext(files, flags.variables, { sliceFallback: true });
  if (ctx.invalid.length) return { errors: ctx.invalid.map((bad) => `error  variables: '${bad.file}' ${bad.error}`) };
  const notes = [];
  if (ctx.variablesPath) notes.push(`variables: ${ctx.variablesPath}`);
  else notes.push("note  no variables: no variables.json at the export root or beside the screen (pass --variables)");
  if (ctx.staleLegacy) notes.push(`warn  ${ctx.staleLegacy} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
  const screens = files.map((f, i) => ({
    file: f,
    doc: readDocFile(f, "screen export", isScreenDoc),
    label: path6.basename(f, ".json"),
    ...ctx.own[i] ? { vars: ctx.own[i] } : {},
    assets: readJsonOrNull(screenSiblingFile(f, "assets"), isScreenAssetsDoc)
  }));
  const firstFile = files[0];
  const at = designSystemDirOf(firstFile, flags.designSystem);
  const designSystem = at === null ? null : { ...readDesignSystemDir(at.dir), ...at };
  if (at === null) notes.push(`note  no design system: none given, and no ${DESIGN_SYSTEM_DIR}/ beside the export (pass --design-system)`);
  else if (at.given && !fs7.existsSync(at.dir)) notes.push(`note  --design-system ${at.dir} does not exist \u2014 no design system was read`);
  else notes.push(`design system: ${at.dir}${at.given ? "" : " (found beside the export; pass --design-system to choose another)"}`);
  const libraries = findLibraryExports(firstFile, at?.dir);
  let map = null, mapFile = null;
  if (flags.map) {
    map = readDocFile(flags.map, "component map", isCodeConnectMap);
    mapFile = flags.map;
  } else {
    const found = findMapFile(process.cwd());
    const r = found.missing ? null : readJson(found.rel, isCodeConnectMap);
    if (r && "doc" in r) {
      map = r.doc;
      mapFile = found.rel;
      notes.push(`map: ${found.rel}`);
    } else if (r) notes.push(`warn  ${found.rel} ${r.error} \u2014 proposals are not labelled alreadyMapped${flags.mapFlag ? " (pass --map to fail on it)" : ""}`);
  }
  return {
    inputs: {
      screens,
      variables: ctx.variablesDoc,
      variablesPath: ctx.variablesPath,
      sliceSources: ctx.sliceSources,
      designSystem,
      libraries,
      map,
      mapFile,
      siblings: exportSiblings(files),
      notes
    }
  };
}
function withCatalog(ds, catalog) {
  if (ds === null || catalog === void 0) return ds;
  return { ...ds, components: ds.given ? ds.components || catalog : catalog };
}
function crossCheckInputOf(c, fallback = {}) {
  const ds = c.designSystem;
  return {
    screens: c.screens,
    variables: c.variables ?? null,
    variablesPath: c.variablesPath ?? null,
    sliceSources: c.sliceSources ?? null,
    tokens: ds?.tokens ?? null,
    components: ds?.components || fallback.components || null,
    componentsLibrary: ds?.componentsLibrary ?? null,
    stylesText: ds?.stylesText ?? null,
    ...ds?.componentsFile !== void 0 ? { componentsFile: ds.componentsFile } : {},
    ...ds?.isLibrary !== void 0 ? { designSystemIsLibrary: ds.isLibrary } : {},
    map: c.map ?? null,
    siblings: c.siblings ?? null
  };
}

// design-to-code/control-kind.ts
var TOGGLE_WORD = /\b(checkbox|check box|radio|switch|toggle)\b/i;
function controlKind(name) {
  const s = String(name || "");
  const toggle = TOGGLE_WORD.test(s);
  if (!toggle && /\b(select|dropdown|drop ?down|combo ?box|multi-?select|picker)\b/i.test(s.replace(/\bselect ?all\b/gi, ""))) return "select";
  if (/\b(input|text ?field|textfield|search|textarea)\b/i.test(s)) return "input";
  if (toggle) return "toggle";
  if (/\b(tab|tabs|segmented|nav ?item|navigation item)\b/i.test(s)) return "tab";
  if (/\blink\b/i.test(s)) return "link";
  if (/\b(button|btn|cta|icon ?button|chip)\b/i.test(s)) return "button";
  return null;
}
var isBoundaryKind = (a) => [a.name, a.mainComponent && a.mainComponent.setName, a.component].some((l) => {
  const k = controlKind(l);
  return k === "input" || k === "select" || k === "toggle";
});
function outermostControl(near) {
  for (let i = 0; i < near.length; i++) {
    const a = near[i];
    if (a && a.type === "INSTANCE" && isBoundaryKind(a)) return i;
  }
  for (let i = near.length - 1; i >= 0; i--) {
    const a = near[i];
    if (a && isBoundaryKind(a)) return i;
  }
  return -1;
}
var DISABLED_WORD = /^(disabled|inactive|is ?disabled)$/i;
var ON_VALUE = /^(true|yes|on)$/i;
function isDisabledLayer(layer) {
  for (const part of String(layer.mainComponent && layer.mainComponent.name || "").split(",")) {
    const [k = "", v = ""] = part.split("=").map((x) => x.trim());
    if (DISABLED_WORD.test(v) || DISABLED_WORD.test(k) && ON_VALUE.test(v)) return true;
  }
  for (const [k, v] of Object.entries(layer.props || {})) {
    if (DISABLED_WORD.test(k.trim()) && (v === true || typeof v === "string" && ON_VALUE.test(v.trim()))) return true;
    if (!layer.mainComponent && typeof v === "string" && /^disabled$/i.test(v.trim())) return true;
  }
  return false;
}

// design-to-code/variable-resolve.ts
var cmpStr = (a, b) => a < b ? -1 : a > b ? 1 : 0;
var definedModes = (v) => {
  const vals = v.values || {};
  return Object.keys(vals).filter((m) => vals[m] !== void 0);
};
var sameVariable = (a, b) => a === b || !!a.key && a.key === b.key;
var sameCollection = (a, b) => a.collectionKey && b.collectionKey ? a.collectionKey === b.collectionKey : a.collection !== void 0 && a.collection === b.collection;
function defaultAmong(v, modes, collections) {
  const hasDefault = (c) => c.default !== void 0 && modes.includes(c.default);
  const byKey = v.collectionKey ? collections.find((c) => c.key === v.collectionKey && hasDefault(c)) : void 0;
  return (byKey ?? (v.collection === void 0 ? void 0 : collections.find((c) => c.name === v.collection && hasDefault(c))))?.default;
}
var isLegacyRgba = (x) => !!x && typeof x === "object" && "r" in x && "g" in x && "b" in x && typeof x.r === "number" && typeof x.g === "number" && typeof x.b === "number";
function readColour(raw) {
  if (typeof raw === "string") return parseHex(raw);
  if (!isLegacyRgba(raw)) return null;
  const a = raw.a === void 0 ? 1 : Number(raw.a);
  return { r: raw.r * 255, g: raw.g * 255, b: raw.b * 255, a: Number.isNaN(a) ? 1 : a };
}
var readNumber = (raw) => {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && NUMERIC_TEXT.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};
var isSourceList = (x) => Array.isArray(x);
var colourOf = (r) => r.fold ?? readColour(r.value);
function variableResolver(input) {
  const sources = isSourceList(input) ? input : [input];
  const byName = /* @__PURE__ */ new Map();
  const collections = [];
  let order = 0;
  for (const [source, src] of sources.entries()) {
    for (const v of src && src.variables || []) {
      if (!v || typeof v.name !== "string") continue;
      const list = byName.get(v.name);
      const entry = { v, source, order: order++ };
      if (list) list.push(entry);
      else byName.set(v.name, [entry]);
    }
    for (const c of src && src.collections || []) if (c) collections.push(c);
  }
  const entries = (name, referrer) => (byName.get(name) || []).filter((e) => !referrer || !sameVariable(e.v, referrer));
  function target(name, referrer) {
    const cands = entries(name, referrer);
    if (cands.length <= 1) return cands[0]?.v ?? null;
    const own = (e) => referrer && sameCollection(e.v, referrer) ? 0 : 1;
    return cands.slice().sort((a, b) => own(a) - own(b) || a.source - b.source || cmpStr(a.v.key || "", b.v.key || "") || a.order - b.order)[0]?.v ?? null;
  }
  function modeOf(v, req = {}) {
    const modes = definedModes(v);
    const fromFrame = v.collection === void 0 ? void 0 : req.byCollection?.[v.collection];
    for (const want of [fromFrame, req.mode]) {
      if (want === void 0) continue;
      if (modes.includes(want)) return want;
      const lower = want.toLowerCase();
      const ci = modes.find((m) => m.toLowerCase() === lower);
      if (ci !== void 0) return ci;
    }
    if (modes.length === 1) return modes[0];
    const fallback = req.fallback ?? "first";
    if (fallback === "none") return void 0;
    const def = defaultAmong(v, modes, collections);
    if (def !== void 0 || fallback === "default") return def;
    return modes[0];
  }
  function walk2(v, req, seen) {
    const none = (mode2) => ({ value: void 0, variable: null, mode: mode2, via: [] });
    if (!v || seen.has(v)) return none();
    const mode = modeOf(v, req);
    if (mode === void 0) return none();
    const raw = (v.values || {})[mode];
    const next = new Set(seen).add(v);
    if (isAlias(raw)) {
      const r = walk2(target(raw.aliasOf, v), req, next);
      return { ...r, mode, via: [raw.aliasOf, ...r.via] };
    }
    if (isComposed(raw)) {
      const c = composed(v, raw.composed, req, next);
      return c ? { value: formatHex(c), variable: v, mode, via: [], fold: c } : none(mode);
    }
    if (raw === void 0 || !!raw && typeof raw === "object" && "composed" in raw) return none(mode);
    return { value: raw, variable: v, mode, via: [] };
  }
  function composed(owner, half, req, seen) {
    const c = isAlias(half.color) ? colourOf(walk2(target(half.color.aliasOf, owner), req, seen)) : readColour(half.color);
    const o = isAlias(half.opacity) ? readNumber(walk2(target(half.opacity.aliasOf, owner), req, seen).value) : readNumber(half.opacity);
    return c && o !== null ? { ...c, a: composeAlpha(c.a, o) } : null;
  }
  function closure(v) {
    const vars = [];
    let complete = true;
    const done = /* @__PURE__ */ new Set();
    const path12 = /* @__PURE__ */ new Set();
    const visit2 = (x) => {
      if (path12.has(x)) {
        complete = false;
        return;
      }
      if (done.has(x)) return;
      vars.push(x);
      path12.add(x);
      for (const val of Object.values(x.values || {})) {
        const names = isAlias(val) ? [val.aliasOf] : isComposed(val) ? [val.composed.color, val.composed.opacity].filter(isAlias).map((a) => a.aliasOf) : [];
        for (const n of names) {
          const t = target(n, x);
          if (t) visit2(t);
          else complete = false;
        }
      }
      path12.delete(x);
      done.add(x);
    };
    visit2(v);
    return { vars, complete };
  }
  return {
    candidates: (name, referrer) => entries(name, referrer).map((e) => e.v),
    target,
    modeOf,
    resolve: (v, req = {}) => {
      const { value, variable, mode, via } = walk2(v, req, /* @__PURE__ */ new Set());
      return { value, variable, mode, via };
    },
    colour: (v, req = {}) => colourOf(walk2(v, req, /* @__PURE__ */ new Set())),
    number: (v, req = {}) => readNumber(walk2(v, req, /* @__PURE__ */ new Set()).value),
    closure
  };
}

// design-to-code/cross-check.ts
var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
var ABSURD_NUMBER = 1e4;
var WRONG_CATALOG_PCT = 5;
function crossCheck(input) {
  const screens = input.screens || [];
  const variables = input.variables || null;
  const tokens = input.tokens || null;
  const components = input.components || null;
  const componentsLibrary = input.componentsLibrary || null;
  const stylesText = input.stylesText || null;
  const catFile = input.componentsFile || "components.local.json";
  const LIST_LIBRARIES = "`dtwin list libraries --client <the screen's file>` (MCP: `figma_list_libraries`)";
  const EXPORT_LIBRARY = input.designSystemIsLibrary ? 'check that the library export you passed is the one the screen consumes (a DUPLICATED library file re-keys everything \u2014 re-export the original with `dtwin pull --as-library "<name>"`, CLI only)' : 'export it with `dtwin pull --as-library "<name>"` (CLI only \u2014 the MCP server has no library export)';
  const findings = [];
  const notChecked = [];
  const push = (severity, code, message, extra) => {
    findings.push(Object.assign({ severity, code, message }, extra || {}));
  };
  const usage = screenUsage(screens);
  const cc = { input, screens, variables, tokens, components, componentsLibrary, stylesText, catFile, LIST_LIBRARIES, EXPORT_LIBRARY, findings, notChecked, push, ...usage };
  const prov = collectionProvenance(cc);
  const sv = screenVariables(cc);
  foreignNameMap(cc, prov, sv);
  nameCollisions(cc, sv);
  danglingTokens(cc, sv);
  const { coverage, rekey, proposals } = catalogCoverage(cc);
  fontStrays(cc);
  textStyleStrays(cc);
  sentinelValues(cc);
  singleModeExport(cc, prov.screenColls);
  mixedModeBindings(screens, variables, tokens, push);
  contrastPerMode(screens, variables, tokens, push, cc.resolvedModes);
  contrastRendered(screens, variables, tokens, push);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const ids = findingIds(findings);
  findings.forEach((f, i) => {
    const id = ids[i];
    if (id !== void 0) f.id = id;
  });
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    coverage,
    // The confirmation list (catalog-rekeyed). Every entry starts unconfirmed; map-bootstrap.ts
    // --from-proposals stubs only the ones a person set "confirmed": true on.
    // Unconfirmed first (shared chrome before screen-only), already-mapped last.
    componentProposals: proposals,
    componentResidual: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.rows.filter((r) => !r.match).map((r) => ({ name: r.name, instances: r.instances, reasons: r.reasons })) : [],
    findings,
    notChecked,
    inputs: {
      screens: screens.map((s) => s.label),
      variables: !!variables,
      tokens: !!tokens,
      components: !!components,
      stylesText: !!stylesText
    }
  };
}
function screenUsage(screens) {
  const usedTokenNames = /* @__PURE__ */ new Map();
  const instances = [];
  const fonts = /* @__PURE__ */ new Map();
  const textStyles = /* @__PURE__ */ new Map();
  const resolvedModes = /* @__PURE__ */ new Map();
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const root of screenRoots(s.doc)) {
      if (root && root.resolvedModes) {
        for (const [coll, mode] of Object.entries(root.resolvedModes)) {
          getOrInit(resolvedModes, coll, () => /* @__PURE__ */ new Set()).add(mode);
        }
      }
      walkVisible(root, (n) => {
        for (const [field, name] of Object.entries(n.tokens || {})) {
          if (typeof name !== "string") continue;
          getOrInit(usedTokenNames, name, () => []).push({ screen: label, nodeId: n.id, field });
        }
        for (const f of n.fills || []) {
          const t = f && f.tokens && f.tokens.color;
          if (typeof t === "string") {
            getOrInit(usedTokenNames, t, () => []).push({ screen: label, nodeId: n.id, field: "fills" });
          }
        }
        if (n.font && n.font.family) fonts.set(n.font.family, (fonts.get(n.font.family) || 0) + 1);
        const ts = n.styles && n.styles.text;
        if (ts) textStyles.set(ts, (textStyles.get(ts) || 0) + 1);
      });
    }
  }
  const visible = [];
  screens.forEach((s) => {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    for (const i of visibleInstances(s.doc, label)) {
      visible.push(i);
      instances.push({ screen: label, nodeId: i.nodeId, name: i.layer, ...ifDefined("key", i.key), ...ifDefined("setKey", i.setKey), setName: i.name, propNames: Object.keys(i.props || {}) });
    }
  });
  return { usedTokenNames, instances, fonts, textStyles, resolvedModes, visible };
}
function collectionProvenance(cc) {
  const { input, tokens, variables, findings, notChecked, push, LIST_LIBRARIES, EXPORT_LIBRARY } = cc;
  const dsCollByKey = /* @__PURE__ */ new Map();
  const dsCollByName = /* @__PURE__ */ new Map();
  for (const c of tokens && tokens.collections || []) {
    if (c.key) dsCollByKey.set(c.key, c);
    if (c.name) dsCollByName.set(alnumKey(c.name), c);
  }
  const screenColls = variables && variables.collections || [];
  let foreignPatch = null;
  if (!tokens) {
    notChecked.push(
      "collection provenance \u2014 no design-system tokens.json was given, so nothing could verify that the screen's variables come from the design system you exported. Run `dtwin pull --design-system` and pass it."
    );
  } else if (!screenColls.length) {
    notChecked.push(
      input.variablesPath ? `collection provenance \u2014 ${input.variablesPath} was checked but carries no collections for this screen, so its own token library is unknown.` : `collection provenance \u2014 no variables.json was found (looked in design/export/variables.json), so the screen's own token library is unknown.`
    );
  } else {
    const foreign = [];
    for (const c of screenColls) {
      if (c.key && dsCollByKey.has(c.key)) continue;
      const twin = dsCollByName.get(alnumKey(c.name));
      foreign.push({ name: c.name, ...ifDefined("key", c.key), ...ifDefined("twinKey", twin && twin.key), ...ifDefined("twinName", twin && twin.name) });
    }
    if (foreign.length) {
      const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
      const all = foreign.length === screenColls.length;
      foreignPatch = {
        foreign,
        head: `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export \u2014 the screen consumes a DIFFERENT library than the one you pulled. ` + (sameNameDifferentKey.length ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key (${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: duplicating a library re-keys everything while leaving names and values identical. ` : "") + `Names and values may still line up (check the collisions below), but nothing here is the same variable. `,
        tail: `Only to find the owning file: run ${LIST_LIBRARIES} \u2014 variable collections are the ONE thing Figma attributes to a library by name \u2014 then open that file and ${EXPORT_LIBRARY}.`,
        at: findings.length
      };
      push(
        "warning",
        "foreign-token-library",
        foreignPatch.head + foreignPatch.tail,
        { collections: foreign, confirm: `${all ? "None" : `Only ${screenColls.length - foreign.length} of ${screenColls.length}`} of the screen's variable collections are in the design system you passed \u2014 is it the library this screen uses? Until confirmed, values come from the screen's own .vars.json.` }
      );
    } else {
      push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
    }
  }
  return { dsCollByKey, screenColls, foreignPatch };
}
function screenVariables(cc) {
  const { input, screens, tokens, variables } = cc;
  const dsVarByName = /* @__PURE__ */ new Map();
  for (const v of tokens && tokens.variables || []) if (v.name) dsVarByName.set(v.name, v);
  const sliceSources = input.sliceSources || null;
  const labels = screens.map((s) => s.label || screenExportOf(s.doc)?.screen || "screen");
  const own = screens.map((s) => s && s.vars && Array.isArray(s.vars.variables) ? s.vars.variables : null);
  let varScope = "own";
  let screenVars = [];
  const none = [];
  if (own.length && own.every((o) => !!o)) {
    screenVars = none.concat(...own);
  } else if (variables && sliceSources && sliceSources.size) {
    varScope = "union-by-source";
    screenVars = (variables && variables.variables || []).filter((v) => {
      const from = v.key ? sliceSources.get(v.key) : void 0;
      return !from || from.some((sc) => labels.includes(sc));
    });
  } else {
    varScope = "union";
    screenVars = variables && variables.variables || [];
  }
  const screenVarsByName = /* @__PURE__ */ new Map();
  for (const v of screenVars) {
    if (!v || !v.name) continue;
    const list = screenVarsByName.get(v.name);
    if (!list) screenVarsByName.set(v.name, [v]);
    else if (!list.some((x) => x.key && x.key === v.key || !x.key && !v.key && x.collection === v.collection)) list.push(v);
  }
  const screenVarByName = new Map([...screenVarsByName].map(([n, l]) => [n, l[0]]));
  const shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, 8) + "\u2026" : null;
  const fromWhere = (v) => {
    const sc = v && v.key && sliceSources && sliceSources.get(v.key);
    return sc && sc.length ? ` (from ${sc.join(", ")})` : "";
  };
  return { dsVarByName, sliceSources, varScope, screenVars, screenVarsByName, screenVarByName, shortKey, fromWhere };
}
function flatten(v) {
  const out = {};
  for (const [mode, val] of Object.entries(v && v.values || {})) {
    out[mode] = val && typeof val === "object" ? "aliasOf" in val ? "-> " + val.aliasOf : JSON.stringify(val) : String(val);
  }
  return out;
}
function valueSet(v) {
  return new Set(Object.values(flatten(v)));
}
function sameResolution(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const shared = Object.keys(fa).filter((m) => m in fb);
  if (shared.length) return shared.every((m) => fa[m] === fb[m]);
  const sa = valueSet(a), sb = valueSet(b);
  if (!sa.size || !sb.size) return null;
  for (const x of sa) if (sb.has(x)) return null;
  return false;
}
function foreignNameMap(cc, { dsCollByKey, screenColls, foreignPatch }, { screenVars, dsVarByName }) {
  const { findings } = cc;
  if (foreignPatch) {
    const fp = foreignPatch;
    const foreignNames = new Set(fp.foreign.map((f2) => f2.name));
    const foreignKeys = new Set(fp.foreign.map((f2) => f2.key).filter((k) => !!k));
    const screenKeys = new Set(screenColls.map((c) => c.key).filter((k) => !!k));
    const sharedNames = new Set(screenColls.filter((c) => c.key && dsCollByKey.has(c.key) && foreignNames.has(c.name)).map((c) => c.name));
    const nameMap = { agree: 0, differ: 0, undecidable: 0, absent: 0 };
    let ambiguous = 0;
    const seen = /* @__PURE__ */ new Set();
    for (const v of screenVars) {
      if (!v || !v.name || !v.collection) continue;
      const byKey = !!v.collectionKey && screenKeys.has(v.collectionKey);
      if (byKey ? !foreignKeys.has(v.collectionKey ?? "") : !foreignNames.has(v.collection)) continue;
      const id = v.key || `${v.collection}\0${v.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!byKey && sharedNames.has(v.collection)) ambiguous++;
      const dv = dsVarByName.get(v.name);
      if (!dv) {
        nameMap.absent++;
        continue;
      }
      const r = sameResolution(v, dv);
      if (r === true) nameMap.agree++;
      else if (r === false) nameMap.differ++;
      else nameMap.undecidable++;
    }
    const n = seen.size;
    let offline = "";
    if (n) {
      offline = `Offline check (no Figma needed): of the ${n} variables in those collections, ${nameMap.agree} have a design-system variable of the same name resolving the same in every shared mode, ${nameMap.differ} resolve differently (listed as token-name-collision), ${nameMap.undecidable} cannot be compared (no shared mode), ${nameMap.absent} have no same-name variable. ` + (nameMap.differ === 0 && nameMap.agree > 0 ? `Mapping by NAME is safe for the ${nameMap.agree}: the screen's own .vars.json is the ground truth for names and values. ` : "") + (nameMap.agree === 0 && nameMap.absent === n ? `None of them exists here by name \u2014 this is not the screen's library; pull the one it uses. ` : "") + (ambiguous ? `(${ambiguous} of them come from a collection whose name a design-system collection also has \u2014 this export predates collection keys on variables; re-pull to tell them apart.) ` : "");
    }
    const f = findings[fp.at];
    if (f) {
      f.message = fp.head + offline + fp.tail;
      f.nameMap = ambiguous ? { ...nameMap, ambiguous } : nameMap;
    }
  }
}
function nameCollisions(cc, vars) {
  const { tokens, usedTokenNames, push } = cc;
  const { dsVarByName, varScope, screenVarsByName, screenVarByName, shortKey, fromWhere } = vars;
  if (tokens && screenVarByName.size) {
    const collisions = [], missing = [];
    for (const [name, list] of screenVarsByName) {
      const dv = dsVarByName.get(name);
      if (!dv) {
        let near = null;
        for (const dname of dsVarByName.keys()) if (alnumKey(dname) === alnumKey(name) && dname !== name) {
          near = dname;
          break;
        }
        if (usedTokenNames.has(name) || near) missing.push({ name, near });
        continue;
      }
      for (const sv of list) {
        if (sameResolution(sv, dv) === false) {
          collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
        }
      }
    }
    const dsByNorm = /* @__PURE__ */ new Map();
    for (const [dname, dv] of dsVarByName) {
      const k = alnumKey(dname);
      getOrInit(dsByNorm, k, () => []).push({ name: dname, v: dv });
    }
    for (const [name, list] of screenVarsByName) {
      if (dsVarByName.has(name)) continue;
      for (const cand of dsByNorm.get(alnumKey(name)) || []) {
        for (const sv of list) {
          if (sameResolution(sv, cand.v) === false) {
            collisions.push({ name, ...ifDefined("key", sv.key), twins: list, sv, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
          }
        }
      }
    }
    const scopeNote = varScope === "own" ? "" : varScope === "union-by-source" ? " (read from the merged variables.json, restricted to the variables its slice records for this screen \u2014 pass the screen's .vars.json to be exact)" : " (read from the MERGED variables.json: this screen's own .vars.json was not available, so this may be another screen's variable \u2014 check its key)";
    for (const c of collisions) {
      const twinNote = c.twins.length > 1 ? ` This screen's own variables include ${c.twins.length} DIFFERENT variables called '${c.name}': ` + c.twins.map((t) => `${shortKey(t) ? "key " + shortKey(t) : "'" + (t.collection || "") + "'"} = ${JSON.stringify(flatten(t))}${fromWhere(t)}`).join(" vs ") + ` \u2014 only the one(s) listed as colliding differ from the design system.` : "";
      const used = c.usedAt.length > 0;
      const message = `The screen's '${c.name}'${shortKey(c.sv) ? ` (key ${shortKey(c.sv)})` : ""} and the design system's '${c.alsoKnownAs || c.name}' ${c.alsoKnownAs ? "differ only by case or punctuation" : "share a name"} but resolve DIFFERENTLY: screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` + (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " \u2014 no mode name is shared and the two value sets are disjoint. ") + `Slugging the name onto the existing token would silently apply the wrong value \u2014 namespace the screen's copy, or confirm which library is authoritative.` + twinNote + scopeNote;
      const extra = { token: c.name, ...ifDefined("key", c.key), ...ifDefined("alsoKnownAs", c.alsoKnownAs), screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt, scope: varScope };
      if (used) push("blocker", "token-name-collision", message, extra);
      else push("warning", "token-name-collision", message, { ...extra, confirm: `'${c.name}' has different values here and in the design system, but no visible layer on this screen binds it \u2014 which one is authoritative if it is used later?` });
    }
    collisionsElsewhere(cc, vars);
    if (missing.length) {
      push(
        "warning",
        "token-absent-from-design-system",
        `${missing.length} token name(s) the screen binds do not exist in the design-system export` + (missing.some((m) => m.near) ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation \u2014 e.g. ` + missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")" : "") + `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", \u2026" : ""}. Build these as literals with a recorded decision \u2014 do not invent a design-system token for them.`,
        { tokens: missing }
      );
    }
  }
}
function collisionsElsewhere(cc, sv) {
  const { variables, push } = cc;
  const { sliceSources, varScope, screenVars, shortKey, fromWhere } = sv;
  if (variables && varScope !== "union") {
    const mine = new Set(screenVars.map((v) => v.key).filter(Boolean));
    const unionByName = /* @__PURE__ */ new Map();
    for (const v of variables && variables.variables || []) {
      if (!v || !v.name || !v.key) continue;
      getOrInit(unionByName, v.name, () => /* @__PURE__ */ new Map()).set(v.key, v);
    }
    for (const [name, byKey] of unionByName) {
      if (byKey.size < 2) continue;
      const all = [...byKey.values()];
      const others = all.filter((v) => !mine.has(v.key));
      if (!others.length) continue;
      if (new Set(all.flatMap((v) => Object.values(flatten(v)))).size <= 1) continue;
      if (all.every((v) => JSON.stringify(flatten(v)) === JSON.stringify(flatten(all[0])))) continue;
      const ours = all.filter((v) => mine.has(v.key));
      push(
        "info",
        "token-name-collision-elsewhere",
        `'${name}' is ${all.length} different variables in the merged variables.json \u2014 ` + all.map((v) => `key ${shortKey(v)} = ${JSON.stringify(flatten(v))}${fromWhere(v)}`).join(" vs ") + ". " + (ours.length ? `THIS screen's own variables carry only key ${ours.map(shortKey).join(", ")}, so the ambiguity belongs to ${[...new Set(others.flatMap((v) => sliceSources && v.key && sliceSources.get(v.key) || []))].join(", ") || "another screen"} \u2014 do not change this screen's value to match it.` : `THIS screen carries none of them.`) + ` Generate this screen's theme from its own .vars.json (or design-system/tokens.json), not from the union.`,
        { token: name, keys: all.map((v) => v.key), mine: ours.map((v) => v.key) }
      );
    }
  }
}
function danglingTokens(cc, { dsVarByName, varScope, screenVarByName }) {
  const { variables, usedTokenNames, push } = cc;
  if (variables || varScope === "own") {
    const dangling = [];
    for (const name of usedTokenNames.keys()) {
      if (screenVarByName.has(name) || dsVarByName.has(name)) continue;
      dangling.push(name);
    }
    if (dangling.length) {
      push(
        "warning",
        "unresolvable-token",
        `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/export/variables.json nor the design-system export: ${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", \u2026" : ""}. Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
        { tokens: dangling }
      );
    }
  }
}
function catalogCoverage(cc) {
  const { input, components, componentsLibrary, catFile, EXPORT_LIBRARY, visible, instances, notChecked, push } = cc;
  let rekey = null;
  let proposals = [];
  const coverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
  const localComps = components && components.components || [];
  const localKeys = new Set(localComps.map((c) => c.key).filter((k) => !!k));
  const catalog = localComps.concat(componentsLibrary && componentsLibrary.components || []);
  if (!catalog.length) {
    notChecked.push(`component coverage \u2014 no ${catFile} was given, so every instance counts as new by default.`);
  } else if (!instances.length) {
    notChecked.push("component coverage \u2014 the screen export contains no INSTANCE nodes to compare.");
  } else {
    rekey = coverageEntries(cc, coverage, localComps, localKeys, catalog);
    coverage.pct = Math.round(coverage.matchedByKey / coverage.distinct * 100);
    coverage.localPct = Math.round(coverage.matchedByLocalKey / coverage.distinct * 100);
    const rekeyedBy = rekey && coverage.localPct <= WRONG_CATALOG_PCT && isRekeyed(rekey) ? rekey : null;
    const rekeyed = !!rekeyedBy;
    coverage.rekey = rekey ? Object.assign({ rekeyed }, rekey.summary) : null;
    const proposedNames = new Set(rekeyedBy ? rekeyedBy.proposals.map((r) => r.name) : []);
    const buckets = { localKey: 0, libraryKey: 0, proposed: 0, nameOnly: 0, ambiguous: 0, newWork: 0 };
    for (const e of coverage.entries) {
      const b = e.matchedBy === "key" ? e.scope === "local" ? "localKey" : "libraryKey" : proposedNames.has(e.setName) ? "proposed" : e.matchedBy === "name" ? "nameOnly" : e.ambiguous ? "ambiguous" : "newWork";
      e.bucket = b;
      buckets[b]++;
    }
    coverage.buckets = buckets;
    const hiddenOnly = hiddenOnlyComponents(cc);
    coverage.hiddenOnly = hiddenOnly.size;
    if (rekeyedBy) {
      const s = rekeyedBy.summary;
      proposals = labelProposals(rekeyedBy, visible, input.map || null, input.siblings || null);
      const props = proposals;
      const mapped = props.filter((p) => p.alreadyMapped).length, toConfirm = props.length - mapped;
      const shared = props.filter((p) => !p.alreadyMapped && (p.sharedWith || 0) > 0).length;
      const residual = rekeyedBy.rows.filter((r) => !r.match);
      push(
        "warning",
        "catalog-rekeyed",
        `0 of ${s.names} component(s) on this screen resolve to ${catFile} by key, but ${s.proposed} of the ${s.withCandidates} whose NAME is in the catalog also match it by prop signature (variant axes + values, prop names + types)${s.remote ? `, and ${s.remote} of the ${s.instances} visible instance(s) say remote:true` : ""}. That is not a foreign library \u2014 it is the SAME components under new keys: one or both Figma files are duplicates (duplicating a file re-mints every component key), or the library was re-published. Proposed matches (confirm each before reuse \u2014 nothing is auto-accepted): ` + props.slice(0, 12).map((r) => `'${r.name}' \u2192 ${r.catalog ? r.catalog.id : "?"}${r.evidence === "name+no-props" ? " (no props to compare \u2014 weaker)" : ""}${r.tie === "duplicate-definitions" ? " (duplicate definitions, harmless tie)" : ""}${r.alreadyMapped ? " (already mapped)" : ""}`).join(", ") + (props.length > 12 ? `, \u2026 (${props.length} in all \u2014 see componentProposals)` : "") + `. ` + // Labels only — what is already in the map, and what other exported screens share
        (mapped ? toConfirm ? `${props.length} proposals, ${mapped} already mapped in the component map \u2014 confirm only the other ${toConfirm}. ` : `All ${props.length} proposals are already mapped in the component map \u2014 nothing is left to confirm. ` : "") + (shared ? `${shared} of the proposals to confirm are on other exported screens too (shared chrome) \u2014 confirm those once. ` : "") + `${residual.length} name(s) are not in ${catFile}` + (buckets.libraryKey ? ` \u2014 of the table's rows, ${buckets.libraryKey} are third-party components.library.json key matches and ${buckets.newWork} new work` : ` and stay new work`) + (residual.length ? ` (${residual.slice(0, 5).map((r) => `'${r.name}'`).join(", ")}${residual.length > 5 ? ", \u2026" : ""})` : "") + `. To use them: show the user the list, set "confirmed": true on each accepted entry of componentProposals in this report's JSON, then run the map-bootstrap script (\`<${catFile}> --out design/codeconnect.local.json --from-proposals <this report>.json\`) \u2014 it stubs ONLY the confirmed ones, keyed by the screen's own instance key.`,
        { rekey: s, proposals: props.length, confirm: `${toConfirm} component(s) match the catalog by name and prop signature but not by key (a duplicated or re-published file)${mapped ? ` \u2014 ${mapped} more are already mapped` : ""} \u2014 confirm the proposed matches before reusing them as mappings.` }
      );
    } else if (coverage.localPct <= WRONG_CATALOG_PCT) {
      push(
        "warning",
        "catalog-covers-nothing",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in ${catFile} by key \u2014 the catalog you exported is not the library this screen is built from. ` + (coverage.matchedByKey > coverage.matchedByLocalKey ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. ` : "") + (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") + (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") + `A "318/318 mapped" count measures the catalog against itself and means nothing here. To find the owning library: open any instance in Figma and use right-click > "Go to main component" \u2014 it jumps to the file that defines it. Then connect that file and ${EXPORT_LIBRARY}. Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.` + (rekey && rekey.summary.withCandidates ? ` (Checked for the duplicated-file case too: only ${rekey.summary.proposedWithSignature} of the ${rekey.summary.withCandidates} name twin(s) also agree on prop signature \u2014 too few to call it the same library under new keys.)` : ""),
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct }, confirm: `Only ${coverage.localPct}% of this screen's components are in ${catFile} by key \u2014 is that the component library this screen is built from? Until confirmed, every instance is new work.` }
      );
    } else if (coverage.localPct < 100) {
      push(
        "warning",
        "partial-catalog-coverage",
        `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to ${catFile} by key` + (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") + `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
        { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
      );
    } else {
      push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to ${catFile} by key.`, {});
    }
    nameMatchFindings(cc, coverage, proposedNames);
  }
  return { coverage, rekey, proposals };
}
function coverageEntries(cc, coverage, localComps, localKeys, catalog) {
  const { components, componentsLibrary, visible, instances, catFile } = cc;
  const byKey = /* @__PURE__ */ new Map();
  for (const c of catalog) if (c.key) byKey.set(c.key, c);
  const rekey = localComps.length ? matchByNameAndSignature(visible, components, componentsLibrary) : null;
  const rowByName = new Map((rekey ? rekey.rows : []).map((r) => [r.name, r]));
  const distinct = /* @__PURE__ */ new Map();
  for (const i of instances) {
    const id = i.setKey || i.key || "name:" + alnumKey(i.setName);
    getOrInit(distinct, id, () => Object.assign({ count: 0 }, i)).count++;
  }
  coverage.distinct = distinct.size;
  for (const i of distinct.values()) {
    const byKeyHit = i.setKey && byKey.get(i.setKey) || i.key && byKey.get(i.key);
    if (byKeyHit) {
      coverage.matchedByKey++;
      const local = !!byKeyHit.key && localKeys.has(byKeyHit.key);
      if (local) coverage.matchedByLocalKey++;
      coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
      continue;
    }
    const row = rowByName.get(i.setName);
    const verdict = row ? nameVerdict(row) : null;
    const matched = row && verdict && verdict.status === "matched" ? row.match : null;
    if (row && matched) {
      coverage.matchedByName++;
      const cat = localComps.find((c) => matched.key ? c.key === matched.key : matched.id !== void 0 && c.id === matched.id);
      const props = Object.keys(cat && cat.props || {}).map((p) => alnumKey(String(p).split("#")[0]));
      const hit = i.propNames.filter((p) => props.includes(alnumKey(String(p).split("#")[0]))).length;
      coverage.entries.push({
        setName: i.setName,
        ...ifDefined("key", i.setKey || i.key),
        matchedBy: "name",
        verified: false,
        catalogName: matched.name,
        ...ifDefined("catalogKey", matched.key),
        ...ifDefined("evidence", row.evidence),
        propOverlap: `${hit}/${i.propNames.length}`,
        instances: i.count
      });
    } else if (row && verdict && verdict.status === "ambiguous") {
      coverage.ambiguousName++;
      coverage.entries.push({ setName: i.setName, ...ifDefined("key", i.setKey || i.key), matchedBy: null, ambiguous: true, candidates: (row.candidates || []).length, reason: verdict.reason, instances: i.count });
    } else {
      coverage.unmatched++;
      coverage.entries.push({
        setName: i.setName,
        ...ifDefined("key", i.setKey || i.key),
        matchedBy: null,
        verified: false,
        reason: verdict ? verdict.reason : `no ${catFile} to match names against (a components.library.json name alone is not a match)`,
        instances: i.count
      });
    }
  }
  return rekey;
}
function hiddenOnlyComponents(cc) {
  const { screens, instances } = cc;
  const visibleSets = new Set(instances.map((i) => i.setKey || i.key || "name:" + alnumKey(i.setName)));
  const hiddenOnly = /* @__PURE__ */ new Set();
  const everyInstance = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "INSTANCE" && n.mainComponent) {
      const mc = n.mainComponent, id = mc.setKey || mc.key || "name:" + alnumKey(mc.setName || mc.name);
      if (!visibleSets.has(id)) hiddenOnly.add(id);
    }
    for (const c of n.children || []) everyInstance(c);
  };
  for (const s of screens) for (const root of screenRoots(s.doc)) everyInstance(root);
  return hiddenOnly;
}
function nameMatchFindings(cc, coverage, proposedNames) {
  const { push } = cc;
  const named = coverage.entries.filter((e) => e.matchedBy === "name" && !proposedNames.has(e.setName));
  if (named.length) {
    push(
      "info",
      "name-matched-components",
      `${named.length} component(s) have no key in the catalog but DO have an exact name twin there whose prop signature agrees: ` + named.slice(0, 10).map((e) => `'${e.setName}' (${e.evidence === "name+no-props" ? "no props to compare" : `props ${e.propOverlap}`})`).join(", ") + (named.length > 10 ? `, \u2026` : "") + `. Mapped BY NAME, UNVERIFIED \u2014 confirm one with "Go to main component" before reusing any of their code; if that one instance points at the catalog's file, the rest almost certainly do too.`,
      { components: named.map((e) => ({ setName: e.setName, ...ifDefined("catalogName", e.catalogName), ...ifDefined("catalogKey", e.catalogKey), ...ifDefined("propOverlap", e.propOverlap), verified: false })) }
    );
  }
  const amb = coverage.entries.filter((e) => e.ambiguous && !proposedNames.has(e.setName));
  const firstAmb = amb[0];
  if (firstAmb) {
    push(
      "warning",
      "ambiguous-component-name",
      `${amb.length} component(s) share their name with SEVERAL catalog entries, and no prop signature picks one of them, so they were left unmatched on purpose: ` + amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", \u2026" : "") + `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed \u2014 binding code to one of them by name would be a guess with a 1-in-${firstAmb.candidates} chance.`,
      { components: amb.map((e) => ({ setName: e.setName, ...ifDefined("candidates", e.candidates) })) }
    );
  }
}
function fontStrays(cc) {
  const { stylesText, fonts, push } = cc;
  const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
  const [main2, ...strays] = sorted;
  if (fonts.size > 1 && main2) {
    const [mainFamily, mainCount] = main2;
    const total = sorted.reduce((n, [, c]) => n + c, 0);
    push(
      "warning",
      "font-family-stray",
      `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. '${mainFamily}' carries ${mainCount}; the rest are strays \u2014 usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
      { families: sorted.map(([family, count]) => ({ family, count })) }
    );
  }
  if (stylesText && fonts.size) {
    const dsFamilies = new Set(stylesText.styles.map((s) => s.font).filter((f) => !!f));
    const foreign = [...fonts.keys()].filter((f) => dsFamilies.size && !dsFamilies.has(f));
    if (foreign.length) {
      push(
        "warning",
        "font-not-in-design-system",
        `font ${foreign.map((f) => `'${f}'`).join(", ")} appears on the screen but NO design-system text style uses it (the design system's text styles are all ${[...dsFamilies].join(", ")}). Nothing in the export declares a font file or a webfont for either, so "is it installed and licensed" is a question only the designer can answer.`,
        { fonts: foreign, designSystemFonts: [...dsFamilies] }
      );
    }
  }
}
function textStyleStrays(cc) {
  const { stylesText, textStyles, push } = cc;
  if (stylesText && stylesText.styles && textStyles.size) {
    const dsByName = new Map((stylesText.styles || []).map((s) => [s.name, s]));
    const dsNorm = /* @__PURE__ */ new Map();
    for (const s of stylesText.styles || []) dsNorm.set(alnumKey(s.name), s.name);
    const absent = [], nearMiss = [];
    for (const name of textStyles.keys()) {
      if (dsByName.has(name)) continue;
      const near = dsNorm.get(alnumKey(name));
      if (near) nearMiss.push({ name, near });
      else absent.push(name);
    }
    if (nearMiss.length) {
      push(
        "warning",
        "text-style-near-miss",
        `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` + nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") + `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
        { styles: nearMiss, confirm: `${nearMiss.map((n) => `'${n.name}' = '${n.near}'`).join(", ")} \u2014 the same style? Until confirmed, use the screen's own text values, not the design-system style.` }
      );
    }
    if (absent.length) {
      push(
        "warning",
        "text-style-absent",
        `${absent.length} of ${textStyles.size} text style(s) used on the screen are not in the design-system export: ` + absent.slice(0, 8).map((n) => "'" + n + "'").join(", ") + (absent.length > 8 ? ", \u2026" : "") + ".",
        { styles: absent }
      );
    }
  }
}
function sentinelValues(cc) {
  const { tokens, variables, push } = cc;
  const absurd = [];
  const seenAbsurd = /* @__PURE__ */ new Set();
  const allVars = (tokens && tokens.variables || []).concat(variables && variables.variables || []);
  for (const v of allVars) {
    for (const [mode, val] of Object.entries(v && v.values || {})) {
      const n = typeof val === "number" ? val : val && typeof val === "object" && "value" in val && typeof val.value === "number" ? val.value : null;
      if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
      const id = JSON.stringify([v.collection ?? null, v.name, mode]);
      if (seenAbsurd.has(id)) continue;
      seenAbsurd.add(id);
      absurd.push({ name: v.name, collection: v.collection, mode, value: n });
    }
  }
  const firstAbsurd = absurd[0];
  if (firstAbsurd) {
    push(
      "warning",
      "sentinel-token-value",
      `${absurd.length} token value(s) are sentinels, not measurements: ` + absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", \u2026" : "") + `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) \u2014 never as \`${firstAbsurd.value}px\`.`,
      { tokens: absurd }
    );
  }
}
function singleModeExport(cc, screenColls) {
  const { tokens, variables, resolvedModes, push } = cc;
  const multiModeColls = [];
  const seenColl = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(screenColls);
  for (const c of allColls) {
    if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
    if (seenColl.has(c.name)) continue;
    seenColl.add(c.name);
    multiModeColls.push(c);
  }
  for (const c of multiModeColls) {
    const seen = resolvedModes.get(c.name);
    if (!seen || !seen.size) continue;
    const only = seen.size === 1 ? [...seen][0] : void 0;
    if (only !== void 0 && c.modes.length > 1) {
      const rest = c.modes.filter((m) => m !== only);
      const colour = [...tokens && tokens.variables || [], ...variables && variables.variables || []].some((v) => v.collection === c.name && v.type === "COLOR");
      const example = colour ? "a dark surface token that stays dark in Light" : `a size or spacing value that should differ in '${rest[0] ?? "another mode"}' but keeps its '${only}' value`;
      push(
        "warning",
        "single-mode-export",
        `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered \u2014 so any element whose ${only}-mode token has no sensible counterpart (${example}) will be mechanically correct and visually broken. Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
        { collection: c.name, exportedMode: only, modes: c.modes }
      );
    }
  }
}
function labelProposals(rekey, visible, map, siblings) {
  const mapKeys = /* @__PURE__ */ new Set();
  for (const [k, e] of Object.entries(map && map.components || {})) {
    mapKeys.add(k);
    if (e && e.figma && e.figma.key) mapKeys.add(e.figma.key);
  }
  const keysOf = /* @__PURE__ */ new Map();
  for (const i of visible) {
    const ks = getOrInit(keysOf, i.name, () => /* @__PURE__ */ new Set());
    if (i.key) ks.add(i.key);
    if (i.setKey) ks.add(i.setKey);
  }
  const others = rekey.proposals.length && siblings ? siblings().map((s) => {
    const ks = /* @__PURE__ */ new Set();
    for (const i of visibleInstances(s.doc, s.label)) {
      if (i.key) ks.add(i.key);
      if (i.setKey) ks.add(i.setKey);
    }
    return ks;
  }) : null;
  const out = rekey.proposals.map((r) => {
    const keys = keysOf.get(r.name) || new Set(r.instanceKeys);
    const mapped = [...keys].some((k) => mapKeys.has(k));
    return {
      name: r.name,
      instances: r.instances,
      screens: r.screens,
      instanceKeys: r.instanceKeys,
      remote: r.remote,
      catalog: r.match,
      ...ifDefined("evidence", r.evidence),
      tie: r.tie || null,
      alternatives: r.alternatives,
      reasons: r.reasons,
      confirmed: false,
      ...mapped ? { alreadyMapped: true } : {},
      ...ifDefined("sharedWith", others ? others.filter((o) => [...keys].some((k) => o.has(k))).length : void 0)
    };
  });
  const rank = (p) => p.alreadyMapped ? 2 : (p.sharedWith || 0) > 0 ? 0 : 1;
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || (b.p.sharedWith || 0) - (a.p.sharedWith || 0) || a.i - b.i).map((x) => x.p);
}
var MIN_CONTRAST = 4.5;
function contrastPerMode(screens, variables, tokens, push, resolvedModes) {
  if (![variables, tokens].some((d) => (d && d.variables || []).length)) return;
  const vars = variableResolver([variables, tokens]);
  const resolve = (name, mode) => vars.colour(vars.target(name), { mode, fallback: "none" });
  const modes = /* @__PURE__ */ new Set();
  const allColls = (tokens && tokens.collections || []).concat(variables && variables.collections || []);
  for (const c of allColls) {
    for (const m of c && c.modes || []) modes.add(m);
  }
  const rendered = /* @__PURE__ */ new Set();
  for (const set of (resolvedModes || /* @__PURE__ */ new Map()).values()) for (const m of set) rendered.add(m);
  for (const m of rendered) modes.delete(m);
  if (!modes.size) return;
  if (!rendered.size) return;
  const pairs = /* @__PURE__ */ new Map();
  for (const s of screens) {
    for (const root of screenRoots(s.doc)) {
      walkVisible(root, (n, ctx) => {
        const bgToken = ctx.backdrop.token;
        if (n.type !== "TEXT" || !bgToken) return;
        const fg = n.tokens && (n.tokens.fills || n.tokens.textRangeFills) || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
        if (!fg || typeof fg !== "string") return;
        const key = fg + "|" + bgToken;
        const pair = getOrInit(pairs, key, () => ({ fg, bg: bgToken, nodes: [], sample: n.name }));
        if (pair.nodes.length < 4) pair.nodes.push(n.id);
      });
    }
  }
  if (!pairs.size) return;
  const failures = [];
  for (const p of pairs.values()) {
    for (const mode of modes) {
      const fg = resolve(p.fg, mode);
      const bg = resolve(p.bg, mode);
      if (!fg || !bg) continue;
      const r = contrastRatio(fg.a < 1 ? compositeOver(fg, bg) : fg, bg);
      if (r >= MIN_CONTRAST) continue;
      failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
    }
  }
  if (!failures.length) return;
  const byMode = /* @__PURE__ */ new Map();
  for (const f of failures) {
    getOrInit(byMode, f.mode, () => []).push(f);
  }
  for (const [mode, list] of byMode) {
    push(
      "warning",
      "derived-mode-contrast",
      `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` + list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") + (list.length > 4 ? ", \u2026" : "") + `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered \u2014 the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say which token each of these should use there. Do not invent an override and call it done.`,
      { mode, pairs: list, confirm: `Mode '${mode}' was never drawn and ${list.length} derived text/background pair(s) in it fail contrast \u2014 ship '${mode}' as derived, or will the designer supply it?` }
    );
  }
}
function fillToken(n) {
  const own = n.tokens && n.tokens.fills || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
  return own && typeof own === "string" ? own : null;
}
function textToken(n) {
  const t = n.tokens || {}, tt = n.textTokens || {};
  for (const x of [t.fills, t.textRangeFills, fillToken(n), tt.fills]) if (typeof x === "string" && x) return x;
  return null;
}
function colourBindings(n) {
  const out = [];
  const add = (x) => {
    for (const s of Array.isArray(x) ? x : [x]) if (typeof s === "string" && s && !out.includes(s)) out.push(s);
  };
  for (const [k, v] of Object.entries(n.tokens || {})) if (/fill|stroke/i.test(k)) add(v);
  for (const f of n.fills || []) add(f && f.tokens && f.tokens.color);
  add((n.textTokens || {}).fills);
  return out;
}
function mixedModeBindings(screens, variables, tokens, push) {
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    const defs = /* @__PURE__ */ new Map();
    for (const doc of [tokens, variables, s.vars || null]) for (const v of doc && doc.variables || []) if (v.name) defs.set(v.name, v);
    const colls = [...s.vars && s.vars.collections || [], ...variables && variables.collections || [], ...tokens && tokens.collections || []];
    const collOf = (v) => {
      const keyed = v.collectionKey ? colls.find((c) => c.key === v.collectionKey && Array.isArray(c.modes)) : void 0;
      if (keyed) return keyed;
      const named = colls.filter((c) => c.name === v.collection && Array.isArray(c.modes));
      const modes = Object.keys(v.values || {});
      return named.find((c) => modes.every((m) => c.modes.includes(m))) ?? named[0];
    };
    for (const root of screenRoots(s.doc)) {
      const rm = root.resolvedModes;
      if (!rm) continue;
      const use = /* @__PURE__ */ new Map();
      walkVisible(root, (n) => {
        for (const name of colourBindings(n)) {
          const v = defs.get(name);
          if (!v || v.type !== "COLOR") continue;
          const c = collOf(v);
          const mode = c ? rm[c.name] : void 0;
          if (!c || c.modes.length < 2 || mode === void 0) continue;
          const u = getOrInit(use, c.name, () => ({ coll: c, mode, count: 0, tokens: [], nodes: [], samples: [] }));
          u.count++;
          if (!u.tokens.includes(name) && u.tokens.length < 20) u.tokens.push(name);
          if (!u.nodes.includes(n.id) && u.nodes.length < 8) u.nodes.push(n.id);
          if (u.samples.length < 3) u.samples.push(`'${name}' on '${n.name}'`);
        }
      });
      const groups = [];
      for (const u of use.values()) {
        const joined = groups.filter((g) => g.some((o) => o.coll.modes.some((m) => u.coll.modes.includes(m))));
        const merged = [...joined.flat(), u];
        for (const g of joined) groups.splice(groups.indexOf(g), 1);
        groups.push(merged);
      }
      for (const group of groups) {
        const perMode = /* @__PURE__ */ new Map();
        for (const u of group) perMode.set(u.mode, (perMode.get(u.mode) || 0) + u.count);
        if (perMode.size < 2) continue;
        const [major] = [...perMode].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
        if (major === void 0) continue;
        const majority = group.filter((u) => u.mode === major);
        const minority = group.filter((u) => u.mode !== major && u.coll.modes.includes(major));
        const first = minority[0];
        if (!first) continue;
        const names = (list) => list.map((u) => `'${u.coll.name}'`).join(", ");
        const minModes = [...new Set(minority.map((u) => `'${u.mode}'`))].join("/");
        push(
          "warning",
          "mixed-mode-bindings",
          `'${label}' renders ${names(majority)} in '${major}' (\xD7${perMode.get(major)} bindings) but ` + minority.map((u) => `'${u.coll.name}' in '${u.mode}' (\xD7${u.count}: ${u.samples.join(", ")}${u.count > u.samples.length ? " \u2026" : ""})`).join(", ") + ` \u2014 ${minority.length > 1 ? "tokens from these collections show their" : `a token from '${first.coll.name}' shows its`} ${minModes} value in a '${major}' screen. Pin ${names(minority)} to '${major}' in Figma (the frame's variable mode), or alias these tokens under a role name in code \u2014 a theme built from one mode per collection gives them their '${major}' value, which nobody drew.`,
          {
            ...ifDefined("nodeId", first.nodes[0]),
            // the first node binding a minority-mode token
            bindings: [...majority, ...minority].map((u) => ({ collection: u.coll.name, mode: u.mode, tokens: u.tokens, nodes: u.nodes })),
            confirm: `'${label}' binds ${minority.reduce((k, u) => k + u.count, 0)} colour token(s) from ${names(minority)} in ${minModes} while the rest of the screen is '${major}' \u2014 intended, or should they follow '${major}'? Until confirmed, build what was drawn (the ${minModes} values).`
          }
        );
      }
    }
  }
}
var LARGE_TEXT_PX = 24;
var LARGE_BOLD_TEXT_PX = 18.66;
var NON_TEXT_CONTRAST = 3;
function isLargeText(n) {
  const f = n.font;
  const size = f && typeof f.size === "number" ? f.size : 0;
  const bold = !!f && (typeof f.weightValue === "number" ? f.weightValue >= 700 : /(^|\s)(extra\s*)?(bold|black|heavy)/i.test(f.weight || "") && !/semi|demi/i.test(f.weight || ""));
  return size >= LARGE_TEXT_PX || size >= LARGE_BOLD_TEXT_PX && bold;
}
var isDisabledVariant = (n) => n.type === "INSTANCE" && isDisabledLayer(n);
function contrastRendered(screens, variables, tokens, push) {
  const rows = /* @__PURE__ */ new Map();
  for (const s of screens) {
    const label = s.label || screenExportOf(s.doc)?.screen || "screen";
    const docs = [s.vars || null, variables, tokens];
    if (!docs.some((d) => (d && d.variables || []).length)) continue;
    const vars = variableResolver(docs);
    for (const root of screenRoots(s.doc)) {
      const req = { byCollection: root.resolvedModes || {}, fallback: "default" };
      const resolve = (name) => vars.colour(vars.target(name), req);
      const modeLabel = (...names) => {
        const ms = [];
        for (const nm of names) {
          const v = vars.target(nm);
          const m = v && Object.keys(v.values || {}).length > 1 ? vars.modeOf(v, req) : void 0;
          if (m !== void 0 && !ms.includes(m)) ms.push(m);
        }
        return ms.join("/") || "single mode";
      };
      const check = (kind, fgTok, bgTok, required, nodeId) => {
        const fg = resolve(fgTok), bg = resolve(bgTok);
        if (!fg || !bg) return;
        if (kind === "non-text" && fg.a <= 0) return;
        const r = contrastRatio(fg.a < 1 ? compositeOver(fg, bg) : fg, bg);
        if (r >= required) return;
        const mode = modeLabel(fgTok, bgTok);
        const row = getOrInit(rows, [kind, fgTok, bgTok, mode].join("\0"), () => ({ kind, fg: fgTok, bg: bgTok, mode, ratio: Number(r.toFixed(2)), required, screens: [], nodes: [] }));
        if (!row.screens.includes(label)) row.screens.push(label);
        if (row.nodes.length < 4 && !row.nodes.includes(nodeId)) row.nodes.push(nodeId);
      };
      walkVisible(root, (n, ctx) => {
        if (isDisabledVariant(n) || ctx.ancestors.some((a) => isDisabledVariant(a.node))) return;
        const above = ctx.backdrop.token;
        if (n.type === "TEXT") {
          const fg = textToken(n);
          if (fg && above) check("text", fg, above, isLargeText(n) ? NON_TEXT_CONTRAST : MIN_CONTRAST, n.id);
        } else if (n.type !== "LINE") {
          const st = n.tokens && n.tokens.strokes;
          const w = n.strokes ? Math.max(n.strokes.weight || 0, ...Object.values(n.strokes.weights || {}).map((x) => x || 0)) : 0;
          const colours = n.strokes && n.strokes.colors || [];
          const painted = !colours.length || colours.some((c) => {
            const x = parseHex(c);
            return !x || x.a > 0;
          });
          const frames = [...ctx.ancestors, { node: n, hidden: false, backdrop: ctx.backdrop, beneath: ctx.beneath }];
          const outer = typeof st === "string" && st && w > 0 && painted ? outermostControl(frames.slice(-4).reverse().map((f) => f.node)) : -1;
          const inside2 = outer < 0 ? [] : frames.slice(frames.length - 1 - outer);
          const outside = inside2[0]?.backdrop.token ?? null;
          const bg = outside ? resolve(outside) : null;
          if (typeof st === "string" && outside && bg) {
            const inner = paintedOver(bg, inside2.flatMap((f, i) => [...i > 0 ? f.beneath : [], f.node]), resolve);
            const rescued = !!inner && contrastRatio(inner.color, bg) >= NON_TEXT_CONTRAST;
            if (!rescued && !(inner && inner.complex)) check("non-text", st, outside, NON_TEXT_CONTRAST, n.id);
          }
        }
      });
    }
  }
  if (!rows.size) return;
  const list = [...rows.values()].sort((a, b) => b.screens.length - a.screens.length || a.ratio - b.ratio || a.fg.localeCompare(b.fg));
  push(
    "info",
    "token-pair-contrast",
    `${list.length} token pair(s) fail WCAG in the rendered mode(s) \u2014 ask the designer once per pair: ` + list.slice(0, 8).map((p) => `${p.kind === "text" ? "" : "stroke "}'${p.fg}' on '${p.bg}' (${p.mode}) ${p.ratio}:1 < ${p.required}:1 \u2014 ${p.screens.length} screen(s)`).join("; ") + (list.length > 8 ? `; \u2026 (${list.length} in all \u2014 see tokenPairs)` : "") + `. Token-level: the token-bound background (a gradient / image / raw or translucent fill in between is not judged), no compositing \u2014 the per-screen audit's low-contrast / non-text-contrast / contrast-manual measure what renders.`,
    { tokenPairs: list }
  );
}
if (false) runCli3(main, { name: "cross-check" });

// design-to-code/audit.ts
import { parseArgs as parseArgs2 } from "node:util";

// bridge/src/svg-normalize.ts
var RASTER_SHELL_MAX_PATHS = 50;
function isRasterShell(rasters, paths) {
  return (rasters ?? 0) > 0 && (paths ?? 0) < RASTER_SHELL_MAX_PATHS;
}

// design-to-code/node-artefacts.ts
import fs12 from "node:fs";
import path10 from "node:path";

// design-to-code/verify-sets.ts
import fs11 from "node:fs";
import path9 from "node:path";

// design-to-code/verify-status.ts
import path8 from "node:path";
import fs10 from "node:fs";

// design-to-code/run-cache.ts
import fs9 from "node:fs";
import os from "node:os";
import path7 from "node:path";

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// bridge/src/file-lock.ts
import fs8 from "node:fs";
var LIVE_STALE_MS = 2 * 6e4;
var PID_NS = (() => {
  if (process.platform !== "linux") return "";
  try {
    return fs8.readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
})();
var sleeper = new Int32Array(new SharedArrayBuffer(4));

// design-to-code/run-cache.ts
var CACHE_NAME = "designtwin-verify";
var RUN_CACHE_SEGMENTS = ["node_modules", ".cache", CACHE_NAME];
var shortSha = (s) => sha256Hex(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs9.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs9.existsSync(p);
function realpath(p) {
  if (typeof fs9.realpathSync.native === "function") {
    try {
      return fs9.realpathSync.native(p);
    } catch {
    }
  }
  return fs9.realpathSync(p);
}
function canonical(p) {
  const abs = path7.resolve(p);
  try {
    return realpath(abs);
  } catch {
    const parent = path7.dirname(abs);
    return parent === abs ? abs : path7.join(canonical(parent), path7.basename(abs));
  }
}
var hasPnp = (d) => exists(path7.join(d, ".pnp.cjs")) || exists(path7.join(d, ".pnp.js"));
function isWorkspaceRoot(d) {
  if (exists(path7.join(d, "pnpm-workspace.yaml"))) return true;
  const r = readJson(path7.join(d, "package.json"), anyJson);
  return "doc" in r && isJsonObject(r.doc) && r.doc.workspaces !== void 0;
}
function installRootOf(dir) {
  let P = null;
  for (let d = dir; ; d = path7.dirname(d)) {
    if (exists(path7.join(d, "package.json"))) {
      P = d;
      break;
    }
    if (exists(path7.join(d, ".git")) || path7.dirname(d) === d) return null;
  }
  if (isDir(path7.join(P, "node_modules"))) return P;
  let ws = null;
  for (let d = P; ; d = path7.dirname(d)) {
    if (isWorkspaceRoot(d)) {
      ws = d;
      break;
    }
    if (exists(path7.join(d, ".git")) || path7.dirname(d) === d) break;
  }
  if (ws !== null && isDir(path7.join(ws, "node_modules"))) return ws;
  if (hasPnp(P) || ws !== null && hasPnp(ws)) return null;
  return P;
}
function runCacheOf(verifyDir) {
  const v = canonical(verifyDir);
  const root = installRootOf(v);
  if (root !== null) {
    const cache = path7.join(root, ...RUN_CACHE_SEGMENTS);
    const rel = path7.relative(root, v).split(path7.sep).join("/");
    return { dir: rel === VERIFY_DIR.split(path7.sep).join("/") ? cache : path7.join(cache, "dirs", shortSha(rel)), root };
  }
  return { dir: path7.join(os.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}

// design-to-code/verify-status.ts
var STATUS_SCHEMA = "designtwin/verify-status@2";
var STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
var TERMINAL_PHASES = ["done", "failed", "blocked"];
var isPhase = (x) => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
var optStr3 = (x) => x === void 0 || typeof x === "string";
var isOwnRunStamp = (x) => isJsonObject(x) && typeof x.pid === "number" && typeof x.host === "string" && optStr3(x.ns) && typeof x.startedAt === "string" && typeof x.deadline === "string";
var isFailureCount = (x) => typeof x === "number" && Number.isInteger(x) && x >= 0;
var isReplacedRun = (x) => isJsonObject(x) && typeof x.runId === "string" && isPhase(x.phase) && typeof x.at === "string";
function isVerifyStatusV2(x) {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number" && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator") && optStr3(x.expectationSha256) && optStr3(x.measuredSha256) && optStr3(x.evidenceSha256) && (x.published === void 0 || Array.isArray(x.published) && x.published.every((p) => typeof p === "string")) && (x.ownRun === void 0 || isOwnRunStamp(x.ownRun)) && (x.probeFailures === void 0 || isFailureCount(x.probeFailures)) && (x.replaced === void 0 || isReplacedRun(x.replaced));
}
isVerifyStatusV2.expected = "a verify status @2 {schema, screen, runId, rev, phase, detail, at, by}";
var liveStatusFile = (base) => path8.join(runCacheDir(path8.dirname(base)), setFile(path8.basename(base), "status"));
function readStatusFile(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return null;
  if (isVerifyStatusV2(r.doc)) return r.doc;
  if (isJsonObject(r.doc) && (r.doc.ownRun !== void 0 || r.doc.probeFailures !== void 0 || r.doc.replaced !== void 0)) {
    const { ownRun, probeFailures, replaced, ...rest } = r.doc;
    const kept = { ...rest, ...isOwnRunStamp(ownRun) ? { ownRun } : {}, ...isFailureCount(probeFailures) ? { probeFailures } : {}, ...isReplacedRun(replaced) ? { replaced } : {} };
    if (isVerifyStatusV2(kept)) return kept;
  }
  return isJsonObject(r.doc) && r.doc.schema === void 0 && typeof r.doc.phase === "string" ? "v1" : null;
}
function runCommands(base, open) {
  const vs = scriptCmd("verify-screen"), S = shellArg(path8.basename(base)), id = shellArg(open.runId), dir = shellArg(path8.resolve(path8.dirname(base)));
  return { waitIt: `${vs} --wait ${S} --run ${id} --dir ${dir}`, endIt: `${vs} --status ${S} --phase failed --run ${id} --dir ${dir}` };
}
function openRunSets(verifyDir) {
  let files;
  try {
    files = fs10.readdirSync(runCacheDir(verifyDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return files.filter((e) => e.isFile() && setBaseOf(e.name, "status") !== null).map((e) => setBaseOf(e.name, "status") ?? e.name).filter((name) => {
    const st = readStatusFile(liveStatusFile(path8.join(verifyDir, name)));
    return st !== null && st !== "v1" && !TERMINAL_PHASES.includes(st.phase);
  }).sort();
}

// design-to-code/verify-sets.ts
var RESERVED_SLUGS = /* @__PURE__ */ new Set(["expected", "report", "measured", "status", "evidence", "prev", "retired", "diff", "forced-colors", "json", "md", "png", "tmp"]);
var MAX_SLUG = 32;
var VARIANT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var STEM_RE = /^[A-Za-z0-9_]+$/;
var isVariantSlug = (s) => s.length <= MAX_SLUG && VARIANT_RE.test(s) && !RESERVED_SLUGS.has(s);
function parseSetName(name) {
  const dot = name.indexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const variant = dot < 0 ? null : name.slice(dot + 1);
  if (!STEM_RE.test(stem)) return null;
  const nodeId = nodeIdFromStem(stem);
  if (nodeId === null) return null;
  if (variant !== null && !isVariantSlug(variant)) return null;
  return { stem, nodeId, variant };
}
function nodeIdFromSetName(name) {
  const dot = name.indexOf(".");
  return nodeIdFromStem(dot < 0 ? name : name.slice(0, dot));
}
var SET_FILE = {
  /** the expectation (verify-screen --expect) — what names the set */
  expected: ".expected.json",
  /** the expectation --expect replaced, kept beside it */
  expectedPrev: ".expected.prev.json",
  /** the report and its markdown (verify-screen --compare) */
  report: ".report.json",
  reportMd: ".report.md",
  /** what the probe (or the verifier) measured */
  measured: ".measured.json",
  /** the run's status (verify-run.ts: the live one is in the run cache, the final one published here) */
  status: ".status.json",
  /** the interactions the verifier drove (--interactions) */
  evidence: ".evidence.json",
  /** the probe's visual diff and forced-colors screenshot */
  diff: ".diff.png",
  forcedColors: ".forced-colors.png",
  /** an expectation moved aside: history, never a live set (allSets) */
  retired: ".expected.json.retired"
};
var setFile = (base, kind) => base + SET_FILE[kind];
var setBaseOf = (file, kind) => file.endsWith(SET_FILE[kind]) ? file.slice(0, -SET_FILE[kind].length) : null;
var EXPECTED_SUFFIX = SET_FILE.expected;
var TRAILING_SEP = path9.sep === "\\" ? /[\\/]+$/ : /\/+$/;
var NAMING_KINDS = ["expected", "report", "measured"];
var namedBy = (f) => {
  for (const k of NAMING_KINDS) if (f.endsWith(SET_FILE[k])) return f.slice(0, -SET_FILE[k].length);
  return null;
};
function allSets(verifyDir) {
  let files;
  try {
    files = fs11.readdirSync(verifyDir);
  } catch {
    return [];
  }
  const have = new Set(files);
  const names = /* @__PURE__ */ new Set();
  for (const f of files) {
    const named = namedBy(f);
    if (named !== null) names.add(named);
    else if (f.endsWith(SET_FILE.retired)) names.add(f.slice(0, -SET_FILE.retired.length));
  }
  return [...names].sort().map((name) => ({ name, retired: !have.has(setFile(name, "expected")) && have.has(setFile(name, "retired")) }));
}
function verifySets(verifyDir) {
  return allSets(verifyDir).filter((s) => !s.retired).map((s) => s.name);
}
function setFacts(verifyDir, name) {
  const exp = readJsonOrNull(setFile(path9.join(verifyDir, name), "expected"), isJsonObject);
  const rep = readJsonOrNull(setFile(path9.join(verifyDir, name), "report"), isJsonObject);
  return setFactsOf(exp, rep);
}
function setFactsOf(exp, rep) {
  const str = (x) => typeof x === "string" && x ? x : null;
  const e = isJsonObject(exp) ? exp : null;
  const frame = e && isJsonObject(e.frame) ? e.frame : null;
  const r = isJsonObject(rep) ? rep : null;
  return { expectedId: str(frame && frame.nodeId), expectedName: str(frame && frame.name), reportId: str(r && r.nodeId), reportScreen: str(r && r.screen) };
}
function stemHolders(verifyDir, stems, open) {
  const onDisk = new Set(verifySets(verifyDir).map((n) => parseSetName(n)?.stem));
  return stems.map((stem) => {
    const set = onDisk.has(stem) ? void 0 : open.find((n) => parseSetName(n)?.stem === stem);
    const st = set !== void 0 ? readStatusFile(liveStatusFile(path9.join(verifyDir, set))) : null;
    if (set === void 0 || st === null || st === "v1") return stem;
    return `an open run ${st.runId} under ${set} (no file of it yet; end it: ${runCommands(path9.join(verifyDir, set), st).endIt})`;
  }).join(", ");
}

// design-to-code/node-artefacts.ts
function planNode(plan, file) {
  return plan.nodeId || (file !== void 0 ? nodeIdFromStem(path10.basename(file).replace(/\.json$/i, "")) : null);
}
function setIdsOf(name, f) {
  return [...new Set([nodeIdFromSetName(name), f.expectedId, f.reportId].filter((x) => x !== null))].sort();
}
function setNodeOf(name, f) {
  const ids = setIdsOf(name, f);
  return ids.length === 1 ? ids[0] ?? null : null;
}
function readPlan(file) {
  const r = readJson(file, anyJson);
  if (!("doc" in r)) return { file, error: r.error };
  const p = parsePlan(r.doc);
  return "plan" in p ? { file, plan: p.plan } : { file, error: p.error };
}
var isPlanFile = (p) => "plan" in p;
var article = (kind) => kind === "audit report" ? "an" : "a";
var several = (kind, nodeId, holders, shown = holders.join(", ")) => ({ ok: false, why: `node ${nodeId} has ${holders.length} ${kind}s (${shown}) \u2014 one node, one ${kind}: keep one`, holders, reason: "several" });
var already = (kind, nodeId, holders, shown = holders.join(", ")) => ({ ok: false, why: `node ${nodeId} already has ${article(kind)} ${kind} (${shown}) \u2014 one node, one ${kind}`, holders, reason: "held" });
var slash = (p) => p.split(path10.sep).join("/");
function nodeArtefacts(root, dirs = {}) {
  const planDir = dirs.planDir ?? PLAN_DIR;
  const verifyDir = dirs.verifyDir ?? VERIFY_DIR;
  const auditDir = dirs.auditDir ?? AUDIT_DIR;
  const abs = (p) => path10.resolve(root, p);
  const spell = (dir, name) => path10.isAbsolute(dir) ? path10.join(dir, name) : slash(path10.join(dir, name));
  const verifyAbs = abs(verifyDir);
  const open = () => dirs.openSets ?? openRunSets(verifyAbs);
  function plans() {
    const out = [], bad = [];
    for (const f of listPlans(abs(planDir))) {
      const file = spell(planDir, f);
      const r = readPlan(abs(file));
      if (isPlanFile(r)) out.push({ file, plan: r.plan, nodeId: planNode(r.plan, f) });
      else bad.push({ file, error: r.error });
    }
    return { plans: out, bad };
  }
  const plansOf = (nodeId) => plans().plans.filter((p) => p.nodeId === nodeId);
  const setIds = (name) => setIdsOf(name, setFacts(verifyAbs, name));
  const setNode = (name) => setNodeOf(name, setFacts(verifyAbs, name));
  function setHolders(nodeId, runs) {
    const stems = /* @__PURE__ */ new Set(), conflicted = [], legacy2 = [];
    for (const name of [.../* @__PURE__ */ new Set([...verifySets(verifyAbs), ...runs])].sort()) {
      const ids = setIds(name);
      if (!ids.includes(nodeId)) continue;
      const p = parseSetName(name);
      if (p === null) {
        legacy2.push(name);
        continue;
      }
      stems.add(p.stem);
      if (ids.length > 1) conflicted.push({ name, ids });
    }
    return { stems: [...stems].sort(), conflicted, legacy: legacy2 };
  }
  function auditReports() {
    let files;
    try {
      files = fs12.readdirSync(abs(auditDir)).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")).sort();
    } catch {
      return [];
    }
    return files.map((f) => {
      const doc = readJsonOrNull(path10.join(abs(auditDir), f), isJsonObject);
      const ids = doc && Array.isArray(doc.nodeIds) ? doc.nodeIds.filter((x) => typeof x === "string") : [];
      return { f, stem: f.slice(0, -5), nodeIds: ids.length ? ids : null };
    });
  }
  const auditNodeIs = (r, nodeId) => r.nodeIds ? r.nodeIds.includes(nodeId) : nodeIdFromStem(r.stem) === nodeId;
  const auditNamesNode = (r) => r.nodeIds !== null || nodeIdFromStem(r.stem) !== null;
  const auditsOf = (nodeId) => auditReports().filter((r) => auditNodeIs(r, nodeId)).map((r) => spell(auditDir, r.f));
  function auditFor(nodeId, hints = {}) {
    if (!fs12.existsSync(abs(auditDir))) return null;
    if (hints.screenFile) {
      const own = path10.basename(hints.screenFile, ".json") + ".json";
      if (fs12.existsSync(path10.join(abs(auditDir), own))) return spell(auditDir, own);
    }
    if (nodeId) {
      const held = auditsOf(nodeId)[0];
      if (held !== void 0) return held;
    }
    const want = alnumKey(hints.screenName);
    if (!want) return null;
    const pool = auditReports().filter((r) => !nodeId || !auditNamesNode(r));
    const nameOf = (s) => {
      const i = s.lastIndexOf("__");
      return i > 0 ? s.slice(0, i) : null;
    };
    const hit = pool.find((r) => alnumKey(r.stem) === want) ?? pool.find((r) => {
      const n = nameOf(r.stem);
      return n !== null && alnumKey(n) === want;
    });
    return hit ? spell(auditDir, hit.f) : null;
  }
  function claimSet(nodeId, o) {
    const runs = open();
    const { stems, conflicted, legacy: legacy2 } = setHolders(nodeId, runs);
    const shown = (names) => stemHolders(verifyAbs, names, runs);
    const mixed = conflicted[0];
    if (mixed !== void 0) {
      return {
        ok: false,
        why: `node ${nodeId}'s verify set ${mixed.name} also carries node ${mixed.ids.filter((x) => x !== nodeId).join(", ")} (its name, expectation and report disagree) \u2014 one node, one verify set: keep one node's files`,
        holders: conflicted.map((c) => c.name),
        reason: "held"
      };
    }
    if (o.target !== void 0) {
      const others = stems.filter((s) => s !== o.target);
      if (others.length) return already("verify set", nodeId, others, shown(others));
      return { ok: true, name: o.target, existing: stems.includes(o.target), legacy: legacy2 };
    }
    if (stems.length > 1) return several("verify set", nodeId, stems, shown(stems));
    const have = stems[0];
    return { ok: true, name: have ?? screenStem(o.layerName ?? "", nodeId), existing: have !== void 0, legacy: legacy2 };
  }
  function claimPlan(nodeId, o) {
    const held = plansOf(nodeId).map((p) => p.file);
    if (held.length > 1) return several("plan", nodeId, held);
    const target = o.target !== void 0 ? abs(o.target) : void 0;
    const have = held[0];
    if (have !== void 0) return target === void 0 || abs(have) === target ? { ok: true, name: have, existing: true, legacy: [] } : already("plan", nodeId, held);
    const s = claimSet(nodeId, { layerName: o.layerName });
    if (!s.ok) return s;
    const name = spell(planDir, s.name + ".json");
    if (target !== void 0 && path10.basename(target) !== path10.basename(name)) return { ok: false, why: `a new plan of node ${nodeId} is named by its node: ${name}, not ${path10.basename(target)}`, holders: [], reason: "misnamed" };
    return { ok: true, name, existing: false, legacy: [] };
  }
  function claimAudit(nodeId, target) {
    const t = abs(target);
    const own = path10.basename(t, ".json");
    const held = auditsOf(nodeId).filter((f) => abs(f) !== t && !own.startsWith(path10.basename(f, ".json") + "."));
    return held.length ? already("audit report", nodeId, held) : { ok: true, name: target, existing: false, legacy: [] };
  }
  function claim(kind, nodeId, o = {}) {
    if (kind === "plan") return claimPlan(nodeId, o);
    if (kind === "verify set") return claimSet(nodeId, o);
    if (o.target === void 0) throw new Error("claim('audit report') takes the target it is about to write");
    return claimAudit(nodeId, o.target);
  }
  return {
    root,
    planDir,
    verifyDir,
    auditDir,
    plans,
    plansOf,
    idlessPlans: () => plans().plans.filter((p) => p.nodeId === null).map((p) => p.file),
    setIds,
    setNode,
    setsOf: (nodeId) => {
      const h = setHolders(nodeId, open());
      return { stems: h.stems, legacy: h.legacy };
    },
    auditsOf,
    auditFor,
    claim
  };
}

// bridge/src/instance-overrides.ts
var OVERRIDE_CAP = 100;

// design-to-code/audit.ts
var TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
var PLATFORMS = Object.keys(TOUCH_MIN);
var AUDIT_CATEGORIES = ["color", "typography", "spacing", "radius", "effects"];
var isPlatform = (p) => typeof p === "string" && PLATFORMS.includes(p);
var over = compositeOver;
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
var STATE_KEYS = ["loading", "empty", "error"];
var STATE_WORDS = {
  loading: /\b(loading|skeleton|spinner|shimmer|placeholder)\b/i,
  // An empty state is usually a SENTENCE ("No items added yet.", "Add your first project"), not a
  // layer called "Empty" — `no … yet/added/created/found/available` within one clause (a non-breaking
  // space counts: `\s`/`[^…]` both match U+00A0, which designers' copy often carries).
  empty: /\b(empty|no results?|no data|nothing (here|found|to show|yet)|zero ?state|(add|create) your first)\b|\bno\b[^.!?\n]{0,40}?\b(yet|added|created|found|available)\b/i,
  error: /\b(error|failed|failure|offline|retry|something went wrong|not found|404|500)\b/i
};
var VALIDATION_WORDS = /\b((is|are) required|required field|invalid|is not valid|must (be|contain|include|match)|please (enter|select|provide|fill)|too (short|long)|already (exists|taken|in use))\b/i;
var DIALOG_NAME = /\b(dialog|modal|pop-?ups?|popover|bottom ?sheet|action ?sheet|side ?drawer)s?\b/i;
function textOf(node) {
  const t = typeof node.text === "string" ? node.text.replace(/\s+/g, " ").trim() : "";
  if (!t || t === (node.name || "").trim()) return null;
  return t.length > 40 ? t.slice(0, 39) + "\u2026" : t;
}
var PICKER_PROMPT = /^(select|choose|pick)\b/i;
var PICKER_ICON = /chevron|arrow-?down|caret|angle-?down|calendar/i;
function pickerCue(inst) {
  let prompt = null, icon = null;
  walkVisible(inst, (c, ctx) => {
    if (ctx.depth === 0 || prompt !== null) return;
    const t = c.type === "TEXT" ? (c.text || "").replace(/\s+/g, " ").trim() : "";
    if (t && PICKER_PROMPT.test(t)) prompt = `"${t.length > 40 ? t.slice(0, 39) + "\u2026" : t}"`;
    else if (icon === null && PICKER_ICON.test(c.name || "")) icon = `a '${c.name}' layer`;
  });
  return prompt ?? icon;
}
var WHITE2 = { r: 255, g: 255, b: 255, a: 1 };
var CONTROL_WORD = /\b(button|btn|checkbox|check box|radio|switch|toggle|input|text ?field|textfield|textarea)\b/i;
var cite = (node) => {
  const t = textOf(node);
  return `'${node.name}'${t ? ` ("${t}")` : ""}`;
};
var textExtra = (node) => ifDefined("text", textOf(node) ?? void 0);
var CONTROL_STATES = ["hover", "pressed", "focus", "disabled", "error", "selected", "loading", "open"];
var STATE_SYNONYMS = {
  hover: /^(hover|hovered|mouse ?over)$/,
  pressed: /^(pressed|press|active|tapped|down)$/,
  focus: /^(focus|focused|focus[- ]visible|keyboard ?focus)$/,
  disabled: DISABLED_WORD,
  // Not "danger"/"destructive": those are button STYLE variants (a red button), not an error state.
  error: /^(error|invalid|has ?error|is ?invalid)$/,
  selected: /^(selected|checked|on|active|current|is ?selected)$/,
  loading: /^(loading|busy|in ?progress|is ?loading)$/,
  // A select/picker's list (or calendar) drawn as a variant
  open: /^(open|opened|expanded|is ?open|show ?list|dropdown ?open)$/
};
function requiredStates(kind, platform) {
  const pointer = platform === "web";
  switch (kind) {
    case "button":
      return pointer ? ["hover", "pressed", "focus", "disabled"] : ["pressed", "disabled"];
    case "input":
      return ["focus", "error", "disabled"];
    // A select/dropdown/picker also has its open list (or calendar) to design — and, in a form, its error
    case "select":
      return pointer ? ["hover", "focus", "disabled", "error", "open"] : ["focus", "disabled", "error", "open"];
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
var variantValuesOf = (mc) => String(mc && mc.name || "").split(",").map((p) => (p.split("=")[1] || "").trim().toLowerCase());
var isField = (k) => k === "input" || k === "select";
function labelledRoots(doc, label) {
  const exp = isScreenExport(doc) ? doc : null;
  const manifest = exp ? exp.manifest : isLayerFile(doc) ? doc.manifest : void 0;
  return screenRoots(doc).map((tree) => ({ tree, label: exp && exp.screen || tree.name || label, ...ifDefined("manifest", manifest) }));
}
var r1 = (v) => Math.round(v * 100) / 100;
var hasTok = (node, ...keys) => {
  const t = node.tokens;
  return !!(t && keys.some((k) => t[k] != null));
};
var unwrap = (d, i) => !d || isScreenDoc(d) ? { doc: d || null, label: `input${i}`, vars: null, assets: null } : { doc: d.doc || null, label: d.label || `input${i}`, vars: d.vars || null, assets: d.assets || null };
function spacingStep(tokens) {
  const values = [];
  const isSpacing = (v) => v.type === "FLOAT" && (/spac/i.test(v.collection || "") || Array.isArray(v.scopes) && v.scopes.includes("GAP"));
  for (const v of tokens && tokens.variables || []) {
    if (!isSpacing(v)) continue;
    for (const mv of Object.values(v.values)) if (typeof mv === "number" && Number.isFinite(mv) && Math.round(Math.abs(mv)) > 0) values.push(Math.round(Math.abs(mv)));
  }
  if (values.length < 2) return null;
  const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
  const step = values.reduce((a, b) => gcd(a, b));
  return step >= 2 ? step : null;
}
function audit(input, opts = {}) {
  const givenPlatform = opts.platform;
  const platformAssumed = !isPlatform(givenPlatform);
  const platform = isPlatform(givenPlatform) ? givenPlatform : "web";
  const gridAssumed = !(opts.grid !== void 0 && opts.grid > 0);
  const grid = gridAssumed || opts.grid === void 0 ? 4 : opts.grid;
  const dsStep = spacingStep(opts.designSystem && opts.designSystem.tokens);
  const gridMismatch = dsStep !== null && dsStep !== grid ? dsStep : null;
  const docs = (Array.isArray(input) ? input : [input]).map(unwrap);
  const roots = docs.flatMap((d) => labelledRoots(d.doc, d.label));
  const catalog = opts.catalog && Array.isArray(opts.catalog.components) ? opts.catalog.components : [];
  const findings = [];
  const binding = { color: [0, 0], typography: [0, 0], spacing: [0, 0], radius: [0, 0], effects: [0, 0] };
  const tally = (cat, bound) => {
    binding[cat][1]++;
    if (bound) binding[cat][0]++;
  };
  const ac = {
    opts,
    platform,
    grid,
    docs,
    roots,
    catalog,
    findings,
    add: makeAdd(findings),
    binding,
    tally,
    rawColors: /* @__PURE__ */ new Map(),
    // hex -> { count, sample node, channels }
    usedComponents: /* @__PURE__ */ new Map(),
    // setKey|key|name -> { name, kind }
    stateHits: { loading: [], empty: [], error: [] },
    validationHits: [],
    inputsSeen: 0,
    // visible input controls — whether a validation state applies at all
    annotations: [],
    hiddenIds: /* @__PURE__ */ new Set(),
    // every node skipped by the hidden predicate — cross-file findings are filtered by it too
    nodesById: /* @__PURE__ */ new Map(),
    // visible nodes, so a finding raised off-tree (a heavy asset) can cite one
    // Prototype links out of this screen, one row per destination: the export has them, and a
    // link copied along with a layer ("every row opens the Details screen") is invisible until clicked.
    navigations: /* @__PURE__ */ new Map(),
    // Sublayer ids (I<inst>;<layer>) whose `characters` some instance overrides, the instances whose list hit
    // the plugin's cap (incomplete), and every visible instance text that is not driven by a TEXT property.
    charOverridden: /* @__PURE__ */ new Set(),
    cappedInstances: /* @__PURE__ */ new Set(),
    instanceTexts: [],
    // Failing control boundaries, one entry per screen + stroke + backdrop.
    boundaries: /* @__PURE__ */ new Map(),
    // Input instances that read like a select/picker ("Select …", a chevron/calendar layer).
    pickers: []
  };
  walkRoots(ac);
  const raws = nearDuplicateColors(ac);
  const nearToken = nearTokenColors(ac, raws);
  nonTextContrast(ac);
  const copyQuestions = defaultCopyInInstances(ac);
  duplicateRootSubtrees(ac);
  const lookup = stateLookup(ac);
  const { components, unchecked } = componentStates(ac, lookup);
  const openStates = undesignedOpenStates(ac, lookup);
  const { allDialogs, screenStates, screenStatesScope } = screenStatesOf(ac);
  heavyAssets(ac);
  prototypeLinks(ac);
  const tokenBinding = tokenBindingOf(ac);
  const questions = openQuestions(ac, { allDialogs, screenStates, unchecked, components, copyQuestions, openStates, nearToken });
  const { crossFile, crossOrigin, hiddenFindingsOmitted } = crossFilePass(ac);
  libraryNotes(ac, crossFile, lookup.screenCollKeys);
  const overridesUnmatched = applyOverrides(ac, crossFile, crossOrigin);
  finishFindings(ac, questions);
  const count = (s) => findings.filter((f) => f.severity === s).length;
  return {
    platform,
    platformAssumed,
    crossFile,
    grid,
    gridAssumed,
    gridMismatch,
    screenStatesScope,
    screens: roots.map((r) => r.label),
    // The root node id(s) audited — additive, read only by the CLI's duplicate-artefact
    // check: it lets a re-run find an EARLIER report for the same screen under a
    // different name without re-parsing every screen export in the directory.
    nodeIds: roots.map((r) => r.tree && r.tree.id).filter((id) => !!id),
    summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
    hiddenLayers: { nodesSkipped: ac.hiddenIds.size, crossFileFindingsOmitted: hiddenFindingsOmitted },
    ...overridesUnmatched.length ? { overridesUnmatched } : {},
    tokenBinding,
    components,
    screenStates,
    annotations: ac.annotations,
    questions,
    findings
  };
}
function makeAdd(findings) {
  const placeOf = (ctx) => ({ screen: ctx.label, ...ifDefined("path", ctx.path) });
  function add(severity, code, message, node, ctx, extra) {
    return findings.push(Object.assign(
      { severity, code, message },
      node ? { nodeId: node.id, nodeName: node.name } : {},
      ctx ? placeOf(ctx) : {},
      extra || {}
    ));
  }
  return add;
}
function walkRoots(ac) {
  const { roots, add } = ac;
  for (const root of roots) {
    const m = root.manifest || {};
    if (m.truncated) add("blocker", "export-truncated", `export of '${root.label}' was truncated (${m.truncated} subtree(s) past the depth limit) \u2014 the tree is incomplete; re-export a narrower scope before building`, null, { label: root.label });
    if (m.assetsFailed) add("blocker", "assets-failed", `${m.assetsFailed} asset export(s) failed in '${root.label}' \u2014 those nodes have no file (look for \`geometry\` fallbacks)`, null, { label: root.label });
    if (root.tree.devStatus && root.tree.devStatus !== "ready_for_dev" && root.tree.devStatus !== "completed") {
      add("warning", "not-ready-for-dev", `'${root.label}' dev status is '${String(root.tree.devStatus)}' \u2014 confirm the design is final before building`, root.tree, { label: root.label, path: root.tree.name });
    }
    const ctx = { label: root.label, ...ifDefined("rootBox", root.tree.box) };
    walkWithHidden(root.tree, (node, w) => visit(ac, node, w, ctx));
  }
}
function visit(ac, node, w, ctx) {
  const { platform, grid, add, tally, annotations, stateHits, validationHits, cappedInstances, charOverridden, hiddenIds, nodesById, usedComponents, pickers, navigations, instanceTexts } = ac;
  const ancestors = w.ancestors.map((a) => a.node);
  const path12 = [...ancestors.map((a) => a.name), node.name].join(" > ");
  const here = { label: ctx.label, path: path12 };
  const hiddenBranch = w.hidden;
  if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, ...ifDefined("label", a.label || a.markdown) });
  if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });
  for (const state of STATE_KEYS) {
    const re = STATE_WORDS[state];
    if (re.test(node.name || "") || node.type === "TEXT" && (state === "empty" || ancestors.length <= 6) && re.test(node.text || "")) {
      stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
    }
  }
  const variantValues = variantValuesOf(node.mainComponent);
  if (node.type === "TEXT" && VALIDATION_WORDS.test(node.text || "") || VALIDATION_WORDS.test(node.name || "") || isField(controlKind(node.mainComponent && node.mainComponent.setName || node.component)) && variantValues.some((v) => STATE_SYNONYMS.error.test(v))) {
    validationHits.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
  }
  if (Array.isArray(node.overrides)) {
    if (node.overrides.length >= OVERRIDE_CAP) cappedInstances.add(node.id);
    for (const o of node.overrides) if (Array.isArray(o.fields) && o.fields.includes("characters")) charOverridden.add(o.id);
  }
  if (hiddenBranch) {
    if (node.id) hiddenIds.add(node.id);
    return;
  }
  if (node.id) nodesById.set(node.id, node);
  if (node.mainComponent || node.component) {
    const mc = node.mainComponent || {};
    const name = mc.setName || node.component;
    const key = mc.setKey || mc.key || name;
    const icon = !!(node.asset || node.geometry || node.assetSkipped) && !CONTROL_WORD.test(String(name || ""));
    if (key && !usedComponents.has(key)) usedComponents.set(key, { name, ...ifDefined("key", mc.setKey || mc.key), ...ifDefined("variantKey", mc.key), remote: !!mc.remote, nodeId: node.id, ...icon ? { icon: true } : {} });
    if (!icon && isField(controlKind(name)) && !/\b(search|filter)/i.test(String(name || ""))) ac.inputsSeen++;
    if (!icon && node.type === "INSTANCE" && key && controlKind(name) === "input" && !/\b(search|filter)/i.test(String(name || "")) && !ancestors.some((a) => a.id !== void 0 && pickers.some((p) => p.node.id === a.id))) {
      const cue = pickerCue(node);
      if (cue) pickers.push({ node, here, useKey: key, cue });
    }
  }
  for (const r of Array.isArray(node.reactions) ? node.reactions : []) {
    for (const a of Array.isArray(r.actions) ? r.actions : []) {
      if (a.type !== "node" || !(a.destination || a.destinationId) || a.navigation === "change_to" || a.navigation === "scroll_to") continue;
      const nav = a.navigation || "navigate";
      const id = nav + "|" + (a.destinationId || a.destination);
      const row = navigations.get(id);
      if (row) row.count++;
      else navigations.set(id, { destination: a.destination, destinationId: a.destinationId, navigation: nav, count: 1, node, label: ctx.label });
    }
  }
  if (node.detachedFrom) add("warning", "detached-instance", `'${node.name}' is a detached component instance \u2014 map it back to the component unless the detach was deliberate`, node, here);
  if (node.missingFont) add("blocker", "missing-font", `'${node.name}' uses a font Figma couldn't load \u2014 the recorded family/weight may not match the render; confirm the font files and license`, node, here);
  if (node.layout && node.layout.mode === "absolute" && Array.isArray(node.children) && node.children.length > 1 && node.type !== "GROUP" && ancestors.length > 0) {
    add("info", "no-auto-layout", `'${node.name}' has no auto layout (${node.children.length} children placed by coordinates) \u2014 infer a flow layout and ask how it should resize`, node, here);
  }
  const flow = Array.isArray(node.children) ? node.children.filter((c) => c && !hiddenSelf(c) && !c.absolute) : [];
  if (node.layout && Array.isArray(node.layout.padding) && node.layout.padding.length === 4 && node.box && flow.length) {
    const [padTop, , padBottom] = node.layout.padding;
    const kids = flow.filter((c) => !!(c.box && typeof c.box.h === "number"));
    if (kids.length === flow.length && padTop !== void 0 && padBottom !== void 0) {
      const direction = node.layout.flexDirection || (node.layout.display === "flex" ? "row" : null);
      const gap = typeof node.layout.gap === "number" ? node.layout.gap : 0;
      let expectedH = null;
      if (direction === "row") expectedH = padTop + padBottom + Math.max(...kids.map((c) => c.box.h));
      else if (direction === "column") expectedH = padTop + padBottom + kids.reduce((s, c) => s + c.box.h, 0) + gap * (kids.length - 1);
      const heightMode = node.heightMode || "fixed";
      const delta = expectedH === null ? 0 : expectedH - node.box.h;
      const overflow = expectedH !== null && delta > 1;
      const hugMismatch = expectedH !== null && heightMode === "hug" && Math.abs(delta) > 1;
      if (expectedH !== null && (overflow || hugMismatch)) {
        const how = direction === "row" ? "max child " + Math.max(...kids.map((c) => c.box.h)) : "children sum " + (expectedH - padTop - padBottom);
        const why = heightMode === "hug" ? `heightMode:"hug" means this box's height IS the content height, but its own padding + children compute ${expectedH}, not the declared ${node.box.h}` : `content (padding + children) computes ${expectedH}, which OVERFLOWS the declared box.h=${node.box.h} by ${delta}px`;
        add("warning", "self-inconsistent-geometry", `'${node.name}' declares box.h=${node.box.h} (heightMode:${JSON.stringify(heightMode)}) \u2014 ${why}: ${padTop}+${how}+${padBottom} = ${expectedH}. The export contradicts itself \u2014 decide which number to trust before building.`, node, here, { statedH: node.box.h, expectedH, heightMode });
      }
    }
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
        if (!bound) noteRaw(ac, f.color, node);
      }
      if (f.type === "gradient" && /DIAMOND/.test(f.kind || "") && platform !== "flutter") add("info", "diamond-gradient", `'${node.name}' uses a diamond gradient \u2014 no native equivalent; use the exported asset or approximate`, node, here);
      if (f.type === "image" && (f.scaleMode === "crop" || f.scaleMode === "tile")) add("info", "image-scale-mode", `'${node.name}' image fill uses scaleMode '${f.scaleMode}' \u2014 not a plain cover/contain; read the crop transform / tile scale`, node, here);
    }
  }
  if (!isAssetLeaf && node.strokes && (node.strokes.align === "outside" || node.strokes.align === "center") && (node.strokes.weight || node.strokes.weights)) {
    const how = { web: "a CSS border is inside the box \u2014 use outline/box-shadow (no layout) or grow the box", ios: "SwiftUI .strokeBorder is inside, .stroke is centered \u2014 pad an overlay for outside", android: "Modifier.border draws inside \u2014 compensate with padding or drawBehind", "react-native": "borderWidth is inside \u2014 wrap or add padding", flutter: "use BorderSide.strokeAlign outside/center" };
    add("info", "stroke-align", `'${node.name}' has a ${node.strokes.align} stroke \u2014 ${how[platform]}; the rendered size differs from box`, node, here);
  }
  if (!isAssetLeaf && node.strokes && Array.isArray(node.strokes.colors)) {
    for (const c of node.strokes.colors) {
      const bound = !!(hasTok(node, "strokes") || node.styles && node.styles.stroke || (node.strokes.paints || []).some((p) => p.tokens));
      tally("color", bound);
      if (!bound) noteRaw(ac, c, node);
    }
    if (node.type !== "TEXT" && node.type !== "LINE") boundaryCheck(ac, node, w, here);
  }
  if (node.type === "TEXT") {
    const runs = Array.isArray(node.runs) && node.runs.length ? node.runs : [{ ...ifDefined("font", node.font), ...ifDefined("tokens", node.textTokens), ...ifDefined("textStyle", node.styles && node.styles.text) }];
    for (const r of runs) {
      const typoBound = !!(r.textStyle || node.styles && node.styles.text || r.tokens && (r.tokens.fontSize || r.tokens.fontFamily || r.tokens.lineHeight) || node.textTokens && (node.textTokens.fontSize || node.textTokens.fontFamily));
      tally("typography", typoBound);
      if (r.font && r.font.color) {
        const cBound = !!(r.tokens && r.tokens.fills || r.fillStyle || node.textTokens && node.textTokens.fills || hasTok(node, "fills") || node.styles && node.styles.fill);
        tally("color", cBound);
        if (!cBound) noteRaw(ac, r.font.color, node);
      }
    }
    if (!hiddenBranch) textChecks(ac, node, w.backdrop, here);
    const inst = [...ancestors].reverse().find((a) => a.type === "INSTANCE");
    if (inst && !(node.propRefs && node.propRefs.characters) && (node.text || "").trim() && !ancestors.some((a) => a.id !== void 0 && cappedInstances.has(a.id))) {
      instanceTexts.push({ node, here, inst });
    }
  }
  if (node.layout && !isAssetLeaf && !node.assetSkipped) {
    const L = node.layout;
    const spacing = [];
    if (typeof L.gap === "number") spacing.push(["gap", L.gap, hasTok(node, "itemSpacing")]);
    const isGrid = L.display === "grid";
    if (typeof L.rowGap === "number") spacing.push(["rowGap", L.rowGap, hasTok(node, isGrid ? "gridRowGap" : "counterAxisSpacing")]);
    if (typeof L.columnGap === "number") spacing.push(["columnGap", L.columnGap, hasTok(node, isGrid ? "gridColumnGap" : "counterAxisSpacing")]);
    if (Array.isArray(L.padding)) {
      const pad = L.padding;
      ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, j) => {
        if (pad[j]) spacing.push([k, pad[j], hasTok(node, k)]);
      });
    }
    const offGrid = [];
    for (const [k, v, bound] of spacing) {
      tally("spacing", bound);
      if (v < 0) add("info", "negative-spacing", `'${node.name}' ${k} is ${v} (overlap) \u2014 Compose Arrangement.spacedBy rejects negatives; use offset/overlay`, node, here);
      else if (!bound && (v % grid !== 0 || !Number.isInteger(v))) offGrid.push(`${k}=${v}`);
    }
    if (offGrid.length) add("info", "off-grid-spacing", `'${node.name}' has unbound spacing off the ${grid}px grid (${offGrid.join(", ")}) \u2014 likely drift; fix it in Figma or bind a token. Until then the build uses these values EXACTLY \u2014 it must not round them to the grid`, node, here);
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
      if ("blurType" in e && e.blurType === "progressive") add("info", "progressive-blur", `'${node.name}' uses a progressive blur \u2014 no direct equivalent on any platform; mask a blur with a gradient or use the asset`, node, here);
      if (["noise", "glass", "texture", "shader"].includes(e.type)) add("info", "exotic-effect", `'${node.name}' uses a '${e.type}' effect \u2014 no code equivalent; rasterize via the exported asset if it's load-bearing`, node, here);
    }
  }
  if (node.blendMode && (platform === "android" || platform === "react-native")) add("info", "blend-mode", `'${node.name}' uses blend mode '${node.blendMode}' \u2014 limited support on ${platform}; flag or bake into an asset`, node, here);
  const tappable = !hiddenBranch && isTappable(node);
  if (tappable && node.box && !ancestors.some(isTappable)) {
    const min = TOUCH_MIN[platform];
    if (node.box.w < min || node.box.h < min) {
      add("warning", "small-touch-target", `'${node.name}' is ${node.box.w}\xD7${node.box.h} \u2014 below the ${min}\xD7${min} ${platform} minimum; expand the hit area (padding/hitSlop/contentShape) even if the visual stays small`, node, here, { size: { w: node.box.w, h: node.box.h }, min });
    }
  }
}
function isTappable(node) {
  if (Array.isArray(node.reactions) && node.reactions.some((r) => TAP_TRIGGER.test(r.trigger || ""))) return true;
  const compName = node.mainComponent && node.mainComponent.setName || node.component || "";
  if (node.type === "INSTANCE" && controlKind(compName)) return true;
  return (node.type === "INSTANCE" || node.type === "FRAME" || node.type === "COMPONENT") && INTERACTIVE_NAME.test(node.name || "") && !/\b(group|container|list|bar|section|row)s?\b/i.test(node.name || "");
}
function noteRaw(ac, hex, node) {
  const { rawColors } = ac;
  const h = String(hex || "").toLowerCase();
  const rgb = parseHex(h);
  if (!rgb) return;
  const e = rawColors.get(h) || { count: 0, nodeId: node.id, nodeName: node.name, rgb };
  e.count++;
  rawColors.set(h, e);
}
function textChecks(ac, node, backdrop, here) {
  const { add } = ac;
  const font = node.font || {};
  if (!node.autoResize && !node.truncate && !node.maxLines) {
    add("warning", "fixed-size-text", `${cite(node)} is a fixed-size text box with no truncation rule \u2014 it will clip under font scaling or longer translations; decide wrap / truncate / grow`, node, here, textExtra(node));
  }
  const fg = parseHex(font.color);
  if (!fg) return;
  const { color: bg, complex } = backdrop;
  const size = typeof font.size === "number" ? font.size : null;
  const bold = (font.weightValue || 0) >= 700 || /bold|black|heavy/i.test(font.weight || "");
  const large = size != null && (size >= 24 || size >= 18.66 && bold);
  const need = large ? 3 : 4.5;
  if (complex) {
    add("info", "contrast-manual", `${cite(node)} sits on a gradient/image \u2014 check text contrast manually (needs ${need}:1)`, node, here, textExtra(node));
    return;
  }
  const assumed = !bg;
  const base = bg || WHITE2;
  const ratio = contrastRatio(over(fg, base), base);
  if (ratio < need) {
    add(assumed ? "info" : "warning", "low-contrast", `${cite(node)} text contrast ${r1(ratio)}:1 is below WCAG AA ${need}:1 (${large ? "large" : "normal"} text, ${font.color} on ${assumed ? "an assumed white page" : "its background"})`, node, here, { ratio: r1(ratio), required: need, ...textExtra(node) });
  }
}
function boundaryCheck(ac, node, w, here) {
  const { boundaries } = ac;
  const strokes = node.strokes;
  const hex = strokes && Array.isArray(strokes.colors) ? strokes.colors.find((c) => {
    const x = parseHex(c);
    return !!x && x.a > 0;
  }) : void 0;
  const sc = parseHex(hex);
  const weight = strokes ? Math.max(strokes.weight || 0, ...Object.values(strokes.weights || {}).map((x) => x || 0)) : 0;
  if (!sc || !(weight > 0) || hex === void 0) return;
  const self = { node, hidden: w.hidden, backdrop: w.backdrop, beneath: w.beneath };
  const frames = [...w.ancestors, self];
  const near = frames.slice(-4).reverse();
  const outer = outermostControl(near.map((f) => f.node));
  if (outer < 0 || near.some((f) => isDisabledLayer(f.node))) return;
  const inside2 = frames.slice(frames.length - 1 - outer);
  const back = inside2[0]?.backdrop ?? w.backdrop;
  if (back.complex) return;
  const base = back.color || WHITE2;
  const ratio = contrastRatio(over(sc, base), base);
  if (ratio >= 3) return;
  const painted = paintedOver(base, inside2.flatMap((f, i) => [...i > 0 ? f.beneath : [], f.node]));
  if (painted && painted.complex) return;
  const inner = painted && painted.color;
  if (inner && contrastRatio(inner, base) >= 3) return;
  const stroke = normHex(hex) ?? hex, backdrop = formatHex(base), assumed = !back.color;
  const k = `${here.label}|${stroke}|${backdrop}|${assumed}`;
  const row = boundaries.get(k);
  if (row) {
    row.nodes.push(node);
    return;
  }
  const st = node.tokens && node.tokens.strokes;
  const strokeToken = Array.isArray(st) ? st[0] : st;
  boundaries.set(k, { nodes: [node], here, stroke, backdrop, ratio, assumed, hasFill: !!inner, ...ifDefined("strokeToken", strokeToken), ...ifDefined("backdropToken", assumed ? void 0 : back.token ?? void 0) });
}
function nearDuplicateColors(ac) {
  const { rawColors, add } = ac;
  const raws = [...rawColors.entries()].map(([hex, e]) => ({ hex, ...e })).filter((x) => x.rgb.a >= 1);
  const labs = raws.map((x) => ({ x, lab: toLab(x.rgb) }));
  const seen = /* @__PURE__ */ new Set();
  for (const [a, { x: ra, lab: la }] of labs.entries()) {
    if (seen.has(ra.hex)) continue;
    const cluster = [ra];
    for (const { x: rb, lab: lb } of labs.slice(a + 1)) {
      if (!seen.has(rb.hex) && labDist(la, lb) < 3) {
        cluster.push(rb);
        seen.add(rb.hex);
      }
    }
    if (cluster.length > 1) add("info", "near-duplicate-colors", `unbound colors ${cluster.map((c) => `${c.hex}\xD7${c.count}`).join(", ")} are visually indistinguishable (\u0394E<3) \u2014 probably one token`, null, null, { colors: cluster.map((c) => c.hex) });
  }
  return raws;
}
function nearTokenColors(ac, raws) {
  const { opts, docs, nodesById, add } = ac;
  const tokenColors = /* @__PURE__ */ new Map();
  for (const doc of [opts.variables, opts.designSystem && opts.designSystem.tokens, ...docs.map((d) => d.vars)]) {
    for (const v of doc && doc.variables || []) {
      if (v.type !== "COLOR") continue;
      for (const val of Object.values(v.values)) {
        const k = colorKey(val), rgb = parseHex(val);
        if (k && rgb && typeof val === "string" && !tokenColors.has(k)) tokenColors.set(k, { name: v.name, hex: normHex(val) ?? val, rgb });
      }
    }
  }
  const tokenRows = [...tokenColors.values()].filter((t) => t.rgb.a >= 1).map((t) => ({ ...t, lab: toLab(t.rgb) }));
  const nearToken = [];
  for (const x of raws) {
    if (tokenColors.has(colorKey(x.hex) ?? "")) continue;
    const lab = toLab(x.rgb);
    let best = null, bestD = Infinity;
    for (const t of tokenRows) {
      const d = labDist(lab, t.lab);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    if (!best || !(bestD < 1)) continue;
    const sample = nodesById.get(x.nodeId) || null;
    add("info", "near-token-color", `unbound '${x.hex}' \xD7${x.count} (e.g. '${x.nodeName}') is \u0394E ${bestD.toFixed(2)} from token '${best.name}' (${best.hex}) \u2014 a typo of the token, or a deliberate value? Use the literal exactly until the designer answers`, sample, null, { token: best.name, colors: [x.hex, best.hex] });
    nearToken.push(`'${x.hex}' (e.g. '${x.nodeName}' ${x.nodeId}) vs token '${best.name}' ${best.hex}`);
  }
  return nearToken;
}
function nonTextContrast(ac) {
  const { boundaries, add } = ac;
  for (const b of boundaries.values()) {
    const [first, ...more] = b.nodes;
    if (!first) continue;
    add(
      b.assumed ? "info" : "warning",
      "non-text-contrast",
      `'${first.name}'${more.length ? ` and ${more.length} more` : ""}: the control's border ${b.stroke}${b.strokeToken ? ` (${b.strokeToken})` : ""} is ${r1(b.ratio)}:1 against ${b.assumed ? "an assumed white page" : `the colour around it, ${b.backdrop}${b.backdropToken ? ` (${b.backdropToken})` : ""}`} \u2014 below the 3:1 WCAG 1.4.11 asks of a control's boundary, and ${b.hasFill ? "its fill does not set it apart either" : "it has no fill to set it apart"}. Build it to pass (a border or fill that reaches 3:1) and ask the designer \u2014 a contrast failure is never kept as designed`,
      first,
      b.here,
      { nodeIds: b.nodes.map((n) => n.id), stroke: b.stroke, backdrop: b.backdrop, ...ifDefined("strokeToken", b.strokeToken), ...ifDefined("backdropToken", b.backdropToken), ratio: r1(b.ratio), required: 3 }
    );
  }
}
function defaultCopyInInstances(ac) {
  const { instanceTexts, charOverridden, add } = ac;
  const copyGroups = /* @__PURE__ */ new Map();
  for (const t of instanceTexts) {
    const mc = t.inst.mainComponent || {};
    const k = `${t.here.label}|${mc.key ?? mc.setKey ?? t.inst.name}|${t.node.id.split(";").pop()}`;
    const g = copyGroups.get(k) || { inst: t.inst, overridden: [], plain: [] };
    (charOverridden.has(t.node.id) ? g.overridden : g.plain).push(t);
    copyGroups.set(k, g);
  }
  const copyQuestions = [];
  for (const g of copyGroups.values()) {
    const own = [...new Set(g.overridden.map((m) => (m.node.text || "").trim()))];
    const plain = g.plain.filter((m) => !own.includes((m.node.text || "").trim()));
    const first = plain[0];
    if (!own.length || !first) continue;
    const comp = g.inst.mainComponent && g.inst.mainComponent.setName || g.inst.component || g.inst.name;
    const dflt = textOf(first.node) ?? (first.node.text || "").trim();
    const eg = own[0] ?? "";
    add(
      "info",
      "default-copy-in-instance",
      `'${comp}' > '${first.node.name}': ${plain.length} instance(s) show the component's default copy ("${dflt}") while ${g.overridden.length} show their own copy (e.g. "${eg.length > 40 ? eg.slice(0, 39) + "\u2026" : eg}") \u2014 a placeholder left in, or intended? Build the copy as drawn and ask the designer`,
      first.node,
      first.here,
      { nodeIds: plain.map((m) => m.node.id), copies: { default: (first.node.text || "").trim(), overridden: own } }
    );
    copyQuestions.push(`'${comp}' > '${first.node.name}' (${first.node.id}) still says "${dflt}" (the component's default) where other instances say "${eg}" \u2014 is "${dflt}" the intended copy, or a placeholder? \u2192 Default: build "${dflt}" as drawn.`);
  }
  return copyQuestions;
}
function duplicateRootSubtrees(ac) {
  const { roots, add } = ac;
  for (const root of roots) {
    const strays = (Array.isArray(root.tree.children) ? root.tree.children : []).filter((c) => c && c.absolute && !hiddenSelf(c));
    if (!strays.length || hiddenSelf(root.tree)) continue;
    const bySig = /* @__PURE__ */ new Map();
    const sigOf2 = /* @__PURE__ */ new Map(), textsOf = /* @__PURE__ */ new Map();
    const visit2 = (n, top) => {
      const texts = n.type === "TEXT" && (n.text || "").trim() ? [(n.text || "").trim()] : [];
      for (const c of Array.isArray(n.children) ? n.children : []) if (c && !hiddenSelf(c)) texts.push(...visit2(c, top || c));
      if (top && texts.length && n.box) {
        const sig = `${texts.join("\0")}@${Math.round(n.box.w)}x${Math.round(n.box.h)}`;
        sigOf2.set(n, sig);
        textsOf.set(n, texts.length);
        const same = bySig.get(sig);
        if (same) same.push({ node: n, top });
        else bySig.set(sig, [{ node: n, top }]);
      }
      return texts;
    };
    visit2(root.tree, null);
    const rootW = root.tree.box && typeof root.tree.box.w === "number" ? root.tree.box.w : null;
    for (const stray of strays) {
      const sig = sigOf2.get(stray);
      const sizeable = (textsOf.get(stray) || 0) >= 2 || rootW !== null && !!stray.box && stray.box.w >= rootW / 2;
      if (sig === void 0 || !sizeable) continue;
      const twin = (bySig.get(sig) || []).find((t) => t.top !== stray && !t.top.absolute);
      if (!twin) continue;
      const rb = root.tree.box, sb = stray.box;
      const at = rb && sb && typeof rb.x === "number" && typeof rb.y === "number" && typeof sb.x === "number" && typeof sb.y === "number" ? ` at ${Math.round(sb.x - rb.x)},${Math.round(sb.y - rb.y)}` : "";
      add(
        "warning",
        "duplicate-root-subtree",
        `'${stray.name}' (${stray.id})${at} duplicates '${twin.node.name}' (${twin.node.id}) \u2014 a stray copy laid over the frame; build the in-flow one and record this as a design artefact (plan.deviations / a verify waiver)`,
        stray,
        { label: root.label, path: `${root.tree.name} > ${stray.name}` },
        { twinId: twin.node.id }
      );
    }
  }
}
var valuesOf = (c) => {
  const values = [];
  for (const p of Object.values(c.props || {})) {
    if (p.type === "VARIANT") values.push(...Array.isArray(p.options) ? p.options : Array.isArray(p.observed) ? p.observed : []);
    if (p.type === "BOOLEAN") values.push(String(p.key || "").split("#")[0] ?? "");
  }
  if (c.variant) for (const part of c.variant.split(",")) {
    const v = part.split("=")[1];
    if (v) values.push(v.trim());
  }
  return values;
};
var isSampled = (c) => !!(c.remote || c.derivedFrom === "instances");
var sameDir = (a, b) => b !== void 0 && path11.resolve(a) === path11.resolve(b);
function stateLookup(ac) {
  const { opts, docs, catalog } = ac;
  const screenCollKeys = new Set(docs.flatMap((d) => (d.vars && d.vars.collections || []).map((c) => c.key)).filter((k) => !!k));
  const fullCatalogs = [];
  if (catalog.length) fullCatalogs.push({ label: "--catalog", components: catalog, byName: true });
  const dsCatalog = opts.designSystem && opts.designSystem.components;
  if (dsCatalog && dsCatalog !== opts.catalog && Array.isArray(dsCatalog.components)) fullCatalogs.push({ label: opts.designSystemDir || "the design system", components: dsCatalog.components, byName: true });
  for (const lib of opts.libraries || []) {
    if (!lib.components || sameDir(lib.rel, opts.designSystemDir)) continue;
    const unknown = !screenCollKeys.size || !lib.collectionKeys.length;
    fullCatalogs.push({ label: lib.rel, components: lib.components.components, byName: unknown || lib.collectionKeys.some((k) => screenCollKeys.has(k)), unproven: unknown });
  }
  const sampledCatalog = opts.designSystem && opts.designSystem.componentsLibrary && opts.designSystem.componentsLibrary.components || [];
  const hasVariants = (c) => !!c.variant || Object.values(c.props || {}).some((p) => p.type === "VARIANT");
  const merged = (rows, label, matchedBy, sampled) => {
    const withVariants = rows.filter(hasVariants);
    const use = withVariants.length ? withVariants : rows;
    const first = use[0];
    if (!first) return null;
    const distinct = new Set(use.map((c) => c.key || c.id || c)).size;
    return { def: first, values: use.flatMap(valuesOf), label: distinct > 1 && !sampled ? `${label} \u2014 ${distinct} rows named '${first.name}', read together` : label, matchedBy, sampled };
  };
  function stateDefOf(u) {
    const keys = [u.key, u.variantKey].filter((k) => !!k);
    const keyHit = (c) => !!c.key && keys.includes(c.key);
    for (const cat of fullCatalogs) {
      const def = cat.components.find(keyHit);
      if (def) return { def, values: valuesOf(def), label: cat.label, matchedBy: "key", sampled: isSampled(def) };
    }
    const sampledKey = sampledCatalog.find(keyHit);
    const sampledDef = sampledKey ? merged(sampledCatalog.filter((c) => keyHit(c) || c.name === sampledKey.name), "components.library.json", "key", true) : null;
    if (u.name !== void 0) {
      for (const cat of fullCatalogs) {
        if (!cat.byName || cat.unproven && sampledDef) continue;
        const found = merged(cat.components.filter((c) => c.name === u.name), cat.label, "name", false);
        if (found) return { ...found, values: [...found.values, ...sampledDef ? sampledDef.values : []], sampled: isSampled(found.def) };
      }
    }
    return sampledDef || (u.name === void 0 ? null : merged(sampledCatalog.filter((c) => c.name === u.name), "components.library.json", "name", true));
  }
  return { screenCollKeys, fullCatalogs, sampledCatalog, stateDefOf };
}
function componentStates(ac, lookup) {
  const { platform, catalog, usedComponents, add } = ac;
  const { fullCatalogs, sampledCatalog, stateDefOf } = lookup;
  const components = [];
  const unchecked = [];
  const candidates = usedComponents.size ? [...usedComponents.values()].filter((u) => !u.icon).map((u) => ({ use: u, found: stateDefOf(u) })) : catalog.filter((c) => c.type === "COMPONENT_SET" || c.type === "COMPONENT").map((c) => ({ use: { name: c.name }, found: { def: c, values: valuesOf(c), label: "--catalog", matchedBy: "name", sampled: isSampled(c) } }));
  for (const { use, found } of candidates) {
    const kind = controlKind(use.name) || found && controlKind(found.def.name);
    if (!kind) continue;
    const need = requiredStates(kind, platform);
    if (!found) {
      components.push({ name: use.name ?? "", kind, known: false, present: [], missing: [], note: "in no component catalog \u2014 states unknown" });
      if (need.length) unchecked.push(use.name ?? "");
      continue;
    }
    const { def, values, label, matchedBy, sampled } = found;
    const norm = values.map((v) => String(v).trim().toLowerCase());
    const present = CONTROL_STATES.filter((s) => norm.some((v) => STATE_SYNONYMS[s].test(v)));
    const missing = need.filter((s) => !present.includes(s));
    components.push({ name: def.name, kind, known: true, sampled, present, missing, catalog: label, matchedBy });
    if (missing.length) {
      const where = `${label}${matchedBy === "name" ? ", matched by NAME only" : ""}`;
      add(sampled ? "info" : "warning", "missing-component-states", `${kind} '${def.name}' has no ${missing.join("/")} state${missing.length > 1 ? "s" : ""} in its variants (${where})${sampled ? " \u2014 sampled from instances, so this may be incomplete rather than missing" : ""} \u2014 ask the designer or derive from tokens, and say so`, null, null, { component: def.name, missing });
    }
  }
  if (unchecked.length) {
    const tried = [...fullCatalogs.map((c) => c.label), ...sampledCatalog.length ? ["components.library.json"] : []];
    add(
      "warning",
      "component-states-unchecked",
      `states could not be checked for ${unchecked.length} control(s) \u2014 ${unchecked.slice(0, 6).map((n) => `'${n}'`).join(", ")}${unchecked.length > 6 ? ", \u2026" : ""} \u2014 ` + (tried.length ? `none of the catalogs this run read (${tried.join(", ")}) defines them` : "no component catalog was given") + `. Missing hover/pressed/focus/disabled designs are invisible here: pass the catalog that defines them (a library export: --design-system <export>/libraries/<dir>), or ask the designer`,
      null,
      null,
      { controls: unchecked }
    );
  }
  return { components, unchecked };
}
function undesignedOpenStates(ac, lookup) {
  const { pickers, usedComponents, add } = ac;
  const { stateDefOf } = lookup;
  const openStates = /* @__PURE__ */ new Map();
  for (const p of pickers) {
    const u = usedComponents.get(p.useKey);
    const def = u ? stateDefOf(u) : null;
    if (def && def.values.some((v) => STATE_SYNONYMS.open.test(String(v).trim().toLowerCase()))) continue;
    const k = `${p.here.label}|${p.useKey}|${p.cue}`;
    const row = openStates.get(k);
    if (row) row.nodes.push(p.node.id);
    else openStates.set(k, { node: p.node, here: p.here, cue: p.cue, nodes: [p.node.id] });
  }
  for (const o of openStates.values()) {
    add(
      "info",
      "undesigned-open-state",
      `'${o.node.name}'${o.nodes.length > 1 ? ` (\xD7${o.nodes.length})` : ""} (${o.cue}) reads like a select/picker; no open state (list/calendar) is drawn \u2014 ask, or extract the frame that draws it`,
      o.node,
      o.here,
      { nodeIds: o.nodes }
    );
  }
  return openStates;
}
function screenStatesOf(ac) {
  const { roots, stateHits, validationHits, inputsSeen } = ac;
  const stateOf = (s) => stateHits[s].length ? "designed" : "not-found";
  const allDialogs = roots.length > 0 && roots.every((r) => DIALOG_NAME.test(r.tree.name || ""));
  const screenStates = {
    loading: stateOf("loading"),
    empty: allDialogs && !stateHits.empty.length ? "not-applicable" : stateOf("empty"),
    error: stateOf("error"),
    ...inputsSeen ? { validation: validationHits.length ? "designed" : "not-found" } : {}
  };
  const screenStatesScope = { rootsAudited: roots.length, singleFrame: roots.length === 1 };
  return { allDialogs, screenStates, screenStatesScope };
}
function heavyAssets(ac) {
  const { docs, hiddenIds, nodesById, add } = ac;
  for (const d of docs) {
    const a = d.assets;
    if (!a || !Array.isArray(a.heavy)) continue;
    const label = labelledRoots(d.doc, d.label)[0]?.label ?? d.label;
    for (const h of a.heavy) {
      const nodeId = (Array.isArray(a.files) ? a.files : []).find((f) => f.file === h.file)?.node;
      if (nodeId && hiddenIds.has(nodeId)) continue;
      const node = nodeId ? nodesById.get(nodeId) : void 0;
      const mb = (h.bytes / 1048576).toFixed(2);
      const msg = isRasterShell(h.embeddedRaster, h.paths) ? `'${h.file}' is ${mb} MB \u2014 a raster image embedded in an SVG shell; use it as an image (<img src>/URL import) or ask the designer for a PNG/JPG export of that layer. Do not inline it` : `'${h.file}' is ${mb} MB${h.paths ? ` / ${h.paths} <path> elements` : ""} \u2014 too heavy to inline; import it by URL, or ask the designer for a raster export. Do not redraw or simplify it`;
      add("info", "heavy-asset", msg, node || null, { label }, { file: h.file, bytes: h.bytes, ...ifDefined("paths", h.paths), ...ifDefined("embeddedRaster", h.embeddedRaster) });
    }
  }
}
function prototypeLinks(ac) {
  const { opts, navigations, nodesById, hiddenIds, add } = ac;
  const nb = opts.neighbours;
  const exportedIds = nb ? new Set(nb.layers.map((l) => l.id)) : null;
  const shotIds = new Set(nb && nb.unexportedShots || []);
  const unexportedTargets = /* @__PURE__ */ new Map();
  for (const n of navigations.values()) {
    const id = n.destinationId;
    const missing = exportedIds !== null && !!id && !exportedIds.has(id) && !nodesById.has(id) && !hiddenIds.has(id);
    add(
      "info",
      "prototype-navigation",
      `${n.count} layer(s) (e.g. '${n.node.name}') ${n.navigation === "overlay" ? "open" : n.navigation === "swap" ? "swap to" : "go to"} '${n.destination ?? "an unnamed frame"}'${n.destinationId ? ` (${n.destinationId})` : ""} in the prototype \u2014 confirm this is the intended behaviour before wiring it (a link copied along with a layer looks the same as a designed one)${missing ? " \u2014 NOT exported" : ""}`,
      n.node,
      { label: n.label },
      { ...ifDefined("destination", n.destination), ...ifDefined("destinationId", n.destinationId), navigation: n.navigation, sources: n.count, ...missing ? { exported: false } : {} }
    );
    if (missing && id && (n.navigation === "overlay" || n.navigation === "swap")) {
      const rows = unexportedTargets.get(n.label) || [];
      rows.push({ n, id });
      unexportedTargets.set(n.label, rows);
    }
  }
  for (const [label, rows] of unexportedTargets) {
    const list = rows.map(({ n, id }) => `'${n.destination ?? "an unnamed frame"}' (${id}) opened by '${n.node.name}'${shotIds.has(id) ? ` \u2014 screenshotted only (assets/${safe(id)}_ref.png)` : ""}`);
    const first = rows[0];
    add(
      "warning",
      "prototype-target-not-exported",
      `${rows.length} prototype target(s) this screen opens are in no index of the export: ${list.join("; ")} \u2014 pull them (\`dtwin pull --node <id>\`; MCP: \`figma_export_url\`) before building, or the builder has nothing to build the dialog from. A frame nested in a SECTION or another frame has no index row of its own: search design/export/pages for the id before pulling`,
      first ? first.n.node : null,
      { label },
      { ids: rows.map((r) => r.id) }
    );
  }
}
function tokenBindingOf(ac) {
  const { binding, add } = ac;
  const bindingOf = (k) => {
    const [b, t] = binding[k];
    return { bound: b, total: t, pct: t ? Math.round(b / t * 100) : null };
  };
  const tokenBinding = { color: bindingOf("color"), typography: bindingOf("typography"), spacing: bindingOf("spacing"), radius: bindingOf("radius"), effects: bindingOf("effects") };
  for (const k of AUDIT_CATEGORIES) {
    const v = tokenBinding[k];
    if (v.total >= 5 && v.pct !== null && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) \u2014 expect to carry raw values through EXACTLY and report each as unbound; do not snap them to the nearest token`, null, null, { category: k });
  }
  return tokenBinding;
}
function openQuestions(ac, { allDialogs, screenStates, unchecked, components, copyQuestions, openStates, nearToken }) {
  const { opts, roots, findings, add } = ac;
  const questions = [];
  const STATE_QUESTION = {
    loading: allDialogs ? "what shows while the dialog's action runs (disabled buttons, spinner, can it be dismissed)?" : "what shows while data loads (skeleton vs spinner, delay before showing)?",
    empty: "what shows when there's no data (first use vs no results vs cleared)?",
    error: "what shows when a request fails (inline vs full-screen, retry, offline)?"
  };
  const auditedIds = new Set(roots.map((r) => r.tree && r.tree.id).filter((id) => !!id));
  const layers = opts.neighbours && opts.neighbours.layers || [];
  const pageIds = new Set(layers.filter((l) => auditedIds.has(l.id)).map((l) => l.pageId).filter((p) => !!p));
  const auditedRows = layers.filter((l) => auditedIds.has(l.id));
  const ownTitles = new Set(auditedRows.map((l) => alnumKey(l.title)).filter((x) => x.length >= 3));
  const ownNames = new Set(roots.map((r) => alnumKey(r.tree.name)).filter((x) => x.length >= 3));
  const nameCount = /* @__PURE__ */ new Map();
  for (const l of layers) if (l.pageId !== void 0 && pageIds.has(l.pageId)) nameCount.set(alnumKey(l.name), (nameCount.get(alnumKey(l.name)) ?? 0) + 1);
  const ownPhrases = [...roots.map((r) => r.tree.name), ...auditedRows.map((l) => l.title)].map((t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter((t) => t.length >= 4);
  const sameSize = (l) => auditedRows.some((a) => a.w === l.w && a.h === l.h);
  for (const s of STATE_KEYS) {
    if (screenStates[s] !== "not-found") continue;
    const candidates = layers.filter((l) => !auditedIds.has(l.id) && l.pageId !== void 0 && pageIds.has(l.pageId)).map((l) => {
      const own = opts.neighbours?.textsOf?.(l);
      return { l, text: [l.title, ...(own && (s === "empty" ? own.all : own.shallow)) ?? l.texts ?? []].find((t) => !!t && STATE_WORDS[s].test(t)) };
    }).filter((c) => c.text !== void 0).map((c) => {
      const t = alnumKey(c.l.title);
      const titleMatch = t.length >= 3 && (ownTitles.has(t) || ownNames.has(t));
      const titlesDisagree = t.length >= 3 && ownTitles.size > 0 && !ownTitles.has(t);
      const nameMatch = ownNames.has(alnumKey(c.l.name)) && (nameCount.get(alnumKey(c.l.name)) ?? 0) <= 2 && !titlesDisagree;
      const named = titleMatch || nameMatch ? 3 : 0;
      const said = ownPhrases.some((p) => c.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(p)) ? 2 : 0;
      return { id: c.l.id, name: c.l.name, text: c.text, score: named + said + (sameSize(c.l) ? 1 : 0), related: named + said > 0 };
    }).filter((c) => c.related).sort((x, y) => y.score - x.score).slice(0, 3).map(({ id, name, text }) => ({ id, name, text }));
    if (candidates.length) {
      const list = candidates.map((c) => `'${c.name}' (${c.id}: "${c.text}")`).join(", ");
      add("info", "state-in-sibling", `no ${s} state in the audited frame, but ${list} on the same page read${candidates.length === 1 ? "s" : ""} like one \u2014 audit it with this screen before asking the designer`, null, null, { state: s, candidates });
      questions.push(`No ${s} state in this frame \u2014 is ${list} this screen's ${s} state? If not: ${STATE_QUESTION[s]}`);
    } else questions.push(`No ${s} state was found in the exported layers \u2014 ${STATE_QUESTION[s]}`);
  }
  const shots = opts.neighbours && opts.neighbours.unexportedShots || [];
  if (shots.length) {
    add("info", "unexported-frames", `${shots.length} frame(s) were screenshotted into assets/ but never exported (${shots.slice(0, 8).join(", ")}${shots.length > 8 ? ", \u2026" : ""}) \u2014 look at assets/<id>_ref.png; a state of this screen among them is "designed but not exported": extract it rather than asking`, null, null, { ids: shots });
  }
  if (screenStates.validation === "not-found") questions.push("No validation state was found for this screen's inputs \u2014 how do field errors show (inline message, when: on blur or on submit, and what does each field require)?");
  if (unchecked.length) questions.push(`The states of ${unchecked.slice(0, 6).map((n) => `'${n}'`).join(", ")}${unchecked.length > 6 ? ", \u2026" : ""} could not be checked (no catalog defines them) \u2014 are hover/pressed/focus/disabled designed somewhere?`);
  for (const c of components.filter((c2) => c2.missing && c2.missing.length)) questions.push(`'${c.name}' has no ${c.missing.join("/")} design \u2014 use the design-system default, or is there a spec?`);
  if (findings.some((f) => f.code === "fixed-size-text")) questions.push("Several text boxes are fixed-size \u2014 at 200% font scale or in a longer language, should they wrap, truncate (how many lines), or grow?");
  questions.push(...copyQuestions);
  if (openStates.size) {
    const list = [...openStates.values()].map((o) => `'${o.node.name}' ${o.node.id} (${o.cue})`);
    questions.push(`${list.join(", ")} read${list.length === 1 ? "s" : ""} like a select/picker with no open state drawn \u2014 what does the open list (or calendar) look like: the platform's native picker, or a designed one (which frame)? \u2192 Default: the platform's native control, styled with the field's tokens.`);
  }
  if (nearToken.length) questions.push(`Unbound colour${nearToken.length === 1 ? "" : "s"} a hair off a token \u2014 ${nearToken.join("; ")}: a typo of the token, or deliberate? \u2192 Default: the literal exactly as drawn, flagged.`);
  return questions;
}
function crossFilePass(ac) {
  const { opts, docs, hiddenIds, findings } = ac;
  let crossFile;
  const crossOrigin = /* @__PURE__ */ new Map();
  let hiddenFindingsOmitted = 0;
  if (opts.designSystem || opts.variables) {
    crossFile = crossCheck(crossCheckInputOf({ ...opts, screens: docs }, { components: opts.catalog }));
    const crossIds = findingIds(crossFile.findings);
    crossFile.findings.forEach((f, i) => {
      const id = crossIds[i];
      if (!f.id && id) f.id = id;
    });
    for (const f of crossFile.findings) {
      if (f.severity === "info") continue;
      if (f.nodeId && hiddenIds.has(f.nodeId)) {
        hiddenFindingsOmitted++;
        continue;
      }
      const { severity, code, message, ...rest } = f;
      const merged = { severity, code, message, crossFile: true, ...rest };
      findings.push(merged);
      crossOrigin.set(merged, f);
    }
  } else {
    crossFile = {
      summary: { blockers: 0, warnings: 0, info: 0 },
      findings: [],
      coverage: null,
      notChecked: [
        `the whole cross-FILE pass \u2014 no design system was given, and none was found beside the export. Every token-binding percentage below means "resolves to some variable in this screen's own file", NOT "matches your design system". Re-run with --design-system design/export/design-system to tell the two apart.`
      ],
      inputs: {}
    };
  }
  return { crossFile, crossOrigin, hiddenFindingsOmitted };
}
function libraryNotes(ac, crossFile, screenCollKeys) {
  const { opts } = ac;
  for (const lib of opts.libraries || []) {
    if (sameDir(lib.rel, opts.designSystemDir)) continue;
    const shared = lib.collectionKeys.filter((k) => screenCollKeys.has(k)).length;
    crossFile.notChecked.push(
      `the library export ${lib.rel} ('${lib.name}') \u2014 the cross-file pass did not compare this screen against it` + (screenCollKeys.size ? ` (the screen binds ${shared} of its ${screenCollKeys.size} variable collection(s) from it by key)` : "") + `. Its components.json ${lib.components ? "WAS" : "could not be"} read for the component-state check. To check tokens, text styles and components against it, re-run with --design-system ${lib.rel}.`
    );
  }
}
function applyOverrides(ac, crossFile, crossOrigin) {
  const { opts, findings } = ac;
  const overridesUnmatched = [];
  for (const o of opts.overrides || []) {
    const hits = findings.filter((f) => f.code === o.code && OVERRIDE_KEYS.every((k) => o[k] === void 0 || f[k] === o[k]));
    const named = OVERRIDE_KEYS.some((k) => o[k] !== void 0);
    let why = null;
    if (!hits.length) why = "matched no finding \u2014 the finding changed or is gone";
    else if (!named && (hits.length > 1 || hits.some((f) => OVERRIDE_KEYS.some((k) => k !== "screen" && f[k] !== void 0))))
      why = `too broad \u2014 name the finding (${OVERRIDE_KEYS.filter((k) => hits.some((f) => f[k] !== void 0)).join(" / ")})`;
    else if (o.severity === "blocker" && !BLOCKER_CODES.includes(o.code)) why = `only ${BLOCKER_CODES.join(", ")} can be blockers`;
    else if (!o.decidedBy && hits.some((f) => !f.overridden && f.severity === "blocker")) why = "downgrading a blocker needs decidedBy (whose decision it was)";
    if (why) {
      overridesUnmatched.push({ ...o, why });
      continue;
    }
    for (const f of hits) {
      if (f.overridden || f.severity === o.severity) continue;
      f.overridden = { from: f.severity, reason: o.reason, ...ifDefined("decidedBy", o.decidedBy), ...ifDefined("decidedAt", o.decidedAt) };
      f.severity = o.severity;
      const orig = crossOrigin.get(f);
      if (orig) {
        orig.overridden = f.overridden;
        orig.severity = f.severity;
      }
    }
  }
  if (crossOrigin.size) {
    const cf = crossFile.findings;
    crossFile.summary = { blockers: cf.filter((f) => f.severity === "blocker").length, warnings: cf.filter((f) => f.severity === "warning").length, info: cf.filter((f) => f.severity === "info").length };
  }
  return overridesUnmatched;
}
function finishFindings(ac, questions) {
  const { findings } = ac;
  for (const f of findings) if (f.crossFile && f.confirm && !f.overridden) questions.push(`Confirm (${f.code}): ${f.confirm}`);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const ownIds = findingIds(findings.filter((f) => !f.crossFile));
  let own = 0;
  findings.forEach((f, i) => {
    const { severity, code, id, ...rest } = f;
    findings[i] = { severity, code, id: f.crossFile && id ? id : ownIds[own] ?? code, ...rest };
    if (!f.crossFile) own++;
  });
}
function pathTail(p) {
  const parts = p.split(" > ");
  return parts.length > 3 ? "\u2026 > " + parts.slice(-3).join(" > ") : p;
}
function toMarkdown(res) {
  const L = [];
  L.push(`# Design audit \u2014 ${res.screens.join(", ") || "(no screens)"}`, "");
  const gridNote = res.gridMismatch ? ` *(${res.gridAssumed ? "DEFAULT \u2014 not given" : "as given"}; this system's own spacing tokens step by ${res.gridMismatch}px, not ${res.grid}px \u2014 pass \`--grid ${res.gridMismatch}\`)*` : res.gridAssumed ? " *(default \u2014 not given)*" : "";
  L.push(`Platform: **${res.platform}**${res.platformAssumed ? " *(ASSUMED \u2014 not given)*" : ""} \xB7 grid ${res.grid}px${gridNote} \xB7 **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
  if (res.overridesUnmatched && res.overridesUnmatched.length) {
    L.push(`> \u26A0\uFE0F ${res.overridesUnmatched.length} recorded severity decision(s) were NOT applied \u2014 review the overrides file:`);
    for (const o of res.overridesUnmatched) L.push(`> - \`${o.code}\`${o.nodeId ? ` on ${o.nodeId}` : ""}${o.token ? ` (${o.token})` : ""}: ${o.why}`);
    L.push("");
  }
  if (res.hiddenLayers && res.hiddenLayers.nodesSkipped) L.push(`*${res.hiddenLayers.nodesSkipped} node(s) on hidden layers (switched off in Figma) were skipped \u2014 they are not built, and no finding below cites one.*`, "");
  if (res.platformAssumed) {
    L.push(
      `> \u26A0\uFE0F **No platform was given, so this audit assumed \`web\`.** Touch-target minimums, shadow`,
      `> spread, blur and blend-mode support all differ per platform \u2014 on the wrong one, every one of`,
      `> those findings is wrong. Confirm it, then re-run with \`--platform ios|android|react-native|flutter\``,
      `> (or write \`design/target.json\`, which both this audit and build-screen read).`,
      ""
    );
  }
  const cf = res.crossFile;
  if (cf) {
    L.push("## Does this screen come from that design system?", "");
    if (cf.coverage && cf.coverage.distinct) {
      const c = cf.coverage;
      L.push(
        `**${c.matchedByLocalKey}/${c.distinct} (${c.localPct}%)** of the components on this screen resolve to the design system's component catalog **by key**` + (c.matchedByName ? `; ${c.matchedByName} more match by NAME only and are unverified` : "") + (c.ambiguousName ? `; ${c.ambiguousName} share a name with several catalog entries and were left unmatched` : "") + ".",
        ""
      );
      if (c.rekey && c.rekey.rekeyed) {
        L.push(
          `**This is the re-keyed-copy case, not a foreign library:** ${c.rekey.proposed} of the ${c.rekey.withCandidates} component(s) whose name is in the catalog also match it by prop signature. The proposed matches are listed under \`crossFile.componentProposals\` \u2014 confirm them with the user, then the map-bootstrap script with \`--from-proposals\` stubs exactly those.`,
          ""
        );
      }
    }
    const cfBlock = cf.findings.filter((f) => f.severity !== "info" || f.code === "token-name-collision-elsewhere");
    if (cfBlock.length) {
      for (const f of cfBlock) L.push(`- **${f.severity}** \`${f.code}\` ${f.message}${f.overridden ? ` *(was ${f.overridden.from}: ${f.overridden.reason})*` : ""}`);
      L.push("");
    } else if (cf.inputs && cf.inputs.tokens) {
      L.push("No cross-file problem found: the screen's tokens, text styles and components all trace to the design system you exported.", "");
    }
    if (cf.notChecked && cf.notChecked.length) {
      L.push("*Not checked \u2014 these are gaps in the INPUT, not clean results:*", "");
      for (const n of cf.notChecked) L.push(`- ${n}`);
      L.push("");
    }
  }
  L.push("## Token binding", "");
  L.push(
    '*"Bound" means the node binds SOME variable \u2014 read it together with the section above, which says whether',
    "that variable is one the design system defines.*",
    "",
    "| Category | Bound | Total | % |",
    "|---|---|---|---|"
  );
  for (const [k, v] of Object.entries(res.tokenBinding)) L.push(`| ${k} | ${v.bound} | ${v.total} | ${v.pct == null ? "\u2013" : v.pct + "%"} |`);
  L.push("", "## Screen states", "");
  const scope = res.screenStatesScope || {};
  if (scope.singleFrame) {
    L.push(
      `*Scope: **one frame** was audited. "not found" below means "not in this frame" \u2014 it does not`,
      `mean the state is missing from the Figma file. Export the other frames to tell the two apart.*`,
      ""
    );
  } else if (scope.rootsAudited !== void 0 && scope.rootsAudited > 1) {
    L.push(`*Scope: ${scope.rootsAudited} frames audited \u2014 "not found" means none of them drew it.*`, "");
  }
  for (const [k, v] of Object.entries(res.screenStates)) {
    L.push(`- ${k}: ${v === "designed" ? "designed" : v === "not-applicable" ? "not applicable (a dialog has no data list)" : scope.singleFrame ? "**not in this frame \u2014 ask**" : "**not found \u2014 ask**"}`);
  }
  if (res.components.length) {
    L.push("", "## Component states", "", "| Component | Kind | Present | Missing | Catalog |", "|---|---|---|---|---|");
    for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "\u2013"} | ${c.known ? c.missing.join(", ") || "none" : c.note}${c.sampled ? " (sampled)" : ""} | ${c.catalog ? `${c.catalog}${c.matchedBy === "name" ? " (by name)" : ""}` : "\u2013"} |`);
  }
  for (const sev of ["blocker", "warning", "info"]) {
    const fs14 = res.findings.filter((f) => f.severity === sev);
    if (!fs14.length) continue;
    L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs14.length})`, "");
    for (const f of fs14) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` \u2014 node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}${f.path ? ` (${pathTail(f.path)})` : ""}${f.overridden ? ` *(was ${f.overridden.from}: ${f.overridden.reason})*` : ""}`);
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
function blockerIds(auditDoc) {
  const findings = reportFindings(auditDoc);
  const ids = findingIds(findings.map((f) => ({ code: f.code || "blocker", nodeId: f.nodeId })));
  return findings.flatMap((f, i) => f.severity === "blocker" ? [f.id || ids[i] || f.code || "blocker"] : []);
}
function reportFindings(auditDoc) {
  const findings = auditDoc && typeof auditDoc === "object" && "findings" in auditDoc && Array.isArray(auditDoc.findings) ? auditDoc.findings : [];
  const str = (v) => typeof v === "string" && v ? v : void 0;
  return findings.filter(isJsonObject).map((f) => ({ ...ifDefined("code", str(f.code)), ...ifDefined("nodeId", str(f.nodeId)), ...ifDefined("severity", str(f.severity)), ...ifDefined("id", str(f.id)) }));
}
var OVERRIDE_KEYS = ["nodeId", "token", "component", "collection", "mode", "category", "state", "screen"];
var BLOCKER_CODES = ["export-truncated", "assets-failed", "missing-font", "token-name-collision"];
function main(argv) {
  const USAGE = `usage: ${scriptCmd("audit")} <screen.json>... [--platform web|ios|android|react-native|flutter]
       [--design-system design/export/design-system] [--variables design/export/variables.json]
       [--catalog components.local.json] [--grid 4] [--out design/audit] [--overrides <file>] [--json] [--gate] [--force]
  --overrides defaults to <out>.overrides.json when it exists: { overrides: [{ code, nodeId?, token?,
  component?, severity, reason, decidedBy?, decidedAt? }] } \u2014 the user's severity decisions, applied to
  BOTH the .json and the .md (never hand-edit severities in the .md).
  A design system turns on the cross-FILE pass (does this screen come from that design system?): --design-system
  takes design/export/design-system or a library export, design/export/libraries/<dir>; without it, the
  design-system/ of the export the screen sits in is used when there is one (stderr names it). With none, every
  token-binding % below means "binds SOME variable", not "matches your design system".
  --out defaults to design/audit/<input file's own basename> \u2014 the same <LayerName>__<node-id>
  name the export gave the screen file, so re-auditing the same screen always lands on the same
  report pair instead of a new name each run. Refuses (exit 1) if an existing report in the same
  directory already covers this node under a DIFFERENT name \u2014 pass --force to write a second one.`;
  const OPTIONS = {
    platform: { type: "string" },
    catalog: { type: "string" },
    "design-system": { type: "string" },
    variables: { type: "string" },
    grid: { type: "string" },
    out: { type: "string" },
    overrides: { type: "string" },
    json: { type: "boolean" },
    gate: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  };
  const { values: flags, positionals: files } = cliParse("audit", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const firstFile = files[0];
  if (firstFile === void 0) {
    console.error(USAGE);
    return 2;
  }
  const { platform, catalog: catalogFile, "design-system": dsDir, variables: varsFile, grid: gridArg, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate, force = !!flags.force;
  if (platform && !PLATFORMS.includes(platform)) {
    console.error(`--platform must be one of ${PLATFORMS.join(", ")}`);
    return 2;
  }
  const grid = gridArg === void 0 ? void 0 : Number(gridArg);
  if (grid !== void 0 && !(Number.isFinite(grid) && grid > 0)) {
    console.error(`--grid must be a positive number of px, got ${JSON.stringify(gridArg)}`);
    return 2;
  }
  const read = readScreenInputs(files, { variables: varsFile, designSystem: dsDir });
  if ("errors" in read) {
    for (const e of read.errors) console.error(e);
    return 2;
  }
  const ctx = read.inputs;
  for (const n of ctx.notes) console.error(n);
  const inputs = ctx.screens;
  const catalog = catalogFile ? readSplitFile(catalogFile, "component catalog", isComponentsCatalog, "components", "design-system/components.local.json") : void 0;
  const ds = ctx.designSystem;
  const designSystem = withCatalog(ds, catalog) ?? void 0;
  const neighbours = findExportNeighbours(firstFile);
  const outBase = out || path11.join(AUDIT_DIR, path11.basename(firstFile, ".json"));
  const ownOverrides = outBase + ".overrides.json";
  const stem = path11.basename(outBase), dot = stem.indexOf(".");
  const parentOverrides = dot > 0 ? path11.join(path11.dirname(outBase), stem.slice(0, dot) + ".overrides.json") : null;
  const overridesFile = flags.overrides || (!fs13.existsSync(ownOverrides) && parentOverrides && fs13.existsSync(parentOverrides) ? parentOverrides : ownOverrides);
  const overridesDoc = flags.overrides ? readDocFile(overridesFile, "audit overrides", isAuditOverridesDoc) : readOptionalDoc(overridesFile, "audit overrides", isAuditOverridesDoc);
  const res = audit(inputs, {
    map: ctx.map,
    siblings: ctx.siblings,
    ...overridesDoc ? { overrides: overridesDoc.overrides } : {},
    ...ifDefined("platform", platform),
    ...ifDefined("catalog", catalog),
    ...ifDefined("designSystem", designSystem),
    ...ifDefined("designSystemDir", ds?.dir),
    libraries: ctx.libraries,
    neighbours,
    variables: ctx.variables,
    variablesPath: ctx.variablesPath,
    sliceSources: ctx.sliceSources,
    ...ifDefined("grid", grid)
  });
  const md = jsonOnly ? "" : toMarkdown(res);
  if (!jsonOnly && outBase && res.nodeIds && res.nodeIds.length) {
    const c = nodeArtefacts(process.cwd(), { auditDir: path11.dirname(outBase) || "." }).claim("audit report", res.nodeIds[0] ?? "", { target: outBase + ".json" });
    if (!c.ok && !force) {
      console.error(`error  ${c.why}: refusing to also write ${outBase}.json/.md. Use that existing name, or pass --force to write this one anyway.`);
      return 1;
    }
  }
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (outBase) {
    fs13.mkdirSync(path11.dirname(outBase), { recursive: true });
    fs13.writeFileSync(outBase + ".json", JSON.stringify(res, null, 2) + "\n");
    fs13.writeFileSync(outBase + ".md", md);
    console.error(`wrote ${outBase}.json and ${outBase}.md`);
  } else {
    process.stdout.write(md);
  }
  if (overridesDoc) console.error(`overrides: ${overridesFile} (${overridesDoc.overrides.length} decision(s))`);
  for (const o of res.overridesUnmatched || []) console.error(`warn  override for ${o.code}${o.nodeId ? ` on ${o.nodeId}` : ""}${o.token ? ` (${o.token})` : ""} NOT applied: ${o.why} \u2014 review ${overridesFile}`);
  if (res.platformAssumed) console.error("warn  no --platform given \u2014 assumed 'web'. Touch targets, shadow spread and blur support differ per platform; pass --platform or write design/target.json.");
  if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.crossFile && res.crossFile.notChecked || []) console.error(`note  not checked: ${n}`);
  return gate && res.summary.blockers > 0 ? 1 : 0;
}
if (import.meta.main) runCli(main, { name: "audit" });
export {
  BLOCKER_CODES,
  TOUCH_MIN,
  audit,
  blockerIds,
  contrastRatio,
  controlKind,
  deltaE,
  main,
  parseHex,
  reportFindings,
  toMarkdown
};
