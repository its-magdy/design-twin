// Shared bridge core: hosts a localhost WebSocket server that the Figma plugin's
// hidden UI iframe connects to, and correlates request/response by id.
// Used by both figma-pull (CLI, read) and figma-mcp (write server).
//
// The plugin is always the WebSocket CLIENT (a browser iframe cannot listen);
// this process is the SERVER. Loopback only — no internet exposure.
//
// The server is Bun's own (Bun.serve with a `websocket` handler), not the `ws` package: under Bun,
// `import "ws"` resolves to Bun's built-in compatibility shim, which IGNORES ws's `maxPayload` and
// enforces a hard 16 MiB frame cap instead — a real asset-heavy export (~60–120 MB in one reply)
// then dies as a bare close 1006 "Received too big message" with no error event, and
// FIGMA_BRIDGE_MAX_PAYLOAD_MB could not raise it. Bun.serve honours `maxPayloadLength`.

import type { Server, ServerWebSocket } from "bun";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as tokenStore from "./token-store.ts";
import type { ResolvedToken } from "./token-store.ts";
import { errCode, errMsg } from "./errmsg.ts";
import { ifDefined, isRecord } from "./json-util.ts";
import { abortReason } from "./abort-reason.ts";
import { TIMEOUTS, HEARTBEAT_MS, NAMED_CLIENT_WAIT_MS, SETTLE_MS, MAX_TIMER_MS } from "./timeouts.ts";
// The ONLY ports the plugin can reach (its manifest's allowedDomains) — shared with doctor.ts.
import { ALLOWED_PORTS, bridgePortOrExit } from "./ports.ts";
import { legacySock } from "./daemon.ts";
import { isConnId, connectionFor } from "./route.ts";
// The command/reply contract shared with the plugin: `request()` is typed per command from it, and
// every reply is checked against it once, at the point it enters this process (see the message handler).
import { replyShapeError } from "./commands.ts";
import type { Cmd, Commands } from "./commands.ts";

// Version reporting lives in staleness.ts so the CLI's pure helpers and doctor.ts can use it without
// loading this module; callers import it from there.
import { pluginStalenessNote } from "./staleness.ts";
import { exitFlushed } from "./stdio.ts";

// The handshake check keeps the CALLBACK shape of ws's async verifyClient — done(ok, code, message) —
// that it was written against: the check runs in Bun.serve's fetch() (see createBridge), and its unit
// tests drive it through exactly that shape.
type VerifyClientCallback = (ok: boolean, code?: number, message?: string) => void;

// FIGMA_BRIDGE_PORT is a choice of three (ports.ts), not a free number; any other value exits here, at load.
const PORT = bridgePortOrExit(process.env.FIGMA_BRIDGE_PORT);

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
//  1. DIAGNOSIS. The plugin caches its token in figma.clientStorage and retries on its own, so a token
//     that does not match any more (usually: someone ran --rotate-token and didn't re-paste) becomes a
//     silent reconnect loop. The bridge is the only side that can see WHY, so it says so —
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

// The handshake fields the check reads (the shape of ws's verifyClient `info`, which it was written
// against): createBridge's fetch() builds one from the upgrade Request, and the test suite drives the
// check with hand-built ones. `| undefined` on url/host: an absent header is absent, not "".
interface HandshakeInfo {
  origin?: string;
  req: { url?: string | undefined; headers: { host?: string | undefined } };
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
// For the plugin ONLY (its sandboxed iframe sends Origin "null"; a CLI/server client sends none and CAN
// read the 401), a handshake that passed Origin + Host and failed on the TOKEN alone is admitted, flagged,
// and closed at once with an application close code the iframe can read. It is never registered as a
// client and gets no message handler, so it can neither receive a command nor send a result — what
// an unauthenticated caller gains over the 401 is one bit it already had ("a bridge is here").
// Origin/Host failures are still refused outright at the HTTP layer.
const CLOSE_BAD_TOKEN = 4401; // 4000-4999 is the range RFC 6455 reserves for applications

// ---- the plugin <-> bridge protocol on the wire: the JSON each side sends. The plugin's side is
// figma-plugin/ui.html (plain JS, so these types are its contract, not its source); the test suites'
// fake plugin (test/fake-plugin.ts) sends and reads exactly these.

/** bridge -> plugin: run one command; the plugin answers with a ReplyFrame carrying the same id. */
export interface CommandFrame<C extends Cmd = Cmd> { id: string; cmd: C; args: Commands[C]["args"] }
/** bridge -> plugin: the bridge gave up on request `id` (timed out, stalled out, or its caller left). */
export interface CancelFrame { type: "cancel"; id: string }
export type BridgeFrame = CommandFrame | CancelFrame;
/** plugin -> bridge: who this plugin is, sent on every socket open. ui.html sends null for what it does not
 *  know; a plugin older than version reporting omits pluginVersion. */
export interface HelloFrame {
  type: "hello";
  instanceId?: string | null; file?: string | null; fileKey?: string | null; page?: string | null; pluginVersion?: string | null;
}
/** plugin -> bridge: an unsolicited progress tick (figma-plugin/src/progress.ts), for the run serving `requestId`. */
export interface ProgressFrame {
  type: "progress";
  requestId?: string | null; phase?: string; page?: { index: number; of: number; name?: string | null } | null;
  nodes?: number | null; assets?: number | null;
  /** a `queued` frame: who the waiting run is for */
  source?: "ui" | "bridge"; label?: string;
}
/** plugin -> bridge: the answer to command `id`. */
export type ReplyFrame = { [C in Cmd]: { id: string; ok: true; result: Commands[C]["reply"] } }[Cmd] | { id: string; ok: false; error: string };
export type PluginWireFrame = HelloFrame | ProgressFrame | ReplyFrame;

// ---- the plugin <-> bridge protocol, as this module sees it.

/** A plugin progress tick as ui.html relays it: `{type:"progress", phase, page, nodes, assets}` — the
 *  counters figma-plugin/src/progress.ts emits, each absent when the phase has none. Read defensively:
 *  it is foreign JSON, and only a human-readable progress message is ever built from it. */
export interface ProgressTick {
  phase: string | null;
  page: { index: number; of: number; name: string | null } | null;
  nodes: number | null;
  assets: number | null;
}

/** One frame from the plugin (figma-plugin/ui.html), after parsePluginFrame: a `hello` identity
 *  announcement, an unsolicited `progress` tick, or the reply to one command (`{id, ok, result, error}`).
 *  Anything else — a non-object, a reply whose id is not a string — is dropped (null). */
type PluginFrame =
  | { type: "progress"; tick: ProgressTick; requestId: string | null }
  | { type: "hello"; instanceId: string | null; file: string | null; fileKey: string | null; page: string | null; pluginVersion: string | null }
  | { type: "reply"; id: string; ok: boolean; result: unknown; error: unknown };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseTick(m: Record<string, unknown>): ProgressTick {
  const p = isRecord(m.page) ? m.page : null;
  const index = p ? num(p.index) : null;
  const of = p ? num(p.of) : null;
  return {
    phase: str(m.phase),
    page: p && index !== null && of !== null ? { index, of, name: str(p.name) } : null,
    nodes: num(m.nodes),
    assets: num(m.assets),
  };
}

function parsePluginFrame(parsed: unknown): PluginFrame | null {
  // JSON.parse can return a non-object (null, number, string) — guard before reading .id so a
  // malformed frame (e.g. the literal `null`) can't throw an uncaught TypeError and kill the process.
  if (!isRecord(parsed)) return null;
  const m = parsed;
  if (m.type === "progress") return { type: "progress", tick: parseTick(m), requestId: str(m.requestId) };
  if (m.type === "hello") {
    return { type: "hello", instanceId: str(m.instanceId), file: str(m.file), fileKey: str(m.fileKey), page: str(m.page), pluginVersion: str(m.pluginVersion) };
  }
  // Request ids are always strings ("r<nonce>-<N>"), so a frame whose id is anything else matches nothing.
  if (typeof m.id !== "string") return null;
  return { type: "reply", id: m.id, ok: !!m.ok, result: m.result, error: m.error };
}

/** The part of a socket the registry reads: whether it is still open. A Bun ServerWebSocket in the
 *  bridge; the test suite drives the registry with plain objects of this shape. */
interface RegistrySocket {
  readyState: number;
}

/** WebSocket readyState OPEN (RFC 6455 / WHATWG: CONNECTING 0, OPEN 1, CLOSING 2, CLOSED 3) — the same
 *  number on a ServerWebSocket and on the registry's test doubles. */
const WS_OPEN = 1;

/** What each server socket carries (Bun.serve's per-socket `data`, set at upgrade): `badToken` marks a
 *  plugin admitted only to be closed with CLOSE_BAD_TOKEN (see `admit`); `entry` is its registry entry
 *  once open() has registered it — never for a bad-token socket. */
interface SocketData {
  badToken: boolean;
  entry: ClientEntry | null;
}
type BridgeSocket = ServerWebSocket<SocketData>;

/** One registry entry: a connected plugin socket plus what its `hello` said. */
interface ClientEntry<S extends RegistrySocket = BridgeSocket> {
  ws: S;
  connId: string;
  /** wall clock (Date.now), for display: the rows' connectedAt / uptimeMs */
  connectedAt: number;
  /** monotonic clock (performance.now), for the waits: the identification grace counts from it */
  connectedMono: number;
  instanceId: string | null;
  file: string | null;
  fileKey: string | null;
  page: string | null;
  pluginVersion: string | null;
  /** Parsed frames received from this client so far — hello, progress, replies, anything the plugin
   *  sent that parsed. request()'s stall check captures it at send time and disarms on the first
   *  frame AFTER that: a count, not a clock, so a connect (or a frame) in the same millisecond as
   *  the send can neither pass for life since the send nor be missed. */
  frames: number;
  /** heartbeat: cleared before each ping, set again by the pong (the ws README's "How to detect and
   *  close broken connections?" recipe). Still false at the next tick = the peer is gone, and it is terminated. */
  isAlive: boolean;
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
  /** the caller's progress listener, fed every progress tick this request's connection sends */
  onProgress?: (tick: ProgressTick) => void;
  /** the plugin began this request's run (its own `start` frame): the per-command budget starts over */
  started: () => void;
}

/** What a request resolved with, plus WHICH connected file answered it (the client resolveClient picked). */
export interface RequestOutcome<C extends Cmd> {
  reply: Commands[C]["reply"];
  client: ClientRow;
}

/** The admission decision for one upgrade request: let it through (`badToken`: only to be closed with
 *  CLOSE_BAD_TOKEN), or refuse it with an HTTP status and body. */
type Admission = { admit: true; badToken: boolean } | { admit: false; code: number; message: string };

function admitWith(token: string): (info: HandshakeInfo) => Admission {
  const verify = verifyClientWith(token);
  return (info) => {
    // verify answers synchronously, through the callback shape it keeps (see VerifyClientCallback).
    let out: Admission = { admit: false, code: 401, message: "" };
    verify(info, (ok, code, msg) => {
      if (ok) out = { admit: true, badToken: false };
      else if (code === 401 && info.origin === "null") out = { admit: true, badToken: true };
      else out = { admit: false, code: code || 401, message: msg || "" };
    });
    return out;
  };
}

// The status texts the bridge answers with. A refusal's body is its message, or this text without one —
// the status line, headers and body ws's own abortHandshake wrote for a verifyClient refusal, so a client
// sees exactly the 401/403 it saw when ws ran the check.
const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 426: "Upgrade Required" };
function refuseUpgrade(code: number, message?: string): Response {
  return new Response(message || STATUS_TEXT[code] || "", { status: code, headers: { Connection: "close", "Content-Type": "text/html" } });
}

