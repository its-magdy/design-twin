// cli-commands.ts — THE registry of dtwin's commands, modelled on read-opts.ts.
//
// The command family used to be worked out by hand at every site that needed it: the flag lists the
// unknown-flag check knew, the index-command list the guards walked, the five booleans openSession
// re-derived "is this an export?" from, the per-command wording of a read-option refusal, the dispatch
// if-chain, the verb tables in verbs.ts and the hand routing of mcp/init/doctor/seed in cli(). Each one
// is a place a new command can be added and then forgotten, and the failure is SILENT: a guard that
// does not know a command lets it combine with another, and only one of the two runs. That is not
// hypothetical — `--list --list-pages` was accepted for exactly that reason (listCmd folded the two
// flags into one value, so the "two index commands" guard only ever saw one), and ran --list-pages.
//
// So: one COMMANDS row is a whole command — its flag, the family that decides what it may be combined
// with, the read it plans (and so which read options it takes), what it prints, its `dtwin <verb>`
// spellings. A FAMILY says whether its commands reach the plugin (open a session) and write an export;
// GUARDS are the combination refusals per family, in the order the first one wins; MODIFIERS are the
// flags that are not commands. VERB_ROWS are the first words of `dtwin <verb>`: their help page and
// their line in `dtwin --help`. figma-pull.ts derives parsing, the guards, unknown-flag detection,
// dispatch and the help from these; verbs.ts derives the verb translation. The runner of each command
// lives in figma-pull.ts, in a map typed against CommandId, so a row without a runner does not compile.
//
// Dependency-free apart from read-opts.ts (itself dependency-free): imported by verbs.ts, which must
// stay import-light so `dtwin help` keeps --help's zero-side-effects guarantee, and walked by the
// test suites without loading figma-pull.ts.

import { READ_OPT_ROWS } from "./read-opts.ts";
import type { ReadScopeKind } from "./read-opts.ts";

// ---- families

export const FAMILY_NAMES = ["scope", "screenshot", "index", "daemon", "token"] as const;
export type Family = (typeof FAMILY_NAMES)[number];

export interface FamilyDef {
  /** Its commands reach the plugin: they run on a session (a running daemon, or a bridge of their own). */
  session: boolean;
  /** Its commands write an export (the no-daemon warning and the stall check are for these). */
  writes: boolean;
}

export const FAMILIES = {
  /** What a pull exports (at most one); with none it pulls the current page. */
  scope: { session: true, writes: true },
  /** One node's reference PNG: writes a file, but it is not a scope. */
  screenshot: { session: true, writes: true },
  /** The cheap structural queries: print, never write outDir. */
  index: { session: true, writes: false },
  /** The `dtwin serve` daemon's lifecycle: owns the invocation, needs no plugin. */
  daemon: { session: false, writes: false },
  /** The stored bridge token's lifecycle: touches only the local token file. */
  token: { session: false, writes: false },
} as const satisfies Record<Family, FamilyDef>;

/** The families whose commands run on a session, as a literal union — what figma-pull.ts types its runner maps by. */
export type SessionFamily = { [F in Family]: (typeof FAMILIES)[F]["session"] extends true ? F : never }[Family];

// ---- commands

export interface CommandDef {
  id: string;
  /** Its flag; null for the one command no flag names — a pull of the current page. */
  flag: string | null;
  family: Family;
  /** A value-taking flag: the refusal when the value is missing; `nodeId` normalises it as a node id
   *  (node-id.ts), `many` makes it repeatable, `verbMissing` is the refusal of `dtwin <verb>` without it. */
  value?: { missing: string; nodeId?: boolean; many?: boolean; verbMissing?: string };
  /** The read this command plans (read-plan.ts), which decides the read options it takes; null for one
   *  that reads no design, which takes none. */
  reads: ReadScopeKind | null;
  /** Index family: what the command prints, as its read-option refusal says it. */
  emits?: string;
  /** Its `dtwin <verb> [sub]` spellings ([verb] alone is the verb with no sub-noun). */
  verbs?: readonly (readonly [string] | readonly [string, string])[];
}

const INDEX_EMITS = "only prints a structural index (id/name/type/size)";

