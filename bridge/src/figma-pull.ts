#!/usr/bin/env -S bun --no-install --no-env-file
// The shebang runs this TypeScript source directly (it is what the package's `bin` points at — there is
// no build). `--no-install`: Bun never auto-installs a package a project lacks from the network (a
// missing dependency is an error, not a download); `--no-env-file`: the project's .env is not loaded
// into this process (a FIGMA_BRIDGE_PORT there would silently move the bridge). `env -S` splits the
// line into its arguments on Linux (GNU coreutils >= 8.30) and macOS alike; BusyBox's env (Alpine) has no
// -S, so there the documented form is `bun --no-install --no-env-file <this file>` (bridge/README.md).
//
// ROUTING (see `cli()` near the bottom of this file): `dtwin mcp`, `dtwin init`, `dtwin doctor`,
// `dtwin seed` and the verbs are dispatched there before anything else runs — in particular before the settings are read.
// `dtwin mcp` routes to the MCP server (figma-mcp.ts). The .mcp.json entry `dtwin init --mcp` writes names
// figma-mcp.ts itself (an absolute bun and path); this route must not disturb any existing invocation: the branch is taken
// ONLY when this file is the process entry AND the first argument is exactly "mcp", so `dtwin …` and
// importing this module from the test suites are untouched, and `bun bridge/src/figma-mcp.ts` still
// works when invoked directly. Everything that reads argv lives inside the async `cli()`, where a
// plain `return` stops the rest of the CLI (arg parsing, bridge setup) from ever loading in MCP mode;
// the module top level holds only side-effect-free imports and the pure, test-driven helpers.

// figma-pull — READ plane CLI.
// Connects to the running Figma plugin over the localhost bridge, pulls the full
// design system + all page frames (or the current selection), and writes them to
// disk. The agent then Reads those files selectively (context-economical).
//
// Usage: the USAGE constant below (after the imports) is the reference for every command and flag —
// it is exactly what `dtwin --help` prints, so the help can never drift from the one place they are
// documented.

import fs from "node:fs";
import path from "node:path";
import * as LAYOUT from "./project-layout.ts";
// TIMEOUTS is the per-command budget table both front-ends read (timeouts.ts); a read's own tier comes from
// read-plan.ts, so the CLI and the MCP tools cannot drift apart. parseArgs and formatClients are pure and test-driven:
// importing this module resolves no token and reads no port — cli() reads the settings (settings.ts) once the
// arguments are parsed.
import { TIMEOUTS, MAX_TIMER_MS } from "./timeouts.ts";
import { errMsg } from "./errmsg.ts";
import { emitTimings, stageClock, timingsTarget } from "./timings.ts";
import * as tokenStore from "./token-store.ts";
import { pluginStalenessNote, daemonRowStalenessNote } from "./staleness.ts";
import type { ClientRow } from "./server-core.ts";
// No load-time effects (settings.ts resolves what it once resolved at load), so a static import.
import { createBridge } from "./server-core.ts";
// The command/reply contract shared with the plugin (commands.ts): `send()` below is typed per command
// from it, so this file cannot read a reply field the plugin never sends (a hand-mirror once
// declared a top-level `frames` that did not exist, and two hints silently never printed).
import type { Cmd, Commands, ListChildrenReply, ListLibrariesReply, ListPagesReply, NodeSummary } from "./commands.ts";
// node-id.ts is "the ONE place that knows what a node id looks like and how it hides in a Figma URL"
// (its own header). --children's raw token is not handed straight to the plugin, whose only
// normalisation is replace(/-/g, ":") — a pasted design URL would work through the MCP twin
// (figma_list_children calls parseNodeId) and fail here. Same input, same answer, one parser.
import { toNodeId } from "./node-id.ts";
// write-out.ts is the ONE writer, shared with the MCP export tools' writeToDisk path — so a file
// pulled through the CLI and the same file pulled through MCP land in the same layout, by
// construction rather than by two implementations agreeing. The `log` argument is what differs:
// this front-end narrates every file to stderr, the MCP one stays silent.
import * as OUT from "./write-out.ts";
import { meteredRequest, runRead } from "./read-run.ts";
import type { ReadRun } from "./read-run.ts";
// The ONE registry of read options, shared with the plugin's run reads and the MCP tool schema.
import { READ_OPTS } from "./read-opts.ts";
import type { ReadOptName } from "./read-opts.ts";
// What a pull SENDS — command, arguments, budget, label — is the read plan's, shared with the MCP export tools.
import { planRead } from "./read-plan.ts";
import type { PlanOf, ReadCmd, ReadPlan, ReadRefusal, ReadScope } from "./read-plan.ts";
// daemon.ts holds the bridge open across invocations. Every ordinary command below goes through the bridge
// holder (bridge-holder.ts), which asks it for a connection FIRST and falls back to opening its own bridge — so the
// one-shot behaviour is unchanged when no daemon is running, and no command needs to know which mode it is in.
import * as daemon from "./daemon.ts";
import { bridgeHolder, daemonSide } from "./bridge-holder.ts";
import { daemonAddressOf, humanMs, readSettings, tokenOverridden } from "./settings.ts";
import type { BridgeSettings } from "./settings.ts";
import { createRoute } from "./route.ts";
import { ALLOWED_PORTS } from "./ports.ts";
import type { Route, Sent } from "./route.ts";
import { translate, VerbError, verbHelp, distance, dtwinPortWarning } from "./verbs.ts";
// THE command registry (cli-commands.ts): every command's flag, family, read and verb spellings, the
// combination guards per family, the modifiers and the help. Parsing, the guards, unknown-flag detection,
// dispatch and the help below are derived from it; each command's runner is in RUN_* below, typed by its id.
import { COMMAND_ROWS, COMMAND_SUMMARY, DEFAULT_COMMAND, FAMILIES, GUARDS, MCP_HELP, MODIFIERS, VALUE_MODIFIERS, VALUE_READ_ORDER } from "./cli-commands.ts";
import type { CommandId, CommandIdIn, CommandRow, Family, RoutedVerb, SessionFamily, ValueModifier } from "./cli-commands.ts";
import { ifDefined, isUnknownArray } from "./json-util.ts";
// The package's own package.json, imported (not read by a path at run time, so a compiled binary has it
// too): `dtwin --version` prints its version.
import pkg from "../package.json" with { type: "json" };
import { CliExit, exitCli, exitFlushed, runCli } from "./stdio.ts";
import { spriteAllowed, versionText } from "./mascot.ts";

