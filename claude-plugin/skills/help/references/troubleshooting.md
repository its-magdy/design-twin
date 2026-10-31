# Troubleshooting — match the symptom, give the fix

Loaded from the `help` skill. Find the symptom, give the fix — don't debug from memory.

## Contents
- Run `dtwin doctor` first
- Connecting the plugin and the bridge
- Slow or stalled pulls
- Commands, tokens and ports
- Exports
- Project setup and the MCP server
- Audit, scripts and the verify probe
- Assets and plugin development

## Run `dtwin doctor` first

**Connection-shaped problem (hangs, timeouts, `EADDRINUSE`, token rejected, "nothing connected")? Run
`dtwin doctor` first.** It checks Bun (≥ 1.4.2), the token (incl. an env var shadowing the saved one), the
daemon, the port and who holds it, whether the plugin connects — and if a plugin is running with the
*wrong* token it says so with both fingerprints — then the project (`design/`, export age, maps,
`.mcp.json`). Each check is ✓ / ! / ✗ with the next step; it changes nothing (mints no token, writes no
file). `--wait 30` waits longer for the plugin; `--json` for machine output. The entries below are the
detail behind its findings, and everything it can't see. (Commands below are written as flags; the
verb forms — `dtwin status`, `dtwin token show`, `dtwin list libraries` … — are the same commands.)

## Connecting the plugin and the bridge

- **Plugin isn't in the menu** → import it via *Import plugin from manifest…* → the file `dtwin plugin path`
  prints (`dtwin plugin install` first if it was never installed; `--open` shows the hidden folder). It lives
  under **Plugins → Development**, not the main plugin list.
- **"plugin vX is older than this bridge" / a manifest change didn't take** → `dtwin plugin update` (any `dtwin`
  that starts a bridge does it too), turn on **Plugins → Development → Hot reload plugin**, then reopen the plugin —
  no re-import (with hot reload off, Figma keeps running the code it loaded). Still old? It was imported from
  somewhere else: `dtwin plugin status` names the folder to import from; remove the other one in Plugins → Manage
  plugins. A new permission that still does not work after a reopen: re-import once.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is held; only one bridge at a time. Check
  `dtwin --daemon-status` first — if a daemon is up, ordinary commands route
  through it and nothing needs stopping, so this means something *else* holds the port: a one-shot
  `dtwin pull` still running, a stale `bun` process, or an MCP server from an older install (current ones
  share the bridge and show up in `dtwin status`). Wait for the pull, or stop the stale process. If the
  error names a socket from an earlier dtwin version, `dtwin --stop` stops that daemon.
- **Windows: `dtwin serve` says the pipe "is held by a process that could not prove it knows your bridge
  token"** → something that is not your daemon holds the daemon's pipe name (the pipe is named from your
  token, and every connection must prove the token first). Nothing was sent to it; commands still work,
  one-shot. If it is not a dtwin you started under another token, `dtwin --rotate-token` moves the daemon to
  a new pipe (then re-paste the token into the plugin).
- **Windows: "port … is already in use" while `dtwin status` finds no daemon** → a daemon started under a
  DIFFERENT token (e.g. another `FIGMA_BRIDGE_TOKEN`) holds the port, and its pipe cannot be found by this
  token, so `dtwin --stop` does not reach it — end that `bun` process (or use the same token).
- **Windows: `dtwin serve` says "no bridge token is saved yet"** → the pipe is named from the token: run any
  command that connects (or `dtwin init`) once, so a token is saved, then `dtwin serve`.
- **"refusing to use … for the dtwin daemon socket"**, or `dtwin status` says no daemon while one is
  running → the daemon socket lives in `$XDG_RUNTIME_DIR`, else `$TMPDIR/designtwin-<uid>/`, so two
  processes with different `XDG_RUNTIME_DIR` / `TMPDIR` see different daemons — start them from the same
  environment. The refusal means that directory is a symlink, someone else's, or not `0700`: commands
  still work, one-shot, but no daemon can run there. Remove the directory (its owner, or an admin, if it
  is not yours), or point `XDG_RUNTIME_DIR` or `TMPDIR` at a directory only you can access.
- **The plugin isn't connecting** → open its **Connect to Claude Code (optional)** section (collapsed by
  default; the pill in its header always shows the state) and read which of these it says:
  - `not set up` — no token pasted. It won't dial until you paste one into **Bridge token** + Save.
  - `not running` — every allowed port was tried and nothing answered: no server is up. The plugin UI
    is a WS *client* — start one (`dtwin --serve`, any `dtwin` pull, or the MCP server); it
    auto-connects (it retries every second).
  - `waiting` — it WAS connected and the bridge went away. Normal after a one-shot `dtwin` pull ends.
  - `token rejected` (red, and the section opens itself) — a bridge is running but refused the token;
    see the next entry.
