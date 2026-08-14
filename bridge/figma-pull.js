#!/usr/bin/env node
// figma-pull — READ plane CLI.
// Connects to the running Figma plugin over the localhost bridge, pulls the full
// design system + all page frames (or the current selection), and writes them to
// disk. The agent then Reads those files selectively (context-economical).
//
// Usage:
//   node figma-pull.js [outDir]              # full: design-system.json + current-page frames + assets
//   node figma-pull.js [outDir] --all-pages  # like full, but frame trees from EVERY page
//   node figma-pull.js [outDir] --selection  # just the current selection
//   node figma-pull.js [outDir] --page <id|name>   # ONE named page (repeatable; ids come from --list)
//   node figma-pull.js [outDir] --timeout N  # seconds to wait for the export (default: 300,
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
//
// Look before you pull (cheap RELATIVE to an export — no recursion, no assets, no node properties;
// prints JSON to stdout):
//   node figma-pull.js --list         # pages + their top-level frames (ids to deep-pull next).
//                                     # Loads each page (Figma warns loading pages is slow on large
//                                     # files) — cheap next to an export, not free. Use --list-pages
//                                     # if you only need the page names.
//   node figma-pull.js --list-pages   # page names only (near-free: does not load any page)
//   node figma-pull.js --children <id>  # ONE node's direct children only (peek inside a frame from
//                                        # --list before committing to a full recursive --page pull)
//   These three take NO read options (--css/--measurements/--plugin-data/--motion/--shared-data/
//   --no-assets): they emit structural fields only, so those flags are refused rather than ignored.
//   --timeout DOES apply to them.
//
// Speed:
//   --no-assets      # skip the per-node SVG/PNG export pass (the dominant cost on a big file).
//                    # Structure + tokens are unaffected; the manifest reports how many were skipped.
//
// Keep the connection open (daemon):
//   node figma-pull.js --serve          # hold the bridge open until stopped. Every command above then
//                                       # routes through it automatically and skips the reconnect.
//   node figma-pull.js --stop           # stop it
//   node figma-pull.js --daemon-status  # is one running, and is the plugin connected?
//   Only ONE process can hold port 8787 — while a daemon (or the MCP server) is up, a second bridge
//   exits with EADDRINUSE. That is exactly what routing through the daemon avoids.
//
// The Figma file must be open with the "Design Export for AI" plugin running.

const fs = require("fs");
const path = require("path");
// TIMEOUTS is the per-command budget table both front-ends read (server-core.js) — the tiers below
// pick from it rather than restating them, so the CLI and the MCP tools cannot drift apart.
const { createBridge, TIMEOUTS, exportTimeout, errMsg } = require("./server-core");
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
const plog = (m) => console.error("[figma-pull] " + m);
const writeJson = (dir, name, obj, quiet) => OUT.writeJson(dir, name, obj, quiet, plog);
const writePages = (dir, layersDoc) => OUT.writePages(dir, layersDoc, plog);
const writeAssets = (dir, assets) => OUT.writeAssets(dir, assets, plog);
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
// Daemon lifecycle. These are COMMANDS, not modifiers: each one owns the whole invocation, so they
// are refused in combination with each other and with any pull below. --serve holds the bridge open
// until stopped; every ordinary command then routes through it automatically (see daemon.js).
const daemonCmd = args.includes("--serve") ? "--serve"
  : args.includes("--stop") ? "--stop"
  : args.includes("--daemon-status") ? "--daemon-status"
  : null;
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
const listCmd = args.includes("--list-pages") ? "--list-pages" : args.includes("--list") ? "--list" : null;
const listOnly = listCmd !== null;
const listDepth = listCmd === "--list-pages" ? 1 : 2;

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

// --page <id|name>, REPEATABLE (docker -e / curl -H convention): export a bounded, caller-chosen set
// of pages. Accepts `--page=x` and `--page x`. Ambiguous/unknown selectors fail loudly plugin-side
// with the available pages listed — never a silent pick, since nothing here is interactive.
const pageSel = takeValues(args, "--page", "--page needs an id or name (see --list)");

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

