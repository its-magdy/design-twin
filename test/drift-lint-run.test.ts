// test/drift-lint-run.test.ts — one drift-lint run (design-to-code/drift-lint.ts runDriftLint), read by two front-ends.
// First the parity checks: the CLI (`bun design-to-code/drift-lint.ts`, a child) and the MCP tool (design_drift_lint, the
// server loaded in this process) are handed the same project and must give the same answer — they once assembled the run
// step by step each and disagreed on a non-catalog file, an unreadable discovered catalog, --catalog extras and the
// screen-coverage union. Then the run itself, in process, through its interface.
// Run with:  bun test/drift-lint-run.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runSync } from "../design-to-code/proc.ts";
import { runDriftLint, type DriftLintRun, type DriftLintRunInput } from "../design-to-code/drift-lint.ts";
import { check, report } from "./assert.ts";

const D2C = path.join(import.meta.dirname, "..", "design-to-code");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-drift-run-"));
const put = (file: string, doc: unknown): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return file;
};
const rec = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const stamp = { exportedAt: new Date().toISOString() };
const entry = (key: string, name: string) => ({ figma: { key, name }, code: { module: "src/ui/" + name + ".tsx", export: name } });

// One project, laid out the way `dtwin pull` writes it: the named catalog, the sampled components.library.json beside
// it, a pulled library under libraries/, one screen, a catalog elsewhere (a --catalog) and the map.
function project(name: string): { root: string; rel: (f: string) => string; catalog: string; sample: string; extra: string; screen: string; map: string; notCatalog: string } {
  const root = path.join(work, name);
  const ex = path.join(root, "design", "export");
  put(path.join(ex, "design-system.json"), { files: { componentsLocal: "design-system/components.local.json" } });
  const catalog = put(path.join(ex, "design-system", "components.local.json"), { ...stamp, components: [{ key: "k-row", id: "1:1", name: "Row", type: "COMPONENT" }] });
  const sample = put(path.join(ex, "design-system", "components.library.json"), { ...stamp, components: [{ key: "k-chip", name: "Chip", type: "COMPONENT", remote: true }] });
  put(path.join(ex, "libraries", "index.json"), { libraries: [{ dir: "kit", libraryName: "Kit" }] });
  put(path.join(ex, "libraries", "kit", "components.json"), { ...stamp, components: [{ key: "k-btn", name: "Button", type: "COMPONENT_SET" }] });
  const extra = put(path.join(root, "vendor", "extra.json"), { ...stamp, components: [{ key: "k-tag", id: "7:7", name: "Tag", type: "COMPONENT" }] });
  const screen = put(path.join(ex, "pages", "Home", "Home__5_1.json"), { nodes: [{ id: "5:1", type: "FRAME", name: "Home", children: [
    { id: "5:2", type: "INSTANCE", name: "Row", mainComponent: { key: "k-row", name: "Row" } },
    { id: "5:3", type: "INSTANCE", name: "Tag", mainComponent: { key: "k-tag", name: "Tag" } },
    { id: "5:4", type: "INSTANCE", name: "Other", mainComponent: { key: "k-other", name: "Other" } },
  ] }] });
  const map = put(path.join(root, "design", "codeconnect.local.json"), { version: 1, components: {
    "k-row": entry("k-row", "Row"), "k-btn": entry("k-btn", "Button"), "k-chip": entry("k-chip", "Chip"), "k-tag": entry("k-tag", "Tag"),
  } });
  const notCatalog = put(path.join(root, "not-a-catalog.json"), { components: "nope" });
  return { root, rel: (f) => path.relative(root, f), catalog, sample, extra, screen, map, notCatalog };
}

// ---------------------------------------------------------------- the two front-ends, read the same way
/** What either front-end answered, reduced to what both must agree on. */
interface Answer {
  /** usable: the lint ran (CLI exit 0/1, a tool result); refused: an input was not usable (CLI exit 2, a tool error) */
  outcome: "linted" | "refused";
  clean: boolean;
  /** `[code] first line` of every finding, sorted */
  findings: string[];
  catalogs: string[];
  /** inMap/distinct inCatalog/distinct, or null without screens */
  coverage: string | null;
  text: string;
}
const firstLine = (s: string): string => s.split("\n")[0] ?? "";

