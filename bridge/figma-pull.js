#!/usr/bin/env node
// `dtwin mcp` — route to the MCP server (figma-mcp.mjs) before anything else in this file runs.
// This is the officially-supported registration shape (`npx -y designtwin mcp`), and it must not
// disturb any existing invocation: the branch is taken ONLY when this file is the process entry AND
// argv[2] is exactly "mcp", so `dtwin …` and requiring this module from the test
// suites are untouched, and `node bridge/figma-mcp.mjs` still works when invoked directly.
// CJS cannot `import` an ESM file statically, so this is a dynamic import(); the top-level `return`
// is legal here because a CommonJS module body is a function body — it stops the rest of the CLI
// (arg parsing, bridge setup) from ever loading in MCP mode.
if (require.main === module && process.argv[2] === "mcp") {
  // `--help` must never be the thing that STARTS a server. Probing a CLI's help surface silently
  // launched a second MCP process attached to the live bridge and held stdio until the caller killed
  // it (live finding 4) — the one command in the table whose --help had a side effect.
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "dtwin mcp\n\n" +
      "  Run the Design Twin MCP server on stdio. This is what a .mcp.json entry points at\n" +
      "  (`dtwin init --mcp` writes one); you do not normally run it by hand.\n\n" +
      "  It takes no flags. While it runs it owns the bridge, so ordinary `dtwin` commands\n" +
      "  route through it rather than starting a second one — `dtwin doctor` says who holds the port.\n\n" +
      "  Its tools mirror the CLI: figma_list_clients / figma_list / figma_export_* / figma_screenshot /\n" +
      "  figma_status / figma_write. Pass writeToDisk:true to get files plus a compact index instead\n" +
      "  of node payloads inline — asset bytes are never returned inline."
    );
    process.exit(0);
  }
  // Hide the subcommand from the MCP entry: it should see the argv of a plain `figma-mcp.mjs` run.
  process.argv.splice(2, 1);
  import("./figma-mcp.mjs").catch((e) => {
    console.error("[dtwin mcp] failed to start the MCP server: " + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
  return;
}
// `dtwin init` — project setup (init.js). Routed here for the same reason `mcp` is: it must run before
// server-core loads (which resolves the token and knows about ports) and it shares none of the pull
// flags, so it gets its own tiny parser instead of a special case in parseArgs.
if (require.main === module && process.argv[2] === "init") {
  require("./init.js").main(process.argv.slice(3));
  return;
}
// `dtwin doctor` — diagnose the setup (doctor.js). Routed like `init`, and for a sharper reason: doctor
// must decide for ITSELF whether it is safe to require server-core (a bad FIGMA_BRIDGE_PORT exits the
// process at require time, and a held port exits it in createBridge) — those are findings to report,
// not ways for the diagnostic to die.
if (require.main === module && process.argv[2] === "doctor") {
  require("./doctor.js").main(process.argv.slice(3));
  return;
}
// `dtwin <verb>` — verbs.js rewrites a leading verb into the flags parsed below (`dtwin list pages` →
// `--list-pages`), so there is still ONE parser and one set of guards. Done here, before the --help
// check and the --token-file pre-scan, so both see the translated argv. verbs.js is pure (no requires,
// no I/O), so `dtwin help` keeps --help's zero-side-effects guarantee.
if (require.main === module) {
  const { translate, VerbError, verbHelp } = require("./verbs.js");
  // Help wins over the verb's own argument check. `dtwin screenshot --help` used to be answered with
  // "needs a node id" (live finding 5) because translate ran first; a help probe must never be an
  // error, and must never have a side effect (see `dtwin mcp --help` above).
  const vh = verbHelp(process.argv.slice(2));
  if (vh) {
    console.log(vh);
    process.exit(0);
  }
  try {
    process.argv.splice(2, process.argv.length - 2, ...translate(process.argv.slice(2), (p) => require("fs").existsSync(p)));
  } catch (e) {
    if (!(e instanceof VerbError)) throw e;
    console.error("[dtwin] error: " + e.message);
    process.exit(1);
  }
}
// figma-pull — READ plane CLI.
// Connects to the running Figma plugin over the localhost bridge, pulls the full
// design system + all page frames (or the current selection), and writes them to
// disk. The agent then Reads those files selectively (context-economical).
//
// Usage:
// Quick start (Figma file open, the "Design Twin" plugin running):
//   dtwin list                        # what is in the file: pages + their top-level LAYERS, with ids
//   dtwin screenshot 12:34            # a reference PNG of one node — look before you pull
//   dtwin pull --node 12:34           # export ONE screen into design/export (tokens, tree, assets)
//   dtwin doctor                      # something not working? checks token, port, daemon, plugin, project
//
// Where things land: everything a pull writes goes under design/export/ and nowhere else, so that
// directory can be deleted and re-pulled without touching design/target.json, design/codeconnect.local.json,
// design/plan/ or design/audit/ — the files you own. `design/README.md` (written by init) says so too.
//
// Commands (each is shorthand for a flag documented below — the flags keep working unchanged):
//   dtwin pull [outDir] [flags]              = dtwin [outDir] [flags].          See pull --help
//   dtwin list [pages|libraries|clients]     = --list | --list-pages | --list-libraries | --list-clients
//   dtwin list children <id|url>             = --children <id|url>.             See list --help
//   dtwin screenshot <id|url> [--scale N]    = --screenshot <id|url>.           See screenshot --help
//   dtwin whoami                             = --whoami
//   dtwin serve | stop | status              = --serve | --stop | --daemon-status
//   dtwin token [status|show|rotate|forget]  = --token-status | --show-token | …  See token --help
//   dtwin doctor [--wait N] [--json]         # diagnose the setup; changes nothing. See doctor --help
//   dtwin init [--mcp] [--dry-run]           # set up the project you are building. See init --help
//   dtwin mcp                                # run the MCP server (what .mcp.json points at). See mcp --help
//   dtwin help                               = --help
//   dtwin --version                          print the installed version
//
//   Every command above answers `--help` with its own page, and none of them does anything else
//   while doing so.
//   A command is only recognised as the FIRST argument: `dtwin design` still pulls into ./design.
//   For an outDir spelled like a command, write `dtwin pull list` or `dtwin ./list`.
//
// Full reference:
//   dtwin init [--mcp]          # set up the project you are BUILDING: design/, target.json, the bridge
//                               # token, (optionally) .mcp.json — then prints the steps left. See init --help
//   dtwin [outDir]              # full: design-system.json + current-page frames + assets
//   dtwin [outDir] --all-pages  # like full, but frame trees from EVERY page
//   dtwin [outDir] --selection  # just the current selection
//   dtwin [outDir] --page <id|name>   # ONE named page (repeatable; ids come from --list)
//   dtwin [outDir] --node <id>  # ONE node, fully exported (properties + assets) — the
//                                            # "paste a Figma link" path. Takes a bare id, dash form,
//                                            # percent-encoded id, or a whole figma.com URL. Unlike
//                                            # --children (peek only) and --screenshot (PNG only) this
//                                            # walks the subtree and exports its assets, same as a
//                                            # --page pull would for that subtree. The CLI twin of the
//                                            # MCP figma_export_url tool.
//   dtwin [outDir] --design-system    # ONLY tokens/styles/components/hygiene — no page
//                                                   # walk, no assets (the cheap "just the design
//                                                   # system" pull). Each catalogued component/variant
//                                                   # carries its OWN fills/strokes/effects/cornerRadius/
//                                                   # opacity/blendMode (`visuals`) — plain synchronous
//                                                   # property reads, not the async cost this mode
//                                                   # exists to avoid. NOTE: this is the component
//                                                   # NODE's own paint (its default/base variant look),
//                                                   # not per-instance overrides elsewhere in the file —
//                                                   # and components consumed from a published library
//                                                   # (not defined in this file) are NOT covered: pull
//                                                   # --as-library on the source library file for those.
//                                                   # Add --variant-visuals for the SET's own variants'
//                                                   # real paint too (see below) — the one read option
//                                                   # this mode accepts.
//   dtwin [outDir] --as-library <name>  # the COMPLETE catalog of a LIBRARY file —
//                                                   # every variable with full per-mode values, every
//                                                   # style, every component. Run it with the LIBRARY
//                                                   # file open, not the design file that consumes it.
//                                                   # Writes design/libraries/<slug>-<fileKey8>/ and
//                                                   # never touches design-system/.
//   dtwin [outDir] --timeout N  # seconds to wait for the export (default: 300,
//                                            # 900 with --all-pages, 120 for --selection); also
//                                            # raises the list commands' own 300s budget
//
// Optional Tier-1 reads (opt-in — each costs extra Plugin-API work):
//   --css            # Figma's own computed CSS per node (getCSSAsync) — the design-to-code oracle
//   --measurements   # measurement redlines (spacing specs the designer placed) for the exported page(s).
//                    # NOT Dev-Mode-only: per developers.figma.com only add/edit/deleteMeasurement are.
//   --plugin-data    # own-scope plugin data stamped on nodes
//   --motion         # motion/animation reads (timelines, keyframe tracks, animations, styles)
//   --shared-data    # cross-plugin shared data (Tokens Studio applied tokens via getSharedPluginData)
//   --variant-visuals  # walk each COMPONENT_SET's variants and attach their REAL layout/fills/radius/
//                      # tokens (not the set wrapper's own selection-chrome visuals). One node walk
//                      # per variant, so slower on large systems. The ONE read option --design-system
//                      # and --as-library both accept (see below) — it enriches the component catalog
//                      # they build, unlike the others which need a page/node walk neither does.
//
// Look before you pull (cheap RELATIVE to an export — no recursion, no assets, no node properties;
// prints JSON to stdout):
//   dtwin --list         # pages + their top-level frames (ids to deep-pull next).
//                                     # Loads each page (Figma warns loading pages is slow on large
//                                     # files) — cheap next to an export, not free. Use --list-pages
//                                     # if you only need the page names.
//   dtwin --list-pages   # page names only (near-free: does not load any page)
//   dtwin --children <id>  # ONE node's direct children only (peek inside a frame from
//                                        # --list before committing to a full recursive --page pull)
//   dtwin --screenshot <id> [--scale N]  # on-demand PNG of ONE node (a component/instance
//                                        # buried in a dense screen, say) — the visual-validation
//                                        # counterpart to --list/--children. WRITES assets/<id>_ref.png
//                                        # (unlike --list/--children, which only print), but is still
//                                        # cheap: it skips serialize() and the recursive asset walk, so
//                                        # exportAsync on the node itself is the only cost. --scale
//                                        # overrides the default (auto, capped at 2048px on the longest
//                                        # side). Mirrors Figma's own get_screenshot tool (single-node,
//                                        # called on demand) rather than pre-rendering every node.
//   dtwin --list-libraries  # which design libraries this file draws on (local + enabled
//                                        # team libraries), their variable collections, and how many
//                                        # of their components this file USES. The discovery step
//                                        # before a pull, exactly as --list is before --page.
//                                        # Honest limits: Figma exposes NO API to enumerate a
//                                        # library's full contents, so component counts are
//                                        # USAGE-derived; and libraries can only be enabled in the
//                                        # Figma UI (never via API), so an export is silently scoped
//                                        # to whatever was enabled at export time. Empty results are
//                                        # a NORMAL outcome (free plan / no library enabled), not a
//                                        # failure — they are reported as such.
//                                        # Requires the plugin manifest's "teamlibrary" permission:
//                                        # RE-IMPORT/reload the plugin in Figma after updating, or a
//                                        # stale plugin silently returns nothing.
//   dtwin --whoami       # who is connected: plugin instance id, file name, whether
//                                     # figma.fileKey is available, socket uptime, and how many times
//                                     # a new connection displaced an earlier one — read from the
//                                     # daemon when one holds the port, so the numbers are real
//                                     # either way. The probe for
//                                     # "can two Figma files use the bridge at once?" — run it from
//                                     # each open file and compare instanceId. Costs nothing (no page
//                                     # load, no node walk, no assets) and writes no files.
//   --json               # machine output for the two that print a TABLE (--list-clients, --list-libraries).
//                        # The others above already print JSON; there it is accepted as a no-op.
//   These take NO read options (--css/--measurements/--plugin-data/--motion/--shared-data/
//   --no-assets): they emit structural fields only, so those flags are refused rather than ignored.
//   --timeout DOES apply to them — to the command AND to the wait for the plugin to connect
//   (default: 10 min at a terminal, 90 s when stderr is not a TTY, e.g. run by an agent).
//
// Speed:
//   --no-assets      # skip the per-node SVG/PNG export pass (the dominant cost on a big file).
//                    # Structure + tokens are unaffected; the manifest reports how many were skipped.
//
// Keep the connection open (daemon):
//   dtwin --serve          # hold the bridge open until stopped. Every command above then
//                                       # routes through it automatically and skips the reconnect.
//   dtwin --stop           # stop it
//   dtwin --daemon-status  # is one running, and is the plugin connected?
//   Only ONE process can hold port 8787 — while a daemon (or the MCP server) is up, a second bridge
//   exits with EADDRINUSE. That is exactly what routing through the daemon avoids.
//
// The bridge token (auth for the plugin -> bridge handshake). Generated once on the first bridge
// start, saved to a per-user config file (0600), and reused forever after — so you paste it into the
// plugin ONCE. These commands need no plugin and no bridge:
//   dtwin --token-status   # where it lives, which source wins, its fingerprint — never the token
//   dtwin --show-token     # print the token itself (stdout only, so `| pbcopy` works)
//   dtwin --rotate-token   # replace it — you must then re-paste it into the plugin
//   dtwin --forget-token   # delete it; the next bridge start mints a new one
//   dtwin --token-file <p> # read the token from <p> for this run instead of the stored one
//   Precedence: --token-file > FIGMA_BRIDGE_TOKEN > the saved file > mint a new one.
//   There is no `--token <value>`: argv is world-readable via `ps`, so passing a secret there leaks
//   it to every other user on the machine. Use --token-file, or the env var.
//
// The Figma file must be open with the "Design Twin" plugin running.

const fs = require("fs");
const path = require("path");
const LAYOUT = require("./project-layout.js");

// --help / -h: print the usage header above and exit 0. Handled HERE, before server-core is required,
// so help has no side effects at all — no token minted, no port bound. The text is the header comment
// itself (from "Usage:" down), read back from this file, so the help can never drift from the one
// place the flags are documented.
function usageText() {
  const lines = fs.readFileSync(__filename, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("// Usage:"));
  const out = [];
  for (let i = start; i < lines.length && lines[i].startsWith("//"); i++) out.push(lines[i].replace(/^\/\/ ?/, ""));
  return "dtwin — pull a design out of a running Figma file (Design Twin plugin) onto disk.\n\n" + out.join("\n");
}
if (require.main === module && ["--version", "-v", "version"].includes(process.argv[2])) {
  console.log(require("./package.json").version);
  process.exit(0);
}
if (require.main === module && process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(usageText());
  process.exit(0);
}

// --token-file has to be honoured BEFORE server-core is required, because server-core resolves the
// token at require time (so the test suite can set FIGMA_BRIDGE_TOKEN and require it). parseArgs
// runs far below that require, so the flag is pre-scanned here and handed over as the env var
// server-core already reads. parseArgs still parses it properly — this scan only has to be right
// about the VALUE, and it is checked against the parsed result once parsing has happened.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--token-file");
  const eq = argv.find((a) => a.startsWith("--token-file="));
  const v = i !== -1 ? argv[i + 1] : eq ? eq.slice("--token-file=".length) : null;
  if (v && !v.startsWith("--")) process.env.FIGMA_BRIDGE_TOKEN_FILE = v;
}

// TIMEOUTS is the per-command budget table both front-ends read (server-core.js) — the tiers below
// pick from it rather than restating them, so the CLI and the MCP tools cannot drift apart.
const { createBridge, TIMEOUTS, exportTimeout, errMsg, tokenStore } = require("./server-core");
// node-id.js is "the ONE place that knows what a node id looks like and how it hides in a Figma URL"
// (its own header). This file used to hand --children's raw token straight to the plugin, whose only
// normalisation is replace(/-/g, ":") — so a pasted design URL worked through the MCP twin
// (figma_list_children calls parseNodeId) and failed here. Same input, same answer, one parser.
const { toNodeId } = require("./node-id.js");
// pages-layout.js owns the pages/ layout (and the safe() sanitiser that names things inside it) for
// BOTH writers — this one, and the plugin's browser-download path which bundles the same module.
// Asset filenames are NOT derived with safe(): the plugin names each asset (assets.ts) and the node
// tree's `asset` path is built from that same string, so re-deriving the convention on this side could
// silently point every path at a missing file. basename() in writeAssets is the only guard those need.
const { safe } = require("./pages-layout.js");
// write-out.js is the ONE writer, shared with the MCP export tools' writeToDisk path — so a file
// pulled through the CLI and the same file pulled through MCP land in the same layout, by
// construction rather than by two implementations agreeing. The `log` argument is what differs:
// this front-end narrates every file to stderr, the MCP one stays silent.
const OUT = require("./write-out.js");
const plog = (m) => console.error("[dtwin] " + m);
const writeJson = (dir, name, obj, quiet) => OUT.writeJson(dir, name, obj, quiet, plog);
// No longer called by main() (the full-export path now goes through OUT.writeExport, which calls
// OUT.writePages itself) — kept as an export because test/bridge.test.js drives the pages/ LAYOUT
// through this exact entry point.
const writePages = (dir, layersDoc) => OUT.writePages(dir, layersDoc, plog);
const writeAssets = (dir, assets) => OUT.writeAssets(dir, assets, plog);
const writeScreenshot = (dir, r) => OUT.writeScreenshot(dir, r, plog);
// hygiene.json persists every warning (see design-system-layout.js), but writeJson's own log line is
// just "wrote design-system/hygiene.json" — a caller watching stderr would never see a DUPLICATE
// COMPONENT NAME or a variant-explosion warning without a separate JSON read. Echo them to stderr
// here so hygiene surfaces the same run it was produced in, not only on a later manual diff.
function printHygiene(r) {
  const hygiene = r && r.designSystem && Array.isArray(r.designSystem.hygiene) ? r.designSystem.hygiene : [];
  if (!hygiene.length) return;
  plog(`hygiene (${hygiene.length}):`);
  for (const h of hygiene) console.error("  - " + h);
}
// The ONE registry of read options, shared with the plugin's runOpts and the MCP tool schema.
const { READ_OPTS } = require("./read-opts.js");
// daemon.js holds the bridge open across invocations. Every ordinary command below asks it for a
// connection FIRST and falls back to opening its own bridge — so the one-shot behaviour is unchanged
// when no daemon is running, and no command needs to know which mode it is in.
const daemon = require("./daemon.js");

// Argument parsing lives in ONE pure function so the test suite can drive it directly. It throws
// UsageError instead of calling process.exit, which is the only difference from doing it inline —
// the CLI entry below turns that back into the same message + exit 1. Untestable arg parsing is how
// `--timeout` shipped silently ignoring its own flag when the value was missing.
class UsageError extends Error {}

function parseArgs(args) {
const selection = args.includes("--selection");
const allPages = args.includes("--all-pages");
// --design-system: tokens/styles/components/hygiene, no page/frame walk and therefore no
// assets either (assets are exported per-node during that walk). The cheap sibling of a full pull
// for "just give me the design system" — see collect.ts's collectDesignSystemOnly for the one
// tradeoff (library-variable completeness depends on nodes actually being walked).
const designSystemOnly = args.includes("--design-system");
// Daemon lifecycle. These are COMMANDS, not modifiers: each one owns the whole invocation, so they
// are refused in combination with each other and with any pull below. --serve holds the bridge open
// until stopped; every ordinary command then routes through it automatically (see daemon.js).
const DAEMON_CMDS = ["--serve", "--stop", "--daemon-status"];
const daemonCmd = DAEMON_CMDS.find((f) => args.includes(f)) || null;
// Token lifecycle. COMMANDS, like the daemon ones above: each owns the whole invocation, needs no
// bridge and no plugin (they only touch the local token file), and so is refused in combination with
// anything else. --token-file is the exception — it is a MODIFIER, read below.
const TOKEN_CMDS = ["--token-status", "--show-token", "--rotate-token", "--forget-token"];
const tokenCmd = TOKEN_CMDS.find((f) => args.includes(f)) || null;
// --no-assets REMOVES work (every other flag adds it): skips the per-node exportAsync render pass,
// which dominates the export on a real design-system file. Structure, layout and tokens are
// unaffected — a skipped node stays the same LEAF the full export produces, marked
// `assetSkipped: true` instead of carrying an `asset` path; only assets/ goes missing.
// Flag -> option name comes from bridge/read-opts.js, the ONE registry shared with the plugin's
// runOpts and the MCP tool schema. Building the table from it (rather than restating the six names
// here) is what lets the guard below name the offending flags without a second hand-written list —
// a twin that would silently stop matching the moment a read option is added.
const READ_OPT_FLAGS = Object.fromEntries(READ_OPTS.map((o) => [o.flag, o.name]));
const readOpts = {};
const readOptFlagsGiven = [];
for (const [flag, opt] of Object.entries(READ_OPT_FLAGS)) {
  readOpts[opt] = args.includes(flag);
  if (readOpts[opt]) readOptFlagsGiven.push(flag); // same predicate by construction, one walk
}

// Export timeout. The extraction — not the interactive connect — is the slow half: it walks every
// node on every page, and a real design-system file blows past server-core's 120s default (found the
// hard way on a ~1000-node file with --all-pages). Scale with the work and let the user override.
// --list is the CHEAP map (pages + top-level frames, no recursion, no assets) you consult before
// paying for a deep export. --list-pages is depth 1: page names only, which needs no page load at all.
// One name for the structural-index command, decided once: every message and guard below asks for
// the flag the user actually typed, instead of re-deriving it from two booleans at each site.
// Exact `includes` matches, so "--list-libraries" is NOT swallowed by the "--list" branch — the same
// prefix trap takeValues() guards against below, one line earlier.
const listCmd = args.includes("--list-pages") ? "--list-pages" : args.includes("--list") ? "--list" : null;
const listOnly = listCmd !== null;
const listDepth = listCmd === "--list-pages" ? 1 : 2;
// --list-libraries: the LIBRARY-scoped member of the same cheap-index family. Same cost model as
// --list (no recursion, no node properties, no assets — it reads the file's library usage), same
// budget tier (TIMEOUTS.list), same "prints and exits before any export runs" shape, and therefore
// the same guards below. It is a discovery step: find out which libraries a file draws on, THEN pull
// only what you need — the library analogue of --list -> --page.
const listLibraries = args.includes("--list-libraries");

// --whoami: the identity/liveness probe. Cheapest command there is (no page load, no node walk, no
// assets) and it PRINTS rather than writing outDir, so it joins the index-command family below and
// inherits its guards. It exists to answer, with evidence rather than inference, the three questions
// the docs do not: whether two Figma files can run the plugin at once, whether `figma.fileKey` is
// available to a locally-imported plugin, and whether a connection survives being left idle.
const whoami = args.includes("--whoami");

// --list-clients: which Figma FILES are connected right now. The bridge accepts one connection per
// open file, so this is the "which of my open files can I talk to?" index — the discovery step before
// --client, exactly as --list is before --page.
const listClients = args.includes("--list-clients");

// Value-taking flags (space form: `--flag value`) consume the NEXT token — that token must never be
// mistaken for the positional [outDir] below. `consumedIdx` tracks every such value's index so
// outDir detection can skip them, not just skip tokens that literally start with "--".
const consumedIdx = new Set();

// ONE parser for every `--flag value` / `--flag=value` pair, repeatable by construction. The three
// value flags below used to hand-roll this rule in three subtly different shapes, so the positional
// [outDir] stayed correct only as long as each of them remembered consumedIdx — and `--timeout`
// already shipped once mishandling its own missing value. A fourth value flag is now one line.
// Matching the flag EXACTLY (plus its `=` form) is part of the rule: startsWith("--timeout") would
// also swallow a future `--timeout-ms`, reading another flag's value as this one's.
// Returns [] when the flag is absent; throws UsageError when it's present with no value.
function takeValues(args, flag, missingMsg) {
  const eq = flag + "=";
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(missingMsg);
      out.push(next);
      consumedIdx.add(i + 1);
      i++;
    } else if (a.startsWith(eq)) {
      const v = a.slice(eq.length);
      if (!v) throw new UsageError(missingMsg);
      out.push(v);
    }
  }
  return out;
}