// Row order is the order a refusal names the commands of one family in.
export const COMMANDS = [
  // ---- scopes: WHAT a pull exports, so at most one (collectFull is `if (allPages) … else if (page)`: a
  // second scope would be dropped in silence and a plausible export of the WRONG scope written).
  // No scope: the current page — its frames, the design system and assets.
  { id: "pull", flag: null, family: "scope", reads: "pages" },
  { id: "selection", flag: "--selection", family: "scope", reads: "selection" },
  { id: "allPages", flag: "--all-pages", family: "scope", reads: "pages" },
  { id: "page", flag: "--page", family: "scope", reads: "pages", value: { missing: "--page needs an id or name (see --list)", many: true } },
  // Tokens/styles/components/hygiene: no page/frame walk and therefore no assets either (assets are exported
  // per-node during that walk). See collect.ts's collectDesignSystemOnly for its one tradeoff
  // (library-variable completeness depends on nodes actually being walked).
  { id: "designSystem", flag: "--design-system", family: "scope", reads: "designSystem" },
  // The LIBRARY-FILE pull, run with the library file open; like --design-system it walks no page.
  { id: "asLibrary", flag: "--as-library", family: "scope", reads: "library", value: { missing: "a library name, e.g. --as-library \"Acme UI\"" } },
  // A REAL export (properties + assets) of exactly ONE node — the CLI twin of the MCP figma_export_url tool.
  // Unlike --children (peek, no recursion) and --screenshot (PNG only, no asset walk) it walks the node's
  // subtree with the full serialize() pass, as a --page pull would for that subtree.
  { id: "node", flag: "--node", family: "scope", reads: "node", value: { missing: "--node needs a node id or figma.com URL (see --list / --children)", nodeId: true } },
  // ---- an on-demand PNG of ONE node (see collectScreenshot in collect.ts for why it is a single-node pull
  // rather than a bulk pre-render pass). It WRITES a file, so it is not an index command; nor a scope.
  { id: "screenshot", flag: "--screenshot", family: "screenshot", reads: "screenshot", verbs: [["screenshot"]],
    value: { missing: "--screenshot needs a node id (see --list / --children)", nodeId: true, verbMissing: "dtwin screenshot needs a node id or a Figma URL" } },
  // ---- the cheap indexes: no recursion, no node properties, no assets; they print and never write outDir.
  // --list is the file-wide map (pages + top-level layers) you consult before paying for a deep export;
  // --list-pages is depth 1, page names only, which needs no page load at all.
  { id: "list", flag: "--list", family: "index", reads: null, emits: INDEX_EMITS, verbs: [["list"], ["list", "frames"]] },
  { id: "listPages", flag: "--list-pages", family: "index", reads: null, emits: INDEX_EMITS, verbs: [["list", "pages"]] },
  // The node-scoped twin of --list: one node's direct children, to peek inside a frame --list surfaced.
  { id: "children", flag: "--children", family: "index", reads: null, emits: INDEX_EMITS, verbs: [["list", "children"]],
    value: { missing: "--children needs a node id (see --list)", nodeId: true, verbMissing: "dtwin list children needs a node id or a Figma URL (ids come from `dtwin list`)" } },
  // Which libraries the file draws on — the library analogue of --list before --page. Same budget tier.
  { id: "listLibraries", flag: "--list-libraries", family: "index", reads: null, emits: "only prints the libraries this file uses", verbs: [["list", "libraries"], ["list", "libs"]] },
  // The identity/liveness probe: what the plugin says it is and what the socket did — evidence for whether
  // two files can share the bridge, whether figma.fileKey is available, whether a connection survives idling.
  { id: "whoami", flag: "--whoami", family: "index", reads: null, emits: "only prints connection/plugin identity", verbs: [["whoami"]] },
  // Which Figma FILES are connected (one connection per open file): the discovery step before --client.
  { id: "listClients", flag: "--list-clients", family: "index", reads: null, emits: "only prints which Figma files are connected", verbs: [["list", "clients"]] },
  // ---- daemon: --serve holds the bridge open until stopped; every ordinary command then routes through it.
  { id: "serve", flag: "--serve", family: "daemon", reads: null, verbs: [["serve"]] },
  { id: "stop", flag: "--stop", family: "daemon", reads: null, verbs: [["stop"]] },
  { id: "daemonStatus", flag: "--daemon-status", family: "daemon", reads: null, verbs: [["status"]] },
  // ---- token: each acts on the local token file only (--token-file is a MODIFIER, below).
  { id: "tokenStatus", flag: "--token-status", family: "token", reads: null, verbs: [["token"], ["token", "status"]] },
  { id: "showToken", flag: "--show-token", family: "token", reads: null, verbs: [["token", "show"]] },
  { id: "rotateToken", flag: "--rotate-token", family: "token", reads: null, verbs: [["token", "rotate"]] },
  { id: "forgetToken", flag: "--forget-token", family: "token", reads: null, verbs: [["token", "forget"]] },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]["id"];
