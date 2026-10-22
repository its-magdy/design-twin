// figma-pull's argument handling as pure functions: readArgs (what each flag says), validateArgs (the
// warnings and the refusal the CLI prints) and parseArgs (both, throwing the refusal).
//   bun test/figma-pull-args.test.ts
// No bridge, no plugin, no port, no spawn: the outDir probe is a stub.
import path from "node:path";
import { check, report } from "./assert.ts";
import { UsageError, parseArgs, readArgs, validateArgs } from "../bridge/src/figma-pull.ts";
import { COMMAND_ROWS, DEFAULT_COMMAND, FAMILIES, GUARDS, MODIFIERS, VALUE_READ_ORDER } from "../bridge/src/cli-commands.ts";
import type { CommandRow } from "../bridge/src/cli-commands.ts";
import { READ_OPT_ROWS } from "../bridge/src/read-opts.ts";
import { translate } from "../bridge/src/verbs.ts";

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
  check("values taken by flags are never the positional outDir", r.outDir === "out" && r.userOutDir === "out" && r.client === "c1" && r.timeoutOverrideMs === 5000);
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

// --timeout: one timer must hold it (setTimeout runs a longer delay, or Infinity, after 1 ms), and a daemon
// frame cannot carry Infinity (JSON null) — so those are refused up front rather than failing at once later.
console.log("\nfigma-pull args — --timeout bounds:");
check("--timeout Infinity is refused, naming the bound", /^--timeout expects a positive number of seconds \(at most 2147483, about 24 days\), got 'Infinity'$/.test(usageError(() => readArgs(["--timeout", "Infinity"])) ?? ""));
check("--timeout above the bound is refused", /got '2147484'$/.test(usageError(() => readArgs(["--timeout", "2147484"])) ?? ""));
check("--timeout at the bound is taken, for the connect window too", (() => { const r = readArgs(["--timeout", "2147483"]); return r.connectWaitMs === 2147483000 && r.timeoutOverrideMs === 2147483000; })());

// The command table (cli-commands.ts) is the whole command surface: every check below walks its rows,
// so a command added there is checked here without a line of this file changing.
const FLAGGED = COMMAND_ROWS.filter((r): r is CommandRow & { flag: string } => r.flag !== null);
const argvOf = (r: CommandRow & { flag: string }): string[] => (r.value ? [r.flag, "1:2"] : [r.flag]);
const err = (args: string[]): string | null => {
  try { return validateArgs(readArgs(args), none).error; } catch (e) { return e instanceof UsageError ? "READ: " + e.message : "not a UsageError: " + String(e); }
};
// A walk's failures, printed (the first three) when there are any, then checked to be none.
const noneOf = (name: string, failures: string[]): void => {
  for (const f of failures.slice(0, 3)) console.log("      " + f);
  check(name, failures.length === 0);
};
const commandOf = (args: string[]): string | null => { try { return parseArgs(args).command.id; } catch { return null; } };
// Which family's guard a cross-family pair falls to: the first GUARDS row of one family that lists the other.
const crossOwner = <R extends CommandRow>(a: R, b: R): R | null => {
  for (const g of GUARDS) {
    if (g.kind !== "cross") continue;
    if (g.family === a.family && g.others.includes(b.family)) return a;
    if (g.family === b.family && g.others.includes(a.family)) return b;
  }
  return null;
};

console.log("\nfigma-pull args — the command table: each command alone:");
check("no command flag is the default pull of the current page", commandOf([]) === DEFAULT_COMMAND.id && DEFAULT_COMMAND.flag === null && DEFAULT_COMMAND.family === "scope");
for (const r of FLAGGED) {
  check(`${r.flag} alone parses as the ${r.id} command, refused by nothing`, err(argvOf(r)) === null && commandOf(argvOf(r)) === r.id);
  if (r.value) check(`${r.flag} with no value is refused with its row's message`, err([r.flag]) === "READ: " + r.value.missing);
}
check("every family has a row, and every row's family is in the table", Object.keys(FAMILIES).every((f) => COMMAND_ROWS.some((r) => r.family === f)));

console.log("\nfigma-pull args — the command table: every pair of commands is refused:");
{
  const accepted: string[] = [];
  const unowned: string[] = [];
  const misworded: string[] = [];
  for (const a of FLAGGED) for (const b of FLAGGED) {
    if (a === b) continue;
    const m = err([...argvOf(a), ...argvOf(b)]);
    if (m === null) { accepted.push(`${a.flag} ${b.flag}`); continue; }
    if (a.family === b.family) {
      // Within one family the refusal names both commands.
      if (!(m.includes(a.flag) && m.includes(b.flag))) misworded.push(`${a.flag} ${b.flag}: ${m}`);
    } else {
      // Across families one family owns the pair: its command leads the refusal and the other is named.
      const owner = crossOwner(a, b);
      const other = owner === a ? b : a;
      if (!owner) unowned.push(`${a.family}/${b.family}`);
      else if (!m.startsWith(owner.flag) || !m.includes(other.flag)) misworded.push(`${a.flag} ${b.flag}: ${m}`);
    }
  }
  noneOf("no two commands are accepted together, in either order", accepted);
  noneOf("every pair of families has a guard that owns it", [...new Set(unowned)]);
  noneOf("each refusal is led by the owning command and names the other", misworded);
  check("--list beside --list-pages is refused (the two flags once folded into one value, and --list-pages ran)",
    err(["--list", "--list-pages"]) === "--list and --list-pages are different queries — pass only one.");
}

