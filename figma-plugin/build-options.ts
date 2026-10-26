// The one spelling of how the plugin's two committed build outputs are made: src/main.ts bundled into code.js, and
// ui.html — ui.template.html with src/relay.ts bundled into its script. build.ts writes the committed files with it,
// and the tests build the same outputs in memory from the current sources (test/fake-figma.ts the bundle,
// test/ui.test.ts the window), so the plugin under test is never a stale build. Side-effect free: importing it
// builds nothing.
import fs from "node:fs";
import path from "node:path";
import esbuild, { type BuildOptions } from "esbuild";
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
export const UI_HTML = path.join(PLUGIN_DIR, "ui.html");
export const UI_TEMPLATE = path.join(PLUGIN_DIR, "ui.template.html");
/** Where the relay bundle goes in the template's script. */
const RELAY_MARKER = "/*@relay*/";

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

/** src/relay.ts as one script declaring the global `DesignTwinRelay` (its exports), for the window's script.
 *  Never written on its own: renderUiHtml inlines it (the plugin's UI is the one HTML file manifest.json names). */
export function relayBuildOptions(): BuildOptions {
  return {
    absWorkingDir: PLUGIN_DIR,
    entryPoints: [path.join(PLUGIN_DIR, "src", "relay.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "DesignTwinRelay",
    target: "es2019", // the iframe is a browser, but nothing here needs newer than code.js's baseline
    legalComments: "none",
    logLevel: "silent",
  };
}

/** ui.html's text: the template with its marker replaced by the relay bundle `relayJs`. */
export function uiHtmlFrom(template: string, relayJs: string): string {
  const at = template.indexOf(RELAY_MARKER);
  if (at === -1 || template.indexOf(RELAY_MARKER, at + 1) !== -1) throw new Error(`ui.template.html must hold ${RELAY_MARKER} exactly once`);
  // esbuild opens the bundle with the "use strict" directive (tsconfig's strict); at the head of the window's one
  // script it would turn the whole script strict, which the window's own code has never run as. Dropped: the relay's
  // code means the same either way.
  const js = relayJs.replace(/^"use strict";\n/, "").trimEnd();
  // Inlined, a `</script` anywhere in the bundle (a string literal, a comment) would end the window's script there.
  if (/<\/script/i.test(js)) throw new Error("src/relay.ts's bundle contains `</script`, which would end ui.html's script early");
  // The banner is part of the committed ui.html bytes, so a hand edit there reads as an edit to a build output.
  return "<!-- GENERATED from ui.template.html + src/relay.ts by build.ts — do not edit by hand. Run `bun run build`. -->\n"
    + template.slice(0, at) + js + template.slice(at + RELAY_MARKER.length);
}

/** ui.html's text, built from the current ui.template.html and src/relay.ts. */
export async function renderUiHtml(): Promise<string> {
  const r = await esbuild.build(relayBuildOptions());
  const js = r.outputFiles?.[0]?.text;
  if (js === undefined) throw new Error("esbuild produced no bundle for figma-plugin/src/relay.ts");
  return uiHtmlFrom(fs.readFileSync(UI_TEMPLATE, "utf8"), js);
}