// The positional [outDir] — the first token that's neither a `--flag` nor a value a flag above already
// claimed. Doing this AFTER parsing every value-taking flag is what keeps e.g. `--children 131:1879`
// (no outDir given) from being misread as `outDir = "131:1879"`.
const outDir = args.find((a, i) => !a.startsWith("--") && !consumedIdx.has(i)) || "design";

// Scope flags are MUTUALLY EXCLUSIVE, and the loser used to be discarded in silence: collectFull is
// `if (allPages) … else if (page)`, so `--all-pages --page Foo` exported all 25 pages while the user
// watched for one; `--selection --page Foo` never forwards the page at all. Both produce a plausible
// export of the WRONG scope — the failure you don't notice. Now that parsing is a pure function,
// refusing costs two lines and a test.
const scopes = [selection && "--selection", allPages && "--all-pages", pageSel.length && "--page"].filter(Boolean);
if (scopes.length > 1) {
  throw new UsageError(`${scopes.join(" and ")} select different scopes — pass only one.`);
}
// Same class of silent loss: the list/peek commands print and exit(0) before any export runs, so an
// export flag combined with one of them is a no-op the user has no way to see.
if ((listOnly || childrenId) && (selection || allPages || pageSel.length)) {
  throw new UsageError(`${listCmd || "--children"} only prints a structural index — it cannot be combined with ${scopes.join(" / ")}. Run the list first, then pull with the ids it prints.`);
}
if (listOnly && childrenId) {
  throw new UsageError("--list and --children are different queries — pass only one.");
}
// Read options are the SAME silent loss, one step further in. The list ops emit only structural
// fields (id/name/type/size) — they never serialize a node, never call getCSSAsync, never read
// measurements, never export an asset — so every flag in READ_OPT_FLAGS is a no-op here, discarded
// without a word. Refused as a group, --no-assets included: it is just as inert (nothing renders on
// this path), and exempting it would put the caller back to guessing WHICH flags survive a list,
// which is the ambiguity the guard exists to remove. `--timeout` is deliberately NOT in this set —
// it genuinely applies (listTimeoutMs).
if ((listOnly || childrenId) && readOptFlagsGiven.length) {
  const cmd = listCmd || "--children";
  // Decide plurality ONCE. Six inline ternaries in one template literal meant any wording edit was an
  // edit to a 400-character single expression with six branch points.
  const many = readOptFlagsGiven.length > 1;
  const [are, they, them] = many ? ["are read options", "they", "them"] : ["is a read option", "it", "it"];
  throw new UsageError(`${readOptFlagsGiven.join(" / ")} ${are} for an EXPORT — ${cmd} only prints a structural index (id/name/type/size), so ${they} would be silently ignored. Drop ${them} here, and pass ${them} to the --page pull afterwards.`);
}

// A daemon command owns the invocation. Combining it with a pull or a list is the same silent-loss
// class the scope guards above exist for: --serve --all-pages would start a daemon and never run the
// export the user typed, with nothing said about it.
if (daemonCmd) {
  const others = [
    selection && "--selection", allPages && "--all-pages", pageSel.length && "--page",
    listCmd, childrenId && "--children", ...readOptFlagsGiven,
  ].filter(Boolean);
  if (others.length) {
    throw new UsageError(`${daemonCmd} manages the background bridge — it cannot be combined with ${others.join(" / ")}. Start the daemon, then run your pull as a separate command (it will route through it automatically).`);
  }
  if ([args.includes("--serve"), args.includes("--stop"), args.includes("--daemon-status")].filter(Boolean).length > 1) {
    throw new UsageError("--serve / --stop / --daemon-status are different commands — pass only one.");
  }
}

return { selection, allPages, readOpts, listOnly, listDepth, childrenId, pageSel, exportTimeoutMs, listTimeoutMs, outDir, daemonCmd };
}