// --children <id>: the node-scoped twin of --list. Same cost model (no recursion, no assets), just
// scoped to one node's direct children instead of a page's top level — for peeking inside a frame
// `--list` surfaced before paying for a full recursive `--page` pull of it.
// Accepts `--children=<id>` as well as `--children <id>` — --page and --timeout both take the `=`
// form, and a value-flag that silently rejects it is a papercut with no reason to exist.
let childrenId = takeValues(args, "--children", "--children needs a node id (see --list)")[0] || null;
// Accept everything the MCP twin accepts: bare id, dash form, percent-encoded, nested-instance
// path, or a whole figma.com URL. toNodeId is node-id.js's lenient entry point — an id shape it
// doesn't recognise passes through and works exactly as before rather than becoming a hard failure.
if (childrenId) childrenId = toNodeId(childrenId);

// --node <id>: a REAL export (properties + assets) of exactly ONE node — the CLI twin of the MCP
// `figma_export_url` tool ("paste a link and ask about it"). Unlike --children (peek, no recursion)
// and --screenshot (PNG only, no asset walk) this walks the node's subtree with the full serialize()
// pass and exports the assets found inside it, same as a --page pull would for that subtree. It is a
// SCOPE flag (selects WHAT is exported), not an index command, so it joins the `scopes` guard below.
let nodeId = takeValues(args, "--node", "--node needs a node id or figma.com URL (see --list / --children)")[0] || null;
if (nodeId) nodeId = toNodeId(nodeId);

