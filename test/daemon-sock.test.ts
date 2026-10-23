// Where the daemon's socket lives (bridge/src/daemon.ts sockDir / sockPath). On POSIX the socket answers
// without a token, so the directory holding it must be private to this user: created 0700, and an
// existing one refused when it is a symlink, someone else's, or open to group/other. On Windows it is a pipe
// named from the token, and the handshake (daemon-auth.ts) is the check — driven here end to end.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as daemon from "../bridge/src/daemon.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";
import type { Cmd, Commands } from "../bridge/src/commands.ts";
import { checkDaemon, sharedTokenNote } from "../bridge/src/doctor.ts";
import { ipcKey, pipeName, serverHandshake } from "../bridge/src/daemon-auth.ts";
import { check, report } from "./assert.ts";
import { dtwin, dtwinSync } from "./children.ts";
import { malformed } from "./fixtures.ts";

const uid = process.getuid?.();

// Where this suite's directories go: a short one. The socket paths built below nest a few levels deep
// (<base>/b<n>/designtwin-<uid>/designtwin-<port>.sock), and macOS holds a socket path to 103 bytes
// (daemon.ts MAX_SOCK_PATH_BYTES) — under its ~48-byte os.tmpdir() (/var/folders/…/T) that nesting is
// ~105 bytes, which sockPath rightly refuses. So on POSIX the base is under /tmp (mkdtemp makes it 0700),
// as in mcp-lifecycle; Windows has no /tmp (and no socket paths: its daemon is a named pipe).
const TMP_ROOT = process.platform === "win32" ? os.tmpdir() : fs.realpathSync.native("/tmp");

// Windows: the daemon is a named pipe, named from the bridge token (daemon.ts winPipe, daemon-auth.ts pipeName).
// The location is computed, so with an injected "win32" it is checked on every OS — and nothing is created
// or looked at in the filesystem for it.
{
  const T = "w".repeat(48);
  const base = fs.mkdtempSync(path.join(TMP_ROOT, "dtwin-u-"));
  const fresh = fs.mkdtempSync(path.join(base, "f-"));
  const win = (token: string | null = T, env: NodeJS.ProcessEnv = {}): daemon.SockPlace => ({ env, tmpdir: fresh, platform: "win32", token });
  check("win32: sockPath is the pipe named from the token and the port", daemon.sockPath(8790, win()) === pipeName(T, 8790) && /^\\\\\.\\pipe\\designtwin-8790-[0-9a-f]{32}$/.test(daemon.sockPath(8790, win())));
  check("…FIGMA_BRIDGE_PORT names the port when none is passed", daemon.sockPath(undefined, win(T, { FIGMA_BRIDGE_PORT: "8788" })) === pipeName(T, 8788));
  check("…another token is another pipe", daemon.sockPath(8790, win("v".repeat(48))) !== daemon.sockPath(8790, win()));
  check("…and nothing was created for it", fs.readdirSync(fresh).length === 0);
  const throws = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e) { return e instanceof Error && re.test(e.message); } };
  check("win32 with no saved token: sockPath refuses, saying a bridge has to save one first",
    throws(() => daemon.sockPath(8790, win(null)), /no bridge token is saved yet.*start a bridge once/));
  check("…assertNoDaemon() (what `dtwin serve` asks first) refuses the same way",
    await (async () => { try { await daemon.assertNoDaemon(8790, win(null)); return false; } catch (e) { return e instanceof Error && e.message === daemon.NO_DAEMON_TOKEN; } })());
  check("…stop() is false — no daemon of ours could be named — not a throw", (await daemon.stop(8790, win(null))) === false);
  check("…connect() and status() are null", (await daemon.connect(8790, win(null))) === null && (await daemon.status(8790, win(null))) === null);
  check("win32: sockProblem() and legacySock() are null (a pipe has no location to refuse, and no earlier build served one)",
    daemon.sockProblem(8790, win()) === null && daemon.legacySock(8790, win()) === null);
  check("daemonToken: a place's own token wins, and an explicit null stays null",
    daemon.daemonToken({ token: T }) === T && daemon.daemonToken({ token: null }) === null);
  fs.rmSync(base, { recursive: true, force: true });
}

