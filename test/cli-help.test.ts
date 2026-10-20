// CLI help surface: per-verb help pages, the `--out` hint, the port override.
//   node test/cli-help.test.ts
// No bridge, no plugin and no port: every case is a pure function or a `--help`/`token status` spawn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { HELP, OWN_HELP_ROUTED, VERBS, dtwinPortWarning, verbHelp } from "../bridge/src/verbs.ts";
import { UsageError, parseArgs } from "../bridge/src/figma-pull.ts";
import { checkPort } from "../bridge/src/doctor.ts";

const CLI = path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts");
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cli-help-"));
// FIGMA_BRIDGE_TOKEN keeps every spawn off the user's saved token; DTWIN_PORT is stripped unless a case sets it.
const run = (args: string[], extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, FIGMA_BRIDGE_TOKEN: "t", ...extra };
  if (!("DTWIN_PORT" in extra)) delete env.DTWIN_PORT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 15000, env });
};
const usageError = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof UsageError ? e.message : "not a UsageError: " + String(e); }
};

try {
  // every verb in the usage header answers --help with ITS OWN page.
  console.log("\ncli help — per-verb pages:");
  for (const v of VERBS) {
    if (v === "help") continue; // its page IS the full usage — below
    const inTable = typeof HELP[v] === "string";
    check(`${v}: has a HELP page, or answers through its own entry point`, inTable || OWN_HELP_ROUTED.includes(v));
    const r = run([v, "--help"]);
    check(`\`dtwin ${v} --help\` exits 0 and its first line starts "dtwin ${v}"`, r.status === 0 && r.stdout.startsWith(`dtwin ${v}`));
    if (inTable) check(`${v}: the spawned page is the table's page (no full-usage fallthrough)`, r.stdout.trim() === HELP[v]);
  }
  const full = run(["help", "--help"]);
  check("`dtwin help --help` prints the full usage", full.status === 0 && full.stdout.startsWith("dtwin — pull a design") && full.stdout.includes("dtwin --stop"));
  check("verbHelp answers whoami/serve/stop/status/version", ["whoami", "serve", "stop", "status", "version"].every((v) => verbHelp([v, "--help"]) === HELP[v] && !!HELP[v]));
  check("the whoami page says `connection` is the ADDRESSED file's socket", /ADDRESSED file/.test(HELP.whoami ?? ""));
  check("the serve page covers the idle shutdown", /FIGMA_DAEMON_IDLE_MIN/.test(HELP.serve ?? ""));
  check("`dtwin version --help` prints the page, not the bare version", !/^\d+\.\d+\.\d+\s*$/.test(run(["version", "--help"]).stdout));

  // `--out` and friends: outDir is positional.
  console.log("\ncli help — the --out hint:");
  for (const flag of ["--out", "-o", "--output", "--out-dir", "--outdir", "--dir"]) {
    const m = usageError(() => parseArgs(["--screenshot", "1:2", flag, "x.png"]));
    check(`${flag} x.png → "outDir is positional" + the right spelling`, !!m && /outDir is positional/.test(m) && /dtwin screenshot <id> <outDir>/.test(m) && /dtwin pull <outDir> --node <id>/.test(m));
  }
  const eq = usageError(() => parseArgs(["--screenshot", "1:2", "--out=x.png"]));
  check("--out=x.png (with =value) gets the same hint", !!eq && /outDir is positional/.test(eq));
  const typo = usageError(() => parseArgs(["--lsit"]));
  check("an ordinary typo still gets did-you-mean, not the outDir hint", !!typo && /did you mean --list/.test(typo) && !/outDir is positional/.test(typo));
  check("a positional outDir still parses", usageError(() => parseArgs(["--screenshot", "1:2", "shots"])) === null);
  const cli = run(["screenshot", "1:2", "--out", "x.png"]);
  check("end to end: `dtwin screenshot 1:2 --out x.png` exits 1 with the hint, before any bridge starts",
    cli.status === 1 && /outDir is positional/.test(cli.stderr) && !/listening/.test(cli.stderr));

  // the port override is documented, and DTWIN_PORT is called out.
  console.log("\ncli help — the port override:");
  check("`dtwin --help` documents FIGMA_BRIDGE_PORT", /FIGMA_BRIDGE_PORT/.test(run(["--help"]).stdout));
  check("…and says there is no --port flag and DTWIN_PORT is not read", /no --port flag/.test(run(["--help"]).stdout) && /DTWIN_PORT is not read/.test(run(["--help"]).stdout));
  const free = checkPort(8788, { free: true }, null, "8788");
  check("doctor's free-port line names FIGMA_BRIDGE_PORT=8788 when it is set", free.status === "ok" && /FIGMA_BRIDGE_PORT=8788/.test(free.detail));
  const dflt = checkPort(8787, { free: true }, null);
  check("…and says how to select another port when it is the default", dflt.status === "ok" && /default; FIGMA_BRIDGE_PORT selects 8788\/8789/.test(dflt.detail));
  check("dtwinPortWarning: unset → null, set → the FIGMA_BRIDGE_PORT sentence",
    dtwinPortWarning({}) === null && /DTWIN_PORT is not read — use FIGMA_BRIDGE_PORT/.test(dtwinPortWarning({ DTWIN_PORT: "8788" }) ?? ""));
  const warned = run(["token", "status"], { DTWIN_PORT: "8788" });
  check("`dtwin token status` with DTWIN_PORT=8788 prints the warning", /DTWIN_PORT is not read — use FIGMA_BRIDGE_PORT \(8787\/8788\/8789\)/.test(warned.stderr));
  check("…and without DTWIN_PORT there is no such warning", !/DTWIN_PORT/.test(run(["token", "status"]).stderr));
  check("--help stays side-effect free: no warning there", !/DTWIN_PORT is not read —/.test(run(["--help"], { DTWIN_PORT: "8788" }).stderr));

  // the cost of `list libraries` is told straight: one Figma call per enabled library
  // collection plus a whole-document instance walk, ~2 s with no libraries — never a bare "5-15s", and the MCP
  // tool does not call it CHEAP. The MCP descriptions are string literals in figma-mcp.ts (not exported).
  console.log("\ncli help — time wording:");
  const pageList = HELP.list ?? "";
  const mcpSrc = (() => { try { return fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts"), "utf8"); } catch { return ""; } })();
  const libTool = (/"figma_list_libraries",\s*\{\s*description:([\s\S]*?)inputSchema/.exec(mcpSrc)?.[1] ?? "").replace(/"\s*\+\s*"/g, "");
  check("the list page gives a range with its cause and the no-libraries case, not a bare 5-15", /few seconds to ~15 s/.test(pageList) && /about 2 s when no\s+libraries are enabled/.test(pageList) && !/5-15/.test(pageList));
  check("no help page says \"5-15\" without the no-libraries clause", Object.values(HELP).every((h) => !/5-15/.test(h) || /no\s+libraries|~2 s/.test(h)));
  check("the MCP figma_list_libraries description was found in the source", libTool.length > 200);
  check("…and is not \"CHEAP discovery\": it calls itself the slowest discovery read, ~2 s with no libraries", !/CHEAP discovery/.test(libTool) && /SLOWEST discovery read/.test(libTool) && /about 2 s when no libraries are enabled/.test(libTool));
  check("figma-mcp.ts has no \"CHEAP discovery\" anywhere", mcpSrc.length > 0 && !/CHEAP discovery/.test(mcpSrc));
  check("the MCP description keeps figma_list_libraries out of the default order (never \"Call this BEFORE exporting\")",
    !/Call this BEFORE exporting/.test(libTool) && /Not part of the default discovery order \(figma_status -> figma_list_pages -> figma_list_children -> figma_export_url\)/.test(libTool));
  check("the per-collection reads are one call each (fanned out), never \"one at a time\" — list page and MCP description",
    !/one at a time/.test(libTool) && !/one at a time/.test(pageList) && /one Figma call per enabled library variable collection/.test(libTool) && /one Figma\s+call per enabled library variable collection/.test(pageList));
  const dsTool = (/"figma_export_design_system",\s*\{\s*description:([\s\S]*?)inputSchema/.exec(mcpSrc)?.[1] ?? "").replace(/"\s*\+\s*"/g, "");
  check("the MCP design-system description gives ~15–40 s and the progress-token caveat", /~15–40 s on a real file/.test(dsTool) && /progress only to clients that send a progress token/.test(dsTool));
  check("…and says the pull is not the library's catalog, with the --as-library route (no \"fewer of them\")", /never the library's catalog/.test(dsTool) && /--as-library/.test(dsTool) && !/fewer of them/.test(dsTool));
  check("the pull help page says the same for --design-system", /CONSUMES a library/.test(HELP.pull ?? "") && /never the library's\s+catalog/.test(HELP.pull ?? ""));
  check("the list page documents children's childCount and `title`; the screenshot page says \"at the default scale\"", /childCount/.test(pageList) && /`title`/.test(pageList) && /at the default scale it leaves no duplicate/.test(HELP.screenshot ?? ""));

  // claude-plugin/build-scripts.ts takes the output dir as argv[2]; a flag must not be taken for it (`--help` would write
  // the bundles into ./--help). Run it with a temp cwd so a regression cannot litter the repo.
  console.log("\ncli help — build-scripts --help:");
  const BUILD = path.join(import.meta.dirname, "..", "claude-plugin", "build-scripts.ts");
  const bs = (arg: string) => spawnSync(process.execPath, [BUILD, arg], { cwd, encoding: "utf8", timeout: 30000 });
  const h = bs("--help");
  const bad = bs("--nope");
  check("`build-scripts.ts --help` exits 0, prints usage and creates no `--help` directory; another dash argument is a usage error (exit 2, stderr), also writing nothing",
    h.status === 0 && /usage: node claude-plugin\/build-scripts\.ts/.test(h.stdout) && !fs.existsSync(path.join(cwd, "--help"))
    && bad.status === 2 && /usage:/.test(bad.stderr) && !fs.existsSync(path.join(cwd, "--nope")));
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
