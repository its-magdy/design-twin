// get-component.ts — resolve ONE entry in components.local.json and print its full detail: variants
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
import path from "node:path";
import { isComponentDetailFile, isComponentsCatalog } from "./doc-guards.ts";
import type { DocGuard } from "./doc-guards.ts";
import { anyJson, readJson } from "./read-json.ts";
import { scriptCmd } from "./cli-args.ts";
import { assertNotManifest } from "./catalog-input.ts";
import { DESIGN_SYSTEM_DIR } from "../bridge/src/design-system-layout.ts";
import type { CatalogComponent, ComponentDetailFile, ComponentsCatalog } from "./types.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2

export type GetComponentResult =
  | { found: false }
  | { found: true; component: CatalogComponent; detail: ComponentDetailFile | null; detailPath?: string };

// entry: a COMPONENT/COMPONENT_SET row from components.local.json (or .library.json — library entries
// never carry a variantsFile since they have no node trees to export in the first place).
function findComponent(catalog: ComponentsCatalog | null | undefined, handle: string): CatalogComponent | null {
  const comps = (catalog && catalog.components) || [];
  const byKey = comps.find((c) => c.key === handle);
  if (byKey) return byKey;
  const byId = comps.find((c) => c.id === handle);
  if (byId) return byId;
  const byName = comps.filter((c) => c.name === handle);
  const only = byName.length === 1 ? byName[0] : undefined;
  if (only) return only;
  if (byName.length > 1) {
    const err: Error & { code?: string } = new Error(`'${handle}' matches ${byName.length} components by name — use its key or id instead (${byName.map((c) => c.key || c.id).join(", ")})`);
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
function resolveVariantsFile(catalogFile: string, variantsFile: string): string {
  const catalogDir = path.dirname(catalogFile); // .../design-system
  const root = path.basename(catalogDir) === DESIGN_SYSTEM_DIR ? path.dirname(catalogDir) : catalogDir;
  return path.join(root, variantsFile);
}

// Throws a one-line Error for a file that is missing, not JSON, or not the kind of document it should
// be (the CLI prints it; the MCP server's design_get_component returns it as the tool error).
function readOrThrow<T>(file: string, guard: DocGuard<T>): T {
  const r = readJson(file, guard);
  if ("doc" in r) return r.doc;
  throw new Error(`'${file}' ${r.error}`);
}

function getComponent(catalogFile: string, handle: string): GetComponentResult {
  // assertNotManifest refuses the one wrong file people pass here, with its own explanation, before
  // the catalog's shape is checked.
  const raw = readOrThrow(catalogFile, anyJson);
  assertNotManifest(raw, catalogFile, "components", "design-system/components.local.json");
  if (!isComponentsCatalog(raw)) throw new Error(`'${catalogFile}' is not ${isComponentsCatalog.expected}`);
  const catalog = raw;
  const comp = findComponent(catalog, handle);
  if (!comp) return { found: false };
  // A standalone COMPONENT's node tree lives under nodeFile (no variants array to hang it off);
  // a COMPONENT_SET's lives under variantsFile. Never both on the same entry.
  const pointer = comp.variantsFile || comp.nodeFile;
  if (!pointer) return { found: true, component: comp, detail: null }; // no exported node tree for this entry
  const detailPath = resolveVariantsFile(catalogFile, pointer);
  const detail = readOrThrow(detailPath, isComponentDetailFile);
  return { found: true, component: comp, detail, detailPath };
}

export { getComponent, findComponent, resolveVariantsFile };

// CLI: node design-to-code/get-component.ts <design-system/components.local.json> <key|id|name>
function main(argv: string[]): number {
  const [catalogFile, handle] = argv;
  if (!catalogFile || !handle) {
    console.error(`usage: ${scriptCmd("get-component")} <design-system/components.local.json> <key|id|name>`);
    return 2;
  }
  try {
    const res = getComponent(catalogFile, handle);
    if (!res.found) {
      console.error(`error  no component matches '${handle}' in ${catalogFile}`);
      return 1;
    }
    if (!res.detail) {
      console.error(`warn   '${handle}' has no variantsFile/nodeFile (no node trees were exported for it — re-run the export with variantVisuals:true) — printing the catalog entry only`);
      process.stdout.write(JSON.stringify(res.component, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(JSON.stringify(res.detail, null, 2) + "\n");
  } catch (e) {
    // `${e.message}` verbatim: a thrown non-Error prints "undefined" here, as it did.
    const message = e && typeof e === "object" && "message" in e ? e.message : undefined;
    console.error(`error  ${String(message)}`);
    return 2;
  }
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
