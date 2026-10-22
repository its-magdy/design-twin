// verbs.ts — `dtwin <verb>` front door. A PURE argv → argv translation onto the flags figma-pull.ts
// already parses, so there is one parser and one set of guards, and every existing `--flag`
// invocation keeps working unchanged (clig.dev: subcommands to tame a large surface; never break the
// old spelling silently).
//
//   dtwin pull [outDir] [flags]      = dtwin [outDir] [flags]
//   dtwin list [pages|libraries|clients]   = --list | --list-pages | --list-libraries | --list-clients
//   dtwin list children <id|url>     = --children <id|url>
//   dtwin whoami                     = --whoami
//   dtwin screenshot <id|url>        = --screenshot <id|url>
//   dtwin serve | stop | status      = --serve | --stop | --daemon-status
//   dtwin token [status|show|rotate|forget]  = --token-status | --show-token | --rotate-token | --forget-token
//   dtwin help | version             = --help | --version
//   dtwin doctor | init | mcp | seed → their own entry points (routed in figma-pull.ts)
//
// A verb is only recognised as the FIRST argument. `dtwin design` still means "pull into ./design":
// an outDir that happens to be spelled like a verb is written `dtwin pull list` or `dtwin ./list`.

import { COMMAND_ROWS, VERB_DEFS } from "./cli-commands.ts";
import type { CommandRow } from "./cli-commands.ts";

export class VerbError extends Error {}

// Every spelling, help page and summary line is a row in cli-commands.ts (the command registry): the
// sub-nouns of `list` and `token` are the spellings on its COMMANDS rows, the verbs and their pages are
// its VERB_ROWS. Derived here, so a command added there is a verb here without a line of this file changing.
export { SEED_HELP } from "./cli-commands.ts";
export const VERBS: string[] = VERB_DEFS.map((v) => v.word);

// Words people (and agents) reach for first that are NOT verbs. Left alone they were a positional
// outDir: `dtwin export` created ./export and then waited for a plugin, looking exactly like a pull
// that was working. Same opt-outs as a near-miss: a path, an existing folder, or `dtwin pull export`.
const ALIASES: Record<string, string> = { export: "pull", get: "pull", fetch: "pull", download: "pull", sync: "pull", ls: "list", frames: "list", pages: "list pages", libraries: "list libraries", clients: "list clients",
  check: "doctor", diagnose: "doctor", setup: "init", install: "init", connect: "doctor", start: "serve", daemon: "serve", kill: "stop", tokens: "token" };
// (`version` was listed here as an alias for `--version`, which made the real `dtwin version` a
// did-you-mean error that pointed at itself. It is a verb row of its own now.)

const isFlag = (a: unknown): boolean => typeof a === "string" && a.startsWith("-");

// Per-verb help. `dtwin screenshot --help` must not hit translate's "needs a node id" refusal, which
// the verb's own argument check would give if it ran before the global --help handler — a help probe
// is the one thing that must never be answered with an error. Every verb has its own page (a row's
// `help`) or answers through its own entry point (OWN_HELP_ROUTED); only `help` prints the full `dtwin --help`.
export const HELP: Record<string, string> = Object.fromEntries(VERB_DEFS.flatMap((v) => (v.help === undefined ? [] : [[v.word, v.help]])));

// The verbs that answer `--help` through their own entry point (routed in figma-pull.ts before verbHelp
// runs) and have no page here. `help` is the one other verb without a page: its page IS the full usage.
// test/cli-help.test.ts walks the verb rows and requires every one to have a page or be in this list.
export const OWN_HELP_ROUTED: readonly string[] = VERB_DEFS.filter((v) => v.to === "routed" && v.help === undefined).map((v) => v.word);

// The only port override is FIGMA_BRIDGE_PORT; DTWIN_PORT is not read, so setting it would be silently ignored.
// One sentence for the CLI and doctor, or null when DTWIN_PORT is not set.
export function dtwinPortWarning(env: Record<string, string | undefined>): string | null {
  return env.DTWIN_PORT === undefined ? null : "DTWIN_PORT is not read — use FIGMA_BRIDGE_PORT (8787/8788/8789)";
}

/** A `dtwin <verb> [sub]` spelling of a command, with the command it means. */
interface Spelling { row: CommandRow; flag: string; words: readonly string[] }
const SPELLINGS: Spelling[] = COMMAND_ROWS.flatMap((row) => (row.flag === null ? [] : (row.verbs ?? []).map((words) => ({ row, flag: row.flag as string, words }))));