- **"The plugin is connected but sent nothing for '<cmd>'"** (stall message) → the plugin socket is up but
  the file's plugin is busy: an earlier export is still running in that file (the plugin runs one at a
  time), or it is a long cold first read of a large page. It is not a dead connection. Retry; with a warm
  plugin (`dtwin serve` in another terminal) the same read answers in seconds. The plugin reports `start`
  when it begins a run and `queued` when it arrives behind another, so a progress line shows which. If it
  keeps happening, look at the plugin window.

## Slow or stalled pulls

- **A pull took ~80 s but the export itself was ~3 s** → read the closing `done in …` line: `waited Ys for
  the plugin to connect` is the plugin re-dialling a fresh one-shot bridge (1 s retry per port, slower in a
  background window). `dtwin serve` keeps one bridge open and the plugin connected.
- **A late or "abandoned" reply answered the wrong command** → request ids are unique per bridge
  and a reply only settles the connection it was sent to. A cancelled request stops in the plugin
  within one node (a single long `exportAsync` still runs to its end), so an abandoned export does not
  keep the plugin busy for the next command.

## Commands, tokens and ports

- **`dtwin: command not found`** → not installed, or its bin dir is not on this PATH: `bun add -g
  @design-twin/dtwin` (lands in `~/.bun/bin`) or `brew install its-magdy/tap/dtwin`; a clone needs `bun link`
  in `bridge/`. **`env: bun: No such file or directory`** → `dtwin` is there but Bun is not (an npm install
  still runs on Bun) — see the `bun: command not found` entry below.
- **`dtwin pull --out <dir>` → "outDir is positional"** → write `dtwin pull <dir>`. There is also no
  `--port`: set `FIGMA_BRIDGE_PORT` (`DTWIN_PORT` is not read; `dtwin doctor` warns about it).
- **Token rejected / 401** → token mismatch: the plugin's **Bridge token** field doesn't equal
  the bridge's. Run `dtwin --token-status` (says which source is winning — a saved token *shadowed* by
  a `FIGMA_BRIDGE_TOKEN` export is the usual surprise), then `dtwin --show-token` and re-paste + Save.
  The bridge also logs the mismatch itself, with both fingerprints. Most common cause: someone ran
  `--rotate-token` and the plugin still has the old one cached in `clientStorage`.
- **Changed the port?** The plugin tries `8787`, then `8788`, then `8789` in turn (manifest +
  `ui.html`) — those are the only three it can dial, so `FIGMA_BRIDGE_PORT` must be one of them.
  Usually easier to just free `8787` than to move the server.
- **`--list-libraries` / `figma_list_libraries` returns nothing** → in this order: (1) the plugin in
  Figma predates the manifest's `"permissions": ["teamlibrary"]` — **reopen it with hot reload on, else re-import it**; (2) no team
  library is enabled for the file (Figma UI → Assets → Libraries; no API can do this); (3) free plan.
  All three are normal, and the command's own output says which.
- **"N Figma files are connected — say which one to use"** → pass `--client` (CLI) or `client` (MCP);
  `--list-clients` shows the valid names. Refused rather than guessed on purpose: an export from the
  wrong file looks exactly like a correct one. Give each file its own output dir (`design/base`,
  `design/lib`) so exports don't collide.
- **A one-shot command waits ~3.5 s after the plugin connects** → the fresh bridge is settling: with no
  `--client`, or one that is a file name (whole or partial — names repeat and match as substrings), it
  waits one plugin walk of the three ports for a second open file before routing, so it refuses to guess instead of picking
  whichever file landed first; a shorter `--timeout` does not cut it short. A connId or fileKey skips it.
  A running `dtwin serve` daemon or MCP session pays nothing once its plugins have been connected for
  3.5 s, but waits again when one window leaves while others stay (it is probably redialling). A window
  redialling slowly (a background window) can still land later — with two files open, always pass `--client`.
- **A connection that sat idle came back as a different `instanceId`** → Figma restarted the plugin
  runtime. Don't leave the Figma window **minimized** (its renderer gets suspended); occluded is fine.

## Exports

- **An export slowed to a crawl — a progress tick every ~3 s and the node counter barely moving** → the
  file's tab is not the *active* tab in Figma Desktop. Measured live (2026-09-25, one page, daemon):
  31–38 ticks and ~2,500 nodes per 10 s with the file's tab in front; 3–5 ticks and ~15 nodes per 10 s
  while another file's tab was in front (about 100× slower); then 27 ticks in the first 10 s after
  switching back and the normal 31–38 from the second window on. Nothing is lost — the export
  finishes, just late — but a `--timeout` sized for the foreground will fire. Figma Desktop is an
  Electron app, and Electron's `backgroundThrottling` (default `true`) is "Whether to throttle
  animations and timers when the page becomes background"; the plugin's walk has no timers of its own
  (it advances on Figma API awaits), so the throttle is the tab's. Keep the exporting file's tab in
  front for the duration; switching between two exporting files means each runs only while it is in
  front.