// The handshake, end to end through a served daemon (in-process). `handshake: true` makes POSIX take the exact
// path win32 takes by default, over this platform's own socket — on Windows CI this IS the pipe. A fixed token
// per place, so the suite never reads (or mints) the real user's.
{
  const T = "h".repeat(48), OTHER = "o".repeat(48);
  const PORT = 8796, SQUAT_PORT = 8797;
  const P: daemon.SockPlace = { handshake: true, token: T };
  const calls: string[] = [];
  let closed = 0;
  const bridge: DaemonBridge = {
    port: PORT, isConnected: () => true, close: () => { closed++; },
    // Every command is answered as ping is: the only one this block sends.
    request: async <C extends Cmd>(cmd: C) => { calls.push(cmd); return { reply: malformed<Commands[C]["reply"]>({ pong: true, page: "P", file: "f" }), client: null }; },
  };
  const h = await daemon.serve(bridge, { port: PORT, signals: false, crashHandlers: false, handshake: true, token: T });
  check("handshake: the daemon serves on this platform's address for the port", h.sock === daemon.sockPath(PORT, P));
  const conn = await daemon.connect(PORT, P);
  check("…a client holding the token finds it", conn !== null);
  check("…and a request round-trips through it", conn !== null && (await conn.request({ cmd: "ping", timeoutMs: 5000 }, 5000)).pong === true && calls.join() === "ping");
  check("…so does __status", (await daemon.status(PORT, P))?.daemon === true);
  const framesBefore = h.activity().frames;
  check("a client with a DIFFERENT token finds no daemon there", (await daemon.connect(PORT, { handshake: true, token: OTHER })) === null);
  check("a client that does not handshake (it sends __ping first) finds none either", (await daemon.connect(PORT, { handshake: false, token: T })) === null);
  check("…neither reached the bridge, and no frame of theirs was read (nor counted as activity)",
    calls.join() === "ping" && h.activity().frames === framesBefore);

  // The raw view of an unauthenticated peer: the public hello, then a closed socket — no reply, no error text.
  const raw = (first: string): Promise<{ got: string; closed: boolean }> => new Promise((resolve) => {
    const c = net.createConnection(h.sock);
    c.setEncoding("utf8");
    let got = "";
    const t = setTimeout(() => { c.destroy(); resolve({ got, closed: false }); }, 2500);
    c.on("data", (d: string) => { got += d; });
    c.on("error", () => { /* the close settles it */ });
    c.on("close", () => { clearTimeout(t); resolve({ got, closed: true }); });
    c.on("connect", () => c.write(first));
  });
  const ping = await raw('{"cmd":"__ping"}\n');
  check("raw: a __ping before the handshake is answered by the hello alone, then the connection closes",
    ping.closed && ping.got.split("\n").filter(Boolean).length === 1 && /"dtwin":"auth\/1"/.test(ping.got) && !/"ok"/.test(ping.got));
  const flood = await raw("x".repeat(4096));
  check("raw: a flood before the handshake is cut off (closed), not buffered", flood.closed && !/"ok"/.test(flood.got));
  check("…and neither reached the bridge", calls.join() === "ping");

  // A squatter: something holding the name that does not know the token. It speaks the handshake — under
  // another token — and records every byte a client sends it after that.
  const squatSock = daemon.sockPath(SQUAT_PORT, P);
  if (!squatSock.startsWith("\\\\")) { try { fs.unlinkSync(squatSock); } catch { /* none left over */ } }
  const leaked: string[] = [];
  const squatter = net.createServer((c) => {
    c.setEncoding("utf8");
    const hs = serverHandshake({ key: ipcKey(OTHER), name: squatSock }, { write: (l) => { try { c.write(l + "\n"); } catch { /* gone */ } }, sink: (x) => leaked.push(x), fail: () => { leaked.push("<proof refused>"); c.destroy(); } });
    c.on("data", hs.data);
    c.on("error", () => { /* the client left */ });
    c.on("close", hs.stop);
  });
  await new Promise<void>((r) => squatter.listen(squatSock, () => r()));
  check("squatter: a client holding the token finds no daemon there", (await daemon.connect(SQUAT_PORT, P)) === null);
  check("…and sent it nothing past its proof — no __ping, no request", leaked.every((x) => x === "<proof refused>"));
  let serveErr = "";
  try { await daemon.serve(bridge, { port: SQUAT_PORT, signals: false, crashHandlers: false, handshake: true, token: T }); } catch (e) { serveErr = String(e); }
  check("…`dtwin serve` on the squatted name refuses, saying the holder could not prove the token",
    /could not prove it knows your bridge token/.test(serveErr) && /--rotate-token/.test(serveErr));
  check("…and stop() there reports nothing of ours to stop (and sends the squatter no request)",
    (await daemon.stop(SQUAT_PORT, P)) === false && leaked.every((x) => x === "<proof refused>"));
  await new Promise<void>((r) => squatter.close(() => r()));

  check("stop() with the token stops the daemon", (await daemon.stop(PORT, P)) === true && closed === 1);
  check("…after which no daemon is found", (await daemon.connect(PORT, P)) === null);
}

