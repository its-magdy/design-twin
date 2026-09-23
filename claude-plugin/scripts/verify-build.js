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

// design-to-code/slice-sources.js
var require_slice_sources = __commonJS({
  "design-to-code/slice-sources.js"(exports2, module2) {
    function sourcesOf(doc, docPath, fs2, path2) {
      const out = /* @__PURE__ */ new Map();
      const add = (key, screen) => {
        if (typeof key !== "string" || !key || !screen) return;
        if (!out.has(key)) out.set(key, []);
        if (!out.get(key).includes(screen)) out.get(key).push(screen);
      };
      const base = docPath ? path2.dirname(docPath) : ".";
      for (const sl of Array.isArray(doc && doc._slices) ? doc._slices : []) {
        if (!sl) continue;
        let read = false;
        if (typeof sl.file === "string" && fs2 && path2) {
          try {
            const slice = JSON.parse(fs2.readFileSync(path2.join(base, sl.file.replace(/\.json$/, ".vars.json")), "utf8"));
            for (const v of slice.variables || []) add(v && v.key, sl.screen);
            read = true;
          } catch (_) {
          }
        }
        if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
      }
      for (const c of Array.isArray(doc && doc._conflicts) ? doc._conflicts : []) {
        for (const vr of c && c.variants || []) for (const sc of vr.screens || []) add(vr.key, sc);
      }
      if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
        for (const v of doc && doc.variables || []) add(v && v.key, path2.basename(docPath, ".vars.json"));
      }
      return out;
    }
    module2.exports = { sourcesOf };
  }
});