/** A row as its readers take it: its id typed, every optional field optional. */
export type CommandRow = CommandDef & { id: CommandId };
export const COMMAND_ROWS: readonly CommandRow[] = COMMANDS;
/** The command no flag names: a pull of the current page. */
export const DEFAULT_COMMAND: CommandRow = COMMAND_ROWS[0] as CommandRow; // the "pull" row, first by construction
/** The ids of a family's commands, as a literal union — what figma-pull.ts types each runner map by. */
export type CommandIdIn<F extends Family> = Extract<(typeof COMMANDS)[number], { family: F }>["id"];

// ---- modifiers: the flags that are not commands

export interface ModifierDef {
  flag: string;
  /** A value-taking modifier; its value is checked where it is read (figma-pull.ts readArgs). */
  value?: boolean;
}
/** The value-taking modifiers: --scale (--screenshot's render scale), --client (WHICH connected Figma file),
 *  --token-file (the token to use this run), --timeout (every budget, and the wait for the plugin). */
export const VALUE_MODIFIERS = ["--scale", "--client", "--token-file", "--timeout"] as const;
export type ValueModifier = (typeof VALUE_MODIFIERS)[number];
export const MODIFIERS: readonly ModifierDef[] = [
  { flag: "--help" },
  { flag: "--json" },
  ...READ_OPT_ROWS.map((o) => ({ flag: o.flag })),
  ...VALUE_MODIFIERS.map((flag) => ({ flag, value: true })),
];

// The order figma-pull.ts readArgs reads the value-taking flags in, which decides which of several
// missing values one command line is refused for first. It is not the rows' order (a refusal names the
// scopes --page before --node, but --node's value was always read first), so it is kept here, as it was
// before this table, so no refusal changed. --screenshot comes before --scale, whose "only applies to
// --screenshot" check runs as it is read. test/figma-pull-args.test.ts checks it lists exactly the
// table's value-taking flags.
export const VALUE_READ_ORDER: readonly string[] = ["--children", "--node", "--screenshot", "--scale", "--page", "--as-library", "--client", "--token-file", "--timeout"];

// ---- the combination guards, in the order the first refusal wins

/** "is a read option" / "are read options", decided once for a refusal's wording. */
export function plural(n: number): { are: string; they: string; them: string } {
  return n > 1 ? { are: "are read options", they: "they", them: "them" } : { are: "is a read option", they: "it", them: "it" };
}

/** What one guard asks:
 *  within    two commands of `family` given;
 *  cross     a command of `family` beside any of `others` (commands of those families, or "readOpts":
 *            any read option given), named in that order;
 *  readOpts  a command of `family` given read options its read does not take (every one, for a
 *            command that reads nothing);
 *  json      --json beside anything but an index command;
 *  tokenFile --token-file beside a token command that acts on the STORED token. */
export type Guard =
  | { kind: "within"; family: Family; say: (flags: string[]) => string }
  | { kind: "cross"; family: Family; others: readonly (Family | "readOpts")[]; say: (cmd: string, others: string[]) => string }
  | { kind: "readOpts"; family: Family; say: (cmd: CommandRow, flags: string[]) => string }
  | { kind: "json"; say: () => string }
  | { kind: "tokenFile"; ignoredBy: readonly CommandId[]; say: (cmd: string) => string };

