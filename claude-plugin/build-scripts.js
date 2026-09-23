// Bundles design-to-code/*.js -> claude-plugin/scripts/*.js (committed; the skills call them as
// ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.js).
//
// Why a bundle and not a copy or a symlink: an installed plugin is ONLY the claude-plugin/ directory.
// drift-lint.js and get-component.js require ../bridge/*.js, which does not exist there, and a symlink
// pointing outside the plugin directory is not installed at all — so either one ships a plugin whose
// Stop hook and every scripts/ call fail. bundle:true inlines those requires, so each output file is
// self-contained (Node builtins only).
//
// Run from the repo root:  node claude-plugin/build-scripts.js [outDir]
// test/design-to-code.test.js rebuilds into a temp dir and fails if scripts/ is stale — the same
// committed-artifact gate figma-plugin/code.js and bridge/figma-mcp.mjs have.
const path = require("path");
const fs = require("fs");

// esbuild is a devDependency of bridge/ (and figma-plugin/) — there is no root package.json.
const esbuild = require(require.resolve("esbuild", { paths: [path.join(__dirname, "..", "bridge"), path.join(__dirname, "..", "figma-plugin")] }));

const SRC = path.join(__dirname, "..", "design-to-code");
// The CLI entry points. kinds.js / catalog-input.js are libraries — they get inlined, not shipped.
const ENTRIES = ["audit", "cross-check", "design-diff", "drift-lint", "get-component", "map-bootstrap", "map-validate", "resolve-screen", "tokens", "verify-build", "verify-screen"];

function build(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  return esbuild.build({
    entryPoints: ENTRIES.map((n) => path.join(SRC, n + ".js")),
    outdir: outDir,
    // esbuild writes each inlined module's path (relative to the working dir) into the output as a
    // comment — pin it to the repo root so the bytes don't depend on where the build was run from.
    absWorkingDir: path.join(__dirname, ".."),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    banner: { js: "// GENERATED from design-to-code/ by claude-plugin/build-scripts.js — edit the source, then rebuild." },
    logLevel: "silent",
  });
}

module.exports = { build, ENTRIES };

if (require.main === module) {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, "scripts"));
  build(outDir)
    .then(() => console.log(`[build-scripts] wrote ${ENTRIES.length} scripts to ${outDir}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
