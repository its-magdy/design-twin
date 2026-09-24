// Shared bridge core: hosts a localhost WebSocket server that the Figma plugin's
// hidden UI iframe connects to, and correlates request/response by id.
// Used by both figma-pull (CLI, read) and figma-mcp (write server).
//
// The plugin is always the WebSocket CLIENT (a browser iframe cannot listen);
// this process is the SERVER. Loopback only — no internet exposure.

import { WebSocketServer, WebSocket } from "ws";
import type { RawData, VerifyClientCallbackAsync } from "ws";
import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
import * as tokenStore from "./token-store.ts";
import type { ResolvedToken } from "./token-store.ts";
import { errMsg } from "./errmsg.ts";
import { TIMEOUTS, exportTimeout } from "./timeouts.ts";
// The ONLY ports the plugin can reach (its manifest's allowedDomains) — shared with doctor.ts.
import { ALLOWED_PORTS } from "./ports.ts";
// The command/reply contract shared with the plugin: `request()` is typed per command from it, and
// every reply is checked against it once, at the point it enters this process (see the message handler).
import { replyShapeError } from "./commands.ts";
import type { Cmd, Commands } from "./commands.ts";

// Finding 327 (BRIDGE_VERSION, pluginStalenessNote, daemonRowStalenessNote) lives in staleness.ts so
// the CLI's pure helpers and doctor.ts can use it without loading this module; re-exported below so
// this module's surface is unchanged.
import { BRIDGE_VERSION, pluginStalenessNote, daemonRowStalenessNote } from "./staleness.ts";

// The async (two-argument) verifyClient form is the only one this file uses; name its two halves.
type VerifyClientInfo = Parameters<VerifyClientCallbackAsync>[0];
type VerifyClientCallback = Parameters<VerifyClientCallbackAsync>[1];

// FIGMA_BRIDGE_PORT is a choice of three (ports.ts), not a free number.
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
// token-store.ts owns everything ABOUT the token that isn't this handshake: the precedence
// (--token-file > env > stored file > mint), the per-OS path, and the file's 0600 mode. It is
// resolved once here at require time, so the tests that set FIGMA_BRIDGE_TOKEN before requiring this
// module still get exactly that token.
//
// `persist: false` here on purpose: requiring this module must not have the side effect of CREATING
// a token file. `dtwin --token-status` requires it just to ask a question, and a status command that
// silently mints the thing it is reporting on would be lying. The mint is committed in createBridge
// instead — the moment a token is actually about to be used.
// Resolution happens at REQUIRE time, so a bad --token-file would otherwise throw out of a module
// load — a raw stack trace, before either front-end has error handling of any kind in scope, for what is
// just a mistyped path. Hold the failure instead and re-throw it from createBridge, which every
// caller already funnels into its own "[dtwin] error: …" + exit 1 path. Commands that never open a
// bridge (--token-status) then keep working, which is exactly when you want to diagnose this.
// "error" is this module's own marker for a resolution that threw (TOKEN_ERROR holds why); every other
// source is token-store's.
type TokenInfo = Omit<ResolvedToken, "token" | "source"> & { token: string | null; source: ResolvedToken["source"] | "error" };
let TOKEN_INFO: TokenInfo;
let TOKEN_ERROR: unknown = null;
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

// Per-COMMAND time budgets (TIMEOUTS) and the scope -> tier rule (exportTimeout) live in timeouts.ts,
// so figma-pull.ts's pure parseArgs can read them without loading this module; re-exported below.

// Thrown value -> message string. Re-exported (not redefined) so both front-ends and the plugin
// bundle share the one definition in errmsg.ts.

// Compare the SHA-256 digests, not the raw tokens. timingSafeEqual throws on unequal lengths, so the
// previous `ba.length === bb.length && ...` guard short-circuited before the constant-time compare
// and leaked the token's LENGTH through timing. Hashing first makes both sides a fixed 32 bytes, so
// every comparison takes the same path regardless of what was presented.
// Strings only: an earlier `unknown` signature ran String() on both sides, so a null TOKEN (a failed
// resolution) would have compared equal to the literal token "null". The expected token is narrowed
// to a real string once, in createBridge, and threaded through verifyClientWith below.
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
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
let lastBadToken: { at: number; fingerprint: string | null } | null = null;
const AUTH_LOG_INTERVAL_MS = 30000;