export const GUARDS: readonly Guard[] = [
  // Scope flags are MUTUALLY EXCLUSIVE, and the loser must not be discarded in silence: collectFull is
  // `if (allPages) … else if (page)`, so `--all-pages --page Foo` would export all 25 pages while the user
  // watched for one; `--selection --page Foo` never forwards the page at all. Both produce a plausible
  // export of the WRONG scope — the failure you don't notice.
  { kind: "within", family: "scope", say: (f) => `${f.join(" and ")} select different scopes — pass only one.` },
  // --screenshot exports exactly one node's reference PNG — it is not a scope modifier, so combining it
  // with one is the same silent-loss class the scope guard exists for.
  { kind: "cross", family: "screenshot", others: ["scope"],
    say: (_c, o) => `--screenshot renders ONE node's reference image — it cannot be combined with ${o.join(" / ")}. Run it on its own.` },
  // It writes a file, so it is not an index command (which never do) — but combining it with one is
  // still silent loss: only one command's output would appear.
  { kind: "cross", family: "screenshot", others: ["index"],
    say: (_c, o) => `--screenshot cannot be combined with ${o.join(" / ")} — run them as separate commands.` },
  // Read options need a serialize()/node walk that --screenshot deliberately skips, so any of them here
  // would be silently ignored exactly as they would on a list command.
  { kind: "readOpts", family: "screenshot",
    say: (_c, f) => { const p = plural(f.length); return `${f.join(" / ")} ${p.are} for a full export — --screenshot only renders a PNG, so ${p.they} would be silently ignored.`; } },
  // --json: machine output for the index commands that print a TABLE for humans (--list-clients,
  // --list-libraries). The primary caller of this CLI is an agent, and scraping an aligned table is how a
  // column rename becomes a silent misread. The other index commands already print JSON, so the flag is
  // accepted there as a no-op (one habit for every index command) and refused everywhere else — an
  // export writes files and prints no result to make JSON of.
  { kind: "json",
    say: () => "--json applies to the commands that PRINT (--list-clients, --list-libraries; --list / --list-pages / --children / --whoami are JSON already). An export writes files instead — read its _manifest.json." },
  // The index commands print and exit before any export runs, so an export flag combined with one is a
  // no-op the user has no way to see.
  { kind: "cross", family: "index", others: ["scope"],
    say: (c, o) => `${c} only prints a structural index — it cannot be combined with ${o.join(" / ")}. Run the list first, then pull with the ids it prints.` },
  // Two index commands at once: only one of them would run and print, and the other would vanish.
  { kind: "within", family: "index", say: (f) => `${f.join(" and ")} are different queries — pass only one.` },
  // The index commands emit structural fields only — they never serialize a node, call getCSSAsync, read
  // measurements or export an asset — so every read option is a no-op there. Refused as a group,
  // --no-assets included: exempting it would put the caller back to guessing WHICH flags survive a list.
  // `--timeout` is not a read option — it genuinely applies (listTimeoutMs).
  { kind: "readOpts", family: "index",
    say: (c, f) => { const p = plural(f.length); return `${f.join(" / ")} ${p.are} for an EXPORT — ${c.flag} ${c.emits}, so ${p.they} would be silently ignored. Drop ${p.them} here, and pass ${p.them} to the --page pull afterwards.`; } },
  // --design-system and --as-library never walk a page or node, so every read option their read does not
  // take (read-opts.ts `scopes`: all but --variant-visuals, which enriches the catalog they build) is
  // just as inert here as on a list command.
  { kind: "readOpts", family: "scope",
    say: (c, f) => { const p = plural(f.length); return `${f.join(" / ")} ${p.are} for a node/page walk — ${c.flag} skips that walk entirely, so ${p.they} would be silently ignored. Drop ${p.them} here, and pass ${p.them} to a --page pull afterwards.`; } },
  // A daemon command owns the invocation: --serve --all-pages would start a daemon and never run the
  // export the user typed, with nothing said about it.
  { kind: "cross", family: "daemon", others: ["scope", "screenshot", "index", "readOpts"],
    say: (c, o) => `${c} manages the background bridge — it cannot be combined with ${o.join(" / ")}. Start the daemon, then run your pull as a separate command (it will route through it automatically).` },
  { kind: "within", family: "daemon", say: () => "--serve / --stop / --daemon-status are different commands — pass only one." },
  // A token command owns the invocation for the same reason: it manages the local credential and never
  // opens a bridge, so pairing it with a pull would start an export the user did not ask for — or,
  // worse, silently do only the token half of what they typed.
  { kind: "cross", family: "token", others: ["scope", "screenshot", "daemon", "index", "readOpts"],
    say: (c, o) => `${c} manages the stored bridge token — it cannot be combined with ${o.join(" / ")}. Run it on its own, then run your command.` },
  { kind: "within", family: "token", say: (f) => `${f.join(" and ")} are different commands — pass only one.` },
  // --token-file names a token to READ; these three act on the STORED one, so beside them it would be
  // silently ignored. --show-token is the one token command where it applies (print the token in that file).
  { kind: "tokenFile", ignoredBy: ["tokenStatus", "rotateToken", "forgetToken"],
    say: (c) => `${c} acts on the stored token, so --token-file would be silently ignored. Drop it (or, for --rotate-token/--forget-token, edit that file directly).` },
];

