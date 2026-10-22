// The one spelling of how src/main.ts is bundled into code.js. build.ts writes the committed bundle with it, and
// the harness (test/fake-figma.ts) builds the same bundle in memory from the current src/, so the plugin under test
// is never a stale code.js. Side-effect free: importing it builds nothing.
import path from "node:path";
import type { BuildOptions } from "esbuild";
// Finding 327: the plugin reported no version at all, so a stale bundle in Figma (several fixes live
// in code.js — SVG normalisation, case-folded asset names) couldn't be told apart from a fresh one:
// `code.js`'s own mtime and the plugin instance's startedAt can land in the same minute either way.
// Baked in at BUILD time (not read from manifest.json — Figma's manifest schema doesn't define a
// `version` key, and nothing enforces it staying in sync with package.json if it were just a stray
// field) so the running bundle always reports the version it was actually built from, not whatever a
// human last remembered to type somewhere.
import pkg from "./package.json" with { type: "json" };

export const PLUGIN_VERSION = pkg.version;
export const PLUGIN_DIR = import.meta.dirname;
export const CODE_JS = path.join(PLUGIN_DIR, "code.js");

// esbuild writes its `// path` comments relative to its working directory, which "normally defaults
// to the current working directory of the process" and is used for "pretty-printing absolute paths
// as relative paths" (https://esbuild.github.io/api/#working-directory) — so a build from the repo
// root used to differ from `bun run build`'s, which runs here. `absWorkingDir` pins it to this
// directory, and the bundle is byte-identical from any cwd.
export function pluginBuildOptions(outfile: string = CODE_JS): BuildOptions {
  return {
    absWorkingDir: PLUGIN_DIR,
    entryPoints: [path.join(PLUGIN_DIR, "src", "main.ts")],
    outfile,
    bundle: true,
    format: "iife",
    target: "es2019", // Figma sandbox baseline
    legalComments: "none",
    logLevel: "info",
    define: { __PLUGIN_VERSION__: JSON.stringify(PLUGIN_VERSION) },
    // The banner is part of the committed code.js bytes: changing it changes every bundle.
    banner: { js: "// GENERATED from src/*.ts by build.ts — do not edit by hand. Run `bun run build`." },
  };
}