// --help / -h: print USAGE and exit 0. Handled in cli() BEFORE the settings are read, so help has no
// side effects at all — no token minted, no port bound. A constant, not text read back from this file
// at run time: a compiled `dtwin` binary has no source file beside it to read.
const USAGE = `Usage:
Quick start (Figma file open, the "Design Twin" plugin running):
  dtwin list                        # what is in the file: pages + their top-level LAYERS, with ids
  dtwin screenshot 12:34            # a reference PNG of one node — look before you pull
  dtwin pull --node 12:34           # export ONE screen into design/export (tokens, tree, assets)
  dtwin doctor                      # something not working? checks token, port, daemon, plugin, project
  More than one Figma file connected? Add --client <fileKey|part of the file name> to every command
  above that reaches the plugin — see \`dtwin list clients\` for the address book.

Where things land: everything a pull writes goes under design/export/ and nowhere else, so that
directory can be deleted and re-pulled without touching design/target.json, design/codeconnect.local.json,
design/plan/ or design/audit/ — the files you own. \`design/README.md\` (written by init) says so too.

Commands (each is shorthand for a flag documented below — the flags keep working unchanged):
${COMMAND_SUMMARY}

  Every command above answers \`--help\` with its own page, and none of them does anything else
  while doing so.
  A command is only recognised as the FIRST argument: \`dtwin design\` still pulls into ./design.
  For an outDir spelled like a command, write \`dtwin pull list\` or \`dtwin ./list\`.

Full reference:
  dtwin init [--mcp]          # set up the project you are BUILDING: design/, target.json, the bridge
                              # token, the Figma plugin copy, (optionally) .mcp.json — then the steps left. See init --help
  dtwin [outDir]              # full: design-system.json + current-page frames + assets
  dtwin [outDir] --all-pages  # like full, but frame trees from EVERY page
  dtwin [outDir] --selection  # just the current selection
  dtwin [outDir] --page <id|name>   # ONE named page (repeatable; ids come from --list)
  dtwin [outDir] --node <id>  # ONE node, fully exported (properties + assets) — the
                                           # "paste a Figma link" path. Takes a bare id, dash form,
                                           # percent-encoded id, or a whole figma.com URL. Unlike
                                           # --children (peek only) and --screenshot (PNG only) this
                                           # walks the subtree and exports its assets, same as a
                                           # --page pull would for that subtree. The CLI twin of the
                                           # MCP figma_export_url tool.
  dtwin [outDir] --design-system    # ONLY tokens/styles/components/hygiene — no page
                                                  # walk, no assets (the cheap "just the design
                                                  # system" pull). Each catalogued component/variant
                                                  # carries its OWN fills/strokes/effects/cornerRadius/
                                                  # opacity/blendMode (\`visuals\`) — plain synchronous
                                                  # property reads, not the async cost this mode
                                                  # exists to avoid. NOTE: this is the component
                                                  # NODE's own paint (its default/base variant look),
                                                  # not per-instance overrides elsewhere in the file —
                                                  # and components consumed from a published library
                                                  # (not defined in this file) are NOT covered: pull
                                                  # --as-library on the source library file for those.
                                                  # Add --variant-visuals for the SET's own variants'
                                                  # real paint too (see below) — the one read option
                                                  # this mode accepts.
  dtwin [outDir] --as-library <name>  # the COMPLETE catalog of a LIBRARY file —
                                                  # every variable with full per-mode values, every
                                                  # style, every component. Run it with the LIBRARY
                                                  # file open, not the design file that consumes it.
                                                  # Writes <outDir>/libraries/<slug>-<fileKey8>/ (by
                                                  # default design/export/libraries/…) and
                                                  # never touches design-system/.
  dtwin [outDir] --timeout N  # seconds to wait for the export (default: 300,
                                           # 900 with --all-pages, 120 for --selection); also
                                           # raises the list commands' own 300s budget

Optional Tier-1 reads (opt-in — each costs extra Plugin-API work):
  --css            # Figma's own computed CSS per node (getCSSAsync) — the design-to-code oracle
  --measurements   # measurement redlines (spacing specs the designer placed) for the exported page(s).
                   # NOT Dev-Mode-only: per developers.figma.com only add/edit/deleteMeasurement are.
  --plugin-data    # own-scope plugin data stamped on nodes
  --motion         # motion/animation reads (timelines, keyframe tracks, animations, styles)
  --shared-data    # cross-plugin shared data (Tokens Studio applied tokens via getSharedPluginData)
  --variant-visuals  # walk each COMPONENT_SET's variants and attach their REAL layout/fills/radius/
                     # tokens (not the set wrapper's own selection-chrome visuals). One node walk
                     # per variant, so slower on large systems. The ONE read option --design-system
                     # and --as-library both accept (see below) — it enriches the component catalog
                     # they build, unlike the others which need a page/node walk neither does.

Look before you pull (cheap RELATIVE to an export — no recursion, no assets, no node properties;
prints JSON to stdout):
  dtwin --list         # pages + their top-level frames (ids to deep-pull next).
                                    # Loads each page (Figma warns loading pages is slow on large
                                    # files) — cheap next to an export, not free. Use --list-pages
                                    # if you only need the page names.
  dtwin --list-pages   # page names only (near-free: does not load any page)
  dtwin --children <id>  # ONE node's direct children only (peek inside a frame from
                                       # --list before committing to a full recursive --page pull)
  dtwin --screenshot <id> [--scale N]  # on-demand PNG of ONE node (a component/instance
                                       # buried in a dense screen, say) — the visual-validation
                                       # counterpart to --list/--children. WRITES assets/<id>_ref.png
                                       # (with --scale: assets/<id>_shot@<N>x.png)
                                       # (unlike --list/--children, which only print), but is still
                                       # cheap: it skips serialize() and the recursive asset walk, so
                                       # exportAsync on the node itself is the only cost. --scale
                                       # overrides the default (auto, capped at 2048px on the longest
                                       # side). Mirrors Figma's own get_screenshot tool (single-node,
                                       # called on demand) rather than pre-rendering every node.
  dtwin --list-libraries  # which design libraries this file draws on (local + enabled
                                       # team libraries), their variable collections, and how many
                                       # of their components this file USES. The discovery step
                                       # before a pull, exactly as --list is before --page.
                                       # Honest limits: Figma exposes NO API to enumerate a
                                       # library's full contents, so component counts are
                                       # USAGE-derived; and libraries can only be enabled in the
                                       # Figma UI (never via API), so an export is silently scoped
                                       # to whatever was enabled at export time. Empty results are
                                       # a NORMAL outcome (free plan / no library enabled), not a
                                       # failure — they are reported as such.
                                       # Requires the plugin manifest's "teamlibrary" permission:
                                       # RE-IMPORT/reload the plugin in Figma after updating, or a
                                       # stale plugin silently returns nothing.
  dtwin --whoami       # who is connected: plugin instance id, file name, whether
                                    # figma.fileKey is available, socket uptime, and how many times
                                    # a new connection displaced an earlier one — read from the
                                    # daemon when one holds the port, so the numbers are real
                                    # either way. The probe for
                                    # "can two Figma files use the bridge at once?" — run it from
                                    # each open file and compare instanceId. Costs nothing (no page
                                    # load, no node walk, no assets) and writes no files.
  --json               # machine output for the two that print a TABLE (--list-clients, --list-libraries).
                       # The others above already print JSON; there it is accepted as a no-op.
  These take NO read options (--css/--measurements/--plugin-data/--motion/--shared-data/
  --no-assets): they emit structural fields only, so those flags are refused rather than ignored.
  --timeout DOES apply to them — to the command AND to the wait for the plugin to connect
  (default: 10 min at a terminal, 90 s when stderr is not a TTY, e.g. run by an agent).

Speed:
  --no-assets      # skip the per-node SVG/PNG export pass (the dominant cost on a big file).
                   # Structure + tokens are unaffected; the manifest reports how many were skipped.

Keep the connection open (daemon):
  dtwin --serve          # hold the bridge open until stopped. Every command above then
                                      # routes through it automatically and skips the reconnect.
  dtwin --stop           # stop it
  dtwin --daemon-status  # is one running, and is the plugin connected?
  Only ONE process can hold port 8787 — while a daemon (or the MCP server) is up, a second bridge
  exits with EADDRINUSE. That is exactly what routing through the daemon avoids.

The bridge token (auth for the plugin -> bridge handshake). Generated once on the first bridge
start, saved to a per-user config file (0600), and reused forever after — so you paste it into the
plugin ONCE. These commands need no plugin and no bridge:
  dtwin --token-status   # where it lives, which source wins, its fingerprint — never the token
  dtwin --show-token     # print the token itself (stdout only, so \`| pbcopy\` works)
  dtwin --rotate-token   # replace it — you must then re-paste it into the plugin
  dtwin --forget-token   # delete it; the next bridge start mints a new one
  dtwin --token-file <p> # read the token from <p> for this run instead of the stored one
  Precedence: --token-file > FIGMA_BRIDGE_TOKEN > the saved file > mint a new one.
  There is no \`--token <value>\`: argv is world-readable via \`ps\`, so passing a secret there leaks
  it to every other user on the machine. Use --token-file, or the env var.

Port:
  The bridge listens on 8787. FIGMA_BRIDGE_PORT=8788|8789 runs it on another of the three ports the
  plugin tries, e.g. a second bridge beside the MCP server. There is no --port flag, and DTWIN_PORT is not read.

The Figma file must be open with the "Design Twin" plugin running.`;

function usageText(): string {
  return "dtwin — pull a design out of a running Figma file (Design Twin plugin) onto disk.\n\n" + USAGE;
}

const plog = (m: string) => console.error("[dtwin] " + m);
const writeJson = (dir: string, name: string, obj: unknown, quiet?: boolean) => OUT.writeJson(dir, name, obj, quiet, plog);
// hygiene.json persists every warning (see design-system-layout.ts), but writeJson's own log line is
// just "wrote design-system/hygiene.json" — a caller watching stderr would never see a DUPLICATE
// COMPONENT NAME or a variant-explosion warning without a separate JSON read. Echo them to stderr
// here so hygiene surfaces the same run it was produced in, not only on a later manual diff.
function printHygiene(r: { designSystem: { hygiene?: string[] } }): void {
  const hygiene = Array.isArray(r.designSystem.hygiene) ? r.designSystem.hygiene : [];
  if (!hygiene.length) return;
  plog(`hygiene (${hygiene.length}):`);
  for (const h of hygiene) console.error("  - " + h);
}

// Argument parsing is plain functions the test suite drives directly: readArgs reads the flags and
// throws UsageError for a bad or missing value, validateArgs returns the outDir warning and the first
// flag-combination refusal without printing, and parseArgs is the two in one call, throwing on a
// refusal. None calls process.exit — the CLI entry below turns errors into the message + exit 1.
// Untestable arg parsing is how `--timeout` shipped silently ignoring its own flag when the value was
// missing.
class UsageError extends Error {}