// ---- verbs: the first word of `dtwin <verb>`

export interface VerbDef {
  word: string;
  /** How the word becomes the argv figma-pull.ts parses:
   *  "commands" its spellings are on COMMANDS rows; "pull" the word is dropped (`dtwin pull X` = `dtwin X`);
   *  "routed"   its own entry point (figma-pull.ts cli()), before anything else is parsed;
   *  a flag     the word becomes that flag (help, version). */
  to: "commands" | "pull" | "routed" | "--help" | "--version";
  /** Its line(s) in `dtwin --help`'s command summary ("" for a verb another verb's line covers). */
  usage: string;
  /** Its own `--help` page. Absent for a routed verb whose entry point answers --help itself, and for
   *  `help`, whose page IS the full usage. */
  help?: string;
  /** A verb with sub-nouns: the refusal for a sub-noun it does not have. */
  badSub?: (sub: string) => string;
}

// `dtwin seed` answers its own --help (it is routed before verbHelp runs), and so does
// `bun bridge/src/seed-components.ts --help` — both print this one string.
export const SEED_HELP =
  "dtwin seed [codeRoot] [outDir] [--dry-run]\n\n" +
  "  Pre-populate <outDir>/components.json from the Code Connect files already in your codebase —\n" +
  "  template files (`// url=` + `// component=` headers), `figma.connect(...)` calls, and\n" +
  "  `@FigmaConnect` (SwiftUI/Compose). It only reads source files: no bridge, no plugin, no token,\n" +
  "  never the network.\n\n" +
  "  codeRoot   where to look (default .); node_modules, .git, dist, build and the like are skipped\n" +
  "  outDir     where components.json lives (default design)\n" +
  "  --dry-run  scan and report what it would add; write nothing\n\n" +
  "  Merges fill-missing-only: an existing entry's hand-authored fields are never overwritten. A\n" +
  "  mapping that carries only a node id is named through <outDir>/design-system.json when one is\n" +
  "  there (export it first); without it, such a mapping is skipped. Fill in each entry's \"import\"\n" +
  "  and \"props\" by hand afterwards.";

// `--help` must never be the thing that STARTS a server: `dtwin mcp --help` prints this and exits.
export const MCP_HELP =
  "dtwin mcp\n\n" +
  "  Run the Design Twin MCP server on stdio. This is what a .mcp.json entry points at\n" +
  "  (`dtwin init --mcp` writes one); you do not normally run it by hand.\n\n" +
  "  It takes no flags. While it runs it owns the bridge, so ordinary `dtwin` commands\n" +
  "  route through it rather than starting a second one — `dtwin doctor` says who holds the port.\n\n" +
  "  Its tools mirror the CLI: figma_list_clients / figma_list / figma_export_* / figma_screenshot /\n" +
  "  figma_status / figma_write. Pass writeToDisk:true to get files plus a compact index instead\n" +
  "  of node payloads inline — asset bytes are never returned inline.";

