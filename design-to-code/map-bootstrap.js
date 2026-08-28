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
      out.components[id] = entry;
    } else {
      out.components[id] = freshEntry(c);
    }
  }

  // Keep existing entries whose component is genuinely absent from the catalog (drift-lint's
  // orphaned-entry surfaces them) — never silently delete human work.
  for (const pk of Object.keys(prev)) if (!usedPrev.has(pk) && !(pk in out.components)) out.components[pk] = clone(prev[pk]);
  return out;
}

module.exports = { bootstrap };

// CLI: node design-to-code/map-bootstrap.js <design-system/components.local.json> [existing-map.json]
// The catalog argument is the SPLIT component file, not design-system.json — that is a slim pointer
// manifest since the split and carries no `components` array (see bridge/design-system-layout.js).
if (require.main === module) {
  const fs = require("fs");
  const { assertNotManifest } = require("./catalog-input.js");
  const [catalogFile, existingFile] = process.argv.slice(2);
  if (!catalogFile) { console.error("usage: node design-to-code/map-bootstrap.js <design-system/components.local.json> [existing-map.json]"); process.exit(1); }
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const existing = existingFile && fs.existsSync(existingFile) ? JSON.parse(fs.readFileSync(existingFile, "utf8")) : null;
  process.stdout.write(JSON.stringify(bootstrap(catalog, existing), null, 2) + "\n");
}