export function translate(argv: string[], exists: (p: string) => boolean = () => false): string[] {
  const [verb, ...rest] = argv;
  if (!verb || isFlag(verb)) return argv;
  const def = VERB_DEFS.find((v) => v.word === verb);
  if (def) {
    if (def.to === "pull") return rest;
    if (def.to === "routed") return argv; // doctor | init | mcp | seed: routed by figma-pull.ts, not translated here
    if (def.to !== "commands") return [def.to, ...rest]; // help | version
    const mine = SPELLINGS.filter((s) => s.words[0] === verb);
    if (def.badSub) {
      // A verb with sub-nouns (`list pages`, `token rotate`): the first word after it, unless it is a flag.
      const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
      const hit = mine.find((s) => (s.words[1] ?? "") === sub);
      if (!hit) throw new VerbError(def.badSub(sub));
      return takeValue(hit, rest.slice(sub ? 1 : 0));
    }
    const hit = mine.find((s) => s.words.length === 1);
    if (hit) return takeValue(hit, rest);
  }
  // Not a verb: a positional outDir — unless it is a near-miss of one. `dtwin whomai` would otherwise
  // start a full pull into ./whomai; a bare word one or two edits from a verb is far likelier
  // a typo than a folder. A path (`./serv`), an existing folder (`exists`), or `dtwin pull serv` opts out.
  const alias = ALIASES[verb.toLowerCase()];
  if (alias && !/[\\/.]/.test(verb) && !exists(verb))
    throw new VerbError(`unknown command \`${verb}\` — did you mean \`dtwin ${alias}\`? (to export into a folder named "${verb}": dtwin pull ${verb})`);
  const near = nearestVerb(verb);
  if (near && !/[\\/.]/.test(verb) && !exists(verb))
    throw new VerbError(`unknown command \`${verb}\` — did you mean \`dtwin ${near}\`? (to export into a folder named "${verb}": dtwin pull ${verb})`);
  return argv;
}

// A spelling's flag in front of what follows it. A value-taking command (`dtwin screenshot <id>`,
// `dtwin list children <id>`) needs its value next: it becomes the flag's value, the rest passes through.
function takeValue({ row, flag }: Spelling, rest: string[]): string[] {
  if (!row.value) return [flag, ...rest];
  if (!rest[0] || isFlag(rest[0])) throw new VerbError(row.value.verbMissing ?? row.value.missing);
  return [flag, rest[0], ...rest.slice(1)];
}

// The verb whose help a given argv is asking for, or null. Exported so figma-pull can answer BEFORE
// translate runs its per-verb argument checks.
export function verbHelp(argv: unknown): string | null {
  if (!Array.isArray(argv) || !argv.some((a) => a === "--help" || a === "-h")) return null;
  const verb: unknown = argv[0];
  return (typeof verb === "string" && verb && HELP[verb]) || null;
}

export function distance(a: string, b: string): number {
  // Levenshtein, one row at a time. `row` is the previous row (row[j] = distance(a[0..i-1), b[0..j)));
  // `diag`/`left` carry row[j-1] and the new row's [j-1] so no cell is read by index.
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  let last = b.length; // the bottom-right cell: row[b.length]
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let diag = i - 1; // row[0] of the previous row
    let left = i;     // next[0]
    for (const [k, up] of row.slice(1).entries()) { // k = j - 1, up = row[j]
      const cur = Math.min(up + 1, left + 1, diag + (a[i - 1] === b[k] ? 0 : 1));
      next.push(cur);
      diag = up;
      left = cur;
    }
    row = next;
    last = left;
  }
  return last;
}

// Two edits for the longer verbs. A short verb ("pull", "list", "stop", "mcp" …) is one edit from real
// folder names ("dist" ↔ "list"), so there only a dropped or extra LAST letter counts ("lis", "lists").
function nearestVerb(word: string): string | null {
  const w = String(word).toLowerCase();
  let best: { v: string; d: number } | null = null;
  for (const v of VERBS) {
    const d = distance(w, v);
    const ok = v.length >= 5 ? d <= (v.length >= 6 ? 2 : 1) : d === 1 && (w.startsWith(v) || v.startsWith(w));
    if (ok && (!best || d < best.d)) best = { v, d };
  }
  return best && best.v;
}