// --rotate-token / --forget-token with a daemon running: it is stopped FIRST, under the old token — afterwards
// nothing could find it (on Windows its pipe is named from the token) while it still held the port.
for (const verb of ["--rotate-token", "--forget-token"] as const) {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, "dtwin-rot-"));
  const cfg = path.join(base, "cfg");
  fs.mkdirSync(cfg, { recursive: true, mode: 0o700 });
  const T = "r".repeat(48);
  fs.writeFileSync(path.join(cfg, "bridge-token"), T + "\n", { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, DESIGNTWIN_CONFIG_DIR: cfg, FIGMA_BRIDGE_PORT: "8789", TMPDIR: base, TEMP: base, TMP: base };
  delete env.XDG_RUNTIME_DIR;
  delete env.FIGMA_BRIDGE_TOKEN;
  delete env.FIGMA_BRIDGE_TOKEN_FILE;
  // The address the child will look at: its own default place, under the env above.
  const place: daemon.SockPlace = { env: {}, tmpdir: base, token: T };
  const sock = daemon.sockPath(8789, place);
  const seen: string[] = [];
  const auth = process.platform === "win32" ? { key: ipcKey(T), name: sock } : null;
  const fake = net.createServer((c) => {
    c.setEncoding("utf8");
    const onFrames = daemon.framer((line) => {
      const m = JSON.parse(line) as { cmd: string };
      seen.push(m.cmd);
      c.write(JSON.stringify({ ok: true, result: m.cmd === "__shutdown" ? { stopped: true } : { daemon: true, pid: 1, port: 8789 } }) + "\n");
    });
    if (!auth) c.on("data", onFrames);
    else { const hs = serverHandshake(auth, { write: (l) => c.write(l + "\n"), sink: onFrames, fail: () => c.destroy() }); c.on("data", hs.data); c.on("close", hs.stop); }
    c.on("error", () => { /* the client left */ });
  });
  await new Promise<void>((r) => fake.listen(sock, () => r()));
  // dtwin, not dtwinSync: this process serves the fake daemon meanwhile.
  const r = await dtwin([verb], { env });
  check(`${verb} with a daemon running stops it first, under the old token, and says so`,
    r.status === 0 && seen.includes("__shutdown") && /stopped the running daemon first — it was using the old token/.test(r.stderr));
  const now = (() => { try { return fs.readFileSync(path.join(cfg, "bridge-token"), "utf8").trim(); } catch { return null; } })();
  check(`…and then ${verb === "--rotate-token" ? "replaces" : "deletes"} the token`, verb === "--rotate-token" ? now !== null && now !== T : now === null);
  await new Promise<void>((r2) => fake.close(() => r2()));
  fs.rmSync(base, { recursive: true, force: true });
}