// --screenshot <id>: an on-demand PNG of ONE node — the visual-validation counterpart to --list/
// --children (see collectScreenshot's comment in collect.ts for why this is a single-node pull rather
// than a bulk pre-render pass). Unlike --list/--children it WRITES a file, so it is its own small
// export, not a member of the indexCmds family below.
let screenshotId = takeValues(args, "--screenshot", "--screenshot needs a node id (see --list / --children)")[0] || null;
if (screenshotId) screenshotId = toNodeId(screenshotId);
// --scale <n>: override collectReference's default (auto, capped at 2048px on the longest side). Only
// meaningful paired with --screenshot — refused standalone below, the same silent-loss class as a read
// option combined with --list.
const BAD_SCALE = "--scale expects a positive number";
const scaleArg = takeValues(args, "--scale", BAD_SCALE)[0];
const scale = scaleArg !== undefined ? Number(scaleArg) : undefined;
if (scaleArg !== undefined && !(scale > 0)) throw new UsageError(`${BAD_SCALE}, got '${scaleArg}'`);
if (scale !== undefined && !screenshotId) {
  throw new UsageError("--scale only applies to --screenshot — pass both, or drop --scale.");
}

// --page <id|name>, REPEATABLE (docker -e / curl -H convention): export a bounded, caller-chosen set
// of pages. Accepts `--page=x` and `--page x`. Ambiguous/unknown selectors fail loudly plugin-side
// with the available pages listed — never a silent pick, since nothing here is interactive.
const pageSel = takeValues(args, "--page", "--page needs an id or name (see --list)");
// --as-library <name>: the LIBRARY-FILE pull. A scope, not a read option — it selects WHAT is
// exported, and like --design-system it walks no page, so the read-option guard below refuses those
// flags for it too. The name is required rather than defaulted from figma.root.name, because it is
// what the output directory is named after and a silent default is a directory the user did not
// choose. Run it with the LIBRARY file open in Figma, not the design file that consumes it.
const asLibrary = takeValues(args, "--as-library", "a library name, e.g. --as-library \"Acme UI\"")[0] || null;

