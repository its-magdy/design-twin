// test/code-scanner.test.ts — what the Stop hook reads out of a build's source (design-to-code/code-scanner.ts): the text
// that is code, colour literals and arbitrary values, whether a literal sits on a token's definition line, what a file
// imports, and the project graph. The plan policy on top (what blocks, what warns) is test/verify-build.test.ts's; token
// names in both directions are test/token-naming.test.ts's.
// Run with:  bun test/code-scanner.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { arbitraryPx, codeOf, colorLiterals, declaredCustomProps, importsOf, isSourceFile, kindsCompatible, literalUses, projectGraph, scanText } from "../design-to-code/code-scanner.ts";
import { colorKey } from "../design-to-code/color.ts";
import { check, report } from "./assert.ts";

console.log("literals:");
check("colorLiterals reads #hex, 0xAARRGGBB and rgb(), keyed rrggbb+alpha", (() => {
  const c = colorLiterals("a #5B5FC7 b Color(0xFF112233) c rgba(255, 0, 10, 0.5)");
  // opaque -> "ff"; 0xAARRGGBB puts alpha FIRST, so it must be moved to the end; rgba's 0.5 -> 80.
  return c.has("#5b5fc7ff") && c.has("#112233ff") && c.has("#ff000a80");
})());
// Alpha is part of the key: if it were folded away, #ffffff and #ffffff1a shared one key. The scan then
// reported whichever spelling it saw first — the live run said "raw literal #ffffff" for a plan row
// that read #ffffff1a, which looks like a hook bug — and an allowedLiterals entry for one exempted
// the other. They are different colors (opaque white vs a 10% scrim) and must stay different keys.
check("[alpha] 8-digit hex keeps its alpha, so it cannot collide with the opaque form", (() => {
  const c = colorLiterals("bg-[#ffffff1a] and #ffffff");
  return c.get("#ffffff1a") === "#ffffff1a" && c.get("#ffffffff") === "#ffffff" && c.size === 2;
})());
check("[alpha] colorKey normalises every spelling to 8 digits; 3- and 4-digit shorthand expand",
  colorKey("#abc") === "#aabbccff" && colorKey("#abcd") === "#aabbccdd" && colorKey("#5B5FC7") === "#5b5fc7ff"
  && colorKey("#5B5FC7CC") === "#5b5fc7cc" && colorKey("red") === null);
check("[alpha] rgba() percent and decimal alpha land on the SAME key as the #rrggbbaa spelling", (() => {
  const c = colorLiterals("rgba(255,255,255,0.1) rgb(1,2,3)");
  return c.has("#ffffff1a") && colorLiterals("rgba(255,255,255,10%)").has("#ffffff1a") && c.has("#010203ff");
})());
// rgb() literals go through color.ts parseCssColor, the same reader as the probe: percentage channels and decimal channels
// are colours too (100% = 255, CSS Color 4 §5.1); a call it cannot read (var(), a template placeholder) is not a literal.
check("[css] colorLiterals reads rgb(100% 0% 0% / 50%), rgb(10.4, 0, 0) and the modern rgb(0 0 0 / 40%); rgb(var(--x)) and rgba(${c}, 0.5) are skipped", (() => {
  const c = colorLiterals("rgb(100% 0% 0% / 50%) rgb(10.4, 0, 0) rgb(0 0 0 / 40%) rgb(var(--x)) rgba(${c}, 0.5)");
  return c.get("#ff000080") === "rgb(100% 0% 0% / 50%)" && c.has("#0a0000ff") && c.has("#00000066") && c.size === 3;
})());
check("arbitraryPx reads [Npx] and [Nrem] as px", (() => { const d = arbitraryPx("gap-[14px] p-[1.5rem]"); return d.has(14) && d.has(24); })());
// Keyed on the number alone, every `rounded-[20px]` was reported as the 20px a
// fontSize token resolves to — and applying the suggestion ("use text-body-1") would have put a
// font-size utility on a border-radius, which the gate would then have passed.
check("[kind] an arbitrary value remembers which utility it was on", (() => {
  const d = arbitraryPx("rounded-[20px] text-[20px]");
  const u = (d.get(20) || []).map((e) => e.utility).sort();
  return u.length === 2 && u[0] === "rounded" && u[1] === "text";
})());
check("[kind] a utility's kind gates which token kind its number can be; an unknown utility or kind keeps the check",
  kindsCompatible("rounded", "radius") && !kindsCompatible("rounded", "fontSize") && kindsCompatible("gap-x", "spacing") && kindsCompatible(null, "fontSize") && kindsCompatible("blob", "radius") && kindsCompatible("text", ""));