// CLI entry: parse once, turning a UsageError back into the message + exit 1 it replaced. When this
// file is REQUIRED (the test suite pulling in parseArgs/writePages) there is no CLI invocation to
// read, so parse nothing — the runner's own argv is not ours to interpret or exit over.
let parsed;
try {
  parsed = parseArgs(require.main === module ? process.argv.slice(2) : []);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error("[figma-pull] error: " + errMsg(e));
  process.exit(1);
}
const { selection, allPages, readOpts, listOnly, listDepth, childrenId, pageSel, exportTimeoutMs, listTimeoutMs, outDir, daemonCmd } = parsed;

async function main() {
  // ---- daemon lifecycle commands. Each owns the whole invocation and returns.
  if (daemonCmd === "--stop") {
    const stopped = await daemon.stop();
    console.error("[figma-pull] " + (stopped ? "daemon stopped." : "no daemon is running."));
    return;
  }
  if (daemonCmd === "--daemon-status") {
    const st = await daemon.status();
    console.log(JSON.stringify(st || { daemon: false }, null, 2));
    console.error("[figma-pull] " + (st
      ? `daemon up (pid ${st.pid}, port ${st.port}) — plugin ${st.pluginConnected ? "CONNECTED" : "not connected"}` +
        (st.idleMs ? `, idle ${Math.round(st.idleForMs / 60000)}/${Math.round(st.idleMs / 60000)} min before auto-shutdown.` : ", no idle shutdown.")
      : "no daemon is running — start one with --serve."));
    return;
  }
  if (daemonCmd === "--serve") {
    const bridge = createBridge();
    const { sock } = await daemon.serve(bridge, { log: (m) => console.error("[figma-pull] " + m) });
    console.error("[figma-pull] bridge listening on ws://localhost:" + bridge.port + " — socket " + sock);
    console.error('[figma-pull] Open your Figma file and run "Design Export for AI" (it auto-connects).');
    console.error("[figma-pull] The connection stays open until you run --stop (or Ctrl-C here).");
    const idleMin = Number(process.env.FIGMA_DAEMON_IDLE_MIN ?? 120);
    console.error("[figma-pull] " + (idleMin > 0
      ? `It also shuts down after ${idleMin} min idle, so an abandoned daemon can't hold port 8787 forever (FIGMA_DAEMON_IDLE_MIN=0 disables).`
      : "Idle shutdown is DISABLED — remember to --stop it, or it holds port 8787 until you do."));
    return; // the socket + WS server keep the event loop alive; no close() here, by design
  }

  // ---- ordinary commands. Route through a running daemon when there is one: it already holds the
  // bridge (and port 8787), so opening our own here would hit EADDRINUSE and exit. When there is no
  // daemon this is exactly the one-shot path it always was.
  const d = await daemon.connect();
  if (d) console.error("[figma-pull] using the running daemon (" + d.sock + ") — no reconnect needed.");

  // Only the export paths write to outDir; --list/--children print to stdout and are explicitly "a
  // decision aid, not a build input", so they must not leave an empty design/ behind as a side effect.
  if (!listOnly && !childrenId) fs.mkdirSync(outDir, { recursive: true });

  let bridge = null;
  let send;
  if (d) {
    // waitForConnection is forwarded so the DAEMON does the waiting: the plugin may not have
    // reconnected yet after a Figma restart, and the daemon is the side holding the socket.
    send = (cmd, args, timeoutMs) => d.request({ cmd, args, timeoutMs, waitForConnection: 600000 }, timeoutMs + 30000);
  } else {
    bridge = createBridge();
    console.error("[figma-pull] listening on ws://localhost:" + bridge.port);
    console.error('[figma-pull] Open your Figma file and run "Design Export for AI" (it auto-connects)…');
    console.error("[figma-pull] tip: --serve keeps this connection open so later pulls skip the reconnect.");
    await bridge.waitForConnection(600000); // 10 min — generous window for an interactive connect
    send = (cmd, args, timeoutMs) => bridge.request(cmd, args, timeoutMs);
  }
  // Every exit path below used to call bridge.close(); with a daemon there is no bridge of ours to
  // close, and closing the DAEMON's would be wrong — one helper so no call site has to know which.
  const finish = () => { if (bridge) bridge.close(); };

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
          summary: (r) => {
            const fr = r.manifest && r.manifest.frames;
            return `${r.manifest.pages} page(s)${fr === undefined ? "" : `, ${fr} top-level frame(s)`} in "${r.file}".`;
          },
        };
    console.error("[figma-pull] plugin connected — " + q.note + "…");
    const r = await send(q.cmd, q.args, listTimeoutMs);
    for (const w of (r.manifest && r.manifest.warnings) || []) console.error("[figma-pull] warn  " + w);
    console.log(JSON.stringify(r, null, 2));
    console.error("[figma-pull] " + q.summary(r));
    // Point at a flag that actually EXISTS. This previously suggested `--node <id>`, which was never
    // wired up — an instruction the CLI could not honour is worse than no instruction.
    console.error("[figma-pull] next: node bridge/figma-pull.js design --page <id>   (repeatable; add --no-assets to skip the render pass)");
    // The WS server keeps the event loop alive, so without an explicit shutdown these commands hung
    // forever after printing (found live: still resident and holding port 8787 a minute later,
    // blocking every subsequent pull). close() rather than process.exit(0) — same effect on the hang,
    // without truncating the JSON these commands exist to print. See close() in server-core.js.
    return finish();
  }

  const mode = selection ? "selection" : allPages ? "all pages" : pageSel.length ? `page(s) ${pageSel.join(", ")}` : "current page";
  // Measured: --all-pages did not finish in 15 minutes on a real 25-page/119-frame file, even with
  // --no-assets. Kept (it's slow, not unsafe — and it's fine on small files) but it should not be the
  // path anyone reaches for by default, so say so up front rather than after a quarter-hour.
  if (allPages) {
    console.error("[figma-pull] note: --all-pages deep-serializes EVERY frame on EVERY page and can exceed 15 min on a large file.");
    console.error("[figma-pull]       prefer: --list  then  --page <id>   (repeatable, e.g. --page 1:2 --page 3:4)");
  }
  console.error(`[figma-pull] plugin connected — pulling ${mode}… (timeout ${Math.round(exportTimeoutMs / 1000)}s)`);

  if (selection) {
    const r = await send("exportSelection", { ...readOpts }, exportTimeoutMs);
    writeJson(outDir, safe(r.screenName || "screen") + ".json", r.screen);
    writeJson(outDir, "variables.json", r.variables);
    writeAssets(outDir, r.assets);
  } else {
    const r = await send("exportFull", { allPages, page: pageSel.length ? pageSel : undefined, ...readOpts }, exportTimeoutMs);
    writeJson(outDir, "design-system.json", r.designSystem);
    writePages(outDir, r.layersDoc);
    writeAssets(outDir, r.assets);
  }

  console.error("[figma-pull] done.");
  finish(); // NOT process.exit — see close() in server-core.js (a daemon-routed run has nothing to close)
}

// Only actually pull when RUN. Requiring this file (test/bridge.test.js drives parseArgs and
// writePages directly) must not open a WebSocket server and sit there waiting for Figma.
if (require.main === module) {
  main().catch((e) => {
    console.error("[figma-pull] error:", errMsg(e));
    process.exit(1);
  });
}

// writeJson is exported for the test suite: it's the ONE place a design-system.json / screen.json
// actually lands on disk, and the freshness stamp (`exportedAt`/`file`, stamped by the plugin itself —
// see collect.ts/components.ts) must survive that write byte-for-byte. figma-pull never adds, strips,
// or re-derives the stamp; it only writes what the plugin sent.
module.exports = { parseArgs, writePages, writeJson, UsageError };