// --client: WHICH connected Figma file this command talks to. Unlike every other flag here it is not
// a scope or a read option — it is the ADDRESS, and it composes with all of them. Omit it and the
// bridge uses the only connected file; with several connected it refuses and lists them rather than
// guessing, so an export can never silently come from the wrong file. Accepts a connId (from
// --list-clients), a fileKey, or part of the file's name. The connId (c1, c2, …) is a reconnect-order
// LABEL for the current bridge lifetime, not a stable id across restarts (finding 209) — prefer the
// file name or fileKey in a script; connId is fine for a human picking between two files open right now.
const client = takeValues(args, "--client", "--client needs a connection id, fileKey, or part of a file name (see --list-clients)")[0] || null;

// --token-file <path>: read the bridge token from somewhere other than the stored default. A
// MODIFIER (it changes which token every other command uses), not a command.
//
// There is deliberately NO `--token <value>` twin. Process arguments are world-readable — `ps aux`,
// /proc/<pid>/cmdline — so a value flag would hand the secret to every other user on the machine for
// as long as the command runs. A path is not a secret; the file it points at is.
const tokenFile = takeValues(args, "--token-file", "--token-file needs a path to a file containing the token")[0] || null;


// A missing VALUE is distinct from a missing FLAG, and takeValues makes that structural: `--timeout`
// with nothing after it (or another flag after it) throws here rather than leaving `undefined` for the
// validator's own `!== undefined` guard to EXEMPT — which is how the flag once got silently ignored
// and you got the default, the one outcome an explicit timeout exists to prevent, invisible until the
// export died at a limit you thought you had raised.
// One message for both failures (absent value, unusable value) so they cannot drift apart.
const BAD_TIMEOUT = "--timeout expects a positive number of seconds";
const timeoutArg = takeValues(args, "--timeout", BAD_TIMEOUT)[0];
const timeoutSec = Number(timeoutArg);
if (timeoutArg !== undefined && !(timeoutSec > 0)) throw new UsageError(`${BAD_TIMEOUT}, got '${timeoutArg}'`);
// One override, applied to every budget below — spelling the `--timeout` conversion per budget is how
// the list ops came to be missed by the flag in the first place.
const overrideMs = timeoutSec > 0 ? timeoutSec * 1000 : undefined;
const exportTimeoutMs = overrideMs ?? exportTimeout({ selection, allPages });
// The list ops get their own budget, and --timeout raises it too — they are cheap RELATIVE to an
// export, not fast (see TIMEOUTS.list). Without this the command you are told to run FIRST would be
// the first to fail on the big files where looking before you pull is the whole point, with no flag to
// rescue it, since --timeout only ever reached the export branch.
const listTimeoutMs = overrideMs ?? TIMEOUTS.list;
// How long to wait for the Figma plugin to CONNECT, before any command is sent. --timeout bounds this
// too — the help has always said it applies to the discovery commands, and a wait it cannot shorten
// made `dtwin list --timeout 5` sit for ten minutes. Without the flag: ten minutes at a terminal (a
// person is walking over to Figma), but 90 s when nobody is watching stderr — an agent's shell gives
// up at two minutes, and a command that outlives it reads as a hang with no message at all.
const connectWaitMs = overrideMs ?? (process.stderr.isTTY ? 600000 : 90000);

// Unknown flags are REFUSED, not absorbed. Every flag above is matched by exact `includes`, so a typo
// (`--lsit`, `--al-pages`) used to match nothing and fall through to the default — a full pull that
// then waits on the plugin: the wrong command, run silently. Same silent-loss class as the guards
// below, one step earlier. Runs after every takeValues() call so a flag's VALUE is never judged.
const BOOL_FLAGS = [
  "--selection", "--all-pages", "--design-system", ...DAEMON_CMDS, ...TOKEN_CMDS,
  "--list", "--list-pages", "--list-libraries", "--whoami", "--list-clients", "--help", "--json",
  ...Object.keys(READ_OPT_FLAGS),
];
const VALUE_FLAGS = ["--children", "--node", "--screenshot", "--scale", "--page", "--as-library", "--client", "--token-file", "--timeout"];
const KNOWN_FLAGS = [...BOOL_FLAGS, ...VALUE_FLAGS];
const unknown = args.filter((a, i) => a.startsWith("-") && a !== "-h" && !consumedIdx.has(i)
  && !BOOL_FLAGS.includes(a) && !VALUE_FLAGS.some((f) => a === f || a.startsWith(f + "=")));
if (unknown.length) {
  // "Did you mean": the nearest known flag by edit distance, offered only when it is a plausible typo.
  const { distance } = require("./verbs.js");
  const hints = unknown.map((u) => {
    const name = u.split("=")[0];
    const best = KNOWN_FLAGS.map((f) => [distance(name, f), f]).sort((x, y) => x[0] - y[0])[0];
    return best[0] <= 2 ? `${u} (did you mean ${best[1]}?)` : u;
  });
  throw new UsageError(`unknown flag${unknown.length > 1 ? "s" : ""}: ${hints.join(", ")}. Run dtwin --help for the full list.`);
}

// The positional [outDir] — the first token that's neither a `--flag` nor a value a flag above already
// claimed. Doing this AFTER parsing every value-taking flag is what keeps e.g. `--children 131:1879`
// (no outDir given) from being misread as `outDir = "131:1879"`.
// Default: design/export — dtwin writes only there, so `rm -rf design/export && re-pull` cannot take
// the component map, the plan or the audit with it. A project created under the older flat layout
// keeps working: its export is still found (bridge/project-layout.js findExportDir).
const userOutDir = args.find((a, i) => !a.startsWith("--") && !consumedIdx.has(i));
const outDir = userOutDir ||
  (LAYOUT.findExportDir(process.cwd()).layout === "legacy-flat" ? LAYOUT.DESIGN_DIR : LAYOUT.EXPORT_DIR);

// P4 #14/#201: `dtwin pull design --node <id>` is the outDir trap — `design` is a valid, deliberate
// positional outDir (never special-cased; see the note above), but when the project ALREADY has a
// design/export/ tree, writing into `design` too creates a SECOND, parallel export tree that every
// other command (doctor, cross-check, audit, build-screen) keeps ignoring. Warn, don't refuse — a
// project genuinely named "design" for something else is legitimate, and refusing would be the parser
// getting magic about one string.
if (userOutDir) {
  const requested = path.resolve(process.cwd(), userOutDir);
  const alreadyHasExport = fs.existsSync(path.join(requested, "export"));
  if (alreadyHasExport) {
    console.error(
      `[dtwin] warn: ${userOutDir} already contains ${path.join(userOutDir, "export")} — writing here too creates a` +
      ` PARALLEL export tree that doctor/cross-check/audit/build-screen do not read. You almost certainly want` +
      ` \`dtwin pull ${userOutDir === "design" ? "" : userOutDir + "/export "}...\` (drop the outDir to use the default` +
      ` design/export, or pass the export dir itself) instead of writing into ${userOutDir}.`
    );
  }
}

