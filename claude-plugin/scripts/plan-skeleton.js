// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/component-match.js
var require_component_match = __commonJS({
  "design-to-code/component-match.js"(exports2, module2) {
    function visibleInstances(doc, label) {
      const out = [];
      const roots = !doc ? [] : Array.isArray(doc.nodes) ? doc.nodes : doc.tree ? [doc.tree] : doc.id || doc.type ? [doc] : [];
      const walk = (n) => {
        if (!n || typeof n !== "object" || n.hidden === true || n.visible === false) return;
        if (n.type === "INSTANCE" && n.mainComponent) {
          const mc = n.mainComponent;
          out.push({
            screen: label,
            nodeId: n.id,
            layer: n.name,
            name: mc.setName || mc.name || n.name,
            key: mc.key,
            setKey: mc.setKey,
            remote: mc.remote === true,
            variant: parseVariant2(n.component) || parseVariant2(mc.variant),
            props: n.props && typeof n.props === "object" ? n.props : {}
          });
        }
        for (const c of n.children || []) walk(c);
      };
      for (const r of roots) walk(r);
      return out;
    }
    function parseVariant2(s) {
      if (s && typeof s === "object" && !Array.isArray(s)) return Object.keys(s).length ? Object.assign({}, s) : null;
      if (!s || typeof s !== "string" || !s.includes("=")) return null;
      const out = {};
      for (const part of s.split(/,\s*(?=[^,=]+=)/)) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return Object.keys(out).length ? out : null;
    }
    var baseProp = (p) => String(p).split("#")[0];
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
        const bad = known.filter((k) => !(props[k].options || []).includes(variant[k]));
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
    function matchByNameAndSignature2(instances, catalog, library) {
      const comps = catalog && catalog.components || [];
      const byName = /* @__PURE__ */ new Map();
      comps.forEach((c, i) => {
        if (!byName.has(c.name)) byName.set(c.name, []);
        byName.get(c.name).push(Object.assign({ _order: i }, c));
      });
      const catKeys = new Set(comps.map((c) => c.key).filter(Boolean));
      const libKeys = new Set((library && library.components || []).map((c) => c.key).filter(Boolean));
      const libNames = new Set((library && library.components || []).map((c) => c.name));
      const groups = /* @__PURE__ */ new Map();
      for (const inst of instances) {
        if (!groups.has(inst.name)) groups.set(inst.name, []);
        groups.get(inst.name).push(inst);
      }
      const rows = [];
      for (const [name, list] of groups) {
        const byKey = list.some((i) => catKeys.has(i.key) || catKeys.has(i.setKey));
        const row = {
          name,
          instances: list.length,
          nodeIds: list.map((i) => i.nodeId),
          screens: [...new Set(list.map((i) => i.screen).filter(Boolean))],
          instanceKeys: [...new Set(list.map((i) => i.setKey || i.key).filter(Boolean))],
          remote: list.every((i) => i.remote),
          byKey,
          match: null,
          alternatives: [],
          reasons: []
        };
        const cands = byName.get(name) || [];
        if (!cands.length) {
          const inLibrary = list.some((i) => libKeys.has(i.key) || libKeys.has(i.setKey));
          row.reasons.push(`no catalog entry named ${JSON.stringify(name)}`);
          row.reasons.push(inLibrary ? "its key IS in components.library.json \u2014 a third-party library both files consume, not the design system's own component" : libNames.has(name) ? "the name appears in components.library.json \u2014 a third-party library the design system consumes, not one of its own components" : "not a component of the exported design system (typically an external icon library) \u2014 expected, not a miss");
          rows.push(row);
          continue;
        }
        const scored = cands.map((c) => {
          const per = list.map((i) => signature(i, c));
          return { c, verified: per.every((p) => p.verified), score: Math.min(...per.map((p) => p.score)), reasons: per[0].reasons, failing: per.find((p) => !p.verified) };
        }).sort((a, b) => b.verified - a.verified || b.score - a.score || a.c._order - b.c._order);
        const best = scored[0];
        if (!best.verified) {
          row.reasons.push(`${cands.length} catalog entr${cands.length === 1 ? "y is" : "ies are"} named ${JSON.stringify(name)}, but no prop signature agrees: ` + (best.failing ? best.failing.reasons.filter((r) => /NOT|not in|none of|\d+\/\d+|sets no variant/.test(r)).join("; ") : "signature mismatch") + " \u2014 a name alone is not a match");
          rows.push(row);
          continue;
        }
        const verifiedOnes = scored.filter((s) => s.verified);
        const ties = verifiedOnes.filter((s) => s.score === best.score && s !== best);
        row.match = { id: best.c.id, key: best.c.key, name: best.c.name, type: best.c.type, page: best.c.page };
        row.evidence = list.some((i) => i.variant || Object.keys(i.props || {}).length) ? "name+signature" : "name+no-props";
        row.reasons = best.reasons.slice();
        if (ties.length) {
          const identical = ties.every((t) => sigOf(t.c) === sigOf(best.c));
          row.reasons.push(identical ? `${ties.length + 1} catalog entries named "${name}" score identically \u2014 they are duplicates of one definition (same props, same variants); the first in the catalog is used` : `${ties.length + 1} catalog entries named "${name}" score identically with DIFFERENT signatures \u2014 the first in the catalog is used; confirm which one`);
          row.tie = identical ? "duplicate-definitions" : "different-signatures";
        } else if (scored.length > 1) {
          row.reasons.push(`beat ${scored.length - 1} same-named candidate(s)${verifiedOnes.length > 1 ? ` by ${best.score - verifiedOnes[1].score} pts` : " (their prop signatures do not agree)"}`);
        }
        row.alternatives = verifiedOnes.filter((s) => s !== best).map((s) => ({ id: s.c.id, key: s.c.key, page: s.c.page, score: s.score }));
        row.reasons.push("key lookup: " + (byKey ? "matched" : "NO MATCH (the instance's key is not in the catalog \u2014 re-keyed)"));
        rows.push(row);
      }
      const proposals = rows.filter((r) => r.match && !r.byKey);
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
    var REKEY_MIN_PROPOSALS = 3;
    var REKEY_MIN_SHARE = 0.5;
    function isRekeyed(result) {
      const s = result.summary;
      return s.names > 0 && s.byKey / s.names <= 0.05 && s.proposedWithSignature >= REKEY_MIN_PROPOSALS && s.withCandidates > 0 && s.proposedWithSignature / s.withCandidates >= REKEY_MIN_SHARE;
    }
    module2.exports = { visibleInstances, parseVariant: parseVariant2, matchByNameAndSignature: matchByNameAndSignature2, isRekeyed, REKEY_MIN_PROPOSALS, REKEY_MIN_SHARE };
  }
});

// design-to-code/plan-skeleton.js
var fs = require("fs");
var path = require("path");
var { matchByNameAndSignature, parseVariant } = require_component_match();
var USAGE = [
  "usage: node plan-skeleton.js <screen.json> <screen.vars.json> <design-system dir> [--out <plan.json>] [--map <codeconnect.local.json>] [--route <route>]",
  "",
  "  Emits the build-screen plan skeleton for one screen, derived from the export:",
  "    tokens[]      every bound variable (keyed by Figma key, value in the frame's mode, design-system match)",
  "    components[]  every VISIBLE instance (key/setKey/name/props + catalog match / codeconnect mapping)",
  "    anchors{}     every VISIBLE node id, mapModule empty \u2014 fill it on sections and instances",
  "    hidden[]      roots of hidden subtrees (hidden: true or a hidden ancestor) \u2014 never built, never anchored",
  "    screenName / nodeId / file / route   the header every skill resolves a plan by",
  "",
  "  You fill in: codeToken, mapModule, verdict, decision, route, deviations[] (and files[], architecture,",
  "  verification as you build).",
  "",
  "  <design-system dir>  design/export/design-system (tokens.json, components.local.json). A missing",
  "                       directory is allowed (single-screen pull): values then come from the screen's",
  "                       own .vars.json and no catalog match is attempted \u2014 stderr says so.",
  "  --out <file>         write the plan there (default: stdout). An existing plan is MERGED, never",
  "                       overwritten: every field you filled is kept.",
  "  --map <file>         codeconnect.local.json (default: design/codeconnect.local.json or",
  "                       codeconnect.local.json in the current directory, when present).",
  "  --route <route>      the app route this screen will live at (else left null for you to fill)."
].join("\n");
var readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
var readJsonOr = (f, fallback) => {
  try {
    return readJson(f);
  } catch {
    return fallback;
  }
};
function rootsOf(doc) {
  if (!doc) return [];
  if (Array.isArray(doc.nodes)) return doc.nodes;
  if (doc.tree) return [doc.tree];
  if (doc.id || doc.type) return [doc];
  return [];
}
function walkNodes(doc, visit) {
  const go = (n, parent, hiddenAbove, insideInstance) => {
    if (!n || typeof n !== "object") return;
    const hidden = hiddenAbove || n.hidden === true;
    visit(n, { parent, hidden, hiddenRoot: n.hidden === true && !hiddenAbove, insideInstance });
    const inInst = n.type === "INSTANCE" ? n.id : insideInstance;
    for (const c of n.children || []) go(c, n, hidden, inInst);
  };
  for (const r of rootsOf(doc)) go(r, null, false, null);
}
function visibility(doc) {
  const visible = /* @__PURE__ */ new Map(), hidden = /* @__PURE__ */ new Set(), hiddenRoots = [];
  const count = /* @__PURE__ */ new Map();
  walkNodes(doc, (n, ctx) => {
    if (!n.id) return;
    if (ctx.hidden) {
      hidden.add(n.id);
      if (ctx.hiddenRoot) {
        hiddenRoots.push({ id: n.id, name: n.name, type: n.type, nodes: 0 });
        count.set(n.id, hiddenRoots[hiddenRoots.length - 1]);
      }
    } else visible.set(n.id, { node: n, parentId: ctx.parent ? ctx.parent.id : null, insideInstance: ctx.insideInstance });
  });
  const tally = (n, root) => {
    if (!n || typeof n !== "object") return;
    const r = root || (count.has(n.id) ? n.id : null);
    if (r) count.get(r).nodes++;
    for (const c of n.children || []) tally(c, r);
  };
  for (const r of rootsOf(doc)) tally(r, null);
  return { visible, hidden, hiddenRoots };
}
function bindingsOf(node) {
  const out = [];
  const collect = (o, where) => {
    if (Array.isArray(o)) {
      for (const x of o) collect(x, where);
      return;
    }
    if (!o || typeof o !== "object") return;
    if (o.tokens && typeof o.tokens === "object") {
      for (const [field, v] of Object.entries(o.tokens)) for (const name of [].concat(v)) if (typeof name === "string") out.push({ name, field: where ? `${where}.${field}` : field });
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
var isAlias = (v) => v && typeof v === "object" && typeof v.aliasOf === "string";
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
    const want = resolvedModes && resolvedModes[v.collection];
    if (want !== void 0 && want in vals) return want;
    if (want !== void 0) {
      const k = keys.find((x) => x.toLowerCase() === String(want).toLowerCase());
      if (k) return k;
    }
    const c = collections.get(v.collection);
    if (c && c.default && c.default in vals) return c.default;
    return keys[0];
  };
  function resolve(v, depth) {
    if (!v || depth > 10) return { value: null, mode: null };
    const mode = modeFor(v);
    const raw = (v.values || {})[mode];
    if (isAlias(raw)) {
      const target = byName.get(raw.aliasOf);
      const r = resolve(target, depth + 1);
      return { value: r.value, mode, via: raw.aliasOf };
    }
    return { value: normValue(v.type, raw), mode };
  }
  return (v) => resolve(v, 0);
}
function normValue(type, raw) {
  if (raw === void 0 || raw === null) return null;
  if (type === "COLOR" && typeof raw === "string") {
    const h = raw.trim().toLowerCase();
    return /^#[0-9a-f]{8}$/.test(h) && h.endsWith("ff") ? h.slice(0, 7) : h;
  }
  if (type === "COLOR" && typeof raw === "object" && "r" in raw) {
    const to = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
    const a = raw.a === void 0 ? 1 : raw.a;
    return "#" + to(raw.r) + to(raw.g) + to(raw.b) + (a < 1 ? to(a) : "");
  }
  return raw;
}
function buildTokens(doc, vis, vars, ds, resolvedModes) {
  const uses = /* @__PURE__ */ new Map();
  walkNodes(doc, (n, ctx) => {
    for (const b of bindingsOf(n)) {
      if (!uses.has(b.name)) uses.set(b.name, { fields: /* @__PURE__ */ new Set(), visible: 0, hidden: 0 });
      const u = uses.get(b.name);
      u.fields.add(b.field);
      if (ctx.hidden) u.hidden++;
      else u.visible++;
    }
  });
  const own = /* @__PURE__ */ new Map();
  for (const v of vars && vars.variables || []) {
    if (!own.has(v.name)) own.set(v.name, []);
    own.get(v.name).push(v);
  }
  const dsByKey = /* @__PURE__ */ new Map(), dsByName = /* @__PURE__ */ new Map();
  for (const v of ds && ds.variables || []) {
    if (v.key) dsByKey.set(v.key, v);
    if (!dsByName.has(v.name)) dsByName.set(v.name, []);
    dsByName.get(v.name).push(v);
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
      key: cands.length === 1 ? v.key || null : null,
      collection: v ? v.collection : null,
      kind: kindOf(v, fields),
      value: r.value,
      mode: r.mode,
      bindings: fields,
      sites: { visible: u.visible, hidden: u.hidden }
    };
    if (r.via) row.aliasOf = r.via;
    if (cands.length > 1) {
      const vals = cands.map((c) => ({ key: c.key, collection: c.collection, value: ownResolve(c).value }));
      row.keyCandidates = vals;
      row.note = `${cands.length} variables in this screen's .vars.json are named '${name}'` + (new Set(vals.map((x) => JSON.stringify(x.value))).size > 1 ? " WITH DIFFERENT VALUES \u2014 decide which one the design means before mapping it" : " (same value) \u2014 either key describes it");
    }
    if (!v) row.note = `'${name}' is bound on the frame but not defined in the screen's .vars.json \u2014 re-pull the screen`;
    let dv = null, how = null;
    for (const c of cands) if (c.key && dsByKey.has(c.key)) {
      dv = dsByKey.get(c.key);
      how = "key";
      break;
    }
    if (!dv && dsByName.has(name)) {
      const same = dsByName.get(name).filter((x) => !v || x.collection === v.collection);
      dv = (same.length ? same : dsByName.get(name))[0];
      how = "name";
    }
    if (dv) {
      const dr = dsResolve(dv);
      row.designSystem = { match: how, key: dv.key || null, value: dr.value, agrees: JSON.stringify(dr.value) === JSON.stringify(r.value) };
    } else row.designSystem = null;
    row.codeToken = null;
    if (!u.visible) {
      row.verdict = "hidden-only";
      row.decision = "bound only by hidden layers \u2014 not built, so no code token is needed";
    } else row.verdict = null;
    rows.push(row);
  }
  rows.sort((a, b) => (b.sites.visible > 0) - (a.sites.visible > 0) || a.figmaName.localeCompare(b.figmaName));
  return rows;
}
function loadMap(file) {
  const map = readJsonOr(file, null);
  const keys = /* @__PURE__ */ new Map();
  for (const [name, e] of Object.entries(map && map.components || {})) {
    if (!e || !e.figma) continue;
    const entry = { name: e.figma.name || name, module: e.code && e.code.module || null, export: e.code && e.code.export || null, status: e.status || null };
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
    const k = [i.key, i.setKey].find((x) => x && catKeys.has(x));
    if (k) {
      const c = catKeys.get(k);
      match = { by: "key", id: c.id, key: c.key, name: c.name };
    } else if (byName.has(i.name) && byName.get(i.name).match) {
      const r = byName.get(i.name);
      match = { by: r.evidence || "name+signature", id: r.match.id, key: r.match.key, name: r.match.name, confirmed: false };
    }
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
function skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd, route, indexRow }) {
  const vis = visibility(doc);
  const roots = rootsOf(doc);
  const root = roots[0] || {};
  const resolvedModes = root.resolvedModes || {};
  const tokens = buildTokens(doc, vis, vars, ds, resolvedModes);
  const components = buildComponents(doc, catalog, library, mapKeys || /* @__PURE__ */ new Map());
  const anchors = {};
  for (const [id, v] of vis.visible) anchors[id] = { name: v.node.name, type: v.node.type, parent: v.parentId, mapModule: "" };
  const nodeId = doc.nodeId || root.id || null;
  const title = indexRow && indexRow.title;
  const rel = screenFile ? path.relative(cwd || process.cwd(), path.resolve(screenFile)).split(path.sep).join("/") : null;
  return {
    schema: "designtwin/plan@2",
    screen: screenFile ? path.basename(screenFile).replace(/\.json$/, "") : null,
    screenName: String(title || doc.screen || root.name || "").trim() || null,
    nodeId,
    route: route || null,
    file: rel,
    exportedAt: doc.exportedAt || null,
    status: "pending",
    target: null,
    architecture: null,
    files: [],
    tokens,
    components,
    anchors,
    hidden: vis.hiddenRoots,
    deviations: [],
    counts: {
      tokens: tokens.length,
      tokensVisible: tokens.filter((t) => t.sites.visible > 0).length,
      instances: components.length,
      anchors: Object.keys(anchors).length,
      hiddenNodes: vis.hidden.size
    }
  };
}
var FILLED_TOKEN = ["codeToken", "verdict", "decision"];
var FILLED_COMPONENT = ["mapModule", "verdict", "decision", "matchedByName"];
function merge(fresh, prev) {
  if (!prev || typeof prev !== "object") return { plan: fresh, dropped: { tokens: 0, components: 0, anchors: 0 } };
  const out = Object.assign({}, prev, {
    schema: fresh.schema,
    screenName: prev.screenName || fresh.screenName,
    nodeId: fresh.nodeId,
    route: prev.route || fresh.route,
    file: fresh.file,
    exportedAt: fresh.exportedAt,
    hidden: fresh.hidden,
    counts: fresh.counts
  });
  const dropped = { tokens: 0, components: 0, anchors: 0 };
  const tk = (t) => t.key || t.figmaName;
  const prevTok = new Map((Array.isArray(prev.tokens) ? prev.tokens : []).map((t) => [tk(t), t]));
  out.tokens = fresh.tokens.map((t) => {
    const p = prevTok.get(tk(t)) || prevTok.get(t.figmaName);
    const row = Object.assign({}, t);
    if (p) {
      for (const f of FILLED_TOKEN) if (p[f] !== void 0 && p[f] !== null && p[f] !== "") row[f] = p[f];
    }
    return row;
  });
  dropped.tokens = [...prevTok.keys()].filter((k) => !fresh.tokens.some((t) => tk(t) === k || t.figmaName === k)).length;
  const prevComp = new Map((Array.isArray(prev.components) ? prev.components : []).filter((c) => c && c.nodeId).map((c) => [c.nodeId, c]));
  out.components = fresh.components.map((c) => {
    const p = prevComp.get(c.nodeId);
    const row = Object.assign({}, c);
    if (p) {
      for (const f of FILLED_COMPONENT) if (p[f] !== void 0 && p[f] !== null && p[f] !== "") row[f] = p[f];
    }
    return row;
  });
  dropped.components = [...prevComp.keys()].filter((id) => !fresh.components.some((c) => c.nodeId === id)).length;
  const pa = prev.anchors && typeof prev.anchors === "object" ? prev.anchors : {};
  out.anchors = {};
  for (const [id, a] of Object.entries(fresh.anchors)) {
    const p = pa[id];
    out.anchors[id] = Object.assign({}, a, p && typeof p === "object" ? Object.fromEntries(Object.entries(p).filter(([k, v]) => !["name", "type", "parent"].includes(k) && v !== "" && v != null)) : {});
  }
  dropped.anchors = Object.keys(pa).filter((id) => !(id in fresh.anchors)).length;
  return { plan: out, dropped };
}
function findIndexRow(screenFile, nodeId) {
  const dir = path.dirname(path.resolve(screenFile));
  for (const idx of [path.join(dir, "..", "index.json"), path.join(dir, "index.json")]) {
    const d = readJsonOr(idx, null);
    const rows = d && Array.isArray(d.layers) ? d.layers : [];
    const hit = rows.find((r) => r.id === nodeId);
    if (hit) return hit;
  }
  return null;
}
function main(argv) {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return void 0;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const out = take("--out"), mapFlag = take("--map"), route = take("--route");
  const stray = args.filter((a) => a.startsWith("-"));
  if (stray.length || args.length !== 3 || [out, mapFlag, route].some((v) => v === "")) {
    console.error((stray.length ? `plan-skeleton: unknown flag ${stray.join(", ")}
` : "") + USAGE);
    return 2;
  }
  const [screenFile, varsFile, dsDir] = args;
  let doc, vars;
  try {
    doc = readJson(screenFile);
  } catch (e) {
    console.error(`plan-skeleton: cannot read the screen JSON ${screenFile}: ${e.message}`);
    return 1;
  }
  try {
    vars = readJson(varsFile);
  } catch (e) {
    console.error(`plan-skeleton: cannot read the screen's variables ${varsFile}: ${e.message}`);
    return 1;
  }
  const hasDs = dsDir && fs.existsSync(dsDir) && fs.statSync(dsDir).isDirectory();
  if (!hasDs) console.error(`plan-skeleton: no design-system directory at ${dsDir} \u2014 token values come from the screen's own .vars.json, and no catalog match was attempted (components[].catalog is null)`);
  const ds = hasDs ? readJsonOr(path.join(dsDir, "tokens.json"), null) : null;
  const catalog = hasDs ? readJsonOr(path.join(dsDir, "components.local.json"), null) : null;
  const library = hasDs ? readJsonOr(path.join(dsDir, "components.library.json"), null) : null;
  const mapFile = mapFlag || ["design/codeconnect.local.json", "codeconnect.local.json"].find((f) => fs.existsSync(f));
  const mapKeys = mapFile ? loadMap(mapFile) : /* @__PURE__ */ new Map();
  const nodeId = doc.nodeId || (rootsOf(doc)[0] || {}).id;
  const fresh = skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd: process.cwd(), route, indexRow: findIndexRow(screenFile, nodeId) });
  const c = fresh.counts;
  if (!out) {
    process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
  } else {
    const prev = fs.existsSync(out) ? readJsonOr(out, void 0) : null;
    if (prev === void 0) {
      console.error(`plan-skeleton: ${out} exists but is not valid JSON \u2014 refusing to overwrite it`);
      return 1;
    }
    const { plan, dropped } = merge(fresh, prev);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
    console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
  }
  console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded`);
  return 0;
}
module.exports = { skeleton, merge, visibility, walkNodes, rootsOf, bindingsOf, buildTokens, buildComponents, USAGE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
