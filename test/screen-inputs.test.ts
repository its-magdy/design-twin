// design-to-code/screen-inputs.ts: a screen plus what surrounds it — the screen docs and their own slices and asset
// manifests, the variables union, the design system (either layout), the libraries, the component map and the export's
// other screens — resolved once for audit and cross-check, with each optional input that is not there said in a note.
// Invented screens, temp dirs only.
//   bun test/screen-inputs.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { catalog, collection, screenExport, tokens, variable } from "./fixtures.ts";
import { crossCheckInputOf, readScreenInputs, withCatalog } from "../design-to-code/screen-inputs.ts";
import { screenSiblingFile } from "../design-to-code/export-index.ts";
import type { ScreenInputs } from "../design-to-code/screen-inputs.ts";
import { cliRunner } from "./cli-runner.ts";
import { main as auditMain } from "../design-to-code/audit.ts";
import { main as crossCheckMain } from "../design-to-code/cross-check.ts";
const d2c = path.join(import.meta.dirname, "..", "design-to-code");
const auditCli = cliRunner(path.join(d2c, "audit.ts"), auditMain);
const crossCheckCli = cliRunner(path.join(d2c, "cross-check.ts"), crossCheckMain);

const tmp = (tag: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-inputs-" + tag + "-")));
const put = (file: string, body: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n");
};
const SCREEN = "design/export/pages/Home/Dashboard__10_1.json";
const OTHER = "design/export/pages/Home/Reports__10_2.json";
const slice = tokens({ collections: [collection({ key: "ck1", name: "Brand", modes: ["Light"], default: "Light" })],
  variables: [variable({ key: "k1", name: "Space 4", type: "FLOAT", collection: "Brand", collectionKey: "ck1", values: { Light: 16 } })] });
/** A project: one screen with its slice and asset manifest, a sibling screen, the export's union, its design-system/, a
 *  library export and a component map — every optional input there. */
function project(): string {
  const root = tmp("project");
  const at = (rel: string): string => path.join(root, rel);
  put(at(SCREEN), screenExport([{ id: "10:1", type: "FRAME", name: "Dashboard" }], { screen: "Dashboard", nodeId: "10:1" }));
  put(at(screenSiblingFile(SCREEN, "vars")), slice);
  put(at(screenSiblingFile(SCREEN, "assets")), { heavy: [], files: [] });
  put(at(OTHER), screenExport([{ id: "10:2", type: "FRAME", name: "Reports" }], { screen: "Reports", nodeId: "10:2" }));
  put(at("design/export/pages/index.json"), { pageDirs: [{ page: "Home", dir: "Home", index: "pages/Home/index.json", layers: 2 }],
    layers: [{ id: "10:1", name: "Dashboard", file: "pages/Home/Dashboard__10_1.json" }, { id: "10:2", name: "Reports", file: "pages/Home/Reports__10_2.json" }] });
  put(at("design/export/variables.json"), slice);
  put(at("design/export/design-system/tokens.json"), slice);
  put(at("design/export/design-system/components.local.json"), catalog([{ key: "ck", name: "Button", type: "COMPONENT" }]));
  put(at("design/export/libraries/index.json"), { libraries: [{ dir: "brand-lib", libraryName: "Brand Lib", collectionKeys: ["ck1"], counts: {}, index: "libraries/brand-lib/index.json" }] });
  put(at("design/export/libraries/brand-lib/components.json"), catalog([{ key: "lk", name: "Chip", type: "COMPONENT" }]));
  put(at("design/codeconnect.local.json"), { version: 1, components: {} });
  return root;
}
/** readScreenInputs from `cwd`, as a CLI run there passes its files. */
function read(cwd: string, files: string[], flags: Parameters<typeof readScreenInputs>[1] = {}): ReturnType<typeof readScreenInputs> {
  const was = process.cwd();
  process.chdir(cwd);
  try { return readScreenInputs(files, flags); } finally { process.chdir(was); }
}
// A found path is printed as findMapFile / variablesContext give it: native separators (`\` on Windows)
const slash = (s: string | null): string | null => (s === null ? null : s.split(path.sep).join("/"));
const ok = (r: ReturnType<typeof readScreenInputs>): ScreenInputs => {
  if ("errors" in r) throw new Error("unexpected errors: " + r.errors.join("; "));
  return r.inputs;
};

console.log("every input beside the screen, found on its own");
{
  const root = project();
  const ix = ok(read(root, [SCREEN]));
  const [s] = ix.screens;
  check("the screen: its doc, label (the file's stem), own slice and asset manifest", s?.label === "Dashboard__10_1" && !!s.doc && s.vars?.variables?.[0]?.key === "k1" && !!s.assets);
  check(`the variables: the export root's union (got ${ix.variablesPath})`, ix.variablesPath === path.join(root, "design/export/variables.json") && !!ix.variables && ix.sliceSources !== null);
  check(`the design system: the export's own design-system/, found — not given (got ${ix.designSystem?.dir})`,
    ix.designSystem?.dir === "design/export/design-system" && ix.designSystem.given === false && ix.designSystem.components?.components[0]?.name === "Button" && !ix.designSystem.isLibrary);
  check("the libraries beside the export", ix.libraries.length === 1 && ix.libraries[0]?.name === "Brand Lib" && ix.libraries[0].components?.components[0]?.name === "Chip");
  check("the component map, found", slash(ix.mapFile) === "design/codeconnect.local.json" && ix.map !== null);
  const sib = ix.siblings ? ix.siblings().map((x) => x.label) : null;
  check(`the export's other screens, not the one checked (got ${JSON.stringify(sib)})`, JSON.stringify(sib) === JSON.stringify(["Reports__10_2"]));
  check(`notes name each input found (got ${JSON.stringify(ix.notes)})`,
    ix.notes.some((n) => /^variables: .*variables\.json$/.test(n)) && ix.notes.some((n) => /^design system: design\/export\/design-system \(found beside the export/.test(n)) && ix.notes.map(slash).includes("map: design/codeconnect.local.json"));
  const cc = crossCheckInputOf(ix);
  check("crossCheckInputOf: the same context as crossCheck's input, field for field",
    cc.screens === ix.screens && cc.variables === ix.variables && cc.variablesPath === ix.variablesPath && cc.sliceSources === ix.sliceSources
    && cc.tokens === ix.designSystem?.tokens && cc.components === ix.designSystem?.components && cc.componentsFile === "components.local.json"
    && cc.designSystemIsLibrary === false && cc.map === ix.map && cc.siblings === ix.siblings);
  check("…a catalog fallback stands in only when the design system has no components", crossCheckInputOf({ ...ix, designSystem: null }, { components: catalog([]) }).components?.components.length === 0
    && crossCheckInputOf(ix, { components: catalog([]) }).components === ix.designSystem?.components);
}

console.log("overrides");
{
  const root = project();
  put(path.join(root, "elsewhere/variables.json"), slice);
  const ix = ok(read(root, [SCREEN], { variables: "elsewhere/variables.json", designSystem: "design/export/libraries/brand-lib", map: "design/codeconnect.local.json" }));
  check("--variables is the union read", ix.variablesPath === "elsewhere/variables.json" && !!ix.variables);
  check("--design-system names either layout: a library export's components.json", ix.designSystem?.given === true && ix.designSystem.isLibrary && ix.designSystem.componentsFile === "components.json"
    && ix.designSystem.components?.components[0]?.name === "Chip" && ix.notes.includes("design system: design/export/libraries/brand-lib"));
  check("a named --map is read", ix.map !== null && ix.mapFile === "design/codeconnect.local.json");
}

console.log("what is not there: no input, and a note saying so");
{
  const root = tmp("bare");
  put(path.join(root, "screen.json"), screenExport([{ id: "1:1", type: "FRAME", name: "A" }], { screen: "A" }));
  const ix = ok(read(root, ["screen.json"]));
  check("a lone screen outside any export: no variables, design system, libraries, map or siblings",
    ix.variables === null && ix.designSystem === null && ix.libraries.length === 0 && ix.map === null && ix.siblings === null && ix.screens[0]?.vars === undefined && ix.screens[0]?.assets === null);
  check(`…each said (got ${JSON.stringify(ix.notes)})`, ix.notes.some((n) => /^note {2}no design system/.test(n)) && ix.notes.some((n) => /^note {2}no variables/.test(n)));
  // a lone screen whose own slice is there and no union: the slice stands in (collection provenance still has something to read)
  put(path.join(root, "screen.vars.json"), slice);
  const lone = ok(read(root, ["screen.json"]));
  check("no union, one screen with its own slice: the slice stands in as the variables", lone.variablesPath === "screen.vars.json" && lone.variables !== null);
}
{
  // the design system defaults to the SCREEN's export, not the cwd's
  const root = project();
  const other = tmp("cwd");
  const ix = ok(read(other, [path.join(root, SCREEN)]));
  check(`a screen outside the cwd's project: its own export's design system (got ${ix.designSystem?.dir})`, ix.designSystem?.dir === path.join(root, "design/export/design-system"));
  // a project with design-system/ but a screen outside any pages/ tree: the cwd's export's
  put(path.join(root, "loose.json"), screenExport([{ id: "1:1", type: "FRAME", name: "A" }]));
  const loose = ok(read(root, ["loose.json"]));
  check(`a screen outside any export: the cwd's export's design system (got ${loose.designSystem?.dir})`, loose.designSystem?.dir === "design/export/design-system");
}

{
  // a screen in an export with no design-system/ while the cwd's project has one: none — another export's is another file's
  const root = project();
  const elsewhere = tmp("other-export");
  put(path.join(elsewhere, "pages/Home/A__1_1.json"), screenExport([{ id: "1:1", type: "FRAME", name: "A" }]));
  put(path.join(elsewhere, "pages/index.json"), { pageDirs: [], layers: [] });
  const ix = ok(read(root, [path.join(elsewhere, "pages/Home/A__1_1.json")]));
  check(`a screen whose own export has no design system: none, not the cwd's (got ${ix.designSystem?.dir ?? null})`, ix.designSystem === null && ix.notes.some((n) => /^note {2}no design system/.test(n)));
  const named = ok(read(root, [SCREEN], { designSystem: "no/such/dir" }));
  check("a named --design-system that is not there: said, not reported as read", named.notes.includes("note  --design-system no/such/dir does not exist — no design system was read"));
}
{
  // either layout: a dir holding both catalogs is a design file's (components.local.json wins)
  const root = project();
  put(path.join(root, "design/export/design-system/components.json"), catalog([{ key: "zz", name: "Other", type: "COMPONENT" }]));
  const ix = ok(read(root, [SCREEN]));
  check("components.local.json beside a components.json: the design file's layout", ix.designSystem?.isLibrary === false && ix.designSystem.components?.components[0]?.name === "Button");
}
{
  // audit's --catalog against the design system: it stands in for a named one's missing catalog, and beats a found one's
  const root = project();
  const named = catalog([{ key: "nk", name: "Named", type: "COMPONENT" }]);
  const found = ok(read(root, [SCREEN])).designSystem;
  check("withCatalog: a catalog the user named beats a found design system's", withCatalog(found, named)?.components === named);
  const given = ok(read(root, [SCREEN], { designSystem: "design/export/design-system" })).designSystem;
  check("…not a named one's", withCatalog(given, named)?.components?.components[0]?.name === "Button");
  const empty = ok(read(root, [SCREEN], { designSystem: "design/export/libraries/none" })).designSystem;
  check("…and stands in when a named one has no catalog", withCatalog(empty, named)?.components === named && withCatalog(null, named) === null && withCatalog(found, undefined) === found);
}

console.log("what is there but broken");
{
  const root = project();
  put(path.join(root, "design/export/variables.json"), "{ not json");
  const r = read(root, [SCREEN]);
  check(`an unreadable union is an error, not "no variables" (got ${JSON.stringify("errors" in r ? r.errors : null)})`, "errors" in r && r.errors.length === 1 && /variables: '.*variables\.json' is not valid JSON/.test(r.errors[0] ?? ""));
}
{
  const root = project();
  put(path.join(root, "design/codeconnect.local.json"), "[]");
  const ix = ok(read(root, [SCREEN]));
  check(`a broken map that was only found: a warning, no map (got ${JSON.stringify(ix.notes.filter((n) => n.startsWith("warn")))})`,
    ix.map === null && ix.notes.map(slash).some((n) => n !== null && /^warn {2}design\/codeconnect\.local\.json is not .* — proposals are not labelled alreadyMapped$/.test(n)));
  const flagged = ok(read(root, [SCREEN], { mapFlag: true }));
  check("…naming --map when the CLI has one", flagged.notes.some((n) => /alreadyMapped \(pass --map to fail on it\)$/.test(n)));
}
{
  const root = project();
  put(path.join(root, "design/variables.json"), slice);
  const ix = ok(read(root, [SCREEN]));
  check("a stale design/variables.json above design/export/: not read, and warned about", ix.variablesPath === path.join(root, "design/export/variables.json")
    && ix.notes.map(slash).some((n) => n !== null && /^warn {2}.*design\/variables\.json also exists and was NOT used/.test(n)));
}

console.log("the two CLIs read one context");
{
  // the same screen, no flags: audit's embedded crossFile IS the cross-check report (the design system found beside the
  // export by both — audit used to need --design-system for it)
  const root = project();
  const a = auditCli([SCREEN, "--platform", "web", "--json"], { cwd: root });
  const c = crossCheckCli([SCREEN, "--json"], { cwd: root });
  const parse = (t: string): unknown => { try { const v: unknown = JSON.parse(t); return v; } catch { return null; } };
  const ar = parse(a.stdout), cr = parse(c.stdout);
  const crossFile = ar && typeof ar === "object" && "crossFile" in ar ? ar.crossFile : undefined;
  const inputsOf = (r: unknown): string => JSON.stringify(r && typeof r === "object" && "inputs" in r ? r.inputs : null);
  check(`both exit 0 (audit ${a.status}, cross-check ${c.status})`, a.status === 0 && c.status === 0);
  check(`the inputs read are the same, the design system's included (audit ${inputsOf(crossFile)}, cross-check ${inputsOf(cr)})`,
    inputsOf(crossFile) === inputsOf(cr) && /"tokens":true/.test(inputsOf(cr)) && /"components":true/.test(inputsOf(cr)));
  const codes = (r: unknown): string => JSON.stringify(r && typeof r === "object" && "findings" in r && Array.isArray(r.findings) ? r.findings.map((f: { code?: unknown }) => f.code) : null);
  check(`…and so are the cross-file findings (${codes(cr)})`, codes(crossFile) === codes(cr));
  check("both print where the design system came from", /design system: design\/export\/design-system \(found beside the export/.test(a.stderr) && /design system: design\/export\/design-system \(found/.test(c.stderr));
}

{
  // a broken split file in a FOUND design system stops the audit like a named one (exit 2, the file named)
  const root = project();
  put(path.join(root, "design/export/design-system/tokens.json"), "{ not json");
  const a = auditCli([SCREEN, "--platform", "web", "--json"], { cwd: root });
  check(`audit, a broken tokens.json in the found design-system/: exit 2 naming it (got ${a.status})`, a.status === 2 && /design-system tokens: '.*tokens\.json' is not valid JSON/.test(a.stderr));
}
{
  // a lone screen with only its own slice: cross-check reads the slice as the variables, and no other screen is blamed
  const root = tmp("lone");
  put(path.join(root, "s.json"), screenExport([{ id: "1:1", type: "FRAME", name: "A" }], { screen: "A" }));
  put(path.join(root, "s.vars.json"), slice);
  const c = crossCheckCli(["s.json", "--json"], { cwd: root });
  check(`cross-check, a lone screen: its own slice is the variables read (${c.stderr.split("\n")[0]})`, c.status === 0 && /^variables: s\.vars\.json$/m.test(c.stderr) && !/-elsewhere/.test(c.stdout));
}
{
  // the library passed as the design system is not also offered as a "re-run with --design-system" library
  const root = project();
  const a = auditCli([SCREEN, "--platform", "web", "--json", "--design-system", "design/export/libraries/brand-lib"], { cwd: root });
  check(`audit --design-system <the library>: no re-run hint for that same library (exit ${a.status})`, a.status === 0 && a.stdout.includes("\"crossFile\"") && !/the library export design\/export\/libraries\/brand-lib/.test(a.stdout));
  const b = auditCli([SCREEN, "--platform", "web", "--json"], { cwd: root });
  check("…while the found design-system/ run names the library to re-run with", /the library export design\/export\/libraries\/brand-lib/.test(b.stdout));
}

console.log("screenSiblingFile");
check("a screen's .vars.json / .assets.json beside it", screenSiblingFile("pages/P/A__1_1.json", "vars") === "pages/P/A__1_1.vars.json" && screenSiblingFile("pages/P/A__1_1.json", "assets") === "pages/P/A__1_1.assets.json");

report();
