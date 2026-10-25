// daemon.ts — hold the bridge open across many CLI invocations.
//
// WHY this shape. A one-shot `figma-pull` pays a full plugin reconnect every run, and only one
// process can hold port 8787 (server-core.ts exits on EADDRINUSE), so back-to-back pulls are both
// slow and mutually exclusive. The obvious fix — "a flag that opens the connection and leaves it
// open" — does NOT work on its own: a long-running CLI has no way to receive further commands, so it
// would occupy the port while being unreachable, blocking the MCP server and every other CLI call.
//
// So: ONE long-lived process owns the bridge (`--serve`), and every other invocation becomes a thin
// client that forwards its request over a unix socket and exits. Existing commands route through the
// daemon automatically when one is running, and fall back to opening their own bridge when it isn't —
// so nothing about the current usage changes, it just gets faster when a daemon is up.
//
// A unix socket, not a second TCP port: it gets filesystem permissions for free (no verifyClient
// equivalent to write), and it cannot be reached from a browser tab the way a loopback port can.
//
// Windows: a named pipe, and a handshake in place of the directory. node:net's IPC there is a named pipe,
// and Bun (libuv underneath) gives it the default security descriptor — Everyone may read it — with no way to
// narrow it, nor for a client to ask who created the server end: another local user could create the name
// first and answer with forged replies. Nothing there plays the part of the 0700 directory below. So on
// win32 the pipe's NAME is derived from the bridge token (daemon-auth.ts pipeName), and before any frame
// both ends prove they hold that token (daemon-auth.ts, which says what that does and does not stop). Every
// serve / stop / lookup below takes that path where `handshakeOn` says so: win32 by default, and anywhere a
// caller asks (`handshake: true` — the POSIX suites drive the whole exchange that way).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AUTH_TIMEOUT_MS, clientHandshake, ipcKey, pipeName, serverHandshake } from "./daemon-auth.ts";
import type { IpcAuth } from "./daemon-auth.ts";
import { errMsg, errCode } from "./errmsg.ts";
import { ifDefined, isRecord } from "./json-util.ts";
import { abortReason } from "./abort-reason.ts";
import { deadline, systemClock } from "./clock.ts";
import { bridgePortOrExit } from "./ports.ts";
import { daemonTokenOf, idleMsFromEnv, tokenSetting } from "./settings.ts";
import { replyShapeError } from "./commands.ts";
import type { Cmd, Commands } from "./commands.ts";
import type { ClientRow, ProgressTick } from "./server-core.ts";
import type { Sent } from "./route.ts";
import { exitFlushed } from "./stdio.ts";
import { CONTROL, createServedSession } from "./served-session.ts";
import type { DaemonActivity, DaemonBridge, DaemonCommandRequest, DaemonControlRequest, DaemonReply, DaemonStatus, SessionFrame } from "./served-session.ts";
import type { Clock } from "./clock.ts";

// ---- the daemon socket protocol (newline-delimited JSON, one request -> one reply per connection). The frames, how a
// request frame is checked and what the daemon answers are the served session's (served-session.ts), which reads them;
// this module is the socket around it (serve) and the client end (request / connect / stop / status).
export { daemonRequestError, isDaemonRequest } from "./served-session.ts";
export type { DaemonActivity, DaemonBridge, DaemonCommandRequest, DaemonControlRequest, DaemonRequest, DaemonStatus } from "./served-session.ts";

/** A client row as relayed over the socket: the one field routing needs (`connId`) is checked, the rest
 *  is read as the bridge's own describe() wrote it. */
function isClientRow(x: unknown): x is ClientRow {
  return isRecord(x) && typeof x.connId === "string";
}

const finiteOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
/** The tick exactly as server-core's parseTick normalises it (every field present, null when absent).
 *  Foreign JSON from another process — possibly another build — so it is checked, never cast. */
function isProgressTick(x: unknown): x is ProgressTick {
  if (!isRecord(x)) return false;
  const p = x.page;
  const pageOk = p === null || (isRecord(p) && typeof p.index === "number" && Number.isFinite(p.index) && typeof p.of === "number" && Number.isFinite(p.of) && stringOrNull(p.name));
  return stringOrNull(x.phase) && pageOk && finiteOrNull(x.nodes) && finiteOrNull(x.assets);
}

/** Is this frame a progress frame at all: `progress` present and no `ok` (every reply has `ok`). */
const isProgressShaped = (x: unknown): x is Record<string, unknown> => isRecord(x) && !("ok" in x) && "progress" in x;

function parseDaemonReply(x: unknown): DaemonReply | null {
  if (!isRecord(x)) return null;
  if (x.ok === true) return { ok: true, result: x.result, ...(isClientRow(x.client) ? { client: x.client } : {}) };
  if (x.ok === false) return { ok: false, error: typeof x.error === "string" ? x.error : "daemon error" };
  return null;
}

/** What status() hands back: `daemon: true` is the one field every daemon has sent; a daemon from an
 *  OLDER bridge may omit the newer ones (see staleness.ts daemonRowStalenessNote), so the rest is Partial. */
export type DaemonStatusView = Partial<DaemonStatus> & { daemon: true };

function isDaemonStatus(x: unknown): x is DaemonStatusView {
  return isRecord(x) && x.daemon === true;
}

