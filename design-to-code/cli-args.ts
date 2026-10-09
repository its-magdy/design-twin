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
import { errCode, errMsg } from "../bridge/src/errmsg.ts";

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
 * The single-dash words in `args` that are not a run of this tool's short flags: Node splits `-Button` into
 * -B -u -t -t -o -n (and reads `-h-thing` as -h, then `--`, then positionals), so a value that merely starts
 * with "-" would be reported as five unknown flags, or slip through as a help flag. A word right after a
 * value-taking flag is that flag's value (parseArgs rules on it), and everything after `--` is left alone.
 */
function badShortWords(args: string[], options: ParseArgsOptionsConfig): string[] {
  const shorts = new Map<string, string>();
  for (const o of Object.values(options)) if (o.short) shorts.set(o.short, o.type);
  const bad: string[] = [];
  let takesNext = false;
  for (const a of args) {
    if (a === "--") break;
    if (takesNext) { takesNext = false; continue; }
    if (a.startsWith("--")) { takesNext = !a.includes("=") && options[a.slice(2)]?.type === "string"; continue; }
    if (!/^-[^-]/.test(a)) continue;
    let ok = true;
    for (const [i, c] of [...a.slice(1)].entries()) {
      const type = shorts.get(c);
      if (type === undefined) { ok = false; break; }
      if (type === "string") { takesNext = i === a.length - 2; break; } // the rest of the word is its value
    }
    if (!ok) bad.push(a);
  }
  return bad;
}

/**
 * Run `parse` (a strict parseArgs call over the normalised `args` with `options`); on a parse error print
 * the tool's message + usage to stderr and exit with `exitCode`.
 */
export function cliParse<R>(tool: string, argv: string[], options: ParseArgsOptionsConfig, usage: string, exitCode: number, parse: (args: string[]) => R): R {
  const args = joinNegativeValues(argv, options);
  // Every unknown flag, named as typed: long ones from a loose re-read (it knows which words are values), plus
  // the single-dash words above, once each (never the letters Node expands them into), in the order typed.
  const unknownFlags = (): string => {
    const { tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
    const long = tokens.flatMap((t) => (t.kind === "option" && t.rawName.startsWith("--") && !(t.name in options) ? [{ name: t.rawName, at: t.index }] : []));
    const short = badShortWords(args, options);
    const hint = short.some((w) => w.length > 2) ? ' (a value starting with "-": put -- before it, or use --flag=value)' : "";
    const named = [...long, ...short.map((w) => ({ name: w, at: args.indexOf(w) }))].sort((a, b) => a.at - b.at).map((n) => n.name);
    return `${tool}: unknown flag ${[...new Set(named)].join(", ")}${hint}\n${usage}`;
  };
  let failure: string;
  try {
    // Node rules first, so its own error (a flag missing its value, a boolean given one) is the one reported;
    // the single-dash check runs only on argv Node accepted (it reads `-h-thing` as -h, `--`, positionals).
    const parsed = parse(args);
    if (!badShortWords(args, options).length) return parsed;
    failure = unknownFlags();
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      failure = unknownFlags();
    } else if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      // the name as typed: the message quotes "-o, --out <value>" or "--out"; take the form that is in argv
      const msg = e instanceof Error ? e.message : "";
      const names = /Option '([^']*)'/.exec(msg)?.[1]?.match(/--?[\w-]+/g) ?? [];
      const typed = names.find((n) => args.some((a) => a === n || a.startsWith(n + "="))) ?? names.at(-1);
      failure = `${tool}: ${typed ?? "an option"} ${/does not take an argument/.test(msg) ? "takes no value" : "needs a value"}\n${usage}`;
    } else {
      failure = `${tool}: ${errMsg(e)}\n${usage}`;
    }
  }
  console.error(failure);
  process.exit(exitCode);
}

/**
 * Check how many positionals a tool took: fewer than `min` prints the usage alone (what a tool prints for a
 * missing argument), more than `max` names the extra ones above the usage — a stray word is a typo, not
 * something to ignore. Prints to stderr; false means the caller returns its usage exit code.
 */
export function cliArity(tool: string, positionals: string[], min: number, max: number, usage: string): boolean {
  if (positionals.length < min) { console.error(usage); return false; }
  if (positionals.length > max) { console.error(`${tool}: unexpected argument ${positionals.slice(max).join(", ")}\n${usage}`); return false; }
  return true;
}

/** `argv` with a leading `--` dropped: for a CLI whose only flag is --help, every other word is an argument, so a
 *  name that starts with "-" is passed as-is (`tool -- -Divider`) or just typed (`tool -Divider`). */
export const bareArgs = (argv: string[]): string[] => argv[0] === "--" ? argv.slice(1) : argv;
