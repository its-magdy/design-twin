// resolve-screen.ts — the `resolve-screen` CLI (claude-plugin/scripts/resolve-screen.js): argument parsing, output and exit codes over
// resolve-screen-core.ts, where everything another module needs lives. An entry module imports no other entry module
// (claude-plugin/build-scripts.ts refuses a bundle that would inline one).
import type { ScreenCandidate } from "./types.ts";
import { ifDefined } from "../bridge/src/json-util.ts";
import { screenStem } from "../bridge/src/pages-layout.ts";
import { bareArgs, cliArity, scriptCmd } from "./cli-args.ts";
import { runCli } from "./proc.ts";
import { nodeArtefacts } from "./node-artefacts.ts";
import { resolveScreen } from "./resolve-screen-core.ts";

// CLI: node <plugin>/scripts/resolve-screen.js <design/export dir> <name-or-id> [design/plan dir]
// (the installed path in a consumer project; in THIS repo it is design-to-code/resolve-screen.ts).
export function main(argv: string[]): number {
  const usage = `usage: ${scriptCmd("resolve-screen")} <design/export dir> <name-or-id> [design/plan dir]`;
  if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); return 0; }
  // --help is the only flag, so every other word is an argument — a screen named "--- Draft ---" is looked up, not parsed
  const positionals = bareArgs(argv);
  if (!cliArity("resolve-screen", positionals, 2, 3, usage)) return 2;
  const [exportDir, query, planDir] = positionals;
  if (!exportDir || !query) {
    console.error(usage);
    return 2;
  }
  const NOTITLES_NOTE =
    "note   this export's index carries no titles (pulled before title indexing) — re-pull the " +
    "screen (`dtwin pull --node <id>`) to enable lookup by title";
  const listCandidates = (candidates: ScreenCandidate[]): void => {
    for (const c of candidates) console.error(`  ${c.id}  ${c.name}${c.title ? ` (title: "${c.title}")` : ""}${c.matchedVia ? ` [matched: ${c.matchedVia.join(", ")}]` : ""}  ${c.w || "?"}x${c.h || "?"}  nodes=${c.nodes ?? "?"}  ${c.reference || ""}  -> ${c.screenshot}`);
  };
  const res = resolveScreen(exportDir, query, { ...ifDefined("planDir", planDir) });
  if (res.status === "resolved") {
    console.log(`resolved '${query}' -> ${res.row.name} (${res.row.id}) via ${res.stage}`);
    // the key the screen's files are named by, as screen-key.ts screenKey names it (node-artefacts.ts claim): plans,
    // verify sets, --status. A verify set already in design/verify for the node keeps its stem, so after a rename in
    // Figma this names the existing set — and so does a run open in the run cache before any of its files exist.
    const k = nodeArtefacts(process.cwd()).claim("verify set", res.row.id, { layerName: res.row.name });
    console.log(`stem ${k.ok ? k.name : screenStem(res.row.name, res.row.id)}`);
    if (!k.ok) console.error(`note   ${k.why}`);
    else if (k.legacy.length) console.error(`note   legacy-named verify set(s) of this node: ${k.legacy.join(", ")} — verify-screen --migrate renames them to ${k.name}`);
    process.stdout.write(JSON.stringify(res.row, null, 2) + "\n");
    return 0;
  }
  if (res.status === "ambiguous") {
    console.error(`error  '${query}' matches ${res.candidates.length} screens at the '${res.stage}' stage — pick one by node id:`);
    listCandidates(res.candidates);
    return 1;
  }
  if (res.status === "needs-confirmation") {
    console.error(res.stage === "text search" ? `error  '${query}' matched only by text search — confirm with the node id (never resolved automatically from a substring hit):`
      : `error  '${query}' matched only ignoring spaces/-/_ — confirm with the node id (never resolved automatically from a near-match):`);
    listCandidates(res.candidates);
    if (res.noTitles) console.error(NOTITLES_NOTE);
    return 1;
  }
  if (res.noIndex) {
    console.error(`error  '${exportDir}' is not an export root (no pages/index.json) — ${res.noIndex.hint ? `pass ${res.noIndex.hint}` : "pass the dir that holds pages/ (design/export)"}`);
    return 1;
  }
  console.error(`error  '${query}' matches no screen. Known layers:`);
  listCandidates(res.candidates);
  if (res.noTitles) console.error(NOTITLES_NOTE);
  return 1;
}

if (import.meta.main) runCli(main, { name: "resolve-screen" }); // exitCode, never exit(): every printed line drains first (proc.ts)