// Scope flags are MUTUALLY EXCLUSIVE, and the loser used to be discarded in silence: collectFull is
// `if (allPages) … else if (page)`, so `--all-pages --page Foo` exported all 25 pages while the user
// watched for one; `--selection --page Foo` never forwards the page at all. Both produce a plausible
// export of the WRONG scope — the failure you don't notice. Now that parsing is a pure function,
// refusing costs two lines and a test.
const scopes = [selection && "--selection", allPages && "--all-pages", pageSel.length && "--page", designSystemOnly && "--design-system", asLibrary && "--as-library", nodeId && "--node"].filter(Boolean);
if (scopes.length > 1) {
  throw new UsageError(`${scopes.join(" and ")} select different scopes — pass only one.`);
}
// --screenshot exports exactly one node's reference PNG — it is not a scope modifier, so combining it
// with one is the same silent-loss class the scope guard above exists for.
if (screenshotId && scopes.length) {
  throw new UsageError(`--screenshot renders ONE node's reference image — it cannot be combined with ${scopes.join(" / ")}. Run it on its own.`);
}
// The cheap-index FAMILY, decided once. Every guard below asks this list rather than re-deriving
// "is this an index command?" from a growing pile of booleans — which is exactly how a flag gets
// added and then silently omitted from one of the three guards (the --timeout class of bug: the
// flag is accepted, and then quietly does nothing).
const indexCmds = [listCmd, childrenId && "--children", listLibraries && "--list-libraries", whoami && "--whoami", listClients && "--list-clients"].filter(Boolean);
const indexCmd = indexCmds[0] || null;
// --screenshot writes a file, so it does not join the indexCmds family above (which never do) — but
// combining it with one is still the same silent-loss class: only one command's output would appear.
if (screenshotId && indexCmds.length) {
  throw new UsageError(`--screenshot cannot be combined with ${indexCmds.join(" / ")} — run them as separate commands.`);
}
// Read options need a serialize()/node walk that --screenshot deliberately skips (see its usage
// comment above), so any of them here would be silently ignored exactly as they would on a list command.
if (screenshotId && readOptFlagsGiven.length) {
  const many = readOptFlagsGiven.length > 1;
  const [are, they] = many ? ["are read options", "they"] : ["is a read option", "it"];
  throw new UsageError(`${readOptFlagsGiven.join(" / ")} ${are} for a full export — --screenshot only renders a PNG, so ${they} would be silently ignored.`);
}

// --json: machine output for the two index commands that print a TABLE for humans (--list-clients,
// --list-libraries). The primary caller of this CLI is an agent, and scraping an aligned table is
// how a column rename becomes a silent misread. --list / --list-pages / --children / --whoami already
// print JSON, so the flag is accepted there as a no-op (one habit for every index command) and
// refused everywhere else — an export writes files and prints no result to make JSON of.
const json = args.includes("--json");
if (json && !indexCmds.length) {
  throw new UsageError("--json applies to the commands that PRINT (--list-clients, --list-libraries; --list / --list-pages / --children / --whoami are JSON already). An export writes files instead — read its _manifest.json.");
}

// Same class of silent loss: the list/peek commands print and exit(0) before any export runs, so an
// export flag combined with one of them is a no-op the user has no way to see.
if (indexCmd && scopes.length) {
  throw new UsageError(`${indexCmd} only prints a structural index — it cannot be combined with ${scopes.join(" / ")}. Run the list first, then pull with the ids it prints.`);
}
// Two index commands at once is the same silent loss one step over: only one of them would run and
// print, and the other would vanish without a word.
if (indexCmds.length > 1) {
  throw new UsageError(`${indexCmds.join(" and ")} are different queries — pass only one.`);
}
// Read options are the SAME silent loss, one step further in. The list ops emit only structural
// fields (id/name/type/size) — they never serialize a node, never call getCSSAsync, never read
// measurements, never export an asset — so every flag in READ_OPT_FLAGS is a no-op here, discarded
// without a word. Refused as a group, --no-assets included: it is just as inert (nothing renders on
// this path), and exempting it would put the caller back to guessing WHICH flags survive a list,
// which is the ambiguity the guard exists to remove. `--timeout` is deliberately NOT in this set —
// it genuinely applies (listTimeoutMs).
// --list-libraries is in the same boat and joins the guard through indexCmd: it reports library
// identity/usage, never a serialized node, so a read option there would be discarded just as silently.
if (indexCmd && readOptFlagsGiven.length) {
  const cmd = indexCmd;
  // What the command DOES emit, so the refusal explains itself instead of asserting a shape that is
  // wrong for one member of the family.
  const emits = cmd === "--list-libraries" ? "only prints the libraries this file uses"
    : cmd === "--whoami" ? "only prints connection/plugin identity"
    : cmd === "--list-clients" ? "only prints which Figma files are connected"
    : "only prints a structural index (id/name/type/size)";
  // Decide plurality ONCE. Six inline ternaries in one template literal meant any wording edit was an
  // edit to a 400-character single expression with six branch points.
  const many = readOptFlagsGiven.length > 1;
  const [are, they, them] = many ? ["are read options", "they", "them"] : ["is a read option", "it", "it"];
  throw new UsageError(`${readOptFlagsGiven.join(" / ")} ${are} for an EXPORT — ${cmd} ${emits}, so ${they} would be silently ignored. Drop ${them} here, and pass ${them} to the --page pull afterwards.`);
}
// --design-system never walks a page or node, so every read option (css/measurements/
// plugin-data/motion/shared-data/no-assets) is just as inert here as it is on a list command — same
// silent-loss class, same refusal. --variant-visuals is the ONE exception: it enriches the
// component catalog itself (findAllWithCriteria for COMPONENT_SET/COMPONENT), which --design-system
// and --as-library both build, so it is genuinely live here — excluded from the guard below and
// forwarded explicitly a few lines down.
const dsGuardFlags = readOptFlagsGiven.filter((f) => f !== "--variant-visuals");
if ((designSystemOnly || asLibrary) && dsGuardFlags.length) {
  const many = dsGuardFlags.length > 1;
  const [are, they, them] = many ? ["are read options", "they", "them"] : ["is a read option", "it", "it"];
  throw new UsageError(`${dsGuardFlags.join(" / ")} ${are} for a node/page walk — ${asLibrary ? "--as-library" : "--design-system"} skips that walk entirely, so ${they} would be silently ignored. Drop ${them} here, and pass ${them} to a --page pull afterwards.`);
}

// A daemon command owns the invocation. Combining it with a pull or a list is the same silent-loss
// class the scope guards above exist for: --serve --all-pages would start a daemon and never run the
// export the user typed, with nothing said about it.
if (daemonCmd) {
  const others = [...scopes, screenshotId && "--screenshot", ...indexCmds, ...readOptFlagsGiven].filter(Boolean);
  if (others.length) {
    throw new UsageError(`${daemonCmd} manages the background bridge — it cannot be combined with ${others.join(" / ")}. Start the daemon, then run your pull as a separate command (it will route through it automatically).`);
  }
  if (DAEMON_CMDS.filter((f) => args.includes(f)).length > 1) {
    throw new UsageError("--serve / --stop / --daemon-status are different commands — pass only one.");
  }
}

// A token command owns the invocation for the same reason a daemon one does: it manages the local
// credential and never opens a bridge, so pairing it with a pull would start an export the user did
// not ask for — or, worse, silently do only the token half of what they typed.
if (tokenCmd) {
  const others = [...scopes, screenshotId && "--screenshot", daemonCmd, ...indexCmds, ...readOptFlagsGiven].filter(Boolean);
  if (others.length) {
    throw new UsageError(`${tokenCmd} manages the stored bridge token — it cannot be combined with ${others.join(" / ")}. Run it on its own, then run your command.`);
  }
  const tokenCmds = TOKEN_CMDS.filter((f) => args.includes(f));
  if (tokenCmds.length > 1) {
    throw new UsageError(`${tokenCmds.join(" and ")} are different commands — pass only one.`);
  }
  // --token-file names a token to READ; these three act on the STORED one. Passing both reads as
  // "rotate/report the token in this file", which is not what happens — the stored token is the one
  // acted on and the --token-file one is silently ignored. --show-token is the ONE token command
  // where --token-file genuinely applies (print the token in that file), so it is not listed here.
  if (tokenFile && tokenCmd !== "--show-token") {
    throw new UsageError(`${tokenCmd} acts on the stored token, so --token-file would be silently ignored. Drop it (or, for --rotate-token/--forget-token, edit that file directly).`);
  }
}

return { selection, allPages, designSystemOnly, asLibrary, nodeId, readOpts, listOnly, listDepth, childrenId, screenshotId, scale, listLibraries, whoami, listClients, client, pageSel, exportTimeoutMs, listTimeoutMs, connectWaitMs, outDir, daemonCmd, tokenCmd, tokenFile, json };
}

