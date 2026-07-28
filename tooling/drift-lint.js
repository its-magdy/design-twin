// drift-lint.js — reconcile a codeconnect.local.json map against the LIVE component catalog
// (the `components` array from figma-plugin/code.js buildDesignSystem()/design-system.json).
//
// This is the check Figma's own Code Connect is missing: because it keys on node-id, a deleted/moved
// mapped component makes `publish` succeed silently with a broken link (github.com/figma/code-connect
// /issues/337). We key on the stable publish `key`, so we can catch exactly that.
//
// Resolution is by IDENTITY only (figma.key, then the map key as a key, then figma.id / map key as an
// id). A NAME never auto-binds an entry — if a declared key/id no longer resolves, the entry is
// ORPHANED (error), even when some other component happens to share its name; the same-named component
// is offered only as a *suggestion* in the message. This avoids silently rebinding to the wrong
// component (the failure that would defeat the tool's purpose). Prop names are compared with Figma's
// "#id" suffix stripped on BOTH sides. Returns { errors, warnings, summary }.

const { TYPE_TO_KIND } = require("./kinds"); // shared vocab — kept in sync with map-bootstrap
const stripSuffix = (k) => String(k).split("#")[0]; // "Size#12:3" -> "Size"

// Index a props object by base name (Figma's "#id" suffix stripped), warning on — and recording —
// any two distinct keys that collapse to the same base so callers skip order-dependent errors on it.
function indexPropsByBase(rawProps, valKey, subject, push, warnings, mapKey) {
  // null-prototype map: a prop whose base name is literally "__proto__"/"constructor" is indexed and
  // compared like any other, instead of silently mutating a prototype and being skipped from drift checks.
  const ambiguous = new Set(), out = Object.create(null);
  for (const k of Object.keys(rawProps || {})) {
    const b = stripSuffix(k);
    if (b in out && out[b].orig !== k) {
      push(warnings, "ambiguous-prop", `${subject} has two props with base name '${b}' ('${out[b].orig}', '${k}') — comparison skipped`, { mapKey, prop: b });
      ambiguous.add(b);
    }
    out[b] = { orig: k, [valKey]: rawProps[k] };
  }
  return { props: out, ambiguous };
}