function rejectBadToken(presented: string, expected: string): string {
  authFailures++;
  lastBadToken = { at: Date.now(), fingerprint: presented ? tokenStore.fingerprint(presented) : null };
  const now = Date.now();
  if (now - lastAuthLog > AUTH_LOG_INTERVAL_MS) {
    lastAuthLog = now;
    const detail = presented
      ? `presented ${tokenStore.fingerprint(presented)}, expected ${tokenStore.fingerprint(expected)}`
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

// The part of ws's verifyClient `info` this reads — a real VerifyClientInfo satisfies it, and so does the
// hand-built object the test suite drives it with.
interface HandshakeInfo {
  origin?: string;
  req: { url?: string; headers: { host?: string } };
}

/** The handshake check, bound to the ONE expected token. */
type VerifyClient = (info: HandshakeInfo, done: VerifyClientCallback) => void;

// Runs during the WS handshake, before the connection is accepted. A factory, so the expected token
// is a real string by construction (createBridge narrows it once) rather than a module-level
// `string | null` every comparison has to trust.
function verifyClientWith(token: string): VerifyClient {
  return (info, done) => verifyClientAgainst(token, info, done);
}

function verifyClientAgainst(expected: string, info: HandshakeInfo, done: VerifyClientCallback): void {
  const req = info.req;
  // Origin: the plugin iframe sends "null" (sandboxed). Block real websites as cheap
  // defense-in-depth — but a sandboxed attacker iframe ALSO sends "null", so the token
  // is what actually authenticates.
  const origin = info.origin;
  const originOk = !origin || origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!originOk) return done(false, 403, "forbidden origin");
  // Host header must be loopback (mitigates DNS-rebinding, where Origin looks fine). Parsed by URL, not
  // split on ":" — splitting "[::1]:8787" yielded "[", stripped to "", and an empty host SKIPPED the
  // check, so any bracketed IPv6 Host passed. URL strips the port and lowercases; its hostname keeps
  // IPv6 brackets ("[::1]"), dropped here to match LOOPBACK_HOSTS. FAIL-CLOSED: a missing or
  // unparseable Host is refused — HTTP/1.1 requires one (RFC 7230 §5.4) and every WS client sends it.
  let host = "";
  try {
    host = new URL("http://" + (req.headers.host || "")).hostname.replace(/^\[|\]$/g, "");
  } catch { /* unparseable: stays "", refused below */ }
  if (!host || !LOOPBACK_HOSTS.has(host)) return done(false, 403, "forbidden host");
  // Token — the actual authentication.
  let token = "";
  try {
    token = new URL(String(req.url), "http://127.0.0.1").searchParams.get("token") || "";
  } catch { /* unparseable URL: no token presented */ }
  if (!safeEqual(token, expected)) return done(false, 401, rejectBadToken(token, expected));
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

// The upgrade requests `admit` let through ONLY to be closed with CLOSE_BAD_TOKEN. A WeakSet rather
// than a flag written onto the request object: nothing else ever needs to see the mark.
const badTokenRequests = new WeakSet<IncomingMessage>();

// ---- the plugin <-> bridge protocol, as this module sees it.

/** One frame from the plugin (figma-plugin/ui.html), after parsePluginFrame: a `hello` identity
 *  announcement, an unsolicited `progress` tick, or the reply to one command (`{id, ok, result, error}`).
 *  Anything else — a non-object, a reply whose id is not a string — is dropped (null). */
type PluginFrame =
  | { type: "progress" }
  | { type: "hello"; instanceId: string | null; file: string | null; fileKey: string | null; page: string | null; pluginVersion: string | null }
  | { type: "reply"; id: string; ok: boolean; result: unknown; error: unknown };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function parsePluginFrame(parsed: unknown): PluginFrame | null {
  // JSON.parse can return a non-object (null, number, string) — guard before reading .id so a
  // malformed frame (e.g. the literal `null`) can't throw an uncaught TypeError and kill the process.
  if (!isRecord(parsed)) return null;
  const m = parsed;
  if (m.type === "progress") return { type: "progress" };
  if (m.type === "hello") {
    return { type: "hello", instanceId: str(m.instanceId), file: str(m.file), fileKey: str(m.fileKey), page: str(m.page), pluginVersion: str(m.pluginVersion) };
  }
  // Request ids are always strings ("r<N>"), so a frame whose id is anything else matches nothing.
  if (typeof m.id !== "string") return null;
  return { type: "reply", id: m.id, ok: !!m.ok, result: m.result, error: m.error };
}

/** One registry entry: a connected plugin socket plus what its `hello` said. */
interface ClientEntry {
  ws: WebSocket;
  connId: string;
  connectedAt: number;
  instanceId: string | null;
  file: string | null;
  fileKey: string | null;
  page: string | null;
  pluginVersion: string | null;
  lastActivity: number;
}

/** One connection as `describe()` presents it — the rows of listClients(), figma_list_clients and `dtwin list clients`. */
export interface ClientRow {
  connId: string;
  file: string | null;
  fileKey: string | null;
  page: string | null;
  instanceId: string | null;
  connectedAt: number;
  uptimeMs: number;
  identified: boolean;
  pluginVersion: string | null;
  pluginStale: string | null;
}

/** connectionInfo(): the socket half of `whoami`. */
export interface ConnectionInfo {
  connId: string | null;
  connected: boolean;
  connectedAt: number | null;
  connectionUptimeMs: number;
  connectionsThisRun: number;
  clientsConnected: number;
  clients: ClientRow[];
  takeovers: number;
  lastTakeoverAt: number | null;
}

interface PendingRequest {
  connId: string;
  /** which command was sent — what the reply is checked against, and what the check's error names */
  cmd: Cmd;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** What a request resolved with, plus WHICH connected file answered it (the client resolveClient picked). */
export interface RequestOutcome<C extends Cmd> {
  reply: Commands[C]["reply"];
  client: ClientRow;
}

// ws's per-socket connId, kept off the socket object itself.
const connIds = new WeakMap<WebSocket, string>();

function admitWith(token: string): (info: VerifyClientInfo, done: VerifyClientCallback) => void {
  const verify = verifyClientWith(token);
  return (info, done) => {
    verify(info, (ok, code, msg) => {
      if (!ok && code === 401 && info.origin === "null") {
        badTokenRequests.add(info.req);
        return done(true);
      }
      done(ok, code, msg);
    });
  };
}

/** createBridge options. `onListenError` is for a caller that must SURVIVE a failed bind (the MCP
 * server: a held port is a tool error there, not a reason to kill the stdio session). Without it, a
 * held port prints the fix and exits 1 — the CLI behaviour, unchanged. */
interface BridgeOptions {
  onListenError?: (e: Error) => void;
}

function createBridge(port: number = PORT, opts: BridgeOptions = {}) {
  // Print the token ONCE — on the run that mints it — and never again. It is stable from here on, the
  // plugin has it saved in clientStorage, and reprinting a live secret into terminal scrollback on
  // every single run is exactly the habit this store exists to end. `--show-token` reveals it on
  // demand; `--token-status` answers "which one is in play" without disclosing it.
  // A token that could not be resolved at require time (a mistyped --token-file) surfaces HERE, where
  // the caller's error handling can turn it into a one-line message instead of a module-load stack.
  // Before the server is even constructed, so a failed start leaves nothing listening — and so the
  // token every handshake is checked against is a real string from here on (the `null` case IS the
  // resolution error; there is no bridge without a token).
  if (TOKEN_ERROR) throw TOKEN_ERROR;
  if (TOKEN === null) throw new Error("no bridge token could be resolved");
  const token: string = TOKEN;

  // host: "127.0.0.1" keeps it strictly loopback. verifyClient authenticates every handshake
  // (Origin + Host + shared token). maxPayload bounds a single frame so a malformed/huge payload
  // can't OOM the process; 128 MB is ~2x a realistic asset-heavy full export, and an unusually large
  // file can raise it via FIGMA_BRIDGE_MAX_PAYLOAD_MB.
  const maxPayloadMb = Number(process.env.FIGMA_BRIDGE_MAX_PAYLOAD_MB) || 128;
  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: maxPayloadMb * 1024 * 1024, verifyClient: admitWith(token) });

  // Commit a freshly-minted token to disk now that one is actually being used. Resolution happened at
  // require time (deliberately without persisting); this is where it becomes permanent.
  if (TOKEN_INFO.source === "ephemeral") {
    try {
      const file = tokenStore.write(token);
      TOKEN_INFO = { ...TOKEN_INFO, source: "file", path: file, created: true };
    } catch (e) {
      TOKEN_INFO = { ...TOKEN_INFO, persistError: e };
    }
  }

  if (TOKEN_INFO.source === "token-file") {
    console.error(`[bridge] auth: token read from ${TOKEN_INFO.path} (${tokenStore.fingerprint(token)}).`);
  } else if (TOKEN_FROM_ENV) {
    console.error(`[bridge] auth: using FIGMA_BRIDGE_TOKEN from the environment (${tokenStore.fingerprint(token)}).`);
  } else if (TOKEN_INFO.created) {
    console.error("[bridge] auth token (paste into the plugin's \"Bridge token\" field): " + token);
    console.error(`[bridge] saved to ${TOKEN_INFO.path} — you won't be asked to paste it again.`);
    console.error("[bridge] see it later with `dtwin --show-token`; replace it with `dtwin --rotate-token`.");
  } else if (TOKEN_INFO.source === "ephemeral") {
    // Couldn't persist (read-only FS, no HOME, locked-down container). Still works — but say so,
    // because the user WILL have to paste again next run and deserves to know why.
    console.error("[bridge] auth token (paste into the plugin's \"Bridge token\" field): " + token);
    console.error(
      "[bridge] could not save it (" + errMsg(TOKEN_INFO.persistError) + ") — it changes every run. " +
        "Set FIGMA_BRIDGE_TOKEN to a stable value instead."
    );
  } else {
    console.error(`[bridge] auth: using the saved token from ${TOKEN_INFO.path} (${tokenStore.fingerprint(token)}).`);
    if (TOKEN_INFO.path !== null && tokenStore.loosePerms(TOKEN_INFO.path)) {
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
  const clients = new Map<string, ClientEntry>(); // connId -> { ws, connId, connectedAt, instanceId, file, fileKey, page }
  const pending = new Map<string, PendingRequest>(); // requestId -> { resolve, reject, connId }
  let seq = 0;
  let connSeq = 0;
  let takeovers = 0; // kept ONLY for the historical whoami field; nothing displaces anything now.
  let lastTakeoverAt = 0;

  wss.on("connection", (ws, req) => {
    // Admitted only to be told why it is refused (see `admit`). Before anything else: no registry
    // entry, no listeners. terminate() backs the close up in case the peer never completes it.
    if (req && badTokenRequests.has(req)) {
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
    const entry: ClientEntry = { ws, connId, connectedAt: Date.now(), instanceId: null, file: null, fileKey: null, page: null, pluginVersion: null, lastActivity: Date.now() };
    connIds.set(ws, connId);
    clients.set(connId, entry);
    console.error(`[bridge] plugin connected: ${connId} (${clients.size} connected).`);

    ws.on("message", (data: RawData, isBinary: boolean) => {
      // The plugin only ever sends text frames (JSON.stringify in ui.html). ws hands the payload over
      // as a Buffer, an ArrayBuffer or a Buffer[] depending on how it arrived — decode each explicitly
      // rather than trusting `.toString()` on a shape it does not have.
      if (isBinary) return;
      const text = Buffer.isBuffer(data) ? data.toString("utf8")
        : Array.isArray(data) ? Buffer.concat(data).toString("utf8")
        : Buffer.from(data).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return;
      }
      const msg = parsePluginFrame(parsed);
      if (!msg) return;
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
        entry.instanceId = msg.instanceId;
        entry.file = msg.file;
        entry.fileKey = msg.fileKey;
        entry.page = msg.page;
        // Finding 327: the plugin's own build version (figma-plugin/package.json, baked in at build
        // time — see figma-plugin/build.js). `null` for a plugin bundle old enough to predate this
        // field entirely, which is itself a useful signal (definitely stale).
        entry.pluginVersion = msg.pluginVersion;
        const stalenessNote = pluginStalenessNote(entry.pluginVersion);
        console.error(`[bridge] ${connId} identified: ${JSON.stringify(entry.file || "(unnamed file)")}` +
          (entry.fileKey ? ` [fileKey ${entry.fileKey}]` : " [no fileKey — private-plugin API not in effect]") +
          ` [plugin v${entry.pluginVersion || "unknown"}]` + (stalenessNote ? ` — ${stalenessNote}` : ""));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (!msg.ok) return p.reject(new Error(String(msg.error || "plugin error")));
      // The ONE place a reply enters this process, so the ONE place its shape is checked against the
      // contract (commands.ts). A plugin that answers `listPages` with something that has no `pages`
      // — an older bundle, a half-migrated command — fails HERE, named, instead of as a TypeError in
      // whichever reader touches the missing field first.
      const bad = replyShapeError(p.cmd, msg.result);
      if (bad) return p.reject(new Error(`plugin replied with an unexpected shape for ${p.cmd}: ${bad}`));
      p.resolve(msg.result);
    });
    // A socket error is the ONLY place the real cause of a mid-export disconnect shows up (most
    // importantly 1009 / "max payload size exceeded" when an export outgrows maxPayload). Swallowing
    // it — as this used to — left the close handler reporting a bare "disconnected", which is a
    // symptom, not a diagnosis. Keep the last error so close() can name the cause.
    let lastError: Error | null = null;
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

  // Resolves once the port is bound. Never rejects: a bind failure goes to onListenError (or exits),
  // so a caller that only wants "is it up yet" cannot leak an unhandled rejection.
  let bound = false;
  const listening = new Promise<void>((resolve) => wss.once("listening", () => { bound = true; resolve(); }));

  wss.on("error", (e) => {
    if (e && (e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const msg =
        `[bridge] port ${port} is already in use — another dtwin bridge or MCP server is running. ` +
        `Stop it first, or set FIGMA_BRIDGE_PORT to one of the other allowed ports ` +
        `(${ALLOWED_PORTS.filter((p) => p !== port).join(", ")}) — the plugin walks all three.`;
      if (opts.onListenError) return opts.onListenError(new Error(msg));
      console.error(msg);
      process.exit(1);
    }
    // Any other failure to BIND (EACCES, …) is the same "no bridge" for such a caller; after the bind,
    // a server error is only logged, as before.
    if (opts.onListenError && !bound) return opts.onListenError(e);
    console.error("[bridge] server error:", e.message);
  });

  const isLive = (e: ClientEntry | undefined): e is ClientEntry => !!e && !!e.ws && e.ws.readyState === WebSocket.OPEN;
  const liveClients = () => [...clients.values()].filter(isLive);

  function isConnected(): boolean {
    return liveClients().length > 0;
  }

  // One connection, described for a human or an agent choosing between them. `describe` is what a
  // listing shows and what an ambiguity error quotes, so the two can never disagree about what a
  // client is called.
  const describe = (e: ClientEntry): ClientRow => ({
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

  function listClients(): ClientRow[] {
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
  function resolveClient(target?: unknown): ClientEntry {
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
  function connectionInfo(): ConnectionInfo {
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
  // figma-pull.ts's own one-shot bridge (no daemon) opts into this, and only for export-class
  // commands — a cheap `whoami`/`list` finishing in under a second never needs it, and the daemon path
  // deliberately does NOT pass it: a persistent connection is exactly the case finding 220 shows is
  // already fast, so there is nothing here worth protecting against on that path.
  const STALL_POLL_MS = 500;
  // Typed per command from commands.ts: `args` is what the plugin reads for `cmd`, and the reply is
  // what it sends back — checked structurally on arrival (the message handler above), so the type
  // here is a promise the runtime keeps rather than a cast.
  function request<C extends Cmd>(cmd: C, args: Commands[C]["args"], timeoutMs: number = TIMEOUTS.command, target?: string | null, stallMs?: number): Promise<Commands[C]["reply"]> {
    return requestWithClient(cmd, args, timeoutMs, target, stallMs).then((o) => o.reply);
  }

  // The same, also answering WHICH connected file the command went to — the client resolveClient
  // picked for `target`, described exactly as listClients() would. figma-pull.ts stamps that onto a
  // screen export as `sourceFile` (P4 #33); it used to re-implement the matching rules to find out.
  function requestWithClient<C extends Cmd>(cmd: C, args: Commands[C]["args"], timeoutMs: number = TIMEOUTS.command, target?: string | null, stallMs?: number): Promise<RequestOutcome<C>> {
    return new Promise<RequestOutcome<C>>((resolve, reject) => {
      let client: ClientEntry;
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
      let stallTimer: ReturnType<typeof setInterval> | null = null;
      if (typeof stallMs === "number" && stallMs > 0) {
        const sentAt = Date.now();
        stallTimer = setInterval(() => {
          if (!pending.has(id)) return; // settled already — the interval's own clear below is racing it
          const quiet = Date.now() - Math.max(client.lastActivity, sentAt);
          if (quiet < stallMs) return;
          pending.delete(id);
          if (stallTimer) clearInterval(stallTimer);
          clearTimeout(timer);
          const nodeId = "nodeId" in args && typeof args.nodeId === "string" ? args.nodeId : "";
          const node = nodeId ? ` (node ${nodeId})` : "";
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
      // `resolve` takes the reply as `unknown`: the message handler has already checked it against
      // this command's shape (replyShapeError) before it gets here, which is what makes the typed
      // promise honest. The one assertion below is that hand-off, not a guess about the plugin.
      const settle = (v: unknown) => resolve({ reply: v as Commands[C]["reply"], client: describe(client) });
      pending.set(id, {
        connId: client.connId,
        cmd,
        resolve: (v) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); settle(v); },
        reject: (e) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); reject(e); },
      });
      client.ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  function waitForConnection(timeoutMs: number = TIMEOUTS.command, pollMs = 400): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
  function waitForIdentified(timeoutMs = 3000, pollMs = 100): Promise<void> {
    return new Promise<void>((resolve) => {
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
  function close(): void {
    for (const p of pending.values()) p.reject(new Error("bridge closed"));
    pending.clear();
    // Close EVERY client, not just the one that used to be `socket` — otherwise a second connected
    // file would hold the event loop open and the process would never exit on its own, which is the
    // whole reason this function exists.
    // close() starts a closing handshake and ws then waits up to 30s for the peer to answer it; a
    // plugin iframe that is busy (or gone) can hold this process open for that long. terminate()
    // after a grace period drops the socket regardless — the same backstop the bad-token path uses.
    for (const e of clients.values()) {
      try { e.ws.close(); } catch { /* already gone */ }
      setTimeout(() => { try { e.ws.terminate(); } catch { /* already gone */ } }, 2000).unref();
    }
    clients.clear();
    try { wss.close(); } catch { /* already closing */ }
  }

  return { request, requestWithClient, isConnected, waitForConnection, waitForIdentified, connectionInfo, listClients, resolveClient, close, port, listening };
}

// The object createBridge() returns — what both front-ends (and the daemon) drive.
export type Bridge = ReturnType<typeof createBridge>;
export type { BridgeOptions };

// verifyClientWith/safeEqual are exported for the test suite (test/bridge.test.ts). They are the bridge's
// ONLY real access control, so they get direct unit coverage rather than being reachable only through
// a live WebSocket handshake.
export { createBridge, verifyClientWith, authStats, CLOSE_BAD_TOKEN, safeEqual, TIMEOUTS, exportTimeout, errMsg, ALLOWED_PORTS, tokenStore, BRIDGE_VERSION, pluginStalenessNote, daemonRowStalenessNote };
