// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/map-bootstrap.ts
import fs2 from "node:fs";

// design-to-code/types.ts
function isJsonObject(x) {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// design-to-code/kinds.ts
var TYPE_TO_KIND = { VARIANT: "enum", BOOLEAN: "boolean", TEXT: "string", INSTANCE_SWAP: "instance" };

// design-to-code/catalog-input.ts
import fs from "node:fs";
function isManifest(doc, payloadKey) {
  return !!(doc && typeof doc === "object" && "files" in doc && doc.files && typeof doc.files === "object" && !Array.isArray(doc.files) && !Array.isArray(doc[payloadKey]));
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
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? e.code : void 0;
    const why = code === "ENOENT" ? "does not exist" : code === "EISDIR" ? "is a directory, not a file" : code === "EACCES" ? "is not readable (permission denied)" : `could not be read (${code || e})`;
    console.error(`error  ${what}: '${file}' ${why}.` + (hint ? `
       ${hint}` : ""));
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? e.message : void 0;
    console.error(`error  ${what}: '${file}' is not valid JSON \u2014 ${message || e}`);
    process.exit(2);
  }
}
var NO_DESIGN_SYSTEM_HINT = "A single-screen pull (`dtwin pull --node <id>`) exports only that screen \u2014 it does not\n       write design/design-system/. Run `dtwin pull --design-system` to create it.";

// design-to-code/component-match.ts
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

// design-to-code/map-bootstrap.ts
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
  const kind = TYPE_TO_KIND[def.type];
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
  const defs = c.props || {};
  for (const pn of Object.keys(defs)) {
    const pe = propEntry(pn, defs[pn]);
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
    if (prevKey && prevEntry) {
      usedPrev.add(prevKey);
      const entry = clone(prevEntry);
      entry.figma = Object.assign({}, entry.figma, { name: c.name || entry.figma && entry.figma.name || "Unnamed" });
      if (c.id) entry.figma.id = c.id;
      if (c.key) entry.figma.key = c.key;
      else if (!entry.figma.key) entry.figma.unstable = true;
      const props = entry.props = entry.props || {};
      const defs = c.props || {};
      for (const pn of Object.keys(defs)) {
        const cdef = defs[pn], kind = TYPE_TO_KIND[cdef.type], ex = props[pn];
        if (!ex || kind && ex.kind && ex.kind !== kind) {
          const pe = propEntry(pn, cdef);
          if (pe) props[pn] = pe;
        }
      }
      if (!Object.keys(props).length) delete entry.props;
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
var isProposalList = (x) => Array.isArray(x);
function proposalsIn(doc) {
  if (isProposalList(doc)) return doc;
  if (isJsonObject(doc) && isProposalList(doc.componentProposals)) return doc.componentProposals;
  if (isJsonObject(doc) && isJsonObject(doc.crossFile) && isProposalList(doc.crossFile.componentProposals)) return doc.crossFile.componentProposals;
  return null;
}
if (import.meta.main) {
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
  const catalogDoc = readJsonFile(catalogFile, "component catalog", NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  assertNotManifest(catalogDoc, catalogFile, "components", "design-system/components.local.json");
  const catalog = catalogDoc;
  const existingFile = existingArg || outFile;
  const existing = existingFile && fs2.existsSync(existingFile) ? readJsonFile(existingFile, "existing map") : null;
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
    if (outFile) fs2.writeFileSync(outFile, out);
    else process.stdout.write(out);
    for (const sk of report.skipped) console.error(`warn  ${sk}`);
    console.error(`map-bootstrap: ${report.confirmed} confirmed proposal(s) \u2192 ${report.added} new stub(s), ${report.kept} already mapped${outFile ? ` \u2014 wrote ${outFile}` : ""}`);
    process.exit(0);
  }
  let scopedCatalog = catalog;
  if (screenFile) {
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
    fs2.writeFileSync(outFile, json);
    const written = JSON.parse(json);
    const entries = Object.values(written.components);
    const review = entries.filter((e) => e.status === "needs-review").length;
    console.error(`map-bootstrap: wrote ${outFile} \u2014 ${entries.length} component(s), ${review} needing review${existing ? " (merged into the existing map)" : ""}`);
  }
}
export {
  bootstrap,
  bootstrapFromProposals,
  proposalsIn
};
