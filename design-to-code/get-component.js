// get-component.js — resolve ONE entry in components.local.json and print its full detail: variants
// with their real serialized node trees, from the sibling file its `variantsFile` pointer names.
//
// Since the components.local.json / design-system/components/*.json split (bridge/design-system-
// layout.js), the catalog is deliberately slim — every COMPONENT_SET's variants[].node (the heavy
// per-variant node tree) lives in its own detail file so an agent that only wants the prop table for
// 143 components doesn't load 4MB of node trees to get it. This is the other half of that trade: the
// tool an agent reaches for when it DOES want one component's variant visuals.
//
// Resolution mirrors drift-lint's identity rule (key is the stable identity, then id, then name) so the
// same handle that drift-lint or map-bootstrap printed for a component also works here.

const fs = require("fs");
const path = require("path");
const { assertNotManifest } = require("./catalog-input.js");
const { DESIGN_SYSTEM_DIR } = require("../bridge/design-system-layout.js");

// entry: a COMPONENT/COMPONENT_SET row from components.local.json (or .library.json — library entries
// never carry a variantsFile since they have no node trees to export in the first place).
function findComponent(catalog, handle) {
  const comps = (catalog && catalog.components) || [];
  const byKey = comps.find((c) => c.key === handle);
  if (byKey) return byKey;
  const byId = comps.find((c) => c.id === handle);
  if (byId) return byId;
  const byName = comps.filter((c) => c.name === handle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const err = new Error(`'${handle}' matches ${byName.length} components by name — use its key or id instead (${byName.map((c) => c.key || c.id).join(", ")})`);
    err.code = "ambiguous-name";
    throw err;
  }
  return null;
}

// Resolve a component's variantsFile pointer to real bytes. `catalogFile` is the path to
// components.local.json actually opened; variantsFile is written relative to the export ROOT (the
// directory that also holds design-system.json), which is always catalogFile's PARENT of parent since
// the layout module places components.local.json directly under design-system/ and detail files under
// design-system/<subdir>/ — so re-derive root the same way for either directory-mode or a caller-
// supplied root, rather than assuming a fixed relative depth.
function resolveVariantsFile(catalogFile, variantsFile) {
  const catalogDir = path.dirname(catalogFile); // .../design-system
  const root = path.basename(catalogDir) === DESIGN_SYSTEM_DIR ? path.dirname(catalogDir) : catalogDir;
  return path.join(root, variantsFile);
}

function getComponent(catalogFile, handle) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const comp = findComponent(catalog, handle);
  if (!comp) return { found: false };
  // A standalone COMPONENT's node tree lives under nodeFile (no variants array to hang it off);
  // a COMPONENT_SET's lives under variantsFile. Never both on the same entry.
  const pointer = comp.variantsFile || comp.nodeFile;
  if (!pointer) return { found: true, component: comp, detail: null }; // no exported node tree for this entry
  const detailPath = resolveVariantsFile(catalogFile, pointer);
  const detail = JSON.parse(fs.readFileSync(detailPath, "utf8"));
  return { found: true, component: comp, detail, detailPath };
}

module.exports = { getComponent, findComponent, resolveVariantsFile };

// CLI: node design-to-code/get-component.js <design-system/components.local.json> <key|id|name>
if (require.main === module) {
  const [catalogFile, handle] = process.argv.slice(2);
  if (!catalogFile || !handle) {
    console.error("usage: node design-to-code/get-component.js <design-system/components.local.json> <key|id|name>");
    process.exit(2);
  }
  try {
    const res = getComponent(catalogFile, handle);
    if (!res.found) {
      console.error(`error  no component matches '${handle}' in ${catalogFile}`);
      process.exit(1);
    }
    if (!res.detail) {
      console.error(`warn   '${handle}' has no variantsFile/nodeFile (no node trees were exported for it — re-run the export with variantVisuals:true) — printing the catalog entry only`);
      process.stdout.write(JSON.stringify(res.component, null, 2) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(res.detail, null, 2) + "\n");
  } catch (e) {
    console.error(`error  ${e.message}`);
    process.exit(2);
  }
}
