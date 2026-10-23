// The read plan (bridge/src/read-plan.ts): what a front-end SENDS for a read scope — command, arguments,
// time budget, label — or the read options it refuses. Pure: no bridge, no plugin, no port.
//   bun test/read-plan.test.ts
// The expected values are what both front-ends sent on the commit before the plan existed (16623e5,
// recorded end to end through a daemon — read-plan-e2e.test.ts keeps that recording live), with the one
// approved change: a design-system pull always says variantVisuals as a boolean.
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { planRead, readOptsFor } from "../bridge/src/read-plan.ts";
import type { ReadScope } from "../bridge/src/read-plan.ts";
import { READ_OPTS } from "../bridge/src/read-opts.ts";
import { cliReadPlan, parseArgs } from "../bridge/src/figma-pull.ts";

const OFF = '"css":false,"measurements":false,"pluginData":false,"motion":false,"sharedData":false,"variantVisuals":false,"skipAssets":false';
type Want = { cmd: string; args: string; timeout: number; label: string };
const plan = (s: ReadScope, opts: Partial<Record<string, boolean>> = {}, o: { timeoutMs?: number } = {}): Want | { refused: string[] } => {
  const p = planRead(s, opts, o);
  return "refused" in p ? { refused: [...p.refused] } : { cmd: p.cmd, args: JSON.stringify(p.args), timeout: p.timeout, label: p.label };
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

console.log("\nread plan — each scope's command, arguments, budget and label:");
const cases: Array<[string, ReadScope, Want]> = [
  ["node", { kind: "node", nodeId: "1:2" }, { cmd: "exportNode", args: `{"nodeId":"1:2",${OFF}}`, timeout: 300000, label: "node 1:2" }],
  ["selection (its own, smaller tier)", { kind: "selection" }, { cmd: "exportSelection", args: `{${OFF}}`, timeout: 120000, label: "selection" }],
  ["the current page", { kind: "pages", allPages: false, pages: [] }, { cmd: "exportFull", args: `{"allPages":false,${OFF}}`, timeout: 300000, label: "current page" }],
  ["named pages", { kind: "pages", allPages: false, pages: ["P1", "P2"] }, { cmd: "exportFull", args: `{"allPages":false,"page":["P1","P2"],${OFF}}`, timeout: 300000, label: "page(s) P1, P2" }],
  ["a blank selector is forwarded (the plugin warns and says what it exported)", { kind: "pages", allPages: false, pages: [""] }, { cmd: "exportFull", args: `{"allPages":false,"page":[""],${OFF}}`, timeout: 300000, label: "page(s) " }],
  ["all pages (the whole-file tier)", { kind: "pages", allPages: true, pages: [] }, { cmd: "exportFull", args: `{"allPages":true,${OFF}}`, timeout: 900000, label: "all pages" }],
  ["all pages plus a page is forwarded (collectFull refuses it, one guard for every caller)", { kind: "pages", allPages: true, pages: ["P1"] }, { cmd: "exportFull", args: `{"allPages":true,"page":["P1"],${OFF}}`, timeout: 900000, label: "all pages" }],
  ["the design system: variantVisuals always said", { kind: "designSystem" }, { cmd: "exportDesignSystem", args: '{"variantVisuals":false}', timeout: 300000, label: "design system only" }],
  ["a library", { kind: "library", name: "Lib" }, { cmd: "exportLibrary", args: '{"asLibrary":"Lib","variantVisuals":false}', timeout: 300000, label: 'library "Lib"' }],
  ["a screenshot", { kind: "screenshot", nodeId: "1:2" }, { cmd: "screenshot", args: '{"nodeId":"1:2"}', timeout: 300000, label: "screenshot of 1:2" }],
  ["a screenshot at a scale", { kind: "screenshot", nodeId: "1:2", scale: 2 }, { cmd: "screenshot", args: '{"nodeId":"1:2","scale":2}', timeout: 300000, label: "screenshot of 1:2" }],
];
for (const [name, s, want] of cases) check(name, same(plan(s), want));

console.log("\nread plan — read options:");
check("a given option is sent as true, the rest as false, in registry order",
  same(plan({ kind: "node", nodeId: "1:2" }, { css: true, skipAssets: true }), { cmd: "exportNode", args: `{"nodeId":"1:2",${OFF.replace('"css":false', '"css":true').replace('"skipAssets":false', '"skipAssets":true')}}`, timeout: 300000, label: "node 1:2" }));
check("variantVisuals reaches the design system", same(plan({ kind: "designSystem" }, { variantVisuals: true }), { cmd: "exportDesignSystem", args: '{"variantVisuals":true}', timeout: 300000, label: "design system only" }));
check("and a library", same(plan({ kind: "library", name: "Lib" }, { variantVisuals: true }), { cmd: "exportLibrary", args: '{"asLibrary":"Lib","variantVisuals":true}', timeout: 300000, label: 'library "Lib"' }));
check("a walk option on the design system is refused, every one named in registry order",
  same(plan({ kind: "designSystem" }, { skipAssets: true, css: true, variantVisuals: true }), { refused: ["css", "skipAssets"] }));
check("and on a library", same(plan({ kind: "library", name: "Lib" }, { measurements: true }), { refused: ["measurements"] }));
check("a screenshot reads no option at all, variantVisuals included", same(plan({ kind: "screenshot", nodeId: "1:2" }, { css: true, variantVisuals: true }), { refused: ["css", "variantVisuals"] }));
check("an option given as false is never refused (the CLI hands every one over)",
  !("refused" in plan({ kind: "designSystem" }, Object.fromEntries(READ_OPTS.map((o) => [o.name, false])))));
check("an option given as undefined is never refused (an MCP call that omitted it)", !("refused" in plan({ kind: "screenshot", nodeId: "1:2" }, { css: undefined })));
check("variantVisuals is still accepted on a node pull (as it was — inert there, a decision for later)", !("refused" in plan({ kind: "node", nodeId: "1:2" }, { variantVisuals: true })));

console.log("\nread plan — the time budget:");
const scopes: ReadScope[] = [...cases.map((c) => c[1])];
check("an override replaces the budget of every scope", scopes.every((s) => { const p = plan(s, {}, { timeoutMs: 7000 }); return "timeout" in p && p.timeout === 7000; }));

console.log("\nread plan — each option's scopes (the registry rows):");
const names = (k: Parameters<typeof readOptsFor>[0]): string[] => readOptsFor(k).map((o) => o.name);
const ALL = READ_OPTS.map((o) => o.name);
check("node, selection and pages read every option", same(names("node"), ALL) && same(names("selection"), ALL) && same(names("pages"), ALL));
check("the design system and a library read variantVisuals only", same(names("designSystem"), ["variantVisuals"]) && same(names("library"), ["variantVisuals"]));
check("a screenshot reads none", names("screenshot").length === 0);
check("every row declares its scopes", READ_OPTS.every((o) => Array.isArray(o.scopes) && o.scopes.length > 0));

console.log("\nread plan — the CLI's command line, through the plan:");
const cli = (args: string[]): Want | { refused: string[] } | null => {
  const p = cliReadPlan(parseArgs(args));
  return !p ? null : "refused" in p ? { refused: [...p.refused] } : { cmd: p.cmd, args: JSON.stringify(p.args), timeout: p.timeout, label: p.label };
};
check("dtwin pull --node 1:2", same(cli(["--node", "1:2"]), cases[0]?.[2]));
check("dtwin pull --selection", same(cli(["--selection"]), cases[1]?.[2]));
check("dtwin pull (the current page)", same(cli([]), cases[2]?.[2]));
check("dtwin pull --page P1 --page P2", same(cli(["--page", "P1", "--page", "P2"]), cases[3]?.[2]));
check("dtwin pull --page \"\" (space form) forwards the blank", same(cli(["--page", ""]), cases[4]?.[2]));
check("dtwin pull --all-pages", same(cli(["--all-pages"]), cases[5]?.[2]));
check("dtwin pull --design-system", same(cli(["--design-system"]), cases[7]?.[2]));
check("dtwin pull --as-library Lib", same(cli(["--as-library", "Lib"]), cases[8]?.[2]));
check("dtwin screenshot 1:2 --scale 2", same(cli(["--screenshot", "1:2", "--scale", "2"]), cases[10]?.[2]));
check("--timeout is the budget of a pull", (() => { const p = cli(["--node", "1:2", "--timeout", "7"]); return !!p && "timeout" in p && p.timeout === 7000; })());
check("and of a screenshot", (() => { const p = cli(["--screenshot", "1:2", "--timeout", "7"]); return !!p && "timeout" in p && p.timeout === 7000; })());
check("an index command has no read plan", cli(["--list"]) === null && cli(["--whoami"]) === null && cli(["--children", "1:2"]) === null);

console.log("\nread plan — both front-ends take it (source):");
const src = (f: string): string => fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", f), "utf8");
for (const f of ["figma-pull.ts", "figma-mcp.ts"]) {
  const s = src(f);
  check(`${f} picks no export budget of its own`, !/exportTimeout\(|TIMEOUTS\.(export|exportAll|selection)\b/.test(s));
  check(`${f} plans its reads`, /planRead\(|cliReadPlan\(/.test(s));
  check(`${f} writes through writeAny alone`, /writeAny\(/.test(s) && !/OUT\.write(Screen|Export|Screenshot)\(|\bwriteScreenshot\(/.test(s));
}
{
  const s = src("figma-mcp.ts");
  check("figma-mcp.ts declares each export tool's read options from the registry's scopes", (s.match(/readOptsShapeFor\("/g) || []).length >= 4 && !/\.\.\.readOptsShape\b/.test(s));
}

report();
