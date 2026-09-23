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
            variant: parseVariant(n.component) || parseVariant(mc.variant),
            props: n.props && typeof n.props === "object" ? n.props : {}
          });
        }
        for (const c of n.children || []) walk(c);
      };
      for (const r of roots) walk(r);
      return out;
    }
    function parseVariant(s) {
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
    function matchByNameAndSignature(instances, catalog, library) {
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
    module2.exports = { visibleInstances, parseVariant, matchByNameAndSignature, isRekeyed, REKEY_MIN_PROPOSALS, REKEY_MIN_SHARE };
  }
});

// design-to-code/hidden.js
var require_hidden = __commonJS({
  "design-to-code/hidden.js"(exports2, module2) {
    var hiddenSelf = (node) => !!(node && typeof node === "object" && node.hidden);
    var isHidden = (node, ancestorHidden) => !!ancestorHidden || hiddenSelf(node);
    function walkWithHidden(root, fn, opts) {
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
      for (const r of roots || []) walkWithHidden(r, (n, c) => {
        if (c.hidden && n.id) out.push(n.id);
      });
      return out;
    }
    function hiddenRoots(roots) {
      const out = [];
      for (const r of roots || []) walkWithHidden(r, (n, c) => {
        if (c.hidden && !c.parentHidden) out.push(n);
      });
      return out;
    }
    module2.exports = { hiddenSelf, isHidden, walkWithHidden, hiddenIds, hiddenRoots };
  }
});

