// cross-check.ts — the `cross-check` CLI (claude-plugin/scripts/cross-check.js): argument parsing, output and exit codes over
// cross-check-core.ts, where everything another module needs lives. An entry module imports no other entry module
// (claude-plugin/build-scripts.ts refuses a bundle that would inline one).
import fs from "node:fs";
import path from "node:path";
import { crossCheckInputOf, readScreenInputs } from "./screen-inputs.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { runCli } from "./proc.ts";
import { crossCheck, toMarkdown } from "./cross-check-core.ts";

// CLI: bun design-to-code/cross-check.ts <screen.json>... [--design-system design/export/design-system]
//        [--variables design/export/variables.json] [--map design/codeconnect.local.json] [--out design/audit/<screen>.cross] [--json] [--gate]
// Every input is checked as it is read (doc-guards.ts / export-shape.ts): a file that is not the kind of
// document it should be is a one-line error and exit 2.
export function main(argv: string[]): number {
  const USAGE =
    `usage: ${scriptCmd("cross-check")} <screen.json>... [--design-system design/export/design-system | design/export/libraries/<dir>] ` +
    "[--variables design/export/variables.json] [--map design/codeconnect.local.json] [--out design/audit/<screen>.cross] [--json] [--gate]";
  const OPTIONS = {
    "design-system": { type: "string" }, variables: { type: "string" }, map: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, gate: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } as const;
  const { values: flags, positionals: files } = cliParse("cross-check", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  if (!files.length) { console.error(USAGE); return 2; }
  const { "design-system": dsDir, variables: varsFile, map: mapFlag, out } = flags;
  const jsonOnly = !!flags.json, gate = !!flags.gate;

  // A screen plus what surrounds it — its own slice, the variables union, the design system (either layout; found beside
  // the export when not given), the component map, the export's other screens — assembled by screen-inputs.ts, shared
  // with audit.ts. Optional inputs are read only when present: the whole point is that this runs on a project that has a
  // screen and nothing else, and SAYS which checks it could not do (notChecked) rather than dying on a missing design
  // system. One that IS there but is not what it should be fails loud; a broken map that was only found is a warning.
  const read = readScreenInputs(files, { variables: varsFile, designSystem: dsDir, map: mapFlag, mapFlag: true });
  if ("errors" in read) { for (const e of read.errors) console.error(e); return 2; }
  for (const n of read.inputs.notes) console.error(n);
  const res = crossCheck(crossCheckInputOf(read.inputs));
  if (jsonOnly) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  } else if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out + ".json", JSON.stringify(res, null, 2) + "\n");
    fs.writeFileSync(out + ".md", toMarkdown(res));
    console.error(`wrote ${out}.json and ${out}.md`);
  } else {
    process.stdout.write(toMarkdown(res));
  }
  console.error(`${res.summary.blockers} blocker(s), ${res.summary.warnings} warning(s), ${res.summary.info} info`);
  for (const n of res.notChecked) console.error(`note  not checked: ${n}`);
  return gate && res.summary.blockers > 0 ? 1 : 0;
}

if (import.meta.main) runCli(main, { name: "cross-check" }); // exitCode, never exit(): every printed line drains first (proc.ts)