export interface ServeOptions {
  port?: number;
  log?: (m: string) => void;
  /** The idle window in ms (0 = none): the holder passes its settings' (settings.ts idleMs); absent, FIGMA_DAEMON_IDLE_MIN. */
  idleMs?: number;
  signals?: boolean;
  /** Install installCrashHandlers for this process. Defaults to `signals`: a serve() that owns the
   *  process's signals owns its lifetime too (`dtwin serve`); a host with its own lifetime (the MCP
   *  server passes signals:false) installs its own, and an in-process test passes false. */
  crashHandlers?: boolean;
  /** The platform the location and handshake are chosen for (defaults to process.platform): win32 listens
   *  on a pipe named from the token, and requires the handshake. */
  platform?: NodeJS.Platform;
  /** Require the handshake (daemon-auth.ts) from every client. Defaults to on for win32 only. */
  handshake?: boolean;
  /** The bridge token the pipe name and handshake key on (defaults to daemonToken()'s resolution). */
  token?: string | null;
  /** What the session's idle clock runs on (clock.ts; systemClock when absent) — a suite's fake one steps it. */
  clock?: Clock;
}

/** What a request through the daemon takes beside its frame (the frame carries the command, its budget, target
 *  and connect window). Every field optional.
 *  `guardMs`: the outer guard for a daemon that stopped answering entirely (route.ts sizes it, daemonGuardMs).
 *  While ticks arrive it is a SILENCE budget — each tick re-arms it (request() below says why). Absent: none.
 *  `onProgress` opts the request into progress frames and receives each tick, in order, before the promise
 *  settles. A daemon older than progress frames sends none; the request still answers.
 *  `signal`: the caller giving up. Aborting it closes this request's socket, which the daemon reads as its
 *  client leaving — a request still waiting for its plugin is never sent, a sent one gets the plugin a cancel
 *  frame (the served session's leave, served-session.ts), which drops it from the plugin's queue or stops it at its next safe point. Any
 *  daemon, old or new, treats a closed socket that way. */
export interface DaemonRequestOptions {
  guardMs?: number | undefined;
  onProgress?: ((tick: ProgressTick) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** connect()'s answer when a daemon is live: its socket, and the one way to send a command through it — the
 *  reply, and the connected file the daemon's bridge used (null from an older daemon). */
export interface DaemonConnection {
  sock: string;
  request<C extends Cmd>(msg: DaemonCommandRequest<C>, o?: DaemonRequestOptions): Promise<Sent<C>>;
}

// ---- the handshake: where, and keyed on what

const isWin = (place: { platform?: NodeJS.Platform | undefined }): boolean => (place.platform ?? process.platform) === "win32";
/** Does a connection to (or from) this place prove the token first: win32 always unless told otherwise,
 *  elsewhere only when asked. Both ends of one daemon must agree — a handshaking client never writes before
 *  the hello, and a handshaking server drops a frame that comes first. */
const handshakeOn = (place: { platform?: NodeJS.Platform | undefined; handshake?: boolean | undefined }): boolean => place.handshake ?? isWin(place);

/** The bridge token the pipe name and the handshake key on: the place's own when it names one (an entry passes
 *  its settings' — settings.ts daemonPlace), else the environment's by the same resolution (settings.ts
 *  tokenSetting / daemonTokenOf): null when nothing is saved yet or a token file cannot be read. */
export function daemonToken(place: SockPlace = {}): string | null {
  if (place.token !== undefined) return place.token;
  return daemonTokenOf(tokenSetting({ ...(place.env ? { env: place.env } : {}) }));
}

/** Why a handshaking daemon cannot be named or served: no token to key it on. */
export const NO_DAEMON_TOKEN = "no bridge token is saved yet, so the daemon's pipe cannot be named — start a bridge once (any dtwin command that connects to Figma saves one) and try again";

/** The handshake for `sock` at `place`, or null where none is used. Throws NO_DAEMON_TOKEN without a token. */
function ipcAuth(sock: string, place: SockPlace): IpcAuth | null {
  if (!handshakeOn(place)) return null;
  const token = daemonToken(place);
  if (token === null) throw new Error(NO_DAEMON_TOKEN);
  return { key: ipcKey(token), name: sock };
}

/** The refusal when something that cannot prove the token holds the daemon's name: not ours, and nothing
 *  was sent to it. ONE spelling (serve, and a request whose daemon fails the handshake). */
export function foreignHolder(sock: string): Error {
  return new Error(`${sock} is held by a process that could not prove it knows your bridge token — not a dtwin daemon of yours, so nothing was sent to it. ` +
    "If it outlives your own dtwin sessions, another user may be squatting the name: `dtwin --rotate-token` moves the daemon to a new one.");
}

// ---- where the socket lives
//
// The socket answers without a token, so its DIRECTORY is the access control: only a directory that
// this user owns and nobody else can enter is safe. os.tmpdir() alone is not — on macOS it is a
// per-user 0700 directory, but on Linux it is usually /tmp (mode 1777, shared), where another local
// user could bind the socket name first: our CLI would then take forged replies from their process,
// and our `serve` could not remove their file (sticky bit).
//
// So, on POSIX: $XDG_RUNTIME_DIR when it is an absolute path to a directory that passes the check
// below (the XDG Base Directory spec requires it to be owned by the user with mode 0700); otherwise
// `<tmpdir>/designtwin-<uid>`, created 0700. An existing directory is used only if it is a real
// directory (not a symlink), owned by this uid, with no group/other permission bits. One that fails is
// REFUSED, never chmod-ed: we never create it looser than 0700, so a looser one was opened by someone,
// and whatever it already holds cannot be trusted. Inside a directory that passes, no other user can
// create, replace or remove an entry, so the socket file in it is ours; it is still checked (owner)
// before use, as a second line.
//
// Windows (no process.getuid) keeps os.tmpdir() unchanged: a per-user directory there, and POSIX
// mode bits do not apply. (No socket file lives there anyway: on win32 the daemon is a named pipe — winPipe.)
//
// Length: the kernel limits a Unix socket address to sockaddr_un.sun_path — 108 bytes on Linux, 104 on
// macOS, each with its terminating NUL. Bun does not hand a longer path to the kernel as it is: on Linux
// it binds and connects through /proc/self/fd/<dir fd>/<name> (bun-usockets bsd.c), so any length works
// there. On macOS, only a recent Bun has the equivalent (fchdir into the directory, then the bare name);
// an older one fails with ENAMETOOLONG — and Node (before the Bun port) silently TRUNCATED the path and bound a
// different file. So on macOS a path over 103 bytes is refused here, by sockPath, with the fix named
// (MAX_SOCK_PATH_BYTES), rather than left to whichever of those the running Bun does. It takes a long
// TMPDIR to get there: a default macOS tmpdir is ~48 bytes, so `<tmpdir>/designtwin-<uid>/designtwin-<port>.sock`
// is ~84 bytes; /run/user/<uid>/designtwin-<port>.sock (Linux, XDG_RUNTIME_DIR) ~36.

/** Why `dir` is not safe to hold this user's socket, or null when it is. */
export function privateDirProblem(dir: string, uid: number): string | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch (e) { return "cannot stat it (" + errMsg(e) + ")"; }
  if (st.isSymbolicLink()) return "it is a symlink";
  if (!st.isDirectory()) return "it is not a directory";
  if (st.uid !== uid) return `it is owned by uid ${st.uid}, not ${uid}`;
  if ((st.mode & 0o077) !== 0) return `its mode is ${(st.mode & 0o777).toString(8).padStart(4, "0")} (group/other may access it; it must be 0700)`;
  return null;
}

export interface SockPlace {
  env?: NodeJS.ProcessEnv;
  /** The base for the fallback directory (defaults to os.tmpdir()). */
  tmpdir?: string;
  /** The owner to require (defaults to process.getuid(); an explicit undefined = no POSIX uids, as on Windows). */
  uid?: number | undefined;
  /** The platform the location is chosen for (defaults to process.platform): win32 is a named pipe. */
  platform?: NodeJS.Platform;
  /** Prove the token before any frame (daemon-auth.ts). Defaults to on for win32 only (handshakeOn). */
  handshake?: boolean;
  /** The bridge token (defaults to daemonToken()'s resolution; null = none saved). */
  token?: string | null;
}

function placeUid(place: SockPlace): number | undefined {
  return "uid" in place ? place.uid : process.getuid?.();
}

/** The directory the daemon socket lives in — created if needed, and checked. Throws when the
 *  directory exists but is not private to this user. */
export function sockDir(place: SockPlace = {}): string {
  return findSockDir(place, true);
}

// `create` false (a lookup): a directory that does not exist yet is null — no daemon can be listening
// in it, and nothing is created or connected to (a directory someone makes after this look is never
// trusted unchecked).
function findSockDir(place: SockPlace, create: true): string;
function findSockDir(place: SockPlace, create: boolean): string | null;
function findSockDir(place: SockPlace, create: boolean): string | null {
  const tmpdir = place.tmpdir ?? os.tmpdir();
  const uid = placeUid(place);
  if (uid === undefined) return tmpdir;
  const xdg = (place.env ?? process.env).XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg) && privateDirProblem(xdg, uid) === null) return xdg;
  const dir = path.join(tmpdir, `designtwin-${uid}`);
  if (!create) {
    try { fs.lstatSync(dir); } catch (e) { if (errCode(e) === "ENOENT") return null; }
  } else {
    // mode is narrowed further by the umask, never widened; an existing directory is left as it is and
    // judged by the check below.
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const bad = privateDirProblem(dir, uid);
  if (bad) throw new Error(`refusing to use ${dir} for the dtwin daemon socket: ${bad}. ${SOCK_FIX}`);
  return dir;
}

