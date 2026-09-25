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
//   dtwin doctor | init | mcp        → their own entry points (routed in figma-pull.ts)
//
// A verb is only recognised as the FIRST argument. `dtwin design` still means "pull into ./design":
// an outDir that happens to be spelled like a verb is written `dtwin pull list` or `dtwin ./list`.

export class VerbError extends Error {}

// The sub-noun and simple-verb tables, keyed by their own literal unions: a typo in a table key is a
// compile error rather than a dead row, and `has()` narrows a user-typed word to a key before lookup.
type ListSub = "" | "frames" | "pages" | "libraries" | "libs" | "clients";
type TokenSub = "" | "status" | "show" | "rotate" | "forget";
type SimpleVerb = "whoami" | "serve" | "stop" | "status" | "help" | "version";
const LIST: Record<ListSub, string> = { "": "--list", frames: "--list", pages: "--list-pages", libraries: "--list-libraries", libs: "--list-libraries", clients: "--list-clients" };
const TOKEN: Record<TokenSub, string> = { "": "--token-status", status: "--token-status", show: "--show-token", rotate: "--rotate-token", forget: "--forget-token" };
const SIMPLE: Record<SimpleVerb, string> = { whoami: "--whoami", serve: "--serve", stop: "--stop", status: "--daemon-status", help: "--help", version: "--version" };
const has = <K extends string>(table: Record<K, string>, word: string): word is K => Object.prototype.hasOwnProperty.call(table, word);
export const VERBS: string[] = ["pull", "list", "whoami", "screenshot", "serve", "stop", "status", "token", "doctor", "init", "mcp", "help", "version"];

// Words people (and agents) reach for first that are NOT verbs. Left alone they were a positional
// outDir: `dtwin export` created ./export and then waited for a plugin, looking exactly like a pull
// that was working. Same opt-outs as a near-miss: a path, an existing folder, or `dtwin pull export`.
const ALIASES: Record<string, string> = { export: "pull", get: "pull", fetch: "pull", download: "pull", sync: "pull", ls: "list", frames: "list", pages: "list pages", libraries: "list libraries", clients: "list clients",
  check: "doctor", diagnose: "doctor", setup: "init", install: "init", connect: "doctor", start: "serve", daemon: "serve", kill: "stop", tokens: "token" };
// (`version` was listed here as an alias for `--version`, which made the real `dtwin version` a
// did-you-mean error that pointed at itself. It is a SIMPLE verb now.)

const isFlag = (a: unknown): boolean => typeof a === "string" && a.startsWith("-");

