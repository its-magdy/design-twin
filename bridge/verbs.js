// verbs.js — `dtwin <verb>` front door. A PURE argv → argv translation onto the flags figma-pull.js
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
//   dtwin help                       = --help
//   dtwin doctor | init | mcp        → their own entry points (routed in figma-pull.js)
//
// A verb is only recognised as the FIRST argument. `dtwin design` still means "pull into ./design":
// an outDir that happens to be spelled like a verb is written `dtwin pull list` or `dtwin ./list`.

class VerbError extends Error {}

const LIST = { "": "--list", frames: "--list", pages: "--list-pages", libraries: "--list-libraries", libs: "--list-libraries", clients: "--list-clients" };
const TOKEN = { "": "--token-status", status: "--token-status", show: "--show-token", rotate: "--rotate-token", forget: "--forget-token" };
const SIMPLE = { whoami: "--whoami", serve: "--serve", stop: "--stop", status: "--daemon-status", help: "--help" };
const VERBS = ["pull", "list", "whoami", "screenshot", "serve", "stop", "status", "token", "doctor", "init", "mcp", "help"];

// Words people (and agents) reach for first that are NOT verbs. Left alone they were a positional
// outDir: `dtwin export` created ./export and then waited for a plugin, looking exactly like a pull
// that was working. Same opt-outs as a near-miss: a path, an existing folder, or `dtwin pull export`.
const ALIASES = { export: "pull", get: "pull", fetch: "pull", download: "pull", sync: "pull", ls: "list", frames: "list", pages: "list pages", libraries: "list libraries", clients: "list clients",
  check: "doctor", diagnose: "doctor", setup: "init", install: "init", connect: "doctor", start: "serve", daemon: "serve", kill: "stop", version: "--version", tokens: "token" };

const isFlag = (a) => typeof a === "string" && a.startsWith("-");

// Per-verb help. `dtwin screenshot --help` used to hit translate's "needs a node id" refusal, because
// the verb's own argument check ran before the global --help handler (live finding 5) — a help probe
// is the one thing that must never be answered with an error. Every verb with real sub-structure gets
// a real answer here; the rest fall through to the full `dtwin --help`.
const HELP = {
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

function translate(argv, exists = () => false) {
  const [verb, ...rest] = argv;
  if (!verb || isFlag(verb)) return argv;
  if (verb === "pull") return rest;
  if (SIMPLE[verb]) return [SIMPLE[verb], ...rest];
  if (verb === "list") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (sub === "children") {
      if (!rest[1] || isFlag(rest[1])) throw new VerbError("dtwin list children needs a node id or a Figma URL (ids come from `dtwin list`)");
      return ["--children", rest[1], ...rest.slice(2)];
    }
    if (!(sub in LIST)) throw new VerbError(`unknown \`dtwin list ${sub}\` — use: dtwin list [pages|libraries|clients], or dtwin list children <id>`);
    return [LIST[sub], ...rest.slice(sub ? 1 : 0)];
  }
  if (verb === "token") {
    const sub = rest[0] && !isFlag(rest[0]) ? rest[0] : "";
    if (!(sub in TOKEN)) throw new VerbError(`unknown \`dtwin token ${sub}\` — use: dtwin token [status|show|rotate|forget]`);
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
  if (VERBS.includes(verb)) return argv; // doctor | init | mcp: routed by figma-pull.js, not translated here
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
function verbHelp(argv) {
  if (!Array.isArray(argv) || !argv.some((a) => a === "--help" || a === "-h")) return null;
  const verb = argv[0];
  return (verb && HELP[verb]) || null;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// Two edits for the longer verbs. A short verb ("pull", "list", "stop", "mcp" …) is one edit from real
// folder names ("dist" ↔ "list"), so there only a dropped or extra LAST letter counts ("lis", "lists").
function nearestVerb(word) {
  const w = String(word).toLowerCase();
  let best = null;
  for (const v of VERBS) {
    const d = distance(w, v);
    const ok = v.length >= 5 ? d <= (v.length >= 6 ? 2 : 1) : d === 1 && (w.startsWith(v) || v.startsWith(w));
    if (ok && (!best || d < best.d)) best = { v, d };
  }
  return best && best.v;
}

module.exports = { translate, verbHelp, VerbError, VERBS, HELP, distance };
