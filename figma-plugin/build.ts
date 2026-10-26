// Builds the plugin's two committed outputs, the files manifest.json loads:
//   code.js  (`main`) — esbuild inlines every src/*.ts import of src/main.ts into one IIFE the Figma sandbox runs;
//   ui.html  (`ui`)   — ui.template.html with src/relay.ts (the bridge protocol's plugin half) bundled into its script.
// Both are committed so the plugin loads with zero build for consumers; run `bun run build` after editing any
// src/*.ts or ui.template.html. The build options live in build-options.ts, which the tests build from too.
import fs from "node:fs";
import path from "node:path";
import esbuild, { type Plugin } from "esbuild";
import { CODE_JS, UI_HTML, UI_TEMPLATE, pluginBuildOptions, relayBuildOptions, uiHtmlFrom } from "./build-options.ts";

const watch = process.argv.includes("--watch");
// `--outfile <path>` / `--ui-outfile <path>`: build somewhere else (a reviewer comparing a fresh build against the
// committed files, CI diffing artefacts) without touching the tree. Defaults are the committed code.js / ui.html; an
// `--outfile` alone puts ui.html beside it, so the old one-flag form never rewrites the committed ui.html.
const argPath = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ? path.resolve(v) : undefined;
};
const outArg = argPath("--outfile");
const outfile = outArg ?? CODE_JS;
const uiOutfile = argPath("--ui-outfile") ?? (outArg ? path.join(path.dirname(outArg), "ui.html") : UI_HTML);
const opts = pluginBuildOptions(outfile);

// Each relay build writes ui.html from its output and the template as it is then. The relay's options are silent (the
// tests build them too), so its errors are printed here — under --watch nothing else would say ui.html went stale.
let uiFailed = false;
const writeUi: Plugin = {
  name: "write-ui-html",
  setup(b) {
    b.onEnd((r) => {
      const js = r.outputFiles?.[0]?.text;
      uiFailed = r.errors.length > 0 || js === undefined;
      if (r.errors.length > 0) {
        for (const m of esbuild.formatMessagesSync(r.errors, { kind: "error" })) console.error(m);
        return;
      }
      if (js === undefined) { console.error("[build] esbuild produced no bundle for src/relay.ts"); return; }
      try {
        fs.writeFileSync(uiOutfile, uiHtmlFrom(fs.readFileSync(UI_TEMPLATE, "utf8"), js));
        console.log("[build] wrote " + path.relative(process.cwd(), uiOutfile));
      } catch (e) {
        uiFailed = true;
        console.error("[build] ui.html not written: " + (e instanceof Error ? e.message : String(e)));
      }
    });
  },
};
const uiOpts = { ...relayBuildOptions(), plugins: [writeUi] };

async function run(): Promise<void> {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    const uiCtx = await esbuild.context(uiOpts);
    await uiCtx.watch();
    // esbuild watches the relay's imports, not the template it is spliced into. The directory, not the file: an editor
    // that saves by rename replaces the file a file watch was holding.
    const template = path.basename(UI_TEMPLATE);
    fs.watch(path.dirname(UI_TEMPLATE), (_ev, name) => {
      if (name === template) uiCtx.rebuild().catch((e: unknown) => console.error(e));
    });
    console.log("[build] watching src/ and ui.template.html …");
  } else {
    await esbuild.build(opts);
    console.log("[build] wrote " + path.relative(process.cwd(), outfile));
    await esbuild.build(uiOpts).catch(() => { uiFailed = true; }); // its errors are printed by writeUi
    if (uiFailed) process.exit(1);
  }
}
run().catch((e: unknown) => { console.error(e); process.exit(1); });
