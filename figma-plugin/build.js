// Bundles src/main.ts -> code.js (the file manifest.json loads as `main`).
// esbuild inlines every src/*.ts import into one IIFE the Figma sandbox can run directly.
// The built code.js is committed so the plugin loads with zero build for consumers;
// run `npm run build` after editing any src/*.ts.
const esbuild = require("esbuild");
const path = require("path");

// Finding 327: the plugin reported no version at all, so a stale bundle in Figma (several fixes live
// in code.js — SVG normalisation, case-folded asset names) couldn't be told apart from a fresh one:
// `code.js`'s own mtime and the plugin instance's startedAt can land in the same minute either way.
// Baked in at BUILD time (not read from manifest.json — Figma's manifest schema doesn't define a
// `version` key, and nothing enforces it staying in sync with package.json if it were just a stray
// field) so the running bundle always reports the version it was actually built from, not whatever a
// human last remembered to type somewhere.
const PLUGIN_VERSION = require("./package.json").version;

const watch = process.argv.includes("--watch");
// `--outfile <path>`: build somewhere else (a reviewer comparing a fresh bundle against the committed
// code.js, CI diffing artefacts) without touching the tree. Default is the committed code.js.
// esbuild writes its `// path` comments relative to its working directory, which "normally defaults
// to the current working directory of the process" and is used for "pretty-printing absolute paths
// as relative paths" (https://esbuild.github.io/api/#working-directory) — so a build from the repo
// root used to differ from `npm run build`'s, which runs here. `absWorkingDir` pins it to this
// directory, and the bundle is byte-identical from any cwd.
const outArg = process.argv.indexOf("--outfile");
const outfile = outArg !== -1 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(__dirname, "code.js");
const opts = {
  absWorkingDir: __dirname,
  entryPoints: [path.join(__dirname, "src", "main.ts")],
  outfile,
  bundle: true,
  format: "iife",
  target: "es2019", // Figma sandbox baseline
  legalComments: "none",
  logLevel: "info",
  define: { __PLUGIN_VERSION__: JSON.stringify(PLUGIN_VERSION) },
  banner: { js: "// GENERATED from src/*.ts by build.js — do not edit by hand. Run `npm run build`." },
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log("[build] watching src/ …");
  } else {
    await esbuild.build(opts);
    console.log("[build] wrote " + path.relative(process.cwd(), outfile));
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
