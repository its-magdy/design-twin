# Troubleshooting — match the symptom, give the fix

Loaded from the `help` skill. Find the symptom, give the fix — don't debug from memory.

**Connection-shaped problem (hangs, timeouts, `EADDRINUSE`, token rejected, "nothing connected")? Run
`dtwin doctor` first.** It checks Node, the token (incl. an env var shadowing the saved one), the
daemon, the port and who holds it, whether the plugin connects — and if a plugin is running with the
*wrong* token it says so with both fingerprints — then the project (`design/`, export age, maps,
`.mcp.json`). Each check is ✓ / ! / ✗ with the next step; it changes nothing (mints no token, writes no
file). `--wait 30` waits longer for the plugin; `--json` for machine output. The entries below are the
detail behind its findings, and everything it can't see. (Commands below are written as flags; the
verb forms — `dtwin status`, `dtwin token show`, `dtwin list libraries` … — are the same commands.)

- **Plugin isn't in the menu / a manifest change didn't take** → re-import via *Import plugin from
  manifest…*. It lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is held; only one bridge at a time. Check
  `dtwin --daemon-status` first — if a daemon is up, ordinary commands route
  through it and nothing needs stopping, so this means something *else* holds the port: a one-shot
  `dtwin pull` still running, a stale `node`, or an MCP server from an older install (current ones
  share the bridge and show up in `dtwin status`). Wait for the pull, or stop the stale process.
- **The plugin isn't connecting** → open its **Connect to Claude Code (optional)** section (collapsed by
  default; the pill in its header always shows the state) and read which of these it says:
  - `not set up` — no token pasted. It won't dial until you paste one into **Bridge token** + Save.
  - `not running` — every allowed port was tried and nothing answered: no server is up. The plugin UI
    is a WS *client* — start one (`dtwin --serve`, any `dtwin` pull, or the MCP server); it
    auto-connects (3s retry).
  - `waiting` — it WAS connected and the bridge went away. Normal after a one-shot `dtwin` pull ends.
  - `token rejected` (red, and the section opens itself) — a bridge is running but refused the token;
    see the next entry.
- **"The plugin is connected but sent nothing for '<cmd>'"** (stall message) → the plugin socket is up but
  the file's plugin is busy: an earlier export is still running in that file (the plugin runs one at a
  time), or it is a long cold first read of a large page. It is not a dead connection. Retry; with a warm
  plugin (`dtwin serve` in another terminal) the same read answers in seconds. The plugin reports `start`
  when it begins a run and `queued` when it arrives behind another, so a progress line shows which. If it
  keeps happening, look at the plugin window.
- **A pull took ~80 s but the export itself was ~3 s** → read the closing `done in …` line: `waited Ys for
  the plugin to connect` is the plugin re-dialling a fresh one-shot bridge (3 s retry, slower in a
  background window). `dtwin serve` keeps one bridge open and the plugin connected.
- **A late or "abandoned" reply answered the wrong command** → fixed: request ids are unique per bridge
  and a reply only settles the connection it was sent to. A cancelled request now stops in the plugin
  within one node (a single long `exportAsync` still runs to its end), so an abandoned export no longer
  keeps the plugin busy for the next command.
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
  Figma predates the manifest's `"permissions": ["teamlibrary"]` — **re-import it**; (2) no team
  library is enabled for the file (Figma UI → Assets → Libraries; no API can do this); (3) free plan.
  All three are normal, and the command's own output says which.
- **"N Figma files are connected — say which one to use"** → pass `--client` (CLI) or `client` (MCP);
  `--list-clients` shows the valid names. Refused rather than guessed on purpose: an export from the
  wrong file looks exactly like a correct one. Give each file its own output dir (`design/base`,
  `design/lib`) so exports don't collide.