// doctor, Windows: the pipe is only as private as the token file, so a file outside the user's profile is
// said on the daemon line (judged by path — Bun cannot read an ACL).
{
  const prof = "C:\\Users\\me";
  check("doctor: a token file outside the profile is named on Windows",
    /outside your user profile/.test(sharedTokenNote("D:\\shared\\tok", prof, "win32") ?? "") && sharedTokenNote("C:\\Users\\meX\\tok", prof, "win32") !== null);
  check("…not one inside it (case-insensitive), not an env token (no file), and never off Windows",
    sharedTokenNote("c:\\users\\ME\\AppData\\Roaming\\design-twin\\bridge-token", prof, "win32") === null
    && sharedTokenNote(null, prof, "win32") === null && sharedTokenNote("/srv/shared/tok", "/home/me", "linux") === null);
  const c = checkDaemon(null, 8787, null, sharedTokenNote("D:\\shared\\tok", prof, "win32"));
  check("…as a warning on the daemon check that says how to fix it", c.status === "warn" && /outside your user profile/.test(c.detail) && /--rotate-token/.test(c.next ?? ""));
  check("…and a refused location stays the failure it is", checkDaemon(null, 8787, "refused here", "a note").status === "fail");
}
if (uid === undefined) {
  console.log("  (no POSIX uids on this platform: the socket stays in os.tmpdir())");
  check("without uids the socket directory is the tmpdir, unchanged", daemon.sockDir({ tmpdir: os.tmpdir() }) === os.tmpdir());
  report();
} else {
  const base = fs.mkdtempSync(path.join(TMP_ROOT, "dtwin-sock-"));
  let n = 0;
  const fresh = (): string => { const d = path.join(base, "b" + ++n); fs.mkdirSync(d); return d; };
  const throws = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e) { return e instanceof Error && re.test(e.message); } };
  const mode = (p: string): number => fs.statSync(p).mode & 0o777;
  const noXdg: NodeJS.ProcessEnv = {};

  // Created 0700, even under a permissive umask (umask only ever narrows mkdir's mode).
  {
    const t = fresh();
    const was = process.umask(0);
    let dir = "";
    try { dir = daemon.sockDir({ env: noXdg, tmpdir: t }); } finally { process.umask(was); }
    check("the fallback directory is <tmpdir>/designtwin-<uid>", dir === path.join(t, `designtwin-${uid}`));
    check("…created with mode 0700 (umask 0)", mode(dir) === 0o700);
    check("…and the socket is designtwin-<port>.sock inside it",
      daemon.sockPath(8790, { env: noXdg, tmpdir: t }) === path.join(dir, "designtwin-8790.sock"));
    check("an existing private directory is reused", daemon.sockDir({ env: noXdg, tmpdir: t }) === dir);
  }

  // An existing directory with group or other bits is refused — and left as it was, not chmod-ed.
  for (const m of [0o750, 0o701, 0o777]) {
    const t = fresh();
    const dir = path.join(t, `designtwin-${uid}`);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, m);
    check(`a ${m.toString(8)} directory is refused`, throws(() => daemon.sockDir({ env: noXdg, tmpdir: t }), /refusing to use .* its mode is 0?\d+ .*must be 0700/));
    check(`…and its mode is left at ${m.toString(8)}`, mode(dir) === m);
  }

  // A symlink in its place is refused, even one pointing at a private directory of our own.
  {
    const t = fresh();
    const target = path.join(t, "real");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(t, `designtwin-${uid}`));
    check("a symlink in place of the directory is refused", throws(() => daemon.sockDir({ env: noXdg, tmpdir: t }), /it is a symlink/));
  }

  // A regular file in its place is refused.
  {
    const t = fresh();
    fs.writeFileSync(path.join(t, `designtwin-${uid}`), "");
    check("a file in place of the directory is refused", throws(() => daemon.sockDir({ env: noXdg, tmpdir: t }), /not a directory/));
  }

  // Someone else's directory is refused. (The owner is simulated: the required uid is one that does
  // not own it.)
  {
    const t = fresh();
    const other = uid + 1;
    fs.mkdirSync(path.join(t, `designtwin-${other}`), { mode: 0o700 });
    check("a directory owned by another uid is refused",
      throws(() => daemon.sockDir({ env: noXdg, tmpdir: t, uid: other }), new RegExp(`owned by uid ${uid}, not ${other}`)));
  }

  // The socket file itself: one owned by another uid is not connected to or removed.
  {
    const t = fresh();
    const dir = daemon.sockDir({ env: noXdg, tmpdir: t });
    const sock = path.join(dir, "designtwin-8790.sock");
    check("no socket file yet is no problem", daemon.sockFileProblem(sock, uid) === null);
    fs.writeFileSync(sock, "");
    check("our own (stale) socket file is no problem", daemon.sockFileProblem(sock, uid) === null);
    check("a socket file owned by another uid is a problem", daemon.sockFileProblem(sock, uid + 1) === `it is owned by uid ${uid}, not ${uid + 1}`);
  }

  // XDG_RUNTIME_DIR: used when it is an absolute path to a private directory of ours; otherwise ignored.
  {
    const t = fresh();
    const xdg = path.join(t, "run");
    fs.mkdirSync(xdg, { mode: 0o700 });
    check("a private XDG_RUNTIME_DIR is used", daemon.sockDir({ env: { XDG_RUNTIME_DIR: xdg }, tmpdir: t }) === xdg);
    check("…and the socket sits directly in it",
      daemon.sockPath(8790, { env: { XDG_RUNTIME_DIR: xdg }, tmpdir: t }) === path.join(xdg, "designtwin-8790.sock"));
    check("…without creating the tmpdir fallback", !fs.existsSync(path.join(t, `designtwin-${uid}`)));
    fs.chmodSync(xdg, 0o755);
    check("an XDG_RUNTIME_DIR open to others is ignored (the private fallback is used)",
      daemon.sockDir({ env: { XDG_RUNTIME_DIR: xdg }, tmpdir: t }) === path.join(t, `designtwin-${uid}`));
    const t2 = fresh();
    fs.mkdirSync(path.join(t2, "run"), { mode: 0o700 });
    // From t2, "run" names a private directory of ours — so only the relative-path rule rejects it.
    const cwd = process.cwd();
    process.chdir(t2);
    let rel = "";
    try { rel = daemon.sockDir({ env: { XDG_RUNTIME_DIR: "run" }, tmpdir: t2 }); } finally { process.chdir(cwd); }
    check("a relative XDG_RUNTIME_DIR is ignored, per the XDG spec", rel === path.join(t2, `designtwin-${uid}`));
  }

  // The real default stays inside sun_path (103 bytes on macOS, 107 on Linux).
  {
    const real = daemon.sockPath(65535);
    console.log(`  (default socket path: ${Buffer.byteLength(real)} bytes)`);
    check("the default socket path fits sun_path", Buffer.byteLength(real) <= 103);
  }

  // An explicit undefined uid (Windows) keeps the tmpdir, with no directory made.
  {
    const t = fresh();
    check("no uid: the socket directory is the tmpdir itself", daemon.sockDir({ env: noXdg, tmpdir: t, uid: undefined }) === t && fs.readdirSync(t).length === 0);
  }

  // A refused location is final for serve / stop, but a lookup ("is a daemon running?") reads it as
  // "no daemon", so a squatted directory cannot lock this user out of every command. The warning goes
  // to stderr once per process.
  {
    const t = fresh();
    const dir = path.join(t, `designtwin-${uid}`);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o777);
    const place = { env: noXdg, tmpdir: t };
    const errs: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    let conn: unknown = "unset", st: unknown = "unset";
    try {
      conn = await daemon.connect(8790, place);
      st = await daemon.status(8790, place);
      await daemon.connect(8790, place);
    } finally { console.error = realError; }
    check("a refused socket directory: connect() is null (no daemon), not a throw", conn === null);
    check("…status() is null too", st === null);
    check("…and the refusal is warned once, on stderr, with the fix",
      errs.length === 1 && /refusing to use .*designtwin-\d+ .*XDG_RUNTIME_DIR or TMPDIR.*Going on without a daemon/.test(errs[0] ?? ""));
    const problem = daemon.sockProblem(8790, place);
    check("sockProblem() states the refusal and the fix", problem !== null && problem.includes(dir) && problem.includes(daemon.SOCK_FIX));
    const rejects = async (p: Promise<unknown>): Promise<boolean> => { try { await p; return false; } catch (e) { return e instanceof Error && /refusing to use/.test(e.message); } };
    check("…stop() still refuses", await rejects(daemon.stop(8790, place)));
    check("…assertNoDaemon() (serve) still refuses", await rejects(daemon.assertNoDaemon(8790, place)));
    check("…and the directory is left as it was", mode(dir) === 0o777);

    // A lookup never creates the directory: none there means no daemon, and nothing is made.
    const t2 = fresh();
    check("a lookup with no socket directory yet: no daemon", (await daemon.connect(8790, { env: noXdg, tmpdir: t2 })) === null);
    check("…and nothing was created", fs.readdirSync(t2).length === 0);
    check("…and sockProblem() sees no problem", daemon.sockProblem(8790, { env: noXdg, tmpdir: t2 }) === null);

    // doctor reports the refusal as a failed check quoting it, rather than as "no daemon".
    const c = checkDaemon(null, 8790, problem);
    check("doctor: a refused location is a FAIL on the daemon check, quoting the refusal",
      c.status === "fail" && c.detail === problem && /XDG_RUNTIME_DIR or TMPDIR/.test(c.next ?? ""));
    check("doctor: no refusal and no daemon is still the ordinary warn", checkDaemon(null, 8790, null).status === "warn");

    // End to end, with the process's TMPDIR pointing at the squatted base (XDG unset).
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: t, FIGMA_BRIDGE_PORT: "8789" };
    delete env.XDG_RUNTIME_DIR;
    const ds = dtwinSync(["--daemon-status"], { env });
    check("CLI --daemon-status under a refused directory: exit 0, reports no daemon",
      ds.status === 0 && /"daemon": false/.test(ds.stdout) && /no daemon is running/.test(ds.stderr));
    check("…with the refusal on stderr exactly once",
      (ds.stderr.match(/refusing to use/g) ?? []).length === 1 && !/refusing/.test(ds.stdout));
    const doc = dtwinSync(["doctor", "--json", "--wait", "0"], { env: { ...env, FIGMA_BRIDGE_TOKEN: "s".repeat(40) }, cwd: t2 });
    let daemonCheck: { status?: string; detail?: string } | undefined;
    try { daemonCheck = (JSON.parse(doc.stdout) as { checks: { id: string; status: string; detail: string }[] }).checks.find((x) => x.id === "daemon"); } catch { /* checked below */ }
    check("doctor --json under a refused directory: the daemon check fails with the refusal",
      daemonCheck?.status === "fail" && /refusing to use/.test(daemonCheck.detail ?? "") && doc.status === 1);
  }

  // A daemon an earlier build started listens at <tmpdir>/designtwin-<port>.sock. --stop finds it
  // there (a socket of ours only) when the current location has none.
  {
    const t = fresh();
    const place = { env: noXdg, tmpdir: t };
    const legacy = path.join(t, "designtwin-8790.sock");
    const seen: string[] = [];
    const old = net.createServer((c) => {
      c.setEncoding("utf8");
      c.on("data", daemon.framer((line) => {
        const m = JSON.parse(line) as { cmd: string };
        seen.push(m.cmd);
        c.write(JSON.stringify({ ok: true, result: m.cmd === "__ping" ? "pong" : true }) + "\n");
      }));
    });
    await new Promise<void>((r) => old.listen(legacy, () => r()));
    check("a socket of ours at the old location is found", daemon.legacySock(8790, place) === legacy);
    check("…but not one owned by another uid", daemon.legacySock(8790, { ...place, uid: uid + 1 }) === null);
    fs.chmodSync(t, 0o700);
    check("…and not when the old location is the current one (XDG_RUNTIME_DIR = the tmpdir)",
      daemon.legacySock(8790, { env: { XDG_RUNTIME_DIR: t }, tmpdir: t }) === null);
    check("stop() at the current location finds nothing", (await daemon.stop(8790, place)) === false);
    check("stopLegacy() sends __shutdown to the old daemon and names its socket",
      (await daemon.stopLegacy(8790, place)) === legacy && seen.includes("__shutdown"));
    // The CLI only takes the allowed ports; its old-location socket is designtwin-8789.sock.
    await new Promise<void>((r2) => old.close(() => r2()));
    await new Promise<void>((r2) => old.listen(path.join(t, "designtwin-8789.sock"), () => r2()));
    seen.length = 0;
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: t, FIGMA_BRIDGE_PORT: "8789" };
    delete env.XDG_RUNTIME_DIR;
    // spawn, not spawnSync: this process serves the old daemon's socket meanwhile.
    const r = await dtwin(["--stop"], { env }).then((x) => ({ code: x.status, err: x.stderr }));
    check("CLI --stop stops a daemon at the old location and says so",
      r.code === 0 && /stopped a daemon started by an earlier dtwin version \(socket .*designtwin-8789\.sock\)/.test(r.err) && seen.includes("__shutdown"));
    await new Promise<void>((r2) => old.close(() => r2()));
    fs.writeFileSync(legacy, "");
    check("a regular file at the old location is not a daemon", daemon.legacySock(8790, place) === null);
  }

  // Socket path length (daemon.ts "Length"). macOS holds a socket path to 103 bytes, and a path over it is
  // refused by sockPath with the fix named — not left to the running Bun (a recent one binds it through the
  // directory, an older one fails ENAMETOOLONG; Node silently bound a truncated path). Linux has no limit
  // to hold to: Bun binds and connects any length through /proc/self/fd.
  {
    const long = "/" + "d".repeat(90) + "/designtwin-8789.sock";
    check("length: on macOS a socket path over 103 bytes is refused, naming its length, the limit and the fix",
      /it is 112 bytes, and a Unix socket path on macOS is limited to 103\. Point XDG_RUNTIME_DIR or TMPDIR at a shorter directory/.test(daemon.sockLengthProblem(long, "darwin") ?? ""));
    check("length: 103 bytes is still fine on macOS", daemon.sockLengthProblem("/" + "d".repeat(81) + "/designtwin-8789.sock", "darwin") === null);
    check("length: Linux (and the rest) hold no limit", daemon.sockLengthProblem(long, "linux") === null);
    if (uid !== undefined) {
      const deep = path.join(fs.mkdtempSync(path.join(base, "len-")), "x".repeat(110));
      fs.mkdirSync(deep, { mode: 0o700 });
      const darwinPlace: daemon.SockPlace = { env: { XDG_RUNTIME_DIR: deep }, tmpdir: deep, platform: "darwin" };
      check("length: sockPath refuses an over-long macOS path, and sockProblem reports it for doctor",
        (() => { try { daemon.sockPath(8790, darwinPlace); return false; } catch (e) { return /a Unix socket path on macOS is limited to 103/.test(String(e)); } })()
        && /limited to 103/.test(daemon.sockProblem(8790, darwinPlace) ?? ""));
      // The limit itself, for real on this platform: a socket path of exactly 103 bytes (macOS's longest,
      // sun_path's 104 with its NUL) passes sockPath, is bound, and a daemon there is found — on macOS this
      // is the kernel's own edge, so MAX_SOCK_PATH_BYTES refuses nothing the platform would take. (A bind
      // that errors instead resolves with nothing bound, and the check fails rather than hanging.)
      {
        const max = daemon.MAX_SOCK_PATH_BYTES.darwin ?? 0;
        const parent = fs.mkdtempSync(path.join(base, "max-"));
        const room = max - Buffer.byteLength(path.join(parent, "x", "designtwin-8790.sock"));
        const edge = path.join(parent, "x" + "e".repeat(room));
        fs.mkdirSync(edge, { mode: 0o700 });
        const place: daemon.SockPlace = { env: { XDG_RUNTIME_DIR: edge }, tmpdir: edge };
        let sock = "";
        try { sock = daemon.sockPath(8790, place); } catch { /* checked below */ }
        let found = false;
        if (sock) {
          const fake = net.createServer((c) => {
            c.setEncoding("utf8");
            c.on("data", daemon.framer(() => { c.write(JSON.stringify({ ok: true, result: { daemon: true, pid: 1, port: 8790 } }) + "\n"); }));
          });
          const bound = await new Promise<boolean>((r) => { fake.once("error", () => r(false)); fake.listen(sock, () => r(true)); });
          found = bound && (await daemon.connect(8790, place)) !== null && fs.existsSync(sock);
          if (bound) await new Promise<void>((r) => fake.close(() => r()));
        }
        check(`length: a socket path of exactly ${max} bytes (the macOS limit) passes sockPath, is bound and a daemon there is found (got ${Buffer.byteLength(sock)} bytes)`,
          max === 103 && Buffer.byteLength(sock) === max && found);
      }
      if (process.platform === "linux") {
        // The real thing on Linux: a daemon socket at a path past sun_path's 108 bytes is bound and found.
        const place: daemon.SockPlace = { env: { XDG_RUNTIME_DIR: deep }, tmpdir: deep };
        const sock = daemon.sockPath(8790, place);
        const fake = net.createServer((c) => {
          c.setEncoding("utf8");
          c.on("data", daemon.framer(() => { c.write(JSON.stringify({ ok: true, result: { daemon: true, pid: 1, port: 8790 } }) + "\n"); }));
        });
        await new Promise<void>((r) => fake.listen(sock, () => r()));
        const conn = await daemon.connect(8790, place);
        check(`length: on Linux a ${Buffer.byteLength(sock)}-byte socket path (over sun_path's 108) is bound and a daemon there is found`,
          Buffer.byteLength(sock) > 108 && conn !== null && fs.existsSync(sock));
        await new Promise<void>((r) => fake.close(() => r()));
      }
    }
  }

  fs.rmSync(base, { recursive: true, force: true });
  report();
}
