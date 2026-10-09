// Where the daemon's socket lives (bridge/src/daemon.ts sockDir / sockPath). The socket answers
// without a token, so the directory holding it must be private to this user: created 0700, and an
// existing one refused when it is a symlink, someone else's, or open to group/other.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as daemon from "../bridge/src/daemon.ts";
import { checkDaemon } from "../bridge/src/doctor.ts";
import { check, report } from "./assert.ts";

const SRC = path.join(import.meta.dirname, "..", "bridge", "src");

const uid = process.getuid?.();
if (uid === undefined) {
  console.log("  (no POSIX uids on this platform: the socket stays in os.tmpdir())");
  check("without uids the socket directory is the tmpdir, unchanged", daemon.sockDir({ tmpdir: os.tmpdir() }) === os.tmpdir());
  report();
} else {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-sock-"));
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
    const ds = spawnSync(process.execPath, [path.join(SRC, "figma-pull.ts"), "--daemon-status"], { env, encoding: "utf8" });
    check("CLI --daemon-status under a refused directory: exit 0, reports no daemon",
      ds.status === 0 && /"daemon": false/.test(ds.stdout) && /no daemon is running/.test(ds.stderr));
    check("…with the refusal on stderr exactly once",
      (ds.stderr.match(/refusing to use/g) ?? []).length === 1 && !/refusing/.test(ds.stdout));
    const doc = spawnSync(process.execPath, [path.join(SRC, "figma-pull.ts"), "doctor", "--json", "--wait", "0"], { env: { ...env, FIGMA_BRIDGE_TOKEN: "s".repeat(40) }, encoding: "utf8", cwd: t2 });
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
    const r = await new Promise<{ code: number | null; err: string }>((res) => {
      const p = spawn(process.execPath, [path.join(SRC, "figma-pull.ts"), "--stop"], { env });
      let err = "";
      p.stderr.on("data", (d: Buffer) => (err += String(d)));
      p.on("exit", (code) => res({ code, err }));
    });
    check("CLI --stop stops a daemon at the old location and says so",
      r.code === 0 && /stopped a daemon started by an earlier dtwin version \(socket .*designtwin-8789\.sock\)/.test(r.err) && seen.includes("__shutdown"));
    await new Promise<void>((r2) => old.close(() => r2()));
    fs.writeFileSync(legacy, "");
    check("a regular file at the old location is not a daemon", daemon.legacySock(8790, place) === null);
  }

  fs.rmSync(base, { recursive: true, force: true });
  report();
}
