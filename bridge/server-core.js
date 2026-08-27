// Shared bridge core: hosts a localhost WebSocket server that the Figma plugin's
// hidden UI iframe connects to, and correlates request/response by id.
// Used by both figma-pull (CLI, read) and figma-mcp (write server).
//
// The plugin is always the WebSocket CLIENT (a browser iframe cannot listen);
// this process is the SERVER. Loopback only — no internet exposure.

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

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

// Shared secret the plugin must present as ?token=... on connect. Prefer a stable
// value via FIGMA_BRIDGE_TOKEN (paste once into the plugin); otherwise a per-run
// token is generated and printed. This is the REAL access control: loopback binding
// and the Origin check below are both defeatable — a sandboxed attacker iframe on any
// site the user visits also sends "Origin: null" — so without the token any local
// page/process could drive the plugin. See AgentSeal's Figma-MCP CSWSH writeup.
const TOKEN = process.env.FIGMA_BRIDGE_TOKEN || crypto.randomBytes(24).toString("hex");
const TOKEN_FROM_ENV = !!process.env.FIGMA_BRIDGE_TOKEN;

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

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

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
  if (!safeEqual(token, TOKEN)) return done(false, 401, "bad or missing token");
  done(true);
}

function createBridge(port = PORT) {
  // host: "127.0.0.1" keeps it strictly loopback. verifyClient authenticates every handshake
  // (Origin + Host + shared token). maxPayload bounds a single frame so a malformed/huge payload
  // can't OOM the process; 128 MB is ~2x a realistic asset-heavy full export, and an unusually large
  // file can raise it via FIGMA_BRIDGE_MAX_PAYLOAD_MB.
  const maxPayloadMb = Number(process.env.FIGMA_BRIDGE_MAX_PAYLOAD_MB) || 128;
  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: maxPayloadMb * 1024 * 1024, verifyClient });

  if (TOKEN_FROM_ENV) {
    console.error("[bridge] auth: using FIGMA_BRIDGE_TOKEN from the environment.");
  } else {
    console.error("[bridge] auth token (paste into the plugin's \"Bridge token\" field): " + TOKEN);
    console.error("[bridge] tip: set FIGMA_BRIDGE_TOKEN to a stable value to avoid re-pasting on each run.");
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

  wss.on("connection", (ws) => {
    // Every connection is kept. The previous single-socket rule terminated the incumbent here, which
    // made two open Figma files fight: the displaced plugin's 3s auto-reconnect immediately stole the
    // bridge back, and the two ping-ponged forever (observed live). Admitting both removes the
    // contention rather than arbitrating it.
    const connId = "c" + ++connSeq;
    const entry = { ws, connId, connectedAt: Date.now(), instanceId: null, file: null, fileKey: null, page: null };
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
        console.error(`[bridge] ${connId} identified: ${JSON.stringify(entry.file || "(unnamed file)")}` +
          (entry.fileKey ? ` [fileKey ${entry.fileKey}]` : " [no fileKey — private-plugin API not in effect]"));
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
  function request(cmd, args, timeoutMs = TIMEOUTS.command, target) {
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
      // Clear the timer once the request settles, so a resolved/rejected request doesn't
      // leave a live 2-minute timer (and its closure) armed until it harmlessly fires.
      // connId is recorded so the close handler can fail exactly this client's in-flight work and
      // leave every other file's alone.
      pending.set(id, {
        connId: client.connId,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
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

  return { request, isConnected, waitForConnection, connectionInfo, listClients, resolveClient, close, port };
}

// verifyClient/safeEqual are exported for the test suite (test/bridge.test.js). They are the bridge's
// ONLY real access control, so they get direct unit coverage rather than being reachable only through
// a live WebSocket handshake.
module.exports = { createBridge, verifyClient, safeEqual, TIMEOUTS, exportTimeout, errMsg, ALLOWED_PORTS };