/** What to do about a refused socket location — quoted by every refusal, and by `dtwin doctor`. */
export const SOCK_FIX = "Remove it (or have its owner remove it), or point XDG_RUNTIME_DIR or TMPDIR at a directory only you can access.";

/** Why the existing file at `sock` must not be used (connected to, or removed), or null — also null
 *  when there is no file yet. */
export function sockFileProblem(sock: string, uid: number): string | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(sock); } catch { return null; }
  return st.uid === uid ? null : `it is owned by uid ${st.uid}, not ${uid}`;
}

// Without an explicit port, the one a bridge binds: FIGMA_BRIDGE_PORT parsed as settings.ts does, so " 8788"
// names the 8788 socket and a value no plugin can reach exits with the same message rather than
// naming a socket no bridge ever serves.
function sockName(port: number | undefined, place: SockPlace): string {
  return `designtwin-${port || bridgePortOrExit((place.env ?? process.env).FIGMA_BRIDGE_PORT)}.sock`;
}

// win32: the named pipe for `port`, named from the token (daemon-auth.ts pipeName) — null with no token,
// where no daemon of ours can be listening. No directory, no file, no length or owner check: a pipe is not
// a path in any filesystem, and goes away with the process that holds it.
function winPipe(port: number | undefined, place: SockPlace): string | null {
  const token = daemonToken(place);
  return token === null ? null : pipeName(token, port || bridgePortOrExit((place.env ?? process.env).FIGMA_BRIDGE_PORT));
}