// --list-libraries prints for a HUMAN (and for an agent skimming a terminal), not raw JSON: the
// payload is a handful of rows, and an aligned table is the difference between "I can see at a glance
// which library this file draws on" and "here is 80 lines of JSON to parse by eye". --list stays JSON
// because its payload is an id catalogue you copy from; this one is a decision aid you READ.
// Pure string-in/string-out so the test suite can drive the empty case (the one that must not look
// like a failure) without a plugin on the other end.
// The connected-files table. Same contract as formatLibraries below: prints for a HUMAN (and an agent
// skimming a terminal), and the EMPTY case is the one that has to explain itself — "no files
// connected" is the normal state before you open the plugin, not a broken bridge.
function formatClients(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return "No Figma files are connected to the bridge.\n" +
      "  Open a file in Figma and run \"Design Twin\" (Plugins → Development). The plugin\n" +
      "  auto-connects and announces itself. You can open it in SEVERAL files at once — each one\n" +
      "  becomes a separate row here, addressable with --client.";
  }
  const lines = [list.length + " Figma file" + (list.length === 1 ? "" : "s") + " connected:", ""];
  for (const c of list) {
    const mins = Math.round((c.uptimeMs || 0) / 60000);
    // An unidentified row is a real state, not a bug: the socket is up but the plugin has not sent its
    // `hello` yet (or is an older build that never does), so say what it IS addressable by.
    lines.push("  " + (c.connId || "?").padEnd(5) + " " + (c.file ? JSON.stringify(c.file) : "(unidentified — address it by connId)"));
    const bits = [];
    if (c.page) bits.push("page " + JSON.stringify(c.page));
    bits.push(c.fileKey ? "fileKey " + c.fileKey : "no fileKey (private-plugin API not in effect)");
    bits.push("up " + (mins >= 1 ? mins + "m" : Math.round((c.uptimeMs || 0) / 1000) + "s"));
    lines.push("        " + bits.join(" · "));
  }
  lines.push("");
  lines.push("Address one with --client <connId | fileKey | part of the file name>, e.g. --client " +
    (list[0].file ? JSON.stringify(list[0].file.split(/\s+/)[0]) : list[0].connId) + ".");
  lines.push("Note: c1/c2 are reconnect-order LABELS for this bridge's current lifetime, not stable ids —" +
    " a restart without `dtwin serve` can hand a different file the same label next time. Prefer the" +
    " file name or fileKey when you script this.");
  return lines.join("\n");
}

function formatLibraries(r) {
  const libs = (r && r.libraries) || [];
  const lines = [];
  if (!libs.length) {
    // The empty result is a NORMAL outcome, and saying so is the whole job here. Figma's team-library
    // reads return nothing when no library is enabled for the file, and library VARIABLE data is
    // unavailable on a free plan — both look exactly like a broken bridge unless the output says
    // otherwise. A stale plugin (imported before the manifest gained "teamlibrary") also lands here,
    // which is why it is named as the FIRST thing to check.
    lines.push("No libraries reported for this file.");
    lines.push("");
    lines.push("This is a normal outcome, not necessarily an error. In order of likelihood:");
    lines.push('  1. The plugin in Figma predates the "teamlibrary" permission — re-import/reload');
    lines.push("     \"Design Twin\" in Figma, then run this again.");
    lines.push("  2. No team library is ENABLED for this file. Libraries can only be enabled from the");
    lines.push("     Figma UI (Assets panel -> Libraries) — no API can enable one.");
    lines.push("  3. Free plan: library variable collections are not exposed to plugins.");
    return lines.join("\n");
  }
  // Column widths from the data, so a long library name doesn't shear the table apart.
  const rows = libs.map((l) => {
    const cols = (l.variableCollections || []);
    return {
      kind: String(l.kind || "?"),
      name: String(l.name || "(unnamed)"),
      collections: String(cols.length),
      variables: String(cols.reduce((n, c) => n + (Number(c.variableCount) || 0), 0)),
      components: String(Number(l.componentCount) || 0),
      cols,
      note: l.note,
    };
  });
  const head = { kind: "KIND", name: "NAME", collections: "COLLECTIONS", variables: "VARIABLES", components: "COMPONENTS (used here)" };
  const w = (k) => Math.max(head[k].length, ...rows.map((x) => x[k].length));
  const wk = w("kind"), wn = w("name"), wc = w("collections"), wv = w("variables");
  const line = (x) => `  ${x.kind.padEnd(wk)}  ${x.name.padEnd(wn)}  ${x.collections.padStart(wc)}  ${x.variables.padStart(wv)}  ${x.components}`;
  lines.push(`LIBRARIES (${libs.length})`);
  lines.push("");
  lines.push(line(head));
  for (const x of rows) {
    lines.push(line(x));
    // Collections are the thing you actually scope a token pull by, so they're worth the indent.
    for (const c of x.cols) lines.push(`      · ${c.name} (${Number(c.variableCount) || 0} variables)${c.key ? "  key=" + c.key : ""}`);
    if (x.note) lines.push(`      note: ${x.note}`);
  }
  lines.push("");
  // The two limits that make a number here mean something other than what it looks like. Printed
  // every time, because the counts are the part a reader is most likely to over-trust.
  lines.push("Component counts are USAGE-derived (components from that library actually used in this");
  lines.push("file) — Figma exposes no API to enumerate a library's full contents.");
  lines.push("Only libraries ENABLED for this file (in the Figma UI) can appear at all.");
  return lines.join("\n");
}

// CLI entry: parse once, turning a UsageError back into the message + exit 1 it replaced. When this
// file is REQUIRED (the test suite pulling in parseArgs/writePages) there is no CLI invocation to
// read, so parse nothing — the runner's own argv is not ours to interpret or exit over.
let parsed;
try {
  parsed = parseArgs(require.main === module ? process.argv.slice(2) : []);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error("[dtwin] error: " + errMsg(e));
  process.exit(1);
}
const { selection, allPages, designSystemOnly, asLibrary, nodeId, readOpts, listOnly, listDepth, childrenId, screenshotId, scale, listLibraries, whoami, listClients, client, pageSel, exportTimeoutMs, listTimeoutMs, connectWaitMs, outDir, daemonCmd, tokenCmd, tokenFile, json } = parsed;

