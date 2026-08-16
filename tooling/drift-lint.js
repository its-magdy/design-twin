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
const { snapshotAge } = require("../bridge/snapshot-meta.js"); // ONE definition of the freshness stamp
const { errMsg } = require("../bridge/errmsg.js"); // ONE thrown-value -> message coercion
const stripSuffix = (k) => String(k).split("#")[0]; // "Size#12:3" -> "Size"

// ---------------------------------------------------------------- staleness / freshness
// The catalog (design-system.json) is stamped by the plugin itself — collect.ts/components.ts already
// emit `exportedAt` (ISO timestamp, ALWAYS present on a real export) and `file` (figma.root.name) at
// the top level of buildDesignSystem()'s result. No wrapper is invented here — those are the fields
// the plugin actually sends, read as-is.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, overridable (CLI --max-age <hours> / env)

// Never silently pass: a catalog with no exportedAt gets an explicit "freshness unknown" warning
// rather than being treated as fresh, and one older than maxAgeMs gets a prominent stale warning
// naming the age. Returns the warning pushed (or undefined when the snapshot is fresh) so callers
// (the CLI) can also print an extra banner for the stale case without re-deriving the check.
function checkFreshness(catalog, push, warnings, opts = {}) {
  const maxAgeMs = opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  // Which field and whether it parses is snapshot-meta's rule (figma_status reads the same stamp);
  // only the threshold, the codes and the wording below are this linter's policy.
  const { exportedAt, ageMs, problem } = snapshotAge(catalog, opts.now || Date.now());
  if (problem === "missing") {
    const w = { code: "unknown-freshness", message: "design-system.json has no `exportedAt` timestamp — freshness cannot be verified. Findings are checked against whatever snapshot is on disk, which may be stale; re-export with the current plugin to get a timestamp." };
    push(warnings, w.code, w.message, {});
    return w;
  }
  if (problem === "unparseable") {
    const w = { code: "unknown-freshness", message: `design-system.json's \`exportedAt\` ('${exportedAt}') is not a parseable timestamp — freshness cannot be verified.` };
    push(warnings, w.code, w.message, { exportedAt });
    return w;
  }
  if (ageMs > maxAgeMs) {
    const ageH = (ageMs / 3600000).toFixed(1);
    const maxH = (maxAgeMs / 3600000).toFixed(1);
    const w = {
      code: "stale-snapshot",
      message: `STALE SNAPSHOT: design-system.json was exported ${ageH}h ago (max-age ${maxH}h)${catalog.file ? ` from '${catalog.file}'` : ""}. Every finding below is checked against that on-disk snapshot, NOT the live Figma file — re-run figma-pull / the export tool before trusting them.`,
    };
    push(warnings, w.code, w.message, { exportedAt, ageMs, maxAgeMs });
    return w;
  }
  return undefined;
}

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

function driftLint(map, catalog, opts) {
  const errors = [], warnings = [];
  const push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));

  const freshness = checkFreshness(catalog, push, warnings, opts || {});

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

  // Coverage: a component is unmapped iff none of its identifiers were matched. The denominator is
  // counted in this same pass — a second filter over `comps` would just re-apply the same predicate.
  let catalogComponents = 0;
  for (const c of comps) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    catalogComponents++;
    if ((c.key && mappedIds.has(c.key)) || (c.id && mappedIds.has(c.id))) continue;
    push(warnings, "unmapped-component", `component '${c.name}'${c.key ? " (key " + c.key + ")" : " (unpublished — no key)"} has no map entry`, { key: c.key, name: c.name });
  }

  return { errors, warnings, freshness, summary: { entries: Object.keys(entries).length, catalogComponents, mapped: compToEntries.size, errorCount: errors.length, warningCount: warnings.length } };
}

