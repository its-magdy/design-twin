// The MCP tool list (bridge/src/mcp-tools.ts MCP_TOOLS) against everything that repeats it by hand: `dtwin mcp --help`,
// the help skill, bridge/README.md and ARCHITECTURE.md's counts. A tool added, renamed or dropped in one place and not
// the others fails here, by name. (test/mcp-smoke.test.ts holds the running server's listTools() to the same list.)
// Starts no server; binds no port.
// Run with:  bun test/mcp-tools.test.ts
import fs from "node:fs";
import path from "node:path";
import { check, report } from "./assert.ts";
import { DISK_READS, LIVE_READS, MCP_TOOLS, WRITES, planeOf } from "../bridge/src/mcp-tools.ts";
import { MCP_HELP } from "../bridge/src/cli-commands.ts";

const REPO = path.join(import.meta.dirname, "..");
const NAMES: readonly string[] = MCP_TOOLS.map((t) => t.name);
// Prose wraps: one line, single spaces.
const flat = (s: string): string => s.replace(/\s+/g, " ");
const doc = (rel: string): string => flat(fs.readFileSync(path.join(REPO, rel), "utf8"));
/** The tool names `text` quotes in backticks (with or without the mcp__designtwin__ prefix); wildcards like figma_* aside. */
const quoted = (text: string): Set<string> =>
  new Set([...text.matchAll(/`(?:mcp__designtwin__)?((?:figma|design)_[a-z_]+)`/g)].map((m) => m[1] ?? ""));
const missing = (text: string): string[] => NAMES.filter((n) => !quoted(text).has(n));
const unknown = (text: string): string[] => [...quoted(text)].filter((n) => !NAMES.includes(n));
const say = (what: string, xs: string[]): string => (xs.length ? ` — ${what}: ${xs.join(", ")}` : "");

console.log("MCP_TOOLS itself:");
check("names are unique", new Set(NAMES).size === NAMES.length);
check("figma_write is the only write", WRITES.join() === "figma_write" && planeOf("figma_write") === "write");
check("the three groups cover every tool once", LIVE_READS.length + WRITES.length + DISK_READS.length === MCP_TOOLS.length
  && [...LIVE_READS, ...WRITES, ...DISK_READS].every((n) => NAMES.includes(n)));
check("a name not in the list has no plane", planeOf("figma_delete_everything") === undefined);

console.log("`dtwin mcp --help`:");
const help = flat(MCP_HELP);
check(`names every tool${say("missing", NAMES.filter((n) => !help.includes(n)))}`, NAMES.every((n) => help.includes(n)));
check("gives the count", help.includes(`Its ${MCP_TOOLS.length} tools`));

for (const rel of ["claude-plugin/skills/help/SKILL.md", "bridge/README.md"]) {
  console.log(`${rel}:`);
  const text = doc(rel);
  const gone = missing(text), extra = unknown(text);
  check(`names every tool${say("missing", gone)}`, gone.length === 0);
  check(`names no tool the server does not have${say("unknown", extra)}`, extra.length === 0);
}
{
  const m = /Tools \((\d+)\):/.exec(doc("bridge/README.md"));
  check(`bridge/README.md's "Tools (N):" is ${MCP_TOOLS.length} (says ${m?.[1] ?? "nothing"})`, Number(m?.[1]) === MCP_TOOLS.length);
}

console.log("ARCHITECTURE.md:");
{
  const text = doc("ARCHITECTURE.md");
  const m = /(\d+) of its (\d+) tools are reads \((\d+) live `figma_\*` reads that mirror the CLI, plus (\d+) `design_\*` tools/.exec(text);
  const reads = MCP_TOOLS.filter((t) => t.plane === "read").length;
  check("states the counts in the one sentence this test reads", m !== null);
  if (m) {
    check(`"${m[1]} of its ${m[2]} tools are reads" is ${reads} of ${MCP_TOOLS.length}`, Number(m[1]) === reads && Number(m[2]) === MCP_TOOLS.length);
    check(`"${m[3]} live figma_* reads" is ${LIVE_READS.length}`, Number(m[3]) === LIVE_READS.length);
    check(`"${m[4]} design_* tools" is ${DISK_READS.length}`, Number(m[4]) === DISK_READS.length);
  }
  const extra = unknown(text);
  check(`names no tool the server does not have${say("unknown", extra)}`, extra.length === 0);
  check("names figma_write as the only write", text.includes("`figma_write` is the only write surface"));
}

report();