function driftLint(map, catalog) {
  const errors = [], warnings = [];
  const push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));

  const comps = (catalog && catalog.components) || [];
  const byKey = new Map(), byId = new Map(), byName = new Map();
  for (const c of comps) {
    if (c.key) { if (byKey.has(c.key)) push(warnings, "duplicate-key", `two catalog components share key '${c.key}' ('${byKey.get(c.key).name}' and '${c.name}')`, { key: c.key }); byKey.set(c.key, c); }
    if (c.id) byId.set(c.id, c);
    if (c.name) (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c);
  }
  const mappedIds = new Set();           // catalog key/id values that got matched (for coverage)
  const compToEntries = new Map();       // component -> [mapKey] (double-map detection)
  const entries = (map && map.components) || {};

  for (const mapKey of Object.keys(entries)) {
    const e = entries[mapKey];
    const f = e.figma || {};
    // Identity resolution. An author-declared figma.key/figma.id is an explicit identity CLAIM and is
    // authoritative: if it's present we resolve by it ALONE and never fall through to the map key. That
    // fallthrough would let a coincidental map-key collision silently rebind a stale entry to an
    // unrelated live component — precisely the drift this tool exists to catch (a deleted/unpublished
    // component would look "mapped" instead of orphaned). Only when the entry declares no figma identity
    // do we lean on the map key, which may itself be a publish key OR (unpublished) a node id.
    let comp;
    if (f.key) comp = byKey.get(f.key);            // published: key is the stable identity — stale key -> orphaned
    else if (f.id) comp = byId.get(f.id);          // unpublished/local: declared node id is the identity
    else comp = byKey.get(mapKey) || byId.get(mapKey); // no explicit identity: the map key is the only handle

    if (!comp) {
      // Orphaned — a NAME is never allowed to rebind; only suggested.
      const sameName = f.name && byName.get(f.name);
      const suggestedKey = sameName && sameName.length === 1 ? sameName[0].key : undefined;
      push(errors, "orphaned-entry",
        `map entry '${mapKey}' (was '${f.name || "?"}'${f.id ? ", id " + f.id : ""}) has no matching component in Figma — deleted, moved, or unpublished${suggestedKey ? ` (a component named '${f.name}' exists with key ${suggestedKey} — verify before re-pointing)` : ""}`,
        { mapKey, suggestedKey });
      continue;
    }
    if (comp.key) mappedIds.add(comp.key);
    if (comp.id) mappedIds.add(comp.id);
    (compToEntries.get(comp) || compToEntries.set(comp, []).get(comp)).push(mapKey);

    if (f.name && comp.name && f.name !== comp.name) {
      push(warnings, "stale-name", `map entry '${mapKey}' remembers name '${f.name}' but component is now '${comp.name}' (rename — refresh advisory metadata)`, { mapKey, from: f.name, to: comp.name });
    }

    // Prop comparison — strip Figma's #id suffix on both sides so the two conventions line up. If two
    // distinct keys collapse to the same base name, surface it (never silently shadow one away) and
    // record the base so we DON'T emit an order-dependent kind/enum error on an ambiguous prop.
    const { props: catProps, ambiguous: catAmbiguous } = indexPropsByBase(comp.props, "def", `component '${comp.name}'`, push, warnings, mapKey);
    const { props: mapProps, ambiguous: mapAmbiguous } = indexPropsByBase(e.props, "prop", `map entry '${mapKey}'`, push, warnings, mapKey);

    for (const pn of Object.keys(mapProps)) if (!(pn in catProps)) push(errors, "stale-prop", `'${mapKey}'.props.${mapProps[pn].orig} does not exist on the Figma component`, { mapKey, prop: pn });
    for (const pn of Object.keys(catProps)) if (!(pn in mapProps)) push(warnings, "uncovered-prop", `'${mapKey}': Figma prop '${catProps[pn].orig}' (${catProps[pn].def.type}) is not mapped`, { mapKey, prop: pn });

    for (const pn of Object.keys(mapProps)) {
      const cp = catProps[pn]; if (!cp || catAmbiguous.has(pn) || mapAmbiguous.has(pn)) continue; // ambiguous base (either side) -> already warned, don't emit order-dependent errors
      const kind = mapProps[pn].prop.kind, expected = TYPE_TO_KIND[cp.def.type];
      if (expected && kind && kind !== expected) { push(errors, "kind-mismatch", `'${mapKey}'.props.${mapProps[pn].orig}: map kind '${kind}' but Figma type is ${cp.def.type} (expected '${expected}')`, { mapKey, prop: pn }); continue; }
      if (kind === "enum") {
        const values = mapProps[pn].prop.values || {};
        if (!Array.isArray(cp.def.options)) { push(warnings, "no-variant-options", `'${mapKey}'.props.${mapProps[pn].orig}: component exposes no variant options — enum values can't be verified`, { mapKey, prop: pn }); continue; }
        for (const opt of Object.keys(values)) if (!cp.def.options.includes(opt)) push(errors, "unknown-variant-value", `'${mapKey}'.props.${mapProps[pn].orig}: maps option '${opt}' that is not a Figma variant option`, { mapKey, prop: pn });
        for (const opt of cp.def.options) if (!(opt in values)) push(warnings, "unmapped-variant-value", `'${mapKey}'.props.${mapProps[pn].orig}: variant option '${opt}' has no code mapping (will be omitted)`, { mapKey, prop: pn });
      }
    }
  }

  // Double-mapping: two entries targeting one component is conflicting drift.
  for (const [comp, keys] of compToEntries) if (keys.length > 1) push(errors, "double-mapped", `component '${comp.name}' is mapped by ${keys.length} entries (${keys.join(", ")}) — only one code target may win`, { keys });

  // Coverage: a component is unmapped iff none of its identifiers were matched.
  for (const c of comps) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    if ((c.key && mappedIds.has(c.key)) || (c.id && mappedIds.has(c.id))) continue;
    push(warnings, "unmapped-component", `component '${c.name}'${c.key ? " (key " + c.key + ")" : " (unpublished — no key)"} has no map entry`, { key: c.key, name: c.name });
  }

  const catalogComponents = comps.filter((c) => c.type === "COMPONENT" || c.type === "COMPONENT_SET");
  return { errors, warnings, summary: { entries: Object.keys(entries).length, catalogComponents: catalogComponents.length, mapped: compToEntries.size, errorCount: errors.length, warningCount: warnings.length } };
}

module.exports = { driftLint };

// CLI: node tooling/drift-lint.js <codeconnect.local.json> <design-system.json>
if (require.main === module) {
  const fs = require("fs");
  const [mapFile, catalogFile] = process.argv.slice(2);
  if (!mapFile || !catalogFile) { console.error("usage: node tooling/drift-lint.js <map.json> <design-system.json>"); process.exit(2); }
  const res = driftLint(JSON.parse(fs.readFileSync(mapFile, "utf8")), JSON.parse(fs.readFileSync(catalogFile, "utf8")));
  res.errors.forEach((e) => console.error(`ERROR  [${e.code}] ${e.message}`));
  res.warnings.forEach((w) => console.error(`warn   [${w.code}] ${w.message}`));
  const s = res.summary;
  console.error(`\n${s.mapped}/${s.catalogComponents} components mapped · ${s.errorCount} error(s), ${s.warningCount} warning(s)`);
  process.exit(res.errors.length ? 1 : 0);
}