/** The bind refusal when `port` is already held (EADDRINUSE). A daemon from an earlier dtwin build listens on
 *  a socket this build does not look at, so neither routing through it nor `dtwin --stop`'s first look finds
 *  it — the text names it instead. On Windows the daemon's pipe is named from the bridge token (daemon.ts
 *  winPipe), so one started under an EARLIER token is unreachable by name in the same way — the text says so. */
function portInUseMessage(port: number, platform: NodeJS.Platform = process.platform): string {
  const others = `set FIGMA_BRIDGE_PORT to one of the other allowed ports (${ALLOWED_PORTS.filter((p) => p !== port).join(", ")}) — the plugin walks all three.`;
  if (platform === "win32") {
    return `[bridge] port ${port} is already in use — another dtwin bridge or MCP server is running. Stop it first, or ${others} ` +
      "A dtwin daemon started under a different bridge token cannot be found by this one (its pipe is named from the token), so `dtwin --stop` does not reach it — end that process instead.";
  }
  const sock = legacySock(port, { platform });
  const legacy = sock ? ` A dtwin daemon from an earlier version may be holding it (socket ${sock}) — \`dtwin --stop\` stops it.` : "";
  return `[bridge] port ${port} is already in use — another dtwin bridge or MCP server is running. Stop it first, or ${others}${legacy}`;
}

// ---- the client registry: which plugin sockets are connected, what each `hello` said, and who addresses which.

/** How long a connected client that has not sent its `hello` still holds a wait that would otherwise resolve
 *  without its file name (an unaddressed request, a listing, an ambiguity). The plugin sends it a beat after the socket opens (ui.html, on every open); a client that never does
 *  (a bundle that predates `hello`) is taken as it is once this passes, so it cannot hold a whole connect window. */
const IDENTIFY_GRACE_MS = 3000;

/** What requestWithClient takes beyond the positional arguments. `waitMs` (> 0): first wait for the target
 *  to be connected, with that connect window — see the registry's awaitClient. */
export interface RequestOptions {
  waitMs?: number;
}

type Hello = Extract<PluginFrame, { type: "hello" }>;

/** createRegistry options. `settleMs` is timeouts.ts SETTLE_MS (the test suites shorten it, or pass 0). */
interface RegistryOptions {
  settleMs?: number;
}

/**
 * The client registry, kept apart from the sockets so the test suite can drive it with plain objects. Every
 * change (a client added, identified or removed, the registry cleared) is announced on one event, which
 * is what awaitClient waits on. Its waits run on the monotonic clock (performance.now), so a wall-clock
 * step cannot end or stretch one.
 */
