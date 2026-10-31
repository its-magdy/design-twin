// What the npm package carries from OUTSIDE bridge/: npm's `files` cannot reach past the package root, so `prepack`
// copies it in and `postpack` takes it out again (both gitignored; a checkout never reads these copies — the repo's
// own design-to-code/ and figma-plugin/ come first, see figma-mcp.ts loadLayer and init.ts).
//
//   layer/         the design-to-code bundles design_get_component / design_drift_lint load in an installed package.
//                  The committed claude-plugin/scripts/*.js, not design-to-code/*.ts: each bundle is self-contained
//                  (node: builtins only — its ../bridge/src imports are inlined), where the sources import
//                  ../bridge/src/*.ts, a path an installed package does not have. test/verify-build.test.ts fails
//                  when a committed bundle is stale, so a tagged commit's are its sources'.
//   figma-plugin/  the built Figma plugin (manifest.json + the committed code.js / ui.html it names), so an install
//                  can "Import plugin from manifest" — `dtwin init` prints the path.
//
// Run from bridge/ (npm runs lifecycle scripts in the package dir):  bun pack.ts [--clean]
import path from "node:path";
import fs from "node:fs";
import { PLUGIN_FILES } from "./src/plugin-install.ts";

const PKG = import.meta.dirname;
const REPO = path.join(PKG, "..");
const BUNDLES = path.join(REPO, "claude-plugin", "scripts");
// The two the MCP server loads, and every script their printed hints name (scriptCmd — cli-args.ts makes it a path
// beside the bundle itself, so a hint naming a script not shipped here would be a command that cannot run).
// pack() holds this list to that (missingHints).
export const LAYER: readonly string[] = ["get-component", "drift-lint", "map-bootstrap", "map-validate", "cross-check"];
// The files Figma loads — one list with the per-user install that copies them on (`dtwin plugin install`).
const PLUGIN: readonly string[] = PLUGIN_FILES;
export const OUT = { layer: path.join(PKG, "layer"), plugin: path.join(PKG, "figma-plugin") } as const;

/** The scripts a bundle's printed hints name (`scriptCmd("<name>")`) that `shipped` does not hold. */
export function missingHints(source: string, shipped: readonly string[]): string[] {
  return [...source.matchAll(/scriptCmd\("([\w-]+)"\)/g)].map((m) => m[1] ?? "").filter((n) => !shipped.includes(n));
}

export function clean(): void {
  for (const dir of Object.values(OUT)) fs.rmSync(dir, { recursive: true, force: true });
}

export function pack(): void {
  clean();
  fs.mkdirSync(OUT.layer, { recursive: true });
  fs.mkdirSync(OUT.plugin, { recursive: true });
  const problems: string[] = [];
  for (const n of LAYER) {
    const src = path.join(BUNDLES, n + ".js");
    const dangling = missingHints(fs.readFileSync(src, "utf8"), LAYER);
    if (dangling.length) problems.push(`${n}.js names ${dangling.join(", ")}, which the package does not ship — add it to LAYER`);
    fs.copyFileSync(src, path.join(OUT.layer, n + ".js"));
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.join(REPO, "figma-plugin", "manifest.json"), "utf8"));
  // The manifest names the files Figma loads; ship exactly those, so a renamed bundle cannot leave a manifest
  // pointing at nothing.
  if (typeof manifest !== "object" || manifest === null || !("main" in manifest) || !("ui" in manifest) ||
    !PLUGIN.includes(String(manifest.main)) || !PLUGIN.includes(String(manifest.ui))) {
    problems.push("figma-plugin/manifest.json's main/ui are not among the files shipped — update PLUGIN");
  }
  for (const f of PLUGIN) fs.copyFileSync(path.join(REPO, "figma-plugin", f), path.join(OUT.plugin, f));
  if (problems.length) {
    clean();
    throw new Error("[pack] " + problems.join("; "));
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--clean") clean();
  else {
    pack();
    console.log(`[pack] copied ${LAYER.length} design-to-code bundles to layer/ and the Figma plugin to figma-plugin/`);
  }
}
