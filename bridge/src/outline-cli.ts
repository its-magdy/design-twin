// `dtwin outline <screen.json> [--budget N]`: the outline (outline.ts) of a screen already on disk. No bridge, no
// token, no plugin: it only reads the file. Without --budget the outline is printed whole.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { errMsg } from "./errmsg.ts";
import { CliExit, exitCli } from "./stdio.ts";
import { OUTLINE_HELP } from "./cli-commands.ts";
import { screenOutline } from "./outline.ts";
import type { ScreenExport } from "./doc-types.ts";

function args_(args: string[]): { file: string; budget: number } {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { budget: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(OUTLINE_HELP);
    exitCli(0);
  }
  const file = positionals[0];
  if (file === undefined || positionals.length !== 1) throw new Error("name one screen JSON file");
  const budget = values.budget === undefined ? Number.MAX_SAFE_INTEGER : Number(values.budget);
  if (!Number.isInteger(budget) || budget <= 0) throw new Error("--budget takes a positive whole number of characters");
  return { file, budget };
}

function fail(message: string): never {
  console.error("[dtwin] error: " + message);
  return exitCli(1);
}

export function main(args: string[]): void {
  let parsed: { file: string; budget: number };
  try {
    parsed = args_(args);
  } catch (e) {
    if (e instanceof CliExit) throw e;
    fail(errMsg(e) + "\n\n" + OUTLINE_HELP);
  }
  const { file, budget } = parsed;
  let doc: ScreenExport;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as ScreenExport;
    if (!Array.isArray(doc.nodes)) throw new Error("no nodes[]: not a screen export (pages/<Page>/<Screen>__<id>.json)");
  } catch (e) {
    fail(`cannot read ${file}: ${errMsg(e)}`);
  }
  const outline = screenOutline({ screen: doc, screenName: doc.screen, sourceFile: doc.sourceFile }, {
    limit: budget,
    more: (level) => `${level === "sections" ? "pull a section with `dtwin pull --node <id>`; " : ""}${file} is the full JSON, the source of truth.`,
  });
  if (!outline) fail(`--budget ${budget} is too small for even the section list`);
  console.log(outline.text);
}
