// map-bootstrap.js — scaffold a codeconnect.local.json from the extractor's component catalog.
//
// The free-plan equivalent of `figma connect create`: pre-fills every component (keyed by its stable
// publish key) with its real props translated to the transform vocabulary, marked status:"needs-review".
//
// Merge semantics (safe by default — NEVER destroys human work):
//   - An existing entry (ANY status) is PRESERVED; only advisory figma metadata is refreshed and newly-
//     appeared props are added. Existing prop mappings are never overwritten (drift-lint reports prop drift).
//   - An existing entry whose component is absent from the catalog is KEPT, not dropped (drift-lint's
//     `orphaned-entry` surfaces it loudly — bootstrap must not silently delete it).
//   - Only genuinely new components get a fresh needs-review stub.
// The `existing` argument is never mutated (entries are deep-cloned).

const { TYPE_TO_KIND: KIND } = require("./kinds"); // shared vocab — kept in sync with drift-lint

const clone = (o) => JSON.parse(JSON.stringify(o));

// Split an arbitrary name into alphanumeric words (drops "/", punctuation, whitespace).
const words = (name) => String(name || "").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

function pascal(name) {
  // Join ALL "/" segments so "Button/Primary/Danger" keeps its namespace instead of collapsing to "Danger".
  const p = words(name).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "Component";
}
function camel(name) {
  const base = String(name || "").split("/").pop() || ""; // camel keys off the LEAF segment only
  const p = words(base).map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "prop";
}

function propEntry(name, def) {
  const kind = KIND[def.type];
  if (kind === "enum") {
    const values = {}; for (const opt of def.options || []) values[opt] = opt; // identity map to start
    const p = { kind, codeProp: camel(name), values };
    if (typeof def.default === "string" || typeof def.default === "number" || typeof def.default === "boolean") { p.default = def.default; p.omitDefault = true; }
    return p;
  }
  if (kind === "boolean") { const p = { kind, codeProp: camel(name) }; if (def.default !== undefined) { p.default = !!def.default; p.omitDefault = true; } return p; }
  if (kind === "string") return { kind, codeProp: /label|text|title/i.test(name) ? "children" : camel(name) };
  if (kind === "instance") return { kind, slot: camel(name) };
  return null;
}

function freshEntry(c) {
  const figma = { name: c.name || c.key || c.id || "Unnamed" }; // figma.name must always be a string
  if (c.key) figma.key = c.key; else figma.unstable = true;
  if (c.id) figma.id = c.id;
  const entry = { figma, code: { module: "TODO: import path", export: pascal(c.name || "Component") }, status: "needs-review" };
  const props = {};
  for (const pn of Object.keys(c.props || {})) { const pe = propEntry(pn, c.props[pn]); if (pe) props[pn] = pe; }
  if (Object.keys(props).length) entry.props = props;
  return entry;
}

