// cli-args.ts — node:util parseArgs for the design-to-code CLIs, with this repo's error wording.
//
// Pulling flags out of argv by hand (`take("--out")` = indexOf + splice) takes the
// NEXT word as a flag's value whatever it is: `--out --json` would write to a file called "--json" and run
// without --json. parseArgs (strict) refuses a value that looks like a flag, knows `--out=x`, and still
// leaves positionals in order. What it does not do is say it the way these tools always have, so the
// parse runs inside cliParse(), which turns its errors into the one-line messages below:
//   <tool>: unknown flag --a, --b          (every unknown flag, not just the first)
//   <tool>: --out needs a value            (missing, or the next word is itself a flag)
//   <tool>: --json takes no value          (--json=1)
// followed by the tool's usage, and the tool's usage exit code. One thing parseArgs gets wrong for these
// tools: `--grid -1` reads `-1` as a flag, so the value-taking flag reports "needs a value" and the tool's
// own "must be a positive number" message is unreachable except as `--grid=-1`. cliParse joins a negative
// number onto the value-taking flag before it (`--grid=-1`) so the tool sees it and says why it is wrong.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

/**
 * The command a usage line or a printed hint gives for another script: its REAL path, so the model can copy
 * it into Bash as-is. Not `${CLAUDE_PLUGIN_ROOT}`: that is substituted in skill/agent Markdown only — it is
 * not an environment variable in the Bash tool, so a usage line quoting it would hand the model a command with an
 * empty path. In a bundle this module is inlined, so import.meta.url is the bundle
 * itself (claude-plugin/scripts/<entry>.js) and its folder holds every sibling script; run from a clone, it is
 * design-to-code/cli-args.ts and the siblings are the .ts sources Node runs directly. Printed output only —
 * never put it in a file the tools write (an absolute, per-install path would change the file's hash).
 */
const SELF = fileURLToPath(import.meta.url);
// Double quotes keep spaces; a path that also holds a character the shell expands inside them (" $ ` \, and
// zsh's history !) is single-quoted instead, with any ' closed, escaped and reopened.
const shellQuote = (p: string): string => /["$`\\!]/.test(p) ? `'${p.replaceAll("'", `'\\''`)}'` : `"${p}"`;
/** One argument of a printed command as one shell word: bare when it holds only characters no shell treats
 *  specially (a path like design/verify/Plots.json), else quoted as above — a project path may hold a space. */
export const shellArg = (a: string): string => /^[\w@%+=:,./-]+$/.test(a) ? a : shellQuote(a);
export const scriptCmd = (name: string): string => `node ${shellQuote(path.join(path.dirname(SELF), name + path.extname(SELF)))}`;

function errCode(e: unknown): string | undefined {
  return e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** `--flag -3` → `--flag=-3` for every value-taking `--flag` in `options`; everything after `--` is left alone. */
function joinNegativeValues(argv: string[], options: ParseArgsOptionsConfig): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i], next = argv[i + 1];
    if (tok === undefined) continue; // i < argv.length, so never
    if (tok === "--") { out.push(...argv.slice(i)); break; }
    const name = tok.startsWith("--") ? tok.slice(2) : undefined;
    if (name !== undefined && next !== undefined && options[name]?.type === "string" && /^-\d/.test(next)) { out.push(`${tok}=${next}`); i++; }
    else out.push(tok);
  }
  return out;
}

/**
 * Run `parse` (a strict parseArgs call over the normalised `args` with `options`); on a parse error print
 * the tool's message + usage to stderr and exit with `exitCode`.
 */
export function cliParse<R>(tool: string, argv: string[], options: ParseArgsOptionsConfig, usage: string, exitCode: number, parse: (args: string[]) => R): R {
  const args = joinNegativeValues(argv, options);
  try {
    return parse(args);
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      // Name them all: re-read loosely and list every option token parseArgs does not know.
      const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
      const unknown = [...new Set(tokens.flatMap((t) => (t.kind === "option" && !(t.name in options) ? [t.rawName] : [])))];
      console.error(`${tool}: unknown flag ${unknown.join(", ")}\n${usage}`);
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      const msg = e instanceof Error ? e.message : "";
      const m = /Option '(-[\w-]+|--[\w-]+)/.exec(msg);
      console.error(`${tool}: ${m ? m[1] : "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}\n${usage}`);
    } else {
      console.error(`${tool}: ${e instanceof Error ? e.message : String(e)}\n${usage}`);
    }
    process.exit(exitCode);
  }
}