interface Inputs { map: string; catalog: string; screens?: string[]; catalogs?: string[] }
function viaCli(p: { root: string }, i: Inputs): Answer {
  const args = [path.join(D2C, "drift-lint.ts"), i.map, i.catalog, ...(i.screens ?? []).flatMap((s) => ["--screen", s]), ...(i.catalogs ?? []).flatMap((c) => ["--catalog", c])];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["FIGMA_FILE_KEY", "FIGMA_TOKEN", "DRIFT_MAX_AGE_HOURS"]) delete env[k];
  const r = runSync(process.execPath, args, { cwd: p.root, env });
  const lines = r.stderr.split("\n");
  const findings = lines.flatMap((l) => { const m = /^(?:ERROR {2}|warn {3})(\[[a-z-]+\] .*)$/.exec(l); return m && m[1] ? [m[1]] : []; }).sort();
  const set = lines.find((l) => l.startsWith("catalogs read ("));
  const catalogs = set ? [...set.matchAll(/(?:: |, )([^,[]+?) \[/g)].map((m) => m[1] ?? "") : [];
  const cov = /SCREEN COVERAGE: (\d+)\/(\d+) \(.*?\) .*? · (\d+)\/(\d+)/.exec(r.stderr);
  return {
    outcome: r.status === 2 ? "refused" : "linted", clean: r.status === 0, findings, catalogs,
    coverage: cov ? `${cov[1]}/${cov[2]} ${cov[3]}/${cov[4]}` : null, text: r.stderr,
  };
}

// The MCP server, in process: importing figma-mcp.ts starts nothing (mcp-delivery.test.ts checks that); the tool is
// driven over an in-memory transport, with this process's cwd as the server's start directory.
for (const k of ["FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "DTWIN_PORT", "MAX_MCP_OUTPUT_TOKENS"]) delete process.env[k];
process.env.FIGMA_BRIDGE_PORT = "8789";
process.env.FIGMA_BRIDGE_TOKEN = "drift-run-token";
const mcp = await import("../bridge/src/figma-mcp.ts");
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mcp.server.connect(serverSide);
const client = new Client({ name: "drift-lint-run", version: "0.0.0" });
await client.connect(clientSide);
const home = process.cwd();
async function viaMcp(p: { root: string; rel: (f: string) => string }, i: Inputs, exportDir = "design/export"): Promise<Answer> {
  process.chdir(p.root);
  try {
    const args: Record<string, unknown> = { map: p.rel(i.map), exportDir };
    if (i.screens) args.screens = i.screens.map(p.rel);
    if (i.catalogs) args.catalogs = i.catalogs.map(p.rel);
    const r = await client.callTool({ name: "design_drift_lint", arguments: args });
    const c0 = rec(list(r.content)[0]);
    const text = typeof c0.text === "string" ? c0.text : "";
    if (r.isError === true) return { outcome: "refused", clean: false, findings: [], catalogs: [], coverage: null, text };
    const parsed: unknown = JSON.parse(text);
    const j = rec(parsed);
    const sc = j.screenCoverage === undefined ? null : rec(j.screenCoverage);
    // The tool names files as it resolved them (absolute); the CLI as it was given them (relative to the project).
    const local = (t: string): string => t.split(fs.realpathSync(p.root) + path.sep).join("").split(p.root + path.sep).join("");
    const findings = [...list(j.errors), ...list(j.warnings), ...(sc ? list(sc.warnings) : [])]
      .map((f) => local(`[${String(rec(f).code)}] ${firstLine(String(rec(f).message))}`)).sort();
    return {
      outcome: "linted", clean: j.ok === true, findings, catalogs: list(j.catalogsRead).map((f) => local(String(f))),
      coverage: sc ? `${String(sc.inMap)}/${String(sc.distinct)} ${String(sc.inCatalog)}/${String(sc.distinct)}` : null, text,
    };
  } finally { process.chdir(home); }
}
const same = (a: Answer, b: Answer): boolean =>
  a.outcome === b.outcome && a.clean === b.clean && JSON.stringify(a.findings) === JSON.stringify(b.findings) && a.coverage === b.coverage;
const show = (a: Answer): string => JSON.stringify({ outcome: a.outcome, clean: a.clean, findings: a.findings, coverage: a.coverage });

console.log("parity — the CLI and the MCP tool give one answer:");
{
  const p = project("parity-clean");
  const i = { map: p.map, catalog: p.catalog, screens: [p.screen], catalogs: [p.extra] };
  const cli = viaCli(p, { ...i, map: p.rel(p.map), catalog: p.rel(p.catalog), screens: [p.rel(p.screen)], catalogs: [p.rel(p.extra)] });
  const tool = await viaMcp(p, i);
  check(`the whole project (named + sample + library + --catalog, one screen): the same findings and coverage (cli ${show(cli)} · mcp ${show(tool)})`,
    same(cli, tool) && cli.outcome === "linted" && cli.clean);
  check("…and the same catalogs read, in the same order", JSON.stringify(cli.catalogs) === JSON.stringify(tool.catalogs) && cli.catalogs.length === 4);
}
{
  // drift 1: a file that is not a component catalog — the CLI refused it (exit 2), the tool linted it as "no catalog".
  const p = project("parity-not-catalog");
  const cli = viaCli(p, { map: p.rel(p.map), catalog: p.rel(p.notCatalog) });
  put(path.join(p.root, "design", "export", "design-system.json"), { files: { componentsLocal: "../../not-a-catalog.json" } });
  const tool = await viaMcp(p, { map: p.map, catalog: p.notCatalog });
  check(`a non-catalog file is refused by both, naming it (cli ${cli.outcome} · mcp ${tool.outcome}: ${firstLine(tool.text)})`,
    cli.outcome === "refused" && tool.outcome === "refused" && /'[^']*not-a-catalog\.json' is not a component catalog/.test(tool.text));
}
{
  // drift 2: a discovered catalog that is there but unreadable — the CLI warned, the tool dropped it silently.
  const p = project("parity-unreadable");
  put(p.sample, "{ not json");
  const cli = viaCli(p, { map: p.rel(p.map), catalog: p.rel(p.catalog) });
  const tool = await viaMcp(p, { map: p.map, catalog: p.catalog });
  check(`an unreadable components.library.json is a catalog-unreadable warning on both (cli ${show(cli)} · mcp ${show(tool)})`,
    same(cli, tool) && tool.findings.some((f) => f.startsWith("[catalog-unreadable]") && f.includes("components.library.json")));
}
{
  // drift 3: --catalog extras — the CLI took them, the tool had no way to name one.
  const p = project("parity-extras");
  const cli = viaCli(p, { map: p.rel(p.map), catalog: p.rel(p.catalog), catalogs: [p.rel(p.extra)] });
  const tool = await viaMcp(p, { map: p.map, catalog: p.catalog, catalogs: [p.extra] });
  check(`a --catalog / catalogs:[…] extra resolves the entry on both (cli ${show(cli)} · mcp ${show(tool)})`,
    same(cli, tool) && !tool.findings.some((f) => f.startsWith("[orphaned-entry]")));
  const broken = put(path.join(p.root, "vendor", "broken.json"), "{ not json");
  const cliBad = viaCli(p, { map: p.rel(p.map), catalog: p.rel(p.catalog), catalogs: [p.rel(broken)] });
  const toolBad = await viaMcp(p, { map: p.map, catalog: p.catalog, catalogs: [broken] });
  check("…and a named extra that is not a catalog is refused by both (it was asked for)", cliBad.outcome === "refused" && toolBad.outcome === "refused" && /broken\.json/.test(toolBad.text));
}
{
  // drift 4: the union screen coverage is counted in — the CLI built it from the full set it read, the tool from what it
  // had discovered (no extras). The screen's Tag lives only in the --catalog extra.
  const p = project("parity-union");
  const cli = viaCli(p, { map: p.rel(p.map), catalog: p.rel(p.catalog), screens: [p.rel(p.screen)], catalogs: [p.rel(p.extra)] });
  const tool = await viaMcp(p, { map: p.map, catalog: p.catalog, screens: [p.screen], catalogs: [p.extra] });
  check(`screen coverage is counted against the same catalog union (cli ${String(cli.coverage)} · mcp ${String(tool.coverage)})`,
    cli.coverage === "2/3 2/3" && tool.coverage === cli.coverage && same(cli, tool));
}

// ---------------------------------------------------------------- the run, in process
/** The run's `linted` answer, or a failed check and null. */
function linted(r: DriftLintRun): Extract<DriftLintRun, { status: "linted" }> | null {
  return r.status === "linted" ? r : null;
}
const codes = (fs: ReadonlyArray<{ code: string }>): string[] => fs.map((f) => f.code);
const run = (i: DriftLintRunInput): DriftLintRun => runDriftLint(i);

console.log("\nrunDriftLint — an input it cannot use is a value, never an exit:");
{
  const p = project("run-unusable");
  const base = { mapFile: p.map, catalogFile: p.catalog };
  const missing = run({ ...base, catalogFile: path.join(p.root, "gone.json") });
  check("a missing catalog: unusable, the file named, with the single-screen-pull hint",
    missing.status === "unusable" && /component catalog: '[^']*gone\.json' does not exist\./.test(missing.message) && /dtwin pull --design-system/.test(missing.message));
  const manifest = run({ ...base, catalogFile: path.join(p.root, "design", "export", "design-system.json") });
  check("the design-system.json manifest: unusable, explained as the manifest, pointing at the split file",
    manifest.status === "unusable" && /is the design-system MANIFEST/.test(manifest.message) && /design-system\/components\.local\.json/.test(manifest.message));
  const notCat = run({ ...base, catalogFile: p.notCatalog });
  check("a file that is not a catalog: unusable (never linted as 'no catalog')", notCat.status === "unusable" && /is not a component catalog/.test(notCat.message));
  const noMap = run({ ...base, mapFile: path.join(p.root, "design", "none.json") });
  check("a missing map: unusable, and the scaffold hint writes that map with --out (never a `>` redirect)",
    noMap.status === "unusable" && /component map: '[^']*none\.json' does not exist\./.test(noMap.message) && /map-bootstrap\.ts["']? <components\.local\.json> --out ["']?\S*none\.json/.test(noMap.message) && !/ > /.test(noMap.message));
  const notScreen = run({ ...base, screenFiles: [p.notCatalog] });
  check("a screen file that is not a screen export: unusable, naming it", notScreen.status === "unusable" && /screen export: '[^']*not-a-catalog\.json' is not a screen export/.test(notScreen.message));
  const brokenExtra = run({ ...base, extraCatalogFiles: [put(path.join(p.root, "vendor", "broken.json"), "{ not json")] });
  check("a named extra catalog that does not parse: unusable (it was asked for)", brokenExtra.status === "unusable" && /component catalog \(--catalog\): '[^']*broken\.json' is not valid JSON/.test(brokenExtra.message));
}
{
  const p = project("run-map-invalid");
  put(p.map, { version: 1, components: { X: null } });
  const r = run({ mapFile: p.map, catalogFile: p.catalog });
  check("a map that fails map-validate: map-invalid, with the validator's errors and one [map-invalid] line each",
    r.status === "map-invalid" && r.errors.length > 0 && r.message.split("\n").filter((l) => l.startsWith("ERROR  [map-invalid] ")).length === r.errors.length && /is not a valid component map/.test(r.message));
}

console.log("\nrunDriftLint — the catalog set:");
{
  const p = project("run-set");
  const all = linted(run({ mapFile: p.map, catalogFile: p.catalog, extraCatalogFiles: [p.extra] }));
  check("named, each extra, every pulled library, then the sampled components.library.json — in that order",
    all !== null && JSON.stringify(all.catalogs.map((c) => c.role)) === JSON.stringify(["named", "extra", "library", "library-sample"]) && all.catalogs[0]?.file === p.catalog && all.catalogs[1]?.file === p.extra);
  check("…every entry resolves somewhere: no errors, three resolved outside the named catalog",
    all !== null && all.errors.length === 0 && all.summary.mapped === 1 && all.summary.mappedElsewhere === 3);
  const dup = linted(run({ mapFile: p.map, catalogFile: p.catalog, extraCatalogFiles: [p.catalog, p.extra, p.extra, p.sample] }));
  check("a file already in the set is not read twice (the named one, a repeated extra, a discovered one named as extra)",
    dup !== null && dup.catalogs.length === 4 && dup.catalogs.filter((c) => c.file === p.sample).length === 1);
  const without = linted(run({ mapFile: p.map, catalogFile: p.catalog }));
  check("without the extra its entry is orphaned — and only that one",
    without !== null && JSON.stringify(without.errors.map((e) => e.mapKey)) === JSON.stringify(["k-tag"]) && codes(without.errors).every((c) => c === "orphaned-entry"));
  put(p.sample, "{ not json");
  const skipped = linted(run({ mapFile: p.map, catalogFile: p.catalog, extraCatalogFiles: [p.extra] }));
  const w = skipped?.warnings.find((x) => x.code === "catalog-unreadable");
  check("an unreadable discovered catalog: left out of the set, one catalog-unreadable warning naming it, counted in the summary",
    skipped !== null && w !== undefined && w.file === p.sample && !skipped.catalogs.some((c) => c.file === p.sample) && skipped.summary.warningCount === skipped.warnings.length);
  check("…and the entry only it held is orphaned", skipped !== null && skipped.errors.some((e) => e.code === "orphaned-entry" && e.mapKey === "k-chip"));
}
{
  // The first screen decides which export's libraries/ count: a catalog outside any export finds none on its own.
  const p = project("run-first-screen");
  const loose = put(path.join(p.root, "elsewhere", "components.local.json"), { ...stamp, components: [{ key: "k-row", id: "1:1", name: "Row", type: "COMPONENT" }] });
  const alone = linted(run({ mapFile: p.map, catalogFile: loose }));
  const withScreen = linted(run({ mapFile: p.map, catalogFile: loose, screenFiles: [p.screen] }));
  check("a catalog outside the export reads no pulled library — until a screen of that export is given",
    alone !== null && !alone.catalogs.some((c) => c.role === "library") && withScreen !== null && withScreen.catalogs.some((c) => c.role === "library"));
}

console.log("\nrunDriftLint — freshness and coverage:");
{
  const p = project("run-fresh");
  const now = Date.parse(stamp.exportedAt) + 3 * 3600000;
  const tight = linted(run({ mapFile: p.map, catalogFile: p.catalog, extraCatalogFiles: [p.extra], maxAgeMs: 3600000, now }));
  check("maxAgeMs and now reach the lint: a 3h-old named catalog is stale at a 1h max-age (the freshness banner names it)",
    tight !== null && tight.freshness?.code === "stale-snapshot" && tight.warnings.some((x) => x.code === "stale-snapshot" && x.message.includes(p.extra)));
  const loose = linted(run({ mapFile: p.map, catalogFile: p.catalog, maxAgeMs: 4 * 3600000, now }));
  check("…and fresh at a 4h max-age", loose !== null && loose.freshness === undefined && !codes(loose.warnings).includes("stale-snapshot"));
  const none = linted(run({ mapFile: p.map, catalogFile: p.catalog }));
  check("no screens: coverage is null", none !== null && none.coverage === null);
  const one = linted(run({ mapFile: p.map, catalogFile: p.catalog, screenFiles: [p.screen], extraCatalogFiles: [p.extra] }));
  check("a screen: its coverage against the whole set (Tag found in the extra), with the unmapped warning",
    one !== null && one.coverage !== null && one.coverage.coverage.distinct === 3 && one.coverage.coverage.inMap === 2 && one.coverage.coverage.inCatalog === 2 &&
      one.coverage.warnings.some((x) => x.code === "screen-coverage" && /'Other' \(1x\)/.test(x.message)));
  const second = put(path.join(p.root, "design", "export", "pages", "Home", "Modal__6_1.json"), { nodes: [{ id: "6:1", type: "FRAME", name: "Modal", children: [
    { id: "6:2", type: "INSTANCE", name: "Button", mainComponent: { key: "k-btn", name: "Button" } },
  ] }] });
  const two = linted(run({ mapFile: p.map, catalogFile: p.catalog, screenFiles: [p.screen, second], extraCatalogFiles: [p.extra] }));
  check("two screens are counted together", two !== null && two.coverage !== null && two.coverage.coverage.distinct === 4 && two.coverage.coverage.inMap === 3);
}

await client.close();
fs.rmSync(work, { recursive: true, force: true });
report();
