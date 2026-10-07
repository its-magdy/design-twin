// CLI help surface (group 14, DT-01 / F-26 / F-52): per-verb help pages, the `--out` hint, the port override.
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
  // [HELP-1] every verb in the usage header answers --help with ITS OWN page.
  console.log("\ncli help — per-verb pages (DT-01):");
  for (const v of VERBS) {
    if (v === "help") continue; // its page IS the full usage — below
    const inTable = typeof HELP[v] === "string";
    check(`[HELP-1] ${v}: has a HELP page, or answers through its own entry point`, inTable || OWN_HELP_ROUTED.includes(v));
    const r = run([v, "--help"]);
    check(`[HELP-1] \`dtwin ${v} --help\` exits 0 and its first line starts "dtwin ${v}"`, r.status === 0 && r.stdout.startsWith(`dtwin ${v}`));
    if (inTable) check(`[HELP-1] ${v}: the spawned page is the table's page (no full-usage fallthrough)`, r.stdout.trim() === HELP[v]);
  }
  const full = run(["help", "--help"]);
  check("[HELP-1] `dtwin help --help` prints the full usage", full.status === 0 && full.stdout.startsWith("dtwin — pull a design") && full.stdout.includes("dtwin --stop"));
  check("[HELP-1] verbHelp answers whoami/serve/stop/status/version", ["whoami", "serve", "stop", "status", "version"].every((v) => verbHelp([v, "--help"]) === HELP[v] && !!HELP[v]));
  check("[HELP-1] the whoami page says `connection` is the ADDRESSED file's socket", /ADDRESSED file/.test(HELP.whoami ?? ""));
  check("[HELP-1] the serve page covers the idle shutdown", /FIGMA_DAEMON_IDLE_MIN/.test(HELP.serve ?? ""));
  check("[HELP-1] `dtwin version --help` prints the page, not the bare version", !/^\d+\.\d+\.\d+\s*$/.test(run(["version", "--help"]).stdout));

  // [F26-1] `--out` and friends: outDir is positional.
  console.log("\ncli help — the --out hint (F-26):");
  for (const flag of ["--out", "-o", "--output", "--out-dir", "--outdir", "--dir"]) {
    const m = usageError(() => parseArgs(["--screenshot", "1:2", flag, "x.png"]));
    check(`[F26-1] ${flag} x.png → "outDir is positional" + the right spelling`, !!m && /outDir is positional/.test(m) && /dtwin screenshot <id> <outDir>/.test(m) && /dtwin pull <outDir> --node <id>/.test(m));
  }
  const eq = usageError(() => parseArgs(["--screenshot", "1:2", "--out=x.png"]));
  check("[F26-1] --out=x.png (with =value) gets the same hint", !!eq && /outDir is positional/.test(eq));
  const typo = usageError(() => parseArgs(["--lsit"]));
  check("[F26-1] an ordinary typo still gets did-you-mean, not the outDir hint", !!typo && /did you mean --list/.test(typo) && !/outDir is positional/.test(typo));
  check("[F26-1] a positional outDir still parses", usageError(() => parseArgs(["--screenshot", "1:2", "shots"])) === null);
  const cli = run(["screenshot", "1:2", "--out", "x.png"]);
  check("[F26-1] end to end: `dtwin screenshot 1:2 --out x.png` exits 1 with the hint, before any bridge starts",
    cli.status === 1 && /outDir is positional/.test(cli.stderr) && !/listening/.test(cli.stderr));

  // [F52-1..3] the port override is documented, and DTWIN_PORT is called out.
  console.log("\ncli help — the port override (F-52):");
  check("[F52-1] `dtwin --help` documents FIGMA_BRIDGE_PORT", /FIGMA_BRIDGE_PORT/.test(run(["--help"]).stdout));
  check("[F52-1] …and says there is no --port flag and DTWIN_PORT is not read", /no --port flag/.test(run(["--help"]).stdout) && /DTWIN_PORT is not read/.test(run(["--help"]).stdout));
  const free = checkPort(8788, { free: true }, null, "8788");
  check("[F52-2] doctor's free-port line names FIGMA_BRIDGE_PORT=8788 when it is set", free.status === "ok" && /FIGMA_BRIDGE_PORT=8788/.test(free.detail));
  const dflt = checkPort(8787, { free: true }, null);
  check("[F52-2] …and says how to select another port when it is the default", dflt.status === "ok" && /default; FIGMA_BRIDGE_PORT selects 8788\/8789/.test(dflt.detail));
  check("[F52-3] dtwinPortWarning: unset → null, set → the FIGMA_BRIDGE_PORT sentence",
    dtwinPortWarning({}) === null && /DTWIN_PORT is not read — use FIGMA_BRIDGE_PORT/.test(dtwinPortWarning({ DTWIN_PORT: "8788" }) ?? ""));
  const warned = run(["token", "status"], { DTWIN_PORT: "8788" });
  check("[F52-3] `dtwin token status` with DTWIN_PORT=8788 prints the warning", /DTWIN_PORT is not read — use FIGMA_BRIDGE_PORT \(8787\/8788\/8789\)/.test(warned.stderr));
  check("[F52-3] …and without DTWIN_PORT there is no such warning", !/DTWIN_PORT/.test(run(["token", "status"]).stderr));
  check("[F52-3] --help stays side-effect free: no warning there", !/DTWIN_PORT is not read —/.test(run(["--help"], { DTWIN_PORT: "8788" }).stderr));

  // [F04-1] the cost of `list libraries` is told straight (group 15, F-04): one Figma call per enabled library
  // collection plus a whole-document instance walk, ~2 s with no libraries — never a bare "5-15s", and the MCP
  // tool no longer calls it CHEAP. The MCP descriptions are string literals in figma-mcp.ts (not exported).
  console.log("\ncli help — time wording (F-04):");
  const pageList = HELP.list ?? "";
  const mcpSrc = (() => { try { return fs.readFileSync(path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts"), "utf8"); } catch { return ""; } })();
  const libTool = (/"figma_list_libraries",\s*\{\s*description:([\s\S]*?)inputSchema/.exec(mcpSrc)?.[1] ?? "").replace(/"\s*\+\s*"/g, "");
  check("[F04-1] the list page gives a range with its cause and the no-libraries case, not a bare 5-15", /few seconds to ~15 s/.test(pageList) && /about 2 s when no\s+libraries are enabled/.test(pageList) && !/5-15/.test(pageList));
  check("[F04-1] no help page says \"5-15\" without the no-libraries clause", Object.values(HELP).every((h) => !/5-15/.test(h) || /no\s+libraries|~2 s/.test(h)));
  check("[F04-1] the MCP figma_list_libraries description was found in the source", libTool.length > 200);
  check("[F04-1] …and is not \"CHEAP discovery\": it calls itself the slowest discovery read, ~2 s with no libraries", !/CHEAP discovery/.test(libTool) && /SLOWEST discovery read/.test(libTool) && /about 2 s when no libraries are enabled/.test(libTool));
  check("[F04-1] figma-mcp.ts has no \"CHEAP discovery\" anywhere", mcpSrc.length > 0 && !/CHEAP discovery/.test(mcpSrc));
  check("[F04-1 rv] the MCP description keeps figma_list_libraries out of the default order (never \"Call this BEFORE exporting\")",
    !/Call this BEFORE exporting/.test(libTool) && /Not part of the default discovery order \(figma_status -> figma_list_pages -> figma_list_children -> figma_export_url\)/.test(libTool));
  check("[F04-1 rv] the per-collection reads are one call each (fanned out), never \"one at a time\" — list page and MCP description",
    !/one at a time/.test(libTool) && !/one at a time/.test(pageList) && /one Figma call per enabled library variable collection/.test(libTool) && /one Figma\s+call per enabled library variable collection/.test(pageList));
  const dsTool = (/"figma_export_design_system",\s*\{\s*description:([\s\S]*?)inputSchema/.exec(mcpSrc)?.[1] ?? "").replace(/"\s*\+\s*"/g, "");
  check("[F05-1] the MCP design-system description gives ~15–40 s and the progress-token caveat", /~15–40 s on a real file/.test(dsTool) && /progress only to clients that send a progress token/.test(dsTool));
  check("[DT08-5] …and says the pull is not the library's catalog, with the --as-library route (no \"fewer of them\")", /never the library's catalog/.test(dsTool) && /--as-library/.test(dsTool) && !/fewer of them/.test(dsTool));
  check("[DT08-5] the pull help page says the same for --design-system", /CONSUMES a library/.test(HELP.pull ?? "") && /never the library's\s+catalog/.test(HELP.pull ?? ""));
  check("[DT05-2] the list page documents children's childCount and `title`; the screenshot page says \"at the default scale\"", /childCount/.test(pageList) && /`title`/.test(pageList) && /at the default scale it leaves no duplicate/.test(HELP.screenshot ?? ""));
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

report();