console.log("\nfigma-pull args — the command table: read options follow each row's read:");
{
  const wrong: string[] = [];
  for (const r of [DEFAULT_COMMAND, ...FLAGGED]) for (const o of READ_OPT_ROWS) {
    const args = [...(r.flag ? argvOf(r as CommandRow & { flag: string }) : []), o.flag];
    const takes = r.reads !== null && o.scopes.includes(r.reads);
    const m = err(args);
    if (takes ? m !== null : !(m && m.includes(o.flag) && m.includes(r.flag ?? ""))) wrong.push(`${r.flag ?? "(pull)"} ${o.flag}: ${m}`);
  }
  noneOf("a read option is accepted exactly where the row's read takes it, and otherwise refused naming both", wrong);
  check("an index command's read-option refusal says what that command prints",
    FLAGGED.filter((r) => r.family === "index").every((r) => (err([...argvOf(r), "--css"]) ?? "").includes(`${r.flag} ${r.emits}`)));
}

console.log("\nfigma-pull args — the command table: modifiers:");
{
  const allRows = [DEFAULT_COMMAND, ...FLAGGED];
  const with_ = (r: CommandRow, extra: string[]) => err([...(r.flag ? argvOf(r as CommandRow & { flag: string }) : []), ...extra]);
  check("--client and --timeout are refused beside no command", allRows.every((r) => with_(r, ["--client", "c1"]) === null && with_(r, ["--timeout", "5"]) === null));
  check("--json is accepted beside exactly the index family", allRows.every((r) => (with_(r, ["--json"]) === null) === (r.family === "index")));
  check("--scale is accepted beside exactly --screenshot", allRows.every((r) => (with_(r, ["--scale", "2"]) === null) === (r.id === "screenshot")));
  const tokenFile = GUARDS.find((g) => g.kind === "tokenFile");
  check("--token-file is refused beside exactly the token commands that act on the stored token",
    !!tokenFile && tokenFile.kind === "tokenFile" && allRows.every((r) => (with_(r, ["--token-file", "/x"]) === null) === !tokenFile.ignoredBy.includes(r.id)));
}

console.log("\nfigma-pull args — the command table: unknown flags and verbs:");
{
  const known = [...FLAGGED.map((r) => r.flag), ...MODIFIERS.map((m) => m.flag)];
  const valueFlags = [...FLAGGED.filter((r) => r.value).map((r) => r.flag), ...MODIFIERS.filter((m) => m.value).map((m) => m.flag)];
  check("VALUE_READ_ORDER lists exactly the table's value-taking flags, each once",
    JSON.stringify([...VALUE_READ_ORDER].sort()) === JSON.stringify([...valueFlags].sort()));
  check("every command and modifier flag is known (none is refused as unknown)", known.every((f) => !/unknown flag/.test(err(MODIFIERS.some((m) => m.flag === f && m.value) || FLAGGED.some((r) => r.flag === f && r.value) ? [f, "1"] : [f]) ?? "")));
  const typos = known.filter((f) => f !== "--help").map((f) => [f, err([f + "q"])] as const).filter(([f, m]) => !(m ?? "").includes(`unknown flag: ${f}q (did you mean ${f}?)`));
  noneOf("a one-letter typo of every known flag is refused, offering that flag", typos.map(([f, m]) => `${f}: ${m}`));
  const verbs = FLAGGED.flatMap((r) => (r.verbs ?? []).map((v): [CommandRow, string[]] => [r, [...v, ...(r.value ? ["1:2"] : [])]]));
  const bad = verbs.filter(([r, v]) => commandOf(translate(v)) !== r.id);
  noneOf("every command outside the scope family has a `dtwin <verb>` spelling (a scope is `dtwin pull <flag>`)", FLAGGED.filter((r) => r.family !== "scope" && !r.verbs?.length).map((r) => r.id));
  noneOf("every row's `dtwin <verb>` spelling runs that row's command", bad.map(([, v]) => v.join(" ")));
  const missing = FLAGGED.filter((r) => r.value?.verbMissing && r.verbs).filter((r) => {
    try { translate([...(r.verbs?.[0] ?? [])]); return true; } catch (e) { return (e as Error).message !== r.value?.verbMissing; }
  });
  noneOf("a value-taking verb with no value is refused with its row's message", missing.map((r) => r.id));
}

report();