// Keyed by PORT so two bridges on different ports get two daemons rather than fighting over one socket.
// Throws when the location is refused (sockDir, or a socket file that is not ours): that is final for
// the commands that create or stop a daemon (serve, assertNoDaemon, stop). A lookup that only asks "is
// a daemon running?" goes through lookupSock instead. On win32 it is the pipe (winPipe), and the one
// refusal is having no token to name it with.
export function sockPath(port?: number, place: SockPlace = {}): string {
  if (isWin(place)) {
    const pipe = winPipe(port, place);
    if (pipe === null) throw new Error(NO_DAEMON_TOKEN);
    return pipe;
  }
  const dir = sockDir(place);
  return path.join(dir, checkedSockName(port, place, dir));
}

/** The longest socket path (bytes, without the NUL) `platform` is held to — see "Length" above. Only
 *  macOS has one: on Linux Bun reaches any length through /proc/self/fd. */
export const MAX_SOCK_PATH_BYTES: Partial<Record<NodeJS.Platform, number>> = { darwin: 103 };

/** Why `sock` is too long to be a socket path on `platform`, or null. */
export function sockLengthProblem(sock: string, platform: NodeJS.Platform = process.platform): string | null {
  const max = MAX_SOCK_PATH_BYTES[platform];
  const bytes = Buffer.byteLength(sock);
  if (max === undefined || bytes <= max) return null;
  return `refusing to use ${sock} as the dtwin daemon socket: it is ${bytes} bytes, and a Unix socket path on ${platform === "darwin" ? "macOS" : platform} is limited to ${max}. ` +
    "Point XDG_RUNTIME_DIR or TMPDIR at a shorter directory only you can access.";
}

function checkedSockName(port: number | undefined, place: SockPlace, dir: string): string {
  const name = sockName(port, place);
  const uid = placeUid(place);
  const sock = path.join(dir, name);
  const tooLong = sockLengthProblem(sock, place.platform);
  if (tooLong) throw new Error(tooLong);
  const bad = uid === undefined ? null : sockFileProblem(sock, uid);
  if (bad) throw new Error(`refusing to use ${sock} as the dtwin daemon socket: ${bad}. ${SOCK_FIX}`);
  return name;
}

// sockPath for a lookup: null when the directory does not exist (nothing created), or on win32 when there
// is no token to name the pipe with; throws a refusal.
function findSock(port: number | undefined, place: SockPlace): string | null {
  if (isWin(place)) return winPipe(port, place);
  const dir = findSockDir(place, false);
  return dir === null ? null : path.join(dir, checkedSockName(port, place, dir));
}

/** Why the socket for `port` cannot be used, or null when it can — the refusal as a value, without
 *  creating anything. Null on win32: a pipe has no location to refuse (the handshake is its check). */
export function sockProblem(port?: number, place: SockPlace = {}): string | null {
  if (isWin(place)) return null;
  try { findSock(port, place); return null; } catch (e) { return errMsg(e); }
}

// A refused location must not take every command down with it. Anyone able to create
// <tmpdir>/designtwin-<uid> first (a shared /tmp) could otherwise lock this user out of dtwin
// entirely. So the "is a daemon running?" lookups (connect, status) read a refusal as "no daemon" —
// the one-shot path then runs exactly as it does without a daemon — and say so ONCE per process, on
// stderr (stdout is the MCP server's protocol channel, and a CLI's data).
let refusalWarned = false;
function lookupSock(port: number | undefined, place: SockPlace): string | null {
  try { return findSock(port, place); } catch (e) {
    if (!refusalWarned) {
      refusalWarned = true;
      console.error("[dtwin] " + errMsg(e) + " Going on without a daemon.");
    }
    return null;
  }
}

// lookupSock plus its handshake: null (no daemon) when either says so — handshaking with no token to key
// on is "no daemon" for a lookup, as a refused location is.
function lookupAuthed(port: number | undefined, place: SockPlace): { sock: string; auth: IpcAuth | null } | null {
  const sock = lookupSock(port, place);
  if (!sock) return null;
  try { return { sock, auth: ipcAuth(sock, place) }; } catch { return null; }
}

/** The socket of a daemon started by an earlier dtwin build, which listened directly in the tmpdir
 *  (<tmpdir>/designtwin-<port>.sock) — when a socket owned by this user is there and it is not the
 *  current location; otherwise null. Only ever used to stop that daemon or to name it in an error. */
export function legacySock(port?: number, place: SockPlace = {}): string | null {
  if (isWin(place)) return null; // no build ever served a daemon on Windows before the pipe
  const uid = placeUid(place);
  if (uid === undefined) return null; // no uids: the current location IS the tmpdir
  const sock = path.join(place.tmpdir ?? os.tmpdir(), sockName(port, place));
  let st: fs.Stats;
  try { st = fs.lstatSync(sock); } catch { return null; }
  if (!st.isSocket() || st.uid !== uid) return null;
  let current: string | null = null;
  try { const dir = findSockDir(place, false); current = dir && path.join(dir, sockName(port, place)); } catch { /* refused: not the current one */ }
  return sock === current ? null : sock;
}

// Newline-delimited JSON. JSON.stringify escapes literal newlines, so a bare "\n" is an unambiguous
// frame terminator even for a 24MB export — but the frame can arrive in many chunks, so callers must
// buffer until they see one. Both sides use this to avoid two subtly different reassembly loops.
// Chunks are strings: every socket fed here has setEncoding("utf8"), whose decoder holds back a
// multi-byte character split across reads. Only the NEW chunk is searched for "\n", and the pieces
// of an unfinished frame are joined once, when its newline arrives: appending to one buffer and
// searching it from the start on every chunk is quadratic in the frame size (a 100 MB export in
// 64 KB reads spent tens of seconds just being split).
export function framer(onFrame: (line: string) => void): (chunk: string) => void {
  let parts: string[] = [];
  return (chunk) => {
    let start = 0;
    let i;
    while ((i = chunk.indexOf("\n", start)) >= 0) {
      const tail = chunk.slice(start, i);
      start = i + 1;
      let line = tail;
      if (parts.length) { parts.push(tail); line = parts.join(""); parts = []; }
      if (line) onFrame(line);
    }
    if (start < chunk.length) parts.push(start ? chunk.slice(start) : chunk);
  };
}