- **A component in an export has no library/main component** → its library probably wasn't enabled
  when the export ran. Enable it in Figma, re-pull; there is no API to enable it.

## Project setup and the MCP server

- **MCP `designtwin` not showing up** → it is registered per project, in the project you are *building*
  (the Design Twin repo itself registers none, by choice). Run `dtwin init --mcp` there: it adds a `.mcp.json`
  entry whose `command` is the absolute path of `bun` and whose `args` are
  `["--no-install", "--no-env-file", "<package>/src/figma-mcp.ts"]` (`bridge/src/…` in a clone) — no token needed
  in it, since the MCP server reads the same per-user stored token the CLI does. Then enable it via `/mcp`
  and restart.
- **`design/` is empty / `/designtwin:build-screen` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and doesn't exist until an export runs (or `dtwin init`). Export first: `/designtwin:extract`.
- **Wrong stack generated** → set `profile` in `design/target.json`. For a stack the plugin does not bundle, write
  `design/profile.md` from `<plugin>/skills/build-screen/profiles/_template.md` and name it in `target.json`.
- **`figma_write` returns "Edits are off in the Design Twin plugin — tick 'Allow edits' …"** (or a dry run
  says `editsAllowed: false`) → the designer has not let the plugin change this file. Writes are off by
  default. Nothing was changed, and the agent cannot turn it on: **ask the user to tick "Allow edits" in the
  Design Twin plugin window**, then retry the same call. The setting is saved for this user in every file, so
  remind them to untick it when they are done. Reads and exports work either way.
- **`stale-snapshot` / `unknown-freshness` from drift-lint** → the export in `design/export/` is older than
  24h (or has no `exportedAt`), so a "clean" result is against the snapshot, not the live file.
  Re-pull (`/designtwin:extract`). Tunable: `--max-age <hours>` / `DRIFT_MAX_AGE_HOURS`.

## Audit, scripts and the verify probe

- **Audit verdict is "Blocked"** → only four things block: a truncated export, failed assets, a missing
  font, or a frame not marked ready for dev. Re-export a narrower scope / install the font / confirm
  with the designer; everything else is a warning with a stated default and doesn't stop the build.
- **Audit says a state is "not found" but the designer drew it** → states are detected by layer NAME
  (Loading/Skeleton/Empty/Error/Offline…) in the exported layers only. Export the page that holds it, or
  rename the frame. Library components' states show as "sampled" — pull the library with
  `--as-library` for their full variants.
- **`bun: command not found`, a hook error naming `bun`, or the SessionStart notice "Design Twin needs Bun ≥ 1.4.2"**
  → every plugin script and hook, `dtwin` and the MCP server run on Bun (Node is not supported). Install it from
  https://bun.sh/install (`curl -fsSL https://bun.sh/install | bash`; Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`)
  or upgrade it the way it was installed (`bun upgrade` for the official installer, `brew upgrade bun`,
  `npm install -g bun@latest`, `scoop update bun`; a canary build of 1.4.2 counts as older than 1.4.2), then restart
  Claude Code. Installed but still not found → it is not on the PATH Claude
  Code was started with (the installer adds `~/.bun/bin` to your shell profile; an app launched from the dock or Start
  menu may not read it): start Claude Code from a new terminal, or put `~/.bun/bin` on the system PATH. Until then the
  visual-verifier's guard cannot run, and its Bash/Write calls go through **unguarded** (the guard's hook runs on every
  agent's calls, so it fails open rather than block the whole session) — do not run `/designtwin:verify` until Bun works.
  On Windows without Git for Windows the notice itself cannot appear (the check is a `sh` script, and Claude Code then
  runs hooks in PowerShell): a SessionStart hook error naming `sh` means the same thing — install Git for Windows, or Bun.
- **`dtwin doctor` says the MCP registration cannot start** (a `bun` or `figma-mcp.ts` that moved, a Node-era
  `node …/dist/figma-mcp.js` entry, bun without `--no-install --no-env-file`) → run `dtwin init --mcp` in the project:
  it rewrites that entry in place to the installed bun and `figma-mcp.ts`, then restart Claude Code.
- **A script "not found" / `Module not found "/scripts/…"`** → the command ran with an empty plugin
  path. The scripts ship at `<plugin>/scripts/<name>.js`. Claude Code writes the real plugin path into a
  skill's or agent's own text when it loads it, but `CLAUDE_PLUGIN_ROOT` is NOT an environment variable in
  the Bash tool, so `bun --no-install --no-env-file "$CLAUDE_PLUGIN_ROOT/scripts/…"` typed into a shell always fails. Copy the path
  exactly as the skill shows it; a script's own usage/hint lines also print their real path. If the skill
  text itself still shows the literal `${…}` form (it was preloaded into an agent), the agent's prompt
  names the folder. The folder is missing → reinstall: `claude plugin install designtwin@designtwin-marketplace`. Working from a clone of
  the Design Twin repo instead? The same scripts are `bun design-to-code/<name>.ts`.