// ONE parser for every `--flag value` / `--flag=value` pair, repeatable by construction. One
// shared rule marks every consumed index in consumedIdx, so the positional [outDir] is never a flag's
// value (hand-rolled copies drifted into subtly different shapes, and `--timeout` once mishandled its own
// missing value). A further value flag is one line.
// Matching the flag EXACTLY (plus its `=` form) is part of the rule: startsWith("--timeout") would
// also swallow a future `--timeout-ms`, reading another flag's value as this one's.
// Returns [] when the flag is absent; throws UsageError when it's present with no value.
function takeValues(args: string[], flag: string, missingMsg: string, consumedIdx: Set<number>): string[] {
  const eq = flag + "=";
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue; // cannot happen: i < args.length
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

// Every flag there is (cli-commands.ts: the commands', then the modifiers'): what the unknown-flag check
// knows, in the order its did-you-mean breaks a tie in. VALUE_FLAGS are the ones that also take `--flag=value`.
const KNOWN_FLAGS: string[] = [
  ...COMMAND_ROWS.flatMap((r) => (r.flag === null || r.value ? [] : [r.flag])), ...MODIFIERS.filter((m) => !m.value).map((m) => m.flag),
  ...COMMAND_ROWS.flatMap((r) => (r.flag === null || !r.value ? [] : [r.flag])), ...MODIFIERS.filter((m) => m.value).map((m) => m.flag),
];
const VALUE_FLAGS: string[] = [...COMMAND_ROWS.flatMap((r) => (r.flag !== null && r.value ? [r.flag] : [])), ...MODIFIERS.filter((m) => m.value).map((m) => m.flag)];
const isValueModifier = (f: string): f is ValueModifier => (VALUE_MODIFIERS as readonly string[]).includes(f);

function readArgs(args: string[]) {
  // Value-taking flags (space form: `--flag value`) consume the NEXT token — that token must never be
  // mistaken for the positional [outDir] below. `consumedIdx` tracks every such value's index so
  // outDir detection can skip them, not just skip tokens that literally start with "--".
  const consumedIdx = new Set<number>();

  // --scale <n>: override collectReference's default (auto, capped at 2048px on the longest side). Only
  // meaningful paired with --screenshot — refused standalone, the same silent-loss class as a read
  // option combined with --list.
  const BAD_SCALE = "--scale expects a positive number";
  // A missing VALUE is distinct from a missing FLAG, and takeValues makes that structural: `--timeout`
  // with nothing after it (or another flag after it) throws here rather than leaving `undefined` for the
  // validator's own `!== undefined` guard to EXEMPT — which is how the flag once got silently ignored
  // and you got the default, the one outcome an explicit timeout exists to prevent, invisible until the
  // export died at a limit you thought you had raised.
  // One message for both failures (absent value, unusable value) so they cannot drift apart.
  // At most what one timer can hold: setTimeout runs a longer delay (and Infinity) after 1 ms
  // (nodejs.org/api/timers.html), so a request would time out at once; and a daemon frame cannot carry
  // Infinity at all (JSON writes it as null).
  const MAX_TIMEOUT_SEC = Math.floor(MAX_TIMER_MS / 1000);
  const BAD_TIMEOUT = `--timeout expects a positive number of seconds (at most ${MAX_TIMEOUT_SEC}, about 24 days)`;
  const MISSING: Record<ValueModifier, string> = {
    "--scale": BAD_SCALE,
    "--client": "--client needs a connection id, fileKey, or part of a file name (see --list-clients)",
    "--token-file": "--token-file needs a path to a file containing the token",
    "--timeout": BAD_TIMEOUT,
  };

  // Every value-taking flag, read in VALUE_READ_ORDER (cli-commands.ts: which of several missing values is
  // refused first). A value-taking command is typed when it has a value (takeValues refuses it with none);
  // a node id goes through node-id.ts's lenient toNodeId — the same inputs the MCP twins accept (bare id,
  // dash form, percent-encoded, nested-instance path, or a whole figma.com URL), and an id shape it does not
  // recognise passes through rather than becoming a hard failure. Only --page is repeatable (docker -e /
  // curl -H convention); ambiguous/unknown page selectors fail loudly plugin-side with the available pages
  // listed. A --as-library name is required rather than defaulted from figma.root.name: it is what the
  // output directory is named after, and a silent default is a directory the user did not choose.
  const values = new Map<CommandId, string[]>();
  const modifier = new Map<ValueModifier, string>();
  for (const f of VALUE_READ_ORDER) {
    const row = COMMAND_ROWS.find((r) => r.flag === f);
    if (row?.value) {
      const taken = takeValues(args, f, row.value.missing, consumedIdx);
      const v = (row.value.many ? taken : taken.slice(0, 1)).map((x) => (row.value?.nodeId ? toNodeId(x) : x));
      if (v.length) values.set(row.id, v);
    } else if (isValueModifier(f)) {
      const v = takeValues(args, f, MISSING[f], consumedIdx)[0];
      if (v === undefined) continue;
      modifier.set(f, v);
      if (f !== "--scale") continue;
      if (!(Number(v) > 0)) throw new UsageError(`${BAD_SCALE}, got '${v}'`);
      // Refused here while reading, not in validateArgs: this error comes before the outDir warning.
      if (!values.has("screenshot")) throw new UsageError("--scale only applies to --screenshot — pass both, or drop --scale.");
    }
  }
  const scaleArg = modifier.get("--scale");
  const scale = scaleArg !== undefined ? Number(scaleArg) : undefined;
  // --client: WHICH connected Figma file this command talks to. Unlike every command flag it is not a
  // scope or a read option — it is the ADDRESS, and it composes with all of them. Omit it and the
  // bridge uses the only connected file; with several connected it refuses and lists them rather than
  // guessing, so an export can never silently come from the wrong file. Accepts a connId (from
  // --list-clients), a fileKey, or part of the file's name. The connId (c1, c2, …) is a reconnect-order
  // LABEL for the current bridge lifetime, not a stable id across restarts — prefer the
  // file name or fileKey in a script; connId is fine for a human picking between two files open right now.
  const client = modifier.get("--client") || null;
  // --token-file <path>: read the bridge token from somewhere other than the stored default. A
  // MODIFIER (it changes which token every other command uses), not a command.
  //
  // There is deliberately NO `--token <value>` twin. Process arguments are world-readable — `ps aux`,
  // /proc/<pid>/cmdline — so a value flag would hand the secret to every other user on the machine for
  // as long as the command runs. A path is not a secret; the file it points at is.
  const tokenFile = modifier.get("--token-file") || null;

  // The commands typed, in the command table's order (cli-commands.ts) — the order a refusal names them in.
  // Matched EXACTLY (`includes`, or takeValues' flag and `=` form), so "--list-libraries" is not swallowed by
  // "--list" — the prefix trap takeValues() guards against.
  const given: CommandRow[] = COMMAND_ROWS.filter((r) => r.flag !== null && (r.value ? values.has(r.id) : args.includes(r.flag)));
  // The one command this line names, once the guards have passed (validateArgs); with none, a pull of the current page.
  const command = given[0] ?? DEFAULT_COMMAND;
  const valueOf = (id: CommandId): string | null => values.get(id)?.[0] ?? null;

  // --no-assets REMOVES work (every other flag adds it): skips the per-node exportAsync render pass,
  // which dominates the export on a real design-system file. Structure, layout and tokens are
  // unaffected — a skipped node stays the same LEAF the full export produces, marked
  // `assetSkipped: true` instead of carrying an `asset` path; only assets/ goes missing.
  // Flag -> option name comes from bridge/src/read-opts.ts, the ONE registry shared with the plugin's
  // run reads and the MCP tool schema. Building the table from it (rather than restating the six names
  // here) is what lets the guards name the offending flags without a second hand-written list —
  // a twin that would silently stop matching the moment a read option is added.
  const readOpts: Partial<Record<ReadOptName, boolean>> = {};
  const readOptFlagsGiven: string[] = [];
  for (const o of READ_OPTS) {
    readOpts[o.name] = args.includes(o.flag);
    if (readOpts[o.name]) readOptFlagsGiven.push(o.flag); // same predicate by construction, one walk
  }

  const timeoutArg = modifier.get("--timeout");
  const timeoutSec = Number(timeoutArg);
  if (timeoutArg !== undefined && !(timeoutSec > 0 && timeoutSec <= MAX_TIMEOUT_SEC)) throw new UsageError(`${BAD_TIMEOUT}, got '${timeoutArg}'`);
  // One override, applied to every budget below — spelling the `--timeout` conversion per budget is how
  // the list ops came to be missed by the flag in the first place. A read's own budget (by scope) is the
  // read plan's (read-plan.ts); `timeoutOverrideMs` is what it is handed, and absent without the flag.
  const overrideMs = timeoutSec > 0 ? timeoutSec * 1000 : undefined;
  const timeoutOverrideMs = overrideMs;
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
  // (`--lsit`, `--al-pages`) would match nothing and fall through to the default — a full pull that
  // then waits on the plugin: the wrong command, run silently. Same silent-loss class as the guards
  // below, one step earlier. Runs after every takeValues() call so a flag's VALUE is never judged.
  const OUT_FLAG_ALIASES = ["--out", "-o", "--output", "--out-dir", "--outdir", "--dir"];
  const unknown = args.filter((a, i) => a.startsWith("-") && a !== "-h" && !consumedIdx.has(i)
    && !KNOWN_FLAGS.includes(a) && !VALUE_FLAGS.some((f) => a.startsWith(f + "=")));
  if (unknown.length) {
    // `--out`/`-o`/`--output` are what people reach for to name where the file lands, and they are
    // too far (> 2 edits) from every real flag for the did-you-mean below to help. outDir is positional.
    const outLike = unknown.find((u) => OUT_FLAG_ALIASES.includes(u.split("=")[0] ?? u));
    if (outLike) {
      throw new UsageError(`unknown flag: ${outLike}. outDir is positional: \`dtwin screenshot <id> <outDir>\` (the PNG lands in <outDir>/assets/<id>_ref.png) or \`dtwin pull <outDir> --node <id>\`; there is no ${outLike.split("=")[0]} flag.`);
    }
    // "Did you mean": the nearest known flag by edit distance, offered only when it is a plausible typo.
    const hints = unknown.map((u) => {
      const eqAt = u.indexOf("=");
      const name = eqAt === -1 ? u : u.slice(0, eqAt); // u.split("=")[0]
      // The FIRST nearest flag in KNOWN_FLAGS order — what the stable `sort(...)[0]` picked. reduce()
      // without a seed needs a non-empty array; KNOWN_FLAGS is a non-empty literal list.
      const best = KNOWN_FLAGS.map((f) => [distance(name, f), f] as const).reduce((x, y) => (y[0] < x[0] ? y : x));
      return best[0] <= 2 ? `${u} (did you mean ${best[1]}?)` : u;
    });
    throw new UsageError(`unknown flag${unknown.length > 1 ? "s" : ""}: ${hints.join(", ")}. Run dtwin --help for the full list.`);
  }

  // The positional [outDir] — the first token that's neither a `--flag` nor a value a flag above already
  // claimed. Doing this AFTER parsing every value-taking flag is what keeps e.g. `--children 131:1879`
  // (no outDir given) from being misread as `outDir = "131:1879"`.
  // Default: design/export — dtwin writes only there, so `rm -rf design/export && re-pull` cannot take
  // the component map, the plan or the audit with it. A project created under the older flat layout
  // keeps working: its export is still found (bridge/src/project-layout.ts findExportDir).
  const userOutDir = args.find((a, i) => !a.startsWith("--") && !consumedIdx.has(i));
  const outDir = userOutDir ||
    (LAYOUT.findExportDir(process.cwd()).layout === "legacy-flat" ? LAYOUT.DESIGN_DIR : LAYOUT.EXPORT_DIR);

  const json = args.includes("--json");
  // --list is pages + their top-level layers; --list-pages is depth 1, page names only (no page load).
  const listDepth: 1 | 2 = command.id === "listPages" ? 1 : 2;

  return {
    command, given, readOpts, readOptFlagsGiven,
    // Each value-taking command's value (null, or [] for --page, when it was not typed).
    nodeId: valueOf("node"), childrenId: valueOf("children"), screenshotId: valueOf("screenshot"), asLibrary: valueOf("asLibrary"), pageSel: values.get("page") ?? [],
    allPages: given.some((r) => r.id === "allPages"),
    listDepth,
    scale, client, tokenFile, json, timeoutOverrideMs, listTimeoutMs, connectWaitMs, outDir, userOutDir,
  };
}

export type ParsedArgs = ReturnType<typeof readArgs>;

// `dtwin pull design --node <id>` is the outDir trap — `design` is a valid, deliberate
// positional outDir (never special-cased; see the note above), but when the project ALREADY has a
// design/export/ tree, writing into `design` too creates a SECOND, parallel export tree that every
// other command (doctor, cross-check, audit, build-screen) keeps ignoring. Warn, don't refuse — a
// project genuinely named "design" for something else is legitimate, and refusing would be the parser
// getting magic about one string.
// Returns the warning text (the caller prints it as `[dtwin] warn: …`), or null.
function outDirWarning(userOutDir: string | undefined, exists: (p: string) => boolean): string | null {
  if (!userOutDir) return null;
  const requested = path.resolve(process.cwd(), userOutDir);
  if (!exists(path.join(requested, "export"))) return null;
  return `${userOutDir} already contains ${path.join(userOutDir, "export")} — writing here too creates a` +
    ` PARALLEL export tree that doctor/cross-check/audit/build-screen do not read. You almost certainly want` +
    ` \`dtwin pull ${userOutDir === "design" ? "" : userOutDir + "/export "}...\` (drop the outDir to use the default` +
    ` design/export, or pass the export dir itself) instead of writing into ${userOutDir}.`;
}

// The read a command names, as the read plan's scope (cli-commands.ts `reads`, with the values typed for it).
function scopeOf(row: CommandRow, p: ParsedArgs): ReadScope {
  switch (row.reads) {
    case "screenshot": return { kind: "screenshot", nodeId: p.screenshotId ?? "", scale: p.scale };
    case "library": return { kind: "library", name: p.asLibrary ?? "" };
    case "node": return { kind: "node", nodeId: p.nodeId ?? "" };
    case "selection": return { kind: "selection" };
    case "designSystem": return { kind: "designSystem" };
    // A command that reads nothing has no scope; it is asked only for one that reads (cliReadPlan, refusedReadOpts).
    case "pages": case null: return { kind: "pages", allPages: p.allPages, pages: p.pageSel };
  }
}

// What this command line SENDS for its read (read-plan.ts — the same plan the MCP export tools send), with
// --timeout as its budget; null for a command that reads no design (an index, daemon or token command).
function cliReadPlan(p: ParsedArgs): ReadPlan | ReadRefusal | null {
  if (p.command.reads === null) return null;
  return planRead(scopeOf(p.command, p), p.readOpts, { timeoutMs: p.timeoutOverrideMs });
}

// The read options given that a command does not take, as their flags: every one for a command that reads
// no design; otherwise the ones its read plan refuses (read-opts.ts `scopes`).
function refusedReadOpts(row: CommandRow, p: ParsedArgs): string[] {
  if (row.reads === null) return p.readOptFlagsGiven;
  const plan = planRead(scopeOf(row, p), p.readOpts);
  return "refused" in plan ? READ_OPTS.filter((o) => plan.refused.includes(o.name)).map((o) => o.flag) : [];
}

// The combination guards: the first refusal's message, or null when the flags make one command. Every
// rule is a GUARDS row (cli-commands.ts), asked in its order: two commands of one family, a command beside
// another family's (or beside read options), the read options a command's read does not take, and the two
// modifiers only some commands take. Each refusal exists because the alternative is SILENT loss — one of
// the two things typed would run, and the other would vanish without a word.
function argConflict(p: ParsedArgs): string | null {
  const flag = (r: CommandRow): string => r.flag ?? "";
  const typed = (f: Family | "readOpts"): string[] => (f === "readOpts" ? p.readOptFlagsGiven : p.given.filter((r) => r.family === f).map(flag));
  for (const g of GUARDS) {
    if (g.kind === "json") {
      if (p.json && !p.given.some((r) => r.family === "index")) return g.say();
      continue;
    }
    if (g.kind === "tokenFile") {
      const cmd = p.given.find((r) => r.family === "token");
      if (p.tokenFile && cmd && g.ignoredBy.includes(cmd.id)) return g.say(flag(cmd));
      continue;
    }
    const mine = p.given.filter((r) => r.family === g.family);
    const cmd = mine[0];
    if (!cmd) continue;
    if (g.kind === "within") {
      if (mine.length > 1) return g.say(mine.map(flag));
    } else if (g.kind === "cross") {
      const others = g.others.flatMap(typed);
      if (others.length) return g.say(flag(cmd), others);
    } else {
      const refused = refusedReadOpts(cmd, p);
      if (refused.length) return g.say(cmd, refused);
    }
  }
  return null;
}

// Everything the CLI says about a parsed command line before running it: warnings to print (each as
// `[dtwin] warn: …`, in order) and the refusal, if any (printed as `[dtwin] error: …`, exit 1, after the
// warnings). Nothing is printed here; `exists` is the filesystem probe for the outDir trap.
function validateArgs(p: ParsedArgs, exists: (p: string) => boolean = fs.existsSync): { warnings: string[]; error: string | null } {
  const trap = outDirWarning(p.userOutDir, exists);
  return { warnings: trap ? [trap] : [], error: argConflict(p) };
}

// readArgs + the combination guards, throwing the refusal as a UsageError: the one-call form the test
// suites drive. Warnings are not computed here — cli() prints them from validateArgs.
function parseArgs(args: string[]): ParsedArgs {
  const parsed = readArgs(args);
  const error = argConflict(parsed);
  if (error) throw new UsageError(error);
  return parsed;
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
/** A client row as formatClients reads it: every non-null object (each field is optional and checked where read). */
function isClientRowLike(x: unknown): x is Partial<ClientRow> {
  return typeof x === "object" && x !== null;
}
function formatClients(rows: unknown): string {
  // Rows from this process's own bridge, or relayed by a daemon (possibly an older one — see the
  // daemon-staleness note below), or hand-built by the test suite: every field is optional here.
  const list: Array<Partial<ClientRow>> = isUnknownArray(rows) ? rows.filter(isClientRowLike) : [];
  const first = list[0];
  if (first === undefined) {
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
    // A version per row, so a stale plugin bundle is visible right where the user is
    // already looking to pick a file — not just buried in a separate `dtwin doctor` run. No version at
    // all is itself the signal (a plugin bundle that predates version reporting, or a `dtwin serve` daemon old enough that its
    // own `describe()` never learned to relay one) — named explicitly rather than a bare "unknown",
    // which read as "couldn't be determined" instead of "definitely predates this".
    if (c.identified) bits.push("plugin v" + (c.pluginVersion || "unknown (pre-versioning)"));
    lines.push("        " + bits.join(" · "));
    if (c.pluginStale) lines.push("        ! " + c.pluginStale);
    const daemonStale = daemonRowStalenessNote(c);
    if (daemonStale) lines.push("        ! " + daemonStale);
  }
  lines.push("");
  lines.push("Address one with --client <connId | fileKey | part of the file name>, e.g. --client " +
    (first.file ? JSON.stringify(first.file.split(/\s+/)[0]) : first.connId) + ".");
  lines.push("Note: c1/c2 are reconnect-order LABELS for this bridge's current lifetime, not stable ids —" +
    " a restart without `dtwin serve` can hand a different file the same label next time. Prefer the" +
    " file name or fileKey when you script this.");
  return lines.join("\n");
}

/** The renderer tolerates gaps (`--json` fixtures, older plugins): every row field is read as optional. */
type LibraryRowView = Partial<ListLibrariesReply["libraries"][number]>;

function formatLibraries(r: { libraries?: LibraryRowView[]; warnings?: string[] } | null | undefined): string {
  const libs = (r && r.libraries) || [];
  const lines: string[] = [];
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
  const w = (k: keyof typeof head) => Math.max(head[k].length, ...rows.map((x) => x[k].length));
  const wk = w("kind"), wn = w("name"), wc = w("collections"), wv = w("variables");
  const line = (x: Record<keyof typeof head, string>) => `  ${x.kind.padEnd(wk)}  ${x.name.padEnd(wn)}  ${x.collections.padStart(wc)}  ${x.variables.padStart(wv)}  ${x.components}`;
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

// Every layer an index reply lists: a listPages reply's top-level layers across its pages (under
// pages[].frames — empty at depth 1), or a listChildren reply's direct children. One walk for both, so
// the per-type breakdown and the SECTION hint below work for `dtwin list children` too.
const topLevelLayers = (r: ListPagesReply | ListChildrenReply): NodeSummary[] =>
  "pages" in r ? r.pages.flatMap((p) => p.frames ?? []) : r.children;

// The closing line of an export — where the time went. A direct pull opens a fresh bridge and waits
// out the plugin's reconnect (a retry timer walking three ports, slower still in a background window),
// which measured 27 s against an export of under 3 s; naming the wait is what makes that visible, and `dtwin serve` is the fix.
// `connectMs` is the own-bridge wait for the plugin (0 / ignored behind a daemon, which waits inside the request).
const CONNECT_HINT_MS = 5000;
const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";
function formatDone(t: { totalMs: number; connectMs: number; exportMs: number; writeMs: number; viaDaemon: boolean }): string[] {
  // Behind a daemon whose plugin is not connected yet, the daemon waits INSIDE the request, so that wait is
  // part of the export figure: the line says so instead of claiming there was no reconnect.
  const wait = t.viaDaemon ? "via the running daemon" : `waited ${secs(t.connectMs)} for the plugin to connect`;
  const exp = t.viaDaemon ? "export (incl. any wait for the plugin)" : "export";
  const lines = [`done in ${secs(t.totalMs)} — ${wait} · ${exp} ${secs(t.exportMs)} · write ${secs(t.writeMs)}`];
  if (!t.viaDaemon && t.connectMs >= CONNECT_HINT_MS) {
    lines.push("the wait was the plugin reconnecting to this fresh bridge (it retries every second, one port at a time, and slower in a background window)" +
      " — `dtwin serve` in another terminal keeps one bridge open, so the next command skips it.");
  }
  return lines;
}

// ---- token lifecycle commands: they touch only the local token file (no bridge, no daemon, no plugin).

function tokenStatus(): void {
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
}

function showToken(settings: BridgeSettings): void {
  if (!settings.token.ok) throw settings.token.error;
  const { token, source } = settings.token.resolved;
  // stdout, alone, so it pipes: `dtwin --show-token | pbcopy`. Every note goes to stderr.
  console.log(token);
  if (source === "ephemeral") {
    console.error("[dtwin] note: nothing is saved yet, so this token is NOT what a future run will use. Start a bridge once to save one.");
  }
}

// A running daemon keeps the token it started with: its plugin connection, and on Windows the pipe it is
// named and found by (daemon.ts daemonAddress). Replaced or deleted from under it, it would hold the port while no
// later command could find it any more — each would then fail on the held port. So it is stopped FIRST,
// while the old token still finds it. Not when an env token or token file is what the bridge actually uses:
// the stored file changing then changes nothing for it (the env token as token-store reads it: trimmed).
// Every allowed port, not just FIGMA_BRIDGE_PORT's: the saved token is shared by all three, so a daemon
// another shell started on 8788 would be stranded the same way.
async function stopDaemonForTokenChange(settings: BridgeSettings): Promise<void> {
  if (tokenOverridden(settings.token)) return;
  for (const port of ALLOWED_PORTS) {
    const at = daemonAddressOf(settings, port);
    // Looked up first (status: creates nothing), so a token command never makes a socket directory.
    if (!(await daemon.status(at).catch(() => null))) continue;
    let stopped = false;
    try { stopped = await daemon.stop(at); } catch { /* a refused socket location: no daemon of ours is there */ }
    if (stopped) console.error(`[dtwin] stopped the running daemon on port ${port} first — it was using the old token. Start it again with \`dtwin serve\`.`);
  }
}

async function rotateToken(settings: BridgeSettings): Promise<void> {
  await stopDaemonForTokenChange(settings);
  const had = tokenStore.readFrom(tokenStore.tokenPath());
  const token = tokenStore.generate();
  const file = tokenStore.write(token);
  console.log(token);
  console.error(`[dtwin] ${had ? "replaced" : "saved"} the bridge token in ${file}.`);
  // The whole point of naming this: the plugin has the OLD token in clientStorage and will
  // fail every handshake, retrying on its own, until someone re-pastes.
  console.error('[dtwin] re-paste it into the plugin\'s "Bridge token" field and press Save — until you do, the plugin cannot connect.');
  if (settings.token.ok && settings.token.resolved.source === "env") {
    console.error("[dtwin] warning: FIGMA_BRIDGE_TOKEN is set and OVERRIDES this file, so the bridge will keep using the env value. Unset it for the rotation to take effect.");
  }
}

async function forgetToken(settings: BridgeSettings): Promise<void> {
  await stopDaemonForTokenChange(settings);
  const file = tokenStore.tokenPath();
  const removed = tokenStore.remove(file);
  console.error("[dtwin] " + (removed ? `deleted ${file}. The next bridge start mints and saves a new token.` : `nothing to delete — no token saved at ${file}.`));
}

// ---- daemon lifecycle commands. Each owns the whole invocation.

async function stopDaemon(settings: BridgeSettings): Promise<void> {
  const at = daemonAddressOf(settings);
  const stopped = await daemon.stop(at);
  // Nothing at the current location: a daemon an earlier build started (before an upgrade) still
  // listens at the old one, and is what holds the port.
  const old = stopped ? null : await daemon.stopLegacy(at);
  console.error("[dtwin] " + (stopped ? "daemon stopped." : old ? `stopped a daemon started by an earlier dtwin version (socket ${old}).` : "no daemon is running."));
}

async function daemonStatus(settings: BridgeSettings): Promise<void> {
  const st = await daemon.status(daemonAddressOf(settings));
  console.log(JSON.stringify(st || { daemon: false }, null, 2));
  // Fields an OLDER daemon may not report (daemon.ts DaemonStatusView) print as "?", never as a guess.
  console.error("[dtwin] " + (st
    ? `daemon up (pid ${st.pid ?? "?"}, port ${st.port ?? "?"}) — plugin ${st.pluginConnected ? "CONNECTED" : "not connected"}` +
      (st.idleMs ? `, idle ${humanMs(st.idleForMs ?? 0)}/${humanMs(st.idleMs)} before auto-shutdown.` : ", no idle shutdown.")
    : "no daemon is running — start one with --serve."));
}

// `dtwin serve`: the bridge holder's "serve" lifetime (bridge-holder.ts) — refused when a daemon already runs (naming
// --stop), then this process's bridge, published on the daemon socket with the settings' idle window.
async function serveDaemon(settings: BridgeSettings): Promise<void> {
  const holder = bridgeHolder("serve", { settings, createBridge, daemon: daemonSide, log: (m) => console.error("[dtwin] " + m) });
  const up = await holder.upstream();
  const h = holder.held();
  console.error("[dtwin] bridge listening on " + up.address + " — socket " + (h.kind === "own" ? h.sock ?? "?" : "?"));
  console.error('[dtwin] Open your Figma file and run "Design Twin" (it auto-connects).');
  console.error("[dtwin] The connection stays open until you run --stop (or Ctrl-C here).");
  const idleMs = settings.idleMs; // the ONE rule the served socket uses (an unparsable value disables it)
  console.error("[dtwin] " + (idleMs > 0
    ? `It also shuts down after ${humanMs(idleMs)} idle, so an abandoned daemon can't hold port 8787 forever (FIGMA_DAEMON_IDLE_MIN=0 disables).`
    : "Idle shutdown is DISABLED — remember to --stop it, or it holds port 8787 until you do."));
  // the socket + WS server keep the event loop alive; no close() here, by design
}

// Typed per command (commands.ts). Every send also answers WHICH connected Figma file the bridge
// routed the command to — the client resolveClient() picked for --client, described as `dtwin list
// clients` would — so a screen export can be stamped with its real source without this
// file re-implementing the bridge's matching rules. `client` is null only from a daemon older than
// that field.
// A read is not sent this way: it runs through Session.read, which stamps it before anything can write it.
type Send = <C extends Exclude<Cmd, ReadCmd>>(cmd: C, args: Commands[C]["args"], timeoutMs: number) => Promise<Sent<C>>;

// What every ordinary command runs on: where its requests go (a running daemon, or a bridge of its own),
// and the timing and shutdown helpers the commands share.
interface Session {
  /** Where requests, the client listing and the socket stats come from (route.ts). */
  route: Route;
  /** A command that reads no design (whoami, an index listing), timed for the closing `done in …` line. */
  send: Send;
  /** A read plan, run (read-run.ts): stamped, its request and its write timed for the closing `done in …` line. */
  read: <C extends ReadCmd>(plan: PlanOf<C>) => Promise<ReadRun<C>>;
  doneLine: () => string[];
  /** Closes this process's bridge, if it has one. */
  finish: () => void;
}

// ---- ordinary commands. Route through a running daemon when there is one: it already holds the
// bridge (and port 8787), so opening our own here would hit EADDRINUSE and exit. When there is no
// daemon this is exactly the one-shot path it always was.
async function openSession(parsed: ParsedArgs, settings: BridgeSettings): Promise<Session> {
  const { command, client, connectWaitMs } = parsed;
  // Timing (see `doneLine` below): the clock starts before the daemon probe.
  const tStart = Date.now();
  const timing = { connectMs: 0, exportMs: 0, writeMs: 0 };
  // DTWIN_TIMINGS (timings.ts): the same split plus plugin phase arrival, payload size and peak RSS, as one JSON record
  const timingsTo = timingsTarget();
  const clock = timingsTo ? stageClock() : null;
  // Where requests go: the running daemon, or a bridge of our own for this command only — the bridge holder's
  // "one-shot" lifetime (bridge-holder.ts). Never shared: a process that finds the port held exits on it.
  const holder = bridgeHolder("one-shot", { settings, createBridge, daemon: daemonSide, log: (m) => console.error("[dtwin] " + m) });
  const up = await holder.upstream();
  const viaDaemon = up.kind === "daemon";
  if (viaDaemon) console.error("[dtwin] using the running daemon (" + up.address + ") — no reconnect needed.");

  // outDir is created lazily by each writer (writeExport/writeScreen/writeScreenshot all
  // fs.mkdirSync(dir, {recursive:true}) themselves) rather than eagerly here. Creating it up front —
  // before the client was even resolved — would let a command that fails on the multi-client check (or any
  // other pre-export validation) leave a stray empty outDir behind: `dtwin
  // nonexistent` with two clients connected exited 1 on "say which one to use" and left `./nonexistent/`
  // on disk. `--list`/`--children` never write outDir at all, so they need no mkdir either way.

  // An export-class command is the one shape a stalled one-shot pull hits: a pull or a screenshot — never
  // an index command (cli-commands.ts FAMILIES `writes`), which is cheap and already excluded from the
  // mkdir guard above for the same reason. Only these get the upfront no-daemon warning and the stall check.
  const isExportCmd = FAMILIES[command.family].writes;
  // Without `dtwin serve`, every pull opens a throwaway bridge and the plugin's
  // reconnect is what actually costs the time (measured 300s/908s vs 7.5-8.8s with a daemon warm).
  // Said up front, before anything is sent, not just diagnosed after the fact by `dtwin doctor`.
  if (!viaDaemon && isExportCmd) {
    console.error("[dtwin] no `dtwin serve` daemon is running — this pull opens its own bridge and waits out the plugin's full reconnect, which can take minutes on a cold connection. Run `dtwin serve` in another terminal for a fast, reliable connection.");
  }
  // The plugin sends a `queued` progress frame when this command waits behind another run in the
  // same file (a `start` frame when it begins — never worth a line). Say so once, so a silent wait is
  // not mistaken for a hang; --timeout still bounds it.
  const onQueued = (): void => console.error("[dtwin] queued behind another export in that file — waiting (up to --timeout)");

  // The route (route.ts) owns the rules either way — the connect window (`--timeout`; a named --client waits at least NAMED_CLIENT_WAIT_MS), the stall
  // check (own bridge, export commands: if NOTHING is heard back within FIGMA_BRIDGE_STALL_MS of sending, abort
  // rather than sit out the full export timeout), the "no plugin ever connected" error, and which commands
  // hear progress ticks.
  // Through a daemon, the DAEMON does the waiting: the plugin may not have reconnected yet after a Figma restart,
  // and the daemon is the side holding the socket. Each request carries the connect window, and an export's
  // progress frames re-arm the outer guard (daemonGuardMs), so a long walk that is still reporting is not cut off
  // by a budget sized for silence — the daemon's own per-command `timeoutMs` still bounds it.
  if (!viaDaemon) {
    console.error("[dtwin] listening on " + up.address);
    console.error('[dtwin] Open your Figma file and run "Design Twin" (it auto-connects)…');
    console.error("[dtwin] tip: --serve keeps this connection open so later pulls skip the reconnect.");
  }
  const route = createRoute(async () => up, { connectWaitMs, oneShot: true });
  // Our own bridge spends the connect window here, once, before anything is sent — timed for the done line.
  // --list-clients IS meaningful with nothing ever connecting ("which files can I talk to?" → "none, open
  // one"), but with no daemon running it is talking to a bridge it JUST opened, and every plugin window
  // currently open in Figma is mid-reconnect to it (timeouts.ts PLUGIN_REDIAL_MS) — so it waits too, and a
  // window with no plugin is its legitimate empty answer. A command instead fails on its first request with
  // the never-connected text (route.ts). The wait (server-core awaitClient) covers the target too: a named
  // one gets more time once a plugin is connected, and with no target or a file name the fresh bridge
  // settles first (timeouts.ts SETTLE_MS), so a second open file a redial behind is connected — and the
  // command refused as ambiguous, or listed — instead of the first file to land being taken silently.
  // No plugin in the whole window fails here (route.ts), so no command prints "plugin connected — …" first; the
  // clients listing alone answers "none".
  timing.connectMs = (await route.connect(client, { listing: command.id === "listClients" })).waitedMs;
  // Where the time went, for the closing `done in …` line. The connect wait is measured above
  // (own bridge only — a daemon does its waiting inside the request), the export is the time inside
  // every request, the write is every write-out (read-run.ts adds both to `timing`). All measured from
  // this side: nothing in server-core.
  const metering = { meter: clock, tally: timing };
  const send: Send = async (cmd, args, timeoutMs) => (await meteredRequest(() => route.request(cmd, args, { timeoutMs, target: client }), metering)).sent;
  const read = <C extends ReadCmd>(plan: PlanOf<C>): Promise<ReadRun<C>> => runRead(route, plan, { ...metering, target: client, onQueued });
  // Every command that prints the done line calls this once, at its end — so it is also where the opt-in record goes
  const doneLine = () => {
    if (clock && timingsTo) emitTimings(clock.record({ command: command.id, viaDaemon, ...timing }), timingsTo);
    return formatDone({ totalMs: Date.now() - tStart, ...timing, viaDaemon });
  };
  // With a daemon there is no bridge of ours to close, and closing the DAEMON's would be wrong — the holder knows
  // which, so no exit path below has to.
  const finish = () => { holder.release(); };
  return { route, send, read, doneLine, finish };
}

// Which Figma files are connected right now. Prints a table for a human (and for an agent skimming
// a terminal); the connId in the first column is what --client takes. Deliberately does NOT talk to
// the plugin at all — the answer lives entirely in the bridge, so this works even while every
// connected file is busy with a long export.
async function listClientsCmd({ route, finish }: Session, json: boolean): Promise<void> {
  const rows = await route.listClients();
  console.log(json ? JSON.stringify({ clients: rows }, null, 2) : formatClients(rows));
  if (rows.length > 1) {
    console.error("[dtwin] " + rows.length + " files connected — pass --client <id|fileKey|name> " +
      "to pick one, or commands that need a target will refuse rather than guess.");
  }
  finish();
}

// The identity/liveness probe. Prints BOTH halves: what the plugin says it is, and what the socket
// did. Run it in each of two open files (a second terminal, or twice in a row after switching the
// focused file) and compare — the interpretation notes below are printed with the result so the
// reading does not depend on remembering what each field means.
async function whoamiCmd({ route, send, finish }: Session): Promise<void> {
  const { reply: r, client: whoamiClient } = await send("whoami", {}, TIMEOUTS.command);
  // The socket half comes from whoever holds the bridge (route.ts): this process, or — with a daemon in
  // front — the daemon, rather than emitting `connection: null` under a help text that promises socket
  // uptime and takeovers. The socket described is the ADDRESSED file's (the client send() routed to), not
  // whichever connection happens to be first — with two files open `--client <name>` would print the other's.
  const addressed = whoamiClient ? whoamiClient.connId : null;
  const { connection: conn, owner } = await route.connectionInfo(addressed).catch(() => ({ connection: null, owner: null }));
  const connFrom = !conn || !owner ? null : owner.kind === "own" ? "this process" : `the daemon (pid ${owner.pid ?? "?"})`;
  console.log(JSON.stringify({ plugin: r, connection: conn, connectionFrom: connFrom || undefined }, null, 2));
  console.error("[dtwin] plugin instance " + r.instanceId + " — file " + JSON.stringify(r.file) +
    ", up " + Math.round(r.uptimeMs / 1000) + "s.");
  // Printed even when nothing is stale, so "no version at all" (an old bundle that
  // predates this field) is visibly different from "version reported, and it's current".
  console.error("[dtwin] plugin version: " + (r.pluginVersion || "unknown (older bundle — predates version reporting)"));
  const stale = pluginStalenessNote(r.pluginVersion);
  if (stale) console.error("[dtwin] ! " + stale);
  console.error("[dtwin] edits: " + (r.editsAllowed === true
    ? "ALLOWED — the designer ticked 'Allow edits' in the plugin window; figma_write can change this file"
    : r.editsAllowed === false
      ? "off — the plugin refuses every write until the designer ticks 'Allow edits' in the plugin window (reads are unaffected)"
      : "unknown (older bundle — predates the 'Allow edits' opt-in, and applies every write)"));
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
  finish();
}

// The library discovery command. Same cost/budget tier as the two below (cheap relative to an
// export) and the same "print, never write outDir" contract — but its own branch, because it
// prints a TABLE rather than the JSON id-catalogue those two exist to hand you.
async function listLibrariesCmd({ send, finish }: Session, json: boolean, listTimeoutMs: number): Promise<void> {
  console.error("[dtwin] plugin connected — listing libraries…");
  const { reply: r } = await send("listLibraries", {}, listTimeoutMs);
  // Plugin-side warnings first, on stderr, so they survive a `| less` of stdout and can never be
  // mistaken for part of the table.
  for (const w of r.warnings) console.error("[dtwin] warn  " + w);
  console.log(json ? JSON.stringify(r, null, 2) : formatLibraries(r));
  console.error("[dtwin] next: dtwin --list   then   --page <id>   (pull only the pages you need)");
  finish(); // see the close()-not-exit note below
}

// The two cheap index commands. --list is the file-wide map (consult it to pick a target, THEN
// deep-pull just that one); --children <id> is its node-scoped twin, for peeking inside a frame
// --list surfaced. Both PRINT to stdout and never write outDir — a decision aid, not a build input —
// and both share the same warn/print/hint/shutdown tail, so only the command differs.
async function listIndexCmd({ send, finish }: Session, childrenId: string | null, listDepth: 1 | 2, listTimeoutMs: number): Promise<void> {
  console.error("[dtwin] plugin connected — " + (childrenId ? "listing children of " + childrenId : "listing structure") + "…");
  const r: ListPagesReply | ListChildrenReply = childrenId
    ? (await send("listChildren", { nodeId: childrenId }, listTimeoutMs)).reply
    : (await send("listPages", { depth: listDepth }, listTimeoutMs)).reply;
  for (const w of r.manifest.warnings) console.error("[dtwin] warn  " + w);
  console.log(JSON.stringify(r, null, 2));
  // "top-level frame(s)" was a lie on every real file: the array holds SECTION, GROUP, INSTANCE,
  // TEXT and RECTANGLE too, and on a sectioned file the actual screens are one level deeper.
  // Say "layer", which is Figma's own word for any object, and break the count down
  // so "deep-pull next" points somewhere real — for a children listing as much as for the page map.
  const byType: Record<string, number> = {};
  for (const f of topLevelLayers(r)) byType[f.type] = (byType[f.type] || 0) + 1;
  const kinds = Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(", ");
  const summary = "children" in r
    ? `${r.children.length} direct child(ren) of "${r.name}" (${r.type})${kinds ? ` — ${kinds}` : ""}.`
    : `${r.manifest.pages} page(s)${r.manifest.frames === undefined ? "" : `, ${r.manifest.frames} top-level layer(s)`} in "${r.file}"${kinds ? ` — ${kinds}` : ""}.`;
  console.error("[dtwin] " + summary);
  // A SECTION is a container, not a screen — pulling one deep-serializes every screen inside it.
  // On the file this was found on, the sections were 8898-35975px wide.
  if (topLevelLayers(r).some((f) => f.type === "SECTION")) {
    console.error("[dtwin] note: some top-level layers are SECTIONs — containers, not screens. The screens are INSIDE them:");
    console.error("[dtwin]       dtwin list children <section id>   then pull the frame you want.");
  }
  console.error("[dtwin] next: dtwin pull --page <id>   (repeatable; add --no-assets to skip the render pass)");
  console.error("[dtwin]       or: dtwin pull --node <id>   (just ONE node, fully exported with its own assets)");
  console.error("[dtwin]       unsure which of two same-named frames? dtwin screenshot <id> renders one cheaply.");
  // The WS server keeps the event loop alive, so without an explicit shutdown these commands hung
  // forever after printing (found live: still resident and holding port 8787 a minute later,
  // blocking every subsequent pull). close() rather than process.exit(0) — same effect on the hang,
  // without truncating the JSON these commands exist to print. See close() in server-core.ts.
  finish();
}

// --screenshot: one node's reference PNG, on demand — the visual-validation counterpart to --list/
// --children above. Cheap next to a full export (skips serialize() and the recursive asset walk —
// see collectScreenshot's comment in collect.ts) but it DOES write a file, unlike the two commands
// it sits next to, so it gets its own branch rather than joining their print-only one.
async function screenshotCmd({ read, doneLine, finish }: Session, plan: PlanOf<"screenshot">, outDir: string): Promise<void> {
  console.error("[dtwin] plugin connected — rendering a reference screenshot…");
  const run = await read(plan);
  const r = run.reply;
  for (const w of r.manifest.warnings) console.error("[dtwin] warn  " + w);
  // Print the path writeScreenshot actually wrote, not the plugin's own relative `reference`
  // string: those can disagree, and a printed path that
  // finds nothing is worse than no path at all.
  const scale = plan.args.scale;
  const shot = run.write((stamped) => OUT.writeAny(outDir, stamped, plog, { scale }));
  const ref = shot.reference || r.reference;
  if (!ref) throw new Error(`the plugin rendered ${r.name} (${r.type}) but named no reference file — nothing was written`);
  // The node's size, the render scale and the PNG's own pixel size. Each is omitted when its
  // source did not send it (an older plugin has no w/h/scale; png needs PNG bytes).
  console.log(JSON.stringify({
    id: r.id, name: r.name, type: r.type,
    ...ifDefined("w", r.w), ...ifDefined("h", r.h), ...ifDefined("scale", r.scale), ...ifDefined("png", shot.png),
    reference: ref,
  }, null, 2));
  console.error(`[dtwin] wrote ${path.join(outDir, ref)} — ${r.name} (${r.type}).`);
  for (const l of doneLine()) console.error("[dtwin] " + l);
  finish();
}

// A pull: one node, the selection, a library catalog, the design system alone, or pages — written to outDir.
async function exportCmd({ read, doneLine, finish }: Session, plan: Exclude<ReadPlan, PlanOf<"screenshot">>, parsed: ParsedArgs): Promise<void> {
  const { allPages, outDir } = parsed;
  // Measured: --all-pages did not finish in 15 minutes on a real 25-page/119-frame file, even with
  // --no-assets. Kept (it's slow, not unsafe — and it's fine on small files) but it should not be the
  // path anyone reaches for by default, so say so up front rather than after a quarter-hour.
  if (allPages) {
    console.error("[dtwin] note: --all-pages deep-serializes EVERY frame on EVERY page and can exceed 15 min on a large file.");
    console.error("[dtwin]       prefer: --list  then  --page <id>   (repeatable, e.g. --page 1:2 --page 3:4)");
  }
  console.error(`[dtwin] plugin connected — pulling ${plan.label}… (timeout ${Math.round(plan.timeout / 1000)}s)`);

  // WHICH connected Figma file this pull talked to — the client the bridge's own
  // resolveClient() picked for --client, handed back with the reply (server-core request;
  // a daemon relays it). A screen export result has no field of its own naming its source file
  // (unlike design-system.json / a library catalog, which the plugin itself stamps), so `doctor` could
  // only ever report whichever file's export happened to sort first, attributing every screen to it.
  // Stamped onto the result by the read run (read-run.ts) before write-out.ts sees it, which persists it onto
  // the screen JSON and its index row. Unstamped (never guessed) when a daemon too old to relay the client
  // answered. A catalog's writers never read it.
  const run = await read(plan);
  // The SAME writer the MCP export tools use (write-out.ts's writeAny), so a CLI pull and an MCP pull of
  // the same read land in identical shape: a screen (--node / --selection) through writeScreen, a library
  // catalog (routed on the plugin's own `source.role`, under libraries/<slug>-<fileKey8>/ — it can never
  // overwrite design-system/), the design system alone or a page walk through writeExport's split. The
  // limited-library-variables note of a --design-system pull rides in designSystem.hygiene (see collect.ts),
  // which writeDesignSystem persists to hygiene.json.
  run.write((r) => OUT.writeAny(outDir, r, plog));
  if ("designSystem" in run.reply) printHygiene(run.reply);

  for (const l of doneLine()) console.error("[dtwin] " + l);
  finish(); // NOT process.exit — see close() in server-core.ts (a daemon-routed run has nothing to close)
}

// Each command's runner, keyed by its id in the command table (cli-commands.ts) and typed by it: a row
// without a runner, or a runner on the wrong side of the session line, does not compile.
// The token and daemon commands run WITHOUT a session: they need no plugin (the token ones touch only the
// local token file), and opening one would be wrong — the token commands must still work while a daemon
// holds the port.
type Sessionless = CommandIdIn<Exclude<Family, SessionFamily>>;
const RUN_SESSIONLESS = {
  tokenStatus: () => tokenStatus(),
  showToken: (_p, s) => showToken(s),
  rotateToken: (_p, s) => rotateToken(s),
  forgetToken: (_p, s) => forgetToken(s),
  serve: (_p, s) => serveDaemon(s),
  stop: (_p, s) => stopDaemon(s),
  daemonStatus: (_p, s) => daemonStatus(s),
} satisfies Record<Sessionless, (p: ParsedArgs, settings: BridgeSettings) => void | Promise<void>>;
const RUN_ON_SESSION = {
  listClients: (s, p) => listClientsCmd(s, p.json),
  whoami: (s) => whoamiCmd(s),
  listLibraries: (s, p) => listLibrariesCmd(s, p.json, p.listTimeoutMs),
  list: (s, p) => listIndexCmd(s, p.childrenId, p.listDepth, p.listTimeoutMs),
  listPages: (s, p) => listIndexCmd(s, p.childrenId, p.listDepth, p.listTimeoutMs),
  children: (s, p) => listIndexCmd(s, p.childrenId, p.listDepth, p.listTimeoutMs),
  screenshot: readCmd,
  pull: readCmd,
  selection: readCmd,
  allPages: readCmd,
  page: readCmd,
  designSystem: readCmd,
  asLibrary: readCmd,
  node: readCmd,
} satisfies Record<CommandIdIn<SessionFamily>, (s: Session, p: ParsedArgs) => Promise<void>>;
const sessionless = (id: CommandId): id is Sessionless => Object.hasOwn(RUN_SESSIONLESS, id);

// A read: the plan this command line sends (read-plan.ts), as a screenshot or a pull.
function readCmd(session: Session, parsed: ParsedArgs): Promise<void> {
  const plan = cliReadPlan(parsed);
  // parseArgs/validateArgs refused a read option this read does not take before anything was opened.
  if (!plan || "refused" in plan) throw new Error("internal: no read plan for this command line");
  if (plan.cmd === "screenshot") return screenshotCmd(session, plan, parsed.outDir);
  return exportCmd(session, plan, parsed);
}

// Runs the one command the parsed command line names.
async function main(parsed: ParsedArgs, settings: BridgeSettings): Promise<void> {
  const { id } = parsed.command;
  if (sessionless(id)) return RUN_SESSIONLESS[id](parsed, settings);
  return RUN_ON_SESSION[id](await openSession(parsed, settings), parsed);
}

// The verbs routed to their own entry point (cli-commands.ts VERB_ROWS `to: "routed"`), by name. Each runs
// before the CLI reads its settings and shares none of the pull flags, so each gets its own parser:
//   mcp     the MCP server (figma-mcp.ts), on stdio — it reads its own settings
//   init    project setup (init.ts) — no bridge
//   doctor  diagnose the setup (doctor.ts) — doctor must decide for ITSELF whether it is safe to open a
//           bridge (a bad FIGMA_BRIDGE_PORT and a held port are findings to report, not ways for the diagnostic
//           to die)
//   seed    components.json from Code Connect files (seed-components.ts) — reads source files only: no
//           bridge, no token (a bridge would resolve, and may mint, one), no plugin
const ROUTES = {
  mcp: runMcp,
  init: async (args) => { (await import("./init.ts")).main(args); },
  doctor: async (args) => { await (await import("./doctor.ts")).main(args); },
  seed: async (args) => { (await import("./seed-components.ts")).main(args); },
  plugin: async (args) => { (await import("./plugin-install.ts")).main(args); },
} satisfies Record<RoutedVerb, (args: string[]) => Promise<void>>;
const routed = (word: string | undefined): word is RoutedVerb => word !== undefined && Object.hasOwn(ROUTES, word);

async function runMcp(args: string[]): Promise<void> {
  // `--help` must never be the thing that STARTS a server. Probing a CLI's help surface silently
  // would launch a second MCP process attached to the live bridge and hold stdio until the caller kills
  // it — the one command in the table whose --help would have a side effect.
  if (args.includes("--help") || args.includes("-h")) {
    console.log(MCP_HELP);
    exitCli(0);
  }
  // Hide the subcommand from the MCP entry: it should see the argv of a plain `figma-mcp.ts` run.
  process.argv.splice(2, 1);
  // Awaited only until the module has LOADED; then its server is started (runServer — loading it starts nothing, so a
  // suite can load it) and runs on, unawaited, after cli() returns. A failure to load it (a CliExit thrown while still
  // inside runCli lands here) ends the process on its exit code, naturally: nothing holds the loop once the module
  // failed. Once cli() has returned, runCli is done with it, and the server runs as `bun figma-mcp.ts` would (stdio.ts
  // says why) — an invalid FIGMA_BRIDGE_PORT included: the server reports it and exits 1.
  try {
    (await import("./figma-mcp.ts")).runServer();
  } catch (e) {
    if (e instanceof CliExit) { process.exitCode = e.code; return; }
    console.error("[dtwin mcp] failed to start the MCP server: " + errMsg(e));
    process.exitCode = 1;
  }
}

// The CLI entry. Runs ONLY when this file is the process entry (see the guard at the bottom): routing
// first, then --version/--help, then the arguments are parsed, THEN the settings are read (settings.ts — port, token
// with --token-file, limits) and the command runs.
async function cli(argv: string[]): Promise<void> {
  // `dtwin mcp|init|doctor|seed|plugin` — their own entry points, before anything else runs (in particular before
  // the settings are read): `dtwin mcp` is taken ONLY when the first argument is exactly "mcp", so `dtwin …` and
  // importing this module from the test suites are untouched, and `bun bridge/src/figma-mcp.ts` still works.
  const word = argv[0];
  if (routed(word)) return ROUTES[word](argv.slice(1));
  // `dtwin <verb>` — verbs.ts rewrites a leading verb into the flags parsed below (`dtwin list pages` →
  // `--list-pages`), so there is still ONE parser and one set of guards. Done here, before the --help
  // check and the argument parse, so both see the translated argv. verbs.ts is pure (no imports,
  // no I/O), so `dtwin help` keeps --help's zero-side-effects guarantee.
  {
    // Help wins over the verb's own argument check. `dtwin screenshot --help` must not be answered with
    // "needs a node id" because translate ran first; a help probe must never be an
    // error, and must never have a side effect (see `dtwin mcp --help` above).
    const vh = verbHelp(argv);
    if (vh) {
      console.log(vh);
      exitCli(0);
    }
    try {
      argv = translate(argv, (p) => fs.existsSync(p));
    } catch (e) {
      if (!(e instanceof VerbError)) throw e;
      console.error("[dtwin] error: " + e.message);
      exitCli(1);
    }
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    // On a terminal, Bo (mascot.ts) beside the name; piped, redirected or with --json, the bare version, as scripts expect.
    console.log(versionText(pkg.version, spriteAllowed(process.stdout.isTTY === true, argv), process.env));
    exitCli(0);
  }
  if (argv.some((a) => a === "--help" || a === "-h")) {
    console.log(usageText());
    exitCli(0);
  }

  // DTWIN_PORT is not a thing this tool reads (FIGMA_BRIDGE_PORT is); say so once rather than
  // let a person who set it believe the bridge moved. After --help/--version, so those stay silent.
  const portWarning = dtwinPortWarning(process.env);
  if (portWarning) console.error("[dtwin] warning: " + portWarning);

  // Parse once, turning a UsageError back into the message + exit 1 it replaced, then print the
  // validation's warnings and, after them, its refusal (exit 1). (When this file is IMPORTED — the test
  // suite pulling in parseArgs/writeJson — cli() never runs, so nothing is parsed: the runner's own
  // argv is not ours to interpret or exit over.)
  let parsed: ParsedArgs;
  try {
    parsed = readArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error("[dtwin] error: " + errMsg(e));
    exitCli(1);
  }
  const check = validateArgs(parsed);
  for (const w of check.warnings) console.error("[dtwin] warn: " + w);
  if (check.error !== null) {
    console.error("[dtwin] error: " + check.error);
    exitCli(1);
  }

  // The bridge settings, resolved ONCE (settings.ts) — --token-file is an argument here, not an environment variable
  // written for a module that read it at load. A port no plugin can reach leaves nothing for any command to do.
  const resolved = readSettings({ tokenFile: parsed.tokenFile });
  if (!resolved.ok) {
    console.error(resolved.problem);
    exitCli(1);
  }

  // A failed command may leave the bridge it opened listening (it holds the loop), so this one ends with an explicit
  // exit — once the error line is out (exitFlushed), never cutting it off.
  await main(parsed, resolved.settings).catch((e: unknown) => {
    if (e instanceof CliExit) throw e;
    console.error("[dtwin] error:", errMsg(e));
    process.exitCode = 1;
    exitFlushed(1);
  });
}

// Only actually pull when RUN. Importing this file (test/bridge.test.ts drives parseArgs and
// writeJson directly) must not open a WebSocket server and sit there waiting for Figma.
// runCli (stdio.ts): console through the queued streams, exitCli unwinding to the exit code, which is process.exitCode —
// the process ends once its output has drained (a piped --list / --json is never cut at the pipe buffer).
if (import.meta.main) runCli(async (argv) => { await cli(argv); return Number(process.exitCode ?? 0); }, { name: "[dtwin] error" });

// writeJson is exported for the test suite: it's the ONE place a design-system.json / screen.json
// actually lands on disk, and the freshness stamp (`exportedAt`/`file`, stamped by the plugin itself —
// see collect.ts/components.ts) must survive that write byte-for-byte. figma-pull never adds, strips,
// or re-derives the stamp; it only writes what the plugin sent.
// formatLibraries is exported for the same reason parseArgs is: the case that MUST NOT look like a
// failure (zero libraries — free plan, or none enabled in the UI) is unreachable from a test that
// needs a live plugin, so the renderer is driven directly.
export { parseArgs, readArgs, validateArgs, cliReadPlan, writeJson, formatLibraries, formatClients, formatDone, UsageError };
