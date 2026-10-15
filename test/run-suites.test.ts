// The test runner's own self-test: it keeps going after a failure, ends with a summary, treats a
// suite that exits 0 without its checks line as failed, warns on SKIPPED locally and fails on it under CI=true, forwards
// every suite's output, runs one suite at a time, kills a hung suite, and refuses an unlisted test file. A
// SIGTERM/SIGHUP to the runner kills the running suite, a suite is done when it exits (a lingering grandchild cannot
// hold the run), a slow reader still gets the SUMMARY, `0/0` fails, the Windows lint command, verify-values' skip.
//   node test/run-suites.test.ts
// The suites it runs are tiny fake scripts in a temp dir (DT_RUN_SUITES_LIST); the real list is only ever asked for
// `--list` (and the coverage guard, against a temp directory of empty files), and for verify-values with no browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { check, report } from "./assert.ts";
import { killBrowsers } from "./drive-e2e-fixture.ts";
import { killPidTree, killTree, limit, poolSize, runNode, type KillHost } from "./pool.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { childPids, killChildTree, type ProcHost } from "../design-to-code/kill-tree.ts";

const RUNNER = path.join(import.meta.dirname, "run-suites.ts");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-suites-"));
const read = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// ---- fake suites
const fake = (name: string, body: string): string => { const f = path.join(tmp, name + ".mjs"); fs.writeFileSync(f, body); return f; };
const LOG = path.join(tmp, "order.log");
// every fake appends start/end around a short sleep, so an overlap of two suites would show in the log
const traced = (name: string, tail: string): string => `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(LOG)}, "start ${name}\\n");
await new Promise((r) => setTimeout(r, 120));
fs.appendFileSync(${JSON.stringify(LOG)}, "end ${name}\\n");
${tail}
`;
const passSrc = (name: string): string => traced(name, `console.log("  ✓ ${name}-check-a"); console.log("  ✓ ${name}-check-b"); console.log("\\n2/2 checks passed");`);
const suite = {
  pass: fake("pass", passSrc("pass")),
  failing: fake("failing", traced("failing", `console.log("  ✓ failing-check-a"); console.log("  ✗ FAIL failing-check-b"); console.log("\\n1/2 checks passed"); process.exit(1);`)),
  nosummary: fake("nosummary", traced("nosummary", `console.log("  ✓ nosummary-check-a"); process.exit(0);`)),
  partial: fake("partial", traced("partial", `console.log("  ✓ partial-check-a"); console.log("\\n1/2 checks passed"); process.exit(0);`)),
  skipped: fake("skipped", traced("skipped", `console.log("SKIPPED (no playwright: fake)"); process.exit(0);`)),
  after: fake("after", traced("after", `console.log("AFTER-SUITE-RAN"); console.log("\\n1/1 checks passed");`)),
  hang: fake("hang", `console.log("HANG-STARTED"); setInterval(() => {}, 1000);`),
  // Fakes: a hung suite that leaves its pid; one whose grandchild inherits its stdout and outlives it; one that
  // prints far more than a pipe holds; one that asserts nothing
  hangpid: fake("hangpid", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(tmp, "hang.pid"))}, String(process.pid)); setInterval(() => {}, 1000);`),
  lingers: fake("lingers", `import fs from "node:fs"; import { spawn } from "node:child_process";
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25000)"], { stdio: ["ignore", "inherit", "inherit"] });
fs.writeFileSync(${JSON.stringify(path.join(tmp, "linger.pid"))}, String(g.pid)); g.unref();
console.log("\\n1/1 checks passed");`),
  big: fake("big", `const row = "x".repeat(99) + "\\n"; process.stdout.write(row.repeat(4000)); console.log("\\n1/1 checks passed");`),
  zero: fake("zero", `console.log("\\n0/0 checks passed");`),
};
const list = (names: (keyof typeof suite)[]): string => {
  const f = path.join(tmp, `list-${names.join("-")}.json`);
  fs.writeFileSync(f, JSON.stringify(names.map((n) => ({ name: n, file: suite[n] }))));
  return f;
};
interface Run { status: number | null; out: string; err: string }
const runner = (args: string[], env: Record<string, string>, removeCI = true): Run => {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  if (removeCI && !("CI" in env)) delete e.CI;
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", timeout: 60_000, env: e });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const lines = (s: string): string[] => s.split("\n");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (f: string): number => Number(read(f)) || 0;
const until = async (cond: () => boolean, capMs: number): Promise<boolean> => { const end = Date.now() + capMs; while (!cond() && Date.now() < end) await sleep(25); return cond(); };
const summaryOf = (s: string): string => s.slice(s.lastIndexOf("SUMMARY"));

try {
  // ---- a failing / no-summary / partial suite does not stop the rest
  console.log("\nrun-suites — keeps going, summary, exit code:");
  fs.rmSync(LOG, { force: true });
  const mixed = runner([], { DT_RUN_SUITES_LIST: list(["pass", "failing", "nosummary", "partial", "skipped", "after"]) });
  const sum = summaryOf(mixed.out);
  check("the suite after a failing one still runs (its output is in the log)", /AFTER-SUITE-RAN/.test(mixed.out) && /=== after /.test(mixed.out));
  check("…and so does every suite after the no-summary and the partial one (all six started)", ["pass", "failing", "nosummary", "partial", "skipped", "after"].every((n) => new RegExp(`^start ${n}$`, "m").test(read(LOG))));
  check("exit 1 when any suite failed", mixed.status === 1);
  check("a SUMMARY block closes the run, one row per suite, with p/t and a time", /SUMMARY/.test(sum) && ["pass", "failing", "nosummary", "partial", "skipped", "after"].every((n) => lines(sum).some((l) => l.startsWith(n + " ")))
    && lines(sum).some((l) => /^pass\s+pass\s+2\/2\s+\d+\.\ds/.test(l)) && lines(sum).some((l) => /^failing\s+FAIL\s+1\/2\s+\d+\.\ds/.test(l)));
  check("the counts line: 6 suites: 2 passed, 3 FAILED, 1 skipped", /6 suites: 2 passed, 3 FAILED, 1 skipped — total \d/.test(sum));
  const failedLine = lines(sum).find((l) => l.startsWith("FAILED:")) ?? "";
  check("FAILED names the failing suite, the one that exited 0 without its checks line, and the p<t one — not the pass/after/skipped",
    /\bfailing\b/.test(failedLine) && /\bnosummary\b/.test(failedLine) && /\bpartial\b/.test(failedLine) && !/\b(pass|after|skipped)\b/.test(failedLine));
  check("a suite that exits 0 without its `N/N checks passed` line says why", /nosummary\s+FAIL\s+-\s+.*ended without its `N\/N checks passed` line/.test(sum));
  check("a suite that exits 0 with p < t is failed (1/2 checks passed)", /partial\s+FAIL\s+1\/2\s+.*1\/2 checks passed/.test(sum));
  check("the failed suites carry a rerun hint", /rerun: node /.test(sum));
  check("the SKIPPED suite is listed as skipped with the CI warning", /^SKIPPED \(no playwright\): skipped$/m.test(sum) && /CI runs these/.test(sum) && /^skipped\s+skipped\s/m.test(sum));
  check("each suite's own output (its check lines and `N/N checks passed`) is forwarded live, before the summary",
    /✓ pass-check-a/.test(mixed.out.slice(0, mixed.out.lastIndexOf("SUMMARY"))) && /✗ FAIL failing-check-b/.test(mixed.out) && (mixed.out.match(/^2\/2 checks passed$/gm) ?? []).length >= 1);
  const log = lines(read(LOG)).filter(Boolean);
  check("strictly serial: every `start X` is followed by its own `end X` before the next start", log.length === 12 && log.every((l, i) => (i % 2 === 0 ? l.startsWith("start ") : l === "end " + (log[i - 1] ?? "").slice(6))));

  // ---- SKIPPED: warning locally, failure under CI=true
  console.log("\nrun-suites — SKIPPED:");
  const okList = list(["pass", "skipped"]);
  const local = runner([], { DT_RUN_SUITES_LIST: okList });
  check("only pass + skipped, no CI: exit 0 and the warning", local.status === 0 && /warning: CI runs these/.test(local.out) && /2 suites: 1 passed, 0 FAILED, 1 skipped/.test(local.out));
  const ci = runner([], { DT_RUN_SUITES_LIST: okList, CI: "true" });
  check("the same under CI=true: exit 1, the skipped suite is FAILED with the reason", ci.status === 1 && /^FAILED: skipped$/m.test(ci.out) && /SKIPPED under CI \(/.test(ci.out));
  const ci1 = runner([], { DT_RUN_SUITES_LIST: okList, CI: "1" });
  check("CI=1 (other runners) counts as CI too: exit 1", ci1.status === 1 && /^FAILED: skipped$/m.test(ci1.out));
  check("CI unset or other than \"true\" does not fail it (CI=false: exit 0)", runner([], { DT_RUN_SUITES_LIST: okList, CI: "false" }).status === 0);
  const allPass = runner([], { DT_RUN_SUITES_LIST: list(["pass", "after"]) });
  check("all suites pass: exit 0, `2 suites: 2 passed, 0 FAILED, 0 skipped`, no FAILED/SKIPPED line", allPass.status === 0 && /2 suites: 2 passed, 0 FAILED, 0 skipped/.test(allPass.out) && !/^FAILED:/m.test(allPass.out) && !/^SKIPPED/m.test(allPass.out));

  // ---- the cap
  console.log("\nrun-suites — per-suite cap:");
  const t0 = Date.now();
  const hung = runner([], { DT_RUN_SUITES_LIST: list(["hang", "after"]), DT_SUITE_TIMEOUT_MS: "500", DT_KILL_GRACE_MS: "300" });
  check("a hung suite is killed at the cap, reported `timed out`, and the next suite still runs", hung.status === 1 && /hang\s+FAIL\s+.*timed out after/.test(hung.out) && /AFTER-SUITE-RAN/.test(hung.out) && Date.now() - t0 < 30_000);

  // ---- a signal to the runner reaches the running suite (its own process group), and the summary still prints
  console.log("\nrun-suites — SIGTERM / SIGHUP:");
  // Not on Windows: there child.kill(sig) is an unconditional terminate (Node: "Sending SIGINT, SIGTERM, and SIGKILL will
  // cause the unconditional termination of the target process"), so the runner's handler never runs; SIGHUP is only
  // generated when the console window closes.
  for (const sig of process.platform === "win32" ? [] : (["SIGTERM", "SIGHUP"] as const)) {
    const pidFile = path.join(tmp, "hang.pid");
    fs.rmSync(pidFile, { force: true });
    const e: Record<string, string | undefined> = { ...process.env, DT_RUN_SUITES_LIST: list(["hangpid", "after"]), DT_KILL_GRACE_MS: "500" };
    delete e.CI;
    const child = spawn(process.execPath, [RUNNER], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
    await until(() => pidIn(pidFile) > 0, 10_000);
    const suitePid = pidIn(pidFile);
    child.kill(sig);
    const code = await Promise.race([exited, sleep(15_000).then(() => -1)]);
    const gone = await until(() => suitePid > 0 && !alive(suitePid), 3_000);
    if (suitePid > 0 && alive(suitePid)) try { process.kill(suitePid, "SIGKILL"); } catch { /* gone */ }
    if (code === -1) child.kill("SIGKILL");
    check(`${sig} to the runner kills the running suite (no orphan), skips the rest, prints the summary, exits 130`,
      suitePid > 0 && gone && code === 130 && /SUMMARY/.test(out) && /hangpid\s+FAIL\s.*interrupted/.test(out) && /after\s+not run/.test(out));
  }
  if (process.platform === "win32") console.log("  (skipped on win32: child.kill(SIGTERM|SIGHUP) terminates the runner outright there, its handler cannot run; SIGHUP only comes from a closed console)");

  // ---- the verdict is the suite's exit, not its pipes closing (a lingering grandchild holds them)
  console.log("\nrun-suites — exit vs close, piped stdout, 0/0:");
  {
    const t1 = Date.now();
    const lingering = runner([], { DT_RUN_SUITES_LIST: list(["lingers"]) });
    const ms = Date.now() - t1;
    const gp = pidIn(path.join(tmp, "linger.pid"));
    if (gp > 0 && alive(gp)) try { process.kill(gp, "SIGKILL"); } catch { /* gone */ }
    check(`a suite whose grandchild keeps its stdout open is done when it EXITS (+ the drain cap), not 25 s later (${ms} ms)`,
      lingering.status === 0 && /lingers\s+pass\s+1\/1/.test(lingering.out) && ms < 10_000);
  }
  {
    // a slow reader on the runner's stdout: exit() must not drop everything still queued in the pipe (the SUMMARY)
    const e: Record<string, string | undefined> = { ...process.env, DT_RUN_SUITES_LIST: list(["big"]) };
    delete e.CI;
    const r = spawnSync("sh", ["-c", `"${process.execPath}" "${RUNNER}" | (sleep 2; cat)`], { encoding: "utf8", timeout: 60_000, env: e });
    check("with a slow reader on a piped stdout the runner's output is complete: the suite's 400 KB, then the SUMMARY",
      (r.stdout.match(/^x{99}$/gm) ?? []).length === 4000 && /SUMMARY/.test(r.stdout) && /1 suites: 1 passed, 0 FAILED/.test(r.stdout));
  }
  {
    const zero = runner([], { DT_RUN_SUITES_LIST: list(["zero", "after"]) });
    check("a suite that prints `0/0 checks passed` asserted nothing: FAIL", zero.status === 1 && /zero\s+FAIL\s.*0\/0 checks/.test(zero.out) && /^FAILED: zero$/m.test(zero.out));
  }

  // ---- the lint command on Windows goes through cmd.exe (spawning npm.cmd without a shell throws EINVAL)
  console.log("\nrun-suites — the lint command per platform:");
  {
    const empty = path.join(tmp, "list-empty.json");
    fs.writeFileSync(empty, "[]");
    const probe = `import { command } from ${JSON.stringify(pathToFileURL(RUNNER).href)};