// ---------------------------------------------------------------- server

/** The refusal `--serve` gives when a daemon already holds this socket. ONE spelling: figma-pull.ts
 *  asks before it opens a bridge of its own, and serve() asks again right before listening. */
export function alreadyRunning(sock: string): Error {
  return new Error(`a dtwin daemon is already running on ${sock} — stop it with --stop`);
}

/** The socket path for `port` — or a throw if a LIVE daemon already answers on it, or (handshaking) if
 *  something that cannot prove the token holds the name (foreignHolder). */
export async function assertNoDaemon(port?: number, place: SockPlace = {}): Promise<string> {
  const sock = sockPath(port, place);
  // A socket file left by a crashed daemon is NOT a running daemon. Probing it first (rather than
  // unlinking unconditionally) is what keeps `--serve` from silently stealing a live daemon's socket.
  const held = await probeAs(sock, ipcAuth(sock, place));
  if (held === "live") throw alreadyRunning(sock);
  if (held === "foreign") throw foreignHolder(sock);
  return sock;
}

// The `exit` hook that removes the socket file when a `signals: false` host (the MCP server) goes
// away. Registered ONCE per process, over a set of live socket paths: figma-mcp re-serves after every
// `dtwin stop`, and a listener per serve() call would pile up (and warn) over a long session.
const exitUnlink = new Set<string>();
let exitHooked = false;
function unlinkOnExit(sock: string): () => void {
  exitUnlink.add(sock);
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => { for (const s of exitUnlink) { try { fs.unlinkSync(s); } catch { /* already gone */ } } });
  }
  return () => { exitUnlink.delete(sock); };
}

// Last-resort handlers for the LONG-LIVED processes only (the `dtwin serve` daemon, the MCP server) —
// never a one-shot CLI run, where the runtime's default (print the stack, exit non-zero) is already right.
// Both log ONE line through errMsg, so the cause reaches stderr the process's own log format.
//  - uncaughtException: log, run `cleanup` (synchronous only), then exit 1. The Node docs are explicit
//    that carrying on is unsafe: "The correct use of 'uncaughtException' is to perform synchronous
//    cleanup of allocated resources (e.g. file descriptors, handles, etc) before shutting down the
//    process. It is not safe to resume normal operation after 'uncaughtException'."
//  - unhandledRejection: log only. A stray rejected promise (a tool whose caller went away, a late
//    socket write) must not take down the user's whole stdio MCP session or a daemon mid-export with it.
// Installed at most once per process: figma-mcp re-serves after every `dtwin stop`. Each call's `cleanup` is kept,
// though (the MCP server installs first, with its own; a serve() that installs too adds the daemon's shutdown), and all
// of them run, in order, each in its own try — the returned function drops that cleanup again (a stopped daemon).
// The cleanups are what release the PORT and the socket: Bun.serve's stop() and net.Server's close() stop listening
// synchronously, so by the time the exit waits on stderr the port is already free for the next bridge. That wait is
// capped short (CRASH_FLUSH_CAP_MS): a host restarting the server right away must not find the old process still
// holding 8787 — or still alive — because a reader stopped draining its stderr.
const CRASH_FLUSH_CAP_MS = 200;
// The first SIGINT / SIGTERM's wait for stderr (serve() below); a second one does not wait at all.
const SIGNAL_FLUSH_CAP_MS = 300;
let crashHandlersInstalled = false;
const crashCleanups = new Set<() => void>();
export function installCrashHandlers(log: (m: string) => void, cleanup?: () => void): () => void {
  if (cleanup) crashCleanups.add(cleanup);
  const forget = (): void => { if (cleanup) crashCleanups.delete(cleanup); };
  if (crashHandlersInstalled) return forget;
  crashHandlersInstalled = true;
  process.on("unhandledRejection", (reason) => {
    log("unhandled promise rejection (continuing): " + errMsg(reason));
  });
  process.on("uncaughtException", (e) => {
    // Say why, release (synchronously: the port and socket are free before anything waits), then wait — briefly — for
    // those lines to reach stderr.
    log("uncaught exception — exiting: " + errMsg(e));
    for (const c of [...crashCleanups]) { try { c(); } catch { /* exiting anyway */ } }
    exitFlushed(1, CRASH_FLUSH_CAP_MS);
  });
  return forget;
}

/** serve()'s handle: the socket it listens on, and the served session's own (served-session.ts) — `activity()` (what
 *  the socket has seen, which a host reads to decide whether OTHER processes use it), `idleOut(ms)` ((re)arms the idle
 *  shutdown with a window of `ms`, 0 disarms it, and checks once AT ONCE) and `shutdown()`. */
export interface ServeHandle {
  sock: string;
  shutdown: () => void;
  activity(): DaemonActivity;
  idleOut(ms: number): void;
}