// Row order is the order of `dtwin --help`'s command summary.
export const VERB_ROWS = [
  {
    word: "pull", to: "pull",
    usage: "  dtwin pull [outDir] [flags]              = dtwin [outDir] [flags].          See pull --help",
    help:
      "dtwin pull [outDir] [--node <id> | --page <id|name> | --all-pages | --selection | --design-system | --as-library <name>]\n\n" +
      "  At most one scope; with none it pulls the CURRENT page (its frames, the design system and assets).\n" +
      "  Everything lands under outDir (default design/export — never bare `design`, a parallel tree nothing reads):\n" +
      "    --node <id>        ONE frame, fully serialized, with its assets. Writes\n" +
      "                       pages/<Page>/<Screen>__<id>.json plus .vars.json and .assets.json beside it,\n" +
      "                       merges its tokens into variables.json, and indexes it in pages/index.json.\n" +
      "    --page <id|name>   every top-level layer on one page (repeatable)\n" +
      "    --all-pages        every top-level layer on EVERY page (slow on a large file)\n" +
      "    --selection        whatever is selected in Figma right now\n" +
      "    --design-system    tokens, styles and component catalogs — no page walk, no assets\n" +
      "                       On a file that CONSUMES a library it holds that file's own tokens plus only the\n" +
      "                       library variables something in it references (`remote: true`) — never the library's\n" +
      "                       catalog; for that run --as-library from inside the library file\n" +
      "    --as-library <n>   the same, from INSIDE a library file, into libraries/<slug>/\n\n" +
      "  Run `dtwin --help` for the full flag reference (read options, timeouts, the daemon).",
  },
  {
    word: "list", to: "commands",
    usage:
      "  dtwin list [pages|libraries|clients]     = --list | --list-pages | --list-libraries | --list-clients\n" +
      "  dtwin list children <id|url>             = --children <id|url>.             See list --help",
    badSub: (sub: string) => `unknown \`dtwin list ${sub}\` — use: dtwin list [pages|libraries|clients], or dtwin list children <id>`,
    help:
      "dtwin list [pages|libraries|clients]      # structural indexes — cheap, write nothing\n" +
      "dtwin list children <id|figma-url>        # the direct children of one node\n\n" +
      "  dtwin list             pages + their top-level LAYERS (frames, but also sections, groups,\n" +
      "                         instances, text) with ids. On a sectioned file the screens are one\n" +
      "                         level deeper — use `list children <section id>` to reach them.\n" +
      "  dtwin list pages       just the page list\n" +
      "  dtwin list libraries   enabled libraries + their variable collections. The SLOWEST read\n" +
      "                         there is: a few seconds to ~15 s — it walks every instance and makes one Figma\n" +
      "                         call per enabled library variable collection (about 2 s when no\n" +
      "                         libraries are enabled). It prints progress while it works.\n" +
      "  dtwin list clients     which Figma files are on the bridge right now, with their connIds\n" +
      "  dtwin list children    one row per direct child: id, name, type, size, childCount; rows that share\n" +
      "                         name + size also get a `title` (first visible text) and one warning per group;\n" +
      "                         when titles match too, `distinctTexts` (up to 3 texts the row shows and its\n" +
      "                         twins do not — skipped, with a warning, past the listing's read budget)\n\n" +
      "  --json                 machine output for the two that print a table (libraries, clients)\n" +
      "  --client <file>        WHICH connected Figma file, when more than one is open\n\n" +
      "  These take no read options (--css/--measurements/…): they emit structural fields only, so\n" +
      "  those flags are refused rather than silently ignored.",
  },
  {
    word: "screenshot", to: "commands",
    usage: "  dtwin screenshot <id|url> [--scale N]    = --screenshot <id|url>.           See screenshot --help",
    help:
      "dtwin screenshot <id|figma-url> [outDir] [--scale N] [--client <file>]\n\n" +
      "  Render ONE node to a reference PNG and write it to <outDir>/assets/<id>_ref.png.\n" +
      "  Cheap: no serialize(), no asset walk — typically under a second once the plugin is warm.\n\n" +
      "  Use it to tell two same-named frames apart BEFORE paying for a full pull: shoot each\n" +
      "  candidate, look, then pull the one you meant.\n\n" +
      "  --scale N   override the render scale (default: auto, capped at 2048px on the longest side);\n" +
      "              the PNG is then <id>_shot@<N>x.png, so a thumbnail never takes the reference's name\n" +
      "  outDir      default design/export; the PNG lands in its assets/ subdirectory, which is exactly\n" +
      "              where a later `pull --node` of the same frame writes its own reference — so shooting\n" +
      "              first costs nothing — at the default scale it leaves no duplicate (a --scale shot is its own file).",
  },
  {
    word: "whoami", to: "commands",
    usage: "  dtwin whoami                             = --whoami",
    help:
      "dtwin whoami [--client <file>]\n\n" +
      "  Who is connected, with evidence rather than inference. Prints JSON to stdout:\n" +
      "    plugin       what the plugin says it is: instance id, file name, fileKey (and whether Figma\n" +
      "                 exposes it), plugin version, how long its runtime has been up\n" +
      "    connection   what the SOCKET did, for the ADDRESSED file's connection (the one --client picked,\n" +
      "                 or the only one): its connId, how long it has been up, connections this run, and\n" +
      "                 takeovers — how many times a new connection displaced an earlier one\n" +
      "  Costs nothing: no page load, no node walk, no assets, and no file is written. Read from the\n" +
      "  daemon when one holds the port, so the numbers are real either way.\n\n" +
      "  Run it from each open file and compare instanceId: two different ids mean two instances coexist;\n" +
      "  a changed id on a repeat call means Figma restarted the plugin runtime.\n\n" +
      "  --client <file>   WHICH connected Figma file, when more than one is open (see `dtwin list clients`)",
  },
  {
    word: "serve", to: "commands",
    usage: "  dtwin serve | stop | status              = --serve | --stop | --daemon-status",
    help:
      "dtwin serve\n\n" +
      "  Hold the bridge open until stopped (Ctrl-C here, or `dtwin stop` elsewhere). Every other dtwin\n" +
      "  command then routes through it and skips the plugin's reconnect — the difference between a\n" +
      "  pull that takes seconds and one that waits out a cold connection. Only ONE process can hold the\n" +
      "  port, so while it (or the MCP server) is up a second bridge refuses to start.\n\n" +
      "  It shuts itself down after FIGMA_DAEMON_IDLE_MIN minutes without a command (default 120;\n" +
      "  0 disables), so an abandoned daemon cannot hold the port forever.\n" +
      "  Port: 8787 by default; FIGMA_BRIDGE_PORT=8788|8789 picks another (the plugin tries all three).",
  },
  {
    word: "stop", to: "commands", usage: "",
    help:
      "dtwin stop\n\n" +
      "  Stop the daemon `dtwin serve` started, and free its port. Says so when none is running.",
  },
  {
    word: "status", to: "commands", usage: "",
    help:
      "dtwin status\n\n" +
      "  Is a `dtwin serve` daemon running, and is the plugin connected to it? Prints JSON to stdout\n" +
      "  ({ \"daemon\": false } when none is running) and a one-line summary — pid, port, plugin connected\n" +
      "  or not, and the idle time left before auto-shutdown — to stderr. Needs no plugin and starts nothing.",
  },
  {
    word: "token", to: "commands",
    usage: "  dtwin token [status|show|rotate|forget]  = --token-status | --show-token | …  See token --help",
    badSub: (sub: string) => `unknown \`dtwin token ${sub}\` — use: dtwin token [status|show|rotate|forget]`,
    help:
      "dtwin token [status|show|rotate|forget]\n\n" +
      "  status   (default) which token is in play, and from where — never prints the token itself\n" +
      "  show     print the token, to paste into the plugin's \"Bridge token\" field\n" +
      "  rotate   mint a new one (you must re-paste it into the plugin)\n" +
      "  forget   delete the saved token\n\n" +
      "  FIGMA_BRIDGE_TOKEN in the environment overrides the saved file. `dtwin token` says which won.",
  },
  { word: "doctor", to: "routed", usage: "  dtwin doctor [--wait N] [--json]         # diagnose the setup; changes nothing. See doctor --help" },
  { word: "init", to: "routed", usage: "  dtwin init [--mcp] [--dry-run]           # set up the project you are building. See init --help" },
  { word: "seed", to: "routed", usage: "  dtwin seed [codeRoot] [outDir]           # components.json from your Code Connect files. See seed --help", help: SEED_HELP },
  { word: "mcp", to: "routed", usage: "  dtwin mcp                                # run the MCP server (what .mcp.json points at). See mcp --help", help: MCP_HELP },
  { word: "help", to: "--help", usage: "  dtwin help                               = --help" },
  {
    word: "version", to: "--version",
    usage: "  dtwin --version                          print the installed version",
    help:
      "dtwin version\n\n" +
      "  Print the installed version (also `dtwin --version`). Needs no bridge, no plugin and no token.",
  },
] as const satisfies readonly VerbDef[];

export type VerbWord = (typeof VERB_ROWS)[number]["word"];
/** The verbs routed to their own entry point, as a literal union — what figma-pull.ts types its route map by. */
export type RoutedVerb = Extract<(typeof VERB_ROWS)[number], { to: "routed" }>["word"];
export const VERB_DEFS: readonly (VerbDef & { word: VerbWord })[] = VERB_ROWS;

/** `dtwin --help`'s command summary: every verb's line(s), in row order. */
export const COMMAND_SUMMARY: string = VERB_DEFS.map((v) => v.usage).filter(Boolean).join("\n");