async function main() {
  // ---- token lifecycle commands. These run FIRST and return: they touch only the local token file,
  // so unlike everything below they need no bridge, no daemon and no plugin. Running them before
  // daemon.connect() also means they still work while a daemon holds the port.
  if (tokenCmd === "--token-status") {
    const st = tokenStore.status();
    console.log(JSON.stringify(st, null, 2));
    console.error("[dtwin] token file: " + st.path + (st.stored ? "" : " (none saved yet)"));
    console.error("[dtwin] in use: " + (
      st.activeSource === "env" ? "FIGMA_BRIDGE_TOKEN from the environment"
        : st.activeSource === "token-file" ? "the file given by --token-file"
        : st.activeSource === "file" ? "the saved token"
        : "a per-run token (nothing saved yet — the next bridge start will save one)"
    ) + (st.fingerprint ? ` (${st.fingerprint})` : ""));
    // The genuinely confusing state: a saved token exists, but the env var overrides it, so editing
    // the file changes nothing and the user has no way to see why.
    if (st.shadowed) {
      console.error("[dtwin] note: FIGMA_BRIDGE_TOKEN is set, so it WINS over the saved token. Unset it to use the file.");
    }
    if (st.loosePerms) console.error("[dtwin] warning: " + st.path + " is readable by other users — chmod 600 it.");
    return;
  }
  if (tokenCmd === "--show-token") {
    const { token, source } = tokenStore.resolve({ tokenFile, persist: false });
    // stdout, alone, so it pipes: `dtwin --show-token | pbcopy`. Every note goes to stderr.
    console.log(token);
    if (source === "ephemeral") {
      console.error("[dtwin] note: nothing is saved yet, so this token is NOT what a future run will use. Start a bridge once to save one.");
    }
    return;
  }
  if (tokenCmd === "--rotate-token") {
    const had = tokenStore.readFrom(tokenStore.tokenPath());
    const token = tokenStore.generate();
    const file = tokenStore.write(token);
    console.log(token);
    console.error(`[dtwin] ${had ? "replaced" : "saved"} the bridge token in ${file}.`);
    // The whole point of naming this: the plugin has the OLD token in clientStorage and will now
    // fail every handshake with a bare 401, retrying every 3s, until someone re-pastes.
    console.error('[dtwin] re-paste it into the plugin\'s "Bridge token" field and press Save — until you do, the plugin cannot connect.');
    if (process.env.FIGMA_BRIDGE_TOKEN) {
      console.error("[dtwin] warning: FIGMA_BRIDGE_TOKEN is set and OVERRIDES this file, so the bridge will keep using the env value. Unset it for the rotation to take effect.");
    }
    return;
  }
  if (tokenCmd === "--forget-token") {
    const file = tokenStore.tokenPath();
    const removed = tokenStore.remove(file);
    console.error("[dtwin] " + (removed ? `deleted ${file}. The next bridge start mints and saves a new token.` : `nothing to delete — no token saved at ${file}.`));
    return;
  }

  // ---- daemon lifecycle commands. Each owns the whole invocation and returns.
  if (daemonCmd === "--stop") {
    const stopped = await daemon.stop();
    console.error("[dtwin] " + (stopped ? "daemon stopped." : "no daemon is running."));
    return;
  }
  if (daemonCmd === "--daemon-status") {
    const st = await daemon.status();
    console.log(JSON.stringify(st || { daemon: false }, null, 2));
    console.error("[dtwin] " + (st
      ? `daemon up (pid ${st.pid}, port ${st.port}) — plugin ${st.pluginConnected ? "CONNECTED" : "not connected"}` +
        (st.idleMs ? `, idle ${Math.round(st.idleForMs / 60000)}/${Math.round(st.idleMs / 60000)} min before auto-shutdown.` : ", no idle shutdown.")
      : "no daemon is running — start one with --serve."));
    return;
  }
  if (daemonCmd === "--serve") {
    const bridge = createBridge();
    const { sock } = await daemon.serve(bridge, { log: (m) => console.error("[dtwin] " + m) });
    console.error("[dtwin] bridge listening on ws://localhost:" + bridge.port + " — socket " + sock);
    console.error('[dtwin] Open your Figma file and run "Design Twin" (it auto-connects).');
    console.error("[dtwin] The connection stays open until you run --stop (or Ctrl-C here).");
    const idleMin = Number(process.env.FIGMA_DAEMON_IDLE_MIN ?? 120);
    console.error("[dtwin] " + (idleMin > 0
      ? `It also shuts down after ${idleMin} min idle, so an abandoned daemon can't hold port 8787 forever (FIGMA_DAEMON_IDLE_MIN=0 disables).`
      : "Idle shutdown is DISABLED — remember to --stop it, or it holds port 8787 until you do."));
    return; // the socket + WS server keep the event loop alive; no close() here, by design
  }

  // ---- ordinary commands. Route through a running daemon when there is one: it already holds the
  // bridge (and port 8787), so opening our own here would hit EADDRINUSE and exit. When there is no
  // daemon this is exactly the one-shot path it always was.
  const d = await daemon.connect();
  if (d) console.error("[dtwin] using the running daemon (" + d.sock + ") — no reconnect needed.");

  // outDir is created lazily by each writer (writeExport/writeScreen/writeScreenshot all
  // fs.mkdirSync(dir, {recursive:true}) themselves) rather than eagerly here. Creating it up front —
  // before the client was even resolved — meant a command that fails on the multi-client check (or any
  // other pre-export validation) still left a stray empty outDir behind (finding 13): `dtwin
  // nonexistent` with two clients connected exited 1 on "say which one to use" and left `./nonexistent/`
  // on disk. `--list`/`--children` never write outDir at all, so they need no mkdir either way.

  // An export-class command is the one shape findings 202/213 hit: exportNode/exportSelection/
  // exportLibrary/exportDesignSystem/exportFull, below — never the index commands (--list/--children/
  // --whoami/--list-clients/--list-libraries), which are cheap and already excluded from the mkdir
  // guard above for the same reason. Only these get the upfront no-daemon warning and the stall check.
  const isExportCmd = !listOnly && !childrenId && !listLibraries && !whoami && !listClients;
  // Findings 202/213/220: without `dtwin serve`, every pull opens a throwaway bridge and the plugin's
  // reconnect is what actually costs the time (measured 300s/908s vs 7.5-8.8s with a daemon warm).
  // Said up front, before anything is sent, not just diagnosed after the fact by `dtwin doctor`.
  if (!d && isExportCmd) {
    console.error("[dtwin] no `dtwin serve` daemon is running — this pull opens its own bridge and waits out the plugin's full reconnect, which can take minutes on a cold connection. Run `dtwin serve` in another terminal for a fast, reliable connection.");
  }
  // The stall-check window (server-core.js's request() `stallMs`): if NOTHING at all is heard back
  // from the plugin (not even a progress frame) within this long, abort rather than sit until the full
  // export timeout. Only applied to the one-shot bridge below, and only for export commands — see the
  // comment on `request()`'s stallMs parameter for why the daemon path opts out.
  const STALL_MS = Number(process.env.FIGMA_BRIDGE_STALL_MS) || 20000;

  let bridge = null;
  let send;
  if (d) {
    // waitForConnection is forwarded so the DAEMON does the waiting: the plugin may not have
    // reconnected yet after a Figma restart, and the daemon is the side holding the socket.
    send = (cmd, args, timeoutMs) => d.request({ cmd, args, timeoutMs, client, waitForConnection: connectWaitMs }, timeoutMs + connectWaitMs + 30000);
  } else {
    bridge = createBridge();
    console.error("[dtwin] listening on ws://localhost:" + bridge.port);
    console.error('[dtwin] Open your Figma file and run "Design Twin" (it auto-connects)…');
    console.error("[dtwin] tip: --serve keeps this connection open so later pulls skip the reconnect.");
    // --list-clients IS meaningful with nothing ever connecting ("which files can I talk to?" →
    // "none, open one"), but with no daemon running it is talking to a bridge it JUST opened, and every
    // plugin window currently open in Figma is mid-reconnect to it (they retry every 3s). Skipping the
    // wait here used to make `list clients` answer `{"clients":[]}` with exit 0 while two files were
    // connected a second later (finding 210) — the documented `--timeout` window applies to this
    // command too. The difference from an export is only what happens on a full timeout: no plugin
    // ever showing up is this command's legitimate "none" answer, not an error, so the wait is capped
    // at `connectWaitMs` but a timeout falls through to the (possibly still empty) listClients() below
    // instead of throwing.
    try { await bridge.waitForConnection(connectWaitMs); }
    catch (e) {
      if (!listClients) {
        bridge.close();
        throw new Error(`no Figma plugin connected within ${Math.round(connectWaitMs / 1000)}s. In Figma DESKTOP open the file and run Plugins → Development → Design Twin, then run this again (--timeout <seconds> waits longer; \`dtwin doctor\` says what is wrong if it still won't connect).`);
      }
      // listClients: no plugin ever connected within the window — a genuine "none", not a failure.
    }
    // A name/fileKey target (not a bare c<N> connId, which never depends on identification) can lose
    // the race against the plugin's `hello` — see waitForIdentified's comment (finding 216).
    if (client && !/^c\d+$/.test(client)) await bridge.waitForIdentified();
    send = (cmd, args, timeoutMs) => bridge.request(cmd, args, timeoutMs, client, isExportCmd ? STALL_MS : undefined);
  }
  // Every exit path below used to call bridge.close(); with a daemon there is no bridge of ours to
  // close, and closing the DAEMON's would be wrong — one helper so no call site has to know which.
  const finish = () => { if (bridge) bridge.close(); };

  // The library discovery command. Same cost/budget tier as the two below (cheap relative to an
  // export) and the same "print, never write outDir" contract — but its own branch, because it
  // prints a TABLE rather than the JSON id-catalogue those two exist to hand you.
  // Which Figma files are connected right now. Prints a table for a human (and for an agent skimming
  // a terminal); the connId in the first column is what --client takes. Deliberately does NOT talk to
  // the plugin at all — the answer lives entirely in the bridge, so this works even while every
  // connected file is busy with a long export.
  if (listClients) {
    const rows = bridge ? bridge.listClients() : ((await daemon.status()) || {}).clients || [];
    console.log(json ? JSON.stringify({ clients: rows }, null, 2) : formatClients(rows));
    if (rows.length > 1) {
      console.error("[dtwin] " + rows.length + " files connected — pass --client <id|fileKey|name> " +
        "to pick one, or commands that need a target will refuse rather than guess.");
    }
    return finish();
  }

  // The identity/liveness probe. Prints BOTH halves: what the plugin says it is, and what the socket
  // did. Run it in each of two open files (a second terminal, or twice in a row after switching the
  // focused file) and compare — the interpretation notes below are printed with the result so the
  // reading does not depend on remembering what each field means.
  if (whoami) {
    const r = await send("whoami", {}, TIMEOUTS.command);
    // connectionInfo lives on the bridge object; with a daemon in front, the daemon owns it and this
    // process has no bridge of its own, so report the plugin half alone rather than inventing zeros.
    // With a daemon in front this process owns no socket, but the DAEMON does — so ask it, rather
    // than emitting `connection: null` under a help text that promises socket uptime and takeovers.
    let conn = bridge ? bridge.connectionInfo() : null;
    let connFrom = bridge ? "this process" : null;
    if (!conn) {
      const st = await daemon.status().catch(() => null);
      if (st && st.connection) { conn = st.connection; connFrom = `the daemon (pid ${st.pid})`; }
    }
    console.log(JSON.stringify({ plugin: r, connection: conn, connectionFrom: connFrom || undefined }, null, 2));
    console.error("[dtwin] plugin instance " + r.instanceId + " — file " + JSON.stringify(r.file) +
      ", up " + Math.round((r.uptimeMs || 0) / 1000) + "s.");
    console.error("[dtwin] fileKey: " + (r.fileKeyAvailable
      ? r.fileKey + " (available — usable as a stable routing key)"
      : "UNAVAILABLE (gated to private plugins; routing must use a server-minted id)"));
    if (conn) {
      console.error("[dtwin] socket " + conn.connId + " up " + Math.round(conn.connectionUptimeMs / 1000) +
        "s; connections this run: " + conn.connectionsThisRun + ", takeovers: " + conn.takeovers +
        (conn.takeovers ? " — a second plugin instance DID connect and displace an earlier one." : ".") +
        (connFrom && connFrom !== "this process" ? " (from " + connFrom + ")" : ""));
    } else {
      console.error("[dtwin] socket stats unavailable — no daemon is running and this process holds no bridge of its own.");
    }
    console.error("[dtwin] reading it: run this from BOTH open files. Two different instanceIds => " +
      "two instances coexist. A CHANGED instanceId on a repeat call => Figma restarted the plugin runtime. " +
      "takeovers > 0 => the bridge's one-connection limit is what disconnected the other file, not Figma.");
    return finish();
  }

  if (listLibraries) {
    console.error("[dtwin] plugin connected — listing libraries…");
    const r = await send("listLibraries", {}, listTimeoutMs);
    // Plugin-side warnings first, on stderr, so they survive a `| less` of stdout and can never be
    // mistaken for part of the table.
    for (const w of (r && r.warnings) || []) console.error("[dtwin] warn  " + w);
    console.log(json ? JSON.stringify(r, null, 2) : formatLibraries(r));
    console.error("[dtwin] next: dtwin --list   then   --page <id>   (pull only the pages you need)");
    return finish(); // see the close()-not-exit note below
  }

  // The two cheap index commands. --list is the file-wide map (consult it to pick a target, THEN
  // deep-pull just that one); --children <id> is its node-scoped twin, for peeking inside a frame
  // --list surfaced. Both PRINT to stdout and never write outDir — a decision aid, not a build input —
  // and both share the same warn/print/hint/shutdown tail, so only the command differs.
  if (listOnly || childrenId) {
    const q = childrenId
      ? {
          note: "listing children of " + childrenId,
          cmd: "listChildren",
          args: { nodeId: childrenId },
          summary: (r) => `${r.children.length} direct child(ren) of "${r.name}" (${r.type}).`,
        }
      : {
          note: "listing structure",
          cmd: "listPages",
          args: { depth: listDepth },
          // "top-level frame(s)" was a lie on every real file: the array holds SECTION, GROUP,
          // INSTANCE, TEXT and RECTANGLE too, and on a sectioned file the actual screens are one
          // level deeper (live finding 18). Say "layer", which is Figma's own word for any object,
          // and break the count down so "deep-pull next" points somewhere real.
          summary: (r) => {
            const fr = r.manifest && r.manifest.frames;
            const byType = {};
            for (const f of r.frames || []) byType[f.type || "?"] = (byType[f.type || "?"] || 0) + 1;
            const kinds = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(", ");
            return `${r.manifest.pages} page(s)${fr === undefined ? "" : `, ${fr} top-level layer(s)`} in "${r.file}"${kinds ? ` — ${kinds}` : ""}.`;
          },
        };
    console.error("[dtwin] plugin connected — " + q.note + "…");
    const r = await send(q.cmd, q.args, listTimeoutMs);
    for (const w of (r.manifest && r.manifest.warnings) || []) console.error("[dtwin] warn  " + w);
    console.log(JSON.stringify(r, null, 2));
    console.error("[dtwin] " + q.summary(r));
    // A SECTION is a container, not a screen — pulling one deep-serializes every screen inside it.
    // On the file this was found on, the sections were 8898-35975px wide.
    if ((r.frames || []).some((f) => f.type === "SECTION")) {
      console.error("[dtwin] note: some top-level layers are SECTIONs — containers, not screens. The screens are INSIDE them:");
      console.error("[dtwin]       dtwin list children <section id>   then pull the frame you want.");
    }
    console.error("[dtwin] next: dtwin pull design --page <id>   (repeatable; add --no-assets to skip the render pass)");
    console.error("[dtwin]       or: dtwin pull design --node <id>   (just ONE node, fully exported with its own assets)");
    console.error("[dtwin]       unsure which of two same-named frames? dtwin screenshot <id> renders one cheaply.");
    // The WS server keeps the event loop alive, so without an explicit shutdown these commands hung
    // forever after printing (found live: still resident and holding port 8787 a minute later,
    // blocking every subsequent pull). close() rather than process.exit(0) — same effect on the hang,
    // without truncating the JSON these commands exist to print. See close() in server-core.js.
    return finish();
  }

  // --screenshot: one node's reference PNG, on demand — the visual-validation counterpart to --list/
  // --children above. Cheap next to a full export (skips serialize() and the recursive asset walk —
  // see collectScreenshot's comment in collect.ts) but it DOES write a file, unlike the two commands
  // it sits next to, so it gets its own branch rather than joining their print-only one.
  if (screenshotId) {
    console.error("[dtwin] plugin connected — rendering a reference screenshot…");
    const r = await send("screenshot", { nodeId: screenshotId, scale }, exportTimeoutMs);
    for (const w of (r.manifest && r.manifest.warnings) || []) console.error("[dtwin] warn  " + w);
    // Print the path writeScreenshot actually wrote, not the plugin's own relative `reference`
    // string: those disagreed for a whole release (live-test findings 20/31) and a printed path that
    // finds nothing is worse than no path at all.
    const shot = writeScreenshot(outDir, r);
    const ref = shot.reference || r.reference;
    console.log(JSON.stringify({ id: r.id, name: r.name, type: r.type, reference: ref }, null, 2));
    console.error(`[dtwin] wrote ${path.join(outDir, ref)} — ${r.name} (${r.type}).`);
    return finish();
  }

  const mode = asLibrary ? `library "${asLibrary}"` : nodeId ? `node ${nodeId}` : selection ? "selection" : designSystemOnly ? "design system only" : allPages ? "all pages" : pageSel.length ? `page(s) ${pageSel.join(", ")}` : "current page";
  // Measured: --all-pages did not finish in 15 minutes on a real 25-page/119-frame file, even with
  // --no-assets. Kept (it's slow, not unsafe — and it's fine on small files) but it should not be the
  // path anyone reaches for by default, so say so up front rather than after a quarter-hour.
  if (allPages) {
    console.error("[dtwin] note: --all-pages deep-serializes EVERY frame on EVERY page and can exceed 15 min on a large file.");
    console.error("[dtwin]       prefer: --list  then  --page <id>   (repeatable, e.g. --page 1:2 --page 3:4)");
  }
  console.error(`[dtwin] plugin connected — pulling ${mode}… (timeout ${Math.round(exportTimeoutMs / 1000)}s)`);

  if (nodeId) {
    // Same writer the MCP figma_export_url tool uses (write-out.js's writeScreen), so a CLI --node
    // pull and an MCP pull of the same node land in identical shape.
    const r = await send("exportNode", { nodeId, ...readOpts }, exportTimeoutMs);
    OUT.writeScreen(outDir, r, plog);
  } else if (selection) {
    // Same writer as --node above — routing both through write-out.js's writeScreen means a
    // selection pull and a --node pull can never drift into two slightly different write shapes
    // (this used to write variables.json unconditionally, where writeScreen correctly skips it
    // when the result carries none, and printed no summary).
    const r = await send("exportSelection", { ...readOpts }, exportTimeoutMs);
    OUT.writeScreen(outDir, r, plog);
  } else if (asLibrary) {
    // Same writer as every other branch: writeExport routes on the plugin's own `source.role`, so a
    // library catalog lands under libraries/<slug>-<fileKey8>/ and can never overwrite design-system/.
    const r = await send("exportLibrary", { asLibrary, variantVisuals: readOpts.variantVisuals }, exportTimeoutMs);
    OUT.writeExport(outDir, r, plog);
    printHygiene(r);
  } else if (designSystemOnly) {
    const r = await send("exportDesignSystem", { variantVisuals: readOpts.variantVisuals }, exportTimeoutMs);
    // Same writer as the full-export branch (OUT.writeExport): it resolves outDir the same way,
    // reports counts, and degrades correctly with no layersDoc/assets on this result shape. The
    // limited-library-variables note rides in designSystem.hygiene (see collect.ts), which
    // writeDesignSystem persists to hygiene.json — not a `manifest.warnings` field that would be
    // silently dropped by the split, both here and via the MCP writeToDisk path.
    OUT.writeExport(outDir, r, plog);
    printHygiene(r);
  } else {
    const r = await send("exportFull", { allPages, page: pageSel.length ? pageSel : undefined, ...readOpts }, exportTimeoutMs);
    // Route through the SAME split writer the MCP export tools use (write-out.js's writeExport), so a
    // CLI pull and an MCP pull land in identical shape. The CLI used to write r.designSystem flat to
    // design-system.json here — undocumented drift from the split described in this file's own header
    // comment and from what the harness's write-out tests actually assert.
    OUT.writeExport(outDir, r, plog);
    printHygiene(r);
  }

  console.error("[dtwin] done.");
  finish(); // NOT process.exit — see close() in server-core.js (a daemon-routed run has nothing to close)
}

// Only actually pull when RUN. Requiring this file (test/bridge.test.js drives parseArgs and
// writePages directly) must not open a WebSocket server and sit there waiting for Figma.
if (require.main === module) {
  main().catch((e) => {
    console.error("[dtwin] error:", errMsg(e));
    process.exit(1);
  });
}

// writeJson is exported for the test suite: it's the ONE place a design-system.json / screen.json
// actually lands on disk, and the freshness stamp (`exportedAt`/`file`, stamped by the plugin itself —
// see collect.ts/components.ts) must survive that write byte-for-byte. figma-pull never adds, strips,
// or re-derives the stamp; it only writes what the plugin sent.
// formatLibraries is exported for the same reason parseArgs is: the case that MUST NOT look like a
// failure (zero libraries — free plan, or none enabled in the UI) is unreachable from a test that
// needs a live plugin, so the renderer is driven directly.
module.exports = { parseArgs, writePages, writeJson, formatLibraries, formatClients, UsageError };