// serve() is the socket adapter around the served session (served-session.ts): the net.Server, the listen race and
// takeover of a stale socket file, the handshake, and the process's signals and crash hooks. What a frame is, what the
// daemon answers, the idle decision and cancel-on-leave are the session's.
export function serve(bridge: DaemonBridge, { port, log, idleMs: idleWindow, signals = true, crashHandlers = signals, platform, handshake, token, clock }: ServeOptions = {}): Promise<ServeHandle> {
  const place: SockPlace = { ...ifDefined("platform", platform), ...ifDefined("handshake", handshake), ...ifDefined("token", token) };
  return assertNoDaemon(port, place).then((sock) => {
    // A pipe (win32) has no file: nothing stale to remove before listening, or after.
    const pipe = isWin(place);
    // Every client proves the token before its first frame is read (null: the directory is the check).
    const auth = ipcAuth(sock, place);
    if (!pipe) { try { fs.unlinkSync(sock); } catch { /* nothing to clean up */ } }

    let forgetExit: (() => void) | null = null;
    let forgetCrash: (() => void) | null = null;
    // The session's shutdown lets the socket go FIRST (release), synchronously: stop listening, remove the socket file,
    // drop the process hooks — then it aborts its requests and closes the bridge.
    const session = createServedSession(bridge, {
      idleMs: idleWindow ?? idleMsFromEnv(),
      ...ifDefined("clock", clock),
      ...ifDefined("log", log),
      release: () => {
        try { server.close(); } catch { /* already closed */ }
        if (!pipe) { try { fs.unlinkSync(sock); } catch { /* already gone */ } }
        if (forgetExit) { forgetExit(); forgetExit = null; }
        if (forgetCrash) { forgetCrash(); forgetCrash = null; }
      },
    });
    const shutdown = session.shutdown;

    const server = net.createServer((conn) => {
      conn.setEncoding("utf8");
      const client = session.connect((frame) => { send(conn, frame); });
      // 'end' counts too: net.Server's default allowHalfOpen:false ends our side as soon as the peer
      // ends its own, so no reply could be written after it anyway.
      conn.on("close", client.leave);
      conn.on("end", client.leave);
      // A client that dies mid-export must not take the daemon with it: the write in send() would emit
      // EPIPE on a dead socket, which is an unhandled 'error' event => process exit.
      conn.on("error", client.leave);
      const onFrames = framer(client.line);
      if (!auth) { conn.on("data", onFrames); return; }
      // Handshaking: until the client has proved the token, its bytes go to the handshake (capped, timed),
      // never to the frame reader — so no __ping, no __status and no request is read, and no activity
      // counted, before that. A failure is a silent destroy: the peer learns only that the pipe closed.
      const hs = serverHandshake(auth, {
        write: (line) => { try { conn.write(line + "\n"); } catch { /* the client went away */ } },
        sink: onFrames,
        fail: () => { try { conn.destroy(); } catch { /* already gone */ } },
      });
      conn.on("data", hs.data);
      conn.on("close", hs.stop);
    });

    // Ctrl-C / kill must remove the socket file, or the next --serve refuses to start against a
    // socket nobody is listening on. `as const`: process.on's overload wants NodeJS.Signals, not string.
    // shutdown() releases the socket file, the socket and the port synchronously; the exit then waits for the log lines
    // to reach stderr — briefly (SIGNAL_FLUSH_CAP_MS: Ctrl-C must feel instant, and a supervisor's SIGKILL follows its
    // SIGTERM soon after). A SECOND signal is a person (or supervisor) insisting: exit at once, waiting on nothing.
    if (signals) {
      let signalled = false;
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
        if (signalled) { exitFlushed(0, 0); return; }
        signalled = true;
        shutdown();
        exitFlushed(0, SIGNAL_FLUSH_CAP_MS);
      });
    }
    // A host that exits some other way (the MCP server ends when its stdio closes) still must not
    // leave the socket file behind for the next probe to trip over. One process-level hook, and this
    // socket is forgotten again on shutdown (the MCP server re-serves after every `dtwin stop`).
    else if (!pipe) forgetExit = unlinkOnExit(sock);
    // shutdown() is synchronous (closes the servers, unlinks the socket file), so it is exactly the
    // "synchronous cleanup" the Node docs allow an uncaughtException handler before it exits.
    if (crashHandlers) forgetCrash = installCrashHandlers(log ?? ((m) => console.error("[dtwin] " + m)), shutdown);

    const handle: ServeHandle = { sock, shutdown, activity: session.activity, idleOut: session.idleOut };
    return new Promise<ServeHandle>((resolve, reject) => {
      const onListening = () => {
        if (log) log(`daemon listening on ${sock} (pid ${process.pid}) — stop it with: dtwin --stop`);
        resolve(handle);
      };
      // The probe-then-unlink-then-listen window is a race: another `--serve` can bind between our
      // probe and our listen. EADDRINUSE from listen() is that case — re-probe, and either refuse
      // (it is alive) or take over the stale file it left (it is not), exactly once.
      // A pipe has no stale file to take over: a name that is taken is held by a live process, ours
      // (alreadyRunning) or not (foreignHolder). And ANY listen error there is read as "taken, maybe":
      // Bun has reported a taken pipe name as ERR_INVALID_ARG_TYPE, not EADDRINUSE, so the re-probe
      // decides, and an error with nothing holding the name is passed on as it came.
      const failed = (e: NodeJS.ErrnoException): void => {
        if (!pipe && e.code !== "EADDRINUSE") return reject(e);
        probeAs(sock, auth).then((held) => {
          if (held === "live") return reject(alreadyRunning(sock));
          if (held === "foreign") return reject(foreignHolder(sock));
          if (pipe) return reject(e);
          try { fs.unlinkSync(sock); } catch { /* gone already */ }
          server.once("error", reject);
          server.listen(sock, onListening);
        }, reject);
      };
      server.once("error", failed);
      // A listen that throws instead of emitting (a runtime's pipe-path bug) takes the same road.
      try { server.listen(sock, onListening); } catch (e) { server.removeListener("error", failed); failed(e as NodeJS.ErrnoException); }
    });
  });
}