- **`verify-probe` exits 3: "chromium did not launch" / no usable browser** → Playwright's Chromium is not
  installed (or not the revision this Playwright expects). The install line the probe prints downloads a browser —
  the user's call. A Chromium already on the machine works instead: `verify-probe.js --browser-path <executable>`
  (also on `--check`) — the binary itself, on macOS the one inside the `.app` (`…/Contents/MacOS/…`). A path that is
  not an executable file is exit 3 with one line saying so. Only guaranteed with the bundled Chromium (another
  version may not launch or may render differently); `measured.json` records `custom`, never the path.
- **A verify run stops with "designtwin visual-verifier guard: …"** → the plugin's PreToolUse hook
  (`hooks/hooks.json` → `scripts/verifier-guard.js`) refused one of the `visual-verifier` agent's own calls; it
  applies to that agent only. It refuses a write outside `design/verify/` and the run cache
  (`node_modules/.cache/designtwin-verify/`), or to a file the verify tools own; a pattern kill (`pkill`,
  `killall`, `kill -1`, …); a dependency or Playwright browser install; `verify-screen --migrate` (it renames verify
  sets and rewrites plans — the caller's call); and `dangerouslyDisableSandbox`. The reason
  says what to do instead. This is by design, not a fault to work round: a needed install (e.g. the probe's exit 3)
  is the user's to run, and the verifier stops its own server with `kill <pid>`, `kill -- -<pgid>` or `pkill -P <pid>`.
- **`verify-screen` / `verify-probe` exit 2: "legacy-named verify set … run verify-screen --migrate"** → the
  project has verify sets from before sets were named by node (a nickname, `<Screen>@320`, `<Screen>-r1`). Every set
  is now `<Layer>__<id>` (a variant `<Layer>__<id>.<slug>`); `--compare` and the probe refuse a legacy-named
  expectation, and `--status` a node that has only legacy-named sets. From the project root run
  `bun --no-install --no-env-file "<plugin>/scripts/verify-screen.js" --migrate` — a dry run that lists each rename and each set it skips, with why —
  then `--migrate --apply`, which renames every file of each set (the live status too) and rewrites the paths a
  plan's `verification` records. Only a legacy base set beside an existing `<Layer>__<id>` base set is retired (its
  expectation gets `.retired`); a legacy variant becomes `<Layer>__<id>.<slug>`. A set it skips, the dry run says why,
  and each has its own way on: an open run — end or finish that run first; a plan that finds the set by its name
  alone — add `"nodeId"` to that plan; a plan that still records a retired set's report — re-run `--compare
  --record-plan` on the node's existing `<Layer>__<id>` set, then `--migrate`; a plan of a set to rename whose record
  was edited by hand — restore the block (`--compare` refuses a legacy-named set, so it cannot be re-recorded under that
  name); one whose record no longer names the report on disk — restore the report the record names; for either,
  instead run `--expect` (no `--variant`; it writes the node's `<Layer>__<id>` base set), measure it and `--compare
  --record-plan` on it (it replaces the block), then `--migrate` retires the legacy set (a base set) or renames it (a
  variant); two legacy sets of one node that neither extends the other — retire the others by hand, as the dry run
  says; a node that is unknown or ambiguous, a new name that is taken, or a variant slug that is reserved, longer than
  32 characters or overlaps another — rename by hand. For any other skip, follow the line the dry run prints. A run cut
  short leaves `design/verify/.migrate-<S>.json`: the next `--migrate --apply` rolls it back first. **"--out takes the verify
  directory"** / **"--force is gone"** → `--out` names the directory, never the set; a second set of one node is
  `--expect --variant <slug>`.
- **Audit flags a lot of `small-touch-target` / `fixed-size-text`** → thresholds differ per platform
  (web 24px, iOS 44pt, Android 48dp) — make sure `--platform` matches the stack. Visual size can stay
  small if the hit area is padded; decorative static text can ignore the fixed-size warning.

## Assets and plugin development

- **Icons missing / lots of asset warnings** → warnings aggregate by kind. Invisible vector nodes are
  skipped silently; failed SVG exports fall back to a `geometry` field the codegen renders inline. A
  node with **neither** `asset` nor `geometry` is a genuine failure — report it.
- **Async / `figma.mixed` errors while editing the plugin** → the manifest uses
  `documentAccess: "dynamic-page"`, so all reads are async and mixed-value props must be guarded.
  See `ARCHITECTURE.md` → "Verified mechanism details".