const lint = { name: "lint:any", kind: "lint", file: "lint:any" };
console.log("CMD " + JSON.stringify({
  win: command(lint, "win32", { ComSpec: "C:\\\\Windows\\\\cmd.exe" }),
  winJs: command(lint, "win32", { npm_execpath: "C:\\\\npm\\\\bin\\\\npm-cli.js" }),
  winNode: command({ name: "x", kind: "node", file: "x.test.ts" }, "win32", {}),
  posix: command(lint, "linux", {}),
}));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 30_000, env: { ...process.env, DT_RUN_SUITES_LIST: empty } });
    const line = lines(r.stdout).find((l) => l.startsWith("CMD ")) ?? "";
    interface Cmd { cmd: string; args: string[]; detached: boolean; windowsVerbatimArguments?: boolean }
    let c: { win?: Cmd; winJs?: Cmd; winNode?: Cmd; posix?: Cmd } = {};
    try { c = JSON.parse(line.slice(4) || "{}") as typeof c; } catch { /* ✗ below */ }
    check("win32 without npm_execpath: cmd.exe /d /s /c \"npm run -s lint:any\" (verbatim), not detached",
      c.win?.cmd === "C:\\Windows\\cmd.exe" && c.win.args.join(" ") === `/d /s /c "npm run -s lint:any"` && c.win.windowsVerbatimArguments === true && c.win.detached === false);
    check("win32 with an npm-cli.js execpath: node runs it directly; a node suite is not detached on win32; posix: npm, detached",
      c.winJs?.cmd === process.execPath && c.winJs.args[0] === "C:\\npm\\bin\\npm-cli.js" && c.winNode?.detached === false
      && c.posix?.cmd === "npm" && c.posix.args.join(" ") === "run -s lint:any" && c.posix.detached === true);
  }

  // ---- verify-values' own local chromium skip is reported `skipped`, not a plain pass
  {
    const vv = runner(["verify-values"], { PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, "no-browsers") });
    check("verify-values with no browser, locally: the runner lists it as skipped (the SKIPPED marker), exit 0",
      vv.status === 0 && /^verify-values\s+skipped\s/m.test(vv.out) && /^SKIPPED \(no playwright\): verify-values$/m.test(vv.out));
  }

  // ---- filters + --list
  console.log("\nrun-suites — filters and --list:");
  fs.rmSync(LOG, { force: true });
  const filtered = runner(["after", "pass"], { DT_RUN_SUITES_LIST: list(["pass", "failing", "after"]) });
  check("positional names run only those suites, in list order (pass then after; failing not started)", filtered.status === 0 && /^start pass$/m.test(read(LOG)) && /^start after$/m.test(read(LOG)) && !/start failing/.test(read(LOG)) && /2 suites: 2 passed/.test(filtered.out));
  const unknown = runner(["no-such-suite"], { DT_RUN_SUITES_LIST: list(["pass"]) });
  check("an unknown name is a usage error (exit 2, names it)", unknown.status === 2 && /no suite matches "no-such-suite"/.test(unknown.err));

  // ---- the compile cache the runner hands its suites (a user's own setting wins; NODE_DISABLE_COMPILE_CACHE is Node's to honour)
  console.log("\nrun-suites — NODE_COMPILE_CACHE for the suites:");
  {
    const probeList = path.join(tmp, "list-envprobe.json");
    fs.writeFileSync(probeList, JSON.stringify([{ name: "envprobe", file: fake("envprobe", `console.log("CC=" + (process.env.NODE_COMPILE_CACHE ?? "<unset>") + " DIS=" + (process.env.NODE_DISABLE_COMPILE_CACHE ?? "<unset>")); console.log("\\n1/1 checks passed");`) }]));
    const probe = (set: Record<string, string>): string => {
      const e: Record<string, string | undefined> = { ...process.env, DT_RUN_SUITES_LIST: probeList, ...set };
      delete e.CI;
      for (const k of ["NODE_COMPILE_CACHE", "NODE_DISABLE_COMPILE_CACHE"]) if (!(k in set)) delete e[k];
      return spawnSync(process.execPath, [RUNNER], { encoding: "utf8", timeout: 60_000, env: e }).stdout;
    };
    check("[cache] by default a suite gets NODE_COMPILE_CACHE=<this checkout>/node_modules/.cache/designtwin-node-compile-cache (per checkout and per user, not a shared /tmp path)", probe({}).includes(`CC=${path.join(path.dirname(import.meta.dirname), "node_modules", ".cache", "designtwin-node-compile-cache")} `));
    check("[cache] a NODE_COMPILE_CACHE the user set wins", probe({ NODE_COMPILE_CACHE: path.join(tmp, "mine") }).includes(`CC=${path.join(tmp, "mine")} `));
    check("[cache] NODE_DISABLE_COMPILE_CACHE reaches the suite untouched (Node honours it)", /DIS=1$/m.test(probe({ NODE_DISABLE_COMPILE_CACHE: "1" })));
  }

  // ---- the real list + the coverage guard
  console.log("\nrun-suites — coverage guard:");
  const testDir = import.meta.dirname;
  const onDisk = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts") || f === "harness.ts");
  const real = runner(["--list"], {});
  const realLines = lines(real.out);
  check("the real `--list` exits 0 and names every test/*.test.ts and harness.ts on disk", real.status === 0 && onDisk.length > 30 && onDisk.every((f) => real.out.includes("test/" + f)));
  check("…the two lints come first (lint:any, lint:types), then the real-name guard, then harness, then bridge — the old chain's order", /^lint:any/.test(realLines[0] ?? "") && /^lint:types/.test(realLines[1] ?? "") && /^real-names /.test(realLines[2] ?? "") && /^harness /.test(realLines[3] ?? "") && /^bridge /.test(realLines[4] ?? ""));
  check("…the browser suites keep their place (verify-probe-e2e after verify-probe, verify-own-pixels after verify-probe-drive-e2e)",
    real.out.indexOf("verify-probe-e2e ") > real.out.indexOf("verify-probe ") && real.out.indexOf("verify-own-pixels") > real.out.indexOf("verify-probe-drive-e2e"));
  const pkg = JSON.parse(read(path.join(testDir, "..", "package.json")) || "{}") as { scripts?: Record<string, string> };
  check("`npm test` is the runner (package.json scripts.test === \"node test/run-suites.ts\"); the lints stay scripts", pkg.scripts?.test === "node test/run-suites.ts" && typeof pkg.scripts.typecheck === "string" && typeof pkg.scripts["lint:any"] === "string" && typeof pkg.scripts["lint:types"] === "string");

  // ---- --fast: skips exactly the four probe e2e suites, `not run` in the summary, exit unaffected, never looks like a full pass
  console.log("\nrun-suites — --fast:");
  const SLOW = ["verify-probe-e2e", "verify-probe-drive-e2e", "verify-probe-drive-tail-e2e", "verify-probe-behaviour-e2e"];
  // fakes named like the real slow suites (the skip applies by name); they would log `start <name>` if they ever ran
  const named = (entries: { name: string; src: string }[], tag: string): string => {
    const f = path.join(tmp, `list-fast-${tag}.json`);
    fs.writeFileSync(f, JSON.stringify(entries.map((e) => ({ name: e.name, file: fake(e.name, e.src) }))));
    return f;
  };
  const okSrc = (n: string): string => passSrc(n);
  const fastList = named([{ name: "quick", src: okSrc("quick") }, ...SLOW.map((n) => ({ name: n, src: okSrc(n) })), { name: "quick2", src: okSrc("quick2") }], "ok");
  fs.rmSync(LOG, { force: true });
  const fastRun = runner(["--fast"], { DT_RUN_SUITES_LIST: fastList });
  const fastSum = summaryOf(fastRun.out);
  check("[fast] --fast skips the four slow suites (never started), runs the others, and exits 0 although they are `not run`",
    fastRun.status === 0 && /^start quick$/m.test(read(LOG)) && /^start quick2$/m.test(read(LOG)) && SLOW.every((n) => !new RegExp(`start ${n}`).test(read(LOG))) && /2 passed, 0 FAILED, 0 skipped, 4 not run/.test(fastSum));
  check("[fast] the SUMMARY lists each skipped suite as `not run` with the reason `--fast`", SLOW.every((n) => lines(fastSum).some((l) => l.startsWith(n + " ") && /\bnot run\b/.test(l) && /--fast\s*$/.test(l))));
  check("[fast] the run ends with the loud line (4 of the probe e2e suites, names them, not the full suite, run `npm test`, CI's other matrix legs run them)",
    /^--fast: skipped 4 of the probe e2e suites \(verify-probe-e2e, verify-probe-drive-e2e, verify-probe-drive-tail-e2e, verify-probe-behaviour-e2e\) .*NOT the full suite.*`npm test`.*CI's other matrix legs run them$/m.test(fastRun.out) && !/CI runs everything/.test(fastRun.out) && (lines(fastRun.out.trimEnd()).pop() ?? "").startsWith("--fast:"));
  check("[fast] without --fast the same list runs all six suites", (() => { const r = runner([], { DT_RUN_SUITES_LIST: fastList }); return r.status === 0 && /6 suites: 6 passed/.test(r.out) && !/--fast/.test(r.out); })());
  check("[fast] under CI=true --fast is allowed and still prints the warning", (() => { const r = runner(["--fast"], { DT_RUN_SUITES_LIST: fastList, CI: "true" }); return r.status === 0 && /^--fast: skipped/m.test(r.out); })());
  const fastFail = runner(["--fast"], { DT_RUN_SUITES_LIST: named([{ name: "bad", src: traced("bad", `console.log("\\n0/1 checks passed"); process.exit(1);`) }, ...SLOW.map((n) => ({ name: n, src: okSrc(n) }))], "fail") });
  check("[fast] a failing suite still exits 1 under --fast", fastFail.status === 1 && /^FAILED: bad$/m.test(fastFail.out));
  const fastList2 = runner(["--fast", "--list"], { DT_RUN_SUITES_LIST: fastList });
  check("[fast] --fast --list prints only what would run (quick, quick2), exit 0", fastList2.status === 0 && lines(fastList2.out).filter(Boolean).map((l) => l.split(/\s+/)[0]).join(",") === "quick,quick2");
  fs.rmSync(LOG, { force: true });
  const fastFilt = runner(["--fast", "quick", "quick2", "verify-probe-drive-e2e"], { DT_RUN_SUITES_LIST: fastList });
  check("[fast] --fast with names: the names pick first, then the slow ones are dropped (quick, quick2 run; the drive e2e is `not run`)",
    fastFilt.status === 0 && /^start quick$/m.test(read(LOG)) && /^start quick2$/m.test(read(LOG)) && !/start verify-probe-drive-e2e/.test(read(LOG)) && /^verify-probe-drive-e2e\s+not run\s.*--fast/m.test(fastFilt.out) && !/verify-probe-e2e\s+not run/.test(fastFilt.out));
  const onlySlow = runner(["--fast", "verify-probe-drive-e2e"], { DT_RUN_SUITES_LIST: fastList });
  check("[fast] --fast with only a slow suite named: nothing runs, so exit 2 (not a green 0) with the reason on stderr", onlySlow.status === 2 && /^run-suites: nothing to run — every picked suite is a --fast skip$/m.test(onlySlow.err) && !/^=== /m.test(onlySlow.out));
  const staleList = runner(["--fast"], { DT_RUN_SUITES_LIST: named([{ name: "quick", src: okSrc("quick") }, { name: "verify-probe-e2e", src: okSrc("a") }, { name: "verify-probe-drive-e2e", src: okSrc("b") }], "stale") });
  check("[fast] a FAST_SKIP name that is not in the suite list exits 1 and names it (a rename cannot silently drop a suite)",
    staleList.status === 1 && /verify-probe-behaviour-e2e/.test(staleList.err) && !/^=== /m.test(staleList.out));
  check("[fast] without --fast a custom list is not subject to that guard", runner([], { DT_RUN_SUITES_LIST: list(["pass"]) }).status === 0);
  check("[fast] an unknown option is still a usage error, and the usage line names --fast", (() => { const r = runner(["--bogus"], { DT_RUN_SUITES_LIST: list(["pass"]) }); return r.status === 2 && /--fast/.test(r.err); })());
  const realFast = runner(["--fast", "--list"], {});
  check("[fast] the real `--fast --list` omits exactly verify-probe-e2e, verify-probe-drive-e2e, verify-probe-drive-tail-e2e, verify-probe-behaviour-e2e (nothing else) and keeps the rest",
    realFast.status === 0 && (() => {
      const all = new Set(lines(real.out).filter(Boolean).map((l) => l.split(/\s+/)[0]));
      const got = new Set(lines(realFast.out).filter(Boolean).map((l) => l.split(/\s+/)[0]));
      const missing = [...all].filter((n) => !got.has(n));
      return missing.sort().join(",") === [...SLOW].sort().join(",") && [...got].every((n) => all.has(n)) && got.size === all.size - SLOW.length;
    })());


  check("[fast] `npm run test:fast` is the runner with --fast (package.json scripts[\"test:fast\"] === \"node test/run-suites.ts --fast\")", pkg.scripts?.["test:fast"] === "node test/run-suites.ts --fast");

  // CI splits the run over a matrix (.github/workflows/test.yml): each `include:` entry is a leg (from its `- leg:` line); a leg
  // without `node:` or `os:` is on the primary Node and OS. There, one leg is `--fast` and the others name suites — between them every
  // suite runs exactly once (the named ones are exactly what --fast leaves out, none twice). A leg on another Node version or OS
  // runs `--fast` alone, and every leg blocks: none is `allow-failure`, and the job has no continue-on-error, so any leg's failure
  // fails `test result`.
  const wf = read(path.join(testDir, "..", ".github", "workflows", "test.yml"));
  const inc = /^( *)include:\n((?:(?:\1 +.*|[ \t]*)\n)*)/m.exec(wf)?.[2] ?? "";
  const legs = inc.split(/^\s*- (?=leg:)/m).slice(1).map((l) => ({
    node: /^\s*node: (.+)$/m.exec(l)?.[1]?.trim(),
    os: /^\s*os: (.+)$/m.exec(l)?.[1]?.trim(),
    allowFailure: /^\s*allow-failure: true\s*$/m.test(l),
    suites: (/^\s*suites: (.+)$/m.exec(l)?.[1] ?? "").trim().split(/\s+/).filter(Boolean),
  }));
  const primary = legs.filter((l) => l.node === undefined && l.os === undefined);
  const primaryFast = primary.filter((l) => l.suites.includes("--fast"));
  const legNamed = primary.filter((l) => !l.suites.includes("--fast")).flatMap((l) => l.suites);
  check("[ci] the workflow's Test step runs the runner with the leg's suites (`node test/run-suites.ts ${{ matrix.suites }}`)", /^\s+run: node test\/run-suites\.ts \$\{\{ matrix\.suites \}\}$/m.test(wf));
  check("[ci] every `suites:` line in the workflow is one matrix leg's (each `- leg:` under `include:` has its own)",
    legs.length > 0 && legs.every((l) => l.suites.length > 0) && legs.length === [...wf.matchAll(/^\s+suites: /gm)].length);
  check("[ci] on the primary Node exactly one matrix leg is `--fast` and it names no suites", primaryFast.length === 1 && primaryFast[0]?.suites.join(" ") === "--fast");
  check("[ci] the other primary-Node legs name exactly the suites --fast leaves out, each once (no suite dropped from CI, none run twice)",
    legNamed.length === SLOW.length && new Set(legNamed).size === legNamed.length && [...legNamed].sort().join(",") === [...SLOW].sort().join(","));
  check("[ci] every leg on another Node version (`node:`) is `--fast` alone (an extra Node version runs the quick suites only)",
    legs.filter((l) => l.node !== undefined).every((l) => l.suites.join(" ") === "--fast"));
  check("[ci] every leg on another OS (`os:`) is `--fast` alone, and the job runs each leg on its `os:` (else the pinned Ubuntu image)",
    legs.some((l) => l.os !== undefined) && legs.filter((l) => l.os !== undefined).every((l) => l.suites.join(" ") === "--fast")
    && /^ {4}runs-on: \$\{\{ matrix\.os \|\| 'ubuntu-24\.04' \}\}$/m.test(wf));
  check("[ci] every leg blocks: none is `allow-failure` and the workflow has no continue-on-error (a failed continue-on-error job is a success to `needs`)",
    legs.every((l) => !l.allowFailure) && !/continue-on-error/.test(wf));

  const mirror = path.join(tmp, "mirror");
  fs.mkdirSync(mirror);
  for (const f of onDisk) fs.writeFileSync(path.join(mirror, f), "");
  const guardEnv = { DT_RUN_SUITES_DIR: mirror };
  check("control: a directory holding exactly the listed files passes the guard", runner(["--list"], guardEnv).status === 0);
  fs.writeFileSync(path.join(mirror, "zz-forgotten.test.ts"), "");
  const stray = runner(["--list"], guardEnv);
  check("a test/*.test.ts that is not in SUITES fails the runner (exit 1) and is named", stray.status === 1 && /zz-forgotten\.test\.ts exists but is not in SUITES/.test(stray.err));
  fs.rmSync(path.join(mirror, "zz-forgotten.test.ts"));
  fs.rmSync(path.join(mirror, "mcp-smoke.test.ts"));
  const missing = runner(["--list"], guardEnv);
  check("a SUITES file that does not exist fails the runner (exit 1) and is named", missing.status === 1 && /lists mcp-smoke\.test\.ts but .* does not exist/.test(missing.err));
  const guardNoRun = runner(["zz-nothing"], guardEnv);
  check("the guard also stops a real run (not only --list): exit 1 before any suite starts", guardNoRun.status === 1 && !/^=== /m.test(guardNoRun.out));

  // ---- test/pool.ts: limit(), poolSize() and runNode() (each async check is raced against 2 s so a regression fails instead of hanging)
  console.log("\nrun-suites — test/pool.ts:");
  const within = async <T, F>(p: Promise<T>, fallback: F): Promise<T | F> => { let t: NodeJS.Timeout | undefined; try { return await Promise.race([p, new Promise<F>((r) => { t = setTimeout(() => r(fallback), 2000); })]); } finally { clearTimeout(t); } };
  const TIMED_OUT = Symbol("timed out");
  {
    const q = limit(1);
    const thrown = q((): Promise<string> => { throw new Error("sync boom"); });
    const next = q(async () => "second ran");
    const t = await within(thrown.then(() => "resolved", (e: unknown) => (e instanceof Error ? e.message : "rejected")), "timed out");
    const n = await within(next, "timed out");
    check("[pool] a task that throws synchronously rejects its own promise (not an uncaught throw out of limit())", t === "sync boom");
    check("[pool] …and releases its slot: the next queued task still runs", n === "second ran");
  }
  {
    const N = 3;
    const q = limit(N);
    let live = 0, peak = 0;
    const work = (): Promise<number> => q(async () => { live++; peak = Math.max(peak, live); await sleep(15); live--; return 1; });
    const all = await within(Promise.all(Array.from({ length: 10 }, work)), TIMED_OUT);
    check(`[pool] limit(${N}): ten tasks all finish and never more than ${N} run at once (peak ${peak})`, all !== TIMED_OUT && all.length === 10 && peak >= 2 && peak <= N);
    const order: number[] = [];
    const q1 = limit(1);
    const o = await within(Promise.all([1, 2, 3, 4].map((i) => q1(async () => { order.push(i); }))), TIMED_OUT);
    check("[pool] tasks start in the order they were queued", o !== TIMED_OUT && order.join(",") === "1,2,3,4");
  }
  {
    const warned: string[] = [];
    const ps = (env: NodeJS.ProcessEnv, cores = 8): number => poolSize(env, cores, (m) => { warned.push(m); });
    check("[pool] poolSize: DT_E2E_POOL in 1-8 is used as given, no warning", ps({ DT_E2E_POOL: "1" }) === 1 && ps({ DT_E2E_POOL: "6", CI: "true" }) === 6 && ps({ DT_E2E_POOL: "8" }) === 8 && warned.length === 0);
    check("[pool] poolSize: DT_E2E_POOL above 8 is clamped to 8 with a warning", (() => { const w = warned.length; return ps({ DT_E2E_POOL: "64" }) === 8 && warned.length === w + 1 && /DT_E2E_POOL=64/.test(warned[w] ?? ""); })());
    check("[pool] poolSize: DT_E2E_POOL of 0 or below is clamped to 1 with a warning", (() => { const w = warned.length; return ps({ DT_E2E_POOL: "0" }) === 1 && ps({ DT_E2E_POOL: "-3" }) === 1 && warned.length === w + 2; })());
    check("[pool] poolSize: a non-integer DT_E2E_POOL warns and falls back to the default (cores/2 clamped 2-4; 2 under CI)", (() => {
      const w = warned.length;
      const got = [ps({ DT_E2E_POOL: "abc" }), ps({ DT_E2E_POOL: "2.5" }), ps({ DT_E2E_POOL: "abc", CI: "true" })];
      return got.join(",") === "4,4,2" && warned.length === w + 3 && /"abc"/.test(warned[w] ?? "");
    })());
    check("[pool] poolSize: an empty DT_E2E_POOL is unset (no warning)", (() => { const w = warned.length; return ps({ DT_E2E_POOL: "" }) === 4 && warned.length === w; })());
    check("[pool] poolSize: CI counts as set for any value but \"\", \"0\" and \"false\" (CI=1 and CI=yes give 2)", ps({ CI: "true" }) === 2 && ps({ CI: "1" }) === 2 && ps({ CI: "yes" }) === 2 && ps({ CI: "" }) === 4 && ps({ CI: "0" }) === 4 && ps({ CI: "false" }) === 4);
    check("[pool] poolSize: without CI it is half the cores clamped to 2-4", ps({}, 2) === 2 && ps({}, 6) === 3 && ps({}, 64) === 4 && ps({}, 1) === 2);
  }
  // runNode: the shared async spawn of the e2e suites (a tiny `node -e`, no port)
  {
    const r = await within(runNode(tmp, "-e", ["console.log('out'); console.error('err'); process.exit(3)"]), TIMED_OUT);
    check("[pool] runNode: resolves the exit status and both captured streams, not killed, with a spawn → close time", r !== TIMED_OUT && r.status === 3 && r.stdout === "out\n" && r.stderr === "err\n" && !r.killed && r.ms >= 0);
    const cwd = await within(runNode(tmp, "-e", ["process.stdout.write(process.cwd())"]), TIMED_OUT);
    check("[pool] runNode: runs in the given cwd", cwd !== TIMED_OUT && fs.realpathSync(cwd.stdout) === fs.realpathSync(tmp));
    const missing = await within(runNode(path.join(tmp, "no-such-dir"), "-e", ["0"]), TIMED_OUT);
    check("[pool] runNode: a spawn that fails asynchronously (missing cwd) resolves status null with `spawn failed:` in stderr — never rejects or hangs", missing !== TIMED_OUT && missing.status === null && /spawn failed: /.test(missing.stderr) && !missing.killed);
    const sync = await within(runNode(tmp, "-e", ["bad\0arg"]), TIMED_OUT);
    check("[pool] runNode: a spawn that throws synchronously (NUL in an argument) resolves status null with `spawn failed:` in stderr", sync !== TIMED_OUT && sync.status === null && /^spawn failed: /.test(sync.stderr) && sync.stdout === "");
    const hung = await within(runNode(tmp, "-e", ["setTimeout(() => {}, 30000)"], 200), TIMED_OUT);
    check("[pool] runNode: killAfterMs kills a run that has not exited and reports killed (status null) with its whole tree (treeKilled)", hung !== TIMED_OUT && hung.killed && hung.treeKilled && hung.status === null && hung.ms < 10_000);
    // a descendant of the killed run goes with it: the child starts a grandchild and prints its pid, then both hang
    const tree = await within(runNode(tmp, "-e", ["const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); console.log(g.pid); setTimeout(() => {}, 30000)"], 1500), TIMED_OUT);
    const gpid = tree === TIMED_OUT ? 0 : Number(tree.stdout.trim());
    const alive = async (): Promise<boolean> => {
      for (let i = 0; i < 50; i++) {
        try { process.kill(gpid, 0); } catch (e) { return e instanceof Error && "code" in e && e.code === "EPERM"; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return true;
    };
    check("[pool] runNode: killAfterMs also ends the processes the run started (its grandchild is gone)", tree !== TIMED_OUT && tree.killed && tree.treeKilled && gpid > 0 && !(await alive()));
    // each branch on any OS, never a live kill: a stand-in host records every taskkill argv and every signal (as ["kill", pid,
    // signal]) — taskkill answers as told; a stand-in child records its kills
    const win = (answer: { error?: Error; status: number | null }, calls: string[][]): KillHost =>
      ({ platform: "win32", taskkill: (args) => { calls.push(args); return answer; }, kill: (pid, s) => { calls.push(["kill", String(pid), s]); } });
    const linux = (calls: string[][]): KillHost =>
      ({ platform: "linux", taskkill: (args) => { calls.push(args); return { status: 0 }; }, kill: (pid, s) => { calls.push(["kill", String(pid), s]); } });
    const killsOf = (host: KillHost, { pid }: { pid: number | undefined } = { pid: 4242 }): { kills: string[]; tree: boolean } => {
      const kills: string[] = [];
      const tree = killTree({ pid, kill: (s) => { kills.push(s); return true; } }, host);
      return { kills, tree };
    };
    const okCalls: string[][] = [], errCalls: string[][] = [], failCalls: string[][] = [], fail1Calls: string[][] = [];
    const ok = killsOf(win({ status: 0 }, okCalls));
    check(`[pool] killTree on Windows: one taskkill with argv exactly /T /F /PID <pid>, nothing else killed, returns true (saw ${JSON.stringify(okCalls)}, kills ${JSON.stringify(ok.kills)})`,
      JSON.stringify(okCalls) === JSON.stringify([["/T", "/F", "/PID", "4242"]]) && ok.kills.length === 0 && ok.tree);
    const err = killsOf(win({ error: new Error("spawnSync taskkill ETIMEDOUT"), status: null }, errCalls));
    check(`[pool] killTree on Windows: a taskkill that does not start or times out (spawnSync's error) falls back to SIGKILL of the child and returns false (saw kills ${JSON.stringify(err.kills)})`,
      errCalls.length === 1 && err.kills.join(",") === "SIGKILL" && !err.tree);
    const fail = killsOf(win({ status: 128 }, failCalls)), fail1 = killsOf(win({ status: 1 }, fail1Calls));
    check(`[pool] killTree on Windows: a taskkill that exits non-zero (128, 1) falls back to SIGKILL of the child and returns false (saw kills ${JSON.stringify([fail.kills, fail1.kills])})`,
      failCalls.length === 1 && fail1Calls.length === 1 && fail.kills.join(",") === "SIGKILL" && fail1.kills.join(",") === "SIGKILL" && !fail.tree && !fail1.tree);
    const noPidCalls: string[][] = [];
    const noPid = killsOf(win({ status: 0 }, noPidCalls), { pid: undefined });
    check("[pool] killTree: a child without a pid gets SIGKILL, no taskkill, returns false", noPidCalls.length === 0 && noPid.kills.join(",") === "SIGKILL" && !noPid.tree);
    // a pid below 2 is refused before any kill (POSIX: -0 is this process's own group, -1 every process) — stand-in hosts only
    const lowCalls: string[][] = [];
    const low = [0, 1].flatMap((pid) => [killPidTree(pid, win({ status: 0 }, lowCalls)), killPidTree(pid, linux(lowCalls))]);
    check(`[pool] killPidTree: pid 0 and pid 1 are false at once — no taskkill, no signal, on Windows or POSIX (saw ${JSON.stringify(lowCalls)})`,
      low.every((b) => !b) && lowCalls.length === 0);
    const posixCalls: string[][] = [];
    const posixTree = killPidTree(4242, linux(posixCalls));
    check(`[pool] killPidTree on POSIX: SIGKILL to the process group (-pid), no taskkill, returns true (saw ${JSON.stringify(posixCalls)})`,
      posixTree && JSON.stringify(posixCalls) === JSON.stringify([["kill", "-4242", "SIGKILL"]]));
    // the freeze e2e's cleanup after a killed run: on Windows only when runNode's tree kill failed (the browser's pid may be reused)
    const browserCalls = (r: { killed: boolean; treeKilled: boolean }, host: (calls: string[][]) => KillHost = (c) => win({ status: 0 }, c)): string[][] => {
      const calls: string[][] = [];
      killBrowsers(r, [101, 202], host(calls));
      return calls;
    };
    const after = browserCalls({ killed: true, treeKilled: false });
    check(`[pool] killBrowsers on Windows, the run's tree kill failed: taskkill /T /F /PID for each browser pid (saw ${JSON.stringify(after)})`,
      JSON.stringify(after) === JSON.stringify([["/T", "/F", "/PID", "101"], ["/T", "/F", "/PID", "202"]]));
    const done = browserCalls({ killed: true, treeKilled: true }), notKilled = browserCalls({ killed: false, treeKilled: false });
    check(`[pool] killBrowsers on Windows: nothing after a tree kill that worked (the browser went with it), nothing for a run not killed (saw ${JSON.stringify([done, notKilled])})`,
      done.length === 0 && notKilled.length === 0);
    // POSIX: the browser leads its own process group, which the run's group kill never reaches — always cleaned up after a kill
    const posixAfter = browserCalls({ killed: true, treeKilled: true }, linux), posixNotKilled = browserCalls({ killed: false, treeKilled: false }, linux);
    check(`[pool] killBrowsers on POSIX, a killed run (its tree kill worked): SIGKILL to each browser's group, -101 and -202; nothing for a run not killed (saw ${JSON.stringify([posixAfter, posixNotKilled])})`,
      JSON.stringify(posixAfter) === JSON.stringify([["kill", "-101", "SIGKILL"], ["kill", "-202", "SIGKILL"]]) && posixNotKilled.length === 0);

    // killChildTree / childPids (a probe's browser) on a stand-in host: every command, signal and taskkill recorded; a
    // command answers as told (TIMEOUT: spawnSync's error for a run past its cap), the procfs reads come from `proc`
    const SELF = 500;
    const TIMEOUT = { error: Object.assign(new Error("spawnSync pgrep ETIMEDOUT"), { code: "ETIMEDOUT" }), status: null, stdout: "" };
    const MISSING = { error: Object.assign(new Error("spawnSync pgrep ENOENT"), { code: "ENOENT" }), status: null, stdout: "" };
    type Answer = { error?: Error; status: number | null; stdout: string };
    const proc = (o: { platform: NodeJS.Platform; calls: string[][]; run?: Record<string, Answer>; stats?: Record<string, string> | null;
      alive?: Set<number>; groups?: Set<number> }): ProcHost => ({
      platform: o.platform, self: SELF,
      taskkill: (args) => { o.calls.push(["taskkill", ...args]); return { status: 0 }; },
      kill: (pid, s) => {
        o.calls.push(["kill", String(pid), s]);
        if (pid < 0 ? !(o.groups ?? new Set()).has(-pid) : !(o.alive ?? new Set()).has(pid)) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      readdir: (dir) => { if (dir !== "/proc" || !o.stats) throw new Error(`ENOENT ${dir}`); return ["self", "1", ...Object.keys(o.stats)]; },
      readFile: (file) => { const s = /^\/proc\/(\d+)\/stat$/.exec(file)?.[1]; const v = s !== undefined ? o.stats?.[s] : undefined; if (v === undefined) throw new Error(`ENOENT ${file}`); return v; },
      run: (cmd, args, cap) => { o.calls.push([cmd, ...args, `cap=${cap}`]); return o.run?.[cmd] ?? TIMEOUT; },
      exists: (pid) => (o.alive ?? new Set()).has(pid),
    });
    const stat = (pid: number, comm: string, ppid: number): string => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560`;
    // Linux: the children come from /proc/<pid>/stat (a command name holding ") (" and spaces still parses) — no command run,
    // so a pgrep/ps past its cap changes nothing
    const linuxCalls: string[][] = [];
    const linuxStats = { "601": stat(601, "headless_shell", SELF), "602": stat(602, "a) (b c", SELF), "603": stat(603, "other", 1) };
    check(`[kill-tree] childPids on Linux: this process's children from a /proc/<pid>/stat scan, no command run (saw ${JSON.stringify(linuxCalls)})`,
      JSON.stringify(childPids(proc({ platform: "linux", calls: linuxCalls, stats: linuxStats }), 2_000)) === "[601,602]" && linuxCalls.length === 0);
    const unknownCalls: string[][] = [];
    await killChildTree(undefined, proc({ platform: "linux", calls: unknownCalls, stats: linuxStats, alive: new Set([601, 602]), groups: new Set([601, 602]) }), { capMs: 2_000 });
    check(`[kill-tree] killChildTree, the browser's pid unknown, Linux with every pgrep/ps past its cap: each child found in /proc gets SIGKILL to its group (saw ${JSON.stringify(unknownCalls)})`,
      JSON.stringify(unknownCalls) === JSON.stringify([["kill", "-601", "SIGKILL"], ["kill", "-602", "SIGKILL"]]));
    // elsewhere: pgrep -P (a ps only when pgrep is missing; a pgrep past its cap is no list, not a slower ps)
    const pgCalls: string[][] = [], psCalls: string[][] = [], capCalls: string[][] = [];
    const viaPgrep = childPids(proc({ platform: "darwin", calls: pgCalls, run: { pgrep: { status: 0, stdout: "701\n702\n" } } }), 2_000);
    const viaPs = childPids(proc({ platform: "darwin", calls: psCalls, run: { pgrep: MISSING, ps: { status: 0, stdout: `  701   ${SELF}\n  9 ${SELF}0\n 702 1\n` } } }), 2_000);
    const capped = childPids(proc({ platform: "darwin", calls: capCalls }), 2_000);
    check(`[kill-tree] childPids on macOS: pgrep -P <self> capped (no ps); ps -A -o pid=,ppid= only when pgrep is missing; a pgrep past its cap → null, no ps (saw ${JSON.stringify([pgCalls, psCalls, capCalls])})`,
      JSON.stringify(viaPgrep) === "[701,702]" && JSON.stringify(pgCalls) === JSON.stringify([["pgrep", "-P", String(SELF), "cap=2000"]])
      && JSON.stringify(viaPs) === "[701]" && JSON.stringify(psCalls[1]) === JSON.stringify(["ps", "-A", "-o", "pid=,ppid=", "cap=2000"])
      && capped === null && capCalls.length === 1);
    // the browser's pid known: its group gets SIGKILL with no command run, however slow ps/pgrep are
    const knownCalls: string[][] = [];
    await killChildTree(4242, proc({ platform: "darwin", calls: knownCalls, alive: new Set([4242]), groups: new Set([4242]) }), { capMs: 2_000 });
    check(`[kill-tree] killChildTree, the browser's pid known, pgrep/ps past their cap: SIGKILL to its group, no command run (saw ${JSON.stringify(knownCalls)})`,
      JSON.stringify(knownCalls) === JSON.stringify([["kill", "-4242", "SIGKILL"]]));
    // known, already gone with no group left: nothing more (no listing, nothing killed alone); still running but leading no
    // group (a wrapper's child): this process's children are ended instead
    const goneCalls: string[][] = [], wrapCalls: string[][] = [];
    await killChildTree(4242, proc({ platform: "darwin", calls: goneCalls }), { capMs: 2_000 });
    await killChildTree(4242, proc({ platform: "darwin", calls: wrapCalls, alive: new Set([4242, 801]), groups: new Set([801]), run: { pgrep: { status: 0, stdout: "801\n" } } }), { capMs: 2_000 });
    check(`[kill-tree] killChildTree, pid known: gone with no group → nothing more; running but no group leader → each child's group (saw ${JSON.stringify([goneCalls, wrapCalls])})`,
      JSON.stringify(goneCalls) === JSON.stringify([["kill", "-4242", "SIGKILL"]])
      && JSON.stringify(wrapCalls) === JSON.stringify([["kill", "-4242", "SIGKILL"], ["pgrep", "-P", String(SELF), "cap=2000"], ["kill", "-801", "SIGKILL"]]));
    // Windows: taskkill /T /F /PID <pid> while it exists — nothing for a pid that has gone (it may be reused), an unknown one, or pid 1
    const winCalls: string[][] = [], winGone: string[][] = [], winUnknown: string[][] = [];
    await killChildTree(4242, proc({ platform: "win32", calls: winCalls, alive: new Set([4242]) }), { capMs: 2_000 });
    await killChildTree(4242, proc({ platform: "win32", calls: winGone }), { capMs: 2_000 });
    await killChildTree(undefined, proc({ platform: "win32", calls: winUnknown, alive: new Set([1]) }), { capMs: 2_000 });
    await killChildTree(1, proc({ platform: "win32", calls: winUnknown, alive: new Set([1]) }), { capMs: 2_000 });
    check(`[kill-tree] killChildTree on Windows: one taskkill /T /F /PID <pid> of a running browser; nothing for one gone, unknown, or pid 1 (saw ${JSON.stringify([winCalls, winGone, winUnknown])})`,
      JSON.stringify(winCalls) === JSON.stringify([["taskkill", "/T", "/F", "/PID", "4242"]]) && winGone.length === 0 && winUnknown.length === 0);
    // the grace: a browser that goes on its own within it is not killed (Windows: no taskkill); one that does not is, after it
    const going = new Set([4242]);
    const graceCalls: string[][] = [];
    setTimeout(() => going.delete(4242), 120);
    const g0 = Date.now();
    await killChildTree(4242, proc({ platform: "win32", calls: graceCalls, alive: going }), { capMs: 2_000, graceMs: 2_000 });
    const goneIn = Date.now() - g0;
    const stuckCalls: string[][] = [];
    const s0 = Date.now();
    await killChildTree(4242, proc({ platform: "win32", calls: stuckCalls, alive: new Set([4242]) }), { capMs: 2_000, graceMs: 300 });
    const stuckIn = Date.now() - s0;
    check(`[kill-tree] killChildTree's grace: a browser gone within it → no taskkill (returned in ${goneIn} ms); one still running → taskkill after the grace (${stuckIn} ms, saw ${JSON.stringify([graceCalls, stuckCalls])})`,
      graceCalls.length === 0 && goneIn < 1_500 && stuckCalls.length === 1 && stuckIn >= 250);
    const quick = await within(runNode(tmp, "-e", ["0"], 20_000), TIMED_OUT);
    check("[pool] runNode: a run that exits before killAfterMs is not killed", quick !== TIMED_OUT && !quick.killed && !quick.treeKilled && quick.status === 0);
    // a variable of this process's own (not PATH: libuv on Windows copies PATH, SYSTEMROOT and a few more into any env missing them)
    process.env.DT_RUNNODE_PARENT_ONLY = "1";
    const env = await within(runNode(tmp, "-e", ["process.stdout.write(String(process.env.X) + String(!!process.env.DT_RUNNODE_PARENT_ONLY))"], 0, { X: "1" }), TIMED_OUT);
    delete process.env.DT_RUNNODE_PARENT_ONLY;
    check(`[pool] runNode: env is the child's WHOLE environment, not added to this one's (X set, this process's DT_RUNNODE_PARENT_ONLY gone; saw ${env === TIMED_OUT ? "a timeout" : JSON.stringify(env.stdout)})`, env !== TIMED_OUT && env.stdout === "1false");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

report();