- **A connection that sat idle came back as a different `instanceId`** → Figma restarted the plugin
  runtime. Don't leave the Figma window **minimized** (its renderer gets suspended); occluded is fine.
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
- **MCP `designtwin` not showing up** → **this repo registers no MCP server** (there is no `.mcp.json`
  here, by choice — see `bridge/README.md`). Path C is for the project you are *building*: add a
  `.mcp.json` there pointing at an absolute path to `bridge/dist/figma-mcp.js` (npm install) or
  `bridge/src/figma-mcp.ts` (repo checkout) — no token needed in it,
  since the MCP server reads the same per-user stored token the CLI does. Then enable it via `/mcp`
  and restart.
- **`design/` is empty / `/designtwin:build-screen` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and doesn't exist until an export runs. Do Path A/B first.
- **Wrong stack generated** → set `design/target.json`, or add a profile at your project's own repo
  root (copy `<plugin>/skills/build-screen/profiles/_template.md`) — it overrides the bundled profiles.
- **`stale-snapshot` / `unknown-freshness` from drift-lint** → the export in `design/` is older than
  24h (or has no `exportedAt`), so a "clean" result is against the snapshot, not the live file.
  Re-run Path A/B. Tunable: `--max-age <hours>` / `DRIFT_MAX_AGE_HOURS`.
- **Audit verdict is "Blocked"** → only four things block: a truncated export, failed assets, a missing
  font, or a frame not marked ready for dev. Re-export a narrower scope / install the font / confirm
  with the designer; everything else is a warning with a stated default and doesn't stop the build.
- **Audit says a state is "not found" but the designer drew it** → states are detected by layer NAME
  (Loading/Skeleton/Empty/Error/Offline…) in the exported layers only. Export the page that holds it, or
  rename the frame. Library components' states show as "sampled" — pull the library with
  `--as-library` for their full variants.
- **A script "not found" / `Cannot find module '/scripts/…'`** → the command ran with an empty plugin
  path. The scripts ship at `<plugin>/scripts/<name>.js`. Claude Code writes the real plugin path into a
  skill's or agent's own text when it loads it, but `CLAUDE_PLUGIN_ROOT` is NOT an environment variable in
  the Bash tool, so `node "$CLAUDE_PLUGIN_ROOT/scripts/…"` typed into a shell always fails. Copy the path
  exactly as the skill shows it; a script's own usage/hint lines also print their real path. If the skill
  text itself still shows the literal `${…}` form (it was preloaded into an agent), the agent's prompt
  names the folder. The folder is missing → re-run `/plugin install designtwin`. Working from a clone of
  the Design Twin repo instead? The same scripts are `node design-to-code/<name>.ts`.
- **`verify-probe` exits 3: "chromium did not launch" / no usable browser** → Playwright's Chromium is not
  installed (or not the revision this Playwright expects). The install line the probe prints downloads a browser —
  the user's call. A Chromium already on the machine works instead: `verify-probe.js --browser-path <executable>`
  (also on `--check`) — the binary itself, on macOS the one inside the `.app` (`…/Contents/MacOS/…`). A path that is
  not an executable file is exit 3 with one line saying so. Only guaranteed with the bundled Chromium (another
  version may not launch or may render differently); `measured.json` records `custom`, never the path.
- **Audit flags a lot of `small-touch-target` / `fixed-size-text`** → thresholds differ per platform
  (web 24px, iOS 44pt, Android 48dp) — make sure `--platform` matches the stack. Visual size can stay
  small if the hit area is padded; decorative static text can ignore the fixed-size warning.
- **Icons missing / lots of asset warnings** → warnings aggregate by kind. Invisible vector nodes are
  skipped silently; failed SVG exports fall back to a `geometry` field the codegen renders inline. A
  node with **neither** `asset` nor `geometry` is a genuine failure — report it.
- **Async / `figma.mixed` errors while editing the plugin** → the manifest uses
  `documentAccess: "dynamic-page"`, so all reads are async and mixed-value props must be guarded.
  See `ARCHITECTURE.md` → "Verified mechanism details".