function createRegistry<S extends RegistrySocket = BridgeSocket>(opts: RegistryOptions = {}) {
  const clients = new Map<string, ClientEntry<S>>(); // connId -> { ws, connId, connectedAt, instanceId, file, fileKey, page }
  const settleMs = opts.settleMs !== undefined && Number.isFinite(opts.settleMs) && opts.settleMs >= 0 ? opts.settleMs : SETTLE_MS;
  const changes = new EventEmitter();
  // One listener per waiting request. Several tool calls can wait at once, which is not a leak — but
  // hundreds would be, so the warning stays armed above any plausible number of concurrent waits.
  changes.setMaxListeners(64);
  let connSeq = 0;
  let closed = false;
  // When the settle window started (monotonic): the registry went from no live client to one, or a client
  // left while others stayed. The window counts from it.
  let liveSince: number | null = null;
  const changed = (): void => { changes.emit("change"); };

  function add(ws: S): ClientEntry<S> {
    const connId = "c" + ++connSeq;
    const now = performance.now();
    if (!live().length) liveSince = now;
    const entry: ClientEntry<S> = { ws, connId, connectedAt: Date.now(), connectedMono: now, instanceId: null, file: null, fileKey: null, page: null, pluginVersion: null, frames: 0, isAlive: true };
    clients.set(connId, entry);
    changed();
    return entry;
  }

  function identify(entry: ClientEntry<S>, hello: Hello): void {
    entry.instanceId = hello.instanceId;
    entry.file = hello.file;
    entry.fileKey = hello.fileKey;
    entry.page = hello.page;
    // The plugin's own build version (figma-plugin/package.json, baked in at build
    // time — see figma-plugin/build.ts). `null` for a plugin bundle old enough to predate this
    // field entirely, which is itself a useful signal (definitely stale).
    entry.pluginVersion = hello.pluginVersion;
    changed();
  }

  // Only forget THIS entry. A connId is never reused, but the check keeps a late close of a socket the
  // heartbeat already dropped from touching anything else.
  function remove(entry: ClientEntry<S>): void {
    if (clients.get(entry.connId) !== entry) return;
    clients.delete(entry.connId);
    // A window that leaves usually comes back a redial later (a reload, a Figma restart). Until then the
    // clients that remain are not the whole picture, so an unaddressed request waits the settle again.
    if (live().length) liveSince = performance.now();
    changed();
  }

  // The bridge is closing: nothing will connect any more, so every wait ends now instead of at its window.
  function clear(): void {
    clients.clear();
    closed = true;
    changed();
  }

  const isLive = (e: ClientEntry<S> | undefined): e is ClientEntry<S> => !!e && !!e.ws && e.ws.readyState === WS_OPEN;
  const live = (): ClientEntry<S>[] => [...clients.values()].filter(isLive);

  // One connection, described for a human or an agent choosing between them. `describe` is what a
  // listing shows and what an ambiguity error quotes, so the two can never disagree about what a
  // client is called.
  const describe = (e: ClientEntry<S>): ClientRow => ({
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
  // The target rules above, as data: which live entries a target names. resolveClient turns the
  // outcome into the routed entry or the error; awaitClient waits on it (a `none` may become a `one`
  // while a second plugin window is still redialling).
  function matchClient(entries: ClientEntry<S>[], t: string): ClientEntry<S>[] {
    const byId = entries.find((e) => e.connId === t);
    if (byId) return [byId];
    const byKey = entries.find((e) => e.fileKey && e.fileKey === t);
    if (byKey) return [byKey];
    const lower = t.toLowerCase();
    return entries.filter((e) => e.file && e.file.toLowerCase().includes(lower));
  }
  function resolveClient(target?: unknown): ClientEntry<S> {
    const entries = live();
    if (!entries.length) {
      throw new Error("Figma plugin not connected. Open the file in Figma and run the plugin.");
    }
    const list = () => entries.map((e) => `  ${e.connId}  ${JSON.stringify(e.file || "(unidentified)")}${e.fileKey ? "  fileKey " + e.fileKey : ""}`).join("\n");
    if (target === undefined || target === null || target === "") {
      const [only] = entries;
      if (entries.length === 1 && only !== undefined) return only; // only is always set when length is 1
      throw new Error(
        `${entries.length} Figma files are connected to the bridge — say which one to use.\n${list()}\n` +
        `Pass the connId, the fileKey, or part of the file name (CLI: --client <id|name>; MCP: client: "<id|name>").`
      );
    }
    const t = String(target);
    const matched = matchClient(entries, t);
    const [hit] = matched;
    if (matched.length === 1 && hit !== undefined) return hit; // hit is always set when length is 1
    if (matched.length > 1) {
      throw new Error(
        `'${t}' matches ${matched.length} connected files — be more specific, or use the connId.\n${list()}`
      );
    }
    throw new Error(`no connected Figma file matches '${t}'. Connected:\n${list()}`);
  }

  // How much of the settle window is left: 0 once it has passed, and 0 with nothing connected (there is
  // nothing to route yet, so nothing to hold — the request's own error says so at once).
  function settleLeft(): number {
    if (liveSince === null || !live().length) return 0;
    return Math.max(0, liveSince + settleMs - performance.now());
  }

  /**
   * Wait, bounded, until `target` can be routed — the one wait every front-end uses before a request
   * (figma-pull's own bridge, the daemon for a request that carries a connect window, the MCP server for
   * a named `client`, and any request while the bridge is still settling). Resolves when:
   *   - a NAMED target (file name or fileKey, not a connId) matches: at once for a single match by fileKey,
   *     or for several matches once no connected client is still waiting to identify itself (the ambiguity
   *     is resolveClient's to report, and its list then names every file); a single match by file name
   *     only once the bridge has settled and no connected client is still waiting to identify itself
   *     (below). File names are not unique and a name matches as a substring, so one match is not yet the
   *     only candidate. Every open plugin window redials on its own clock (figma-plugin ui.html), so with
   *     two files open whichever lands first is all there is for a moment (seen live: `--client "Design
   *     System"` failed with only the other file listed, and that file connected two seconds later). And a
   *     socket that is open is not yet identified: its `hello`, which carries the file name, arrives a beat
   *     later ("one run in four failed");
   *   - a connId: that connection is live (it needs no identification), or every live client has identified
   *     itself (or been connected IDENTIFY_GRACE_MS without doing so), so a connId that is not there fails
   *     with the connected list, every file in it named, instead of holding the window;
   *   - no target: every live client has identified itself, or has been connected for IDENTIFY_GRACE_MS
   *     without doing so — and the bridge has settled or several clients are already connected (resolveClient
   *     then refuses to guess). So a listing (--list-clients) right after a window's socket opens waits the
   *     few milliseconds to its `hello` and shows the file name; a client that never sends one is listed
   *     unidentified once its grace has passed;
   *   - the window runs out: `waitMs` (Infinity: no end) for a first live client; once one is live, a
   *     named target gets min(waitMs, NAMED_CLIENT_WAIT_MS) from that moment, so a name that never
   *     matches fails with the connected list instead of holding the whole connect window. A window (> 0)
   *     that ends before the settle does is stretched to it for a target that is not a connId, since
   *     routing at the window would take the first file to land;
   *   - the CAP: once some client has been live without a gap since moment L, the wait ends by
   *     L + max(min(waitMs, NAMED_CLIENT_WAIT_MS), settleMs) + IDENTIFY_GRACE_MS (18 s at most with the
   *     defaults — the CLI's connect window is longer than the 15 s cap), whatever the settle and the graces say — a
   *     socket that opens and closes without a hello faster than the settle restarts it on every leave and
   *     brings a fresh grace each time, and would otherwise hold the wait for good. With nothing live, only
   *     the window ends it (Infinity still waits for a first plugin, or, with no target or a connId, for a
   *     client that stays connected long enough to say hello or outlast its grace — as before the cap);
   *   - `signal` aborts, or the registry is cleared (the bridge closed).
   * SETTLED: settleMs (timeouts.ts SETTLE_MS) have passed since the settle window started — the registry
   * went from no live client to one, or a client left while others stayed (it is probably redialling).
   * Until then a target that is not routed by connId or fileKey could go to the first file to land while
   * another open file's window is a redial behind — a silent wrong-file export — so it waits. A bridge
   * whose plugins have been connected longer pays nothing.
   * Never rejects: resolveClient, run afterwards, says what is wrong with whatever is connected then.
   * Woken by the registry's change event (a connect, a `hello`, a close) — no polling; the one timer is the
   * next moment the answer can change without an event (the window, the cap, the settle, an identification grace),
   * unref'd so a wait never keeps a process alive by itself, and cleared on every exit, as is the listener.
   * `namedCapMs` is NAMED_CLIENT_WAIT_MS (the test suite shortens it).
   */
  function awaitClient(target: string | null | undefined, waitMs: number, signal?: AbortSignal, namedCapMs: number = NAMED_CLIENT_WAIT_MS): Promise<void> {
    const t = target ?? "";
    const connId = t !== "" && isConnId(t);
    const named = t !== "" && !connId;
    const windowMs = waitMs > 0 ? waitMs : 0; // NaN, 0 and below: no wait; Infinity: no end
    const capMs = namedCapMs >= 0 ? namedCapMs : NAMED_CLIENT_WAIT_MS; // NaN or negative: the default, not a timer that never settles
    // Only an id names one socket: file names repeat ("Untitled") and match as substrings ("App" in "App (Copy)").
    const exact = (e: ClientEntry<S>): boolean => e.connId === t || (e.fileKey !== null && e.fileKey === t);
    const start = performance.now();
    let firstLiveAt: number | null = null;
    let liveFrom: number | null = null; // since when some client has been live without a gap (null: none now)
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        // emit() still calls a listener removed during that same emit (nodejs.org/api/events.html), hence `done`.
        if (done) return;
        done = true;
        changes.off("change", check);
        signal?.removeEventListener("abort", finish);
        if (timer) clearTimeout(timer);
        timer = null;
        resolve();
      };
      function check(): void {
        if (done) return;
        if (closed || signal?.aborted) return finish();
        const now = performance.now();
        const entries = live();
        if (entries.length && firstLiveAt === null) firstLiveAt = now;
        const settleAt = liveSince === null ? now : liveSince + settleMs;
        const settled = now >= settleAt;
        // A client that has not sent its hello yet may be another window of the file being asked for.
        const identifying = entries.some((e) => !e.instanceId && now - e.connectedMono < IDENTIFY_GRACE_MS);
        // Every outcome that does not route to one matched file — a refusal or a "no match" that lists the
        // connected files, a no-target request with several, `--list-clients` — waits out a hello still due,
        // so a window whose socket opened a moment ago is listed by its file name, not as unidentified.
        let ready: boolean;
        if (named) {
          const matched = matchClient(entries, t);
          const [only] = matched;
          ready = (matched.length > 1 && !identifying) || (only !== undefined && (exact(only) || (settled && !identifying)));
        } else {
          const there = connId && entries.some((e) => e.connId === t); // a connId names one socket: identification adds nothing
          ready = there || (entries.length > 0 && !identifying && (connId || settled || entries.length > 1));
        }
        if (ready) return finish();
        let deadline = named && firstLiveAt !== null ? firstLiveAt + Math.min(windowMs, capMs) : start + windowMs;
        // A window that ends inside the settle would route to whichever file has landed so far.
        if (!connId && windowMs > 0 && entries.length && !settled) deadline = Math.max(deadline, settleAt);
        // The settle restarts on every leave and every new socket brings its own grace, so a socket that
        // keeps opening and closing without a hello could push both forever: the cap counts from the moment
        // this wait last saw a client go live and nothing moves it.
        if (!entries.length) liveFrom = null;
        else if (liveFrom === null) liveFrom = now;
        const capAt = liveFrom === null ? Number.POSITIVE_INFINITY : liveFrom + Math.max(Math.min(windowMs, capMs), settleMs) + IDENTIFY_GRACE_MS;
        if (now >= deadline || now >= capAt) return finish();
        // The next moment the answer can change without an event: the window, the cap, the settle, or an
        // unidentified client's grace.
        let wake = Math.min(deadline, capAt);
        if (!connId && entries.length && !settled) wake = Math.min(wake, settleAt);
        for (const e of entries) if (!e.instanceId && now - e.connectedMono < IDENTIFY_GRACE_MS) wake = Math.min(wake, e.connectedMono + IDENTIFY_GRACE_MS);
        if (timer) clearTimeout(timer);
        timer = setTimeout(check, Math.min(Math.max(Math.ceil(wake - now), 1), MAX_TIMER_MS));
        timer.unref();
      }
      changes.on("change", check);
      signal?.addEventListener("abort", finish, { once: true });
      check();
    });
  }

  return {
    clients, add, identify, remove, clear, live, describe, resolveClient, awaitClient, settleLeft,
    /** connections registered so far (bad-token sockets are never registered) */
    connections: (): number => connSeq,
    /** test seam: how many waits are listening for registry changes right now */
    waiting: (): number => changes.listenerCount("change"),
  };
}

