// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.


// design-to-code/get-component.ts
import fs2 from "node:fs";
import path from "node:path";

// design-to-code/catalog-input.ts
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

// bridge/src/design-system-layout.ts
var DIR = "design-system";
var DESIGN_SYSTEM_DIR = DIR;

// bridge/src/is-main.ts
import fs from "node:fs";
import { fileURLToPath } from "node:url";
function isMainFallback(metaUrl) {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// design-to-code/get-component.ts
function findComponent(catalog, handle) {
  const comps = catalog && catalog.components || [];
  const byKey = comps.find((c) => c.key === handle);
  if (byKey) return byKey;
  const byId = comps.find((c) => c.id === handle);
  if (byId) return byId;
  const byName = comps.filter((c) => c.name === handle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const err = new Error(`'${handle}' matches ${byName.length} components by name \u2014 use its key or id instead (${byName.map((c) => c.key || c.id).join(", ")})`);
    err.code = "ambiguous-name";
    throw err;
  }
  return null;
}
function resolveVariantsFile(catalogFile, variantsFile) {
  const catalogDir = path.dirname(catalogFile);
  const root = path.basename(catalogDir) === DESIGN_SYSTEM_DIR ? path.dirname(catalogDir) : catalogDir;
  return path.join(root, variantsFile);
}
function getComponent(catalogFile, handle) {
  const catalog = JSON.parse(fs2.readFileSync(catalogFile, "utf8"));
  assertNotManifest(catalog, catalogFile, "components", "design-system/components.local.json");
  const comp = findComponent(catalog, handle);
  if (!comp) return { found: false };
  const pointer = comp.variantsFile || comp.nodeFile;
  if (!pointer) return { found: true, component: comp, detail: null };
  const detailPath = resolveVariantsFile(catalogFile, pointer);
  const detail = JSON.parse(fs2.readFileSync(detailPath, "utf8"));
  return { found: true, component: comp, detail, detailPath };
}
if (import.meta.main ?? isMainFallback(import.meta.url)) {
  const [catalogFile, handle] = process.argv.slice(2);
  if (!catalogFile || !handle) {
    console.error("usage: node design-to-code/get-component.ts <design-system/components.local.json> <key|id|name>");
    process.exit(2);
  }
  try {
    const res = getComponent(catalogFile, handle);
    if (!res.found) {
      console.error(`error  no component matches '${handle}' in ${catalogFile}`);
      process.exit(1);
    }
    if (!res.detail) {
      console.error(`warn   '${handle}' has no variantsFile/nodeFile (no node trees were exported for it \u2014 re-run the export with variantVisuals:true) \u2014 printing the catalog entry only`);
      process.stdout.write(JSON.stringify(res.component, null, 2) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(res.detail, null, 2) + "\n");
  } catch (e) {
    const message = e && typeof e === "object" && "message" in e ? e.message : void 0;
    console.error(`error  ${String(message)}`);
    process.exit(2);
  }
}
export {
  findComponent,
  getComponent,
  resolveVariantsFile
};
