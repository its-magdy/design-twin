# Troubleshooting — match the symptom, give the fix

Loaded from the `help` skill. Find the symptom, give the fix — don't debug from memory.

- **Plugin isn't in the menu / a manifest change didn't take** → re-import via *Import plugin from
  manifest…*. It lives under **Plugins → Development**, not the main plugin list.
- **`EADDRINUSE` / bridge hangs on connect** → port 8787 is held; only one bridge at a time. Check
  `dtwin --daemon-status` first — if a daemon is up, ordinary commands route
  through it and nothing needs stopping, so this means something *else* holds the port (usually the
  MCP server, or a stale `node`). If the MCP is the holder and you wanted files, use `writeToDisk:
  true` rather than killing it.
- **Bridge stays "offline" in the plugin** → either no token pasted (the plugin says
  `offline — paste the bridge token above` and won't dial until you paste + Save), or no server is
  running yet — the plugin UI is a WS *client*. Fix the token, start a server, it auto-connects (3s retry).
- **Connection rejected / 401** → token mismatch: the plugin's **Bridge token** field doesn't equal
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
- **A component in an export has no library/main component** → its library probably wasn't enabled
  when the export ran. Enable it in Figma, re-pull; there is no API to enable it.
- **MCP `figma` not showing up** → **this repo registers no MCP server** (there is no `.mcp.json`
  here, by choice — see `bridge/README.md`). Path C is for the project you are *building*: add a
  `.mcp.json` there pointing at an absolute path to `bridge/figma-mcp.mjs` — no token needed in it,
  since the MCP server reads the same per-user stored token the CLI does. Then enable it via `/mcp`
  and restart.
- **`design/` is empty / `/designtwin:build-screen` can't find files** → nothing exported yet. `design/` is a
  generated drop-target and doesn't exist until an export runs. Do Path A/B first.
- **Wrong stack generated** → set `design/target.json`, or add a profile at your project's own repo
  root (copy `${CLAUDE_PLUGIN_ROOT}/skills/build-screen/profiles/_template.md`) — it overrides the bundled profiles.
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
- **`audit.js`/`drift-lint.js`/etc. "not found"** → these ship at `${CLAUDE_PLUGIN_ROOT}/scripts/`
  inside the plugin itself — that env var is set by Claude Code whenever a skill from this plugin is
  active, so `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.js"` resolves regardless of the consumer
  project's own layout. If it still doesn't resolve, check `ls "${CLAUDE_PLUGIN_ROOT}/scripts"`: an
  empty/missing directory means a broken install — re-run `/plugin install designtwin`. Working from
  a clone of the Design Twin repo instead? The same scripts are `node design-to-code/<name>.js`.
- **Audit flags a lot of `small-touch-target` / `fixed-size-text`** → thresholds differ per platform
  (web 24px, iOS 44pt, Android 48dp) — make sure `--platform` matches the stack. Visual size can stay
  small if the hit area is padded; decorative static text can ignore the fixed-size warning.
- **Icons missing / lots of asset warnings** → warnings aggregate by kind. Invisible vector nodes are
  skipped silently; failed SVG exports fall back to a `geometry` field the codegen renders inline. A
  node with **neither** `asset` nor `geometry` is a genuine failure — report it.
- **Async / `figma.mixed` errors while editing the plugin** → the manifest uses
  `documentAccess: "dynamic-page"`, so all reads are async and mixed-value props must be guarded.
  See `ARCHITECTURE.md` → "Verified mechanism details".