console.log("the text that is code:");
check("scanText drops //, /* */, JSX {/* */} and <!-- --> comments but keeps code", (() => {
  const t = scanText("a.tsx", "// #111111\nconst a = 1; /* #222222 */\n<div>{/* #333333 */}</div>\nconst b = '#444444';");
  const h = scanText("a.vue", "<!-- #555555 -->\n<p style=\"color:#666666\"></p>");
  return !/#111111|#222222|#333333/.test(t) && /#444444/.test(t) && !/#555555/.test(h) && /#666666/.test(h);
})());
check("a prose string (provenance note) is skipped; a style string is not", (() => {
  const t = scanText("a.tsx", "const note = \"bound to Neutrals/Neutral 0, which is #121319 in Dark\";\nconst c = \"#121319\";\nconst b = '1px solid #121319';\nconst k = 'flex items center bg-[#121319]';");
  return (t.match(/#121319/g) || []).length === 3 && !/Neutral 0, which/.test(t);
})());
check("`https://` in code is not mistaken for a comment", /#777777/.test(scanText("a.ts", "fetch(`https://x.test/a`); const c = '#777777';")));
check("isSourceFile: .tsx/.css/.swift/.kt are code; .svg/.json/.md/.png are not",
  ["a.tsx", "a.css", "A.swift", "A.kt", "a.dart"].every(isSourceFile) && !["a.svg", "tokens.json", "README.md", "x.png"].some(isSourceFile));
check("codeOf keeps only the source files, as their scanText", (() => {
  const c = codeOf([{ rel: "a.tsx", text: "// #111111\nconst b = '#222222';" }, { rel: "x.svg", text: "<path stroke=\"#333333\"/>" }]);
  return c.length === 1 && c[0]?.rel === "a.tsx" && !/#111111/.test(c[0]?.text ?? "") && /#222222/.test(c[0]?.text ?? "");
})());

console.log("definition lines (literalUses):");
check("[defs] a literal only on its token's definition line is found and used nowhere", (() => {
  const u = literalUses([{ rel: "theme.css", text: ":root {\n  --brand-600: #5B5FC7;\n}" }], "#5B5FC7", ["brand-600"]);
  return u.found && !u.usedIn.length;
})());
check("[defs] the same literal in a component is a use, named by its file", (() => {
  const u = literalUses([{ rel: "theme.css", text: "--brand-600: #5B5FC7;" }, { rel: "Card.tsx", text: "style={{ color: '#5B5FC7' }}" }], "#5B5FC7", ["brand-600"]);
  return u.found && u.usedIn.join() === "Card.tsx";
})());
check("[defs] in a stylesheet only a custom property declares a token; a plain property is a use", (() => {
  const u = literalUses([{ rel: "a.css", text: ".x { border-color: #e5e5e5 }" }], "#e5e5e5", ["border", "input"]);
  return u.usedIn.join() === "a.css";
})());
check("[defs] two tokens sharing one value, both defined on ONE line → neither is a use of the other", (() => {
  const u = literalUses([{ rel: "t.css", text: ":root { --color-surface: #1d1d1f; --color-canvas: #1d1d1f; }" }], "#1d1d1f", ["surface", "canvas"]);
  return u.found && !u.usedIn.length && literalUses([{ rel: "t.css", text: ":root { --color-surface: #1d1d1f; --color-canvas: #1d1d1f; }" }], "#1d1d1f", ["surface"]).usedIn.join() === "t.css";
})());
check("[defs] an exempt file (allowedLiterals {file}) is found but never a use", (() => {
  const u = literalUses([{ rel: "gen.css", text: ".x{background:#5B5FC7}" }], "#5B5FC7", ["brand-600"], ["gen.css"]);
  return u.found && !u.usedIn.length;
})());
check("[defs] a literal nowhere in the code is not found", (() => { const u = literalUses([{ rel: "a.tsx", text: "x" }], "#5B5FC7", ["brand-600"]); return !u.found && !u.usedIn.length; })());
check("declaredCustomProps: every --x: in the files, lower-cased, comments stripped", (() => {
  const d = declaredCustomProps([{ rel: "a.css", text: "/* --gone: 1 */ :root { --Color-Brand: #fff; --gap:4px }" }]);
  return d.has("--color-brand") && d.has("--gap") && !d.has("--gone");
})());

console.log("imports and the project graph:");
check("importsOf reads ES/CJS/dynamic/CSS imports",
  importsOf("import { A } from '../A';\nimport type { B } from \"@/B\";\nexport { C } from './C';\nconst d = require('d');\nimport('./e');\n@import url('f.css');").join(",") === "../A,@/B,./C,d,./e,f.css");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-scan-"));
  const put = (rel: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put("src/App.tsx", "import { Page } from './Page';\nimport { Shell } from './Shell';");
  put("src/Page.tsx", "import { A } from './screens/A';\nimport { B } from './screens/B';");
  put("src/Shell.tsx", "import { Sidebar } from './Sidebar';");
  put("src/Sidebar.tsx", "export const Sidebar = 1;");
  put("src/screens/A.tsx", "import { Row } from '../Row';");
  put("src/screens/B.tsx", "import { Only } from '../OnlyB';");
  put("src/Row.tsx", "x"); put("src/OnlyB.tsx", "x");
  // two plans: A's and B's own files, both listing the shared app shell
  const g = projectGraph(root, [["src/screens/A.tsx", "src/App.tsx", "src/Page.tsx", "src/Shell.tsx"], ["src/screens/B.tsx", "src/App.tsx", "src/Page.tsx", "src/Shell.tsx"]], ["src/Sidebar.tsx", "src/Row.tsx", "src/OnlyB.tsx"]);
  const reach = new Set(g.reachable(["src/screens/A.tsx"]).map((f) => f.rel));
  check("[graph] listCount counts the lists naming each file", g.listCount.get("src/App.tsx") === 2 && g.listCount.get("src/screens/A.tsx") === 1 && !g.listCount.has("src/Row.tsx"));
  check("[graph] a screen reaches its imports, its ancestors and what a shared ancestor imports…",
    ["src/screens/A.tsx", "src/Row.tsx", "src/Page.tsx", "src/App.tsx", "src/Shell.tsx"].every((r) => reach.has(r)));
  check("[graph] …but not another screen's own file (listed by one plan only)", !reach.has("src/screens/B.tsx") && !reach.has("src/OnlyB.tsx"));
  check("[graph] cached() answers with the bytes it read until the run rewrites the file", (() => {
    const had = g.cached("src/Row.tsx")?.toString("utf8") === "x";
    g.rewrote(path.join(root, "src/Row.tsx"));
    return had && g.cached("src/Row.tsx") === undefined;
  })());
  check("[graph] scan() finds the project's .css files and a tailwind.config", (() => {
    put("styles/app.css", ":root { --x: 1px }"); put("tailwind.config.ts", "export default {}");
    const s = projectGraph(root, []).scan();
    return s.tailwindConfig && s.css.some((f) => f.rel === "styles/app.css");
  })());
  fs.rmSync(root, { recursive: true, force: true });
}

report();
