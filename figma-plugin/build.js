// Bundles src/main.ts -> code.js (the file manifest.json loads as `main`).
// esbuild inlines every src/*.ts import into one IIFE the Figma sandbox can run directly.
// The built code.js is committed so the plugin loads with zero build for consumers;
// run `npm run build` after editing any src/*.ts.
const esbuild = require("esbuild");
const path = require("path");

const watch = process.argv.includes("--watch");
const opts = {
  entryPoints: [path.join(__dirname, "src", "main.ts")],
  outfile: path.join(__dirname, "code.js"),
  bundle: true,
  format: "iife",
  target: "es2019", // Figma sandbox baseline
  legalComments: "none",
  logLevel: "info",
  banner: { js: "// GENERATED from src/*.ts by build.js — do not edit by hand. Run `npm run build`." },
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log("[build] watching src/ …");
  } else {
    await esbuild.build(opts);
    console.log("[build] wrote code.js");
  }
}
run().catch((e) => { console.error(e); process.exit(1); });