function send(conn: net.Socket, obj: SessionFrame): void {
  try { conn.write(JSON.stringify(obj) + "\n"); } catch { /* client went away mid-reply */ }
}

// ---------------------------------------------------------------- client

// Is there a LIVE daemon? A stale socket file (crashed daemon) answers ECONNREFUSED, and must read as
// "no daemon" rather than hanging or erroring — otherwise one crash makes every later CLI run fail.
// `auth` (handshaking, see ipcAuth): the __ping goes out only once the daemon has proved the token.
export function probe(sock: string, timeoutMs = 1500, auth: IpcAuth | null = null): Promise<boolean> {
  return probeAs(sock, auth, timeoutMs).then((held) => held === "live");
}

/** What holds `sock`: "live" — a daemon that answered (and, handshaking, proved the token); "none" —
 *  nothing, a stale file, or (not handshaking) something that never answered; "foreign" — handshaking,
 *  something accepted the connection but did not prove the token (a squatter, or a mute listener). */
export type ProbeResult = "live" | "none" | "foreign";

export function probeAs(sock: string, auth: IpcAuth | null, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let done = false;
    let connected = false;
    let stopHs = (): void => {};
    let c: net.Socket | null = null;
    // Handshaking, a peer that accepted and then stalled or failed holds the name: "foreign", not "none".
    const silent = (): ProbeResult => (connected && auth ? "foreign" : "none");
    const t = setTimeout(() => finish(silent()), timeoutMs);
    function finish(v: ProbeResult): void {
      if (done) return;
      done = true;
      clearTimeout(t);
      stopHs();
      try { if (v === "live") c?.end(); else c?.destroy(); } catch { /* already gone */ }
      resolve(v);
    }
    try { c = net.createConnection(sock); } catch { return finish("none"); }
    const conn = c;
    conn.on("error", () => finish(silent()));
    conn.setEncoding("utf8");
    const ping = (): void => { try { conn.write(JSON.stringify({ cmd: "__ping" }) + "\n"); } catch { finish(silent()); } };
    // Only a daemon REPLY is a daemon: a handshaking daemon's hello reaching a client that does not handshake
    // (it wrote its __ping first) is not one, and neither is anything else that happens to write a line.
    const onFrame = framer((line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch { return finish(silent()); }
      finish(parseDaemonReply(parsed) ? "live" : silent());
    });
    if (!auth) {
      conn.on("data", onFrame);
      conn.on("connect", () => { connected = true; ping(); });
      return;
    }
    const hs = clientHandshake(auth, {
      write: (l) => { try { conn.write(l + "\n"); } catch { /* the error handler settles it */ } },
      sink: onFrame,
      ready: ping,
      fail: () => finish("foreign"),
      timeoutMs,
    });
    stopHs = hs.stop;
    conn.on("data", hs.data);
    conn.on("connect", () => { connected = true; });
  });
}

