// Bundles design-to-code/*.ts -> claude-plugin/scripts/*.js (committed; the skills call them as
// ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js).
//
// Why a bundle and not a copy or a symlink: an installed plugin is ONLY the claude-plugin/ directory.
// drift-lint.ts and get-component.ts import ../bridge/src/*.ts, which does not exist there, and a symlink
// pointing outside the plugin directory is not installed at all — so either one ships a plugin whose
// Stop hook and every scripts/ call fail. bundle:true inlines those imports, so each output file is
// self-contained (Node builtins only).
//
// Why one esbuild build PER ENTRY, with the inlined-CLI-guard plugin: every design-to-code module ends in
// an `if (import.meta.main) { …CLI… }` block. In an ESM bundle every inlined module's `import.meta` IS the
// bundle's own, so `import.meta.main` is true for all of them — verify-build.js would run cross-check's
// CLI (then exit) instead of its own, silently no-op'ing the Stop hook. (Under CJS the equivalent
// `require.main === module` compared against the inner module object and was false.) So each entry is
// built on its own, and in every OTHER design-to-code module the plugin rewrites `import.meta.main` to
// `false` before esbuild sees it; only the entry keeps a live guard (exactly one per bundle).
//
// Run from the repo root:  node claude-plugin/build-scripts.ts [outDir]
// test/verify-build.test.ts rebuilds into a temp dir and fails if scripts/ is stale — the same
// committed-artifact gate figma-plugin/code.js has.
import path from "node:path";
import fs from "node:fs";
// esbuild is a devDependency of the bridge/ and figma-plugin/ workspaces, hoisted to the repo-root
// node_modules — the bare specifier resolves there.
import esbuild, { type BuildResult, type Plugin } from "esbuild";

const SRC = path.join(import.meta.dirname, "..", "design-to-code");
// The CLI entry points. kinds.ts / catalog-input.ts are libraries — they get inlined, not shipped.
const ENTRIES: readonly string[] = ["audit", "cross-check", "design-diff", "drift-lint", "get-component", "map-bootstrap", "map-validate", "plan-skeleton", "resolve-screen", "tokens", "verify-build", "verify-screen"];

// Rewrites `import.meta.main` to `false` in every design-to-code module except `entry` (see header).
function inlinedCliGuard(entry: string): Plugin {
  return {
    name: "inlined-cli-guard",
    setup(b) {
      b.onLoad({ filter: /[\\/]design-to-code[\\/][^\\/]+\.ts$/ }, async (args) => {
        const src = await fs.promises.readFile(args.path, "utf8");
        return { contents: path.resolve(args.path) === entry ? src : src.replaceAll("import.meta.main", "false"), loader: "ts" };
      });
    },
  };
}

function build(outDir: string): Promise<BuildResult[]> {
  fs.mkdirSync(outDir, { recursive: true });
  return Promise.all(ENTRIES.map((n) => {
    const entry = path.resolve(SRC, n + ".ts");
    return esbuild.build({
      entryPoints: [entry],
      outdir: outDir,
      // esbuild writes each inlined module's path (relative to the working dir) into the output as a
      // comment — pin it to the repo root so the bytes don't depend on where the build was run from.
      absWorkingDir: path.join(import.meta.dirname, ".."),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      // Part of every committed scripts/*.js, so it still names build-scripts.js (the pre-TS name).
      banner: { js: "// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild.\n" },
      plugins: [inlinedCliGuard(entry)],
      logLevel: "silent",
    });
  }));
}

export { build, ENTRIES };

if (import.meta.main) {
  const outDir = path.resolve(process.argv[2] || path.join(import.meta.dirname, "scripts"));
  build(outDir)
    .then(() => console.log(`[build-scripts] wrote ${ENTRIES.length} scripts to ${outDir}`))
    .catch((e: unknown) => { console.error(e); process.exit(1); });
}
