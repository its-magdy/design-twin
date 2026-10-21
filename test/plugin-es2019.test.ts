// The Figma plugin's main thread must stay ES2019: the sandbox it runs in predates `??` and `?.`, and a
// bundle that uses either fails to PARSE — the whole plugin is dead on import, with no error a designer
// can read. esbuild hides this from us: build.ts targets es2019, so esbuild silently LOWERS `a ?? b` to
// `(_a = a) != null ? _a : b` and the committed code.js looks fine — until a syntax esbuild cannot lower
// slips in, or the lowering is lost. So the source is held to ES2019 itself:
//   1. the committed figma-plugin/code.js parses as an ES2019 script (acorn, ecmaVersion 2019 — it rejects
//      `??`, `?.`, class fields, BigInt literals, `||=`, dynamic import, import.meta, the regex `d`/`v` flags …);
//   2. the sources (src/*.ts plus the bridge/src modules it inlines) bundle IDENTICALLY for es2019, es2020 and
//      esnext — i.e. esbuild lowers nothing, so no syntax depends on a transform — and that bundle parses as
//      ES2019 too (so a syntax esbuild passes through untouched is still caught);
//   3. negative controls: the parser and the comparison both fail on the syntax they exist to catch, so a
//      vacuous pass (acorn option ignored, build options that no longer lower anything) cannot hide.
// acorn is the one extra devDependency (figma-plugin/package.json, zero deps): esbuild alone cannot REJECT
// newer syntax — given JS it lowers or passes it through, it never refuses it by version.
//   bun test/plugin-es2019.test.ts
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import * as esbuild from "esbuild";
import { check, report } from "./assert.ts";

const PLUGIN = path.join(import.meta.dirname, "..", "figma-plugin");
const version = (JSON.parse(fs.readFileSync(path.join(PLUGIN, "package.json"), "utf8")) as { version: string }).version;

// null = parses as an ES2019 script; otherwise acorn's message (with its line:col).
function es2019Error(code: string): string | null {
  try { acorn.parse(code, { ecmaVersion: 2019, sourceType: "script" }); return null; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
}

// ---- 1. the committed bundle
const committed = fs.readFileSync(path.join(PLUGIN, "code.js"), "utf8");
const committedErr = es2019Error(committed);
if (committedErr !== null) console.log("    code.js: " + committedErr);
check("figma-plugin/code.js parses as ES2019 (no ??, ?., class fields, BigInt, …)", committedErr === null);
check("…as a script, not a module (no top-level import/export)", acorn.parse(committed, { ecmaVersion: 2019, sourceType: "script" }).body.every((n) => !/^(?:Import|Export)/.test(n.type)));

// ---- 2. the sources, built like build.ts but in memory, for three targets
// The same options as build.ts apart from `target` / `write` / logging: if build.ts's bundle options change,
// change them here (this guards the SYNTAX of the sources, it is not a second copy of the build).
async function bundle(target: string): Promise<string> {
  const r = await esbuild.build({
    absWorkingDir: PLUGIN,
    entryPoints: [path.join(PLUGIN, "src", "main.ts")],
    outfile: path.join(PLUGIN, "code.js"),
    write: false,
    bundle: true,
    format: "iife",
    target,
    legalComments: "none",
    logLevel: "silent",
    define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  });
  const out = r.outputFiles[0];
  return out === undefined ? "" : out.text;
}
const [b2019, b2020, bNext] = await Promise.all([bundle("es2019"), bundle("es2020"), bundle("esnext")]);
check("the sources bundle to something (non-empty es2019 build)", b2019.length > 1000);
check("es2019 build == es2020 build (esbuild lowers nothing for ES2020: no ??, ?., … in the sources)", b2019 === b2020);
check("es2019 build == esnext build (no syntax in the sources depends on lowering at all)", b2019 === bNext);
const nextErr = es2019Error(bNext);
if (nextErr !== null) console.log("    esnext build: " + nextErr);
check("the un-lowered (esnext) bundle of the sources parses as ES2019", nextErr === null);
check("no esbuild lowering helper or temp in the es2019 build (__async, __spread*, __privateGet, `var _a;`)",
  !/\b__(?:async|spread\w*|objRest|publicField|privateGet|privateSet|privateAdd|forAwait|template)\b/.test(b2019) && !/^\s*var _a;$/m.test(b2019));
check("the committed code.js carries no lowered-nullish residue (`(_a = x) != null`)", !/\(_a = [^;]*\) (?:!=|==) null\b/.test(committed));

// ---- 3. negative controls
const NEWER: Array<[string, string]> = [
  ["nullish coalescing", "var a = b ?? c;"],
  ["optional chaining", "var a = b?.c;"],
  ["optional call", "var a = b?.();"],
  ["logical assignment", "a ||= b;"],
  ["class field", "class A { x = 1; }"],
  ["private field", "class A { #x = 1; }"],
  ["BigInt literal", "var a = 1n;"],
  ["dynamic import", "import(\"x\");"],
  ["import.meta", "var a = import.meta;"],
  ["numeric separator", "var a = 1_000;"],
  ["regex d flag", "var a = /a/d;"],
  ["regex v flag", "var a = /a/v;"],
  ["top-level await", "await x;"],
];
for (const [what, src] of NEWER) check("negative control: the ES2019 parse rejects " + what, es2019Error(src) !== null);
const OLDER: Array<[string, string]> = [
  ["optional catch binding (ES2019)", "try { f(); } catch { g(); }"],
  ["object spread and rest (ES2018)", "var a = { ...b }; var { c, ...d } = a;"],
  ["async function and for await (ES2018)", "(async function () { for await (var x of y) {} })();"],
  ["regex lookbehind and named group (ES2018)", "var a = /(?<=a)(?<n>b)/;"],
  ["exponent operator (ES2016)", "var a = 2 ** 3;"],
];
for (const [what, src] of OLDER) check("positive control: the ES2019 parse accepts " + what, es2019Error(src) === null);

// The equality checks above would pass vacuously if the target stopped mattering: prove esbuild DOES lower
// ES2020 syntax for es2019 here, so "es2019 == esnext" really means "there was nothing to lower".
const lowered = await esbuild.transform("var a = b ?? c; var d = e?.f;", { target: "es2019", logLevel: "silent" });
const kept = await esbuild.transform("var a = b ?? c; var d = e?.f;", { target: "esnext", logLevel: "silent" });
check("negative control: esbuild lowers ?? and ?. for es2019 and keeps them for esnext", lowered.code !== kept.code && /\?\?|\?\./.test(kept.code) && !/\?\?|\?\./.test(lowered.code));
check("negative control: that lowered form (what unguarded source would ship) parses as ES2019, the kept one does not", es2019Error(lowered.code) === null && es2019Error(kept.code) !== null);

report();