/** createBridge options. `onListenError` is for a caller that must SURVIVE a failed bind (the MCP
 * server: a held port is a tool error there, not a reason to kill the stdio session). Without it, a
 * held port prints the fix and exits 1 — the CLI behaviour, unchanged. `heartbeatMs` overrides the
 * ping interval (timeouts.ts HEARTBEAT_MS); the test suite shortens it, or passes 0 = no interval at
 * all, and steps the returned `heartbeatTick()` itself. */
interface BridgeOptions {
  onListenError?: (e: Error) => void;
  heartbeatMs?: number;
  /** the registry's settle window (timeouts.ts SETTLE_MS); the test suite passes 0 where it is not under test */
  settleMs?: number;
}

const DEFAULT_MAX_PAYLOAD_MB = 128;
const MiB = 1024 * 1024;
/** The bridge's per-frame cap from FIGMA_BRIDGE_MAX_PAYLOAD_MB. It bounds a single frame so a malformed/huge payload can't
 *  OOM the process; 128 MB is ~2x a realistic asset-heavy full export, and an unusually large file can raise it. Bun.serve
 *  takes it as `maxPayloadLength`, an unsigned 32-bit byte count, so a value past 4096 MB is clamped to just under 4 GiB
 *  and `mb` says so (the too-big diagnosis quotes it — the cap in force, not the number typed).
 *  A value that is not a finite number above 0 falls back to the default, with a `warning`: `ws` read 0 (and below) as
 *  "unlimited", but Bun.serve has no unlimited — 0 there refuses every non-empty frame — and a typo must not become either one. */