function bootstrap(catalog, existing) {
  // components is a string-keyed map; use a null-prototype object so a component whose key/id is
  // literally "__proto__"/"constructor" becomes a real own entry instead of silently vanishing
  // (which would violate the "never destroys human work" contract). Serializes to JSON normally.
  const out = { version: 1, components: Object.create(null) };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev = (existing && existing.components) || {};
  // Index prev entries by EVERY identifier they carry (their map key + figma.key + figma.id), so a
  // component that changes how it's identified (e.g. an id-keyed entry whose component later gains a
  // publish key) reuses its existing entry instead of producing a duplicate.
  const prevByIdent = new Map();
  for (const pk of Object.keys(prev)) {
    if (!prevByIdent.has(pk)) prevByIdent.set(pk, pk);
    const pf = prev[pk].figma || {};
    if (pf.key && !prevByIdent.has(pf.key)) prevByIdent.set(pf.key, pk);
    if (pf.id && !prevByIdent.has(pf.id)) prevByIdent.set(pf.id, pk);
  }
  const usedPrev = new Set();

  for (const c of (catalog && catalog.components) || []) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    const id = c.key || c.id;
    if (!id) continue;
    const matchKey = [c.key, c.id, id].find((x) => x && prevByIdent.has(x));
    const prevKey = matchKey ? prevByIdent.get(matchKey) : null;
    const prevEntry = prevKey ? prev[prevKey] : null;

    if (prevEntry) {
      // Preserve ALL human work regardless of status — a `needs-review` stub can still carry half-
      // finished edits (a renamed export, mapped props) before its import path is filled, so we never
      // regenerate wholesale. Refresh only advisory metadata, add newly-appeared props, and regenerate
      // a prop whose Figma TYPE changed (its old mapping is definitionally invalid — the only safe
      // overwrite). A genuinely-stale stub is simply kept; drift-lint reports its staleness.
      usedPrev.add(prevKey);
      const entry = clone(prevEntry);
      entry.figma = Object.assign({}, entry.figma, { name: c.name || (entry.figma && entry.figma.name) || "Unnamed" });
      if (c.id) entry.figma.id = c.id;
      if (c.key) entry.figma.key = c.key; else if (!entry.figma.key) entry.figma.unstable = true;
      entry.props = entry.props || {};
      for (const pn of Object.keys(c.props || {})) {
        const cdef = c.props[pn], kind = KIND[cdef.type], ex = entry.props[pn];
        if (!ex || (kind && ex.kind && ex.kind !== kind)) { const pe = propEntry(pn, cdef); if (pe) entry.props[pn] = pe; }
      }
      if (!Object.keys(entry.props).length) delete entry.props;
      // An entry filed under a key that is NOT one of this component's own identifiers was put there on
      // purpose — a confirmed re-key proposal is filed under the SCREEN's instance key (the catalog's
      // key was re-minted by a file duplication, livetest-3 #226) so an instance lookup finds it. Keep it
      // there; moving it to the catalog key would silently unmap every instance again.
      out.components[prevKey !== c.key && prevKey !== c.id ? prevKey : id] = entry;
    } else {
      out.components[id] = freshEntry(c);
    }
  }

  // Keep existing entries whose component is genuinely absent from the catalog (drift-lint's
  // orphaned-entry surfaces them) — never silently delete human work.
  for (const pk of Object.keys(prev)) if (!usedPrev.has(pk) && !(pk in out.components)) out.components[pk] = clone(prev[pk]);
  return out;
}

// Stubs for CONFIRMED name+prop-signature matches only (cross-check.js `componentProposals`, see
// component-match.js). Why a separate path: when a file was duplicated, 0 of the screen's instance
// keys are in the catalog, and a full bootstrap wrote 318 stubs of which none was on the screen
// (livetest-3 #103) — a list nobody can evaluate. Here every stub is one the user already said yes
// to, filed under the screen's OWN instance key (what build-screen looks an instance up by), with
// figma.key/id pointing at the catalog component whose props it was matched on.
// Never auto-accepts: an entry without `confirmed: true` is skipped. Never overwrites: an existing
// entry under the same key is kept as it is.
function bootstrapFromProposals(proposals, catalog, existing) {
  const out = { version: 1, components: Object.create(null) };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev = (existing && existing.components) || {};
  for (const pk of Object.keys(prev)) out.components[pk] = clone(prev[pk]);
  const comps = (catalog && catalog.components) || [];
  const report = { confirmed: 0, added: 0, kept: 0, skipped: [] };
  for (const p of proposals || []) {
    if (!p || p.confirmed !== true) continue;
    report.confirmed++;
    const want = p.catalog || {};
    const c = comps.find((x) => (want.key && x.key === want.key) || (want.id && x.id === want.id));
    const mapKey = (p.instanceKeys || [])[0];
    if (!c) { report.skipped.push(`'${p.name}': catalog component ${want.id || want.key || "?"} is not in this catalog`); continue; }
    if (!mapKey) { report.skipped.push(`'${p.name}': the proposal carries no instance key to file it under`); continue; }
    if (mapKey in out.components) { report.kept++; continue; }
    const entry = freshEntry(c);
    out.components[mapKey] = entry;
    report.added++;
    for (const extra of (p.instanceKeys || []).slice(1)) report.skipped.push(`'${p.name}': also used under instance key ${extra} — filed once, under ${mapKey}`);
  }
  return { map: out, report };
}

// A cross-check report, an audit report (its crossFile), or a bare array.
function proposalsIn(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.componentProposals)) return doc.componentProposals;
  if (doc && doc.crossFile && Array.isArray(doc.crossFile.componentProposals)) return doc.crossFile.componentProposals;
  return null;
}

module.exports = { bootstrap, bootstrapFromProposals, proposalsIn };