// design-to-code/cross-check.js
var require_cross_check = __commonJS({
  "design-to-code/cross-check.js"(exports2, module2) {
    var { visibleInstances, matchByNameAndSignature, isRekeyed } = require_component_match();
    var { hiddenSelf } = require_hidden();
    var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
    var ABSURD_NUMBER = 1e4;
    var WRONG_CATALOG_PCT = 5;
    function walk(node, fn) {
      if (!node || typeof node !== "object") return;
      if (hiddenSelf(node)) return;
      fn(node);
      for (const c of node.children || []) walk(c, fn);
    }
    function rootsOf2(doc) {
      if (!doc) return [];
      if (Array.isArray(doc.nodes)) return doc.nodes;
      if (doc.tree) return [doc.tree];
      if (doc.id || doc.type) return [doc];
      return [];
    }
    var norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    function crossCheck(input) {
      const screens = input.screens || [];
      const variables = input.variables || null;
      const tokens = input.tokens || null;
      const components = input.components || null;
      const componentsLibrary = input.componentsLibrary || null;
      const stylesText = input.stylesText || null;
      const findings = [];
      const notChecked = [];
      const push = (severity, code, message, extra) => findings.push(Object.assign({ severity, code, message }, extra || {}));
      const usedTokenNames = /* @__PURE__ */ new Map();
      const instances = [];
      const fonts = /* @__PURE__ */ new Map();
      const textStyles = /* @__PURE__ */ new Map();
      const resolvedModes = /* @__PURE__ */ new Map();
      for (const s of screens) {
        const label = s.label || s.doc && s.doc.screen || "screen";
        for (const root of rootsOf2(s.doc)) {
          if (root && root.resolvedModes) {
            for (const [coll, mode] of Object.entries(root.resolvedModes)) {
              if (!resolvedModes.has(coll)) resolvedModes.set(coll, /* @__PURE__ */ new Set());
              resolvedModes.get(coll).add(mode);
            }
          }
          walk(root, (n) => {
            for (const [field, name] of Object.entries(n.tokens || {})) {
              if (typeof name !== "string") continue;
              if (!usedTokenNames.has(name)) usedTokenNames.set(name, []);
              usedTokenNames.get(name).push({ screen: label, nodeId: n.id, field });
            }
            for (const f of n.fills || []) {
              const t = f && f.tokens && f.tokens.color;
              if (typeof t === "string") {
                if (!usedTokenNames.has(t)) usedTokenNames.set(t, []);
                usedTokenNames.get(t).push({ screen: label, nodeId: n.id, field: "fills" });
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
        const label = s.label || s.doc && s.doc.screen || "screen";
        for (const i of visibleInstances(s.doc, label)) {
          visible.push(i);
          instances.push({ screen: label, nodeId: i.nodeId, name: i.layer, key: i.key, setKey: i.setKey, setName: i.name, propNames: Object.keys(i.props || {}) });
        }
      });
      const dsCollByKey = /* @__PURE__ */ new Map();
      const dsCollByName = /* @__PURE__ */ new Map();
      for (const c of tokens && tokens.collections || []) {
        if (c.key) dsCollByKey.set(c.key, c);
        if (c.name) dsCollByName.set(norm(c.name), c);
      }
      const screenColls = variables && variables.collections || [];
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
          const twin = dsCollByName.get(norm(c.name));
          foreign.push({ name: c.name, key: c.key, twinKey: twin && twin.key, twinName: twin && twin.name });
        }
        if (foreign.length) {
          const sameNameDifferentKey = foreign.filter((f) => f.twinKey);
          const severity = foreign.length === screenColls.length ? "blocker" : "warning";
          push(
            severity,
            "foreign-token-library",
            `${foreign.length} of ${screenColls.length} variable collection(s) the screen binds are NOT in the design-system export \u2014 the screen consumes a DIFFERENT library than the one you pulled. ` + (sameNameDifferentKey.length ? `${sameNameDifferentKey.length} of them carry a design-system collection's name under a different key (${sameNameDifferentKey.slice(0, 3).map((f) => `'${f.name}'`).join(", ")}), which is the signature of a DUPLICATED Figma file: duplicating a library re-keys everything while leaving names and values identical. ` : "") + `Names and values may still line up (check the collisions below), but nothing here is the same variable. To find the real owner: run \`dtwin list libraries --client <the screen's file>\` \u2014 variable collections are the ONE thing Figma attributes to a library by name \u2014 then open that file and export it with \`dtwin pull --as-library "<name>"\`.`,
            { collections: foreign }
          );
        } else {
          push("info", "token-library-matches", `all ${screenColls.length} variable collection(s) the screen binds resolve to the design-system export by key.`, {});
        }
      }
      const dsVarByName = /* @__PURE__ */ new Map();
      for (const v of tokens && tokens.variables || []) if (v.name) dsVarByName.set(v.name, v);
      const sliceSources = input.sliceSources || null;
      const labels = screens.map((s) => s.label || s.doc && s.doc.screen || "screen");
      const own = screens.map((s) => s && s.vars && Array.isArray(s.vars.variables) ? s.vars.variables : null);
      let varScope = "own";
      let screenVars = [];
      if (own.length && own.every(Boolean)) {
        screenVars = [].concat(...own);
      } else if (variables && sliceSources && sliceSources.size) {
        varScope = "union-by-source";
        screenVars = (variables && variables.variables || []).filter((v) => !v.key || !sliceSources.has(v.key) || sliceSources.get(v.key).some((sc) => labels.includes(sc)));
      } else {
        varScope = "union";
        screenVars = variables && variables.variables || [];
      }
      const screenVarsByName = /* @__PURE__ */ new Map();
      for (const v of screenVars) {
        if (!v || !v.name) continue;
        if (!screenVarsByName.has(v.name)) screenVarsByName.set(v.name, []);
        const list = screenVarsByName.get(v.name);
        if (!list.some((x) => x.key && x.key === v.key || !x.key && !v.key && x.collection === v.collection)) list.push(v);
      }
      const screenVarByName = new Map([...screenVarsByName].map(([n, l]) => [n, l[0]]));
      const shortKey = (v) => v && typeof v.key === "string" && v.key ? v.key.slice(0, 8) + "\u2026" : null;
      const fromWhere = (v) => {
        const sc = v && v.key && sliceSources && sliceSources.get(v.key);
        return sc && sc.length ? ` (from ${sc.join(", ")})` : "";
      };
      function flatten(v) {
        const out = {};
        for (const [mode, val] of Object.entries(v && v.values || {})) {
          out[mode] = val && typeof val === "object" ? val.aliasOf != null ? "-> " + val.aliasOf : JSON.stringify(val) : String(val);
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
      if (tokens && screenVarByName.size) {
        const collisions = [], missing = [];
        for (const [name, list] of screenVarsByName) {
          const dv = dsVarByName.get(name);
          if (!dv) {
            let near = null;
            for (const dname of dsVarByName.keys()) if (norm(dname) === norm(name) && dname !== name) {
              near = dname;
              break;
            }
            if (usedTokenNames.has(name) || near) missing.push({ name, near });
            continue;
          }
          for (const sv of list) {
            if (sameResolution(sv, dv) === false) {
              collisions.push({ name, key: sv.key, twins: list, sv, screen: flatten(sv), designSystem: flatten(dv), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
            }
          }
        }
        const dsByNorm = /* @__PURE__ */ new Map();
        for (const [dname, dv] of dsVarByName) {
          const k = norm(dname);
          if (!dsByNorm.has(k)) dsByNorm.set(k, []);
          dsByNorm.get(k).push({ name: dname, v: dv });
        }
        for (const [name, list] of screenVarsByName) {
          if (dsVarByName.has(name)) continue;
          for (const cand of dsByNorm.get(norm(name)) || []) {
            for (const sv of list) {
              if (sameResolution(sv, cand.v) === false) {
                collisions.push({ name, key: sv.key, twins: list, sv, alsoKnownAs: cand.name, screen: flatten(sv), designSystem: flatten(cand.v), usedAt: (usedTokenNames.get(name) || []).slice(0, 3) });
              }
            }
          }
        }
        const scopeNote = varScope === "own" ? "" : varScope === "union-by-source" ? " (read from the merged variables.json, restricted to the variables its slice records for this screen \u2014 pass the screen's .vars.json to be exact)" : " (read from the MERGED variables.json: this screen's own .vars.json was not available, so this may be another screen's variable \u2014 check its key)";
        for (const c of collisions) {
          const twinNote = c.twins.length > 1 ? ` This screen's own variables include ${c.twins.length} DIFFERENT variables called '${c.name}': ` + c.twins.map((t) => `${shortKey(t) ? "key " + shortKey(t) : "'" + (t.collection || "") + "'"} = ${JSON.stringify(flatten(t))}${fromWhere(t)}`).join(" vs ") + ` \u2014 only the one(s) listed as colliding differ from the design system.` : "";
          push(
            "blocker",
            "token-name-collision",
            `'${c.name}'${shortKey(c.sv) ? ` (key ${shortKey(c.sv)})` : ""}${c.alsoKnownAs ? ` and the design system's '${c.alsoKnownAs}'` : ""} share a name but resolve DIFFERENTLY: screen ${JSON.stringify(c.screen)} vs design system ${JSON.stringify(c.designSystem)}` + (Object.keys(c.screen).some((m) => m in c.designSystem) ? ". " : " \u2014 no mode name is shared and the two value sets are disjoint. ") + `Slugging the name onto the existing token would silently apply the wrong value \u2014 namespace the screen's copy, or confirm which library is authoritative.` + twinNote + scopeNote,
            { token: c.name, key: c.key, alsoKnownAs: c.alsoKnownAs, screenValue: c.screen, designSystemValue: c.designSystem, usedAt: c.usedAt, scope: varScope }
          );
        }
        if (variables && varScope !== "union") {
          const mine = new Set(screenVars.map((v) => v.key).filter(Boolean));
          const unionByName = /* @__PURE__ */ new Map();
          for (const v of variables && variables.variables || []) {
            if (!v || !v.name || !v.key) continue;
            if (!unionByName.has(v.name)) unionByName.set(v.name, /* @__PURE__ */ new Map());
            unionByName.get(v.name).set(v.key, v);
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
              `'${name}' is ${all.length} different variables in the merged variables.json \u2014 ` + all.map((v) => `key ${shortKey(v)} = ${JSON.stringify(flatten(v))}${fromWhere(v)}`).join(" vs ") + ". " + (ours.length ? `THIS screen's own variables carry only key ${ours.map(shortKey).join(", ")}, so the ambiguity belongs to ${[...new Set(others.flatMap((v) => sliceSources && sliceSources.get(v.key) || []))].join(", ") || "another screen"} \u2014 do not change this screen's value to match it.` : `THIS screen carries none of them.`) + ` Generate this screen's theme from its own .vars.json (or design-system/tokens.json), not from the union.`,
              { token: name, keys: all.map((v) => v.key), mine: ours.map((v) => v.key) }
            );
          }
        }
        if (missing.length) {
          push(
            "warning",
            "token-absent-from-design-system",
            `${missing.length} token name(s) the screen binds do not exist in the design-system export` + (missing.some((m) => m.near) ? ` (${missing.filter((m) => m.near).length} differ from a design-system name only by case or punctuation \u2014 e.g. ` + missing.filter((m) => m.near).slice(0, 2).map((m) => `'${m.name}' vs '${m.near}'`).join(", ") + ")" : "") + `: ${missing.slice(0, 8).map((m) => "'" + m.name + "'").join(", ")}${missing.length > 8 ? ", \u2026" : ""}. Build these as literals with a recorded decision \u2014 do not invent a design-system token for them.`,
            { tokens: missing }
          );
        }
      }
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
            `${dangling.length} token name(s) are bound by a node but defined in NEITHER design/variables.json nor the design-system export: ${dangling.slice(0, 8).map((n) => "'" + n + "'").join(", ")}${dangling.length > 8 ? ", \u2026" : ""}. Re-pull the screen (variables.json now merges, so nothing is lost) or treat the node's raw value as authoritative.`,
            { tokens: dangling }
          );
        }
      }
      let rekey = null;
      const coverage = { instances: instances.length, distinct: 0, matchedByKey: 0, matchedByLocalKey: 0, matchedByName: 0, ambiguousName: 0, unmatched: 0, pct: null, localPct: null, entries: [] };
      const localComps = components && components.components || [];
      const localKeys = new Set(localComps.map((c) => c.key).filter(Boolean));
      const catalog = [].concat(localComps, componentsLibrary && componentsLibrary.components || []);
      if (!catalog.length) {
        notChecked.push("component coverage \u2014 no components.local.json was given, so every instance counts as new by default.");
      } else if (!instances.length) {
        notChecked.push("component coverage \u2014 the screen export contains no INSTANCE nodes to compare.");
      } else {
        const byKey = /* @__PURE__ */ new Map();
        const byName = /* @__PURE__ */ new Map();
        for (const c of catalog) {
          if (c.key) byKey.set(c.key, c);
          const k = norm(c.name);
          if (!byName.has(k)) byName.set(k, []);
          byName.get(k).push(c);
        }
        const distinct = /* @__PURE__ */ new Map();
        for (const i of instances) {
          const id = i.setKey || i.key || "name:" + norm(i.setName);
          if (!distinct.has(id)) distinct.set(id, Object.assign({ count: 0 }, i));
          distinct.get(id).count++;
        }
        coverage.distinct = distinct.size;
        for (const [id, i] of distinct) {
          const byKeyHit = i.setKey && byKey.get(i.setKey) || i.key && byKey.get(i.key);
          if (byKeyHit) {
            coverage.matchedByKey++;
            const local = localKeys.has(byKeyHit.key);
            if (local) coverage.matchedByLocalKey++;
            coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: "key", scope: local ? "local" : "library", verified: true, catalogName: byKeyHit.name, instances: i.count });
            continue;
          }
          const cands = byName.get(norm(i.setName)) || [];
          let best = null;
          for (const c of cands) {
            const props = Object.keys(c.props || {}).map((p) => norm(String(p).split("#")[0]));
            const want = i.propNames.map((p) => norm(String(p).split("#")[0]));
            const hit = want.filter((p) => props.includes(p)).length;
            const score = want.length ? hit / want.length : props.length ? 0 : 0.5;
            if (!best || score > best.score) best = { c, score, hit, of: want.length };
          }
          if (best && cands.length > 1) {
            coverage.ambiguousName++;
            coverage.unmatched++;
            coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, ambiguous: true, candidates: cands.length, instances: i.count });
          } else if (best && (best.score >= 0.5 || cands.length === 1)) {
            coverage.matchedByName++;
            coverage.entries.push({
              setName: i.setName,
              key: i.setKey || i.key,
              matchedBy: "name",
              verified: false,
              catalogName: best.c.name,
              catalogKey: best.c.key,
              propOverlap: `${best.hit}/${best.of}`,
              instances: i.count
            });
          } else {
            coverage.unmatched++;
            coverage.entries.push({ setName: i.setName, key: i.setKey || i.key, matchedBy: null, verified: false, instances: i.count });
          }
        }
        const matched = coverage.matchedByKey + coverage.matchedByName;
        coverage.pct = Math.round(coverage.matchedByKey / coverage.distinct * 100);
        coverage.localPct = Math.round(coverage.matchedByLocalKey / coverage.distinct * 100);
        const pctAny = Math.round(matched / coverage.distinct * 100);
        rekey = localComps.length ? matchByNameAndSignature(visible, components, componentsLibrary) : null;
        const rekeyed = !!rekey && coverage.localPct <= WRONG_CATALOG_PCT && isRekeyed(rekey);
        coverage.rekey = rekey ? Object.assign({ rekeyed }, rekey.summary) : null;
        if (rekeyed) {
          const s = rekey.summary, props = rekey.proposals;
          const residual = rekey.rows.filter((r) => !r.match);
          push(
            "blocker",
            "catalog-rekeyed",
            `0 of ${s.names} component(s) on this screen resolve to components.local.json by key, but ${s.proposed} of the ${s.withCandidates} whose NAME is in the catalog also match it by prop signature (variant axes + values, prop names + types)${s.remote ? `, and ${s.remote} of the ${s.instances} visible instance(s) say remote:true` : ""}. That is not a foreign library \u2014 it is the SAME components under new keys: one or both Figma files are duplicates (duplicating a file re-mints every component key), or the library was re-published. Proposed matches (confirm each before reuse \u2014 nothing is auto-accepted): ` + props.slice(0, 12).map((r) => `'${r.name}' \u2192 ${r.match.id}${r.evidence === "name+no-props" ? " (no props to compare \u2014 weaker)" : ""}${r.tie === "duplicate-definitions" ? " (duplicate definitions, harmless tie)" : ""}`).join(", ") + (props.length > 12 ? `, \u2026 (${props.length} in all \u2014 see componentProposals)` : "") + `. ${residual.length} name(s) have no catalog twin and stay new work` + (residual.length ? ` (${residual.slice(0, 5).map((r) => `'${r.name}'`).join(", ")}${residual.length > 5 ? ", \u2026" : ""})` : "") + `. To use them: show the user the list, set "confirmed": true on each accepted entry of componentProposals in this report's JSON, then run \`map-bootstrap.js <components.local.json> --out design/codeconnect.local.json --from-proposals <this report>.json\` \u2014 it stubs ONLY the confirmed ones, keyed by the screen's own instance key.`,
            { rekey: s, proposals: props.length }
          );
        } else if (coverage.localPct <= WRONG_CATALOG_PCT) {
          push(
            "blocker",
            "catalog-covers-nothing",
            `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) used on this screen (${coverage.localPct}%) are in components.local.json by key \u2014 the catalog you exported is not the library this screen is built from. ` + (coverage.matchedByKey > coverage.matchedByLocalKey ? `${coverage.matchedByKey - coverage.matchedByLocalKey} more match components.library.json, which only means both files consume the same third-party set. ` : "") + (coverage.matchedByName ? `${coverage.matchedByName} match BY NAME only and are marked unverified: a lead, not a mapping. ` : "") + (coverage.ambiguousName ? `${coverage.ambiguousName} more share a name with SEVERAL catalog entries ('Component 1'-class names) and are deliberately left unmatched. ` : "") + `A "318/318 mapped" count measures the catalog against itself and means nothing here. To find the owning library: open any instance in Figma and use right-click > "Go to main component" \u2014 it jumps to the file that defines it. Then connect that file and run \`dtwin pull --as-library "<name>"\`. Until then every instance is correctly a \`verdict:"new"\` build, not a port of the catalog.` + (rekey && rekey.summary.withCandidates ? ` (Checked for the duplicated-file case too: only ${rekey.summary.proposedWithSignature} of the ${rekey.summary.withCandidates} name twin(s) also agree on prop signature \u2014 too few to call it the same library under new keys.)` : ""),
            { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, ambiguousName: coverage.ambiguousName, localPct: coverage.localPct } }
          );
        } else if (coverage.localPct < 100) {
          push(
            "warning",
            "partial-catalog-coverage",
            `${coverage.matchedByLocalKey} of ${coverage.distinct} component(s) on this screen (${coverage.localPct}%) resolve to components.local.json by key` + (coverage.matchedByName ? `, ${coverage.matchedByName} more by name only (unverified)` : "") + `. The rest are new work: ${coverage.entries.filter((e) => !e.matchedBy).slice(0, 6).map((e) => "'" + e.setName + "'").join(", ")}.`,
            { coverage: { distinct: coverage.distinct, byLocalKey: coverage.matchedByLocalKey, byKey: coverage.matchedByKey, byName: coverage.matchedByName, localPct: coverage.localPct } }
          );
        } else {
          push("info", "catalog-covers-screen", `all ${coverage.distinct} component(s) on this screen resolve to components.local.json by key.`, {});
        }
        const proposedNames = new Set(coverage.rekey && coverage.rekey.rekeyed ? rekey.proposals.map((r) => r.name) : []);
        const named = coverage.entries.filter((e) => e.matchedBy === "name" && !proposedNames.has(e.setName));
        if (named.length) {
          push(
            "info",
            "name-matched-components",
            `${named.length} component(s) have no key in the catalog but DO have an exact name twin there: ` + named.slice(0, 10).map((e) => `'${e.setName}' (props ${e.propOverlap})`).join(", ") + (named.length > 10 ? `, \u2026` : "") + `. Mapped BY NAME, UNVERIFIED \u2014 confirm one with "Go to main component" before reusing any of their code; if that one instance points at the catalog's file, the rest almost certainly do too.`,
            { components: named.map((e) => ({ setName: e.setName, catalogName: e.catalogName, catalogKey: e.catalogKey, propOverlap: e.propOverlap, verified: false })) }
          );
        }
        const amb = coverage.entries.filter((e) => e.ambiguous && !proposedNames.has(e.setName));
        if (amb.length) {
          push(
            "warning",
            "ambiguous-component-name",
            `${amb.length} component(s) share their name with SEVERAL catalog entries and were left unmatched on purpose: ` + amb.slice(0, 8).map((e) => `'${e.setName}' (${e.candidates} candidates)`).join(", ") + (amb.length > 8 ? ", \u2026" : "") + `. Generic names like these are what the design system's own hygiene report flags as duplicated/unnamed \u2014 binding code to one of them by name would be a guess with a 1-in-${amb[0].candidates} chance.`,
            { components: amb.map((e) => ({ setName: e.setName, candidates: e.candidates })) }
          );
        }
      }
      if (fonts.size > 1) {
        const sorted = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
        const [mainFamily, mainCount] = sorted[0];
        const strays = sorted.slice(1);
        const total = sorted.reduce((n, [, c]) => n + c, 0);
        push(
          "warning",
          "font-family-stray",
          `${total} text node(s) use ${sorted.length} different font families: ${sorted.map(([f, c]) => `${f} (${c})`).join(", ")}. '${mainFamily}' carries ${mainCount}; the rest are strays \u2014 usually a starter-kit style (Figma's Material 3 kit leaks \`material-theme/*\`) left on a layer. Ask the designer before shipping a second webfont for ${strays.reduce((n, [, c]) => n + c, 0)} node(s).`,
          { families: sorted.map(([family, count2]) => ({ family, count: count2 })) }
        );
      }
      if (stylesText && stylesText.styles && fonts.size) {
        const dsFamilies = new Set((stylesText.styles || []).map((s) => s.font).filter(Boolean));
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
      if (stylesText && stylesText.styles && textStyles.size) {
        const dsByName = new Map((stylesText.styles || []).map((s) => [s.name, s]));
        const dsNorm = /* @__PURE__ */ new Map();
        for (const s of stylesText.styles || []) dsNorm.set(norm(s.name), s.name);
        const absent = [], nearMiss = [];
        for (const name of textStyles.keys()) {
          if (dsByName.has(name)) continue;
          const near = dsNorm.get(norm(name));
          if (near) nearMiss.push({ name, near });
          else absent.push(name);
        }
        if (nearMiss.length) {
          push(
            "blocker",
            "text-style-near-miss",
            `${nearMiss.length} text style name(s) differ from a design-system style ONLY by case or punctuation: ` + nearMiss.map((n) => `'${n.name}' vs '${n.near}'`).join(", ") + `. That is the exact near-miss a name-based mapping binds wrongly and silently. Confirm they are the same style before reusing it.`,
            { styles: nearMiss }
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
      const absurd = [];
      const seenAbsurd = /* @__PURE__ */ new Set();
      for (const v of [].concat(tokens && tokens.variables || [], variables && variables.variables || [])) {
        for (const [mode, val] of Object.entries(v && v.values || {})) {
          const n = typeof val === "number" ? val : val && typeof val === "object" && typeof val.value === "number" ? val.value : null;
          if (n == null || Math.abs(n) < ABSURD_NUMBER) continue;
          const id = `${v.collection}/${v.name}/${mode}`;
          if (seenAbsurd.has(id)) continue;
          seenAbsurd.add(id);
          absurd.push({ name: v.name, collection: v.collection, mode, value: n });
        }
      }
      if (absurd.length) {
        push(
          "warning",
          "sentinel-token-value",
          `${absurd.length} token value(s) are sentinels, not measurements: ` + absurd.slice(0, 4).map((a) => `'${a.name}' = ${a.value} (${a.mode})`).join(", ") + (absurd.length > 4 ? ", \u2026" : "") + `. Figma's "fully rounded" corner exports as a literal 1e9. Emit these as the platform's own idiom (CSS 9999px or 50%, SwiftUI .infinity, Compose CircleShape) \u2014 never as \`${absurd[0].value}px\`.`,
          { tokens: absurd }
        );
      }
      const multiModeColls = [];
      const seenColl = /* @__PURE__ */ new Set();
      for (const c of [].concat(tokens && tokens.collections || [], screenColls)) {
        if (!Array.isArray(c.modes) || c.modes.length <= 1) continue;
        if (seenColl.has(c.name)) continue;
        seenColl.add(c.name);
        multiModeColls.push(c);
      }
      for (const c of multiModeColls) {
        const seen = resolvedModes.get(c.name);
        if (!seen || !seen.size) continue;
        if (seen.size === 1 && c.modes.length > 1) {
          const only = [...seen][0];
          const rest = c.modes.filter((m) => m !== only);
          push(
            "warning",
            "single-mode-export",
            `every exported frame resolved collection '${c.name}' in mode '${only}', but it defines ${c.modes.length} modes (${c.modes.join(", ")}). The other ${rest.length} mode(s) are DERIVED from variable values, never seen rendered \u2014 so any element whose ${only}-mode token has no sensible counterpart (a dark surface token that stays dark in Light) will be mechanically correct and visually broken. Export a frame in ${rest.map((m) => `'${m}'`).join(" / ")} too, or have the designer confirm the derivation before it ships.`,
            { collection: c.name, exportedMode: only, modes: c.modes }
          );
        }
      }
      contrastPerMode(screens, variables, tokens, push, resolvedModes);
      findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
      const count = (s) => findings.filter((f) => f.severity === s).length;
      return {
        summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
        coverage,
        // The confirmation list (catalog-rekeyed). Every entry starts unconfirmed; map-bootstrap.js
        // --from-proposals stubs only the ones a person set "confirmed": true on.
        componentProposals: rekey && coverage.rekey && coverage.rekey.rekeyed ? rekey.proposals.map((r) => ({
          name: r.name,
          instances: r.instances,
          screens: r.screens,
          instanceKeys: r.instanceKeys,
          remote: r.remote,
          catalog: r.match,
          evidence: r.evidence,
          tie: r.tie || null,
          alternatives: r.alternatives,
          reasons: r.reasons,
          confirmed: false
        })) : [],
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
    function hexToRgb(hex) {
      const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || ""));
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
    }
    function relLuminance(c) {
      const ch = (v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    }
    function ratio(a, b) {
      const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    }
    var MIN_CONTRAST = 4.5;
    function contrastPerMode(screens, variables, tokens, push, resolvedModes) {
      const defs = /* @__PURE__ */ new Map();
      for (const v of tokens && tokens.variables || []) if (v.name) defs.set(v.name, v);
      for (const v of variables && variables.variables || []) if (v.name) defs.set(v.name, v);
      if (!defs.size) return;
      function resolve(name, mode, depth) {
        if (depth > 8) return null;
        const v = defs.get(name);
        if (!v || !v.values) return null;
        let val = v.values[mode];
        if (val === void 0) {
          const keys = Object.keys(v.values);
          if (keys.length !== 1) return null;
          val = v.values[keys[0]];
        }
        if (typeof val === "string") return hexToRgb(val);
        if (val && typeof val === "object" && val.aliasOf) return resolve(val.aliasOf, mode, depth + 1);
        return null;
      }
      const modes = /* @__PURE__ */ new Set();
      for (const c of [].concat(tokens && tokens.collections || [], variables && variables.collections || [])) {
        for (const m of c && c.modes || []) modes.add(m);
      }
      const rendered = /* @__PURE__ */ new Set();
      for (const set of (resolvedModes || /* @__PURE__ */ new Map()).values()) for (const m of set) rendered.add(m);
      for (const m of rendered) modes.delete(m);
      if (!modes.size) return;
      if (!rendered.size) return;
      const pairs = /* @__PURE__ */ new Map();
      for (const s of screens) {
        for (const root of rootsOf2(s.doc)) {
          walkWithBg(root, null, (n, bgToken) => {
            if (n.type !== "TEXT" || !bgToken) return;
            const fg = n.tokens && (n.tokens.fills || n.tokens.textRangeFills) || (n.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
            if (!fg || typeof fg !== "string") return;
            const key = fg + "|" + bgToken;
            if (!pairs.has(key)) pairs.set(key, { fg, bg: bgToken, nodes: [], sample: n.name });
            if (pairs.get(key).nodes.length < 4) pairs.get(key).nodes.push(n.id);
          });
        }
      }
      if (!pairs.size) return;
      const failures = [];
      for (const p of pairs.values()) {
        for (const mode of modes) {
          const fg = resolve(p.fg, mode, 0);
          const bg = resolve(p.bg, mode, 0);
          if (!fg || !bg) continue;
          const r = ratio(fg, bg);
          if (r >= MIN_CONTRAST) continue;
          failures.push({ mode, fg: p.fg, bg: p.bg, ratio: Number(r.toFixed(2)), nodes: p.nodes, sample: p.sample });
        }
      }
      if (!failures.length) return;
      const byMode = /* @__PURE__ */ new Map();
      for (const f of failures) {
        if (!byMode.has(f.mode)) byMode.set(f.mode, []);
        byMode.get(f.mode).push(f);
      }
      for (const [mode, list] of byMode) {
        push(
          "blocker",
          "derived-mode-contrast",
          `in mode '${mode}', ${list.length} text/background token pair(s) fall below WCAG AA (${MIN_CONTRAST}:1): ` + list.slice(0, 4).map((f) => `'${f.fg}' on '${f.bg}' = ${f.ratio}:1 (e.g. ${f.sample})`).join("; ") + (list.length > 4 ? ", \u2026" : "") + `. No frame was exported in '${mode}', so this mode is DERIVED from variable values and nobody has ever seen it rendered \u2014 the derivation is mechanically correct and visually broken. Export a '${mode}' frame, or get the designer to say which token each of these should use there. Do not invent an override and call it done.`,
          { mode, pairs: list }
        );
      }
    }
    function walkWithBg(node, bgToken, fn) {
      if (!node || typeof node !== "object") return;
      if (hiddenSelf(node)) return;
      let bg = bgToken;
      const own = node.tokens && node.tokens.fills || (node.fills || []).map((f) => f && f.tokens && f.tokens.color).find(Boolean);
      if (own && typeof own === "string" && node.type !== "TEXT") bg = own;
      fn(node, bg);
      for (const c of node.children || []) walkWithBg(c, bg, fn);
    }
    function toMarkdown(res) {
      const L = [];
      L.push(`# Cross-file check \u2014 ${res.inputs.screens.join(", ") || "(no screens)"}`, "");
      L.push(
        `**${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info. Every check here is a JOIN between the screen and the design system \u2014 none of it is visible from either file alone.`,
        ""
      );
      const c = res.coverage;
      if (c && c.distinct) {
        L.push("## Component coverage of THIS screen", "");
        L.push(`| | count |`, `|---|---|`);
        L.push(`| instances on the screen | ${c.instances} |`);
        L.push(`| distinct components | ${c.distinct} |`);
        L.push(`| in **components.local.json** by key (verified) | ${c.matchedByLocalKey} (${c.localPct}%) |`);
        L.push(`| in components.library.json by key (a shared third-party set) | ${c.matchedByKey - c.matchedByLocalKey} |`);
        L.push(`| by name only (**unverified**) | ${c.matchedByName} |`);
        L.push(`| name shared with several catalog entries \u2014 left unmatched | ${c.ambiguousName} |`);
        L.push(`| no match at all \u2014 new work | ${c.unmatched} |`);
        if (c.rekey) L.push(`| same NAME **and** prop signature as a catalog entry (re-keyed copy?) | ${c.rekey.proposed} of ${c.rekey.withCandidates} name twin(s) |`);
        L.push("");
      }
      if (res.componentProposals && res.componentProposals.length) {
        L.push("## Proposed component matches \u2014 confirm before reuse", "");
        L.push(
          "*Matched by name + prop signature because the keys were re-minted (a duplicated file or a re-published library).",
          'Nothing here is accepted until a person sets `"confirmed": true` on the entry in the JSON report.*',
          ""
        );
        L.push("| instance name | \xD7 | \u2192 catalog | id | page | evidence | why |", "|---|--:|---|---|---|---|---|");
        for (const p of res.componentProposals) {
          L.push(`| \`${p.name}\` | ${p.instances} | \`${p.catalog.name}\` | ${p.catalog.id} | ${p.catalog.page || ""} | ${p.evidence}${p.tie ? ` (${p.tie})` : ""} | ${p.reasons.join("; ")} |`);
        }
        L.push("");
        if (res.componentResidual && res.componentResidual.length) {
          L.push(`**Not in the catalog (${res.componentResidual.length}) \u2014 new work:** ` + res.componentResidual.map((r) => `\`${r.name}\``).join(", "), "");
        }
      }
      for (const sev of ["blocker", "warning", "info"]) {
        const fs2 = res.findings.filter((f) => f.severity === sev);
        if (!fs2.length) continue;
        L.push(`## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs2.length})`, "");
        for (const f of fs2) L.push(`- \`${f.code}\` ${f.message}`);
        L.push("");
      }
      if (res.notChecked.length) {
        L.push("## Not checked", "", "*These are gaps in the INPUT, not clean results:*", "");
        for (const n of res.notChecked) L.push(`- ${n}`);
        L.push("");
      }
      return L.join("\n") + "\n";
    }
    module2.exports = { crossCheck, toMarkdown, ABSURD_NUMBER, WRONG_CATALOG_PCT };
    if (require.main === module2) {
      const fs2 = require("fs");
      const path2 = require("path");
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
      const dsDir = take("--design-system");
      const varsFile = take("--variables");
      const out = take("--out");
      const jsonOnly = strip("--json"), gate = strip("--gate");
      const USAGE2 = "usage: node design-to-code/cross-check.js <screen.json>... [--design-system design/design-system] [--variables design/variables.json] [--out design/audit/<screen>.cross] [--json] [--gate]";
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE2);
        process.exit(0);
      }
      const stray = argv.filter((a) => a.startsWith("-"));
      if (stray.length || !argv.length) {
        console.error((stray.length ? `cross-check: unknown flag ${stray.join(", ")}
` : "") + USAGE2);
        process.exit(2);
      }
      const maybe = (f) => f && fs2.existsSync(f) ? JSON.parse(fs2.readFileSync(f, "utf8")) : null;
      const screens = argv.map((f) => ({
        doc: readJsonFile(f, "screen export"),
        label: path2.basename(f, ".json"),
        vars: maybe(f.replace(/\.json$/, ".vars.json"))
      }));
      const dsBase = dsDir || "design/design-system";
      const exportRoot = path2.resolve(path2.dirname(argv[0]), "..", "..");
      const exportRootVarsPath = path2.join(exportRoot, "variables.json");
      const siblingVarsPath = path2.join(path2.dirname(argv[0]), "variables.json");
      let variablesPath = varsFile;
      if (!variablesPath && fs2.existsSync(exportRootVarsPath)) variablesPath = exportRootVarsPath;
      if (!variablesPath && fs2.existsSync(siblingVarsPath)) variablesPath = siblingVarsPath;
      const variablesDoc = maybe(variablesPath);
      if (variablesPath) console.error(`variables: ${variablesPath}`);
      const staleLegacyVars = path2.join(exportRoot, "..", "variables.json");
      if (fs2.existsSync(staleLegacyVars) && path2.resolve(staleLegacyVars) !== path2.resolve(variablesPath || "")) {
        console.error(`warn  ${staleLegacyVars} also exists and was NOT used (stale sibling of design/export/) \u2014 remove it or re-pull into design/export/.`);
      }
      const res = crossCheck({
        screens,
        sliceSources: variablesDoc ? require_slice_sources().sourcesOf(variablesDoc, variablesPath, fs2, path2) : null,
        variables: variablesDoc,
        variablesPath,
        tokens: maybe(path2.join(dsBase, "tokens.json")),
        components: maybe(path2.join(dsBase, "components.local.json")),
        componentsLibrary: maybe(path2.join(dsBase, "components.library.json")),
        stylesText: maybe(path2.join(dsBase, "styles.text.json"))
      });
      if (jsonOnly) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else if (out) {
        fs2.mkdirSync(path2.dirname(out), { recursive: true });
        fs2.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
        fs2.writeFileSync(out + ".md", toMarkdown(res));
        console.error(`wrote ${out}.json and ${out}.md`);
      } else {
        process.stdout.write(toMarkdown(res));
      }
      console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
      for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
      process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
    }
  }
});

// design-to-code/audit.js
var require_audit = __commonJS({
  "design-to-code/audit.js"(exports2, module2) {
    var { isHidden, hiddenSelf } = require_hidden();
    var SEVERITY_ORDER = { blocker: 0, warning: 1, info: 2 };
    var omit = (o, keys) => {
      const out = {};
      for (const k of Object.keys(o)) if (!keys.includes(k)) out[k] = o[k];
      return out;
    };
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
    function rootsOf2(doc, label) {
      if (!doc || typeof doc !== "object") return [];
      if (Array.isArray(doc)) return doc.flatMap((d, i) => rootsOf2(d, `${label}[${i}]`));
      if (Array.isArray(doc.nodes)) return doc.nodes.map((n) => ({ tree: n, label: doc.screen || n.name || label, manifest: doc.manifest }));
      if (doc.tree && typeof doc.tree === "object") return [{ tree: doc.tree, label: doc.tree.name || label, manifest: doc.manifest }];
      if (doc.type && doc.id) return [{ tree: doc, label: doc.name || label, manifest: doc.manifest }];
      return [];
    }
    var r1 = (v) => Math.round(v * 100) / 100;
    var hasTok = (node, ...keys) => !!(node.tokens && keys.some((k) => node.tokens[k] != null));
    function audit(input, opts = {}) {
      const platformAssumed = !PLATFORMS.includes(opts.platform);
      const platform = platformAssumed ? "web" : opts.platform;
      const gridAssumed = !(opts.grid > 0);
      const grid = gridAssumed ? 4 : opts.grid;
      let gridMismatch = null;
      if (gridAssumed) {
        const dsTokens = opts.designSystem && opts.designSystem.tokens;
        const spacingValues = [];
        for (const c of dsTokens && dsTokens.collections || []) {
          if (!/spac|space/i.test(c.name || "")) continue;
          for (const v of c.variables || []) {
            for (const mv of Object.values(v.valuesByMode || v.values || {})) {
              const n = typeof mv === "number" ? mv : typeof mv === "string" && /^-?\d+(\.\d+)?$/.test(mv) ? Number(mv) : null;
              if (n !== null && Number.isFinite(n) && n > 0) spacingValues.push(Math.abs(n));
            }
          }
        }
        if (spacingValues.length >= 2) {
          const gcd2 = (a, b) => b === 0 ? a : gcd2(b, a % b);
          const step = spacingValues.map(Math.round).reduce((a, b) => gcd2(a, b));
          if (step > 0 && step !== grid) gridMismatch = step;
        }
      }
      const docs = Array.isArray(input) ? input : [input];
      const roots = docs.flatMap((d, i) => rootsOf2(d && d.doc !== void 0 ? d.doc : d, d && d.label || `input${i}`));
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
      const hiddenIds = /* @__PURE__ */ new Set();
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
        const path2 = [...ancestors.map((a) => a.name), node.name].join(" > ");
        const here = { label: ctx.label, path: path2 };
        const hiddenBranch = isHidden(node, ancestors.some((a) => hiddenSelf(a)));
        if (Array.isArray(node.annotations)) for (const a of node.annotations) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: a.label || a.markdown });
        if (node.devStatusNote) annotations.push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, label: `dev note: ${node.devStatusNote}` });
        for (const [state, re] of Object.entries(STATE_WORDS)) {
          if (re.test(node.name || "") || node.type === "TEXT" && ancestors.length <= 6 && re.test(node.text || "")) {
            stateHits[state].push({ nodeId: node.id, nodeName: node.name, screen: ctx.label, hidden: !!hiddenBranch });
          }
        }
        if (hiddenBranch) {
          if (node.id) hiddenIds.add(node.id);
          const self = { name: node.name, hidden: true, fills: [], __tappable: false, __beneath: [] };
          for (const child of Array.isArray(node.children) ? node.children : []) walk(child, [...ancestors, self], ctx);
          return;
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
        if (node.layout && Array.isArray(node.layout.padding) && node.layout.padding.length === 4 && node.box && Array.isArray(node.children) && node.children.length) {
          const [padTop, , padBottom] = node.layout.padding;
          const kids = node.children.filter((c) => c && c.box && typeof c.box.h === "number");
          if (kids.length === node.children.length && kids.length) {
            const direction = node.layout.flexDirection || (node.layout.display === "flex" ? "row" : null);
            const gap = typeof node.layout.gap === "number" ? node.layout.gap : 0;
            let expectedH = null;
            if (direction === "row") expectedH = padTop + padBottom + Math.max(...kids.map((c) => c.box.h));
            else if (direction === "column") expectedH = padTop + padBottom + kids.reduce((s, c) => s + c.box.h, 0) + gap * (kids.length - 1);
            const heightMode = node.heightMode || "fixed";
            const delta = expectedH === null ? 0 : expectedH - node.box.h;
            const overflow = expectedH !== null && delta > 1;
            const hugMismatch = expectedH !== null && heightMode === "hug" && Math.abs(delta) > 1;
            if (overflow || hugMismatch) {
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
      const screenStatesScope = { rootsAudited: roots.length, singleFrame: roots.length === 1 };
      const tokenBinding = {};
      for (const [k, [b, t]] of Object.entries(binding)) tokenBinding[k] = { bound: b, total: t, pct: t ? Math.round(b / t * 100) : null };
      for (const [k, v] of Object.entries(tokenBinding)) {
        if (v.total >= 5 && v.pct < 50) add("warning", "low-token-binding", `only ${v.pct}% of ${k} values are bound to tokens/styles (${v.bound}/${v.total}) \u2014 expect to carry raw values through EXACTLY and report each as unbound; do not snap them to the nearest token`, null, null, { category: k });
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
      let crossFile = null;
      let hiddenFindingsOmitted = 0;
      if (opts.designSystem || opts.variables) {
        const { crossCheck } = require_cross_check();
        crossFile = crossCheck({
          screens: docs.map((d, i) => ({ doc: d && d.doc !== void 0 ? d.doc : d, label: d && d.label || `input${i}` })),
          variables: opts.variables || null,
          tokens: opts.designSystem && opts.designSystem.tokens || null,
          components: opts.designSystem && opts.designSystem.components || opts.catalog || null,
          componentsLibrary: opts.designSystem && opts.designSystem.componentsLibrary || null,
          stylesText: opts.designSystem && opts.designSystem.stylesText || null
        });
        for (const f of crossFile.findings) {
          if (f.severity === "info") continue;
          if (f.nodeId && hiddenIds.has(f.nodeId)) {
            hiddenFindingsOmitted++;
            continue;
          }
          findings.push(Object.assign({ severity: f.severity, code: f.code, message: f.message, crossFile: true }, omit(f, ["severity", "code", "message"])));
        }
      } else {
        crossFile = {
          summary: { blockers: 0, warnings: 0, info: 0 },
          findings: [],
          coverage: null,
          notChecked: [
            `the whole cross-FILE pass \u2014 no design system was given. Every token-binding percentage below means "resolves to some variable in this screen's own file", NOT "matches your design system". Re-run with --design-system design/design-system to tell the two apart.`
          ],
          inputs: {}
        };
      }
      findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
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
        summary: { blockers: count("blocker"), warnings: count("warning"), info: count("info") },
        hiddenLayers: { nodesSkipped: hiddenIds.size, crossFileFindingsOmitted: hiddenFindingsOmitted },
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
      const gridNote = res.gridAssumed ? res.gridMismatch ? ` *(DEFAULT \u2014 not given; this system's own spacing tokens step by ${res.gridMismatch}px, not ${res.grid}px \u2014 pass \`--grid ${res.gridMismatch}\`)*` : " *(default \u2014 not given)*" : "";
      L.push(`Platform: **${res.platform}**${res.platformAssumed ? " *(ASSUMED \u2014 not given)*" : ""} \xB7 grid ${res.grid}px${gridNote} \xB7 **${res.summary.blockers} blocker(s)**, ${res.summary.warnings} warning(s), ${res.summary.info} info`, "");
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
            `**${c.matchedByLocalKey}/${c.distinct} (${c.localPct}%)** of the components on this screen resolve to \`components.local.json\` **by key**` + (c.matchedByName ? `; ${c.matchedByName} more match by NAME only and are unverified` : "") + (c.ambiguousName ? `; ${c.ambiguousName} share a name with several catalog entries and were left unmatched` : "") + ".",
            ""
          );
          if (c.rekey && c.rekey.rekeyed) {
            L.push(
              `**This is the re-keyed-copy case, not a foreign library:** ${c.rekey.proposed} of the ${c.rekey.withCandidates} component(s) whose name is in the catalog also match it by prop signature. The proposed matches are listed under \`crossFile.componentProposals\` \u2014 confirm them with the user, then \`map-bootstrap.js \u2026 --from-proposals\` stubs exactly those.`,
              ""
            );
          }
        }
        const cfBlock = cf.findings.filter((f) => f.severity !== "info");
        if (cfBlock.length) {
          for (const f of cfBlock) L.push(`- **${f.severity}** \`${f.code}\` ${f.message}`);
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
      } else if (scope.rootsAudited > 1) {
        L.push(`*Scope: ${scope.rootsAudited} frames audited \u2014 "not found" means none of them drew it.*`, "");
      }
      for (const [k, v] of Object.entries(res.screenStates)) {
        L.push(`- ${k}: ${v === "designed" ? "designed" : scope.singleFrame ? "**not in this frame \u2014 ask**" : "**not found \u2014 ask**"}`);
      }
      if (res.components.length) {
        L.push("", "## Component states", "", "| Component | Kind | Present | Missing |", "|---|---|---|---|");
        for (const c of res.components) L.push(`| ${c.name} | ${c.kind} | ${c.present.join(", ") || "\u2013"} | ${c.known ? c.missing.join(", ") || "none" : c.note}${c.sampled ? " (sampled)" : ""} |`);
      }
      for (const sev of ["blocker", "warning", "info"]) {
        const fs2 = res.findings.filter((f) => f.severity === sev);
        if (!fs2.length) continue;
        L.push("", `## ${sev === "blocker" ? "Blockers" : sev === "warning" ? "Warnings" : "Info"} (${fs2.length})`, "");
        for (const f of fs2) L.push(`- \`${f.code}\` ${f.message}${f.nodeId ? ` \u2014 node \`${f.nodeId}\`${f.screen ? ` in ${f.screen}` : ""}` : ""}`);
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
      const findings = auditDoc && Array.isArray(auditDoc.findings) ? auditDoc.findings : [];
      return findings.filter((f) => f && f.severity === "blocker").map((f, i) => `${f.code || "blocker"}#${i}`);
    }
    module2.exports = { audit, toMarkdown, contrastRatio, parseHex, deltaE, controlKind, TOUCH_MIN, blockerIds };
    if (require.main === module2) {
      const fs2 = require("fs");
      const path2 = require("path");
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
      const dsDir = take("--design-system");
      const varsFile = take("--variables");
      const gridArg = take("--grid");
      const out = take("--out");
      const strip = (flag) => {
        const i = argv.indexOf(flag);
        if (i === -1) return false;
        argv.splice(i, 1);
        return true;
      };
      const jsonOnly = strip("--json"), gate = strip("--gate");
      const USAGE2 = `usage: node design-to-code/audit.js <screen.json>... [--platform web|ios|android|react-native|flutter]
       [--design-system design/design-system] [--variables design/variables.json]
       [--catalog components.local.json] [--grid 4] [--out design/audit] [--json] [--gate]
  --design-system turns on the cross-FILE pass (does this screen come from that design system?).
  Without it every token-binding % below means "binds SOME variable", not "matches your design system".
  --out defaults to design/audit/<input file's own basename> \u2014 the same <LayerName>__<node-id>
  name write-out.js gave the screen file, so re-auditing the same screen always lands on the same
  report pair instead of a new name each run.`;
      if (argv.includes("--help") || argv.includes("-h")) {
        console.log(USAGE2);
        process.exit(0);
      }
      const stray = argv.filter((a) => a.startsWith("-"));
      if (stray.length || !argv.length) {
        console.error((stray.length ? `audit: unknown flag ${stray.join(", ")}
` : "") + USAGE2);
        process.exit(2);
      }
      if (platform && !PLATFORMS.includes(platform)) {
        console.error(`--platform must be one of ${PLATFORMS.join(", ")}`);
        process.exit(2);
      }
      const { readJsonFile } = require_catalog_input();
      const read = (f, what) => readJsonFile(f, what);
      const inputs = argv.map((f) => ({ doc: read(f, "screen export"), label: path2.basename(f, ".json") }));
      const catalog = catalogFile ? read(catalogFile, "component catalog") : void 0;
      const maybe = (f) => f && fs2.existsSync(f) ? JSON.parse(fs2.readFileSync(f, "utf8")) : null;
      const designSystem = dsDir ? {
        tokens: maybe(path2.join(dsDir, "tokens.json")),
        components: maybe(path2.join(dsDir, "components.local.json")) || catalog,
        componentsLibrary: maybe(path2.join(dsDir, "components.library.json")),
        stylesText: maybe(path2.join(dsDir, "styles.text.json"))
      } : void 0;
      const exportRoot = path2.resolve(path2.dirname(argv[0]), "..", "..");
      const variables = maybe(varsFile) || maybe(path2.join(exportRoot, "variables.json")) || maybe(argv[0].replace(/\.json$/, ".vars.json")) || maybe(path2.join(path2.dirname(argv[0]), "variables.json"));
      const res = audit(inputs, { platform, catalog, designSystem, variables, grid: gridArg ? Number(gridArg) : void 0 });
      const md = jsonOnly ? "" : toMarkdown(res);
      const outBase = out || (argv[0] ? path2.join("design", "audit", path2.basename(argv[0], ".json")) : void 0);
      if (jsonOnly) {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      } else if (outBase) {
        fs2.mkdirSync(path2.dirname(outBase), { recursive: true });
        fs2.writeFileSync(outBase + ".json", JSON.stringify(res, null, 2) + "\n");
        fs2.writeFileSync(outBase + ".md", md);
        console.error(`wrote ${outBase}.json and ${outBase}.md`);
      } else {
        process.stdout.write(md);
      }
      if (res.platformAssumed) console.error("warn  no --platform given \u2014 assumed 'web'. Touch targets, shadow spread and blur support differ per platform; pass --platform or write design/target.json.");
      if (!jsonOnly) console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
      for (const n of res.crossFile && res.crossFile.notChecked || []) console.error(`note  not checked: ${n}`);
      process.exit(gate && res.summary.blockers > 0 ? 1 : 0);
    }
  }
});

// design-to-code/audit-gate.js
var require_audit_gate = __commonJS({
  "design-to-code/audit-gate.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var { blockerIds } = require_audit();
    function slug2(s) {
      return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    }
    function locateAuditFile(cwd, screenFile, screenName) {
      const dir = path2.join(cwd, "design", "audit");
      if (!fs2.existsSync(dir)) return null;
      const base = screenFile ? path2.basename(screenFile, ".json") : null;
      const candidates = [];
      if (base) candidates.push(path2.join(dir, base + ".json"));
      let entries = [];
      try {
        entries = fs2.readdirSync(dir).filter((f) => f.endsWith(".json"));
      } catch {
        entries = [];
      }
      for (const c of candidates) if (fs2.existsSync(c)) return path2.relative(cwd, c).split(path2.sep).join("/");
      const wantSlug = slug2(screenName);
      if (wantSlug) {
        const hit = entries.find((f) => slug2(f.replace(/\.json$/, "")) === wantSlug || slug2(f.replace(/\.json$/, "")).startsWith(wantSlug) || wantSlug.startsWith(slug2(f.replace(/\.json$/, ""))));
        if (hit) return path2.relative(cwd, path2.join(dir, hit)).split(path2.sep).join("/");
      }
      return null;
    }
    function auditGateStatus(cwd, screenFile, screenName) {
      const rel = locateAuditFile(cwd, screenFile, screenName);
      if (!rel) return { auditFile: null, blockers: [] };
      let doc;
      try {
        doc = JSON.parse(fs2.readFileSync(path2.join(cwd, rel), "utf8"));
      } catch {
        return { auditFile: rel, blockers: [], unreadable: true };
      }
      return { auditFile: rel, blockers: blockerIds(doc), doc };
    }
    module2.exports = { locateAuditFile, auditGateStatus, blockerIds, slug: slug2 };
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
      const screenName = String(title || doc.screen || root.name || "").trim() || null;
      let auditGate = null;
      try {
        const { auditGateStatus } = require_audit_gate();
        const g = auditGateStatus(cwd || process.cwd(), screenFile, screenName);
        if (g.auditFile && g.blockers.length) {
          auditGate = { auditFile: g.auditFile, verdict: "blocked", blockers: g.blockers, overridden: [], reason: null, decidedBy: null, decidedAt: null };
        }
      } catch {
      }
      return {
        schema: "designtwin/plan@2",
        screen: screenFile ? path2.basename(screenFile).replace(/\.json$/, "") : null,
        screenName,
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
        // Never clear a decided auditGate; only fill one in if the plan never had one.
        auditGate: prev.auditGate && typeof prev.auditGate === "object" ? prev.auditGate : fresh.auditGate,
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

// design-to-code/content-hash.js
var require_content_hash = __commonJS({
  "design-to-code/content-hash.js"(exports2, module2) {
    var fs2 = require("fs");
    var path2 = require("path");
    var crypto2 = require("crypto");
    var sha256 = (s) => crypto2.createHash("sha256").update(s).digest("hex");
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
    function exportContentSha256(docs) {
      const list = Array.isArray(docs) ? docs : [docs];
      return sha256(JSON.stringify(list.map((d) => stripPullTimes(d))));
    }
    function fileHashes2(files, cwd) {
      const out = {};
      for (const rel of Array.isArray(files) ? files.map(String) : []) {
        try {
          out[rel] = sha256(fs2.readFileSync(path2.join(cwd, rel))).slice(0, 16);
        } catch {
          out[rel] = null;
        }
      }
      return out;
    }
    function gitHead(cwd) {
      try {
        const r = require("child_process").spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
        const h = r.status === 0 && String(r.stdout || "").trim();
        return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
      } catch {
        return null;
      }
    }
    module2.exports = { stripPullTimes, exportContentSha256, fileHashes: fileHashes2, gitHead };
  }
});

// design-to-code/verify-build.js
var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { visibility, rootsOf } = require_plan_skeleton();
var contentHash = require_content_hash();
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
var REPORT_SCHEMA_V2 = "designtwin/verify-report@2";
var LIFECYCLE = /* @__PURE__ */ new Set(["pending", "awaiting-user", "abandoned"]);
var COMPUTED_STORED = /* @__PURE__ */ new Set(["verified", "static-only"]);
var lifecycleOf = (plan) => {
  const s = String(plan && plan.status || "pending").trim().toLowerCase();
  return LIFECYCLE.has(s) ? s : "pending";
};
var sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
function fileHashes(plan, cwd) {
  return contentHash.fileHashes(plan && plan.files, cwd);
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
    const where = code.filter((f) => f.text.includes(lit) && !allowedFiles.includes(f.rel) && !f.text.split("\n").filter((l) => l.includes(lit)).every((l) => e.tokens.some((t) => declaresToken(l, lit, t)))).map((f) => f.rel);
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
  warnings.push(...auditGateWarnings(plan, cwd, exp));
  return { blocking, warnings };
}
function auditGateWarnings(plan, cwd, exp) {
  let auditGateStatus;
  try {
    ({ auditGateStatus } = require_audit_gate());
  } catch {
    return [];
  }
  const screenFile = plan.file ? path.resolve(cwd, plan.file) : null;
  const screenName = plan.screenName || exp && exp.layerName || null;
  let g;
  try {
    g = auditGateStatus(cwd, screenFile, screenName);
  } catch {
    return [];
  }
  if (!g || !g.auditFile || !g.blockers || !g.blockers.length) return [];
  const gate = plan.auditGate;
  if (!gate || typeof gate !== "object") {
    return [`${g.auditFile} is Blocked (${g.blockers.length} blocker(s): ${g.blockers.join(", ")}) and this plan has no \`auditGate\` \u2014 either resolve the blocker(s) or record {auditGate:{auditFile,verdict,overridden:[...],reason,decidedBy,decidedAt}} naming which one(s) were acknowledged and why`];
  }
  const overridden = new Set(Array.isArray(gate.overridden) ? gate.overridden : []);
  const uncovered = g.blockers.filter((id) => !overridden.has(id));
  if (uncovered.length) return [`${g.auditFile} has ${uncovered.length} blocker(s) not listed in this plan's auditGate.overridden: ${uncovered.join(", ")} \u2014 either resolve them or add them with a reason`];
  if (!gate.reason) return [`this plan's auditGate overrides ${overridden.size} blocker(s) but gives no \`reason\` \u2014 say why it is safe to build past ${g.auditFile}`];
  return [];
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
      exportContentSha256: r.inputs && r.inputs.exportContentSha256 || null,
      code: r.inputs && r.inputs.code || null,
      expectationChanged,
      expectationRel: expectationChanged ? path.relative(cwd, expFile).split(path.sep).join("/") : null
    });
  }
  return out;
}
function reportVerdict(plan, cwd, exp, reports) {
  const mode = plan.verification && plan.verification.mode;
  if (!reports.length) {
    if (mode === "static-only") return { status: "static-only", reasons: [`built and checked statically \u2014 not rendered (${plan.verification.reason || "no reason recorded"})`] };
    return { status: "unverified", reasons: [`no verify report found for this screen in design/verify/ \u2014 run verify-screen.js --expect/--compare (the report's verdict is what grants "verified")`] };
  }
  const legacy = reports.filter((r) => r.schema !== REPORT_SCHEMA_V2);
  if (legacy.length) return { status: "unverified", reasons: legacy.map((r) => `${r.rel} is ${r.schema || "an unversioned report"} (its verdict: ${JSON.stringify(r.verdict)}) \u2014 it predates ${REPORT_SCHEMA_V2}, whose counts exclude hidden layers, so its verdict and figures are not reliable. Regenerate it: verify-screen.js --expect, then --compare`) };
  const said = (r) => `${r.rel} says verdict ${JSON.stringify(r.verdict)}${r.headline ? ` (${r.headline})` : r.why.length ? `: ${r.why.join("; ")}` : ""}`;
  const failing = reports.filter((r) => r.verdict === "fail");
  if (failing.length) return { status: "failed", reasons: failing.map(said) };
  const notPass = reports.filter((r) => r.verdict !== "pass");
  if (notPass.length) return { status: "unverified", reasons: notPass.map(said) };
  const expSha = exp && exp.doc ? contentHash.exportContentSha256(exp.doc) : null;
  for (const r of reports) {
    if (!r.exportContentSha256) {
      if (r.expectationChanged) return { status: "unverified", reasons: [`${r.rel} was computed against a different ${r.expectationRel} than the one on disk (inputs.expectationSha256 no longer matches) \u2014 re-run --compare`] };
      return { status: "unverified", reasons: [`${r.rel} does not record the content hash of the export it measured (inputs.exportContentSha256) \u2014 re-run verify-screen.js --expect and --compare`] };
    }
    if (!expSha) return { status: "unverified", reasons: [`cannot find this plan's screen export to compare with ${r.rel}'s inputs.exportContentSha256 \u2014 give the plan its \`file\` header`] };
    if (r.exportContentSha256 !== expSha) return { status: "unverified", reasons: [`the design changed since ${r.rel} was computed (export content sha256 ${r.exportContentSha256.slice(0, 12)}\u2026 \u2192 ${expSha.slice(0, 12)}\u2026, timestamps ignored) \u2014 re-run --expect and --compare`] };
    const measured = r.code && r.code.files && typeof r.code.files === "object" ? r.code.files : null;
    if (!measured) return { status: "unverified", reasons: [`${r.rel} does not record which code it measured (inputs.code) \u2014 re-run verify-screen.js --compare from the project root, where design/plan/ lists this screen's files`] };
    const now = fileHashes(plan, cwd);
    const differ = Object.keys(now).filter((f) => measured[f] !== now[f]);
    if (differ.length) return { status: "unverified", reasons: [`${r.rel} measured different code \u2014 changed since: ${differ.slice(0, 6).join(", ")}${differ.length > 6 ? `, +${differ.length - 6} more` : ""} \u2014 re-run --compare`] };
  }
  const head = reports.map((r) => r.code && r.code.gitHead).find(Boolean);
  return { status: "verified", reasons: [`${reports.map((r) => r.rel).join(", ")} says pass and measured this design and exactly these files (by content)${head ? ` \u2014 at git ${head.slice(0, 12)}` : ""}`] };
}
function computeStatus(plan, opts) {
  const o = opts || {};
  const cwd = o.cwd || (o.planFile ? rootOfPlan(o.planFile) : process.cwd());
  const notes = [];
  const stored = String(plan && plan.status || "").trim().toLowerCase();
  if (COMPUTED_STORED.has(stored)) notes.push(`the stored "status": "${plan.status}" was not confirmed by the current hook and is ignored \u2014 status is computed, never stored`);
  const life = lifecycleOf(plan);
  if (life !== "pending") return { status: life, reasons: [life === "abandoned" ? 'retired by hand ("status": "abandoned")' : 'paused on a question for the user ("status": "awaiting-user")'], reports: [] };
  const exp = o.export === void 0 ? locateExport(plan, o.planFile, cwd) : o.export;
  const reports = o.reports || locateReports(plan, o.planFile, cwd, exp);
  const rv = reportVerdict(plan, cwd, exp, reports);
  const hook = plan.verification && plan.verification.hook;
  let hookState = null, hookWhy = [];
  if (!hook || !hook.result) {
    hookState = "pending";
    hookWhy = ["the build-screen Stop hook has not checked this plan"];
  } else if (hook.planHash && hook.planHash !== planHash(plan)) {
    hookState = "pending";
    hookWhy = ["the plan changed after the hook's last check"];
  } else if (hook.result !== "pass") {
    hookState = "blocked";
    hookWhy = hook.blocking && hook.blocking.length ? hook.blocking : ["the hook's last check blocked"];
  } else {
    const ch = changedFiles(plan, cwd) || [];
    if (ch.length) {
      hookState = "stale";
      hookWhy = [`file(s) changed since the hook passed: ${ch.slice(0, 6).join(", ")}${ch.length > 6 ? `, +${ch.length - 6} more` : ""}`];
    }
  }
  const reportWhy = rv.reasons.map((r) => (hookState ? "report: " : "") + r);
  if (rv.status === "failed") return { status: "failed", reasons: notes.concat(reportWhy, hookWhy.map((h) => "hook: " + h)), reports };
  if (hookState) return { status: hookState, reasons: notes.concat(hookWhy, reportWhy), reports };
  return { status: rv.status, reasons: notes.concat(rv.status === "verified" ? ["hook passed; " + rv.reasons[0]] : rv.reasons), reports };
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
  "--status computes the status from that, the file hashes, and design/verify/<\u2026>.report.json. First match wins:",
  "  1. abandoned | awaiting-user  set by a person in plan.status; nothing else is evaluated",
  "  2. failed       a verify-report@2 for this screen says fail (never hidden behind the hook's state)",
  "  3. blocked      the Stop hook's last check blocked",
  "  4. stale        a file in files[] changed (by content) since the hook passed",
  "  5. pending      the hook has not checked this version of the plan",
  "  6. unverified | static-only | verified   what the report says: verified only for an @2 'pass' that",
  "     measured this design and these files, by content hash (no report / a pre-@2 report / other",
  '     design or code -> unverified). A stored "verified" is ignored.',
  "Every non-verified status carries a non-empty why: the hook's state AND what the report says (a",
  "report too old to trust is named with its schema). --json prints {plan, status, why, reasons, reports}."
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
    if (json) console.log(JSON.stringify(rows.map((r) => ({ plan: r.plan, status: r.status, why: r.reasons.join(" \xB7 ") || null, reasons: r.reasons, reports: r.reports.map((x) => ({ file: x.rel, verdict: x.verdict, matchedBy: x.matchedBy })) })), null, 2));
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
  auditGateWarnings,
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
