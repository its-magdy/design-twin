// The test runner's own self-test (group 16, H-1a / D103): it keeps going after a failure, ends with a summary, treats a
// suite that exits 0 without its checks line as failed, warns on SKIPPED locally and fails on it under CI=true, forwards
// every suite's output, runs one suite at a time, kills a hung suite, and refuses an unlisted test file. D109: a
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
  // D109 fakes: a hung suite that leaves its pid; one whose grandchild inherits its stdout and outlives it; one that
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, capMs: number): Promise<boolean> => { const end = Date.now() + capMs; while (!cond() && Date.now() < end) await sleep(25); return cond(); };
const summaryOf = (s: string): string => s.slice(s.lastIndexOf("SUMMARY"));

try {
  // ---- a failing / no-summary / partial suite does not stop the rest
  console.log("\nrun-suites — keeps going, summary, exit code:");
  fs.rmSync(LOG, { force: true });
  const mixed = runner([], { DT_RUN_SUITES_LIST: list(["pass", "failing", "nosummary", "partial", "skipped", "after"]) });
  const sum = summaryOf(mixed.out);
  check("[H-1] the suite after a failing one still runs (its output is in the log)", /AFTER-SUITE-RAN/.test(mixed.out) && /=== after /.test(mixed.out));
  check("[H-1] …and so does every suite after the no-summary and the partial one (all six started)", ["pass", "failing", "nosummary", "partial", "skipped", "after"].every((n) => new RegExp(`^start ${n}$`, "m").test(read(LOG))));
  check("[H-1] exit 1 when any suite failed", mixed.status === 1);
  check("[H-1] a SUMMARY block closes the run, one row per suite, with p/t and a time", /SUMMARY/.test(sum) && ["pass", "failing", "nosummary", "partial", "skipped", "after"].every((n) => lines(sum).some((l) => l.startsWith(n + " ")))
    && lines(sum).some((l) => /^pass\s+pass\s+2\/2\s+\d+\.\ds/.test(l)) && lines(sum).some((l) => /^failing\s+FAIL\s+1\/2\s+\d+\.\ds/.test(l)));
  check("[H-1] the counts line: 6 suites: 2 passed, 3 FAILED, 1 skipped", /6 suites: 2 passed, 3 FAILED, 1 skipped — total \d/.test(sum));
  const failedLine = lines(sum).find((l) => l.startsWith("FAILED:")) ?? "";
  check("[H-1] FAILED names the failing suite, the one that exited 0 without its checks line, and the p<t one — not the pass/after/skipped",
    /\bfailing\b/.test(failedLine) && /\bnosummary\b/.test(failedLine) && /\bpartial\b/.test(failedLine) && !/\b(pass|after|skipped)\b/.test(failedLine));
  check("[H-1] a suite that exits 0 without its `N/N checks passed` line says why", /nosummary\s+FAIL\s+-\s+.*ended without its `N\/N checks passed` line/.test(sum));
  check("[H-1] a suite that exits 0 with p < t is failed (1/2 checks passed)", /partial\s+FAIL\s+1\/2\s+.*1\/2 checks passed/.test(sum));
  check("[H-1] the failed suites carry a rerun hint", /rerun: node /.test(sum));
  check("[D103] the SKIPPED suite is listed as skipped with the CI warning", /^SKIPPED \(no playwright\): skipped$/m.test(sum) && /CI runs these/.test(sum) && /^skipped\s+skipped\s/m.test(sum));
  check("[H-1] each suite's own output (its check lines and `N/N checks passed`) is forwarded live, before the summary",
    /✓ pass-check-a/.test(mixed.out.slice(0, mixed.out.lastIndexOf("SUMMARY"))) && /✗ FAIL failing-check-b/.test(mixed.out) && (mixed.out.match(/^2\/2 checks passed$/gm) ?? []).length >= 1);
  const log = lines(read(LOG)).filter(Boolean);
  check("[H-1] strictly serial: every `start X` is followed by its own `end X` before the next start", log.length === 12 && log.every((l, i) => (i % 2 === 0 ? l.startsWith("start ") : l === "end " + (log[i - 1] ?? "").slice(6))));

  // ---- SKIPPED: warning locally, failure under CI=true
  console.log("\nrun-suites — SKIPPED (D103):");
  const okList = list(["pass", "skipped"]);
  const local = runner([], { DT_RUN_SUITES_LIST: okList });
  check("[D103] only pass + skipped, no CI: exit 0 and the warning", local.status === 0 && /warning: CI runs these/.test(local.out) && /2 suites: 1 passed, 0 FAILED, 1 skipped/.test(local.out));
  const ci = runner([], { DT_RUN_SUITES_LIST: okList, CI: "true" });
  check("[D103] the same under CI=true: exit 1, the skipped suite is FAILED with the reason", ci.status === 1 && /^FAILED: skipped$/m.test(ci.out) && /SKIPPED under CI=true/.test(ci.out));
  check("[D103] CI unset or other than \"true\" does not fail it (CI=false: exit 0)", runner([], { DT_RUN_SUITES_LIST: okList, CI: "false" }).status === 0);
  const allPass = runner([], { DT_RUN_SUITES_LIST: list(["pass", "after"]) });
  check("[H-1] all suites pass: exit 0, `2 suites: 2 passed, 0 FAILED, 0 skipped`, no FAILED/SKIPPED line", allPass.status === 0 && /2 suites: 2 passed, 0 FAILED, 0 skipped/.test(allPass.out) && !/^FAILED:/m.test(allPass.out) && !/^SKIPPED/m.test(allPass.out));

  // ---- the cap
  console.log("\nrun-suites — per-suite cap:");
  const t0 = Date.now();
  const hung = runner([], { DT_RUN_SUITES_LIST: list(["hang", "after"]), DT_SUITE_TIMEOUT_MS: "500", DT_KILL_GRACE_MS: "300" });
  check("[H-1] a hung suite is killed at the cap, reported `timed out`, and the next suite still runs", hung.status === 1 && /hang\s+FAIL\s+.*timed out after/.test(hung.out) && /AFTER-SUITE-RAN/.test(hung.out) && Date.now() - t0 < 30_000);

  // ---- D109: a signal to the runner reaches the running suite (its own process group), and the summary still prints
  console.log("\nrun-suites — SIGTERM / SIGHUP (D109):");
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
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
    check(`[D109] ${sig} to the runner kills the running suite (no orphan), skips the rest, prints the summary, exits 130`,
      suitePid > 0 && gone && code === 130 && /SUMMARY/.test(out) && /hangpid\s+FAIL\s.*interrupted/.test(out) && /after\s+not run/.test(out));
  }

  // ---- D109: the verdict is the suite's exit, not its pipes closing (a lingering grandchild holds them)
  console.log("\nrun-suites — exit vs close, piped stdout, 0/0 (D109):");
  {
    const t1 = Date.now();
    const lingering = runner([], { DT_RUN_SUITES_LIST: list(["lingers"]) });
    const ms = Date.now() - t1;
    const gp = pidIn(path.join(tmp, "linger.pid"));
    if (gp > 0 && alive(gp)) try { process.kill(gp, "SIGKILL"); } catch { /* gone */ }
    check(`[D109] a suite whose grandchild keeps its stdout open is done when it EXITS (+ the drain cap), not 25 s later (${ms} ms)`,
      lingering.status === 0 && /lingers\s+pass\s+1\/1/.test(lingering.out) && ms < 10_000);
  }
  {
    // a slow reader on the runner's stdout: exit() used to drop everything still queued in the pipe (the SUMMARY)
    const e: Record<string, string | undefined> = { ...process.env, DT_RUN_SUITES_LIST: list(["big"]) };
    delete e.CI;
    const r = spawnSync("sh", ["-c", `"${process.execPath}" "${RUNNER}" | (sleep 2; cat)`], { encoding: "utf8", timeout: 60_000, env: e });
    check("[D109] with a slow reader on a piped stdout the runner's output is complete: the suite's 400 KB, then the SUMMARY",
      (r.stdout.match(/^x{99}$/gm) ?? []).length === 4000 && /SUMMARY/.test(r.stdout) && /1 suites: 1 passed, 0 FAILED/.test(r.stdout));
  }
  {
    const zero = runner([], { DT_RUN_SUITES_LIST: list(["zero", "after"]) });
    check("[D109] a suite that prints `0/0 checks passed` asserted nothing: FAIL", zero.status === 1 && /zero\s+FAIL\s.*0\/0 checks/.test(zero.out) && /^FAILED: zero$/m.test(zero.out));
  }

  // ---- D109: the lint command on Windows goes through cmd.exe (spawning npm.cmd without a shell throws EINVAL)
  console.log("\nrun-suites — the lint command per platform (D109):");
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
    check("[D109] win32 without npm_execpath: cmd.exe /d /s /c \"npm run -s lint:any\" (verbatim), not detached",
      c.win?.cmd === "C:\\Windows\\cmd.exe" && c.win.args.join(" ") === `/d /s /c "npm run -s lint:any"` && c.win.windowsVerbatimArguments === true && c.win.detached === false);
    check("[D109] win32 with an npm-cli.js execpath: node runs it directly; a node suite is not detached on win32; posix: npm, detached",
      c.winJs?.cmd === process.execPath && c.winJs.args[0] === "C:\\npm\\bin\\npm-cli.js" && c.winNode?.detached === false
      && c.posix?.cmd === "npm" && c.posix.args.join(" ") === "run -s lint:any" && c.posix.detached === true);
  }

  // ---- D109: verify-values' own local chromium skip is reported `skipped`, not a plain pass
  {
    const vv = runner(["verify-values"], { PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, "no-browsers") });
    check("[D109] verify-values with no browser, locally: the runner lists it as skipped (the SKIPPED marker), exit 0",
      vv.status === 0 && /^verify-values\s+skipped\s/m.test(vv.out) && /^SKIPPED \(no playwright\): verify-values$/m.test(vv.out));
  }

  // ---- filters + --list
  console.log("\nrun-suites — filters and --list:");
  fs.rmSync(LOG, { force: true });
  const filtered = runner(["after", "pass"], { DT_RUN_SUITES_LIST: list(["pass", "failing", "after"]) });
  check("[H-1] positional names run only those suites, in list order (pass then after; failing not started)", filtered.status === 0 && /^start pass$/m.test(read(LOG)) && /^start after$/m.test(read(LOG)) && !/start failing/.test(read(LOG)) && /2 suites: 2 passed/.test(filtered.out));
  const unknown = runner(["no-such-suite"], { DT_RUN_SUITES_LIST: list(["pass"]) });
  check("[H-1] an unknown name is a usage error (exit 2, names it)", unknown.status === 2 && /no suite matches "no-such-suite"/.test(unknown.err));

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
    check("[cache] by default a suite gets NODE_COMPILE_CACHE=<tmpdir>/designtwin-node-compile-cache", probe({}).includes(`CC=${path.join(os.tmpdir(), "designtwin-node-compile-cache")} `));
    check("[cache] a NODE_COMPILE_CACHE the user set wins", probe({ NODE_COMPILE_CACHE: path.join(tmp, "mine") }).includes(`CC=${path.join(tmp, "mine")} `));
    check("[cache] NODE_DISABLE_COMPILE_CACHE reaches the suite untouched (Node honours it)", /DIS=1$/m.test(probe({ NODE_DISABLE_COMPILE_CACHE: "1" })));
  }

  // ---- the real list + the coverage guard
  console.log("\nrun-suites — coverage guard:");
  const testDir = import.meta.dirname;
  const onDisk = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.ts") || f === "harness.ts");
  const real = runner(["--list"], {});
  const realLines = lines(real.out);
  check("[H-1] the real `--list` exits 0 and names every test/*.test.ts and harness.ts on disk", real.status === 0 && onDisk.length > 30 && onDisk.every((f) => real.out.includes("test/" + f)));
  check("[H-1] …the two lints come first (lint:any, lint:types), then the real-name guard, then harness, then bridge — the old chain's order", /^lint:any/.test(realLines[0] ?? "") && /^lint:types/.test(realLines[1] ?? "") && /^real-names /.test(realLines[2] ?? "") && /^harness /.test(realLines[3] ?? "") && /^bridge /.test(realLines[4] ?? ""));
  check("[H-1] …the browser suites keep their place (verify-probe-e2e after verify-probe, verify-own-pixels after verify-probe-drive-e2e)",
    real.out.indexOf("verify-probe-e2e ") > real.out.indexOf("verify-probe ") && real.out.indexOf("verify-own-pixels") > real.out.indexOf("verify-probe-drive-e2e"));
  const pkg = JSON.parse(read(path.join(testDir, "..", "package.json")) || "{}") as { scripts?: Record<string, string> };
  check("[H-1] `npm test` is the runner (package.json scripts.test === \"node test/run-suites.ts\"); the lints stay scripts", pkg.scripts?.test === "node test/run-suites.ts" && typeof pkg.scripts.typecheck === "string" && typeof pkg.scripts["lint:any"] === "string" && typeof pkg.scripts["lint:types"] === "string");

  // ---- --fast: skips exactly the three probe e2e suites, `not run` in the summary, exit unaffected, never looks like a full pass
  console.log("\nrun-suites — --fast:");
  const SLOW = ["verify-probe-e2e", "verify-probe-drive-e2e", "verify-probe-behaviour-e2e"];
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
  check("[fast] --fast skips the three slow suites (never started), runs the others, and exits 0 although they are `not run`",
    fastRun.status === 0 && /^start quick$/m.test(read(LOG)) && /^start quick2$/m.test(read(LOG)) && SLOW.every((n) => !new RegExp(`start ${n}`).test(read(LOG))) && /2 passed, 0 FAILED, 0 skipped, 3 not run/.test(fastSum));
  check("[fast] the SUMMARY lists each skipped suite as `not run` with the reason `--fast`", SLOW.every((n) => lines(fastSum).some((l) => l.startsWith(n + " ") && /\bnot run\b/.test(l) && /--fast\s*$/.test(l))));
  check("[fast] the run ends with the loud line (not the full suite, names them, run `npm test`, CI runs everything)",
    /^--fast: skipped the probe e2e suites \(verify-probe-e2e, verify-probe-drive-e2e, verify-probe-behaviour-e2e\) .*NOT the full suite.*`npm test`.*CI runs everything$/m.test(fastRun.out) && (lines(fastRun.out.trimEnd()).pop() ?? "").startsWith("--fast:"));
  check("[fast] without --fast the same list runs all five suites", (() => { const r = runner([], { DT_RUN_SUITES_LIST: fastList }); return r.status === 0 && /5 suites: 5 passed/.test(r.out) && !/--fast/.test(r.out); })());
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
  check("[fast] --fast with only a slow suite named: nothing runs, exit 0, the warning is printed", onlySlow.status === 0 && /^--fast: skipped/m.test(onlySlow.out) && !/^=== /m.test(onlySlow.out));
  const staleList = runner(["--fast"], { DT_RUN_SUITES_LIST: named([{ name: "quick", src: okSrc("quick") }, { name: "verify-probe-e2e", src: okSrc("a") }, { name: "verify-probe-drive-e2e", src: okSrc("b") }], "stale") });
  check("[fast] a FAST_SKIP name that is not in the suite list exits 1 and names it (a rename cannot silently drop a suite)",
    staleList.status === 1 && /verify-probe-behaviour-e2e/.test(staleList.err) && !/^=== /m.test(staleList.out));
  check("[fast] without --fast a custom list is not subject to that guard", runner([], { DT_RUN_SUITES_LIST: list(["pass"]) }).status === 0);
  check("[fast] an unknown option is still a usage error, and the usage line names --fast", (() => { const r = runner(["--bogus"], { DT_RUN_SUITES_LIST: list(["pass"]) }); return r.status === 2 && /--fast/.test(r.err); })());
  const realFast = runner(["--fast", "--list"], {});
  check("[fast] the real `--fast --list` omits exactly verify-probe-e2e, verify-probe-drive-e2e, verify-probe-behaviour-e2e (nothing else) and keeps the rest",
    realFast.status === 0 && (() => {
      const all = new Set(lines(real.out).filter(Boolean).map((l) => l.split(/\s+/)[0]));
      const got = new Set(lines(realFast.out).filter(Boolean).map((l) => l.split(/\s+/)[0]));
      const missing = [...all].filter((n) => !got.has(n));
      return missing.sort().join(",") === [...SLOW].sort().join(",") && [...got].every((n) => all.has(n)) && got.size === all.size - 3;
    })());


  check("[fast] `npm run test:fast` is the runner with --fast (package.json scripts[\"test:fast\"] === \"node test/run-suites.ts --fast\")", pkg.scripts?.["test:fast"] === "node test/run-suites.ts --fast");

  const mirror = path.join(tmp, "mirror");
  fs.mkdirSync(mirror);
  for (const f of onDisk) fs.writeFileSync(path.join(mirror, f), "");
  const guardEnv = { DT_RUN_SUITES_DIR: mirror };
  check("[H-1] control: a directory holding exactly the listed files passes the guard", runner(["--list"], guardEnv).status === 0);
  fs.writeFileSync(path.join(mirror, "zz-forgotten.test.ts"), "");
  const stray = runner(["--list"], guardEnv);
  check("[H-1] a test/*.test.ts that is not in SUITES fails the runner (exit 1) and is named", stray.status === 1 && /zz-forgotten\.test\.ts exists but is not in SUITES/.test(stray.err));
  fs.rmSync(path.join(mirror, "zz-forgotten.test.ts"));
  fs.rmSync(path.join(mirror, "mcp-smoke.test.ts"));
  const missing = runner(["--list"], guardEnv);
  check("[H-1] a SUITES file that does not exist fails the runner (exit 1) and is named", missing.status === 1 && /lists mcp-smoke\.test\.ts but .* does not exist/.test(missing.err));
  const guardNoRun = runner(["zz-nothing"], guardEnv);
  check("[H-1] the guard also stops a real run (not only --list): exit 1 before any suite starts", guardNoRun.status === 1 && !/^=== /m.test(guardNoRun.out));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

report();