// design-to-code/plan-skeleton.js
var require_plan_skeleton = __commonJS({
  "design-to-code/plan-skeleton.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { matchByNameAndSignature, parseVariant } = require_component_match();
    var { walkWithHidden } = require_hidden();
    var USAGE2 = [
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
    var readJson = (f) => JSON.parse(fs2.readFileSync(f, "utf8"));
    var readJsonOr2 = (f, fallback) => {
      try {
        return readJson(f);
      } catch {
        return fallback;
      }
    };
    function rootsOf2(doc) {
      if (!doc) return [];
      if (Array.isArray(doc.nodes)) return doc.nodes;
      if (doc.tree) return [doc.tree];
      if (doc.id || doc.type) return [doc];
      return [];
    }
    function walkNodes(doc, visit) {
      const instAbove = /* @__PURE__ */ new Map();
      for (const r of rootsOf2(doc)) {
        walkWithHidden(r, (n, c) => {
          const above = c.parent ? c.parent.type === "INSTANCE" ? c.parent.id : instAbove.get(c.parent) || null : null;
          instAbove.set(n, above);
          visit(n, { parent: c.parent, hidden: c.hidden, hiddenRoot: c.hidden && !c.parentHidden, insideInstance: above });
        });
      }
    }
    function visibility2(doc) {
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
      for (const r of rootsOf2(doc)) tally(r, null);
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
      const map = readJsonOr2(file, null);
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
      const vis = visibility2(doc);
      const roots = rootsOf2(doc);
      const root = roots[0] || {};
      const resolvedModes = root.resolvedModes || {};
      const tokens = buildTokens(doc, vis, vars, ds, resolvedModes);
      const components = buildComponents(doc, catalog, library, mapKeys || /* @__PURE__ */ new Map());
      const anchors = {};
      for (const [id, v] of vis.visible) anchors[id] = { name: v.node.name, type: v.node.type, parent: v.parentId, mapModule: "" };
      const nodeId = doc.nodeId || root.id || null;
      const title = indexRow && indexRow.title;
      const rel = screenFile ? path2.relative(cwd || process.cwd(), path2.resolve(screenFile)).split(path2.sep).join("/") : null;
      return {
        schema: "designtwin/plan@2",
        screen: screenFile ? path2.basename(screenFile).replace(/\.json$/, "") : null,
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
      const dir = path2.dirname(path2.resolve(screenFile));
      for (const idx of [path2.join(dir, "..", "index.json"), path2.join(dir, "index.json")]) {
        const d = readJsonOr2(idx, null);
        const rows = d && Array.isArray(d.layers) ? d.layers : [];
        const hit = rows.find((r) => r.id === nodeId);
        if (hit) return hit;
      }
      return null;
    }
    function main2(argv) {
      const args = argv.slice();
      if (args.includes("--help") || args.includes("-h")) {
        console.log(USAGE2);
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
` : "") + USAGE2);
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
      const hasDs = dsDir && fs2.existsSync(dsDir) && fs2.statSync(dsDir).isDirectory();
      if (!hasDs) console.error(`plan-skeleton: no design-system directory at ${dsDir} \u2014 token values come from the screen's own .vars.json, and no catalog match was attempted (components[].catalog is null)`);
      const ds = hasDs ? readJsonOr2(path2.join(dsDir, "tokens.json"), null) : null;
      const catalog = hasDs ? readJsonOr2(path2.join(dsDir, "components.local.json"), null) : null;
      const library = hasDs ? readJsonOr2(path2.join(dsDir, "components.library.json"), null) : null;
      const mapFile = mapFlag || ["design/codeconnect.local.json", "codeconnect.local.json"].find((f) => fs2.existsSync(f));
      const mapKeys = mapFile ? loadMap(mapFile) : /* @__PURE__ */ new Map();
      const nodeId = doc.nodeId || (rootsOf2(doc)[0] || {}).id;
      const fresh = skeleton({ doc, vars, ds, catalog, library, mapKeys, screenFile, cwd: process.cwd(), route, indexRow: findIndexRow(screenFile, nodeId) });
      const c = fresh.counts;
      if (!out) {
        process.stdout.write(JSON.stringify(fresh, null, 2) + "\n");
      } else {
        const prev = fs2.existsSync(out) ? readJsonOr2(out, void 0) : null;
        if (prev === void 0) {
          console.error(`plan-skeleton: ${out} exists but is not valid JSON \u2014 refusing to overwrite it`);
          return 1;
        }
        const { plan, dropped } = merge(fresh, prev);
        fs2.mkdirSync(path2.dirname(path2.resolve(out)), { recursive: true });
        fs2.writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
        console.error(`plan-skeleton: ${prev ? "merged into" : "wrote"} ${out}` + (prev ? ` (kept every filled field; dropped ${dropped.tokens} token row(s), ${dropped.components} component row(s), ${dropped.anchors} anchor(s) no longer in the export)` : ""));
      }
      console.error(`plan-skeleton: ${c.tokens} bound token(s) (${c.tokensVisible} on visible nodes), ${c.instances} visible instance(s), ${c.anchors} visible node anchor slot(s), ${c.hiddenNodes} hidden node(s) excluded`);
      return 0;
    }
    module2.exports = { skeleton, merge, visibility: visibility2, walkNodes, rootsOf: rootsOf2, bindingsOf, buildTokens, buildComponents, USAGE: USAGE2 };
    if (require.main === module2) process.exitCode = main2(process.argv.slice(2));
  }
});

// design-to-code/verify-build.js
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { visibility, rootsOf } = require_plan_skeleton();
var HOOK_TIMEOUT_MS = () => Number(process.env.DTWIN_HOOK_TIMEOUT_MS) || 6e4;
var STDIN_WAIT_MS = () => {
  const n = Number(process.env.DTWIN_HOOK_STDIN_WAIT_MS);
  return Number.isFinite(n) && n >= 0 && process.env.DTWIN_HOOK_STDIN_WAIT_MS !== "" ? n : 1e3;
};
var phase = "starting";
var setPhase = (p) => {
  phase = p;
};
function readHookInput() {
  if (process.stdin.isTTY) return Promise.resolve({ payload: {}, source: "tty" });
  let st;
  try {
    st = fs.fstatSync(0);
  } catch {
    return Promise.resolve({ payload: {}, source: "closed" });
  }
  const parse = (raw) => {
    try {
      return raw.trim() ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  };
  if (st.isFile() || st.isCharacterDevice()) {
    try {
      return Promise.resolve({ payload: parse(fs.readFileSync(0, "utf8")), source: "file" });
    } catch {
      return Promise.resolve({ payload: {}, source: "unreadable" });
    }
  }
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0, finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(first);
      clearTimeout(hard);
      process.stdin.removeAllListeners("data");
      process.stdin.removeAllListeners("end");
      try {
        process.stdin.pause();
        process.stdin.unref && process.stdin.unref();
      } catch {
      }
      resolve(value);
    };
    const first = setTimeout(() => {
      if (!bytes) done({ payload: {}, source: "silent-pipe" });
    }, STDIN_WAIT_MS());
    const hard = setTimeout(() => done({ error: `timed out after ${Math.round(HOOK_TIMEOUT_MS() / 1e3)} s waiting for the hook payload on stdin (${bytes} byte(s) received, no end-of-file) \u2014 pass the plan path as an argument instead, or pipe the payload: echo '{"cwd":"\u2026"}' | node verify-build.js` }), Math.max(50, HOOK_TIMEOUT_MS() - 250));
    process.stdin.on("data", (c) => {
      bytes += c.length;
      chunks.push(c);
    });
    process.stdin.on("end", () => done({ payload: parse(Buffer.concat(chunks).toString("utf8")), source: "pipe" }));
    process.stdin.on("error", () => done({ payload: {}, source: "error" }));
    process.stdin.resume();
  });
}
var STALE_HOURS = 12;
function staleCutoffMs() {
  const raw = process.env.DTWIN_PLAN_STALE_HOURS;
  const h = raw === void 0 || raw === "" ? STALE_HOURS : Number(raw);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1e3 : 0;
}
function isStale(file, now = Date.now()) {
  const cutoff = staleCutoffMs();
  if (!cutoff) return false;
  try {
    return now - fs.statSync(file).mtimeMs > cutoff;
  } catch {
    return false;
  }
}
function readPlan(file) {
  try {
    return { file, plan: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}
function findPlans(cwd) {
  const dir = path.join(cwd, "design", "plan");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readPlan(path.join(dir, f))).filter(Boolean);
}
function rootOfPlan(file, fallback) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (path.basename(dir) === "plan" && path.basename(path.dirname(dir)) === "design") return path.dirname(path.dirname(dir));
  return fallback || process.cwd();
}
var LIFECYCLE = /* @__PURE__ */ new Set(["pending", "awaiting-user", "abandoned"]);
var COMPUTED_STORED = /* @__PURE__ */ new Set(["verified", "static-only"]);
var lifecycleOf = (plan) => {
  const s = String(plan && plan.status || "pending").trim().toLowerCase();
  return LIFECYCLE.has(s) ? s : "pending";
};
var sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
function fileHashes(plan, cwd) {
  const out = {};
  for (const rel of Array.isArray(plan.files) ? plan.files.map(String) : []) {
    try {
      out[rel] = sha(fs.readFileSync(path.join(cwd, rel)));
    } catch {
      out[rel] = null;
    }
  }
  return out;
}
function planHash(plan) {
  const copy = JSON.parse(JSON.stringify(plan || {}));
  delete copy.status;
  if (copy.verification && typeof copy.verification === "object") {
    delete copy.verification.hook;
    if (!Object.keys(copy.verification).length) delete copy.verification;
  }
  return sha(JSON.stringify(copy));
}
function changedFiles(plan, cwd) {
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.files) return null;
  const now = fileHashes(plan, cwd);
  const changed = [];
  const all = /* @__PURE__ */ new Set([...Object.keys(hook.files), ...Object.keys(now)]);
  for (const f of all) if (hook.files[f] !== now[f]) changed.push(now[f] === void 0 ? `${f} (no longer in files[])` : hook.files[f] === void 0 ? `${f} (added to files[])` : now[f] === null ? `${f} (missing)` : f);
  return changed;
}
function isOpen(p, cwd) {
  if (lifecycleOf(p.plan) !== "pending") return false;
  if (isStale(p.file)) return false;
  const hook = p.plan.verification && p.plan.verification.hook;
  if (!hook || hook.result !== "pass") return true;
  if (hook.planHash !== planHash(p.plan)) return true;
  const ch = changedFiles(p.plan, cwd);
  return !ch || ch.length > 0;
}
var SOURCE_EXT = /* @__PURE__ */ new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "astro",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "html",
  "htm",
  "swift",
  "kt",
  "kts",
  "java",
  "dart",
  "xml",
  "m",
  "mm",
  "h",
  "cs",
  "xaml"
]);
var extOf = (rel) => String(rel).toLowerCase().split(".").pop();
var isSourceFile = (rel) => SOURCE_EXT.has(extOf(rel));
var PROSE = /\b[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}[,.;:]?\s+[A-Za-z]{2,}\b/;
var isProse = (s) => PROSE.test(s) && !/-\[|\[#/.test(s);
function scanText(rel, text) {
  const ext = extOf(rel);
  const lineComments = !["css", "html", "htm", "xml", "xaml"].includes(ext);
  const htmlComments = ["html", "htm", "xml", "xaml", "vue", "svelte", "astro"].includes(ext);
  const strings = !["html", "htm", "xml", "xaml"].includes(ext);
  let out = "", i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (lineComments && c === "/" && d === "/" && text[i - 1] !== ":") {
      const j = text.indexOf("\n", i);
      const end = j === -1 ? n : j;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    if (htmlComments && text.startsWith("<!--", i)) {
      const j = text.indexOf("-->", i + 4);
      const end = j === -1 ? n : j + 3;
      out += text.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
      continue;
    }
    if (strings && (c === '"' || c === "'" || c === "`")) {
      let j = i + 1;
      while (j < n && text[j] !== c && !(c !== "`" && text[j] === "\n")) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const body = text.slice(i + 1, j);
      out += isProse(body) ? c + body.replace(/[^\n]/g, " ") + (text[j] === c ? c : "") : text.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
function hex6(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
}
function colorKey(value) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(String(value).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
  return full.length === 6 ? full + "ff" : full;
}
function colorLiterals(source) {
  const found = /* @__PURE__ */ new Map();
  const add = (h, lit) => {
    if (h && !found.has(h)) found.set(h, lit);
  };
  for (const m of source.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g)) add(colorKey(m[1]), m[0]);
  for (const m of source.matchAll(/\b0x([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g)) {
    const h = m[1].toLowerCase();
    add(h.length === 8 ? h.slice(2) + h.slice(0, 2) : h + "ff", m[0]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?[^)]*\)/g)) {
    const rgb = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
    add(rgb + alphaHex(m[4]), m[0]);
  }
  return found;
}
function alphaHex(a) {
  if (a === void 0 || a === "") return "ff";
  const n = String(a).endsWith("%") ? Number(String(a).slice(0, -1)) / 100 : Number(a);
  if (!Number.isFinite(n)) return "ff";
  return Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
}
var UTILITY_KIND = [
  [/^rounded(-[a-z]+)?$/, "radius"],
  [/^text$/, "fontSize"],
  [/^leading$/, "lineHeight"],
  [/^tracking$/, "letterSpacing"],
  [/^(gap|gap-x|gap-y|space-x|space-y)$/, "spacing"],
  [/^([pm][trblxy]?)$/, "spacing"],
  [/^(top|right|bottom|left|inset(-[xy])?|start|end)$/, "spacing"],
  [/^(w|h|min-w|min-h|max-w|max-h|size|basis)$/, "size"],
  [/^border(-[trblxyse]+)?$/, "borderWidth"]
];
var KIND_MATCHES = {
  radius: ["radius", "borderradius", "cornerradius"],
  fontSize: ["fontsize", "font-size", "type", "typography"],
  lineHeight: ["lineheight", "line-height"],
  letterSpacing: ["letterspacing", "letter-spacing", "tracking"],
  spacing: ["spacing", "space", "gap", "padding", "margin", "size", "dimension"],
  size: ["size", "spacing", "space", "dimension", "width", "height"],
  borderWidth: ["borderwidth", "border-width", "border", "stroke"]
};
function utilityKind(utility) {
  const u = String(utility || "").replace(/^-/, "");
  for (const [re, kind] of UTILITY_KIND) if (re.test(u)) return kind;
  return null;
}
function kindsCompatible(utility, rowKind) {
  const uk = utilityKind(utility);
  if (!uk) return true;
  const rk = String(rowKind || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!rk) return true;
  return (KIND_MATCHES[uk] || []).some((k) => k.replace(/[^a-z]/g, "") === rk);
}
function arbitraryPx(source) {
  const found = /* @__PURE__ */ new Map();
  for (const m of source.matchAll(/(?:^|[\s"'`{(])([a-z-]+)-\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[2]) * (m[3] === "rem" ? 16 : 1);
    const entry = { literal: `[${m[2]}${m[3]}]`, utility: m[1] };
    const list = found.get(px) || [];
    if (!list.some((e) => e.utility === entry.utility)) list.push(entry);
    found.set(px, list);
  }
  for (const m of source.matchAll(/\[(-?\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === "rem" ? 16 : 1);
    if (!found.has(px)) found.set(px, [{ literal: m[0], utility: null }]);
  }
  return found;
}
function importsOf(text) {
  const out = [];
  const re = /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?["'`]([^"'`]+)["'`]|\bexport\s+[^'"`;]*?\sfrom\s+["'`]([^"'`]+)["'`]|\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|@import\s+(?:url\()?["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) out.push(m[1] || m[2] || m[3] || m[4]);
  return out;
}
var SRC_EXT_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|css|scss|swift|kt|dart)$/i;
function moduleSegments(spec) {
  let s = String(spec || "").trim().replace(/\\/g, "/").replace(SRC_EXT_RE, "").replace(/\/index$/i, "");
  const segs = s.split("/").filter((x) => x && x !== "." && x !== "..");
  if (segs.length && /^[@~#]$/.test(segs[0])) segs.shift();
  return segs;
}
function moduleImported(mapModule, byFile, cwd) {
  const want = moduleSegments(mapModule);
  if (!want.length) return true;
  const suffixMatch = (have) => {
    const k = Math.min(have.length, want.length);
    if (!k) return false;
    for (let i = 1; i <= k; i++) if (have[have.length - i].toLowerCase() !== want[want.length - i].toLowerCase()) return false;
    return true;
  };
  const wantAbs = moduleSegments(path.relative(cwd, path.resolve(cwd, String(mapModule))));
  for (const f of byFile) {
    for (const spec of importsOf(f.text)) {
      if (spec.startsWith(".")) {
        const resolved = moduleSegments(path.relative(cwd, path.resolve(cwd, path.dirname(f.rel), spec)));
        if (resolved.join("/").toLowerCase() === wantAbs.join("/").toLowerCase() || suffixMatch(resolved)) return true;
      } else if (suffixMatch(moduleSegments(spec))) return true;
    }
    if (!/\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/i.test(f.rel)) {
      const name = want[want.length - 1];
      if (name && new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, "")}\\b`).test(f.text)) return true;
    }
  }
  return false;
}
function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function exportDirOf(cwd) {
  const e = path.join(cwd, "design", "export");
  return fs.existsSync(path.join(e, "pages")) ? e : path.join(cwd, "design");
}
var idFromStem = (s) => {
  const m = /__(I?\d+)_(\d+)$/.exec(String(s || ""));
  return m ? `${m[1]}:${m[2]}` : null;
};
function indexRows(exportDir) {
  const root = readJsonOr(path.join(exportDir, "pages", "index.json"), null);
  if (!root) return [];
  if (Array.isArray(root.layers)) return root.layers;
  const rows = [];
  for (const pd of root.pageDirs || []) {
    const idx = readJsonOr(path.join(exportDir, pd.index || path.join("pages", pd.dir || "", "index.json")), null);
    if (idx && Array.isArray(idx.layers)) rows.push(...idx.layers);
  }
  return rows;
}
function locateExport(plan, planFile, cwd) {
  const exportDir = exportDirOf(cwd);
  const tryFile = (rel) => {
    if (!rel) return null;
    for (const f of [path.resolve(cwd, rel), path.resolve(exportDir, rel)]) {
      const doc = fs.existsSync(f) ? readJsonOr(f, null) : null;
      if (doc) return { file: f, doc };
    }
    return null;
  };
  let hit = tryFile(plan.file && /\.json$/i.test(plan.file) ? plan.file : null);
  const rows = indexRows(exportDir);
  const ids = [plan.nodeId, idFromStem(plan.screen), planFile ? idFromStem(path.basename(planFile, ".json")) : null].filter(Boolean);
  let row = null;
  for (const id of ids) {
    row = rows.find((r) => r.id === id);
    if (row) break;
  }
  if (!hit && row) hit = tryFile(row.file);
  if (!hit) return null;
  const root = rootsOf(hit.doc)[0] || {};
  if (!row) row = rows.find((r) => r.id === (hit.doc.nodeId || root.id)) || null;
  return Object.assign(hit, { row, nodeId: hit.doc.nodeId || root.id || null, layerName: String(hit.doc.screen || root.name || ""), sameNameRows: rows.filter((r) => String(r.name || "").trim() === String(hit.doc.screen || root.name || "").trim()).length });
}
var anchored = (a) => !!a && typeof a === "object" && ["mapModule", "file", "symbol", "omitted"].some((k) => typeof a[k] === "string" && a[k].trim());
function anchorCoverage(plan, doc) {
  const { visible, hidden } = visibility(doc);
  const anchors = plan.anchors && typeof plan.anchors === "object" ? plan.anchors : {};
  const covered = /* @__PURE__ */ new Map();
  const isCovered = (id) => {
    if (covered.has(id)) return covered.get(id);
    const v = visible.get(id);
    const r = anchored(anchors[id]) || !!v && !!v.parentId && visible.has(v.parentId) && isCovered(v.parentId);
    covered.set(id, r);
    return r;
  };
  const hasAnchoredBelow = /* @__PURE__ */ new Set();
  for (const id of visible.keys()) {
    if (!anchored(anchors[id])) continue;
    let p = visible.get(id).parentId;
    while (p && visible.has(p) && !hasAnchoredBelow.has(p)) {
      hasAnchoredBelow.add(p);
      p = visible.get(p).parentId;
    }
  }
  const unmapped = [], wrappers = [];
  for (const [id, v] of visible) {
    if (isCovered(id)) continue;
    if (hasAnchoredBelow.has(id)) {
      wrappers.push({ id, name: v.node.name, type: v.node.type });
      continue;
    }
    const parentUnmapped = v.parentId && visible.has(v.parentId) && !isCovered(v.parentId) && !hasAnchoredBelow.has(v.parentId);
    if (!parentUnmapped) unmapped.push({ id, name: v.node.name, type: v.node.type });
  }
  const unmappedNodes = [...visible.keys()].filter((id) => !isCovered(id) && !hasAnchoredBelow.has(id)).length;
  return {
    visible: visible.size,
    unmapped,
    unmappedNodes,
    wrappers,
    hiddenAnchored: Object.keys(anchors).filter((id) => hidden.has(id)),
    unknown: Object.keys(anchors).filter((id) => !visible.has(id) && !hidden.has(id))
  };
}
var verdictOf = (row) => String(row && row.verdict || "").trim().toLowerCase();
var NO_TOKEN = /* @__PURE__ */ new Set(["missing", "none", "n/a", "na", "-", "null", "tbd"]);
var hasToken = (row) => !!row.codeToken && !NO_TOKEN.has(String(row.codeToken).trim().toLowerCase());
function loadMapKeys(cwd) {
  for (const f of [path.join(cwd, "design", "codeconnect.local.json"), path.join(cwd, "codeconnect.local.json")]) {
    const map = readJsonOr(f, null);
    if (!map) continue;
    const keys = /* @__PURE__ */ new Map();
    for (const [name, e] of Object.entries(map.components || {})) {
      if (e && e.figma && e.figma.key && e.code && e.code.module && e.status !== "deprecated") keys.set(e.figma.key, { name, module: e.code.module });
    }
    return keys;
  }
  return /* @__PURE__ */ new Map();
}
function checkVerification(plan, cwd) {
  const v = plan.verification;
  if (!v || typeof v !== "object" || v.mode === void 0) {
    return ['no `verification.mode` in the plan \u2014 record how the build was checked: {mode:"rendered", renderer, artifacts:[\u2026], deltas:[\u2026]} after rendering and comparing (references/verify.md), or {mode:"static-only", reason} if the project genuinely has no way to render'];
  }
  if (v.mode === "rendered") {
    const artifacts = Array.isArray(v.artifacts) ? v.artifacts : [];
    if (!artifacts.length) return ['verification.mode is "rendered" but `artifacts` is empty \u2014 list the screenshot(s)/report the render produced'];
    const missing = artifacts.filter((a) => !fs.existsSync(path.join(cwd, String(a))));
    if (missing.length) return [`verification artifact(s) not found on disk: ${missing.join(", ")} \u2014 render the screen, or record mode "static-only" with the reason`];
    if (!Array.isArray(v.deltas)) return ["verification.deltas is missing \u2014 list the residual differences against the reference ([] if none were found)"];
    return [];
  }
  if (v.mode === "static-only") {
    return v.reason ? [] : ['verification.mode is "static-only" with no `reason` \u2014 say what was checked for and not found (dev server, Playwright, simulator\u2026)'];
  }
  return [`verification.mode must be "rendered" or "static-only", got ${JSON.stringify(v.mode)}`];
}
function verificationWarnings(plan) {
  const v = plan.verification;
  if (!v || v.mode !== "rendered") return [];
  const out = [];
  const c = v.coverage;
  if (!c || !Array.isArray(c.rendered) || !c.rendered.length) out.push('verification.coverage is missing \u2014 record {rendered:[\u2026], notChecked:[{what, why}]} so the report can say which states/themes/sizes were never rendered (references/verify.md, "Beyond the ideal frame")');
  if (!v.a11y) out.push("verification.a11y is missing \u2014 no accessibility check is recorded (web: @axe-core/playwright on the rendered page); say so in the report rather than implying one ran");
  return out;
}
var A11Y = /\b(a11y|axe|accessib)/i;
function verificationContradictions(plan, reports) {
  const v = plan.verification;
  if (!v || typeof v !== "object") return [];
  const out = [];
  const notChecked = v.coverage && Array.isArray(v.coverage.notChecked) ? v.coverage.notChecked : [];
  const what = (e) => String(e && typeof e === "object" ? e.what || "" : e || "");
  const rendered = v.coverage && Array.isArray(v.coverage.rendered) ? v.coverage.rendered.map((x) => String(x).trim().toLowerCase()) : [];
  if (v.a11y && typeof v.a11y === "object" && v.a11y.violations !== void 0) {
    const nc = notChecked.find((e) => A11Y.test(what(e)));
    if (nc) out.push(`verification contradicts itself: \`a11y\` records ${JSON.stringify(v.a11y.violations)} violation(s) from ${JSON.stringify(v.a11y.tool || "an a11y scan")}, while \`coverage.notChecked\` says "${what(nc)}" was not checked${nc.why ? ` (${nc.why})` : ""} \u2014 keep the one that is true`);
  }
  for (const e of notChecked) if (rendered.includes(what(e).trim().toLowerCase())) out.push(`verification contradicts itself: "${what(e)}" is listed both in coverage.rendered and in coverage.notChecked`);
  for (const r of reports || []) {
    if (Array.isArray(v.deltas) && !v.deltas.length && Array.isArray(r.deltas) && r.deltas.length) out.push(`verification.deltas is [] but ${r.rel} lists ${r.deltas.length} delta(s) \u2014 copy them (or the ones you judged real, with why) into the plan`);
    for (const k of ["verifyScreenVerdict", "verdict"]) {
      const claimed = v[k];
      const s = claimed && typeof claimed === "object" ? claimed.verdict : claimed;
      if (typeof s === "string" && /pass/i.test(s) && r.verdict !== "pass") out.push(`verification.${k} says ${JSON.stringify(s)} but ${r.rel} says verdict ${JSON.stringify(r.verdict)} \u2014 the report is the verdict; the plan cannot overrule it`);
    }
  }
  return out;
}
var DEVIATION_FIELDS = ["nodeId", "field", "designed", "built", "reason"];
function deviationWarnings(plan) {
  if (plan.deviations === void 0) return [];
  if (!Array.isArray(plan.deviations)) return ["`deviations` must be an array of {nodeId, field, designed, built, reason}"];
  const bad = [];
  plan.deviations.forEach((d, i) => {
    const miss = DEVIATION_FIELDS.filter((k) => {
      if (k === "nodeId") return !(d && (typeof d.nodeId === "string" && d.nodeId || Array.isArray(d.nodeIds) && d.nodeIds.length));
      return !(d && d[k] !== void 0 && d[k] !== null && d[k] !== "");
    });
    if (miss.length) bad.push(`#${i}${d && d.id ? ` (${d.id})` : ""}: ${miss.join(", ")}`);
  });
  return bad.length ? [`${bad.length} deviation(s) are missing fields \u2014 each needs {nodeId, field, designed, built, reason} so a reviewer can check it against the export: ${bad.slice(0, 6).join("; ")}${bad.length > 6 ? `; +${bad.length - 6} more` : ""}`] : [];
}
function validatePlanHeader(plan) {
  const missing = ["screenName", "nodeId", "route", "file"].filter((k) => plan[k] === void 0 || plan[k] === null || plan[k] === "");
  if (!missing.length) return [];
  return [
    `plan header is missing ${missing.map((k) => `\`${k}\``).join(", ")} \u2014 other skills (verify, sync-design) resolve a screen through this header, not through the free-text \`screen\` field; add ${missing.length > 1 ? "them" : "it"} so this plan is findable by node id/name/route without guessing (plan-skeleton.js writes the header; only the route is yours to fill)`
  ];
}
var DECLARATION = /(^|[\s;{,(])(--[\w-]+|[\w$][\w$-]*)\s*[:=]\s*[^;,}\n]*$/;
var slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function tokenCore(x) {
  let s = String(x || "").toLowerCase().replace(/^--/, "").replace(/^var\(--|\)$/g, "");
  s = s.replace(/^(color|colors|spacing|space|radius|rounded|text|font|font-size|font-weight|leading|tracking|shadow|bg|border|fill|stroke|ring|outline|gap|gap-[xy]|p[xytrbl]?|m[xytrbl]?|w|h|size|inset|top|left|right|bottom)-/, "");
  s = s.replace(/^figma-/, "").replace(/-[0-9a-f]{8}$/, "");
  return slug(s);
}
function declaresToken(line, literal, codeToken) {
  const at = line.indexOf(literal);
  if (at === -1) return false;
  const m = DECLARATION.exec(line.slice(0, at));
  if (!m) return false;
  const declared = slug(m[2]), token = slug(codeToken);
  if (!declared || !token) return false;
  const dc = tokenCore(m[2]), tc = tokenCore(codeToken);
  return declared === token || declared.includes(token) || token.includes(declared) || !!dc && !!tc && (dc === tc || dc.includes(tc) || tc.includes(dc));
}
function checkPlan({ plan, file }, cwd, opts) {
  const o = opts || {};
  const blocking = [], warnings = [];
  const listed = Array.isArray(plan.files) ? plan.files.map(String) : [];
  const absent = listed.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (!listed.length) warnings.push("`files` is empty \u2014 list every file this build created or changed; the literal and import checks only read the files named there, so nothing was checked");
  if (absent.length) warnings.push(`file(s) listed in \`files\` not found on disk: ${absent.join(", ")} \u2014 fix the path(s) (relative to the project root) or remove entries for files that were not written`);
  const byFile = listed.filter((rel) => fs.existsSync(path.join(cwd, rel)) && fs.statSync(path.join(cwd, rel)).isFile()).map((rel) => ({ rel, text: fs.readFileSync(path.join(cwd, rel), "utf8") }));
  const code = byFile.filter((f) => isSourceFile(f.rel)).map((f) => ({ rel: f.rel, text: scanText(f.rel, f.text) }));
  const source = code.map((f) => f.text).join("\n");
  const allowed = new Set((plan.allowedLiterals || []).filter((a) => a && a.reason && a.value !== void 0).map((a) => String(a.value).toLowerCase()));
  const allowedFiles = (plan.allowedLiterals || []).filter((a) => a && a.reason && a.file).map((a) => String(a.file));
  const isAllowed = (row, literal) => allowed.has(String(row.value).toLowerCase()) || allowed.has(String(literal).toLowerCase());
  function definedOnlyInTokenSource(literal, codeToken) {
    if (!literal) return false;
    let seen = false;
    for (const f of code) {
      if (!f.text.includes(literal)) continue;
      if (allowedFiles.includes(f.rel)) {
        seen = true;
        continue;
      }
      for (const line of f.text.split("\n")) {
        if (!line.includes(literal)) continue;
        if (!declaresToken(line, literal, codeToken)) return false;
        seen = true;
      }
    }
    return seen;
  }
  const tokens = Array.isArray(plan.tokens) ? plan.tokens : [];
  const live = tokens.filter((r) => verdictOf(r) !== "hidden-only");
  const undecided = live.filter((row) => (verdictOf(row) === "missing" || !hasToken(row)) && !row.decision);
  if (undecided.length) {
    const show = undecided.slice(0, 8).map((row) => `${row.figmaName ? `'${row.figmaName}' ` : ""}${row.value} (${row.kind})`).join(", ");
    warnings.push(`${undecided.length} token row(s) have no token and no recorded decision: ${show}${undecided.length > 8 ? `, +${undecided.length - 8} more` : ""} \u2014 fill codeToken, or say what you did about it in \`decision\` (a one-off literal is a legitimate answer; say so)`);
  }
  const byCodeToken = /* @__PURE__ */ new Map();
  for (const row of live) {
    if (!hasToken(row) || !row.figmaName) continue;
    const c = String(row.codeToken).trim();
    const names = byCodeToken.get(c) || /* @__PURE__ */ new Map();
    if (!names.has(row.figmaName)) names.set(row.figmaName, row.value);
    byCodeToken.set(c, names);
  }
  for (const [c, names] of byCodeToken) {
    if (names.size < 2) continue;
    const l = [...names].map(([n, v]) => `'${n}' (${v})`).join(" and ");
    warnings.push(`code token '${c}' is mapped from ${names.size} DIFFERENT Figma tokens \u2014 ${l}. They may share a value in the exported mode, but they are separate tokens and will diverge in another mode/theme; give each its own code token named after its own Figma name`);
  }
  const colors = colorLiterals(source);
  const colourHits = /* @__PURE__ */ new Map();
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() !== "color") continue;
    const h = colorKey(row.value);
    const lit = h && colors.get(h);
    if (lit && !isAllowed(row, lit) && !definedOnlyInTokenSource(lit, row.codeToken)) {
      if (!colourHits.has(lit)) colourHits.set(lit, { value: row.value, tokens: [] });
      const e = colourHits.get(lit);
      if (!e.tokens.includes(row.codeToken)) e.tokens.push(row.codeToken);
    }
  }
  for (const [lit, e] of colourHits) {
    const where = code.filter((f) => f.text.includes(lit)).map((f) => f.rel);
    blocking.push(`raw colour ${lit} in ${where.join(", ")}, but the plan resolved ${e.value} to token ${e.tokens.map((t) => `'${t}'`).join(" / ")} \u2014 use the token, not the literal (comments, prose strings and non-source files such as .svg are not scanned). A value that must stay literal goes in allowedLiterals as {"value": "${lit}", "reason": "\u2026"}, matched on the exact value string, or name the file that defines the tokens: {"file": "\u2026", "reason": "\u2026"}`);
  }
  const dims = arbitraryPx(source);
  for (const row of live) {
    if (!hasToken(row) || String(row.kind).toLowerCase() === "color") continue;
    const n = parseFloat(row.value);
    const hits = Number.isFinite(n) ? dims.get(n) || [] : [];
    const hit = hits.find((e) => kindsCompatible(e.utility, row.kind) && !isAllowed(row, e.literal) && !definedOnlyInTokenSource(e.literal, row.codeToken));
    if (hit) warnings.push(`arbitrary value ${hit.utility ? `${hit.utility}-${hit.literal}` : hit.literal} in built code, but the plan resolved ${row.value} (${row.kind}) to token '${row.codeToken}' \u2014 use the token (or add it to allowedLiterals with a reason)`);
  }
  const mapped = loadMapKeys(cwd);
  const seenModule = /* @__PURE__ */ new Set();
  for (const row of Array.isArray(plan.components) ? plan.components : []) {
    const verdict = verdictOf(row);
    if (verdict === "reused" && row.mapModule && !seenModule.has(row.mapModule)) {
      seenModule.add(row.mapModule);
      if (!moduleImported(row.mapModule, byFile, cwd)) warnings.push(`component '${row.name}' is "reused" from ${row.mapModule}, but no file in files[] imports that module (compared by resolved path / path suffix, so '../../components/X' and '@/components/X' both count) \u2014 was it regenerated instead of reused?`);
    }
    if (verdict === "new" && row.key && mapped.has(row.key)) {
      warnings.push(`component '${row.name}' is marked "new" in the plan, but its Figma key is mapped to ${mapped.get(row.key).module} in codeconnect.local.json \u2014 reuse the existing component`);
    }
    if (verdict === "missing") warnings.push(`component '${row.name}' has no recorded reuse/new decision`);
  }
  const exp = o.export === void 0 ? locateExport(plan, file, cwd) : o.export;
  if (!exp) {
    warnings.push("could not find this plan's screen export (no `file`/`nodeId` header, and no node id in its name) \u2014 the anchor check did not run; plan-skeleton.js writes the header");
  } else {
    const cov = anchorCoverage(plan, exp.doc);
    if (cov.unmapped.length) {
      const show = cov.unmapped.slice(0, 10).map((u) => `${u.id} '${String(u.name).trim()}' (${u.type})`).join(", ");
      blocking.push(`${cov.unmappedNodes} visible design node(s) have no anchor in the plan \u2014 neither they nor any ancestor map to code. Top of each unmapped subtree: ${show}${cov.unmapped.length > 10 ? `, +${cov.unmapped.length - 10} more` : ""}. Add anchors["<id>"] = {"mapModule": "<the file that renders it>"} on the subtree's top (children inherit it), or {"omitted": "<why it is not built>"} \u2014 plan-skeleton.js lists every visible node`);
    }
    if (cov.wrappers.length) warnings.push(`${cov.wrappers.length} visible container(s) have anchored children but no anchor of their own (e.g. ${cov.wrappers.slice(0, 3).map((w) => `${w.id} '${String(w.name).trim()}'`).join(", ")}) \u2014 anchor the frame to the screen component so sync-design can place a change to it`);
    if (cov.hiddenAnchored.length) warnings.push(`${cov.hiddenAnchored.length} anchor(s) point at HIDDEN nodes (${cov.hiddenAnchored.slice(0, 4).join(", ")}${cov.hiddenAnchored.length > 4 ? ", \u2026" : ""}) \u2014 hidden layers are not built; remove them`);
    if (cov.unknown.length) warnings.push(`${cov.unknown.length} anchor(s) name node ids that are not on this frame (${cov.unknown.slice(0, 4).join(", ")}${cov.unknown.length > 4 ? ", \u2026" : ""}) \u2014 e.g. a shared shell tagged with another frame's instance ids; anchor THIS frame's ids`);
  }
  warnings.push(...checkVerification(plan, cwd));
  warnings.push(...verificationWarnings(plan));
  warnings.push(...verificationContradictions(plan, o.reports || locateReports(plan, file, cwd, exp)));
  warnings.push(...deviationWarnings(plan));
  warnings.push(...validatePlanHeader(plan));
  return { blocking, warnings };
}
function locateReports(plan, planFile, cwd, exp) {
  const dir = path.join(cwd, "design", "verify");
  if (!fs.existsSync(dir)) return [];
  const e = exp === void 0 ? locateExport(plan, planFile, cwd) : exp;
  const stems = new Set([
    plan.file ? path.basename(String(plan.file)).replace(/\.json$/i, "") : null,
    e ? path.basename(e.file).replace(/\.json$/i, "") : null,
    planFile ? path.basename(planFile, ".json") : null,
    plan.screen ? String(plan.screen) : null
  ].filter(Boolean));
  const nodeId = plan.nodeId || e && e.nodeId || idFromStem(plan.screen) || (planFile ? idFromStem(path.basename(planFile, ".json")) : null);
  const layer = e ? e.layerName.trim() : null;
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".report.json")).sort()) {
    const abs = path.join(dir, f);
    const r = readJsonOr(abs, null);
    if (!r) continue;
    const stem = f.replace(/\.report\.json$/, "");
    let by = null;
    const expFile = path.join(dir, stem + ".expected.json");
    const expFrame = () => {
      const x = readJsonOr(expFile, null);
      return x && x.frame && x.frame.nodeId;
    };
    if (stems.has(stem)) by = "name";
    else if (nodeId && (r.nodeId === nodeId || idFromStem(stem) === nodeId)) by = "nodeId";
    else if (nodeId && fs.existsSync(expFile) && expFrame() === nodeId) by = "expectation frame";
    else if (layer && e.sameNameRows <= 1 && String(r.screen || "").trim() === layer) by = "layer name";
    if (!by) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
    }
    const want = r.inputs && r.inputs.expectationSha256;
    let expectationChanged = false;
    if (want && fs.existsSync(expFile)) {
      try {
        expectationChanged = crypto.createHash("sha256").update(fs.readFileSync(expFile)).digest("hex") !== want;
      } catch {
      }
    }
    out.push({
      rel: path.relative(cwd, abs).split(path.sep).join("/"),
      matchedBy: by,
      schema: r.schema || null,
      verdict: r.verdict || null,
      headline: r.headline || null,
      why: Array.isArray(r.why) ? r.why : [],
      deltas: Array.isArray(r.deltas) ? r.deltas : null,
      exportedAt: r.exportedAt || null,
      measuredAt: r.measuredAt || null,
      mtimeMs,
      expectationChanged,
      expectationRel: expectationChanged ? path.relative(cwd, expFile).split(path.sep).join("/") : null
    });
  }
  return out;
}
function computeStatus(plan, opts) {
  const o = opts || {};
  const cwd = o.cwd || (o.planFile ? rootOfPlan(o.planFile) : process.cwd());
  const reasons = [];
  const stored = String(plan && plan.status || "").trim().toLowerCase();
  if (COMPUTED_STORED.has(stored)) reasons.push(`the stored "status": "${plan.status}" was written by an older hook and is ignored \u2014 status is computed`);
  const life = lifecycleOf(plan);
  if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? "retired by hand" : "paused on a question for the user"], reports: [] };
  const hook = plan.verification && plan.verification.hook;
  if (!hook || !hook.result) return { status: "pending", reasons: reasons.concat("the build-screen Stop hook has not checked this plan"), reports: [] };
  if (hook.planHash && hook.planHash !== planHash(plan)) return { status: "pending", reasons: reasons.concat("the plan changed after the hook's last check"), reports: [] };
  if (hook.result !== "pass") return { status: "blocked", reasons: reasons.concat(hook.blocking && hook.blocking.length ? hook.blocking : ["the hook's last check blocked"]), reports: [] };
  const ch = changedFiles(plan, cwd) || [];
  if (ch.length) return { status: "stale", reasons: reasons.concat(`file(s) changed since the hook passed: ${ch.slice(0, 6).join(", ")}${ch.length > 6 ? `, +${ch.length - 6} more` : ""}`), reports: [] };
  const exp = o.export === void 0 ? locateExport(plan, o.planFile, cwd) : o.export;
  const reports = o.reports || locateReports(plan, o.planFile, cwd, exp);
  const said = (r) => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.headline ? ` (${r.headline})` : r.why.length ? `: ${r.why.join("; ")}` : ""}`;
  const failing = reports.filter((r) => r.verdict === "fail");
  if (failing.length) return { status: "failed", reasons: reasons.concat(failing.map(said)), reports };
  const notPass = reports.filter((r) => r.verdict !== "pass");
  if (notPass.length) return { status: "unverified", reasons: reasons.concat(notPass.map(said)), reports };
  const moved = reports.filter((r) => r.expectationChanged);
  if (moved.length) return { status: "unverified", reasons: reasons.concat(moved.map((r) => `${r.rel} was computed against a different ${r.expectationRel} than the one on disk (inputs.expectationSha256 no longer matches) \u2014 re-run --compare`)), reports };
  const mode = plan.verification && plan.verification.mode;
  if (!reports.length) {
    if (mode === "static-only") return { status: "static-only", reasons: reasons.concat(`built and checked statically \u2014 not rendered (${plan.verification.reason || "no reason recorded"})`), reports };
    return { status: "unverified", reasons: reasons.concat(`no verify report found for this screen in design/verify/ \u2014 run verify-screen.js --expect/--compare (the report's verdict is what grants "verified")`), reports };
  }
  let newest = 0;
  for (const rel of Array.isArray(plan.files) ? plan.files : []) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(cwd, String(rel))).mtimeMs);
    } catch {
    }
  }
  const older = reports.filter((r) => r.mtimeMs && newest && r.mtimeMs < newest);
  if (older.length) return { status: "unverified", reasons: reasons.concat(`${older.map((r) => r.rel).join(", ")} is older than the newest file in files[] \u2014 it describes an earlier build; re-run --compare`), reports };
  const expAt = exp && exp.doc && exp.doc.exportedAt;
  const onOld = expAt ? reports.filter((r) => r.exportedAt && r.exportedAt !== expAt) : [];
  if (onOld.length) return { status: "unverified", reasons: reasons.concat(`${onOld.map((r) => r.rel).join(", ")} was computed against an export from ${onOld[0].exportedAt}; the export on disk is from ${expAt} \u2014 re-run --expect and --compare`), reports };
  return { status: "verified", reasons: reasons.concat(`hook passed, files unchanged, ${reports.map((r) => r.rel).join(", ")} says pass`), reports };
}
function ownPlans(open, input, all) {
  const file = input.agent_transcript_path || (input.agent_id ? null : input.transcript_path);
  if (!file) return open;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return open;
  }
  const mentioned = (p) => {
    const base = path.basename(p.file);
    return text.includes("plan/" + base) || text.includes("plan\\\\" + base);
  };
  const known = all && all.length ? all : open;
  if (!known.some(mentioned)) return open;
  return open.filter(mentioned);
}
var USAGE = [
  "usage: node verify-build.js                     (Stop hook: reads the hook JSON from stdin when stdin is not a terminal)",
  "       node verify-build.js <plan.json>\u2026        check these plans now (no stdin read)",
  "       node verify-build.js --status [<plan.json>\u2026] [--json]   print each plan's computed status (all of design/plan/ by default); never writes",
  "",
  "Blocks (exit 2) on exactly two things: a raw colour the plan resolved to a token, in a source file of",
  "files[] (comments, prose strings and .svg/.json/non-source files are not scanned); and a visible",
  "design node with no anchor (itself or an ancestor) in anchors{}. Everything else is a warning (exit 0).",
  "Never writes plan.status: it records verification.hook {result, planHash, files:{path: sha256}}, and",
  "--status computes pending | blocked | stale | failed | unverified | static-only | verified from that,",
  "the file hashes, and design/verify/<\u2026>.report.json's verdict."
].join("\n");
function checkAndRecord(p, cwd, input) {
  const exp = locateExport(p.plan, p.file, cwd);
  const reports = locateReports(p.plan, p.file, cwd, exp);
  setPhase(`checking ${path.basename(p.file)}`);
  const { blocking, warnings } = checkPlan(p, cwd, { export: exp, reports });
  const plan = p.plan;
  const cleared = COMPUTED_STORED.has(String(plan.status || "").toLowerCase()) ? plan.status : null;
  if (cleared) delete plan.status;
  if (!plan.verification || typeof plan.verification !== "object") plan.verification = {};
  setPhase(`hashing files[] of ${path.basename(p.file)}`);
  plan.verification.hook = {
    result: blocking.length ? "blocked" : "pass",
    checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
    blocking,
    warnings: warnings.length,
    planHash: planHash(plan),
    files: fileHashes(plan, cwd)
  };
  let times = null;
  try {
    const s = fs.statSync(p.file);
    times = [s.atime, s.mtime];
  } catch {
  }
  fs.writeFileSync(p.file, JSON.stringify(plan, null, 2) + "\n");
  if (times) try {
    fs.utimesSync(p.file, times[0], times[1]);
  } catch {
  }
  const st = computeStatus(plan, { cwd, planFile: p.file, export: exp, reports });
  return { blocking, warnings, cleared, status: st };
}
async function main(argv) {
  const args = argv.slice();
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const statusMode = args.includes("--status");
  const json = args.includes("--json");
  const planArgs = args.filter((a) => !a.startsWith("-"));
  const stray = args.filter((a) => a.startsWith("-") && !["--status", "--json"].includes(a));
  if (stray.length) {
    console.error(`verify-build: unknown flag ${stray.join(", ")}
${USAGE}`);
    return 2;
  }
  if (statusMode) {
    setPhase("computing plan status");
    const plans = planArgs.length ? planArgs.map((f) => readPlan(path.resolve(f))).filter(Boolean) : findPlans(process.cwd());
    const show = (f) => {
      const r = path.relative(process.cwd(), f);
      return r.startsWith("..") ? f : r;
    };
    const rows = plans.map((p) => Object.assign({ plan: show(p.file) }, computeStatus(p.plan, { planFile: p.file, cwd: rootOfPlan(p.file) })));
    if (json) console.log(JSON.stringify(rows.map((r) => ({ plan: r.plan, status: r.status, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
    else for (const r of rows) console.log(`${r.plan}: ${r.status}${r.reasons.length ? "\n  - " + r.reasons.join("\n  - ") : ""}`);
    if (!plans.length) console.error("verify-build: no plans found (design/plan/*.json)");
    return 0;
  }
  let input = {};
  let targets;
  if (planArgs.length) {
    targets = planArgs.map((f) => readPlan(path.resolve(f)));
    const bad = planArgs.filter((f, i) => !targets[i]);
    if (bad.length) {
      console.error(`verify-build: cannot read plan(s): ${bad.join(", ")}`);
      return 1;
    }
  } else {
    setPhase("reading the hook payload on stdin");
    const r = await readHookInput();
    if (r.error) {
      console.error(`verify-build: ${r.error}`);
      return 1;
    }
    input = r.payload || {};
    if (input.stop_hook_active) return 0;
  }
  const all = [];
  if (targets) {
    for (const p of targets) {
      const cwd = rootOfPlan(p.file);
      const life = lifecycleOf(p.plan);
      if (life !== "pending") {
        console.error(`verify-build: ${path.basename(p.file)} is "${life}" \u2014 not checked`);
        continue;
      }
      all.push({ p, cwd });
    }
  } else {
    const cwd = input.cwd || process.cwd();
    setPhase("finding open plans in design/plan/");
    const plans = findPlans(cwd);
    const open = plans.filter((p) => isOpen(p, cwd));
    if (!open.length) return 0;
    for (const p of ownPlans(open, input, plans)) all.push({ p, cwd });
  }
  const blockedOut = [];
  for (const { p, cwd } of all) {
    const res = checkAndRecord(p, cwd, input);
    const name = path.basename(p.file);
    if (res.cleared) console.error(`verify-build: ${name}: removed the stored "status": "${res.cleared}" \u2014 status is computed now (verify-build.js --status), never stored`);
    for (const w of res.warnings) console.error(`verify-build: warning (${name}): ${w}`);
    if (res.blocking.length) blockedOut.push(`# ${name}`, ...res.blocking.map((m) => `  - ${m}`));
    const why = res.blocking.length ? "see below" : res.status.reasons[res.status.reasons.length - 1];
    console.error(`verify-build: ${name}: hook ${res.blocking.length ? "BLOCKED" : "passed"} \xB7 computed status: ${res.status.status}${why ? ` \u2014 ${why}` : ""}`);
  }
  if (blockedOut.length) {
    console.error("\nverify-build: build-screen check failed \u2014 do not report this screen as done until these are resolved");
    console.error('(a plan that will not be finished: set its status to "abandoned"; a build paused on a question for the user: "awaiting-user", then ask):\n');
    console.error(blockedOut.join("\n"));
    return 2;
  }
  return 0;
}
module.exports = {
  checkPlan,
  computeStatus,
  locateReports,
  locateExport,
  anchorCoverage,
  moduleImported,
  importsOf,
  scanText,
  isSourceFile,
  verificationWarnings,
  verificationContradictions,
  deviationWarnings,
  validatePlanHeader,
  ownPlans,
  checkVerification,
  colorLiterals,
  arbitraryPx,
  hex6,
  colorKey,
  isStale,
  isOpen,
  planHash,
  fileHashes,
  readHookInput,
  main,
  USAGE
};
if (require.main === module) {
  const watchdog = setTimeout(() => {
    console.error(`verify-build: gave up after ${Math.round(HOOK_TIMEOUT_MS() / 1e3)} s while ${phase} \u2014 nothing was blocked; re-run \`node verify-build.js <plan.json>\` to check the plan directly`);
    process.exit(1);
  }, HOOK_TIMEOUT_MS());
  watchdog.unref();
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`verify-build: ${e && e.stack || e}`);
    process.exitCode = 1;
  });
}