// One request through a running daemon. Rejects (rather than falling back) once connected: a daemon
// that answered __ping and then failed is a real error the caller should see, not a reason to
// silently open a second bridge that would then hit EADDRINUSE against the daemon itself.
//
// `onProgress` opts the request into progress frames (`progress: true` on the wire) and receives each
// well-formed tick. A progress frame is never the reply: it is dispatched and the reader reads on. A
// malformed one (a bad tick, or a frame this client never asked for) is DROPPED, not fatal — a tick is
// advisory, and losing one must never cost the caller its export. A throwing listener is its own
// failure, as in server-core's relay.
//
// Timeout: `timeoutMs` is the outer guard for a daemon that stopped answering entirely (the daemon's
// own per-command budget, msg.timeoutMs, still bounds the whole command on the bridge side). Every
// progress frame RE-ARMS it: a tick is proof the daemon and the plugin are both alive. So with progress
// flowing the guard is a silence budget; without progress it is the same total budget it always was. It is
// clock.ts's deadline — the rule the bridge's own budgets run on (pending-requests.ts), stepped by the suites.
//
// `signal` (optional): aborted → the socket is DESTROYED and the promise rejects at once, with the
// signal's reason when it is an Error of the caller's own, else "request aborted by the caller" — the
// same rule as server-core's request. Destroying (not ending) the socket is the cancel: the
// daemon sees its client go and abandons the request on the wire. Aborted before the call → nothing
// is connected or sent.
//
// `auth` (handshaking): nothing is written until the daemon has proved the token; one that cannot is
// refused with foreignHolder and never sees the request.
function request<C extends Cmd>(sock: string, msg: DaemonCommandRequest<C> | DaemonControlRequest, timeoutMs?: number, onProgress?: (tick: ProgressTick) => void, signal?: AbortSignal, auth: IpcAuth | null = null): Promise<{ result: unknown; client: ClientRow | null }> {
  return new Promise<{ result: unknown; client: ClientRow | null }>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal, "request aborted before it was sent"));
    const c = net.createConnection(sock);
    c.setEncoding("utf8");
    let settled = false;
    let stopHs = (): void => {};
    // Removed on settle, so a long-lived signal shared by many requests never accumulates listeners.
    let onAbort: (() => void) | null = null;
    const unlisten = () => { if (signal && onAbort) signal.removeEventListener("abort", onAbort); onAbort = null; };
    const done = <V>(fn: (v: V) => void, v: V) => { if (!settled) { settled = true; unlisten(); stopHs(); try { c.end(); } catch { /* already gone */ } fn(v); } };
    // The daemon's own per-command budget still applies; this is the outer guard for a daemon that
    // stopped answering entirely. Generous by design — an --all-pages export legitimately runs long.
    // The deadline rule (clock.ts) the bridge's own budgets run on: armed now, re-armed by every tick.
    const guard = timeoutMs ? deadline(systemClock, timeoutMs, () => done(reject, new Error("daemon did not respond within " + Math.round(timeoutMs / 1000) + "s"))) : null;
    const disarm = (): void => { guard?.cancel(); };
    const arm = (): void => { guard?.rearm(); };
    c.on("error", (e) => { disarm(); done(reject, e); });
    c.on("close", () => { disarm(); done(reject, new Error("daemon closed the connection before replying")); });
    const onFrames = framer((line) => {
      if (settled) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; } catch (e) { disarm(); return done(reject, new Error("bad reply frame: " + errMsg(e))); }
      if (isProgressShaped(parsed)) {
        arm(); // activity: the silence budget starts over (see above)
        if (onProgress && isProgressTick(parsed.progress)) {
          try { onProgress(parsed.progress); } catch { /* a listener's failure is its own; the request goes on */ }
        }
        return;
      }
      disarm();
      const r = parseDaemonReply(parsed);
      if (!r) return done(reject, new Error("bad reply frame: not a daemon reply"));
      if (r.ok) done(resolve, { result: r.result, client: r.client ?? null });
      else done(reject, new Error(r.error));
    });
    // `progress: true` only with a listener: a request without one is byte-identical on the wire to
    // what it always was, so no daemon ever has a reason to send it a progress frame.
    const frame = onProgress && !CONTROL.has(msg.cmd) ? { ...msg, progress: true } : msg;
    const send = (): void => { c.write(JSON.stringify(frame) + "\n"); };
    if (!auth) {
      c.on("data", onFrames);
      c.on("connect", send);
    } else {
      const hs = clientHandshake(auth, {
        write: (l) => { try { c.write(l + "\n"); } catch { /* the close handler settles it */ } },
        sink: onFrames,
        ready: send,
        fail: () => { disarm(); done(reject, foreignHolder(sock)); try { c.destroy(); } catch { /* already gone */ } },
        // A request follows a probe that already saw this daemon prove the token, so a slow answer here is a
        // busy daemon, not a stranger: it gets the request's own budget, never less than the handshake's.
        timeoutMs: Math.max(AUTH_TIMEOUT_MS, timeoutMs ?? 0),
      });
      stopHs = hs.stop;
      c.on("data", hs.data);
    }
    if (signal) {
      const sig = signal;
      onAbort = () => {
        if (settled) return;
        disarm();
        done(reject, abortReason(sig, "request aborted by the caller"));
        try { c.destroy(); } catch { /* already gone */ }
      };
      sig.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// The routing decision every CLI command makes: use the daemon if one is live, otherwise report that
// there isn't one and let the caller open its own bridge exactly as it does without a daemon.
export async function connect(port?: number, place: SockPlace = {}): Promise<DaemonConnection | null> {
  const found = lookupAuthed(port, place);
  if (!found || !(await probe(found.sock, undefined, found.auth))) return null;
  const { sock, auth } = found;
  // The daemon's reply to a forwarded command is the plugin's own reply. The daemon's bridge already
  // checked it against commands.ts on arrival, but that was another process (and possibly an older
  // build), so it is checked again here — which is what makes the typed reply below honest rather
  // than a guess about what came over the socket.
  const send = async <C extends Cmd>(msg: DaemonCommandRequest<C>, o: DaemonRequestOptions = {}): Promise<Sent<C>> => {
    const r = await request(sock, msg, o.guardMs, o.onProgress, o.signal, auth);
    const bad = replyShapeError(msg.cmd, r.result);
    if (bad) throw new Error(`the daemon relayed an unexpected shape for ${msg.cmd}: ${bad}`);
    return { reply: r.result as Commands[C]["reply"], client: r.client };
  };
  return { sock, request: send };
}

/** Stops the live daemon for `port`: true when one was stopped, false when none was running. A refused
 *  socket location throws (sockPath); on win32 no saved token means no daemon of ours to stop: false. */
export async function stop(port?: number, place: SockPlace = {}): Promise<boolean> {
  const sock = isWin(place) ? winPipe(port, place) : sockPath(port, place);
  if (sock === null) return false;
  const auth = ipcAuth(sock, place);
  if (!(await probe(sock, undefined, auth))) return false;
  await request(sock, { cmd: "__shutdown" }, 5000, undefined, undefined, auth);
  return true;
}

/** Stops a live daemon from an earlier build (legacySock); returns its socket, or null when there is
 *  none. For `--stop` after stop() found nothing at the current location. */
export async function stopLegacy(port?: number, place: SockPlace = {}): Promise<string | null> {
  const sock = legacySock(port, place);
  if (!sock || !(await probe(sock))) return null;
  await request(sock, { cmd: "__shutdown" }, 5000);
  return sock;
}

export async function status(port?: number, place: SockPlace = {}): Promise<DaemonStatusView | null> {
  const found = lookupAuthed(port, place);
  if (!found || !(await probe(found.sock, undefined, found.auth))) return null;
  // The daemon's own __status reply: `daemon: true` is checked, the rest is read as optional (a daemon
  // from an OLDER bridge may omit newer fields — see staleness.ts daemonRowStalenessNote).
  const { result } = await request(found.sock, { cmd: "__status" }, 5000, undefined, undefined, found.auth);
  if (!isDaemonStatus(result)) throw new Error("the daemon answered __status with an unexpected shape");
  return result;
}