// Per-verb help. `dtwin screenshot --help` used to hit translate's "needs a node id" refusal, because
// the verb's own argument check ran before the global --help handler (live finding 5) — a help probe
// is the one thing that must never be answered with an error. Every verb with real sub-structure gets
// a real answer here; the rest fall through to the full `dtwin --help`.
export const HELP: Record<string, string> = {
  screenshot:
    "dtwin screenshot <id|figma-url> [outDir] [--scale N] [--client <file>]\n\n" +
    "  Render ONE node to a reference PNG and write it to <outDir>/assets/<id>_ref.png.\n" +
    "  Cheap: no serialize(), no asset walk — typically under a second once the plugin is warm.\n\n" +
    "  Use it to tell two same-named frames apart BEFORE paying for a full pull: shoot each\n" +
    "  candidate, look, then pull the one you meant.\n\n" +
    "  --scale N   override the render scale (default: auto, capped at 2048px on the longest side)\n" +
    "  outDir      default design/export; the PNG lands in its assets/ subdirectory, which is exactly\n" +
    "              where a later `pull --node` of the same frame writes its own reference — so shooting\n" +
    "              first costs nothing and leaves no duplicate.",
  list:
    "dtwin list [pages|libraries|clients]      # structural indexes — cheap, write nothing\n" +
    "dtwin list children <id|figma-url>        # the direct children of one node\n\n" +
    "  dtwin list             pages + their top-level LAYERS (frames, but also sections, groups,\n" +
    "                         instances, text) with ids. On a sectioned file the screens are one\n" +
    "                         level deeper — use `list children <section id>` to reach them.\n" +
    "  dtwin list pages       just the page list\n" +
    "  dtwin list libraries   enabled libraries + their variable collections. The SLOWEST read\n" +
    "                         there is (5-15s on a real file); it prints progress while it works.\n" +
    "  dtwin list clients     which Figma files are on the bridge right now, with their connIds\n\n" +
    "  --json                 machine output for the two that print a table (libraries, clients)\n" +
    "  --client <file>        WHICH connected Figma file, when more than one is open\n\n" +
    "  These take no read options (--css/--measurements/…): they emit structural fields only, so\n" +
    "  those flags are refused rather than silently ignored.",
  token:
    "dtwin token [status|show|rotate|forget]\n\n" +
    "  status   (default) which token is in play, and from where — never prints the token itself\n" +
    "  show     print the token, to paste into the plugin's \"Bridge token\" field\n" +
    "  rotate   mint a new one (you must re-paste it into the plugin)\n" +
    "  forget   delete the saved token\n\n" +
    "  FIGMA_BRIDGE_TOKEN in the environment overrides the saved file. `dtwin token` says which won.",
  pull:
    "dtwin pull [outDir] --node <id> | --page <id|name> | --selection | --design-system | --as-library <name>\n\n" +
    "  Exactly one scope. Everything lands under outDir (default design/export):\n" +
    "    --node <id>        ONE frame, fully serialized, with its assets. Writes\n" +
    "                       pages/<Page>/<Screen>__<id>.json plus .vars.json and .assets.json beside it,\n" +
    "                       merges its tokens into variables.json, and indexes it in pages/index.json.\n" +
    "    --page <id|name>   every top-level layer on one page (repeatable)\n" +
    "    --selection        whatever is selected in Figma right now\n" +
    "    --design-system    tokens, styles and component catalogs — no page walk, no assets\n" +
    "    --as-library <n>   the same, from INSIDE a library file, into libraries/<slug>/\n\n" +
    "  Run `dtwin --help` for the full flag reference (read options, timeouts, the daemon).",
};

export function translate(argv: string[], exists: (p: string) => boolean = () => false): string[] {
  const [verb, ...rest] = argv;
  if (!verb || isFlag(verb)) return argv;
  if (verb === "pull") return rest;
  if (has(SIMPLE, verb)) return [SIMPLE[verb], ...rest];
  if (verb === "list") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (sub === "children") {
      if (!rest[1] || isFlag(rest[1])) throw new VerbError("dtwin list children needs a node id or a Figma URL (ids come from `dtwin list`)");
      return ["--children", rest[1], ...rest.slice(2)];
    }
    if (!has(LIST, sub)) throw new VerbError(`unknown \`dtwin list ${sub}\` — use: dtwin list [pages|libraries|clients], or dtwin list children <id>`);
    return [LIST[sub], ...rest.slice(sub ? 1 : 0)];
  }
  if (verb === "token") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (!has(TOKEN, sub)) throw new VerbError(`unknown \`dtwin token ${sub}\` — use: dtwin token [status|show|rotate|forget]`);
    return [TOKEN[sub], ...rest.slice(sub ? 1 : 0)];
  }
  if (verb === "screenshot") {
    if (!rest[0] || isFlag(rest[0])) throw new VerbError("dtwin screenshot needs a node id or a Figma URL");
    // `dtwin screenshot <id> [outDir] [flags]` — the id is the flag's value, the rest passes through.
    return ["--screenshot", rest[0], ...rest.slice(1)];
  }
  // Not a verb: a positional outDir, exactly as before — unless it is a near-miss of one. `dtwin whomai`
  // used to start a full pull into ./whomai; a bare word one or two edits from a verb is far likelier
  // a typo than a folder. A path (`./serv`), an existing folder (`exists`), or `dtwin pull serv` opts out.
  if (VERBS.includes(verb)) return argv; // doctor | init | mcp: routed by figma-pull.ts, not translated here
  const alias = ALIASES[verb.toLowerCase()];
  if (alias && !/[\\/.]/.test(verb) && !exists(verb))
    throw new VerbError(`unknown command \`${verb}\` — did you mean \`dtwin ${alias}\`? (to export into a folder named "${verb}": dtwin pull ${verb})`);
  const near = nearestVerb(verb);
  if (near && !/[\\/.]/.test(verb) && !exists(verb))
    throw new VerbError(`unknown command \`${verb}\` — did you mean \`dtwin ${near}\`? (to export into a folder named "${verb}": dtwin pull ${verb})`);
  return argv;
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
