// figma-pull's argument handling as pure functions: readArgs (what each flag says), validateArgs (the
// warnings and the refusal the CLI prints) and parseArgs (both, throwing the refusal).
//   node test/figma-pull-args.test.ts
// No bridge, no plugin, no port, no spawn: the outDir probe is a stub.
import path from "node:path";
import { check, report } from "./assert.ts";
import { UsageError, parseArgs, readArgs, validateArgs } from "../bridge/src/figma-pull.ts";

const usageError = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof UsageError ? e.message : "not a UsageError: " + String(e); }
};
const none = (): boolean => false;
// An `exists` stub that answers true for <dir>/export under the cwd, and records every probe.
const hasExport = (dir: string) => {
  const probed: string[] = [];
  const exists = (p: string): boolean => { probed.push(p); return p === path.resolve(process.cwd(), dir, "export"); };
  return { exists, probed };
};

console.log("\nfigma-pull args — readArgs reads, validateArgs refuses:");
{
  const conflict = ["--selection", "--all-pages"];
  check("readArgs does not refuse a scope conflict (that is validateArgs's job)", usageError(() => readArgs(conflict)) === null);
  const v = validateArgs(readArgs(conflict), none);
  check("validateArgs names the conflict as its error", v.error === "--selection and --all-pages select different scopes — pass only one." && v.warnings.length === 0);
  check("parseArgs throws that same message as a UsageError", usageError(() => parseArgs(conflict)) === v.error);
  check("a clean command line validates to no warnings and no error",
    JSON.stringify(validateArgs(readArgs(["--page", "1:2", "--css"]), none)) === JSON.stringify({ warnings: [], error: null }));
}

console.log("\nfigma-pull args — readArgs's own refusals (values and unknown flags):");
check("a value flag with no value is a UsageError from readArgs", usageError(() => readArgs(["--page"])) === "--page needs an id or name (see --list)");
check("a value flag followed by another flag has no value", usageError(() => readArgs(["--children", "--list"])) === "--children needs a node id (see --list)");
check("an unknown flag is refused with did-you-mean", /^unknown flag: --lsit \(did you mean --list\?\)/.test(usageError(() => readArgs(["--lsit"])) ?? ""));
check("--scale without --screenshot is refused while reading", /^--scale only applies to --screenshot/.test(usageError(() => readArgs(["--scale", "2"])) ?? ""));
{
  const r = readArgs(["out", "--page", "A", "--page=B", "--timeout", "5", "--client", "c1"]);
  check("repeated --page values are collected in order (space and = forms)", JSON.stringify(r.pageSel) === JSON.stringify(["A", "B"]));
  check("values taken by flags are never the positional outDir", r.outDir === "out" && r.userOutDir === "out" && r.client === "c1" && r.exportTimeoutMs === 5000);
  const t = readArgs(["--timeout", "7"]);
  check("with no positional, userOutDir is undefined (the flag value 7 is not it)", t.userOutDir === undefined && t.listTimeoutMs === 7000);
}

console.log("\nfigma-pull args — the outDir trap is a warning, returned not printed:");
{
  const real = console.error;
  const printed: unknown[] = [];
  console.error = (...a: unknown[]) => { printed.push(a); };
  let v: ReturnType<typeof validateArgs>;
  let other: ReturnType<typeof validateArgs>;
  let parsedDesign: ReturnType<typeof parseArgs>;
  try {
    v = validateArgs(readArgs(["design", "--selection", "--all-pages"]), hasExport("design").exists);
    other = validateArgs(readArgs(["shots", "--node", "1:2"]), hasExport("shots").exists);
    parsedDesign = parseArgs(["design", "--node", "1:2"]);
  } finally {
    console.error = real;
  }
  check("validateArgs, readArgs and parseArgs print nothing", printed.length === 0);
  check("a user outDir that already holds export/ warns, and the scope refusal still follows",
    v.warnings.length === 1 && (v.warnings[0] ?? "").startsWith(`design already contains ${path.join("design", "export")} — writing here too creates a PARALLEL export tree`)
    && v.error === "--selection and --all-pages select different scopes — pass only one.");
  check("for `design` the hint is `dtwin pull ...` (the default outDir)", (v.warnings[0] ?? "").includes("`dtwin pull ...`"));
  check("for another dir the hint names <dir>/export", (other.warnings[0] ?? "").includes("`dtwin pull shots/export ...`") && other.error === null);
  check("parseArgs neither warns nor refuses a valid command with a trapped outDir", parsedDesign.nodeId === "1:2");
  const clean = hasExport("design");
  const noOut = validateArgs(readArgs(["--node", "1:2"]), clean.exists);
  check("with no positional outDir the filesystem is not probed and nothing is warned", clean.probed.length === 0 && noOut.warnings.length === 0);
  const elsewhere = hasExport("design");
  const notTrapped = validateArgs(readArgs(["build", "--node", "1:2"]), elsewhere.exists);
  check("an outDir without export/ inside is probed once and not warned about",
    elsewhere.probed.length === 1 && elsewhere.probed[0] === path.resolve(process.cwd(), "build", "export") && notTrapped.warnings.length === 0);
}

console.log("\nfigma-pull args — command ownership guards:");
{
  const err = (args: string[]) => validateArgs(readArgs(args), none).error;
  check("two daemon commands are refused", err(["--serve", "--stop"]) === "--serve / --stop / --daemon-status are different commands — pass only one.");
  check("two token commands are refused, named in the command table's order", err(["--rotate-token", "--show-token"]) === "--show-token and --rotate-token are different commands — pass only one.");
  check("a token command beside a daemon command names the daemon command", /^--token-status manages the stored bridge token — it cannot be combined with --serve\./.test(err(["--token-status", "--serve"]) ?? ""));
  check("--token-file beside --token-status is refused, beside --show-token it is not",
    /^--token-status acts on the stored token/.test(err(["--token-status", "--token-file", "/x"]) ?? "") && err(["--show-token", "--token-file", "/x"]) === null);
  check("--json is refused on an export and allowed on an index command", /^--json applies to the commands that PRINT/.test(err(["--page", "A", "--json"]) ?? "") && err(["--list-clients", "--json"]) === null);
  check("--variant-visuals is the one read option --design-system accepts", err(["--design-system", "--variant-visuals"]) === null
    && /^--css is a read option for a node\/page walk — --design-system skips/.test(err(["--design-system", "--variant-visuals", "--css"]) ?? ""));
}

report();