function maxPayloadFromEnv(raw: string | undefined): { mb: number; bytes: number; warning?: string } {
  const v = (raw ?? "").trim();
  if (v === "") return { mb: DEFAULT_MAX_PAYLOAD_MB, bytes: DEFAULT_MAX_PAYLOAD_MB * MiB };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    return { mb: DEFAULT_MAX_PAYLOAD_MB, bytes: DEFAULT_MAX_PAYLOAD_MB * MiB, warning: `FIGMA_BRIDGE_MAX_PAYLOAD_MB=${JSON.stringify(raw)} is not a number of megabytes above 0 — using the default ${DEFAULT_MAX_PAYLOAD_MB} MB (there is no "unlimited")` };
  }
  const bytes = Math.max(1, Math.min(Math.floor(n * MiB), 0xffffffff));
  return { mb: Math.round((bytes / MiB) * 100) / 100, bytes };
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

  // The per-frame cap (maxPayloadFromEnv): FIGMA_BRIDGE_MAX_PAYLOAD_MB, or 128 MB.
  const payload = maxPayloadFromEnv(process.env.FIGMA_BRIDGE_MAX_PAYLOAD_MB);
  if (payload.warning) console.error("[bridge] " + payload.warning);
  const { mb: maxPayloadMb, bytes: maxPayloadBytes } = payload;
  const admit = admitWith(token);

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
  const registry = createRegistry(ifDefined("settleMs", opts.settleMs));
  const clients = registry.clients;
  const pending = new Map<string, PendingRequest>(); // requestId -> { resolve, reject, connId }
  // Request ids are `r<nonce>-<seq>`, the nonce minted once per bridge. A bare per-process counter
  // restarted at r1 in every bridge, so a plugin still finishing a run for a bridge that has since
  // gone (a one-shot CLI that stalled out and exited) posted ITS r1 to whatever socket was current —
  // and the next bridge's own r1 (a daemon's first forwarded request) settled with that stale run's
  // reply: "export cancelled: … abandoned" for a request nobody had abandoned (seen live), or
  // another node's tree had the old run succeeded. With the nonce such a reply names an id nobody here
  // knows, and is dropped. Opaque to the plugin, which only ever echoes it back.
  const nonce = crypto.randomBytes(3).toString("hex");
  let seq = 0;
  let takeovers = 0; // kept ONLY for the historical whoami field; nothing displaces anything.
  let lastTakeoverAt = 0;

  // The socket handlers Bun.serve calls (its `websocket` option, below). A socket's registry entry rides
  // on its own `data`, set by open(); a bad-token socket never gets one, so every handler after open()
  // ignores it — it can neither receive a command nor send a result.
  function onOpen(ws: BridgeSocket): void {
    // Admitted only to be told why it is refused (see `admit`). Before anything else: no registry
    // entry. terminate() backs the close up in case the peer never completes it.
    if (ws.data.badToken) {
      ws.close(CLOSE_BAD_TOKEN, "bad token");
      setTimeout(() => { try { ws.terminate(); } catch { /* already gone */ } }, 2000).unref();
      return;
    }
    // Every connection is kept. The previous single-socket rule terminated the incumbent here, which
    // made two open Figma files fight: the displaced plugin's auto-reconnect immediately stole the
    // bridge back, and the two ping-ponged forever (observed live). Admitting both removes the
    // contention rather than arbitrating it.
    const entry = registry.add(ws);
    ws.data.entry = entry;
    console.error(`[bridge] plugin connected: ${entry.connId} (${clients.size} connected).`);
  }

  function onMessage(ws: BridgeSocket, data: string | Buffer): void {
    const entry = ws.data.entry;
    if (!entry) return;
    const connId = entry.connId;
    // The plugin only ever sends text frames (JSON.stringify in ui.html); Bun hands a text frame over
    // as a string and a binary one as a Buffer, which is nothing the protocol has.
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    const msg = parsePluginFrame(parsed);
    if (!msg) return;
    // ANY message from this client is a sign of life — counted unconditionally, before the
    // type-specific handling below, so request()'s stall detector (see below) can tell "the plugin
    // is genuinely walking a big file and periodically reporting progress" from "nothing has been
    // heard from this socket since the command was sent", which a plain reply-or-timeout wait
    // cannot: a real pull measured a 300s/908s silent wait, on a bridge that WAS connected, for
    // work that took 7.5-8.8s once a daemon kept the connection warm.
    entry.frames++;
    // An unsolicited progress frame relayed from the plugin's own UI (figma-plugin/src/progress.ts
    // posts these to the iframe DOM; ui.html forwards a bridge-triggered run's frames over this
    // socket too). Is never a reply (a `requestId` on it only routes it, below) and needs no reply; it exists
    // to keep `frames` moving during a long walk — and to feed the progress listener of any
    // request in flight on THIS connection (the MCP server forwards them as notifications/progress).
    // A frame that names its request (`requestId`: the plugin's `start` / `queued` for one run) goes to
    // that request only — a request executing must not hear that another one is queued. An id-less frame
    // (page ticks, an older plugin) keeps the fan-out; an id this connection has no pending request for
    // feeds nothing (it already counted as life above).
    if (msg.type === "progress") {
      const only = msg.requestId;
      // A request's OWN `start` (named by id — an id-less one could be anyone's) re-arms its budget: see dispatch.
      if (only !== null && msg.tick.phase === "start") {
        const p = pending.get(only);
        if (p && p.connId === connId) p.started();
      }
      for (const [id, p] of pending) {
        if (p.connId !== connId || !p.onProgress || (only !== null && id !== only)) continue;
        try { p.onProgress(msg.tick); } catch { /* a listener's failure is its own; the request goes on */ }
      }
      return;
    }
    // Unsolicited identity announcement, sent by the plugin UI on connect AND on every reconnect.
    // Re-announcing is the whole point: identity is DERIVED from the environment each time rather
    // than issued by us and replayed, so a plugin that Figma tore down and re-ran comes back
    // correctly labelled without any resumable-session machinery. A `hello` carries no request id,
    // so it can never be confused with a reply.
    if (msg.type === "hello") {
      registry.identify(entry, msg);
      const stalenessNote = pluginStalenessNote(entry.pluginVersion);
      console.error(`[bridge] ${connId} identified: ${JSON.stringify(entry.file || "(unnamed file)")}` +
        (entry.fileKey ? ` [fileKey ${entry.fileKey}]` : " [no fileKey — private-plugin API not in effect]") +
        ` [plugin v${entry.pluginVersion || "unknown"}]` + (stalenessNote ? ` — ${stalenessNote}` : ""));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    // Settled only by the connection it was SENT to. A reply carrying this id on another socket is
    // not an answer to it (with per-bridge ids it can only be a coincidence or a confused peer), and
    // letting it through would resolve one file's request with another file's work.
    if (p.connId !== connId) return;
    pending.delete(msg.id);
    if (!msg.ok) return p.reject(new Error(String(msg.error || "plugin error")));
    // The ONE place a reply enters this process, so the ONE place its shape is checked against the
    // contract (commands.ts). A plugin that answers `listPages` with something that has no `pages`
    // — an older bundle, a half-migrated command — fails HERE, named, instead of as a TypeError in
    // whichever reader touches the missing field first.
    const bad = replyShapeError(p.cmd, msg.result);
    if (bad) return p.reject(new Error(`plugin replied with an unexpected shape for ${p.cmd}: ${bad}`));
    p.resolve(msg.result);
  }

  // The close code and reason are the whole diagnosis of a mid-export disconnect: Bun.serve reports no
  // per-socket error event (ws did, and that error was where "max payload size exceeded" showed up).
  // A frame over maxPayloadLength closes the socket with 1009, or — what Bun 1.4 actually reports to
  // this handler — 1006 "Received too big message"; a peer that closes with 1009 itself says the same.
  function onClose(ws: BridgeSocket, code: number, reason: string): void {
    const entry = ws.data.entry;
    if (!entry) return; // a bad-token socket: never registered, nothing in flight
    const connId = entry.connId;
    // Only forget THIS connection. A single-socket guard (`socket === ws`)
    // would do the same job by accident; with a registry it has to be explicit, or one file closing
    // its plugin window would drop the entry a different file is actively using.
    registry.remove(entry);
    const label = entry.file ? ` (${entry.file})` : "";
    console.error(`[bridge] plugin disconnected: ${connId}${label} (${clients.size} still connected).`);
    let why = `Figma plugin disconnected before replying (close ${code || "?"}${reason ? ": " + reason : ""}).`;
    // 1009 is the one a caller can actually act on, and the likeliest failure on a big file:
    // the export outgrew the frame limit, so name the knob instead of making them find it.
    if (code === 1009 || /max payload|too large|too big/i.test(reason)) {
      why += ` The export exceeded the ${maxPayloadMb} MB frame limit — raise FIGMA_BRIDGE_MAX_PAYLOAD_MB,` +
             ` or pull less at once (a single page instead of --all-pages).`;
    } else {
      // Anything else => the peer went away on its own: a plugin-side crash/OOM, or the window was
      // closed. That surfaces in Figma's console, not here — say so.
      why += ` No socket error was reported, so the plugin itself likely stopped (crash/OOM, or the` +
             ` window was closed). Check Plugins → Development → Open Console in Figma.`;
    }
    // Fail in-flight requests fast instead of hanging until their timeout — but ONLY the ones sent to
    // the socket that just died. Rejecting the whole map (as a single-client bridge could, when the
    // whole map could only ever belong to one socket) would abort a long export running happily
    // in ANOTHER file because an unrelated one closed its plugin window.
    for (const [id, p] of pending) {
      if (p.connId !== connId) continue;
      pending.delete(id);
      p.reject(new Error(why));
    }
  }

  // Heartbeat, as in the ws README's "How to detect and close broken connections?": "Sometimes, the
  // link between the server and the client can be interrupted in a way that keeps both the server and
  // the client unaware of the broken state of the connection ... In these cases, ping messages can be
  // used as a means to verify that the remote endpoint is still responsive." A client still not alive
  // at the next tick missed the last pong: it leaves the registry at once (so no command is routed to
  // it) and is terminated, whose close event fails its in-flight requests like every other disconnect.
  // unref'd: the heartbeat must never be what keeps a one-shot CLI process alive.
  const heartbeatTick = (): void => {
    for (const [id, e] of clients) {
      if (!e.isAlive) {
        registry.remove(e);
        console.error(`[bridge] ${id} did not answer a heartbeat ping — terminating it.`);
        try { e.ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      e.isAlive = false;
      try { e.ws.ping(); } catch { /* not open any more; its close handler removes it */ }
    }
  };
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const heartbeat = heartbeatMs > 0 ? setInterval(heartbeatTick, heartbeatMs) : undefined;
  heartbeat?.unref();

  // The server. Bound to 127.0.0.1: strictly loopback. fetch() runs the admission (Origin + Host +
  // shared token, fail-closed, and the plugin's null-origin bad-token admit-then-4401) on every upgrade
  // request, and either upgrades it or refuses it with the 401/403 ws used to write. A plain
  // (non-upgrade) request is answered 426, as ws's internal server did — `dtwin doctor` reads that 426
  // as "a websocket server holds this port".
  // The websocket options, each against a Bun default that would change what the bridge does:
  //   sendPings false, idleTimeout 0 — no automatic pings and no idle cut-off: the heartbeat above is the
  //     one liveness rule (a plugin can legitimately sit idle for hours between commands), and its tests
  //     count the pings exactly;
  //   perMessageDeflate false — ws's server default too; compressing a 100 MB export costs more than the
  //     loopback copy it saves;
  //   backpressureLimit = maxPayloadBytes — the bridge's own frames are small (commands, cancels), but a
  //     send past the limit is DROPPED (send() returns 0), so the limit is never below a frame the bridge
  //     would accept; sendFrame() reports a drop instead of leaving the request to time out.
  // TEST SEAM: DT_TEST_EPHEMERAL_PORT=1 binds an ephemeral port instead of `port` and prints the real one
  // on stderr (`[bridge] DT_TEST_EPHEMERAL_PORT: <port> -> <real port>`), so a test that spawns a server
  // never takes 8787–8789 from a live Figma session or another test run. `port` keeps naming everything
  // else (the daemon socket, status output). No user-facing path sets it.
  const ephemeral = process.env.DT_TEST_EPHEMERAL_PORT === "1";
  let server: Server<SocketData> | null = null;
  let bindError: Error | null = null;
  try {
    server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: ephemeral ? 0 : port,
      // reusePort false, stated, never left to the default: Bun 1.4 turns SO_REUSEPORT ON whenever
      // `development` is false — set here, and also Bun's own default under NODE_ENV=production — and two
      // bridges would then BOTH bind 8787, with the kernel dealing plugin connections between them at
      // random, instead of the second getting EADDRINUSE (the port-in-use refusal, and the daemon
      // routing every front-end relies on). Found by test/cli-pull.test.ts: a second one-shot command
      // "bound" the port a first one held.
      reusePort: false,
      development: false,
      fetch(req, srv) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response(STATUS_TEXT[426], { status: 426, headers: { "Content-Type": "text/plain" } });
        }
        const origin = req.headers.get("origin");
        const host = req.headers.get("host");
        const a = admit({ ...(origin !== null ? { origin } : {}), req: { url: req.url, headers: { host: host ?? undefined } } });
        if (!a.admit) return refuseUpgrade(a.code, a.message);
        // false: not a valid WebSocket handshake after all (no Sec-WebSocket-Key, a version other than 13).
        return srv.upgrade(req, { data: { badToken: a.badToken, entry: null } }) ? undefined : refuseUpgrade(400);
      },
      websocket: {
        maxPayloadLength: maxPayloadBytes,
        backpressureLimit: maxPayloadBytes,
        sendPings: false,
        idleTimeout: 0,
        perMessageDeflate: false,
        open: onOpen,
        message: onMessage,
        pong(ws) { if (ws.data.entry) ws.data.entry.isAlive = true; },
        close: onClose,
      },
    });
    if (ephemeral) console.error(`[bridge] DT_TEST_EPHEMERAL_PORT: ${port} -> ${server.port}`);
  } catch (e) {
    bindError = e instanceof Error ? e : new Error(errMsg(e));
  }

  // Resolves once the port is bound. Never rejects: a bind failure goes to onListenError (or exits),
  // so a caller that only wants "is it up yet" cannot leak an unhandled rejection.
  // Bun.serve binds synchronously (it throws on a held port), but the failure is still reported a turn
  // later, as node:http's 'error' event was: createBridge() returns first, so a caller that keeps the
  // bridge (figma-mcp's resolveHolder) has it in hand when onListenError runs, and can close() it.
  const listening = server ? Promise.resolve() : new Promise<void>(() => {});
  if (bindError) {
    const e = bindError;
    setImmediate(() => {
      const err = errCode(e) === "EADDRINUSE" ? new Error(portInUseMessage(port)) : e;
      if (opts.onListenError) return opts.onListenError(err);
      console.error(errCode(e) === "EADDRINUSE" ? err.message : `[bridge] could not listen on 127.0.0.1:${port}: ${errMsg(e)}`);
      // Off the CLI's call stack (a turn later), and the caller is awaiting `listening`, which never settles: an
      // explicit exit, once that line is out.
      exitFlushed(1);
    });
  }

  // A frame to one plugin socket. Bun's send() answers -1 (queued behind backpressure; it goes out on
  // drain), 0 (DROPPED: the socket is closed, or its buffer is past backpressureLimit) or the bytes
  // written. Only a drop is a failure: false, so the caller can say so instead of waiting on a reply to
  // a frame that never left.
  const sendFrame = (ws: BridgeSocket, frame: BridgeFrame): boolean => ws.send(JSON.stringify(frame)) !== 0;

  const liveClients = registry.live;
  const describe = registry.describe;
  const resolveClient = registry.resolveClient;
  const awaitClient = registry.awaitClient;

  function isConnected(): boolean {
    return liveClients().length > 0;
  }

  function listClients(): ClientRow[] {
    return liveClients().map(describe);
  }

  // Server-side half of the whoami probe. The plugin reports who IT is (instanceId, file, fileKey);
  // this reports what the SOCKETS did. `takeovers` is retained and always 0 since connections
  // coexist — kept rather than removed so an older reader of this field sees "no displacement is
  // happening" instead of the key vanishing.
  // `connId`: describe THAT connection (the one a request was addressed to) instead of the
  // first live one; see connectionFor. Omitted = the first live connection.
  function connectionInfo(connId?: string): ConnectionInfo {
    const live = liveClients();
    const first = live[0];
    const info: ConnectionInfo = {
      connId: first ? first.connId : null,
      connected: live.length > 0,
      connectedAt: first ? first.connectedAt : null,
      connectionUptimeMs: first ? Date.now() - first.connectedAt : 0,
      connectionsThisRun: registry.connections(),
      clientsConnected: live.length,
      clients: live.map(describe),
      takeovers,
      lastTakeoverAt: lastTakeoverAt || null,
    };
    return connectionFor(info, connId);
  }

  // `target` is optional and LAST so every existing three-argument call site keeps working unchanged:
  // with one file connected it resolves to that file, which is the single-file behaviour.
  // `stallMs` (opt-in — undefined leaves today's behaviour untouched for every existing caller,
  // including the daemon and MCP paths) is a SEPARATE, SHORTER wait for any sign of life from this
  // specific client, checked independently of the real per-command timeout: a real pull measured
  // a 300s/908s silent wait — on a connected, identified bridge — for work that takes
  // 7.5-8.8s once a daemon keeps the plugin warm. A stalled one-shot connection (the shape of both
  // measurements: no `dtwin serve` running) shows NO activity at all on the socket — not even a
  // progress frame — for the whole wait, where a genuinely large/slow export shows life through the
  // progress relay (see the `ws.on("message")` handler above). The check is armed only until that
  // first sign of life: a working export can go quiet for minutes (see the loop below). Only
  // figma-pull.ts's own one-shot bridge (no daemon) opts into this, and only for export-class
  // commands — a cheap `whoami`/`list` finishing in under a second never needs it, and the daemon path
  // deliberately does NOT pass it: a persistent connection is exactly the case that is
  // already fast, so there is nothing here worth protecting against on that path.
  // The clock starts at SEND, after the caller's connect + identify waits, so a stall never measures
  // the plugin's reconnect. A current plugin answers within moments of the send even when it cannot
  // start yet: a `queued` frame when its run waits behind another, a `start` frame when the run begins
  // (figma-plugin state.ts / ui.html). So silence here means a plugin too busy to dispatch the frame
  // at all (a long synchronous stretch of an earlier run) — or an older plugin with neither frame.
  const STALL_POLL_MS = 500;
  // Typed per command from commands.ts: `args` is what the plugin reads for `cmd`, and the reply is
  // what it sends back — checked structurally on arrival (the message handler above), so the type
  // here is a promise the runtime keeps rather than a cast.
  // `onProgress` (optional, last) receives every progress tick the chosen connection sends while this
  // request is in flight — the plugin relays them during a bridge-triggered export.
  // `signal`: the caller's way to give up on the request — the daemon aborts it when
  // ITS client disconnects. See requestWithClient for what an abort does on the wire, and for `opts`.
  function request<C extends Cmd>(cmd: C, args: Commands[C]["args"], timeoutMs: number = TIMEOUTS.command, target?: string | null, stallMs?: number, onProgress?: (tick: ProgressTick) => void, signal?: AbortSignal, opts: RequestOptions = {}): Promise<Commands[C]["reply"]> {
    return requestWithClient(cmd, args, timeoutMs, target, stallMs, onProgress, signal, opts).then((o) => o.reply);
  }

  // CANCEL. Whenever this side gives up on a request it has already sent —
  // the per-command timeout, the stall check, close(), or the caller's `signal` — the plugin is told,
  // or it keeps walking the export for nobody and queues every later command behind it. The frame is
  // `{ type: "cancel", id }` (no `cmd`): best-effort, sent only on an OPEN socket, and nothing is ever
  // awaited back. A plugin that already finished, or never heard of `id`, ignores it; so does an older
  // plugin bundle that predates the frame (it reads a frame without `cmd` as nothing to run). A
  // duplicate for the same id is equally harmless. A socket that CLOSES is itself a cancel on the
  // plugin side, which is why the one-shot CLI (whose exit closes the socket) needs nothing more.
  function cancelOnWire(client: ClientEntry, id: string): void {
    if (client.ws.readyState !== WS_OPEN) return;
    try { sendFrame(client.ws, { type: "cancel", id }); } catch { /* socket went away — closing it is a cancel too */ }
  }

  // The same, also answering WHICH connected file the command went to — the client resolveClient
  // picked for `target`, described exactly as listClients() would. figma-pull.ts stamps that onto a
  // screen export as `sourceFile` without re-implementing the matching rules.
  //
  // `opts.waitMs` (> 0): wait for `target` first, with that connect window (awaitClient) — the MCP server
  // passes it for a named `client`, the daemon for a request that carries a connect window. Without it
  // the target is resolved against whatever is connected now — once the bridge has settled (awaitClient).
  //
  // `signal`: already aborted, or aborted during the wait → rejects with the signal's reason when that is
  // an Error of the caller's own, else "request aborted before it was sent", and nothing is sent;
  // aborted while pending → the cancel frame goes to the plugin, the request is forgotten, and the promise rejects with the signal's reason when that is an Error of the
  // caller's own (the daemon passes one naming its departed client), else "request aborted by the caller".
  function requestWithClient<C extends Cmd>(cmd: C, args: Commands[C]["args"], timeoutMs: number = TIMEOUTS.command, target?: string | null, stallMs?: number, onProgress?: (tick: ProgressTick) => void, signal?: AbortSignal, opts: RequestOptions = {}): Promise<RequestOutcome<C>> {
    if (signal?.aborted) return Promise.reject(abortReason(signal, "request aborted before it was sent"));
    // A bridge that is still settling holds every request for the rest of that window (awaitClient routes
    // a connId or fileKey at once), so a fresh bridge never routes a vague one to the first file to land.
    // A connect window shorter than the rest of the settle is stretched to it inside awaitClient.
    const asked = opts.waitMs ?? 0;
    const waitMs = Math.max(asked > 0 ? asked : 0, registry.settleLeft());
    if (!(waitMs > 0)) return dispatch(cmd, args, timeoutMs, target, stallMs, onProgress, signal);
    return awaitClient(target, waitMs, signal).then(() => {
      if (signal?.aborted) throw abortReason(signal, "request aborted before it was sent");
      return dispatch(cmd, args, timeoutMs, target, stallMs, onProgress, signal);
    });
  }

  // requestWithClient after its wait: resolve the target now, send, and settle on the reply.
  function dispatch<C extends Cmd>(cmd: C, args: Commands[C]["args"], timeoutMs: number, target: string | null | undefined, stallMs: number | undefined, onProgress: ((tick: ProgressTick) => void) | undefined, signal: AbortSignal | undefined): Promise<RequestOutcome<C>> {
    return new Promise<RequestOutcome<C>>((resolve, reject) => {
      let client: ClientEntry;
      try {
        client = resolveClient(target);
      } catch (e) {
        return reject(e);
      }
      const id = "r" + nonce + "-" + ++seq;
      // Removed on settle (every path below goes through `unlisten`), so a long-lived signal shared by
      // many requests never accumulates listeners.
      let onAbort: (() => void) | null = null;
      const unlisten = () => { if (signal && onAbort) signal.removeEventListener("abort", onAbort); onAbort = null; };
      // The per-command budget is for the RUN. It is armed at send, which bounds a wait in the plugin's queue behind
      // an earlier run in that file (figma-plugin state.ts scheduleRun — the one queue on every path, so the wait
      // is not otherwise bounded here), and re-armed in full when the plugin says this request's run has begun (its
      // own `start` frame, `started` below): a run that began late is not cut short by the time it spent waiting.
      const onTimeout = () => {
        if (pending.has(id)) {
          pending.delete(id);
          if (stallTimer) clearInterval(stallTimer);
          unlisten();
          cancelOnWire(client, id);
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
      };
      let timer = setTimeout(onTimeout, timeoutMs);
      let stallTimer: ReturnType<typeof setInterval> | null = null;
      if (typeof stallMs === "number" && stallMs > 0) {
        const sentAt = Date.now();
        const framesAtSend = client.frames;
        stallTimer = setInterval(() => {
          if (!pending.has(id)) return; // settled already — the interval's own clear below is racing it
          // LIVE (2026-09-25): a real one-page export goes legitimately quiet for longer than any
          // sensible window — measured 14–24 s at the end of one large top-level frame (the tree is
          // counted and measured before the next tick) and 116–135 s between the last page tick and
          // the reply (catalog build, then a 120 MB reply serialised and sent) — so "quiet for stallMs
          // at ANY point" aborted a working export and left the plugin walking for nobody. The stall
          // this exists to catch is a connection that never shows life for the
          // request at all; so the check disarms itself on the FIRST frame after the send — by COUNT
          // (`frames`), not by clock: a timestamp compare read a client that connected in the same
          // millisecond as the send as life since the send — and the real per-command timeout bounds
          // everything after that (as it always did on the daemon path, which never opts in).
          if (client.frames > framesAtSend) { if (stallTimer) clearInterval(stallTimer); stallTimer = null; return; }
          if (Date.now() - sentAt < stallMs) return;
          pending.delete(id);
          if (stallTimer) clearInterval(stallTimer);
          clearTimeout(timer);
          unlisten();
          cancelOnWire(client, id);
          const nodeId = "nodeId" in args && typeof args.nodeId === "string" ? args.nodeId : "";
          const node = nodeId ? ` (node ${nodeId})` : "";
          // Only reachable after connect + identify (the clock starts at send), so the plugin IS
          // connected: say that, and name what keeps a connected plugin silent.
          reject(new Error(
            `the plugin is connected but sent nothing for '${cmd}'${node} in ${Math.round(stallMs / 1000)}s — it is busy (an earlier export ` +
            `still running in that file, possibly one this command's predecessor abandoned, or a long cold first read of a large page). ` +
            `Retry; a warm plugin (\`dtwin serve\` in another terminal) answers in seconds; if it keeps happening, check the plugin window.`
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
        ...ifDefined("onProgress", onProgress),
        started: () => { clearTimeout(timer); timer = setTimeout(onTimeout, timeoutMs); },
        resolve: (v) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); unlisten(); settle(v); },
        reject: (e) => { clearTimeout(timer); if (stallTimer) clearInterval(stallTimer); unlisten(); reject(e); },
      });
      if (signal) {
        const sig = signal;
        onAbort = () => {
          const p = pending.get(id);
          if (!p) return; // settled already
          pending.delete(id);
          cancelOnWire(client, id);
          p.reject(abortReason(sig, "request aborted by the caller"));
        };
        sig.addEventListener("abort", onAbort, { once: true });
      }
      if (!sendFrame(client.ws, { id, cmd, args })) {
        // Dropped (see sendFrame): nothing will ever answer it, so fail it now rather than at its timeout.
        const p = pending.get(id);
        pending.delete(id);
        p?.reject(new Error(
          `could not send '${cmd}' to the Figma plugin (${client.connId}): its socket is closing, or its send buffer is past ` +
          `the ${maxPayloadMb} MB limit (FIGMA_BRIDGE_MAX_PAYLOAD_MB). Retry once the plugin has reconnected.`
        ));
      }
    });
  }

  // Shut the server down so the process can exit ON ITS OWN. Without this a caller's only way out was
  // process.exit(), which on a PIPE discards whatever stdout hasn't flushed — stdout is async for pipes
  // (seen under Node, before the Bun port), so a large `--list` payload was silently cut at one 64KB
  // pipe buffer (measured: 369,799 bytes written, 65,536 delivered). Letting the event loop drain instead is the only fix
  // that keeps the whole payload; the WS server is what was holding the loop open, so it has to go.
  function close(): void {
    clearInterval(heartbeat);
    // Cancel frames FIRST, while the sockets are still open: every request still pending here is work
    // the plugin would otherwise finish for nobody (see cancelOnWire). The socket close below is a
    // cancel on the plugin side too; the explicit frame names the exact request and costs nothing.
    for (const [id, p] of pending) {
      const c = clients.get(p.connId);
      if (c) cancelOnWire(c, id);
    }
    for (const p of pending.values()) p.reject(new Error("bridge closed"));
    pending.clear();
    // Close EVERY client, not just one — otherwise a second connected
    // file would hold the event loop open and the process would never exit on its own, which is the
    // whole reason this function exists.
    // close() starts a closing handshake that waits for the peer to answer it; a plugin iframe that is
    // busy (or gone) can hold this process open meanwhile. terminate() after a grace period drops the
    // socket regardless — the same backstop the bad-token path uses.
    for (const e of clients.values()) {
      try { e.ws.close(); } catch { /* already gone */ }
      setTimeout(() => { try { e.ws.terminate(); } catch { /* already gone */ } }, 2000).unref();
    }
    registry.clear(); // and every wait for a client ends now
    // Stop listening. stop(false) leaves the sockets just closed above to finish their handshake (or be
    // terminated); its promise settles when they have, which nothing here needs to wait for.
    if (server) { const s = server; server = null; void s.stop(false).catch(() => { /* already stopped */ }); }
  }

  /** The port actually bound — `port` itself, except under createBridge(0) or DT_TEST_EPHEMERAL_PORT
   *  (an ephemeral one); null when the bind failed or after close(). Test seam: a suite binds port 0 and
   *  dials this, so it never collides with a live bridge or a concurrent run. */
  const boundPort = (): number | null => server?.port ?? null;

  return {
    request, requestWithClient, isConnected, awaitClient, connectionInfo, listClients, resolveClient, close, port, listening, boundPort,
    /** test seam: one heartbeat round, run by hand — with `heartbeatMs: 0` it is the only one. */
    heartbeatTick,
  };
}

// The object createBridge() returns — what route.ts's own adapter (and through it the daemon) drives.
export type Bridge = ReturnType<typeof createBridge>;
export type { BridgeOptions };

// verifyClientWith/safeEqual are exported for the test suite (test/bridge.test.ts). They are the bridge's
// ONLY real access control, so they get direct unit coverage rather than being reachable only through
// a live WebSocket handshake.
// isConnId and connectionFor live in route.ts (side-effect free, so the front-ends reach them without this
// module's load-time token read); re-exported for the suites that test them here.
export { createBridge, maxPayloadFromEnv, createRegistry, connectionFor, isConnId, verifyClientWith, authStats, CLOSE_BAD_TOKEN, safeEqual, portInUseMessage, IDENTIFY_GRACE_MS };
