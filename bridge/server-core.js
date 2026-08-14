// Shared bridge core: hosts a localhost WebSocket server that the Figma plugin's
// hidden UI iframe connects to, and correlates request/response by id.
// Used by both figma-pull (CLI, read) and figma-mcp (write server).
//
// The plugin is always the WebSocket CLIENT (a browser iframe cannot listen);
// this process is the SERVER. Loopback only — no internet exposure.

const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = Number(process.env.FIGMA_BRIDGE_PORT || 8787);

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
  let socket = null;
  const pending = new Map();
  let seq = 0;

  wss.on("connection", (ws) => {
    // Keep only the most recent plugin connection. Reassign `socket` FIRST so the stale socket's
    // close handler (guarded by `socket === ws`) won't clear the new connection's pending requests,
    // then terminate the stale one so it doesn't leak.
    const stale = socket;
    socket = ws;
    if (stale && stale !== ws) { try { stale.terminate(); } catch (e) {} }
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
      if (socket === ws) {
        socket = null;
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
        // Fail in-flight requests fast instead of hanging until their timeout.
        for (const p of pending.values()) p.reject(new Error(why));
        pending.clear();
      }
    });
  });

  wss.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") {
      console.error(
        `[bridge] port ${port} is already in use — another figma-pull or figma-mcp bridge is running. ` +
          "Stop it first, or set FIGMA_BRIDGE_PORT to a free port."
      );
      process.exit(1);
    }
    console.error("[bridge] server error:", e.message);
  });

  function isConnected() {
    return !!socket && socket.readyState === 1;
  }

  function request(cmd, args, timeoutMs = TIMEOUTS.command) {
    return new Promise((resolve, reject) => {
      if (!isConnected()) {
        return reject(new Error("Figma plugin not connected. Open the file in Figma and run the plugin."));
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
            `A large file (especially --all-pages) can legitimately take longer — from the figma-pull CLI, ` +
            `retry with --timeout <seconds>; from MCP, export one page at a time (page:[id]) rather than the whole file. ` +
            `If it never finishes, check the plugin window for a red error.`
          ));
        }
      }, timeoutMs);
      // Clear the timer once the request settles, so a resolved/rejected request doesn't
      // leave a live 2-minute timer (and its closure) armed until it harmlessly fires.
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      socket.send(JSON.stringify({ id, cmd, args }));
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
    if (socket) { try { socket.close(); } catch { /* already gone */ } socket = null; }
    try { wss.close(); } catch { /* already closing */ }
  }

  return { request, isConnected, waitForConnection, close, port };
}

// verifyClient/safeEqual are exported for the test suite (test/bridge.test.js). They are the bridge's
// ONLY real access control, so they get direct unit coverage rather than being reachable only through
// a live WebSocket handshake.
module.exports = { createBridge, verifyClient, safeEqual, TIMEOUTS, exportTimeout, errMsg };