// Strictly opt-in live check: GET /v1/files/:key/meta (Tier 3, ~10/min even on free files) and compare
// Figma's own `last_modified` against the snapshot's `exportedAt`. Skipped WITHOUT ERROR whenever a
// token or file key is absent — this repo deliberately never requires a REST token, so the offline
// exportedAt/maxAge check above must carry the whole guarantee on its own; this is only a sharper
// answer when the caller happens to have credentials lying around.
async function checkLiveFreshness(fileKey, token, exportedAt) {
  if (!fileKey || !token) return null; // opt-in: nothing configured, nothing attempted
  const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/meta`, { headers: { "X-Figma-Token": token } });
  if (!res.ok) throw new Error(`GET /v1/files/${fileKey}/meta -> ${res.status} ${res.statusText}`);
  const body = await res.json();
  const lastModified = body && body.file && body.file.last_modified;
  if (!lastModified) return { lastModified: undefined, aheadOfSnapshot: undefined };
  const aheadOfSnapshot = exportedAt ? Date.parse(lastModified) > Date.parse(exportedAt) : undefined;
  return { lastModified, aheadOfSnapshot };
}

module.exports = { driftLint, checkFreshness, checkLiveFreshness, DEFAULT_MAX_AGE_MS };

// CLI: node tooling/drift-lint.js <codeconnect.local.json> <design-system/components.local.json> [--max-age <hours>]
// The catalog argument is the SPLIT component file — design-system.json is a slim pointer manifest
// since the split and has no `components` array (see bridge/design-system-layout.js).
if (require.main === module) {
  const fs = require("fs");
  const { assertNotManifest } = require("./catalog-input.js");
  const argv = process.argv.slice(2);
  const maxAgeIdx = argv.indexOf("--max-age");
  let maxAgeHours;
  if (maxAgeIdx !== -1) {
    maxAgeHours = Number(argv[maxAgeIdx + 1]);
    if (!(maxAgeHours > 0)) { console.error("--max-age expects a positive number of hours"); process.exit(2); }
    argv.splice(maxAgeIdx, 2);
  } else if (process.env.DRIFT_MAX_AGE_HOURS) {
    maxAgeHours = Number(process.env.DRIFT_MAX_AGE_HOURS);
    if (!(maxAgeHours > 0)) { console.error("DRIFT_MAX_AGE_HOURS expects a positive number of hours"); process.exit(2); }
  }
  const maxAgeMs = maxAgeHours ? maxAgeHours * 3600000 : undefined;

  const [mapFile, catalogFile] = argv;
  if (!mapFile || !catalogFile) { console.error("usage: node tooling/drift-lint.js <map.json> <design-system/components.local.json> [--max-age <hours>]"); process.exit(2); }
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const res = driftLint(JSON.parse(fs.readFileSync(mapFile, "utf8")), catalog, { maxAgeMs });
  res.errors.forEach((e) => console.error(`ERROR  [${e.code}] ${e.message}`));
  res.warnings.forEach((w) => console.error(`warn   [${w.code}] ${w.message}`));
  const s = res.summary;
  console.error(`\n${s.mapped}/${s.catalogComponents} components mapped · ${s.errorCount} error(s), ${s.warningCount} warning(s)`);

  // Strictly opt-in: only attempted when both are present, and any failure is a warning, never a
  // crash — this check is a bonus on top of the offline exportedAt/maxAge guarantee above, not a
  // replacement for it.
  const fileKey = process.env.FIGMA_FILE_KEY;
  const token = process.env.FIGMA_TOKEN;
  const run = async () => {
    if (fileKey && token) {
      try {
        const live = await checkLiveFreshness(fileKey, token, catalog.exportedAt);
        if (live && live.aheadOfSnapshot) console.error(`warn   [live-meta] the live Figma file was modified (${live.lastModified}) AFTER this snapshot was exported (${catalog.exportedAt}) — it is confirmed stale, not just old.`);
      } catch (e) {
        console.error(`warn   [live-meta] could not verify against the live file: ${errMsg(e)}`);
      }
    }
    process.exit(res.errors.length ? 1 : 0);
  };
  run();
}
