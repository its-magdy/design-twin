// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/plan-skeleton.ts
import fs12 from "node:fs";
import path13 from "node:path";

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
  (function go(node, parentHidden, path14, ancestors, under, beneath) {
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
      path: path14,
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
    for (const [i, kid] of kids.entries()) go(kid, hidden, (path14 ? path14 + " > " : "") + pathOf(kid, i), chain, inside2, memo(() => beneathOf(node, kids, i)));
  })(root, false, root ? pathOf(root, 0) : "", [], () => NOTHING, () => []);
}
function walkWithHidden(root, fn, opts) {
  walk(root, fn, false, opts);
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

// design-to-code/audit-gate.ts
import path11 from "node:path";

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
function legacyBlockerIds(findings) {
  return findings.filter((f) => f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
}

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
var TAILWIND_SOURCE_NOT_NOTE = `Tailwind v4 scans every file git does not ignore, ${DESIGN_DIR}/ included, so class names quoted in ${DESIGN_DIR}/ notes, audits and plans end up in your CSS. Next to \`@import "tailwindcss";\` in your CSS entry, add \`@source not "<path from that CSS file to ${DESIGN_DIR}/>";\` (e.g. \`@source not "../${DESIGN_DIR}";\` for src/app.css) \u2014 Tailwind v4.1+`;
var VITE_WATCH_IGNORED_NOTE = `With Tailwind v4's automatic source detection, rewriting an existing text file under ${DESIGN_DIR}/ (a re-export, a verify report) makes Vite fully reload the open page. Either add \`server: { watch: { ignored: ['**/${DESIGN_DIR}/**'] } }\` in vite.config (merge it with any existing \`server.watch\` options), or the Tailwind \`@source not\` above \u2014 both stop it`;
var slashed = (p) => p.split(path.sep).join("/");
var VERIFY_GITIGNORE_NOTE = `${slashed(VERIFY_DIR)}/ is regenerated on every verify run (measurements, screenshots, reports) \u2014 consider adding \`${slashed(VERIFY_DIR)}/\` to .gitignore; decisions live in ${slashed(PLAN_DIR)}/ and are not affected`;
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
var DESIGN_SYSTEM_FILES = { TOKENS, COMPONENTS_LOCAL, COMPONENTS_LIBRARY, COMPONENTS_DIR, HYGIENE, MANIFEST };
var DESIGN_SYSTEM_FILE_NAMES = [TOKENS, ...STYLE_KINDS.map((row) => row.file), COMPONENTS_LOCAL, COMPONENTS_LIBRARY, HYGIENE, MANIFEST];

// design-to-code/read-json.ts
import fs2 from "node:fs";

// bridge/src/errmsg.ts
var errMsg = (e) => typeof e === "string" ? e : String(e && e.message || e);
var errCode = (e) => e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : void 0;

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

// design-to-code/design-system-dir.ts
import fs4 from "node:fs";
import path4 from "node:path";

// design-to-code/doc-guards.ts
function optArrayOf(x, each) {
  return x === void 0 || Array.isArray(x) && x.every(each);
}
var optObj = (x) => x === void 0 || isJsonObject(x);
var optStr = (x) => x === void 0 || typeof x === "string";
var anyObject = (x) => isJsonObject(x);
var isAlias = (v) => !!v && typeof v === "object" && "aliasOf" in v && typeof v.aliasOf === "string";
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
function isIndexRowLike(x) {
  return isJsonObject(x) && typeof x.id === "string" && typeof x.name === "string";
}
function isPagesRootIndex(x) {
  return isJsonObject(x) && Array.isArray(x.pageDirs) && x.pageDirs.every((d) => isJsonObject(d) && optStr(d.dir) && optStr(d.index)) && (x.layers === void 0 || Array.isArray(x.layers) && x.layers.every(isIndexRowLike));
}
isPagesRootIndex.expected = "the export's pages/index.json: an object with a `pageDirs` array (and `layers`, when present, an array of {id, name, file})";
function isPageIndex(x) {
  return isJsonObject(x) && Array.isArray(x.layers) && x.layers.every(isIndexRowLike);
}
isPageIndex.expected = "a page index (pages/<Page>/index.json): an object with a `layers` array of {id, name, file}";
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

// design-to-code/export-index.ts
import fs3 from "node:fs";
import path3 from "node:path";

// design-to-code/verify-shared.ts
import path2 from "node:path";
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
  if (/^\d+$/.test(s)) return Number(s);
  const key = s.toLowerCase().replace(/[^a-z]/g, "");
  return WEIGHTS[key] != null ? WEIGHTS[key] : null;
}
function normFamily(v) {
  if (v == null) return null;
  return (String(v).split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
}
function resolveInside(base, rel, within = base) {
  const root = path2.resolve(within), file = path2.resolve(base, ...rel.split("/"));
  return file.startsWith(root + path2.sep) ? file : null;
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

// design-to-code/export-index.ts
var PAGES = "pages";
var INDEX = "index.json";
var rootIndexFile = (exportRoot) => path3.join(exportRoot, PAGES, INDEX);
function pagesRootOfScreen(screenFile) {
  const pages = path3.dirname(path3.dirname(path3.resolve(screenFile)));
  return path3.basename(pages) === PAGES ? path3.dirname(pages) : null;
}
var inside = (root, rel) => rel && !path3.isAbsolute(rel) ? resolveInside(root, rel) : null;
function pageIndexFiles(root, pageDirs) {
  const files = [];
  const add = (f) => {
    if (f !== null && !files.includes(path3.resolve(f))) files.push(path3.resolve(f));
  };
  const ofDir = (dir) => dir && !/[\\/]/.test(dir) && dir !== ".." && dir !== "." ? path3.join(root, PAGES, dir, INDEX) : null;
  for (const pd of pageDirs) add(pd.index ? inside(root, pd.index) : ofDir(pd.dir));
  let dirs = [];
  try {
    dirs = fs3.readdirSync(path3.join(root, PAGES), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
  }
  for (const d of dirs) add(ofDir(d));
  return files;
}
function readExportIndex(exportRoot) {
  const root = exportRoot;
  const read2 = readJson(rootIndexFile(root), isPagesRootIndex);
  const rootDoc = "doc" in read2 ? read2.doc : null;
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
        t = f === null ? -1 : fs3.statSync(f).mtimeMs;
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
  for (const row of rootDoc?.layers ?? []) take(row, true);
  for (const f of pageIndexFiles(root, rootDoc?.pageDirs ?? [])) {
    for (const row of readJsonOrNull(f, isPageIndex)?.layers ?? []) take(row, false);
  }
  return {
    root,
    indexed: rootDoc !== null,
    rootProblem: "error" in read2 && !read2.missing ? read2.error : null,
    rows,
    isExported: (id) => byId.has(id),
    fileOf: (row) => inside(root, row.file)
  };
}

// bridge/src/library-layout.ts
var INDEX2 = "index.json";
var { TOKENS: TOKENS2, HYGIENE: HYGIENE2 } = DESIGN_SYSTEM_FILES;
var COMPONENTS = "components.json";
var LIBRARY_FILE_NAMES = [TOKENS2, ...STYLE_KINDS.map((row) => row.file), COMPONENTS, HYGIENE2, INDEX2];

// design-to-code/design-system-dir.ts
var { TOKENS: TOKENS3, COMPONENTS_LOCAL: COMPONENTS_LOCAL2, COMPONENTS_LIBRARY: COMPONENTS_LIBRARY2 } = DESIGN_SYSTEM_FILES;
var STYLES_TEXT = STYLE_KIND_ROWS.text.file;
function designSystemFiles(dir) {
  const local = path4.join(dir, COMPONENTS_LOCAL2);
  const isLibrary = !fs4.existsSync(local) && fs4.existsSync(path4.join(dir, COMPONENTS));
  return {
    tokens: path4.join(dir, TOKENS3),
    components: isLibrary ? path4.join(dir, COMPONENTS) : local,
    componentsLibrary: path4.join(dir, COMPONENTS_LIBRARY2),
    stylesText: path4.join(dir, STYLES_TEXT),
    componentsFile: isLibrary ? COMPONENTS : COMPONENTS_LOCAL2,
    isLibrary
  };
}

// design-to-code/cli-args.ts
import path5 from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
var SELF = fileURLToPath(import.meta.url);
var shellQuote = (p) => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
var SCRIPT_RUNNER = "bun --no-install --no-env-file";
var shellArg = (a) => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
var scriptCmd = (name) => `${SCRIPT_RUNNER} ${shellQuote(path5.join(path5.dirname(SELF), name + path5.extname(SELF)))}`;
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
  const err = (path14, message) => errors.push({ path: path14, message });
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

// design-to-code/cross-check.ts
if (false) runCli3(main, { name: "cross-check" });

// design-to-code/node-artefacts.ts
import fs9 from "node:fs";
import path10 from "node:path";

// design-to-code/verify-sets.ts
import fs8 from "node:fs";
import path9 from "node:path";

// design-to-code/verify-status.ts
import path8 from "node:path";
import fs7 from "node:fs";

// design-to-code/run-cache.ts
import fs6 from "node:fs";
import os2 from "node:os";
import path7 from "node:path";

// bridge/src/hash.ts
import crypto from "node:crypto";
var sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// bridge/src/file-lock.ts
import crypto2 from "node:crypto";
import fs5 from "node:fs";
import os from "node:os";
import path6 from "node:path";
var STALE_MS = 3e4;
var WAIT_MS = 1e4;
var POLL_MS = 25;
var LIVE_STALE_MS = 2 * 6e4;
var UNWRITTEN_STALE_MS = 2e3;
var TRANSIENT_MS = 2e3;
var TRANSIENT_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
var lockFileOf = (file) => file + ".lock";
var breakGuardOf = (lockFile) => lockFile + ".break";
var LockBusy = class extends Error {
  lockFile;
  constructor(lockFile, message) {
    super(message);
    this.name = "LockBusy";
    this.lockFile = lockFile;
  }
};
var LockLost = class extends LockBusy {
  constructor(lockFile) {
    super(lockFile, `${lockFile} was taken over by another writer while this one held it \u2014 nothing more written; retry`);
    this.name = "LockLost";
  }
};
var PID_NS = (() => {
  if (process.platform !== "linux") return "";
  try {
    return fs5.readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
})();
function holderOf(text) {
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || !("pid" in v) || !("host" in v) || !("at" in v) || !("token" in v)) return null;
    const { pid, host, at, token } = v;
    const ns = "ns" in v ? v.ns : "";
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof host === "string" && typeof at === "number" && typeof token === "string" && typeof ns === "string" ? { pid, host, at, token, ns } : null;
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM";
  }
}
var sameMachine = (h) => h.host === os.hostname() && h.ns === PID_NS;
var thisProcess = () => ({ pid: process.pid, host: os.hostname(), ...PID_NS ? { ns: PID_NS } : {} });
function processState(p) {
  if (!Number.isInteger(p.pid) || p.pid <= 0 || !sameMachine({ host: p.host, ns: p.ns ?? "" })) return "unknown";
  return pidAlive(p.pid) ? "alive" : "gone";
}
var read = (file) => {
  try {
    return fs5.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
var ageOf = (t) => Math.abs(Date.now() - t);
var describeHolder = (text) => {
  const h = text === null ? null : holderOf(text);
  return h ? `process ${h.pid}${h.host !== os.hostname() ? ` on ${h.host}` : ""} since ${new Date(h.at).toISOString()}` : "another process";
};
function isStale(file, text, staleMs) {
  const h = holderOf(text);
  if (h === null) {
    try {
      return ageOf(fs5.statSync(file).mtimeMs) > Math.min(staleMs, UNWRITTEN_STALE_MS);
    } catch {
      return false;
    }
  }
  const state = processState(h);
  if (state !== "unknown") return state === "gone" || ageOf(h.at) > Math.max(staleMs, LIVE_STALE_MS);
  return ageOf(h.at) > staleMs;
}
var stampOf = (token) => JSON.stringify({ ...thisProcess(), at: Date.now(), token });
function claim(file, token) {
  const fd = fs5.openSync(file, "wx");
  const mine = stampOf(token);
  try {
    fs5.writeSync(fd, mine);
  } catch (e) {
    fs5.closeSync(fd);
    fs5.rmSync(file, { force: true });
    throw e;
  }
  fs5.closeSync(fd);
  return read(file) === mine ? mine : null;
}
function breakStale(lockFile, seen, staleMs = STALE_MS) {
  const guard = breakGuardOf(lockFile);
  let mine;
  try {
    mine = claim(guard, crypto2.randomBytes(8).toString("hex"));
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
    const g = read(guard);
    if (g !== null && isStale(guard, g, staleMs) && read(guard) === g) try {
      fs5.unlinkSync(guard);
    } catch {
    }
    return false;
  }
  if (mine === null) return false;
  try {
    if (read(lockFile) !== seen || !isStale(lockFile, seen, staleMs)) return false;
    if (read(guard) !== mine) return false;
    try {
      fs5.unlinkSync(lockFile);
    } catch (e) {
      if (errCode(e) === "ENOENT") return false;
      throw e;
    }
    return true;
  } finally {
    if (read(guard) === mine) try {
      fs5.rmSync(guard, { force: true });
    } catch {
    }
  }
}
var maybeTransient = (code) => process.platform === "win32" && code !== void 0 && TRANSIENT_CODES.has(code);
var sleeper = new Int32Array(new SharedArrayBuffer(4));
var sleepSync = (ms) => {
  Atomics.wait(sleeper, 0, 0, ms);
};
function acquireFileLock(lockFile, opts = {}) {
  const staleMs = opts.staleMs ?? STALE_MS, waitMs = opts.waitMs ?? WAIT_MS;
  const token = crypto2.randomBytes(8).toString("hex");
  fs5.mkdirSync(path6.dirname(path6.resolve(lockFile)), { recursive: true });
  const t0 = Date.now();
  let firstTransientAt = null;
  const transientYet = (e) => {
    if (!maybeTransient(errCode(e))) return false;
    firstTransientAt ??= Date.now();
    return Date.now() - firstTransientAt < TRANSIENT_MS;
  };
  for (; ; ) {
    let mine = null, text = null, transient = false;
    let refused = null;
    try {
      mine = claim(lockFile, token);
    } catch (e) {
      const code = errCode(e);
      if (code === "EEXIST") {
        text = read(lockFile);
        if (text !== null && isStale(lockFile, text, staleMs)) {
          try {
            if (breakStale(lockFile, text, staleMs)) continue;
          } catch (be) {
            if (transientYet(be)) transient = true;
            else refused = be;
          }
        }
      } else if (transientYet(e)) transient = true;
      else throw e;
    }
    if (!transient) firstTransientAt = null;
    if (mine !== null) {
      const held = mine;
      const stillMine = () => read(lockFile) === held;
      return {
        // only our own lock: one broken as stale and taken by another holder is theirs now
        release: () => {
          if (stillMine()) try {
            fs5.rmSync(lockFile, { force: true });
          } catch {
          }
        },
        stillMine,
        assertMine: () => {
          if (!stillMine()) throw new LockLost(lockFile);
        }
      };
    }
    const waited = Date.now() - t0;
    if (waited >= waitMs) {
      if (refused !== null) throw refused;
      if (transient) throw new LockBusy(lockFile, `${lockFile} could not be created for ${Math.round((Date.now() - (firstTransientAt ?? t0)) / 100) / 10}s (a lock just released is still being removed, or a scan holds it); retry`);
      throw new LockBusy(lockFile, `${lockFile} is held by ${describeHolder(text)} \u2014 another write was still in progress after ${Math.round(waited / 100) / 10}s; retry once it is done`);
    }
    sleepSync(Math.min(POLL_MS, waitMs - waited));
  }
}

// design-to-code/run-cache.ts
var CACHE_NAME = "designtwin-verify";
var RUN_CACHE_SEGMENTS = ["node_modules", ".cache", CACHE_NAME];
var shortSha = (s) => sha256Hex(s).slice(0, 16);
var isDir = (p) => {
  try {
    return fs6.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
var exists = (p) => fs6.existsSync(p);
function realpath(p) {
  if (typeof fs6.realpathSync.native === "function") {
    try {
      return fs6.realpathSync.native(p);
    } catch {
    }
  }
  return fs6.realpathSync(p);
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
  return { dir: path7.join(os2.tmpdir(), CACHE_NAME, shortSha(v)), root: v };
}
function runCacheDir(verifyDir) {
  return runCacheOf(verifyDir).dir;
}
function planLockOf(planFile) {
  const abs = canonical(planFile);
  const root = installRootOf(path7.dirname(abs));
  if (root === null) return { lockFile: lockFileOf(planFile), cache: null };
  const rel = path7.relative(root, abs).split(path7.sep).join("/");
  const dir = path7.join(root, ...RUN_CACHE_SEGMENTS);
  return { lockFile: path7.join(dir, "plan-locks", `${path7.basename(abs)}.${shortSha(rel)}.lock`), cache: { dir, root } };
}
var planLockFile = (planFile) => planLockOf(planFile).lockFile;
var PLAN_LOCK_UNWRITABLE = /* @__PURE__ */ new Set(["EACCES", "EPERM", "EROFS"]);
function planLockRefused(planFile, e) {
  const code = errCode(e);
  const { cache } = planLockOf(planFile);
  return cache !== null && code !== void 0 && PLAN_LOCK_UNWRITABLE.has(code) ? new RunCacheUnwritable(cache.dir, cache.root, code) : e;
}
var GONE_CODES = /* @__PURE__ */ new Set(["ENOENT", "ENOTDIR"]);
var RunCacheUnwritable = class extends Error {
  cacheDir;
  root;
  /** `code`: the refusal's errno, or "read" when the run cache exists but cannot be read (--wait). ENOENT / ENOTDIR are
   *  not a permission: a directory on the way was removed while the run wrote there */
  constructor(cacheDir, root, code) {
    super(GONE_CODES.has(code) ? `run cache ${cacheDir} disappeared \u2014 was node_modules reinstalled during the run? (a reinstall clears node_modules/.cache: the live status and the staged files with it) \u2014 start a new run once it is back` : `run cache ${cacheDir} is not ${code === "read" ? "readable" : "writable"} (sandbox write scope?) \u2014 run from ${root} or allow ${code === "read" ? "access" : "writes"} there`);
    this.name = "RunCacheUnwritable";
    this.cacheDir = cacheDir;
    this.root = root;
  }
};

// design-to-code/verify-status.ts
var STATUS_SCHEMA = "designtwin/verify-status@2";
var STATUS_PHASES = ["queued", "starting", "renderer-found", "renderer-ready", "measuring", "measured", "driving", "done", "failed", "blocked"];
var TERMINAL_PHASES = ["done", "failed", "blocked"];
var isPhase = (x) => typeof x === "string" && STATUS_PHASES.some((p) => p === x);
var optStr2 = (x) => x === void 0 || typeof x === "string";
var isOwnRunStamp = (x) => isJsonObject(x) && typeof x.pid === "number" && typeof x.host === "string" && optStr2(x.ns) && typeof x.startedAt === "string" && typeof x.deadline === "string";
var isFailureCount = (x) => typeof x === "number" && Number.isInteger(x) && x >= 0;
var isReplacedRun = (x) => isJsonObject(x) && typeof x.runId === "string" && isPhase(x.phase) && typeof x.at === "string";
function isVerifyStatusV2(x) {
  return isJsonObject(x) && x.schema === STATUS_SCHEMA && typeof x.screen === "string" && typeof x.runId === "string" && typeof x.rev === "number" && isPhase(x.phase) && typeof x.detail === "string" && typeof x.at === "string" && (x.by === "verify-probe" || x.by === "agent" || x.by === "orchestrator") && optStr2(x.expectationSha256) && optStr2(x.measuredSha256) && optStr2(x.evidenceSha256) && (x.published === void 0 || Array.isArray(x.published) && x.published.every((p) => typeof p === "string")) && (x.ownRun === void 0 || isOwnRunStamp(x.ownRun)) && (x.probeFailures === void 0 || isFailureCount(x.probeFailures)) && (x.replaced === void 0 || isReplacedRun(x.replaced));
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
    files = fs7.readdirSync(runCacheDir(verifyDir), { withFileTypes: true });
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
    files = fs8.readdirSync(verifyDir);
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
      files = fs9.readdirSync(abs(auditDir)).filter((f) => f.endsWith(".json") && !f.slice(0, -5).includes(".")).sort();
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
    if (!fs9.existsSync(abs(auditDir))) return null;
    if (hints.screenFile) {
      const own = path10.basename(hints.screenFile, ".json") + ".json";
      if (fs9.existsSync(path10.join(abs(auditDir), own))) return spell(auditDir, own);
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
  function claim2(kind, nodeId, o = {}) {
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
    claim: claim2
  };
}

// design-to-code/audit.ts
var TOUCH_MIN = { web: 24, ios: 44, android: 48, "react-native": 44, flutter: 48 };
var PLATFORMS = Object.keys(TOUCH_MIN);
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
if (false) runCli4(main, { name: "audit" });

// design-to-code/audit-gate.ts
function auditGateStatus(cwd, nodeId, screenFile, screenName) {
  const rel = nodeArtefacts(cwd).auditFor(nodeId, { screenFile, screenName });
  if (!rel) return { auditFile: null, blockers: [], legacyBlockers: [] };
  const r = readJson(path11.join(cwd, rel), isAuditReport);
  if (!("doc" in r)) return { auditFile: rel, blockers: [], legacyBlockers: [], unreadable: true, error: r.error };
  return { auditFile: rel, blockers: blockerIds(r.doc), legacyBlockers: legacyBlockerIds(reportFindings(r.doc)) };
}

// design-to-code/plan-skeleton.ts
import { parseArgs as parseArgs2 } from "node:util";

// bridge/src/json-file.ts
import fs11 from "node:fs";

// bridge/src/atomic-write.ts
import crypto3 from "node:crypto";
import fs10 from "node:fs";
import path12 from "node:path";
var tmpSuffix = () => `.tmp-${process.pid}-${crypto3.randomBytes(4).toString("hex")}`;
var RENAME_RETRY_MS = 2e3;
var RENAME_TRANSIENT = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
var sleeper2 = new Int32Array(new SharedArrayBuffer(4));
function renameOver(from, to) {
  const t0 = Date.now();
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      fs10.renameSync(from, to);
      return;
    } catch (e) {
      const code = errCode(e);
      if (process.platform !== "win32" || code === void 0 || !RENAME_TRANSIENT.has(code) || Date.now() - t0 >= RENAME_RETRY_MS) throw e;
      let dir = false;
      try {
        dir = fs10.statSync(to).isDirectory();
      } catch {
      }
      if (dir) throw e;
      Atomics.wait(sleeper2, 0, 0, delay);
    }
  }
}
function syncDir(dir) {
  if (process.platform === "win32") return;
  try {
    const fd = fs10.openSync(dir, "r");
    try {
      fs10.fsyncSync(fd);
    } finally {
      fs10.closeSync(fd);
    }
  } catch {
  }
}
function writeFileAtomic(file, data, opts = {}) {
  const dir = path12.dirname(path12.resolve(file));
  fs10.mkdirSync(dir, { recursive: true });
  const tmp = file + tmpSuffix();
  try {
    if (opts.sync) {
      const fd = fs10.openSync(tmp, "wx", opts.mode);
      try {
        fs10.writeFileSync(fd, data);
        fs10.fsyncSync(fd);
      } finally {
        fs10.closeSync(fd);
      }
    } else {
      fs10.writeFileSync(tmp, data, { flag: "wx", ...opts.mode === void 0 ? {} : { mode: opts.mode } });
    }
    if (opts.mode !== void 0) fs10.chmodSync(tmp, opts.mode);
    renameOver(tmp, file);
  } catch (e) {
    try {
      fs10.rmSync(tmp, { force: true });
    } catch {
    }
    throw e;
  }
  if (opts.sync) syncDir(dir);
}

// bridge/src/json-file.ts
var indentOf = (text) => /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
function formatJsonLike(value, raw) {
  if (raw === null) return JSON.stringify(value, null, 2) + "\n";
  const bom = raw.charCodeAt(0) === 65279 ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return bom + JSON.stringify(value, null, indentOf(text)).split("\n").join(eol) + (/\n$/.test(text) ? eol : "");
}
var UPDATE_TRIES = 3;
var readIfThere = (file) => {
  try {
    return fs11.readFileSync(file, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
};
function updateJsonLike(file, fn, opts = {}) {
  const { lockFile = lockFileOf(file), afterWrite, lockRefused, ...lockOpts } = opts;
  let lock;
  try {
    lock = acquireFileLock(lockFile, lockOpts);
  } catch (e) {
    throw lockRefused ? lockRefused(e) : e;
  }
  try {
    for (let tries = 1; ; tries++) {
      const raw = readIfThere(file);
      const out = formatJsonLike(fn(raw), raw);
      if (out === raw) return false;
      if (readIfThere(file) === raw) {
        lock.assertMine();
        writeFileAtomic(file, out);
        afterWrite?.();
        return true;
      }
      if (tries >= UPDATE_TRIES) throw new Error(`${file} kept changing while it was being updated (${UPDATE_TRIES} tries) \u2014 retry once its other writer is done`);
    }
  } finally {
    lock.release();
  }
}

// design-to-code/plan-record.ts
var updatePlan = (file, fn, opts = {}) => updateJsonLike(file, fn, { lockFile: planLockFile(file), lockRefused: (e) => planLockRefused(file, e), ...opts });
function parsePlanText(raw, file) {
  const parsed = JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw);
  const pp = parsePlan(parsed);
  if (!("plan" in pp)) throw new Error(`${file} ${pp.error}`);
  return pp.plan;
}

// design-to-code/plan-skeleton.ts
var USAGE = [
  `usage: ${scriptCmd("plan-skeleton")} <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>] [--seed-from <plan.json>]...`,
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty \u2014 fill it on sections and instances",
  "    anchorsSuggested[]  the few anchors worth filling first (the screen frame, root sections, outermost instances, repeated lists)",
  "    hidden[]      roots of hidden subtrees (hidden: true or a hidden ancestor) \u2014 never built, never anchored",
  "    screenName / nodeId / file / route   the header every skill resolves a plan by",
  "",
  "  You fill in: codeToken, mapModule, verdict, decision, route, deviations[] (and files[], architecture,",
  "  verification as you build).",
  "",
  "  <design-system dir>  design/export/design-system (tokens.json, components.local.json), or a library",
  "                       export's design/export/libraries/<dir> (its catalog is components.json). A missing",
  "                       directory is allowed (single-screen pull): values then come from the screen's",
  "                       own .vars.json and no catalog match is attempted \u2014 stderr says so.",
  "  --out <file>         write the plan there (default: stdout). An existing plan is MERGED, never",
  "                       overwritten: every field you filled is kept. A new plan is named by its node,",
  "                       design/plan/<Layer>__<id>.json (the stem its verify set already has, if any);",
  "                       another name, or a second plan of a node that already has one, is refused (exit 2).",
  "  --map <file>         codeconnect.local.json (default: design/codeconnect.local.json or",
  "                       codeconnect.local.json in the current directory, when present).",
  "  --route <route>      the app route this screen will live at (else left null for you to fill).",
  "  --seed-from <plan>   a sibling screen's plan (repeatable; the first that has an answer wins). A row still",
  "                       empty here takes that plan's answer when it is the SAME thing: a token with the same",
  "                       key (or, both keyless, the same Figma name) AND the same value \u2192 codeToken/verdict/",
  "                       decision; a component with the same setKey (else key) \u2192 mapModule/verdict/decision.",
  "                       Nothing filled is ever overwritten. Seeded rows carry `seededFrom` \u2014 review them."
].join("\n");
function walkNodes(doc, visit) {
  for (const r of screenRoots(doc)) {
    walkWithHidden(r, (n, c) => {
      const above = c.ancestors.findLast((a) => a.node.type === "INSTANCE");
      visit(n, { parent: c.parent, hidden: c.hidden, hiddenRoot: c.hidden && !c.parentHidden, insideInstance: above ? above.node.id || null : null });
    });
  }
}
function visibility(doc) {
  const visible = /* @__PURE__ */ new Map(), hidden = /* @__PURE__ */ new Set(), hiddenRoots = [];
  const count = /* @__PURE__ */ new Map();
  walkNodes(doc, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) {
        const root = { id: n.id, name: n.name, type: n.type, nodes: 0 };
        hiddenRoots.push(root);
        count.set(n.id, root);
      }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  const tally = (n, root) => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    const entry = r ? count.get(r) : void 0;
    if (entry) entry.nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of screenRoots(doc)) tally(r, null);
  return { visible, hidden, hiddenRoots };
}
function bindingsOf(node) {
  const out = [];
  const collect = (o, where) => {
    if (Array.isArray(o)) {
      for (const x of o) collect(x, where);
      return;
    }
    if (!isJsonObject(o)) return;
    if (o.tokens && typeof o.tokens === "object") {
      for (const [field, v] of Object.entries(o.tokens)) for (const name of Array.isArray(v) ? v : [v]) if (typeof name === "string") out.push({ name, field: where ? `${where}.${field}` : field });
    }
    for (const [k, v] of Object.entries(o)) if (k !== "tokens" && k !== "children" && v && typeof v === "object") collect(v, where || k);
  };
  collect(Object.assign({}, node, { children: void 0 }), "");
  return out;
}
function kindOf(variable, fields) {
  const t = variable && variable.type;
  if (t === "COLOR") return "color";
  if (t === "STRING") return /fontStyle|fontFamily|fontName/.test(fields.join(" ")) ? "fontStyle" : "string";
  if (t === "BOOLEAN") return "boolean";
  const f = fields.join(" ");
  if (/Radius/i.test(f)) return "radius";
  if (/fontSize/.test(f)) return "fontSize";
  if (/fontWeight/.test(f)) return "fontWeight";
  if (/lineHeight/.test(f)) return "lineHeight";
  if (/letterSpacing/.test(f)) return "letterSpacing";
  if (/padding|itemSpacing|counterAxisSpacing|gap/i.test(f)) return "spacing";
  if (/strokeWeight|strokeTopWeight|strokeWidth/i.test(f)) return "borderWidth";
  if (/width|height/i.test(f)) return "size";
  if (/opacity/i.test(f)) return "opacity";
  return "number";
}
function resolver(sources, resolvedModes) {
  const byName = /* @__PURE__ */ new Map();
  const collections = /* @__PURE__ */ new Map();
  for (const src of sources) {
    for (const v of src && src.variables || []) if (v && v.name && !byName.has(v.name)) byName.set(v.name, v);
    for (const c of src && src.collections || []) if (c && c.name && !collections.has(c.name)) collections.set(c.name, c);
  }
  const modeFor = (v) => {
    const vals = v.values || {};
    const keys = Object.keys(vals);
    const want = v.collection === void 0 ? void 0 : resolvedModes[v.collection];
    if (want !== void 0 && want in vals) return want;
    if (want !== void 0) {
      const k = keys.find((x) => x.toLowerCase() === String(want).toLowerCase());
      if (k) return k;
    }
    const c = v.collection === void 0 ? void 0 : collections.get(v.collection);
    if (c && c.default && c.default in vals) return c.default;
    return keys[0];
  };
  function resolve(v, depth) {
    if (!v || depth > 10) return { value: null, mode: null };
    const mode = modeFor(v);
    const raw = mode === void 0 ? void 0 : (v.values || {})[mode];
    if (isAlias(raw)) {
      const target = byName.get(raw.aliasOf);
      const r = resolve(target, depth + 1);
      return { value: r.value, mode, via: raw.aliasOf };
    }
    if (raw && typeof raw === "object" && "composed" in raw) {
      const { color, opacity } = raw.composed;
      const c = typeof color === "string" ? color : resolve(byName.get(color.aliasOf), depth + 1).value;
      const o = typeof opacity === "number" ? opacity : resolve(byName.get(opacity.aliasOf), depth + 1).value;
      return { value: composedHex(c, o), mode };
    }
    return { value: normValue(v.type, raw), mode };
  }
  return (v) => resolve(v, 0);
}
function composedHex(color, opacity) {
  const c = parseHex(color);
  if (!c || typeof opacity !== "number" || !Number.isFinite(opacity)) return null;
  return formatHex({ ...c, a: composeAlpha(c.a, opacity) });
}
var isLegacyRgba = (v) => "r" in v;
function normValue(type, raw) {
  if (raw === void 0 || raw === null) return null;
  if (type === "COLOR" && typeof raw === "string") {
    const c = parseHex(raw);
    return c ? formatHex(c) : raw.trim().toLowerCase();
  }
  if (type === "COLOR" && typeof raw === "object" && isLegacyRgba(raw)) {
    const a = raw.a === void 0 ? 1 : Number(raw.a);
    return formatHex({ r: raw.r * 255, g: raw.g * 255, b: raw.b * 255, a: Number.isNaN(a) ? 1 : a });
  }
  return raw;
}
function buildTokens(doc, vars, ds, resolvedModes) {
  const uses = /* @__PURE__ */ new Map();
  walkNodes(doc, (n, ctx) => {
    for (const b of bindingsOf(n)) {
      const u = getOrInit(uses, b.name, () => ({ fields: /* @__PURE__ */ new Set(), visible: 0, hidden: 0 }));
      u.fields.add(b.field);
      if (ctx.hidden) u.hidden++;
      else u.visible++;
    }
  });
  const own = /* @__PURE__ */ new Map();
  for (const v of vars && vars.variables || []) getOrInit(own, v.name, () => []).push(v);
  const dsByKey = /* @__PURE__ */ new Map(), dsByName = /* @__PURE__ */ new Map();
  for (const v of ds && ds.variables || []) {
    if (v.key) dsByKey.set(v.key, v);
    getOrInit(dsByName, v.name, () => []).push(v);
  }
  const ownResolve = resolver([vars, ds], resolvedModes);
  const dsResolve = resolver([ds], resolvedModes);
  const rows = [];
  for (const [name, u] of uses) {
    const fields = [...u.fields].sort();
    const cands = own.get(name) || [];
    const v = cands[0] || null;
    const r = v ? ownResolve(v) : { value: null, mode: null };
    const row = {
      figmaName: name,
      key: cands.length === 1 && v ? v.key || null : null,
      // v is cands[0] here
      collection: (v && v.collection) ?? null,
      // null: no variable, or the export could not name its collection
      kind: kindOf(v, fields),
      value: r.value,
      ...ifDefined("mode", r.mode),
      bindings: fields,
      sites: { visible: u.visible, hidden: u.hidden }
    };
    if (r.via) row.aliasOf = r.via;
    if (cands.length > 1) {
      const vals = cands.map((c) => ({ ...ifDefined("key", c.key), ...ifDefined("collection", c.collection), value: ownResolve(c).value }));
      row.keyCandidates = vals;
      row.note = `${cands.length} variables in this screen's .vars.json are named '${name}'` + (new Set(vals.map((x) => JSON.stringify(x.value))).size > 1 ? " WITH DIFFERENT VALUES \u2014 decide which one the design means before mapping it" : " (same value) \u2014 either key describes it");
    }
    if (!v) row.note = `'${name}' is bound on the frame but not defined in the screen's .vars.json \u2014 re-pull the screen`;
    let dv = null, how = null;
    for (const c of cands) {
      const hit = c.key ? dsByKey.get(c.key) : void 0;
      if (hit) {
        dv = hit;
        how = "key";
        break;
      }
    }
    const named = dv ? void 0 : dsByName.get(name);
    if (named) {
      const same = named.filter((x) => !v || x.collection === v.collection);
      dv = (same.length ? same : named)[0] ?? null;
      how = "name";
    }
    if (dv && how) {
      const dr = dsResolve(dv);
      row.designSystem = { match: how, key: dv.key || null, value: dr.value, agrees: JSON.stringify(dr.value) === JSON.stringify(r.value) };
    } else row.designSystem = null;
    row.codeToken = null;
    if (!u.visible) {
      row.verdict = "hidden-only";
      row.decision = "bound only by hidden layers \u2014 not built, so no code token is needed";
    } else row.verdict = null;
    rows.push({ ...row, codeToken: row.codeToken ?? null, verdict: row.verdict ?? null });
  }
  rows.sort((a, b) => Number(b.sites.visible > 0) - Number(a.sites.visible > 0) || a.figmaName.localeCompare(b.figmaName));
  return rows;
}
function mapKeysOf(map) {
  const keys = /* @__PURE__ */ new Map();
  for (const [name, e] of Object.entries(map.components)) {
    const entry = { name: e.figma.name, module: e.code.module, export: e.code.export, status: e.status || null };
    if (e.figma.key) keys.set(e.figma.key, entry);
    if (!keys.has(name)) keys.set(name, entry);
  }
  return keys;
}
function buildComponents(doc, catalog, library, mapKeys) {
  const insts = [];
  walkNodes(doc, (n, ctx) => {
    if (ctx.hidden || n.type !== "INSTANCE") return;
    const mc = n.mainComponent || {};
    insts.push({
      nodeId: n.id,
      layer: n.name,
      name: mc.setName || mc.name || n.name,
      key: mc.key || null,
      setKey: mc.setKey || null,
      remote: mc.remote === true,
      variant: parseVariant(n.component) || parseVariant(mc.variant),
      props: n.props && typeof n.props === "object" ? n.props : {},
      insideInstance: ctx.insideInstance || null
    });
  });
  const catKeys = /* @__PURE__ */ new Map();
  for (const c of catalog && catalog.components || []) if (c.key) catKeys.set(c.key, c);
  const byName = /* @__PURE__ */ new Map();
  if (catalog) for (const r of matchByNameAndSignature(insts, catalog, library).rows) byName.set(r.name, r);
  return insts.map((i) => {
    let match = null;
    const c = (i.key ? catKeys.get(i.key) : void 0) ?? (i.setKey ? catKeys.get(i.setKey) : void 0);
    const r = byName.get(i.name);
    const verdict = !c && r ? nameVerdict(r).status : null;
    if (c) match = { by: "key", ...ifDefined("id", c.id), ...ifDefined("key", c.key), name: c.name };
    else if (r && r.match && verdict === "matched") {
      match = { by: r.evidence || "name+signature", ...ifDefined("id", r.match.id), ...ifDefined("key", r.match.key), name: r.match.name, confirmed: false };
    } else if (r && verdict === "ambiguous") match = { by: "ambiguous", candidates: r.candidates || [] };
    const mapped = [i.key, i.setKey].map((x) => x && mapKeys.get(x)).find(Boolean) || null;
    const row = {
      nodeId: i.nodeId,
      name: i.name,
      layer: i.layer,
      key: i.key,
      setKey: i.setKey,
      variant: i.variant,
      props: i.props,
      catalog: match,
      mapped: mapped ? { module: mapped.module, export: mapped.export, status: mapped.status } : null,
      mapModule: mapped && mapped.module && !/^TODO/.test(mapped.module) ? mapped.module : "",
      verdict: null
    };
    if (i.insideInstance) row.insideInstance = i.insideInstance;
    return row;
  });
}
var REPEAT_MIN = 3;
function suggestAnchors(doc, vis) {
  const out = [];
  const kids = (n) => (n.children || []).filter((c) => !!c.id && vis.visible.has(c.id));
  const size = (n) => 1 + kids(n).reduce((a, c) => a + size(c), 0);
  const sig = (n) => {
    if (n.type === "INSTANCE") {
      const mc = n.mainComponent;
      return "I:" + (mc && (mc.setKey || mc.key || mc.setName || mc.name) || n.name);
    }
    const k = kids(n);
    return k.length ? n.type + ":" + k.map((c) => c.type).join(",") : null;
  };
  const listRows = (n) => {
    const all = kids(n);
    const seen = /* @__PURE__ */ new Map();
    for (const c of all) {
      const g = sig(c);
      if (g !== null) getOrInit(seen, g, () => []).push(c);
    }
    let best = null, bestSig = null;
    for (const [g, l] of seen) if (l.length >= REPEAT_MIN && (!best || l.length > best.length)) {
      best = l;
      bestSig = g;
    }
    if (!best) return null;
    const names = new Set(best.map((c) => c.type + ":" + c.name));
    const rows = all.filter((c) => {
      const g = sig(c);
      return g !== null && (g === bestSig || names.has(c.type + ":" + c.name));
    });
    const rowSet = new Set(rows);
    const isRow = (c) => c !== void 0 && rowSet.has(c);
    const between = all.filter((c, i) => !rowSet.has(c) && sig(c) !== null && isRow(all[i - 1]) && isRow(all[i + 1]));
    const sepSigs = new Set(between.map(sig));
    const seps = between.length === rows.length - 1 && sepSigs.size === 1 && !all.some((c) => !between.includes(c) && sepSigs.has(sig(c))) ? between : [];
    const shaped = all.filter((c) => sig(c) !== null).length - seps.length;
    return rows.length * 2 > shaped ? /* @__PURE__ */ new Set([...rows, ...seps]) : null;
  };
  const visit = (n, section) => {
    const instance = n.type === "INSTANCE";
    const rows = instance ? null : listRows(n);
    const why = section ? "section" : instance ? "instance" : rows ? "repeat" : null;
    if (why) out.push({ id: n.id, name: n.name, why, covers: size(n) });
    if (instance) return;
    for (const c of kids(n)) if (!rows || !rows.has(c)) visit(c, false);
  };
  for (const r of screenRoots(doc)) {
    if (!r.id || !vis.visible.has(r.id)) continue;
    out.push({ id: r.id, name: r.name, why: "screen", covers: size(r) });
    if (r.type === "INSTANCE") continue;
    for (const c of kids(r)) visit(c, true);
  }
  return out;
}
function skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd, route, indexRow }) {
  const vis = visibility(doc);
  const roots = screenRoots(doc);
  const root = roots[0];
  const exp = screenExportOf(doc);
  const resolvedModes = root && root.resolvedModes || {};
  const tokens = buildTokens(doc, vars, ds, resolvedModes);
  const components = buildComponents(doc, catalog, library, mapKeys || /* @__PURE__ */ new Map());
  const anchors = {};
  for (const [id, v] of vis.visible) anchors[id] = { name: v.node.name, type: v.node.type, parent: v.parentId, mapModule: "" };
  const nodeId = exp && exp.nodeId || root && root.id || null;
  const title = indexRow && indexRow.title;
  const rel = screenFile ? path13.relative(cwd || process.cwd(), path13.resolve(screenFile)).split(path13.sep).join("/") : null;
  const screenName = String(title || exp && exp.screen || root && root.name || "").trim() || null;
  let auditGate = null;
  try {
    const base = cwd || process.cwd();
    const g = auditGateStatus(base, nodeId, screenFile, screenName);
    if (g.auditFile && g.blockers.length) {
      const cross = g.auditFile.replace(/\.json$/, ".cross.json");
      const crossCheckFile = cross !== g.auditFile && fs12.existsSync(path13.join(base, cross)) ? cross : null;
      auditGate = { auditFile: g.auditFile, crossCheckFile, verdict: "blocked", blockers: g.blockers, overridden: [], reason: null, decidedBy: null, decidedAt: null };
    }
  } catch {
  }
  return {
    schema: "designtwin/plan@2",
    screen: screenFile ? path13.basename(screenFile).replace(/\.json$/, "") : null,
    screenName,
    nodeId,
    route: route || null,
    file: rel,
    exportedAt: exp && exp.exportedAt || null,
    status: "pending",
    target: null,
    architecture: null,
    files: [],
    tokens,
    components,
    anchors,
    anchorsSuggested: suggestAnchors(doc, vis),
    hidden: vis.hiddenRoots,
    deviations: [],
    auditGate,
    counts: {
      tokens: tokens.length,
      tokensVisible: tokens.filter((t) => t.sites.visible > 0).length,
      instances: components.length,
      anchors: Object.keys(anchors).length,
      hiddenNodes: vis.hidden.size
    }
  };
}
var FILLED_TOKEN = ["codeToken", "verdict", "decision", "acknowledged", "seededFrom"];
var FILLED_COMPONENT = ["mapModule", "verdict", "decision", "matchedByName", "seededFrom"];
function mergeAuditGate(prev, fresh) {
  if (!prev || typeof prev !== "object") return fresh;
  if (!fresh) return prev;
  return { ...prev, auditFile: fresh.auditFile, crossCheckFile: fresh.crossCheckFile, blockers: fresh.blockers };
}
function merge(fresh, prev) {
  if (!prev || typeof prev !== "object") return { plan: fresh, dropped: { tokens: 0, components: 0, anchors: 0 } };
  const out = Object.assign({}, prev, {
    anchorsSuggested: fresh.anchorsSuggested,
    // skeleton-owned: refreshed, like hidden[]
    schema: fresh.schema,
    screenName: prev.screenName || fresh.screenName,
    nodeId: fresh.nodeId,
    route: prev.route || fresh.route,
    file: fresh.file,
    exportedAt: fresh.exportedAt,
    hidden: fresh.hidden,
    auditGate: mergeAuditGate(prev.auditGate, fresh.auditGate),
    counts: fresh.counts
  });
  const dropped = { tokens: 0, components: 0, anchors: 0 };
  const tk = (t) => t.key || t.figmaName || "";
  const prevTok = new Map((prev.tokens || []).map((t) => [tk(t), t]));
  out.tokens = fresh.tokens.map((t) => {
    const p = prevTok.get(tk(t)) || prevTok.get(t.figmaName);
    const row = Object.assign({}, t);
    if (p) {
      for (const f of FILLED_TOKEN) if (p[f] !== void 0 && p[f] !== null && p[f] !== "") Object.assign(row, { [f]: p[f] });
    }
    return row;
  });
  dropped.tokens = [...prevTok.keys()].filter((k) => !fresh.tokens.some((t) => tk(t) === k || t.figmaName === k)).length;
  const prevComp = new Map((prev.components || []).filter((c) => !!(c && c.nodeId)).map((c) => [c.nodeId, c]));
  out.components = fresh.components.map((c) => {
    const p = c.nodeId ? prevComp.get(c.nodeId) : void 0;
    const row = Object.assign({}, c);
    if (p) {
      for (const f of FILLED_COMPONENT) if (p[f] !== void 0 && p[f] !== null && p[f] !== "") Object.assign(row, { [f]: p[f] });
    }
    return row;
  });
  dropped.components = [...prevComp.keys()].filter((id) => !fresh.components.some((c) => c.nodeId === id)).length;
  const pa = prev.anchors || {};
  out.anchors = {};
  for (const [id, a] of Object.entries(fresh.anchors)) {
    const p = pa[id];
    out.anchors[id] = Object.assign({}, a, p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k, v]) => !["name", "type", "parent"].includes(k) && v !== "" && v != null)) : {});
  }
  dropped.anchors = Object.keys(pa).filter((id) => !(id in fresh.anchors)).length;
  return { plan: out, dropped };
}
var isEmpty = (v) => v === void 0 || v === null || v === "";
var SEED_TOKEN = ["codeToken", "verdict", "decision"];
var SEED_COMPONENT = ["mapModule", "verdict", "decision"];
function seed(plan, from, label) {
  const n = { tokens: 0, components: 0 };
  const sameValue = (a, b) => JSON.stringify(a.value ?? null) === JSON.stringify(b.value ?? null);
  const sameToken = (a, b) => (a.key ? a.key === b.key : !b.key && !!a.figmaName && a.figmaName === b.figmaName) && sameValue(a, b);
  const answered = (r, fields) => fields.some((f) => !isEmpty(r[f]));
  for (const row of plan.tokens || []) {
    if (row.seededFrom || row.verdict === "hidden-only" || !SEED_TOKEN.some((f) => isEmpty(row[f]))) continue;
    const src = (from.tokens || []).find((t) => t.verdict !== "hidden-only" && sameToken(row, t) && answered(t, SEED_TOKEN));
    if (!src) continue;
    let took = false;
    for (const f of SEED_TOKEN) if (isEmpty(row[f]) && !isEmpty(src[f])) {
      Object.assign(row, { [f]: src[f] });
      took = true;
    }
    if (took) {
      row.seededFrom = label;
      n.tokens++;
    }
  }
  const sameComponent = (a, b) => a.setKey ? a.setKey === b.setKey : !!a.key && a.key === b.key;
  for (const row of plan.components || []) {
    if (row.seededFrom || !SEED_COMPONENT.some((f) => isEmpty(row[f]))) continue;
    const src = (from.components || []).find((c) => sameComponent(row, c) && answered(c, SEED_COMPONENT));
    if (!src) continue;
    let took = false;
    for (const f of SEED_COMPONENT) if (isEmpty(row[f]) && !isEmpty(src[f])) {
      Object.assign(row, { [f]: src[f] });
      took = true;
    }
    if (took) {
      row.seededFrom = label;
      n.components++;
    }
  }
  return n;
}
function findIndexRow(screenFile, nodeId) {
  const root = pagesRootOfScreen(screenFile);
  return root === null ? null : readExportIndex(root).rows.find((r) => r.id === nodeId) ?? null;
}
function newPlanProblem(out, nodeId, layerName) {
  if (!nodeId) return "the screen export names no node id, and a new plan is named by its node \u2014 re-pull the screen";
  const c = nodeArtefacts(process.cwd(), { planDir: path13.dirname(out) }).claim("plan", nodeId, { layerName, target: out });
  if (c.ok) return null;
  return c.reason === "held" ? `${c.why}: pass --out ${c.holders[0] ?? ""} to merge into it` : c.why;
}
var cannotRead = (what, file, error) => {
  console.error(`plan-skeleton: cannot read ${what} ${file}: ${error}`);
  return 1;
};
function main(argv) {
  const OPTIONS = { out: { type: "string" }, map: { type: "string" }, route: { type: "string" }, "seed-from": { type: "string", multiple: true }, help: { type: "boolean", short: "h" } };
  const { values: flags, positionals } = cliParse("plan-skeleton", argv, OPTIONS, USAGE, 2, (args) => parseArgs2({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const { out, map: mapFlag, route } = flags;
  const seedFiles = flags["seed-from"] || [];
  const [screenFile, varsFile, dsDir] = positionals;
  if (positionals.length !== 3 || screenFile === void 0 || varsFile === void 0 || dsDir === void 0 || [out, mapFlag, route, ...seedFiles].some((v) => v === "")) {
    console.error(USAGE);
    return 2;
  }
  const screen = readJson(screenFile, isScreenDoc);
  if (!("doc" in screen)) return cannotRead("the screen JSON", screenFile, screen.error);
  const varsRead = readJson(varsFile, isTokensDoc);
  if (!("doc" in varsRead)) return cannotRead("the screen's variables", varsFile, varsRead.error);
  const doc = screen.doc, vars = varsRead.doc;
  const hasDs = dsDir && fs12.existsSync(dsDir) && fs12.statSync(dsDir).isDirectory();
  if (!hasDs) console.error(`plan-skeleton: no design-system directory at ${dsDir} \u2014 token values come from the screen's own .vars.json, and no catalog match was attempted (components[].catalog is null)`);
  const optional = (file, guard) => {
    if (!hasDs) return { doc: null };
    const r = readJson(file, guard);
    return "doc" in r ? r : r.missing ? { doc: null } : { error: r.error };
  };
  const dsFiles = designSystemFiles(dsDir);
  const dsRead = optional(dsFiles.tokens, isTokensDoc), catRead = optional(dsFiles.components, isComponentsCatalog), libRead = optional(dsFiles.componentsLibrary, isComponentsCatalog);
  if ("error" in dsRead) return cannotRead("the design system's tokens", dsFiles.tokens, dsRead.error);
  if ("error" in catRead) return cannotRead("the component catalog", dsFiles.components, catRead.error);
  if ("error" in libRead) return cannotRead("the library component catalog", dsFiles.componentsLibrary, libRead.error);
  const mapAt = findMapFile(process.cwd());
  const mapFile = mapFlag || (mapAt.missing ? void 0 : mapAt.rel);
  let mapKeys = /* @__PURE__ */ new Map();
  if (mapFile) {
    const m = readJson(mapFile, isCodeConnectMap);
    if (!("doc" in m)) return cannotRead("the component map", mapFile, m.error);
    mapKeys = mapKeysOf(m.doc);
  }
  const seeds = [];
  for (const f of seedFiles) {
    const r = readJson(f, anyJson);
    const parsed = "doc" in r ? parsePlan(r.doc) : null;
    if (!parsed || "error" in parsed) return cannotRead("the --seed-from plan", f, !("doc" in r) ? r.error : parsed && "error" in parsed ? parsed.error : "is not a plan");
    seeds.push({ file: f, plan: parsed.plan });
  }
  const seedAll = (plan) => seeds.map((sd) => {
    const n = seed(plan, sd.plan, path13.basename(sd.file));
    return `plan-skeleton: seeded ${n.tokens} token row(s), ${n.components} component row(s) from ${sd.file}` + (n.tokens || n.components ? " \u2014 review them (seededFrom)" : "");
  });
  const exp = screenExportOf(doc), root = screenRoots(doc)[0];
  const nodeId = exp?.nodeId || root?.id;
  const indexRow = findIndexRow(screenFile, nodeId);
  const fresh = skeleton({ doc, vars, ds: dsRead.doc, catalog: catRead.doc, library: libRead.doc, mapKeys, screenFile, cwd: process.cwd(), ...ifDefined("route", route), indexRow });
  const c = fresh.counts;
  if (out && !fs12.existsSync(out)) {
    const why = newPlanProblem(out, nodeId, indexRow?.name ?? exp?.screen ?? root?.name ?? "");
    if (why) {
      console.error(`plan-skeleton: ${why} \u2014 nothing written`);
      return 2;
    }
  }
  if (!out) {
    for (const l of seedAll(fresh)) console.error(l);
    process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
  } else {
    const prevRead = readJson(out, anyJson);
    const parsed = "doc" in prevRead ? parsePlan(prevRead.doc) : null;
    const why = !("doc" in prevRead) ? prevRead.missing ? null : prevRead.error : parsed && "error" in parsed ? parsed.error : null;
    if (why) {
      console.error(`plan-skeleton: ${out} exists but ${why} \u2014 refusing to overwrite it`);
      return 1;
    }
    let done = { prev: null, dropped: { tokens: 0, components: 0, anchors: 0 }, seeded: [] };
    try {
      const changed = updatePlan(out, (raw) => {
        const prev2 = raw === null ? null : parsePlanText(raw, out);
        const { plan, dropped: dropped2 } = merge(structuredClone(fresh), prev2);
        done = { prev: prev2, dropped: dropped2, seeded: seedAll(plan) };
        return plan;
      });
      if (!changed) {
        const now = /* @__PURE__ */ new Date();
        fs12.utimesSync(out, now, now);
      }
    } catch (e) {
      console.error(`plan-skeleton: ${out}: ${errMsg(e)} \u2014 not written`);
      return 1;
    }
    for (const l of done.seeded) console.error(l);
    const { prev, dropped } = done;
    console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
  }
  console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded, ${fresh.anchorsSuggested.length} suggested anchor root(s) (anchorsSuggested)`);
  return 0;
}
if (import.meta.main) runCli(main, { name: "plan-skeleton" });
export {
  USAGE,
  bindingsOf,
  buildComponents,
  buildTokens,
  main,
  merge,
  seed,
  skeleton,
  visibility,
  walkNodes
};