// CLI: node design-to-code/map-bootstrap.js <design-system/components.local.json> [existing-map.json] [--out <file>]
// The catalog argument is the SPLIT component file, not design-system.json — that is a slim pointer
// manifest since the split and carries no `components` array (see bridge/design-system-layout.js).
// Without --out the map goes to stdout. With --out it is written to that file; when the file already
// exists and no existing-map was named, it IS the existing map — so re-running merges into it (the
// "never destroys human work" semantics above) instead of replacing it with fresh stubs.
if (require.main === module) {
  const fs = require("fs");
  const { assertNotManifest, readJsonFile, NO_DESIGN_SYSTEM_HINT } = require("./catalog-input.js");
  const usage = "usage: node design-to-code/map-bootstrap.js <design-system/components.local.json> [existing-map.json] [--out <file>] [--from-proposals <cross-check report.json>] [--screen <screen.json>]";
  const argv = process.argv.slice(2);
  let outFile = null, proposalsFile = null, screenFile = null;
  const pi = argv.indexOf("--from-proposals");
  if (pi !== -1) {
    proposalsFile = argv[pi + 1];
    if (!proposalsFile || proposalsFile.startsWith("--")) { console.error("--from-proposals needs the JSON report cross-check.js (or audit.js) wrote\n" + usage); process.exit(1); }
    argv.splice(pi, 2);
  }
  const si = argv.indexOf("--screen");
  if (si !== -1) {
    screenFile = argv[si + 1];
    if (!screenFile || screenFile.startsWith("--")) { console.error("--screen needs a screen export .json\n" + usage); process.exit(1); }
    argv.splice(si, 2);
  }
  const o = argv.indexOf("--out");
  if (o !== -1) {
    outFile = argv[o + 1];
    if (!outFile || outFile.startsWith("--")) { console.error("--out needs a file path\n" + usage); process.exit(1); }
    argv.splice(o, 2);
  }
  const unknown = argv.find((a) => a.startsWith("--"));
  if (unknown) { console.error(`unknown option ${unknown}\n${usage}`); process.exit(1); }
  const [catalogFile, existingArg] = argv;
  if (!catalogFile) { console.error(usage); process.exit(1); }
  const catalog = readJsonFile(catalogFile, "component catalog", NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const existingFile = existingArg || outFile;
  const existing = existingFile && fs.existsSync(existingFile) ? readJsonFile(existingFile, "existing map") : null;
  if (proposalsFile) {
    const doc = readJsonFile(proposalsFile, "proposals report");
    const proposals = proposalsIn(doc);
    if (!proposals) { console.error(`map-bootstrap: ${proposalsFile} has no componentProposals — run cross-check.js with --out (or --json) and pass the JSON it wrote`); process.exit(1); }
    const { map, report } = bootstrapFromProposals(proposals, catalog, existing);
    if (!report.confirmed) {
      console.error(`map-bootstrap: none of the ${proposals.length} proposal(s) in ${proposalsFile} is confirmed. Show the user the list, set "confirmed": true on each ` +
        `entry they accept, and re-run. Nothing was written — proposals are never accepted automatically.`);
      process.exit(1);
    }
    const out = JSON.stringify(map, null, 2) + "\n";
    if (outFile) fs.writeFileSync(outFile, out); else process.stdout.write(out);
    for (const sk of report.skipped) console.error(`warn  ${sk}`);
    console.error(`map-bootstrap: ${report.confirmed} confirmed proposal(s) → ${report.added} new stub(s), ${report.kept} already mapped${outFile ? ` — wrote ${outFile}` : ""}`);
    process.exit(0);
  }
  // Finding 103: a full bootstrap on a real catalog stubs EVERY component in the file (318 on the
  // live run) — a list nobody can evaluate, and none of them may even be on the screen the user is
  // about to build. When --screen is given, scope the catalog to the keys/ids that screen's own
  // VISIBLE instances actually reference first, so the "confirm the stubs" step is small and every
  // entry is one the screen actually needs. Run the screen-coverage/cross-check BEFORE this (the
  // skill's own ordering), then pass its screen json here.
  let scopedCatalog = catalog;
  if (screenFile) {
    const { visibleInstances } = require("./component-match.js");
    const screenDoc = readJsonFile(screenFile, "screen export");
    const used = new Set();
    for (const i of visibleInstances(screenDoc, "screen")) {
      if (i.key) used.add(i.key);
      if (i.setKey) used.add(i.setKey);
    }
    const all = (catalog && catalog.components) || [];
    const scoped = all.filter((c) => (c.key && used.has(c.key)) || (c.id && used.has(c.id)));
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
    console.error(`map-bootstrap: wrote ${outFile} — ${entries.length} component(s), ${review} needing review${existing ? " (merged into the existing map)" : ""}`);
  }
}
