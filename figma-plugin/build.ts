// Bundles src/main.ts -> code.js (the file manifest.json loads as `main`).
// esbuild inlines every src/*.ts import into one IIFE the Figma sandbox can run directly.
// The built code.js is committed so the plugin loads with zero build for consumers;
// run `bun run build` after editing any src/*.ts. The bundle options live in build-options.ts,
// which the harness builds from too.
import path from "node:path";
import esbuild from "esbuild";
import { CODE_JS, pluginBuildOptions } from "./build-options.ts";

const watch = process.argv.includes("--watch");
// `--outfile <path>`: build somewhere else (a reviewer comparing a fresh bundle against the committed
// code.js, CI diffing artefacts) without touching the tree. Default is the committed code.js.
const outArg = process.argv.indexOf("--outfile");
const outPath = outArg !== -1 ? process.argv[outArg + 1] : undefined;
const outfile = outPath ? path.resolve(outPath) : CODE_JS;
const opts = pluginBuildOptions(outfile);

async function run(): Promise<void> {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log("[build] watching src/ …");
  } else {
    await esbuild.build(opts);
    console.log("[build] wrote " + path.relative(process.cwd(), outfile));
  }
}
run().catch((e: unknown) => { console.error(e); process.exit(1); });
