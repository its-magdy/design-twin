// map-validate.ts — the `map-validate` CLI (claude-plugin/scripts/map-validate.js): argument parsing, output and exit codes over
// map-validate-core.ts, where everything another module needs lives. An entry module imports no other entry module
// (claude-plugin/build-scripts.ts refuses a bundle that would inline one).
import { scriptCmd } from "./cli-args.ts";
import { readJsonFile } from "./catalog-input.ts";
import { runCli } from "./proc.ts";
import { validateMap } from "./map-validate-core.ts";

// CLI: bun design-to-code/map-validate.ts <codeconnect.local.json>
export function main(argv: string[]): number {
  const file = argv[0];
  const USAGE = `usage: ${scriptCmd("map-validate")} <map.json>`;
  if (file === "--help" || file === "-h") { console.log(USAGE); return 0; }
  if (!file || file.startsWith("-")) { console.error((file ? `map-validate: unknown flag ${file}\n` : "") + USAGE); return 1; }
  const res = validateMap(readJsonFile(file, "component map"));
  if (res.ok) { console.log("map valid"); return 0; }
  res.errors.forEach((e) => console.error(`  ${e.path || "(root)"}: ${e.message}`));
  console.error(`\n${res.errors.length} error(s)`);
  return 1;
}

if (import.meta.main) runCli(main, { name: "map-validate" }); // exitCode, never exit(): every printed line drains first (proc.ts)
