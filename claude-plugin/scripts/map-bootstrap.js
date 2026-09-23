// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// design-to-code/kinds.js
var require_kinds = __commonJS({
  "design-to-code/kinds.js"(exports2, module2) {
    var TYPE_TO_KIND = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance" };
    module2.exports = { TYPE_TO_KIND };
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
    var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull --design-system` to create it.";
    module2.exports = { assertNotManifest, isManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT };
  }
});

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

// design-to-code/map-bootstrap.js
var { TYPE_TO_KIND: KIND } = require_kinds();
var clone = (o) => JSON.parse(JSON.stringify(o));
var words = (name) => String(name || "").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
function pascal(name) {
  const p = words(name).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "Component";
}
function camel(name) {
  const base = String(name || "").split("/").pop() || "";
  const p = words(base).map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "prop";
}
function propEntry(name, def) {
  const kind = KIND[def.type];
  if (kind === "enum") {
    const values = {};
    for (const opt of def.options || []) values[opt] = opt;
    const p = { kind, codeProp: camel(name), values };
    if (typeof def.default === "string" || typeof def.default === "number" || typeof def.default === "boolean") {
      p.default = def.default;
      p.omitDefault = true;
    }
    return p;
  }
  if (kind === "boolean") {
    const p = { kind, codeProp: camel(name) };
    if (def.default !== void 0) {
      p.default = !!def.default;
      p.omitDefault = true;
    }
    return p;
  }
  if (kind === "string") return { kind, codeProp: /label|text|title/i.test(name) ? "children" : camel(name) };
  if (kind === "instance") return { kind, slot: camel(name) };
  return null;
}
function freshEntry(c) {
  const figma = { name: c.name || c.key || c.id || "Unnamed" };
  if (c.key) figma.key = c.key;
  else figma.unstable = true;
  if (c.id) figma.id = c.id;
  const entry = { figma, code: { module: "TODO: import path", export: pascal(c.name || "Component") }, status: "needs-review" };
  const props = {};
  for (const pn of Object.keys(c.props || {})) {
    const pe = propEntry(pn, c.props[pn]);
    if (pe) props[pn] = pe;
  }
  if (Object.keys(props).length) entry.props = props;
  return entry;
}
function bootstrap(catalog, existing) {
  const out = { version: 1, components: /* @__PURE__ */ Object.create(null) };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev = existing && existing.components || {};
  const prevByIdent = /* @__PURE__ */ new Map();
  for (const pk of Object.keys(prev)) {
    if (!prevByIdent.has(pk)) prevByIdent.set(pk, pk);
    const pf = prev[pk].figma || {};
    if (pf.key && !prevByIdent.has(pf.key)) prevByIdent.set(pf.key, pk);
    if (pf.id && !prevByIdent.has(pf.id)) prevByIdent.set(pf.id, pk);
  }
  const usedPrev = /* @__PURE__ */ new Set();
  for (const c of catalog && catalog.components || []) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    const id = c.key || c.id;
    if (!id) continue;
    const matchKey = [c.key, c.id, id].find((x) => x && prevByIdent.has(x));
    const prevKey = matchKey ? prevByIdent.get(matchKey) : null;
    const prevEntry = prevKey ? prev[prevKey] : null;
    if (prevEntry) {
      usedPrev.add(prevKey);
      const entry = clone(prevEntry);
      entry.figma = Object.assign({}, entry.figma, { name: c.name || entry.figma && entry.figma.name || "Unnamed" });
      if (c.id) entry.figma.id = c.id;
      if (c.key) entry.figma.key = c.key;
      else if (!entry.figma.key) entry.figma.unstable = true;
      entry.props = entry.props || {};
      for (const pn of Object.keys(c.props || {})) {
        const cdef = c.props[pn], kind = KIND[cdef.type], ex = entry.props[pn];
        if (!ex || kind && ex.kind && ex.kind !== kind) {
          const pe = propEntry(pn, cdef);
          if (pe) entry.props[pn] = pe;
        }
      }
      if (!Object.keys(entry.props).length) delete entry.props;
      out.components[prevKey !== c.key && prevKey !== c.id ? prevKey : id] = entry;
    } else {
      out.components[id] = freshEntry(c);
    }
  }
  for (const pk of Object.keys(prev)) if (!usedPrev.has(pk) && !(pk in out.components)) out.components[pk] = clone(prev[pk]);
  return out;
}
function bootstrapFromProposals(proposals, catalog, existing) {
  const out = { version: 1, components: /* @__PURE__ */ Object.create(null) };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev = existing && existing.components || {};
  for (const pk of Object.keys(prev)) out.components[pk] = clone(prev[pk]);
  const comps = catalog && catalog.components || [];
  const report = { confirmed: 0, added: 0, kept: 0, skipped: [] };
  for (const p of proposals || []) {
    if (!p || p.confirmed !== true) continue;
    report.confirmed++;
    const want = p.catalog || {};
    const c = comps.find((x) => want.key && x.key === want.key || want.id && x.id === want.id);
    const mapKey = (p.instanceKeys || [])[0];
    if (!c) {
      report.skipped.push(`'${p.name}': catalog component ${want.id || want.key || "?"} is not in this catalog`);
      continue;
    }
    if (!mapKey) {
      report.skipped.push(`'${p.name}': the proposal carries no instance key to file it under`);
      continue;
    }
    if (mapKey in out.components) {
      report.kept++;
      continue;
    }
    const entry = freshEntry(c);
    out.components[mapKey] = entry;
    report.added++;
    for (const extra of (p.instanceKeys || []).slice(1)) report.skipped.push(`'${p.name}': also used under instance key ${extra} \u2014 filed once, under ${mapKey}`);
  }
  return { map: out, report };
}
function proposalsIn(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.componentProposals)) return doc.componentProposals;
  if (doc && doc.crossFile && Array.isArray(doc.crossFile.componentProposals)) return doc.crossFile.componentProposals;
  return null;
}
module.exports = { bootstrap, bootstrapFromProposals, proposalsIn };
if (require.main === module) {
  const fs = require("fs");
  const { assertNotManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT } = require_catalog_input();
  const usage = "usage: node design-to-code/map-bootstrap.js <design-system/components.local.json> [existing-map.json] [--out <file>] [--from-proposals <cross-check report.json>] [--screen <screen.json>]";
  const argv = process.argv.slice(2);
  let outFile = null, proposalsFile = null, screenFile = null;
  const pi = argv.indexOf("--from-proposals");
  if (pi !== -1) {
    proposalsFile = argv[pi + 1];
    if (!proposalsFile || proposalsFile.startsWith("--")) {
      console.error("--from-proposals needs the JSON report cross-check.js (or audit.js) wrote\n" + usage);
      process.exit(1);
    }
    argv.splice(pi, 2);
  }
  const si = argv.indexOf("--screen");
  if (si !== -1) {
    screenFile = argv[si + 1];
    if (!screenFile || screenFile.startsWith("--")) {
      console.error("--screen needs a screen export .json\n" + usage);
      process.exit(1);
    }
    argv.splice(si, 2);
  }
  const o = argv.indexOf("--out");
  if (o !== -1) {
    outFile = argv[o + 1];
    if (!outFile || outFile.startsWith("--")) {
      console.error("--out needs a file path\n" + usage);
      process.exit(1);
    }
    argv.splice(o, 2);
  }
  const unknown = argv.find((a) => a.startsWith("--"));
  if (unknown) {
    console.error(`unknown option ${unknown}
${usage}`);
    process.exit(1);
  }
  const [catalogFile, existingArg] = argv;
  if (!catalogFile) {
    console.error(usage);
    process.exit(1);
  }
  const catalog = readJsonFile(catalogFile, "component catalog", NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const existingFile = existingArg || outFile;
  const existing = existingFile && fs.existsSync(existingFile) ? readJsonFile(existingFile, "existing map") : null;
  if (proposalsFile) {
    const doc = readJsonFile(proposalsFile, "proposals report");
    const proposals = proposalsIn(doc);
    if (!proposals) {
      console.error(`map-bootstrap: ${proposalsFile} has no componentProposals \u2014 run cross-check.js with --out (or --json) and pass the JSON it wrote`);
      process.exit(1);
    }
    const { map, report } = bootstrapFromProposals(proposals, catalog, existing);
    if (!report.confirmed) {
      console.error(`map-bootstrap: none of the ${proposals.length} proposal(s) in ${proposalsFile} is confirmed. Show the user the list, set "confirmed": true on each entry they accept, and re-run. Nothing was written \u2014 proposals are never accepted automatically.`);
      process.exit(1);
    }
    const out = JSON.stringify(map, null, 2) + "\n";
    if (outFile) fs.writeFileSync(outFile, out);
    else process.stdout.write(out);
    for (const sk of report.skipped) console.error(`warn  ${sk}`);
    console.error(`map-bootstrap: ${report.confirmed} confirmed proposal(s) \u2192 ${report.added} new stub(s), ${report.kept} already mapped${outFile ? ` \u2014 wrote ${outFile}` : ""}`);
    process.exit(0);
  }
  let scopedCatalog = catalog;
  if (screenFile) {
    const { visibleInstances } = require_component_match();
    const screenDoc = readJsonFile(screenFile, "screen export");
    const used = /* @__PURE__ */ new Set();
    for (const i of visibleInstances(screenDoc, "screen")) {
      if (i.key) used.add(i.key);
      if (i.setKey) used.add(i.setKey);
    }
    const all = catalog && catalog.components || [];
    const scoped = all.filter((c) => c.key && used.has(c.key) || c.id && used.has(c.id));
    scopedCatalog = Object.assign({}, catalog, { components: scoped });
    console.error(`map-bootstrap: --screen scoped the catalog from ${all.length} to ${scoped.length} component(s) this screen actually uses.`);
  }
  const json = JSON.stringify(bootstrap(scopedCatalog, existing), null, 2) + "\n";
  if (!outFile) {
    process.stdout.write(json);
  } else {
    fs.writeFileSync(outFile, json);
    const entries = Object.values(JSON.parse(json).components);
    const review = entries.filter((e) => e.status === "needs-review").length;
    console.error(`map-bootstrap: wrote ${outFile} \u2014 ${entries.length} component(s), ${review} needing review${existing ? " (merged into the existing map)" : ""}`);
  }
}
