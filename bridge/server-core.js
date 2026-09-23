// Shared bridge core: hosts a localhost WebSocket server that the Figma plugin's
// hidden UI iframe connects to, and correlates request/response by id.
// Used by both figma-pull (CLI, read) and figma-mcp (write server).
//
// The plugin is always the WebSocket CLIENT (a browser iframe cannot listen);
// this process is the SERVER. Loopback only — no internet exposure.

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

// Finding 327: the plugin used to report no version at all, so a stale bundle in Figma (several fixes
// live only in figma-plugin/code.js — SVG normalisation, case-folded asset names) could not be told
// apart from a fresh one — a plugin instance's startedAt and code.js's own mtime can land in the same
// minute either way. `BRIDGE_VERSION` is this PACKAGE's version (bridge/package.json — the CLI/MCP the
// user is actually running); `pluginStalenessNote` compares it against whatever the connected plugin
// announced in its `hello`. A simple numeric [major,minor,patch] compare, not semver ranges: this is an
// internal tool with one version number moving in one repo, not a published dependency graph.
const BRIDGE_VERSION = (() => { try { return require("./package.json").version; } catch (e) { return null; } })();
function parseVersion(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function versionOlder(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
// `null` means "nothing to warn about" — the plugin reported a version, and it isn't older than this
// CLI/MCP. Everything else IS worth a warn, including a MISSING version: the first live check of this
// exact feature found a real daemon + a real Figma plugin both still running pre-327 code, and doctor
// said nothing — `list clients --json` printed `pluginVersion: null, pluginStale: null` for both
// files, because the old logic only ever compared two REAL version strings and treated "didn't report
// one" as "nothing to check," which is backwards: no version at all is the ONE case we can be certain
// predates this feature, so it is unconditionally worth a warning, not a silent pass.
function pluginStalenessNote(pluginVersion) {
  if (typeof pluginVersion !== "string" || !pluginVersion) {
    return "plugin bundle predates version reporting (or the daemon was started before this bridge was updated) — " +
      "re-run Plugins → Development → Design Twin in Figma and restart `dtwin serve`";
  }
  const p = parseVersion(pluginVersion), b = parseVersion(BRIDGE_VERSION);
  if (!p || !b || !versionOlder(p, b)) return null;
  return `plugin v${pluginVersion} is older than this ${BRIDGE_VERSION} bridge — reload the plugin in Figma (Plugins → Development → Design Twin) to pick up recent fixes`;
}

// Distinct from the above: this fires when the CLIENT ROW ITSELF has no `pluginVersion` KEY at all
// (`"pluginVersion" in row` is false), which is not the same as the key being present and `null`.
// `describe()` below always sets the key — to a string or explicitly to `null` — for any bridge
// running this code, so a row with the key entirely absent can only have come from an OLDER daemon's
// own (pre-327) `describe()`, read back over its status socket by a NEWER `dtwin` CLI. That is a
// second, independent kind of staleness this tool can detect: not just "the Figma plugin is old" but
// "the long-running `dtwin serve` process itself predates this bridge version and needs restarting" —
// which reloading the Figma plugin alone will not fix, since the daemon in front of it is what's stale.
function daemonRowStalenessNote(row) {
  if (row && typeof row === "object" && !("pluginVersion" in row)) {
    return "the `dtwin serve` daemon in front of this connection predates plugin-version reporting — restart it (`dtwin serve --stop` then `dtwin serve`) to pick up recent fixes";
  }
  return null;
}

// The ONLY ports a published plugin can reach. figma-plugin/manifest.json lists these three in
// `networkAccess.allowedDomains`, Figma's match patterns have no port wildcard, and a plugin socket to
// any other port is blocked by Figma before it leaves the iframe. So FIGMA_BRIDGE_PORT is a choice of
// three, not a free number: binding 9999 gives a bridge that nothing can ever connect to. Keep this
// array and the manifest's allowedDomains in sync — they are two halves of one contract.
const ALLOWED_PORTS = [8787, 8788, 8789];

const PORT = (() => {
  const raw = process.env.FIGMA_BRIDGE_PORT;
  if (!raw) return ALLOWED_PORTS[0];
  const n = Number(raw);
  if (ALLOWED_PORTS.includes(n)) return n;
  console.error(
    `[bridge] FIGMA_BRIDGE_PORT=${raw} is not one of ${ALLOWED_PORTS.join(", ")}. The Figma plugin ` +
      "may only open sockets to ports named in its manifest, so a bridge here would never be reachable."
  );
  process.exit(1);
})();

// Shared secret the plugin must present as ?token=... on connect. This is the REAL access control:
// loopback binding and the Origin check below are both defeatable — a sandboxed attacker iframe on
// any site the user visits also sends "Origin: null" — so without the token any local page/process
// could drive the plugin. See AgentSeal's Figma-MCP CSWSH writeup.
//
// token-store.js owns everything ABOUT the token that isn't this handshake: the precedence
// (--token-file > env > stored file > mint), the per-OS path, and the file's 0600 mode. It is
// resolved once here at require time, so the tests that set FIGMA_BRIDGE_TOKEN before requiring this
// module still get exactly that token.
//
// `persist: false` here on purpose: requiring this module must not have the side effect of CREATING
// a token file. `dtwin --token-status` requires it just to ask a question, and a status command that
// silently mints the thing it is reporting on would be lying. The mint is committed in createBridge
// instead — the moment a token is actually about to be used.
const tokenStore = require("./token-store.js");
// Resolution happens at REQUIRE time, so a bad --token-file would otherwise throw out of a module
// load — a raw stack trace, before either front-end has any error handling in scope, for what is
// just a mistyped path. Hold the failure instead and re-throw it from createBridge, which every
// caller already funnels into its own "[dtwin] error: …" + exit 1 path. Commands that never open a
// bridge (--token-status) then keep working, which is exactly when you want to diagnose this.
let TOKEN_INFO;
let TOKEN_ERROR = null;
try {
  TOKEN_INFO = tokenStore.resolve({
    tokenFile: process.env.FIGMA_BRIDGE_TOKEN_FILE || null,
    persist: false,
  });
} catch (e) {
  TOKEN_ERROR = e;
  TOKEN_INFO = { token: null, source: "error", path: null, created: false };
}
const TOKEN = TOKEN_INFO.token;
const TOKEN_FROM_ENV = TOKEN_INFO.source === "env";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Per-COMMAND time budgets, in ONE table. The budget is a property of the work, not of the caller, so
// both front-ends (figma-pull CLI, figma-mcp) read it from here instead of restating the tiers — a
// fourth caller would otherwise inherit `command` again, which is the 120s default tuned for
// ping/getSelection and far too small for anything that walks a page.
//   selection  — one hand-picked selection (small by construction)
//   list       — cheap RELATIVE to an export, not fast: depth 2 loads EVERY page, which Figma's own
//                docs call "slow for large documents". The tool you're told to call FIRST must not be
//                the first to fail on exactly the large files where looking before you pull matters.
//   export     — one page / one node: found the hard way on a ~1000-node file.
//   exportAll  — whole file / --all-pages: measured >15 min on a real 25-page file.
const TIMEOUTS = { command: 120000, selection: 120000, list: 300000, export: 300000, exportAll: 900000 };

// The scope -> tier RULE, not just the table. Hoisting only the numbers still left both front-ends
// restating which tier an export picks, and they had already drifted (the MCP copy omitted the
// selection tier). One function so a new tier reaches every caller.
const exportTimeout = ({ selection, allPages } = {}) =>
  selection ? TIMEOUTS.selection : allPages ? TIMEOUTS.exportAll : TIMEOUTS.export;

// Thrown value -> message string. Re-exported (not redefined) so both front-ends and the plugin
// bundle share the one definition in errmsg.js.
const { errMsg } = require("./errmsg.js");

// Compare the SHA-256 digests, not the raw tokens. timingSafeEqual throws on unequal lengths, so the
// previous `ba.length === bb.length && ...` guard short-circuited before the constant-time compare
// and leaked the token's LENGTH through timing. Hashing first makes both sides a fixed 32 bytes, so
// every comparison takes the same path regardless of what was presented.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Failed-handshake accounting. Two jobs, one counter:
//
//  1. DIAGNOSIS. The plugin caches its token in figma.clientStorage and retries every 3s, so a token
//     that no longer matches (usually: someone ran --rotate-token and didn't re-paste) becomes a
//     silent 3-second reconnect loop. The bridge is the only side that can see WHY, so it says so —
//     once, not sixty times a minute.
//  2. THROTTLE. Nothing here is a serious brute-force defence (the token is 192 bits; a local
//     attacker guessing it is not the threat model — see the Origin note above). It exists so a
//     runaway client can't spin the handshake path, and so the log stays readable.
let authFailures = 0;
let lastAuthLog = 0;
// The most recent refused token, by fingerprint only — what `dtwin doctor` reads to tell "no plugin is
// running" apart from "a plugin is running with the WRONG token", which look identical from outside.
let lastBadToken = null;
const AUTH_LOG_INTERVAL_MS = 30000;

function rejectBadToken(presented) {
  authFailures++;
  lastBadToken = { at: Date.now(), fingerprint: presented ? tokenStore.fingerprint(presented) : null };
  const now = Date.now();
  if (now - lastAuthLog > AUTH_LOG_INTERVAL_MS) {
    lastAuthLog = now;
    const detail = presented
      ? `presented ${tokenStore.fingerprint(presented)}, expected ${tokenStore.fingerprint(TOKEN)}`
      : "no token presented";
    console.error(
      `[bridge] rejected a connection: ${detail}` +
        (authFailures > 1 ? ` (${authFailures} failures so far)` : "") +
        ". Re-paste the plugin's \"Bridge token\" field — `dtwin --show-token` prints the current one."
    );
  }
  return "bad or missing token";
}

const authStats = () => ({ failures: authFailures, lastBadToken, expected: tokenStore.fingerprint(TOKEN) });

// Runs during the WS handshake, before the connection is accepted.
function verifyClient(info, done) {
  const req = info.req;
  // Origin: the plugin iframe sends "null" (sandboxed). Block real websites as cheap
  // defense-in-depth — but a sandboxed attacker iframe ALSO sends "null", so the token
  // is what actually authenticates.
  const origin = info.origin;
  const originOk = !origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!originOk) return done(false, 403, "forbidden origin");
  // Host header must be loopback (mitigates DNS-rebinding, where Origin looks fine).
  const host = String(req.headers.host || "").split(":")[0].replace(/^\[|\]$/g, "");
  if (host && !LOOPBACK_HOSTS.has(host)) return done(false, 403, "forbidden host");
  // Token — the actual authentication.
  let token = "";
  try {
    token = new URL(req.url, "http://127.0.0.1").searchParams.get("token") || "";
  } catch (e) {}
  if (!safeEqual(token, TOKEN)) return done(false, 401, rejectBadToken(token));
  authFailures = 0; // a success clears the backoff — a mis-paste then a fix shouldn't stay penalised
  done(true);
}

// A browser WebSocket can never see an HTTP status: a handshake refused with 401 surfaces in the
// plugin as an opaque close 1006, byte-identical to "nothing is listening". So the plugin could not
// tell "start the bridge" from "re-paste the token", and showed one useless "offline" for both.
//
// For the plugin ONLY (its sandboxed iframe sends Origin "null"; a Node client sends none and CAN read
// the 401), a handshake that passed Origin + Host and failed on the TOKEN alone is admitted, flagged,
// and closed at once with an application close code the iframe can read. It is never registered as a
// client and gets no message handler, so it can neither receive a command nor send a result — what
// an unauthenticated caller gains over the 401 is one bit it already had ("a bridge is here").
// Origin/Host failures are still refused outright at the HTTP layer.
const CLOSE_BAD_TOKEN = 4401; // 4000-4999 is the range RFC 6455 reserves for applications

function admit(info, done) {
  verifyClient(info, (ok, code, msg) => {
    if (!ok && code === 401 && info.origin === "null") {
      info.req._dtwinBadToken = true;
      return done(true);
    }
    done(ok, code, msg);
  });
}

function createBridge(port = PORT) {
  // host: "127.0.0.1" keeps it strictly loopback. verifyClient authenticates every handshake
  // (Origin + Host + shared token). maxPayload bounds a single frame so a malformed/huge payload
  // can't OOM the process; 128 MB is ~2x a realistic asset-heavy full export, and an unusually large
  // file can raise it via FIGMA_BRIDGE_MAX_PAYLOAD_MB.
  const maxPayloadMb = Number(process.env.FIGMA_BRIDGE_MAX_PAYLOAD_MB) || 128;
  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: maxPayloadMb * 1024 * 1024, verifyClient: admit });

  // Print the token ONCE — on the run that mints it — and never again. It is stable from here on, the
  // plugin has it saved in clientStorage, and reprinting a live secret into terminal scrollback on
  // every single run is exactly the habit this store exists to end. `--show-token` reveals it on
  // demand; `--token-status` answers "which one is in play" without disclosing it.
  // A token that could not be resolved at require time (a mistyped --token-file) surfaces HERE, where
  // the caller's error handling can turn it into a one-line message instead of a module-load stack.
  // Before the port is bound, so a failed start leaves nothing listening.
  if (TOKEN_ERROR) throw TOKEN_ERROR;

  // Commit a freshly-minted token to disk now that one is actually being used. Resolution happened at
  // require time (deliberately without persisting); this is where it becomes permanent.
  if (TOKEN_INFO.source === "ephemeral") {
    try {
      const file = tokenStore.write(TOKEN);
      TOKEN_INFO = { ...TOKEN_INFO, source: "file", path: file, created: true };
    } catch (e) {
      TOKEN_INFO = { ...TOKEN_INFO, persistError: e };
    }
  }

  if (TOKEN_INFO.source === "token-file") {
    console.error(`[bridge] auth: token read from ${TOKEN_INFO.path} (${tokenStore.fingerprint(TOKEN)}).`);
  } else if (TOKEN_FROM_ENV) {
    console.error(`[bridge] auth: using FIGMA_BRIDGE_TOKEN from the environment (${tokenStore.fingerprint(TOKEN)}).`);
  } else if (TOKEN_INFO.created) {
    console.error("[bridge] auth token (paste into the plugin's \"Bridge token\" field): " + TOKEN);
    console.error(`[bridge] saved to ${TOKEN_INFO.path} — you won't be asked to paste it again.`);
    console.error("[bridge] see it later with `dtwin --show-token`; replace it with `dtwin --rotate-token`.");
  } else if (TOKEN_INFO.source === "ephemeral") {
    // Couldn't persist (read-only FS, no HOME, locked-down container). Still works — but say so,
    // because the user WILL have to paste again next run and deserves to know why.
    console.error("[bridge] auth token (paste into the plugin's \"Bridge token\" field): " + TOKEN);
    console.error(
      "[bridge] could not save it (" + errMsg(TOKEN_INFO.persistError) + ") — it changes every run. " +
        "Set FIGMA_BRIDGE_TOKEN to a stable value instead."
    );
  } else {
    console.error(`[bridge] auth: using the saved token from ${TOKEN_INFO.path} (${tokenStore.fingerprint(TOKEN)}).`);
    if (tokenStore.loosePerms(TOKEN_INFO.path)) {
      console.error(`[bridge] warning: ${TOKEN_INFO.path} is readable by other users — chmod 600 it.`);
    }
  }
  // MULTI-CLIENT registry. Every connected plugin instance gets an entry, keyed by a server-minted
  // `connId` — one Figma file per entry, so a design file and the library file it draws on can be
  // driven from the same bridge instead of stealing the socket from each other.
  //
  // Why the server mints the key rather than trusting the plugin: `figma.fileKey` is gated to private
  // plugins (undefined for an ordinary local import — `--whoami` reports which case you are in) and
  // `figma.root.name` is a human-editable display string that duplicated files share, so neither is a
  // dependable identity on its own. Both are RECORDED (they are what a human recognises in a listing,
  // and fileKey is genuinely unique when present) but the routing key is always ours. This mirrors the
  // Chrome DevTools Protocol shape — discover targets, then address a server-assigned id — rather than
  // the user-typed "channel name" other Figma bridges use, which has no uniqueness guarantee and
  // misroutes silently on a typo or a duplicate.
  const clients = new Map(); // connId -> { ws, connId, connectedAt, instanceId, file, fileKey, page }
  const pending = new Map(); // requestId -> { resolve, reject, connId }
  let seq = 0;
  let connSeq = 0;
  let takeovers = 0; // kept ONLY for the historical whoami field; nothing displaces anything now.
  let lastTakeoverAt = 0;

  wss.on("connection", (ws, req) => {
    // Admitted only to be told why it is refused (see `admit`). Before anything else: no registry
    // entry, no listeners. terminate() backs the close up in case the peer never completes it.
    if (req && req._dtwinBadToken) {
      ws.on("error", () => {});
      ws.close(CLOSE_BAD_TOKEN, "bad token");
      setTimeout(() => { try { ws.terminate(); } catch { /* already gone */ } }, 2000).unref();
      return;
    }
    // Every connection is kept. The previous single-socket rule terminated the incumbent here, which
    // made two open Figma files fight: the displaced plugin's 3s auto-reconnect immediately stole the
    // bridge back, and the two ping-ponged forever (observed live). Admitting both removes the
    // contention rather than arbitrating it.
    const connId = "c" + ++connSeq;
    const entry = { ws, connId, connectedAt: Date.now(), instanceId: null, file: null, fileKey: null, page: null, pluginVersion: null, lastActivity: Date.now() };
    ws._connId = connId;
    clients.set(connId, entry);
    console.error(`[bridge] plugin connected: ${connId} (${clients.size} connected).`);

    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        return;
      }
      // JSON.parse can return a non-object (null, number, string) — guard before reading .id so a
      // malformed frame (e.g. the literal `null`) can't throw an uncaught TypeError and kill the process.
      if (!msg || typeof msg !== "object") return;
      // ANY message from this client is a sign of life — recorded unconditionally, before the
      // type-specific handling below, so request()'s stall detector (see below) can tell "the plugin
      // is genuinely walking a big file and periodically reporting progress" from "nothing has been
      // heard from this socket since the command was sent", which a plain reply-or-timeout wait
      // cannot: findings 202/213 measured a 300s/908s silent wait, on a bridge that WAS connected, for
      // work that took 7.5-8.8s once a daemon kept the connection warm (finding 220).
      entry.lastActivity = Date.now();
      // An unsolicited progress frame relayed from the plugin's own UI (figma-plugin/src/progress.ts
      // posts these to the iframe DOM; ui.html forwards a bridge-triggered run's frames over this
      // socket too). Carries no request id — same rule as `hello` — and needs no reply; it exists
      // purely to keep `lastActivity` current during a long walk.
      if (msg.type === "progress") return;
      // Unsolicited identity announcement, sent by the plugin UI on connect AND on every reconnect.
      // Re-announcing is the whole point: identity is DERIVED from the environment each time rather
      // than issued by us and replayed, so a plugin that Figma tore down and re-ran comes back
      // correctly labelled without any resumable-session machinery. A `hello` carries no request id,
      // so it can never be confused with a reply.
      if (msg.type === "hello") {
        entry.instanceId = typeof msg.instanceId === "string" ? msg.instanceId : null;
        entry.file = typeof msg.file === "string" ? msg.file : null;
        entry.fileKey = typeof msg.fileKey === "string" && msg.fileKey ? msg.fileKey : null;
        entry.page = typeof msg.page === "string" ? msg.page : null;
        // Finding 327: the plugin's own build version (figma-plugin/package.json, baked in at build
        // time — see figma-plugin/build.js). `null` for a plugin bundle old enough to predate this
        // field entirely, which is itself a useful signal (definitely stale).
        entry.pluginVersion = typeof msg.pluginVersion === "string" && msg.pluginVersion ? msg.pluginVersion : null;
        const stalenessNote = pluginStalenessNote(entry.pluginVersion);
        console.error(`[bridge] ${connId} identified: ${JSON.stringify(entry.file || "(unnamed file)")}` +
          (entry.fileKey ? ` [fileKey ${entry.fileKey}]` : " [no fileKey — private-plugin API not in effect]") +
          ` [plugin v${entry.pluginVersion || "unknown"}]` + (stalenessNote ? ` — ${stalenessNote}` : ""));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "plugin error"));
    });
    // A socket error is the ONLY place the real cause of a mid-export disconnect shows up (most
    // importantly 1009 / "max payload size exceeded" when an export outgrows maxPayload). Swallowing
    // it — as this used to — left the close handler reporting a bare "disconnected", which is a
    // symptom, not a diagnosis. Keep the last error so close() can name the cause.
    let lastError = null;
    ws.on("error", (e) => { lastError = e; });
    ws.on("close", (code, reasonBuf) => {
      // Only forget THIS connection. Under the old single-socket rule the guard was `socket === ws`,
      // which did the same job by accident; with a registry it has to be explicit, or one file closing
      // its plugin window would drop the entry a different file is actively using.
      if (clients.get(connId) === entry) clients.delete(connId);
      const label = entry.file ? ` (${entry.file})` : "";
      console.error(`[bridge] plugin disconnected: ${connId}${label} (${clients.size} still connected).`);
      const reason = reasonBuf && reasonBuf.length ? reasonBuf.toString() : "";
      let why = `Figma plugin disconnected before replying (close ${code || "?"}${reason ? ": " + reason : ""}).`;
      if (lastError && lastError.message) why += ` socket error: ${lastError.message}.`;
      // 1009 is the one a caller can actually act on, and the likeliest failure on a big file:
      // the export outgrew the frame limit, so name the knob instead of making them find it.
      if (code === 1009 || /max payload|too large|too big/i.test((lastError && lastError.message) || "")) {
        why += ` The export exceeded the ${maxPayloadMb} MB frame limit — raise FIGMA_BRIDGE_MAX_PAYLOAD_MB,` +
               ` or pull less at once (a single page instead of --all-pages).`;
      } else if (!lastError) {
        // No socket error at all => the peer went away on its own: a plugin-side crash/OOM, or the
        // window was closed. That surfaces in Figma's console, not here — say so.
        why += ` No socket error was reported, so the plugin itself likely stopped (crash/OOM, or the` +
               ` window was closed). Check Plugins → Development → Open Console in Figma.`;
      }
      // Fail in-flight requests fast instead of hanging until their timeout — but ONLY the ones sent to
      // the socket that just died. Rejecting the whole map (as the single-client version did, when the
      // whole map could only ever belong to one socket) would now abort a long export running happily
      // in ANOTHER file because an unrelated one closed its plugin window.
      for (const [id, p] of pending) {
        if (p.connId !== connId) continue;
        pending.delete(id);
        p.reject(new Error(why));
      }
    });
  });

  wss.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") {
      console.error(
        `[bridge] port ${port} is already in use — another dtwin bridge or MCP server is running. ` +
          `Stop it first, or set FIGMA_BRIDGE_PORT to one of the other allowed ports ` +
          `(${ALLOWED_PORTS.filter((p) => p !== port).join(", ")}) — the plugin walks all three.`
      );
      process.exit(1);
    }
    console.error("[bridge] server error:", e.message);
  });

  const isLive = (e) => !!e && !!e.ws && e.ws.readyState === 1;
  const liveClients = () => [...clients.values()].filter(isLive);

  function isConnected() {
    return liveClients().length > 0;
  }

  // One connection, described for a human or an agent choosing between them. `describe` is what a
  // listing shows and what an ambiguity error quotes, so the two can never disagree about what a
  // client is called.
  const describe = (e) => ({
    connId: e.connId,
    file: e.file,
    fileKey: e.fileKey,
    page: e.page,
    instanceId: e.instanceId,
    connectedAt: e.connectedAt,
    uptimeMs: Date.now() - e.connectedAt,
    identified: !!e.instanceId,
    pluginVersion: e.pluginVersion || null,
    pluginStale: e.instanceId ? pluginStalenessNote(e.pluginVersion) : null,
  });

  function listClients() {
    return liveClients().map(describe);
  }

  // Which connection does a command go to? The rules, in order:
  //   no target + exactly one client  -> that one (the overwhelmingly common case: one file open)
  //   no target + several clients     -> REFUSE, and list them. Silently picking one would send an
  //                                      export to whichever file happened to connect first, write it
  //                                      to the caller's outDir, and look completely successful. adb
  //                                      makes the same call ("more than one device") for the same
  //                                      reason: guessing is worse than asking.
  //   target                          -> exact connId, then exact fileKey, then case-insensitive
  //                                      substring of the file name. A substring matching several
  //                                      files is refused rather than resolved to the first.
  function resolveClient(target) {
    const live = liveClients();
    if (!live.length) {
      throw new Error("Figma plugin not connected. Open the file in Figma and run the plugin.");
    }
    const list = () => live.map((e) => `  ${e.connId}  ${JSON.stringify(e.file || "(unidentified)")}${e.fileKey ? "  fileKey " + e.fileKey : ""}`).join("\n");
    if (target === undefined || target === null || target === "") {
      if (live.length === 1) return live[0];
      throw new Error(
        `${live.length} Figma files are connected to the bridge — say which one to use.\n${list()}\n` +
        `Pass the connId, the fileKey, or part of the file name (CLI: --client <id|name>; MCP: client: "<id|name>").`
      );
    }
    const t = String(target);
    const byId = live.find((e) => e.connId === t);
    if (byId) return byId;
    const byKey = live.find((e) => e.fileKey && e.fileKey === t);
    if (byKey) return byKey;
    const lower = t.toLowerCase();
    const byName = live.filter((e) => e.file && e.file.toLowerCase().includes(lower));
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new Error(
        `'${t}' matches ${byName.length} connected files — be more specific, or use the connId.\n${list()}`
      );
    }
    throw new Error(`no connected Figma file matches '${t}'. Connected:\n${list()}`);
  }

  // Server-side half of the whoami probe. The plugin reports who IT is (instanceId, file, fileKey);
  // this reports what the SOCKETS did. `takeovers` is retained and always 0 now that connections
  // coexist — kept rather than removed so an older reader of this field sees "no displacement is
  // happening" instead of the key vanishing.
  function connectionInfo() {
    const live = liveClients();
    const first = live[0];
    return {
      connId: first ? first.connId : null,
      connected: live.length > 0,
      connectedAt: first ? first.connectedAt : null,
      connectionUptimeMs: first ? Date.now() - first.connectedAt : 0,
      connectionsThisRun: connSeq,
      clientsConnected: live.length,
      clients: live.map(describe),
      takeovers,
      lastTakeoverAt: lastTakeoverAt || null,
    };
  }

  // `target` is optional and LAST so every existing three-argument call site keeps working unchanged:
  // with one file connected it resolves to that file, which is exactly what it did before.
  // `stallMs` (opt-in — undefined leaves today's behaviour untouched for every existing caller,
  // including the daemon and MCP paths) is a SEPARATE, SHORTER wait for any sign of life from this
  // specific client, checked independently of the real per-command timeout: findings 202/213 measured
  // a 300s/908s silent wait — on a connected, identified bridge — for work finding 220 proved takes
  // 7.5-8.8s once a daemon keeps the plugin warm. A stalled one-shot connection (the shape those two
  // findings share: no `dtwin serve` running) shows NO activity at all on the socket — not even a
  // progress frame — for the whole wait, where a genuinely large/slow export keeps resetting
  // `lastActivity` via the periodic progress relay (see the `ws.on("message")` handler above). Only
  // figma-pull.js's own one-shot bridge (no daemon) opts into this, and only for export-class
  // commands — a cheap `whoami`/`list` finishing in under a second never needs it, and the daemon path
  // deliberately does NOT pass it: a persistent connection is exactly the case finding 220 shows is
  // already fast, so there is nothing here worth protecting against on that path.
  const STALL_POLL_MS = 500;
  function request(cmd, args, timeoutMs = TIMEOUTS.command, target, stallMs) {
    return new Promise((resolve, reject) => {
      let client;
      try {
        client = resolveClient(target);
      } catch (e) {
        return reject(e);
      }
      const id = "r" + ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          // We only get here AFTER isConnected() passed and the command was sent, so the socket is
          // up and the file IS open — never blame those. The real causes are a slow export (big
          // file / --all-pages) or a plugin-side throw, which surfaces in the plugin window, not here.
          reject(new Error(
            `the Figma plugin connected but did not answer '${cmd}' within ${Math.round(timeoutMs / 1000)}s. ` +
            `A large file (especially --all-pages) can legitimately take longer — from the dtwin CLI, ` +
            `retry with --timeout <seconds>; from MCP, export one page at a time (page:[id]) rather than the whole file. ` +
            `If it never finishes, check the plugin window for a red error.`
          ));
        }
      }, timeoutMs);
      let stallTimer = null;
      if (typeof stallMs === "number" && stallMs > 0) {
        const sentAt = Date.now();
        stallTimer = setInterval(() => {
          if (!pending.has(id)) return; // settled already — the interval's own clear below is racing it
          const quiet = Date.now() - Math.max(client.lastActivity, sentAt);
          if (quiet < stallMs) return;
          pending.delete(id);
          clearInterval(stallTimer);
          clearTimeout(timer);
          const node = args && (args.nodeId || args.node) ? ` (node ${args.nodeId || args.node})` : "";
          reject(new Error(
            `no response from the Figma plugin${node} for '${cmd}' in ${Math.round(stallMs / 1000)}s, and no progress was reported either — ` +
            `this is the shape a missing \`dtwin serve\` daemon produces (every command opens a fresh bridge and the plugin's reconnect is what actually takes ` +
            `the time, not the export itself). Run \`dtwin serve\` in a background terminal and retry, or \`dtwin doctor\` to confirm. ` +
            `Still stuck with a daemon running? check the plugin window in Figma for a red error — this stall check does not apply there.`
          ));
        }, STALL_POLL_MS);
      }
      // Clear the timer once the request settles, so a resolved/rejected request doesn't
      // leave a live 2-minute timer (and its closure) armed until it harmlessly fires.
      // connId is recorded so the close handler can fail exactly this client's in-flight work and
      // leave every other file's alone.
      pending.set(id, {
        connId: client.connId,
        resolve: (v) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); resolve(v); },
        reject: (e) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); reject(e); },
      });
      client.ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  function waitForConnection(timeoutMs = TIMEOUTS.command, pollMs = 400) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        if (isConnected()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for the plugin to connect"));
        setTimeout(poll, pollMs);
      })();
    });
  }

  // A socket being open is not the same as it being IDENTIFIED: the plugin's `hello` (which carries
  // `file`, used by --client <name>) arrives a beat after the WebSocket handshake, not in the same
  // tick. Resolving a name-based --client the instant waitForConnection settles was a coin flip
  // (finding 216: "one run in four failed ... the plugin's identified message has not arrived yet"),
  // because `resolveClient` can only match `file` on entries that already have it. This waits (briefly
  // — plugin identification is sub-second once connected) for at least one live client to be
  // identified, OR for `timeoutMs` to elapse, whichever comes first; it never rejects — callers still
  // get whatever resolveClient() decides afterwards, including its own honest error.
  function waitForIdentified(timeoutMs = 3000, pollMs = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        const live = liveClients();
        if (!live.length || live.some((e) => e.instanceId)) return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        setTimeout(poll, pollMs);
      })();
    });
  }

  // Shut the server down so the process can exit ON ITS OWN. Without this a caller's only way out was
  // process.exit(), which on a PIPE discards whatever stdout hasn't flushed — Node's stdout is async
  // for pipes, so a large `--list` payload was silently cut at one 64KB pipe buffer (measured:
  // 369,799 bytes written, 65,536 delivered). Letting the event loop drain instead is the only fix
  // that keeps the whole payload; the WS server is what was holding the loop open, so it has to go.
  function close() {
    for (const p of pending.values()) p.reject(new Error("bridge closed"));
    pending.clear();
    // Close EVERY client, not just the one that used to be `socket` — otherwise a second connected
    // file would hold the event loop open and the process would never exit on its own, which is the
    // whole reason this function exists.
    for (const e of clients.values()) { try { e.ws.close(); } catch { /* already gone */ } }
    clients.clear();
    try { wss.close(); } catch { /* already closing */ }
  }

  return { request, isConnected, waitForConnection, waitForIdentified, connectionInfo, listClients, resolveClient, close, port };
}

// verifyClient/safeEqual are exported for the test suite (test/bridge.test.js). They are the bridge's
// ONLY real access control, so they get direct unit coverage rather than being reachable only through
// a live WebSocket handshake.
module.exports = { createBridge, verifyClient, authStats, CLOSE_BAD_TOKEN, safeEqual, TIMEOUTS, exportTimeout, errMsg, ALLOWED_PORTS, tokenStore, BRIDGE_VERSION, pluginStalenessNote, daemonRowStalenessNote };
