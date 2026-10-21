// one verification run on disk: status v2 written by the tools, atomic
// writes, --publish from a staging directory, and --wait on a run. Runs design-to-code/verify-run.ts in-process
// and `verify-screen --status / --wait` as the CLI, in temp projects (invented names).
// Run with:  bun test/verify-run.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { runSync } from "../design-to-code/proc.ts";
import type { ProcResult } from "../design-to-code/proc.ts";
import * as VR from "../design-to-code/verify-run.ts";
import { scriptCmd, shellArg } from "../design-to-code/cli-args.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import { check, report } from "./assert.ts";
import { POSIX_SH } from "./posix-sh.ts";
import { LockBusy, LockLost, PID_NS } from "../bridge/src/file-lock.ts";
import { setTimeout as sleep } from "node:timers/promises";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
const VS_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
const LOCK_CHILD = path.join(import.meta.dirname, "lock-child.ts"); // another writer, in its own process
const sha = (f: string): string => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
// The run cache keys by the on-disk spelling (fs.realpathSync.native); the JS resolver keeps what it was given — on Windows
// the 8.3 short temp dir (RUNNER~1) stays short there and is the long name natively — so expectations use the native one.
const realNative = (p: string): string => fs.realpathSync.native(p);
const tmps: string[] = [];
const mk = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
const inTmpDir = (live: string): boolean => live.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep);
const readStatusFile = (f: string): VR.VerifyStatusV2 | null => readJsonOrNull(f, VR.isVerifyStatusV2);
// Each block runs guarded: a throw is one ✗ with the reason, never a crash that hides the checks after it.
async function block(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); } catch (e) { check(`${name} (the block threw: ${e instanceof Error ? e.message : String(e)})`, false); }
}

// ---------------------------------------------------------------- the module (interface names)
console.log("verify-run.ts — the interface:");
safe("STATUS_SCHEMA and STATUS_PHASES are exported with the interface's values", () => VR.STATUS_SCHEMA === "designtwin/verify-status@2"
  && VR.STATUS_PHASES.join(",") === "queued,starting,renderer-found,renderer-ready,measuring,measured,driving,done,failed,blocked");

console.log("writeStatus / readStatus:");
await block("writeStatus / readStatus:", async () => {
  const d = mk("dt-run-status-");
  const base = path.join(d, "Plots__1_1");
  const a1 = VR.writeStatus(base, { runId: "run-a", phase: "measuring", by: "verify-probe" });
  const a2 = VR.writeStatus(base, { runId: "run-a", phase: "measured", by: "verify-probe", measuredSha256: "1".repeat(64) });
  const b1 = VR.writeStatus(base, { runId: "run-b", phase: "queued", by: "orchestrator" });
  safe("rev counts writes within a run (1, 2), and restarts at 1 for a new run", () => a1.rev === 1 && a2.rev === 2 && b1.rev === 1);
  const onDisk = readStatusFile(VR.liveStatusFile(base));
  tmps.push(path.dirname(VR.liveStatusFile(base)));
  safe("the file is status v2: schema, screen = the base name, machine ISO time, by", () => onDisk !== null && onDisk.schema === VR.STATUS_SCHEMA && onDisk.screen === "Plots__1_1" && onDisk.runId === "run-b"
    && !Number.isNaN(Date.parse(onDisk.at)) && onDisk.by === "orchestrator");
  fs.rmSync(VR.liveStatusFile(base));
  fs.writeFileSync(base + ".status.json", JSON.stringify({ screen: "Plots__1_1", phase: "done", detail: "measured 12 nodes", at: "2026-09-29T19:22:52Z" }));
  safe("an older hand-written status {screen, phase, detail, at} reads as 'v1' (never trusted for shas)", () => VR.readStatus(base) === "v1");
  safe("…and a write over it starts rev 1", () => VR.writeStatus(base, { runId: "run-c", phase: "starting", by: "agent" }).rev === 1);
});

// ---------------------------------------------------------------- where the live status lives
console.log("the run cache — the live status never lives in the watched project tree:");
// A project the way a consumer has one: package.json + node_modules beside design/verify/.
function proj(prefix = "dt-run-cli-"): string {
  const cwd = mk(prefix);
  fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.mkdirSync(path.join(cwd, "design", "verify"), { recursive: true });
  return cwd;
}
await block("the run cache:", async () => {
  const cwd = proj();
  const real = realNative(cwd);
  const base = path.join(cwd, "design", "verify", "Plots__1_1");
  safe("a project with node_modules → <project>/node_modules/.cache/designtwin-verify/<S>.status.json", () => VR.liveStatusFile(base) === path.join(real, "node_modules", ".cache", "designtwin-verify", "Plots__1_1.status.json"));
  safe("…the stage dir of a run is <run cache>/stage/<runId>/", () => VR.stageDirOf(base, "run-a") === path.join(real, "node_modules", ".cache", "designtwin-verify", "stage", "run-a"));
  const prevCwd = process.cwd();
  process.chdir(path.join(cwd, "design"));
  const viaRelative = VR.liveStatusFile(path.join("verify", "Plots__1_1"));
  process.chdir(prevCwd);
  safe("the same file from a relative path and another cwd (one key for verifier, probe and caller)", () => viaRelative === VR.liveStatusFile(base));
  const other = proj();
  safe("two projects never share a live file", () => VR.liveStatusFile(path.join(other, "design", "verify", "Plots__1_1")) !== VR.liveStatusFile(base));
  safe("a verify dir other than design/verify gets its own dirs/<key>/ in the cache", () => VR.liveStatusFile(path.join(cwd, "qa", "Plots__1_1")).startsWith(path.join(real, "node_modules", ".cache", "designtwin-verify", "dirs") + path.sep));
  const bare = mk("dt-run-bare-");
  fs.mkdirSync(path.join(bare, "design", "verify"), { recursive: true });
  const bareLive = VR.liveStatusFile(path.join(bare, "design", "verify", "Plots__1_1"));
  safe("no node_modules → <os tmpdir>/designtwin-verify/<short sha of the verify dir's realpath>/", () => bareLive.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep)
    && path.basename(path.dirname(bareLive)) === crypto.createHash("sha256").update(realNative(path.join(bare, "design", "verify"))).digest("hex").slice(0, 16));
  tmps.push(path.dirname(bareLive));
});

// a monorepo with hoisted dependencies — node_modules only at the workspace root, none beside the app's package.json
await block("the run cache in a monorepo:", async () => {
  const ws = mk("dt-run-ws-");
  const real = realNative(ws);
  fs.writeFileSync(path.join(ws, "package.json"), "{\"name\":\"plots-ws\",\"private\":true,\"workspaces\":[\"apps/*\"]}\n");
  fs.mkdirSync(path.join(ws, "node_modules"));
  const app = path.join(ws, "apps", "plots");
  fs.mkdirSync(path.join(app, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  const fromApp = (() => { const prev = process.cwd(); process.chdir(app); try { return VR.liveStatusFile(path.join("design", "verify", "Plots__1_1")); } finally { process.chdir(prev); } })();
  const fromRoot = (() => { const prev = process.cwd(); process.chdir(ws); try { return VR.liveStatusFile(path.join("apps", "plots", "design", "verify", "Plots__1_1")); } finally { process.chdir(prev); } })();
  const fromAbs = VR.liveStatusFile(path.join(app, "design", "verify", "Plots__1_1"));
  const cache = path.join(real, "node_modules", ".cache", "designtwin-verify");
  safe("root node_modules only → the live file is under <workspace root>/node_modules/.cache/designtwin-verify/, never the os tmpdir", () => fromAbs.startsWith(cache + path.sep) && !fromAbs.startsWith(path.join(os.tmpdir(), "designtwin-verify")));
  safe("…the same file from the app's cwd, the workspace root's cwd and an absolute path", () => fromApp === fromAbs && fromRoot === fromAbs);
  safe("…keyed by the verify dir's path relative to the root (apps/plots/design/verify → dirs/<key>/)", () => path.dirname(fromAbs) === path.join(cache, "dirs", crypto.createHash("sha256").update("apps/plots/design/verify").digest("hex").slice(0, 16)));
  const other = path.join(ws, "apps", "charts", "design", "verify");
  fs.mkdirSync(other, { recursive: true });
  safe("…two apps of one workspace never share a live file", () => VR.liveStatusFile(path.join(other, "Plots__1_1")) !== fromAbs);
  // Yarn PnP-like: package.json + .pnp.cjs, no node_modules anywhere above → the tmpdir fallback
  const pnp = mk("dt-run-pnp-");
  fs.writeFileSync(path.join(pnp, "package.json"), "{\"name\":\"plots-pnp\",\"private\":true}\n");
  fs.writeFileSync(path.join(pnp, ".pnp.cjs"), "// pnp\n");
  fs.mkdirSync(path.join(pnp, "design", "verify"), { recursive: true });
  const pnpLive = VR.liveStatusFile(path.join(pnp, "design", "verify", "Plots__1_1"));
  safe("PnP-like (no node_modules above) → <os tmpdir>/designtwin-verify/<key>/", () => pnpLive.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep));
  tmps.push(path.dirname(pnpLive));
});

// ---------------------------------------------------------------- CLI --status
console.log("verify-screen --status:");
// Everything under the project except node_modules: name → mtime + size (what a dev-server watcher could see change).
function treeState(root: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const st = fs.statSync(f); out.push(`${path.relative(root, f)} ${st.mtimeMs} ${st.size}`); }
    }
  };
  walk(root);
  return out.sort().join("\n");
}
type Cli = (...a: string[]) => ProcResult;
function project(): { cwd: string; dir: string; base: string; live: string; cli: Cli } {
  const cwd = proj();
  const dir = path.join(cwd, "design", "verify");
  fs.writeFileSync(path.join(dir, "Plots__1_1.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "1:1", name: "Plots" }, nodes: [] }, null, 2) + "\n");
  const cli: Cli = (...a: string[]) => runSync(process.execPath, [VS_TS, ...a], { cwd });
  const base = path.join(dir, "Plots__1_1");
  return { cwd, dir, base, live: VR.liveStatusFile(base), cli };
}
// A printed repo-relative path is path.join'd (backslashes on Windows) and quoted by shellArg: build the expectation the same way.
const relPrinted = (file: string): string => shellArg(path.join("design", "verify", file));
const measuredFor = (dir: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ expectationSha256: sha(path.join(dir, "Plots__1_1.expected.json")), nodes: [], ...extra });
await block("verify-screen --status:", async () => {
  const { cwd, dir, live, cli } = project();
  const before = treeState(cwd);
  const s1 = cli("--status", "Plots__1_1", "--phase", "starting", "--new-run", "--detail", "renderer check");
  const m = /^run (\S+) rev 1$/m.exec(s1.stdout);
  const runId = m ? m[1] ?? "" : "";
  safe("--new-run prints `run <id> rev 1` and writes the LIVE status (run cache); stderr names that file", () => s1.status === 0 && runId !== "" && readStatusFile(live)?.detail === "renderer check" && s1.stderr.includes(`status ${shellArg(path.join(realNative(path.dirname(live)), path.basename(live)))}`));
  const s2 = cli("--status", "Plots__1_1", "--phase", "driving");
  cli("--status", "Plots__1_1", "--phase", "driving", "--detail", "heartbeat");
  safe("no --run continues the run in progress (rev 2, same id)", () => s2.status === 0 && s2.stdout.trim() === `run ${runId} rev 2`);
  safe("heartbeats never create or modify anything in the project tree (outside node_modules) — design/verify has no status file", () => treeState(cwd) === before && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
  safe("an unknown phase → exit 2, nothing changed", () => cli("--status", "Plots__1_1", "--phase", "comparing").status === 2 && readStatusFile(live)?.rev === 3);
  safe("--run and --new-run together → exit 2", () => cli("--status", "Plots__1_1", "--phase", "starting", "--run", "x", "--new-run").status === 2);
  safe("--run that is not a run id → exit 2", () => cli("--status", "Plots__1_1", "--phase", "starting", "--run", "../x").status === 2);
  const d0 = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId);
  safe("done with no measured file → refused, exit 1", () => d0.status === 1 && /measured\.json does not exist/.test(d0.stderr));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), nodes: [] }));
  const d1 = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId);
  safe("done with a measured file taken against another expectation → refused, exit 1", () => d1.status === 1 && /measured against expectation 000000000000…/.test(d1.stderr));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), JSON.stringify({ nodes: [] }));
  safe("done with a measured file naming no expectation → refused, exit 1", () => cli("--status", "Plots__1_1", "--phase", "done", "--run", runId).status === 1);
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "another-run" }));
  const d4 = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId);
  safe("done with a measured file whose runId is another run → refused, exit 1", () => d4.status === 1 && /measured in run another-run/.test(d4.stderr));
  safe("…and no refused done published a status into design/verify", () => !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId }));
  fs.writeFileSync(path.join(dir, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [] }));
  const d2 = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId);
  const st = readStatusFile(live);
  safe("done with the right measured file → exit 0; the status names the expected and measured shas", () => d2.status === 0 && st?.phase === "done"
    && st.expectationSha256 === sha(path.join(dir, "Plots__1_1.expected.json")) && st.measuredSha256 === sha(path.join(dir, "Plots__1_1.measured.json")));
  safe("done publishes the final status into design/verify/Plots__1_1.status.json (the same document as the live one)", () => fs.existsSync(path.join(dir, "Plots__1_1.status.json")) && fs.readFileSync(path.join(dir, "Plots__1_1.status.json"), "utf8") === fs.readFileSync(live, "utf8"));
  safe("an evidence file this run never published is not hashed as this run's", () => st?.evidenceSha256 === undefined && /was not published in run/.test(d2.stderr));
  const c1 = cli("--status", "Plots__1_1", "--phase", "driving");
  safe("no --run after the run ended (done) → exit 2 'pass --run <id> or --new-run'", () => c1.status === 2 && /pass --run <id> or --new-run/.test(c1.stderr));
  fs.rmSync(live);
  fs.writeFileSync(path.join(dir, "Plots__1_1.status.json"), JSON.stringify({ screen: "Plots__1_1", phase: "driving", detail: "hand-written", at: "2026-09-29T19:22:52Z" }));
  const c2 = cli("--status", "Plots__1_1", "--phase", "driving");
  safe("no --run over an older hand-written (v1) status → exit 2", () => c2.status === 2 && /pass --run <id> or --new-run/.test(c2.stderr));
  fs.rmSync(path.join(dir, "Plots__1_1.status.json"));
  safe("no --run and no status at all → exit 2", () => cli("--status", "Plots__1_1", "--phase", "starting").status === 2);
  safe("the published status is read when there is no live one (a v2 fallback)", () => {
    VR.publishStatus(path.join(dir, "Plots__1_1"), { schema: VR.STATUS_SCHEMA, screen: "Plots__1_1", runId: "run-old", rev: 4, phase: "done", detail: "", at: "2026-09-30T00:00:00Z", by: "agent" });
    const r = VR.readStatusAt(path.join(dir, "Plots__1_1"));
    return r !== null && r.file === path.join(dir, "Plots__1_1.status.json") && r.status !== "v1" && r.status.runId === "run-old";
  });
});

console.log("done — the probe's record of this run:");
await block("done — the probe's record of this run:", async () => {
  const { dir, base, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-p" }));
  // the probe wrote `measured` naming the file it wrote; an agent heartbeat followed (the sha carries forward)
  VR.writeStatus(base, { runId: "run-p", phase: "measured", by: "verify-probe", measuredSha256: sha(path.join(dir, "Plots__1_1.measured.json")) });
  VR.writeStatus(base, { runId: "run-p", phase: "driving", by: "agent" });
  safe("a later write of the same run still names the probe's measured sha", () => { const st = VR.readStatus(base); return st !== null && st !== "v1" && st.measuredSha256 === sha(path.join(dir, "Plots__1_1.measured.json")); });
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-p", nodes: [{ nodeId: "9:9", styles: {} }] }));
  const d = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-p");
  safe("the measured file changed since the probe recorded it in this run → done refused, exit 1", () => d.status === 1 && /recorded measured file/.test(d.stderr));
});

console.log("verify-screen --status --publish (staging):");
await block("verify-screen --status --publish (staging):", async () => {
  const { cwd, dir, base, live, cli } = project();
  const s = cli("--status", "Plots__1_1", "--phase", "driving", "--new-run");
  const runId = /^run (\S+) rev 1$/m.exec(s.stdout)?.[1] ?? "";
  const stage = VR.stageDirOf(base, runId);
  safe("--status prints and creates the run's stage dir in the run cache", () => s.stderr.includes(`stage  ${shellArg(stage)}`) && fs.statSync(stage).isDirectory());
  fs.writeFileSync(path.join(stage, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [{ nodeId: "2:4", trigger: "on_click", ok: true }] }));
  fs.writeFileSync(path.join(stage, "Plots__1_1-dialog.png"), "png bytes");
  fs.mkdirSync(path.join(stage, "nested"));
  const p = cli("--status", "Plots__1_1", "--phase", "driving", "--run", runId, "--publish", stage);
  const st = readStatusFile(live);
  safe("copies every regular file of the stage dir into design/verify; the status lists them", () => p.status === 0
    && fs.readFileSync(path.join(dir, "Plots__1_1-dialog.png"), "utf8") === "png bytes" && fs.existsSync(path.join(dir, "Plots__1_1.evidence.json"))
    && JSON.stringify(st?.published) === JSON.stringify(["Plots__1_1-dialog.png", "Plots__1_1.evidence.json"]) && !fs.existsSync(path.join(dir, "nested")));
  safe("…through a tmp file in the target dir: none left behind", () => !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  fs.writeFileSync(path.join(stage, "Plots__1_1.report.json"), "{}");
  fs.writeFileSync(path.join(stage, "Plots__1_1-dialog.png"), "changed");
  const r = cli("--status", "Plots__1_1", "--phase", "driving", "--run", runId, "--publish", stage);
  safe("a stage dir holding a tool-owned file (report/expected/status) → refused, exit 1, nothing copied", () => r.status === 1 && fs.readFileSync(path.join(dir, "Plots__1_1-dialog.png"), "utf8") === "png bytes" && !fs.existsSync(path.join(dir, "Plots__1_1.report.json")));
  safe("publishing the verify dir into itself → refused", () => "error" in VR.publishStaged(dir, dir));
  // the same directory spelt through a symlink (or a ../ path) is still the verify dir — compared by realpath
  const alias = path.join(cwd, "verify-alias");
  fs.symlinkSync(dir, alias);
  const aliasR = VR.publishStaged(alias, dir);
  safe("a symlink to the verify dir as the stage dir → refused (realpath), nothing copied", () => "error" in aliasR && aliasR.error.includes("verify directory itself"));
  safe("…and a ../ spelling of it → refused", () => "error" in VR.publishStaged(path.join(dir, "..", "verify"), dir));
  fs.unlinkSync(alias);
  fs.rmSync(path.join(stage, "Plots__1_1.report.json"));
  fs.writeFileSync(path.join(stage, ".migrate-Plots__1_1.json"), "{}");
  const journal = VR.publishStaged(stage, dir);
  safe("a stage dir holding a --migrate journal (.migrate-<S>.json) → refused, nothing copied", () => "error" in journal && journal.error.includes(".migrate-Plots__1_1.json") && !fs.existsSync(path.join(dir, ".migrate-Plots__1_1.json")));
  fs.rmSync(path.join(stage, ".migrate-Plots__1_1.json"));
  // statusRun writes the status between prepare and commit — a refused write aborts, publishing nothing
  const prep = VR.prepareStaged(stage, dir);
  const prepped = "files" in prep && fs.readFileSync(prep.tmpOf("Plots__1_1-dialog.png"), "utf8") === "changed" && fs.readFileSync(path.join(dir, "Plots__1_1-dialog.png"), "utf8") === "png bytes";
  if ("files" in prep) prep.abort();
  safe("prepareStaged copies beside the destination without replacing it; abort removes the copies, the published file unchanged",
    () => prepped && fs.readFileSync(path.join(dir, "Plots__1_1-dialog.png"), "utf8") === "png bytes" && !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  // done validates BEFORE it publishes — and validates the staged measured file when the stage holds one
  fs.writeFileSync(path.join(stage, "Plots__1_1.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), nodes: [] }));
  fs.writeFileSync(path.join(stage, "Plots__1_1-hover.png"), "hover");
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir));
  const bad = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId, "--publish", stage);
  safe("done --publish with a staged measured file taken against another expectation → refused, NOTHING copied", () => bad.status === 1 && /measured against expectation/.test(bad.stderr)
    && !fs.existsSync(path.join(dir, "Plots__1_1-hover.png")) && fs.readFileSync(path.join(dir, "Plots__1_1-dialog.png"), "utf8") === "png bytes");
  fs.writeFileSync(path.join(stage, "Plots__1_1.measured.json"), measuredFor(dir, { runId }));
  const ok = cli("--status", "Plots__1_1", "--phase", "done", "--run", runId, "--publish", stage);
  const fin = readStatusFile(live);
  safe("…a good staged measured file → done: published, measuredSha256 = the staged (now published) file", () => ok.status === 0 && fin?.phase === "done" && fs.existsSync(path.join(dir, "Plots__1_1-hover.png"))
    && fin.measuredSha256 === sha(path.join(dir, "Plots__1_1.measured.json")) && fin.measuredSha256 === sha(path.join(stage, "Plots__1_1.measured.json")));
  safe("evidence published in this run is hashed at done", () => fin?.evidenceSha256 === sha(path.join(dir, "Plots__1_1.evidence.json")));
});

console.log("[tool-owned] --publish and a variant set's files:");
await block("[tool-owned] --publish and a variant set's files:", async () => {
  const dest = path.join(mk("dt-run-owned-"), "verify");
  fs.mkdirSync(dest);
  // TOOL_OWNED is anchored at the end: a variant `<stem>.<slug>` set's expected/report/status/prev files are refused like the base set's
  for (const t of ["expected.json", "report.json", "report.md", "status.json", "expected.prev.json"]) {
    const stage = mk("dt-run-owned-stage-");
    fs.writeFileSync(path.join(stage, `Plots__1_1.w320-dialog.${t}`), "{}");
    const r = VR.prepareStaged(stage, dest);
    safe(`[tool-owned] a staged Plots__1_1.w320-dialog.${t} → refused, nothing copied`, () => "error" in r && r.error.includes(`Plots__1_1.w320-dialog.${t}`) && !fs.readdirSync(dest).length);
  }
  const stage = mk("dt-run-owned-stage-");
  const own = ["Plots__1_1.w320-dialog.measured.json", "Plots__1_1.w320-dialog.png", "Plots__1_1.w320-dialog-dialog.png", "Plots__1_1.w320-dialog-diff.png", "Plots__1_1.dark.evidence.json"];
  for (const f of own) fs.writeFileSync(path.join(stage, f), "x");
  const r = VR.publishStaged(stage, dest);
  safe(`[tool-owned] its measured file, screenshots, a state's -dialog.png, its -diff.png and evidence → published (got ${JSON.stringify(r)})`, () => "published" in r && JSON.stringify(r.published) === JSON.stringify([...own].sort()));
});

// `--phase measured` is the probe's recovery when its own `measured` write was refused — it records the measured
// file's sha after the same checks done applies, so compare and done can tell the file apart from a later one
console.log("--status --phase measured — the recovery records the measured file:");
await block("--status --phase measured:", async () => {
  const { dir, base, live, cli } = project();
  cli("--status", "Plots__1_1", "--phase", "measuring", "--run", "run-r");
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-r" }));
  const m = cli("--status", "Plots__1_1", "--phase", "measured", "--run", "run-r");
  const st = readStatusFile(live);
  safe("measured with the right file → exit 0; the status names its measuredSha256 and expectationSha256", () => m.status === 0 && st?.phase === "measured"
    && st.measuredSha256 === sha(path.join(dir, "Plots__1_1.measured.json")) && st.expectationSha256 === sha(path.join(dir, "Plots__1_1.expected.json")));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-r", nodes: [{ nodeId: "9:9", styles: {} }] }));
  const d = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-r");
  safe("…the file changed after that record → done refused 'recorded measured file', exit 1", () => d.status === 1 && /recorded measured file/.test(d.stderr));
  const { dir: dir2, base: base2, live: live2, cli: cli2 } = project();
  cli2("--status", "Plots__1_1", "--phase", "measuring", "--run", "run-s");
  fs.writeFileSync(path.join(dir2, "Plots__1_1.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), runId: "run-s", nodes: [] }));
  const x1 = cli2("--status", "Plots__1_1", "--phase", "measured", "--run", "run-s");
  safe("measured with a file taken against another expectation → refused, exit 1, the status unchanged", () => x1.status === 1 && /measured against expectation 000000000000…/.test(x1.stderr) && readStatusFile(live2)?.phase === "measuring");
  fs.writeFileSync(path.join(dir2, "Plots__1_1.measured.json"), measuredFor(dir2, { runId: "run-other" }));
  const x2 = cli2("--status", "Plots__1_1", "--phase", "measured", "--run", "run-s");
  safe("measured with a file of another run → refused, exit 1", () => x2.status === 1 && /measured in run run-other/.test(x2.stderr));
  fs.rmSync(path.join(dir2, "Plots__1_1.measured.json"));
  safe("measured with no measured file → refused, exit 1", () => cli2("--status", "Plots__1_1", "--phase", "measured", "--run", "run-s").status === 1);
  // the probe wrote into the run's stage dir (--out <stage>/Plots__1_1): that file is the one recorded
  const stage = VR.stageDirOf(base2, "run-s");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "Plots__1_1.measured.json"), measuredFor(dir2, { runId: "run-s" }));
  const x3 = cli2("--status", "Plots__1_1", "--phase", "measured", "--run", "run-s");
  safe("…a measured file in the run's stage dir → recorded (its sha)", () => x3.status === 0 && readStatusFile(live2)?.measuredSha256 === sha(path.join(stage, "Plots__1_1.measured.json")));
  void base;
});

// the pre-publish check is a real write — a sandbox can refuse creating a file where access(W_OK) says yes
console.log("the pre-publish writability check is a real write:");
await block("pre-publish write probe:", async () => {
  const hasSeatbelt = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
  if (!hasSeatbelt) { console.log("  (skipped: needs macOS sandbox-exec)"); return; }
  const { dir, base, live, cwd } = project();
  const cache = path.dirname(live);
  fs.mkdirSync(cache, { recursive: true });
  const stage = mk("dt-run-seatbelt-stage-");
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir));
  fs.writeFileSync(path.join(stage, "Plots__1_1-hover.png"), "hover");
  // file-write-create denied in the run cache: access(W_OK) on it still succeeds, creating a file there does not
  const profile = `(version 1)(allow default)(deny file-write-create (subpath ${JSON.stringify(fs.realpathSync(cache))}))`;
  const probeAccess = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", 'require("fs").accessSync(process.argv[1], 2)', cache], { encoding: "utf8" });
  if (probeAccess.status !== 0) { console.log(`  (skipped: sandbox-exec unavailable here or access() refused too: ${probeAccess.stderr.split("\n")[0]})`); return; }
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, VS_TS, "--status", "Plots__1_1", "--phase", "done", "--run", "run-sb", "--publish", stage], { cwd, encoding: "utf8" });
  safe("[write probe] done --publish where the run cache refuses file creation (access(W_OK) still ok) → exit 6 BEFORE publishing: nothing copied into design/verify", () =>
    r.status === 6 && /is not writable/.test(r.stderr) && !fs.existsSync(path.join(dir, "Plots__1_1-hover.png")) && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
  safe("[write probe] …and no probe file is left in the run cache", () => !fs.readdirSync(cache).some((f) => f.startsWith(".w-")));
  void base;
});

// the run cache vanished (node_modules removed / reinstalled mid-run) — its own sentence, still exit 6
console.log("a run cache that disappeared:");
await block("a run cache that disappeared:", async () => {
  const cwd = mk("dt-run-gone-");
  fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd, "design", "verify"), { recursive: true });
  // node_modules mid-reinstall: a link to a directory that is gone — every write under it is ENOENT (POSIX), ENOTDIR (Bun's
  // mkdir on Windows)
  fs.symlinkSync(path.join(cwd, "gone-node-modules"), path.join(cwd, "node_modules"));
  const r = runSync(process.execPath, [VS_TS, "--status", "Plots__1_1", "--phase", "queued", "--new-run"], { cwd });
  safe("--status into a run cache that no longer exists → exit 6, 'run cache <dir> disappeared — was node_modules reinstalled during the run?', not 'not writable'", () =>
    r.status === 6 && /run cache \S+ disappeared — was node_modules reinstalled during the run\?/.test(r.stderr) && !/not writable/.test(r.stderr) && !/\n\s+at /.test(r.stderr));
  if (r.status !== 6) console.log(`    (exit ${String(r.status)}; stderr: ${r.stderr.trim()})`);
  // a node_modules that is a FILE: mkdir through it is ENOTDIR on every platform — the errno Bun's mkdir gives on Windows
  // for the dangling link above (the link is there, and it is not a directory), so this is that case on every OS
  const cwd2 = mk("dt-run-gone-file-");
  fs.writeFileSync(path.join(cwd2, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd2, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(cwd2, "node_modules"), "");
  const f = runSync(process.execPath, [VS_TS, "--status", "Plots__1_1", "--phase", "queued", "--new-run"], { cwd: cwd2 });
  safe("…a node_modules that is a file (ENOTDIR) → the same exit 6 and sentence, not a raw ENOTDIR (exit 1)", () =>
    f.status === 6 && /run cache \S+ disappeared — was node_modules reinstalled during the run\?/.test(f.stderr) && !/ENOTDIR|not writable/.test(f.stderr));
  if (f.status !== 6) console.log(`    (exit ${String(f.status)}; stderr: ${f.stderr.trim()})`);
  safe("the class says the same for ENOENT and ENOTDIR; a permission refusal keeps 'not writable (sandbox write scope?)'", () =>
    ["ENOENT", "ENOTDIR"].every((c) => /disappeared — was node_modules reinstalled/.test(new VR.RunCacheUnwritable("/c", "/r", c).message))
    && /not writable \(sandbox write scope\?\)/.test(new VR.RunCacheUnwritable("/c", "/r", "EACCES").message));
});

// `.git` as a FILE (a submodule / worktree checkout) is a repo boundary too; --wait before the cache exists
console.log("a .git file is a boundary; --wait before any run cache exists:");
await block(".git file / --wait with no cache:", async () => {
  const outer = mk("dt-run-sub-");
  fs.writeFileSync(path.join(outer, "package.json"), "{\"name\":\"plots-outer\",\"private\":true}\n");
  fs.mkdirSync(path.join(outer, "node_modules"));
  const sub = path.join(outer, "plots-native");
  fs.mkdirSync(path.join(sub, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/plots-native\n");
  const subLive = VR.liveStatusFile(path.join(sub, "design", "verify", "Plots__1_1"));
  safe("a submodule (.git is a file) with no package.json inside → the OS temp dir, never the package.json above it", () => inTmpDir(subLive));
  tmps.push(path.dirname(subLive));
  const { cwd, live } = project();
  const t0 = Date.now();
  const w = runSync(process.execPath, [VS_TS, "--wait", "Plots__1_1", "--run", "run-none", "--timeout", "0.5", "--interval", "0.1"], { cwd });
  safe("--wait before any run cache exists → keeps waiting and ends on --timeout (exit 5), not 'not readable' (6)", () =>
    !fs.existsSync(path.dirname(live)) && w.status === 5 && /timed out after 0.5s/.test(w.stderr) && Date.now() - t0 >= 400);
});

// printed commands run as printed from a project whose path holds a space
console.log("printed commands quote their paths:");
await block("printed commands quote paths:", async () => {
  if (POSIX_SH === null) { console.log("  (skipped: no sh on PATH — the printed commands are POSIX-shell quoted, run through Git Bash on Windows)"); return; }
  const sh = POSIX_SH;
  const cwd = mk("dt run space-");
  fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd, "node_modules"));
  const dir = path.join(cwd, "design", "verify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Plots__1_1.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "1:1", name: "Plots" }, nodes: [] }, null, 2) + "\n");
  const cli = (...a: string[]) => runSync(process.execPath, [VS_TS, ...a], { cwd: os.tmpdir() });
  const s = cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-q", "--dir", dir);
  const stageLine = /^stage {2}(.+)$/m.exec(s.stderr)?.[1] ?? "";
  const echoed = spawnSync(sh, ["-c", `printf %s ${stageLine}`], { encoding: "utf8" }).stdout;
  safe("--status prints the stage dir as one shell word (the path holds a space)", () => s.status === 0 && echoed === VR.stageDirOf(path.join(dir, "Plots__1_1"), "run-q"));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-q" }));
  cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-q", "--dir", dir);
  const w = cli("--wait", "Plots__1_1", "--run", "run-q", "--dir", dir, "--timeout", "5", "--interval", "0.1");
  const ran = spawnSync(sh, ["-c", w.stdout.trim()], { cwd: os.tmpdir(), encoding: "utf8" });
  safe("--wait's printed --compare runs as printed from another directory (exit 0/1, the report written beside the measured file)", () =>
    w.status === 0 && (ran.status === 0 || ran.status === 1) && fs.existsSync(path.join(dir, "Plots__1_1.report.json")));
});

// an ended run stays ended — a write after done/failed/blocked would replace its phase and detail
console.log("verify-screen --status — a run that ended takes no more writes:");
await block("verify-screen --status after an ended run:", async () => {
  const { dir, live, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir));
  cli("--status", "Plots__1_1", "--phase", "measured", "--run", "run-blk");
  cli("--status", "Plots__1_1", "--phase", "blocked", "--run", "run-blk", "--detail", "blocked on permissions: compare remaining");
  const before = fs.readFileSync(live, "utf8");
  const stage = mk("dt-run-endstage-");
  fs.writeFileSync(path.join(stage, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [] }));
  const d1 = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-blk", "--by", "orchestrator", "--publish", stage);
  safe("blocked → done in the same run: exit 2, 'run <id> already ended at blocked (<detail>) — start a new run with --new-run'", () => d1.status === 2
    && d1.stderr.includes("run run-blk already ended at blocked (blocked on permissions: compare remaining) — start a new run with --new-run"));
  safe("…the status is unchanged (still blocked, same rev and detail), nothing published into design/verify", () => fs.readFileSync(live, "utf8") === before
    && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")) && !fs.existsSync(path.join(dir, "Plots__1_1.evidence.json")));
  cli("--status", "Plots__1_1", "--phase", "failed", "--run", "run-fld", "--detail", "renderer gone");
  const d2 = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-fld");
  safe("failed → done in the same run: exit 2, names the failed phase and its detail; status stays failed", () => d2.status === 2
    && d2.stderr.includes("run run-fld already ended at failed (renderer gone)") && readStatusFile(live)?.phase === "failed");
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-dn" }));
  cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-dn");
  const doneDoc = fs.readFileSync(live, "utf8");
  const d3 = cli("--status", "Plots__1_1", "--phase", "measuring", "--run", "run-dn");
  safe("done → measuring in the same run: exit 2 'already ended at done — start a new run'; the done status is unchanged", () => d3.status === 2
    && d3.stderr.includes("run run-dn already ended at done — start a new run with --new-run") && fs.readFileSync(live, "utf8") === doneDoc);
  cli("--status", "Plots__1_1", "--phase", "blocked", "--run", "run-blk2", "--detail", "blocked again");
  const n = cli("--status", "Plots__1_1", "--phase", "starting", "--new-run");
  safe("…a new run after a blocked one is written (exit 0, rev 1, phase starting)", () => n.status === 0 && /^run \S+ rev 1$/m.test(n.stdout) && readStatusFile(live)?.phase === "starting");
  // the refusal lives in writeStatus itself — a writer that checked at its start (the probe, whose
  // `measured` write comes up to its time budget later) cannot reopen a run that was ended meanwhile.
  const base = path.join(dir, "Plots__1_1");
  VR.writeStatus(base, { runId: "run-late", phase: "measuring", by: "verify-probe" });
  VR.writeStatus(base, { runId: "run-late", phase: "failed", by: "orchestrator", detail: "verifier gone" });
  const failedDoc = fs.readFileSync(live, "utf8");
  let late: unknown = null;
  try { VR.writeStatus(base, { runId: "run-late", phase: "measured", by: "verify-probe", measuredSha256: "0".repeat(64) }); } catch (e) { late = e; }
  // pre-change: fails — the late write returned rev 3, phase measured
  safe("writeStatus refuses a late write to an ended run (RunEnded naming the phase and detail); the failed status is unchanged",
    () => late instanceof VR.RunEnded && late.message.startsWith("run run-late already ended at failed (verifier gone)") && fs.readFileSync(live, "utf8") === failedDoc);
  safe("…a write for another run id still goes through", () => VR.writeStatus(base, { runId: "run-next", phase: "starting", by: "agent" }).rev === 1);
});

// a --status write of a named run (--run, or the inferred run in progress) never lands over ANOTHER run that has not ended
console.log("verify-screen --status — never over another open run (without --new-run):");
await block("verify-screen --status vs another open run:", async () => {
  const { dir, base, live, cli } = project();
  const absDir = path.resolve(dir); // passed as --dir: the printed commands name it as given
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 999_999; // an exited child's pid (no output read)
  const own = (pid: number): VR.OwnRunStamp => ({ pid, host: os.hostname(), ...(PID_NS ? { ns: PID_NS } : {}), startedAt: "2026-10-15T08:00:00.000Z", deadline: "2999-01-01T00:00:00.000Z" });
  // a probe printed the recovery for run-a; another probe took run-a over and run-b measures now
  VR.writeStatus(base, { runId: "run-b", phase: "measuring", by: "verify-probe", ownRun: own(process.pid) }, { alone: true });
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-a" }));
  const openDoc = fs.readFileSync(live, "utf8");
  const late = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-a", "--dir", absDir);
  const endB = `${scriptCmd("verify-screen")} --status Plots__1_1 --phase failed --run run-b --dir ${shellArg(absDir)}`;
  safe("the recovery `--phase done --run run-a` run after run-b (a probe's own run, its probe alive) started → exit 2 'run run-a is not the current run of Plots__1_1: run run-b is a probe's own run (…)' — when, by which pid, how to end it, no --wait; nothing written or published", () =>
    late.status === 2 && late.stderr.trimEnd() === `run run-a is not the current run of Plots__1_1: run run-b is a probe's own run (no --run), started at 2026-10-15T08:00:00.000Z by pid ${process.pid} on ${os.hostname()} ` +
      `and still open (phase measuring) — nothing is written; if no probe is running, end it: ${endB}`
      && !/--wait/.test(late.stderr) && fs.readFileSync(live, "utf8") === openDoc && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
  if (late.status !== 2) console.log(`    exit ${String(late.status)}: ${String(late.stderr).slice(0, 400)}`);
  fs.rmSync(path.join(dir, "Plots__1_1.measured.json"));
  const before = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-a");
  safe("…said before the measured-file checks (no measured file: still exit 2, not 1)", () => before.status === 2 && /is not the current run/.test(before.stderr) && !/does not exist/.test(before.stderr));
  // a verifier's open run V, then an end-it hint for an older run run late
  VR.writeStatus(base, { runId: "run-b", phase: "failed", by: "verify-probe" });
  VR.writeStatus(base, { runId: "run-v", phase: "driving", by: "agent" });
  const vDoc = fs.readFileSync(live, "utf8");
  const endLate = cli("--status", "Plots__1_1", "--phase", "failed", "--run", "run-old", "--dir", absDir);
  safe("an end-it hint (`--phase failed --run run-old`) run while a verifier's run-v is open → exit 2 'run run-old is not the current run of Plots__1_1: run run-v is open (…)' with how to wait for / end it; run-v's status byte-identical", () =>
    endLate.status === 2 && endLate.stderr.includes("run run-old is not the current run of Plots__1_1: run run-v is open (phase driving, rev 1, by agent, ")
      && endLate.stderr.includes(`nothing is written; wait for it (${scriptCmd("verify-screen")} --wait Plots__1_1 --run run-v --dir ${shellArg(absDir)})`)
      && endLate.stderr.trimEnd().endsWith(`end it (${scriptCmd("verify-screen")} --status Plots__1_1 --phase failed --run run-v --dir ${shellArg(absDir)})`)
      && fs.readFileSync(live, "utf8") === vDoc);
  const mine = cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-v", "--detail", "heartbeat");
  safe("…the verifier's own --run writes go on in run-v: exit 0, rev 2", () => mine.status === 0 && mine.stdout.trim() === "run run-v rev 2");
  const queued = cli("--status", "Plots__1_1", "--phase", "queued", "--new-run", "--by", "orchestrator");
  safe("…--new-run still starts a run over it (the orchestrator's queued run): exit 0, rev 1", () => queued.status === 0 && /^run \S+ rev 1$/m.test(queued.stdout) && readStatusFile(live)?.phase === "queued");
  const qId = readStatusFile(live)?.runId ?? "";
  // an abandoned own run (its probe's pid is gone) is open too: only a probe's own run ends it as abandoned
  VR.writeStatus(base, { runId: qId, phase: "failed", by: "orchestrator" });
  VR.writeStatus(base, { runId: "run-dead", phase: "measuring", by: "verify-probe", ownRun: own(deadPid) });
  const overDead = cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-x", "--dir", absDir);
  safe("another probe's own run left open by a probe that is gone → refused the same way (no abandoned exemption), in own-run wording that says its probe is gone (no --wait); it stays measuring", () =>
    overDead.status === 2 && overDead.stderr.trimEnd() === `run run-x is not the current run of Plots__1_1: run run-dead is a probe's own run (no --run), started at 2026-10-15T08:00:00.000Z by pid ${deadPid} ` +
      `on ${os.hostname()} and still open (phase measuring), but the probe that started it is gone — nothing is written; if no probe is running, end it: ` +
      `${scriptCmd("verify-screen")} --status Plots__1_1 --phase failed --run run-dead --dir ${shellArg(absDir)}`
      && readStatusFile(live)?.runId === "run-dead" && readStatusFile(live)?.phase === "measuring");
  safe("…one whose probe's pid runs but is past its deadline → 'but the probe that started it is past the run's deadline <deadline>' (no --wait)", () => {
    const st = VR.readStatus(base);
    const pastDue = st !== null && st !== "v1" ? { ...st, ownRun: { ...own(process.pid), deadline: "2026-01-01T00:00:00.000Z" } } : null;
    const e = VR.notCurrentRun(base, pastDue, "run-x");
    return e !== null && e.message.includes(`run run-dead is a probe's own run (no --run), started at 2026-10-15T08:00:00.000Z by pid ${process.pid} on ${os.hostname()} and still open (phase measuring), ` +
      "but the probe that started it is past the run's deadline 2026-01-01T00:00:00.000Z — nothing is written; if no probe is running, end it: ") && !/--wait/.test(e.message);
  });
  // an ended run, or no status: the measured-file recovery after its run's status ended still records
  VR.writeStatus(base, { runId: "run-dead", phase: "failed", by: "agent" });
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-r" }));
  const rec = cli("--status", "Plots__1_1", "--phase", "measured", "--run", "run-r");
  safe("over another run that ended (failed) → the `--phase measured --run run-r` recovery is written: exit 0, rev 1", () => rec.status === 0 && rec.stdout.trim() === "run run-r rev 1");
  safe("notCurrentRun: the one refusal — another v2 run not ended (abandoned included); never the run itself, an ended run, a v1 file or no status", () => {
    const st = VR.readStatus(base);
    const openSt = st !== null && st !== "v1" ? { ...st, phase: "measuring" as const, ownRun: own(deadPid) } : null;
    return openSt !== null && VR.notCurrentRun(base, openSt, "run-other") instanceof VR.RunNotCurrent && VR.abandonedRun(openSt, "run-other") !== null
      && VR.notCurrentRun(base, openSt, "run-r") === null && VR.notCurrentRun(base, { ...openSt, phase: "done" }, "run-other") === null
      && VR.notCurrentRun(base, "v1", "run-other") === null && VR.notCurrentRun(base, null, "run-other") === null;
  });

  // another run starts between --status's own read and its write (a takeover of the run it continues): refused under the lock
  const takeOver = (): void => { VR.writeStatus(base, { runId: "run-t", phase: "measuring", by: "verify-probe", ownRun: own(process.pid) }, { alone: true, abandoned: () => {} }); };
  const race = (flags: VR.StatusFlags, start: () => void): { code: number; err: string; took: boolean } => {
    const errs: string[] = [];
    let took = false;
    const rm = fs.rmSync;
    // the cache write check's probe file is removed after statusRun's read, before writeStatus: take the run over there
    Reflect.set(fs, "rmSync", (p: fs.PathLike, o?: fs.RmOptions): void => {
      rm(p, o);
      if (!took && path.basename(String(p)) === `.w-${process.pid}`) {
        took = true;
        start();
      }
    });
    const logErr = console.error, logOut = console.log;
    console.error = (...a: unknown[]): void => { errs.push(a.map(String).join(" ")); };
    console.log = (): void => {};
    let code: number;
    try { code = VR.statusMain("Plots__1_1", { ...flags, dir }, "usage"); }
    finally { Reflect.set(fs, "rmSync", rm); console.error = logErr; console.log = logOut; }
    return { code, err: errs.join("\n"), took };
  };
  VR.writeStatus(base, { runId: "run-r", phase: "failed", by: "agent" });
  VR.writeStatus(base, { runId: "run-c", phase: "measuring", by: "verify-probe", ownRun: own(deadPid) });
  const inferred = race({ phase: "driving" }, takeOver);
  const tDoc = readStatusFile(live);
  safe("no --run: the run in progress (run-c) is taken over after --status read it → exit 2 'run run-c is not the current run of Plots__1_1: run run-t is a probe's own run'; run-t's status untouched (rev 1, measuring)", () =>
    inferred.took && inferred.code === 2 && inferred.err.includes(`run run-c is not the current run of Plots__1_1: run run-t is a probe's own run (no --run), started at 2026-10-15T08:00:00.000Z by pid ${process.pid} on ${os.hostname()} and still open (phase measuring) — `)
      && tDoc?.runId === "run-t" && tDoc.rev === 1 && tDoc.phase === "measuring");
  if (inferred.code !== 2) console.log(`    exit ${inferred.code}: ${inferred.err.slice(0, 300)}`);
  VR.writeStatus(base, { runId: "run-t", phase: "failed", by: "agent" });
  VR.writeStatus(base, { runId: "run-n", phase: "driving", by: "agent" });
  // an orchestrator queues a new run (--new-run) after this --status checked run-n
  const named = race({ phase: "failed", run: "run-n" }, () => { VR.writeStatus(base, { runId: "run-q", phase: "queued", by: "orchestrator" }); });
  safe("--run run-n: another run opens after --status checked → refused under the lock the same way (exit 2), run-q's status untouched", () =>
    named.took && named.code === 2 && named.err.includes("run run-n is not the current run of Plots__1_1: run run-q is open (phase queued, rev 1, ")
      && readStatusFile(live)?.runId === "run-q" && readStatusFile(live)?.phase === "queued");
});

// ---------------------------------------------------------------- one status writer at a time (<live status>.lock)
console.log("writeStatus — locked; before/after hooks; a run that ended gets no files:");
await block("writeStatus locked:", async () => {
  const { dir, base, live } = project();
  VR.writeStatus(base, { runId: "run-h", phase: "measuring", by: "verify-probe" });
  const order: string[] = [];
  const doc = VR.writeStatus(base, { runId: "run-h", phase: "measured", by: "verify-probe" }, {
    before: () => { order.push(`before:${fs.existsSync(VR.lockFileOfStatus(base)) ? "locked" : "unlocked"}`); fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), "{}"); return { measuredSha256: "a".repeat(64) }; },
    after: (d) => { order.push(`after:rev${d.rev}:${readStatusFile(live)?.phase ?? "?"}:${fs.existsSync(VR.lockFileOfStatus(base)) ? "locked" : "unlocked"}`); },
  });
  safe("before runs under the lock, ahead of the record; its measuredSha256 is recorded; after sees the written doc, still locked; the lock is gone after",
    () => order.join(" ") === "before:locked after:rev2:measured:locked" && doc.measuredSha256 === "a".repeat(64) && readStatusFile(live)?.measuredSha256 === "a".repeat(64) && !fs.existsSync(VR.lockFileOfStatus(base)));
  const unchanged = fs.readFileSync(live, "utf8");
  const thrown = ((): unknown => { try { VR.writeStatus(base, { runId: "run-h", phase: "measured", by: "verify-probe" }, { before: () => { throw new Error("disk full"); } }); return null; } catch (e) { return e; } })();
  safe("a throw in before → thrown as it is, no record written, the lock released", () => thrown instanceof Error && thrown.message === "disk full" && fs.readFileSync(live, "utf8") === unchanged && !fs.existsSync(VR.lockFileOfStatus(base)));
  VR.writeStatus(base, { runId: "run-h", phase: "failed", by: "orchestrator", detail: "gave up" });
  const failedDoc = fs.readFileSync(live, "utf8");
  let beforeRan = false, afterRan = false;
  const ended = ((): unknown => { try { VR.writeStatus(base, { runId: "run-h", phase: "measured", by: "verify-probe" }, { before: () => { beforeRan = true; return {}; }, after: () => { afterRan = true; } }); return null; } catch (e) { return e; } })();
  safe("a run that ended → RunEnded before anything: before and after never run (the probe's files are not written), the status unchanged",
    () => ended instanceof VR.RunEnded && !beforeRan && !afterRan && fs.readFileSync(live, "utf8") === failedDoc && !fs.existsSync(VR.lockFileOfStatus(base)));
  safe("endedRun: the one refusal — for the same run at done/failed/blocked only", () => {
    const st = VR.readStatus(base);
    const e = VR.endedRun(st, "run-h");
    return e instanceof VR.RunEnded && e.message === "run run-h already ended at failed (gave up) — start a new run with --new-run"
      && VR.endedRun(st, "run-other") === null && VR.endedRun("v1", "run-h") === null && VR.endedRun(null, "run-h") === null;
  });
  // the lock is broken and taken by another writer while this one runs its before hook: no record over theirs
  VR.writeStatus(base, { runId: "run-lost", phase: "measuring", by: "verify-probe" });
  const beforeLost = fs.readFileSync(live, "utf8");
  const other = JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), token: "0123456789abcdef", ns: PID_NS });
  const lost = ((): unknown => { try { VR.writeStatus(base, { runId: "run-lost", phase: "measured", by: "verify-probe" }, { before: () => { fs.writeFileSync(VR.lockFileOfStatus(base), other); return {}; } }); return null; } catch (e) { return e; } })();
  safe("the status lock taken by another writer during the write → LockLost (a LockBusy), no record written, the other writer's lock left",
    () => lost instanceof LockLost && lost instanceof LockBusy && fs.readFileSync(live, "utf8") === beforeLost && fs.readFileSync(VR.lockFileOfStatus(base), "utf8") === other);
  fs.rmSync(VR.lockFileOfStatus(base));
  // a lock left by a writer that was killed mid-write (its pid is gone) does not wedge the run
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 999_999; // an exited child's pid (no output read)
  fs.writeFileSync(VR.lockFileOfStatus(base), JSON.stringify({ pid: deadPid, host: os.hostname(), at: Date.now(), token: "0123456789abcdef", ns: PID_NS }));
  const s = runSync(process.execPath, [VS_TS, "--status", "Plots__1_1", "--phase", "starting", "--new-run"], { cwd: path.dirname(path.dirname(dir)) });
  safe("a lock left by a killed writer (dead pid) → the next --status breaks it and writes (exit 0), no lock left", () => s.status === 0 && readStatusFile(live)?.phase === "starting" && !fs.existsSync(VR.lockFileOfStatus(base)));
});

// the probe's own run (no --run): it must be the screen's only open run — refused under the lock beside another
console.log("writeStatus alone — a run of its own never writes beside another open run:");
await block("writeStatus alone:", async () => {
  const { dir, base, live } = project();
  const id = VR.newRunId();
  safe("newRunId: a sortable time + randomness id, safe as a run id (letters, digits, . : _ -), a new one per call", () => /^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id) && VR.newRunId() !== id);
  VR.writeStatus(base, { runId: "run-v", phase: "driving", by: "agent", detail: "the verifier drives" });
  const verifierDoc = fs.readFileSync(live, "utf8");
  let beforeRan = false, afterRan = false;
  const open = ((): unknown => { try { VR.writeStatus(base, { runId: id, phase: "measuring", by: "verify-probe" }, { alone: true, before: () => { beforeRan = true; return {}; }, after: () => { afterRan = true; } }); return null; } catch (e) { return e; } })();
  const absDir = path.resolve(dir);
  safe("another run open (driving) → RunOpen before anything: before/after never run, the verifier's status unchanged, the lock released; the message names that run and how to wait for / end it",
    () => open instanceof VR.RunOpen && !beforeRan && !afterRan && fs.readFileSync(live, "utf8") === verifierDoc && !fs.existsSync(VR.lockFileOfStatus(base))
      && open.message.startsWith("run run-v of Plots__1_1 is open (phase driving, rev 1, by agent, ")
      && open.message.includes(`that run's verifier passes --run run-v; anyone else waits for it (`) && open.message.includes(`--wait Plots__1_1 --run run-v --dir ${shellArg(absDir)})`)
      && open.message.endsWith(`--status Plots__1_1 --phase failed --run run-v --dir ${shellArg(absDir)})`));
  safe("…the same write without `alone` (a --run write, --new-run) still goes through as before", () => VR.writeStatus(base, { runId: "run-w", phase: "queued", by: "orchestrator" }).rev === 1);
  VR.writeStatus(base, { runId: "run-w", phase: "blocked", by: "agent", detail: "denied" });
  const own = VR.writeStatus(base, { runId: id, phase: "measuring", by: "verify-probe" }, { alone: true });
  const own2 = VR.writeStatus(base, { runId: id, phase: "done", by: "verify-probe", measuredSha256: "b".repeat(64) }, { alone: true });
  safe("an ended run beside it (blocked) → its own run starts at rev 1 and its later writes go on (its own open run is not 'another')", () => own.rev === 1 && own.runId === id && own2.rev === 2 && own2.phase === "done"
    && readStatusFile(live)?.runId === id);
  safe("openRun: the one refusal — another v2 run not ended; never for the run itself, an ended run, a v1 file or no status", () => {
    const st = VR.readStatus(base);
    const openSt = st !== null && st !== "v1" ? { ...st, phase: "measuring" as const } : null;
    return openSt !== null && VR.openRun(base, openSt, "run-other") instanceof VR.RunOpen && VR.openRun(base, openSt, id) === null
      && VR.openRun(base, st, "run-other") === null && VR.openRun(base, "v1", "run-other") === null && VR.openRun(base, null, "run-other") === null;
  });
});

// writers in separate processes: every write gets its own rev (no two writers read the same previous status)
console.log("status writers in separate processes:");
await block("concurrent status writers:", async () => {
  const { base, live } = project();
  VR.writeStatus(base, { runId: "run-cc", phase: "starting", by: "agent" });
  const N = 4, K = 15;
  const outs = await Promise.all(Array.from({ length: N }, (_, w) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, [LOCK_CHILD, "status", base, `w${w}`, String(K)]);
    let out = "", err = "";
    p.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    p.on("close", (code) => resolve({ code, out, err }));
  })));
  const revs = outs.flatMap((o) => o.out.split(",").filter(Boolean).map(Number));
  const final = readStatusFile(live);
  safe(`${N} processes × ${K} writes of one run → revs 2…${N * K + 1}, each written once; the file ends at rev ${N * K + 1}`, () =>
    outs.every((o) => o.code === 0) && revs.length === N * K && new Set(revs).size === N * K && Math.min(...revs) === 2 && Math.max(...revs) === N * K + 1 && final?.rev === N * K + 1);
  if (!outs.every((o) => o.code === 0)) console.log(`    ${outs.map((o) => o.err.split("\n")[0]).join(" | ")}`);
});

// Another writer (a separate process) that holds the status lock of `base` once `ready` exists, and on end() ends the
// run (failed, "gave up") under it and releases — so a writer started meanwhile waits on the lock, then sees the end.
async function lockHolder(base: string): Promise<{ end(): void; done: Promise<number | null> }> {
  const sig = mk("dt-run-race-sig-");
  const ready = path.join(sig, "ready"), go = path.join(sig, "go");
  const ender = spawn(process.execPath, [LOCK_CHILD, "end-run", base, ready, go]);
  const done = new Promise<number | null>((resolve) => ender.on("close", resolve));
  for (const t0 = Date.now(); !fs.existsSync(ready) && Date.now() - t0 < 10_000;) await sleep(20);
  return { end: () => fs.writeFileSync(go, ""), done };
}

// the run ends while a `done --publish` waits for the status lock (after its own checks, its files staged beside
// design/verify): the write is refused under the lock, nothing is published
console.log("--status done --publish while another writer ends the run:");
await block("done --publish vs an ending run:", async () => {
  const { cwd, dir, base, live } = project();
  VR.writeStatus(base, { runId: "run-race", phase: "driving", by: "agent" });
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-race" }));
  const stage = mk("dt-run-race-stage-");
  fs.writeFileSync(path.join(stage, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [] }));
  const holder = await lockHolder(base);
  let err = "";
  const cli = spawn(process.execPath, [VS_TS, "--status", "Plots__1_1", "--phase", "done", "--run", "run-race", "--publish", stage], { cwd });
  cli.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const cliDone = new Promise<number | null>((resolve) => cli.on("close", resolve));
  // the CLI has passed its checks and staged its copies beside design/verify: it now waits on the lock
  let staged = false;
  for (const t0 = Date.now(); !staged && Date.now() - t0 < 10_000;) { staged = fs.readdirSync(dir).some((f) => f.includes(".tmp-")); if (!staged) await sleep(10); }
  holder.end();
  const [code] = await Promise.all([cliDone, holder.done]);
  safe("the CLI got past its own ended-run check and staged its copies before the run ended (the race is real here)", () => staged);
  safe("…the run ended under the lock first → exit 2 'already ended at failed (gave up)'", () => code === 2 && err.includes("run run-race already ended at failed (gave up)"));
  safe("…nothing published: no evidence, no durable status, no staged tmp left in design/verify; the status stays failed", () =>
    !fs.existsSync(path.join(dir, "Plots__1_1.evidence.json")) && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")) && !fs.readdirSync(dir).some((f) => f.includes(".tmp-")) && readStatusFile(live)?.phase === "failed");
});

// --publish moves its files into design/verify inside the status write's lock, after the record: a writer that takes
// the lock next (another run starting) sees them already published, never published under its own run
console.log("--status done --publish — the publish commit is inside the status lock, after the record:");
await block("publish commit under the lock:", () => {
  const { dir, base, live } = project();
  VR.writeStatus(base, { runId: "run-pub", phase: "driving", by: "agent" });
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-pub" }));
  const stage = mk("dt-run-pub-stage-");
  fs.writeFileSync(path.join(stage, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [] }));
  const dest = path.join(dir, "Plots__1_1.evidence.json");
  const seen: string[] = [];
  const rename = fs.renameSync;
  Reflect.set(fs, "renameSync", (from: string, to: string): void => {
    if (path.resolve(String(to)) === path.resolve(dest)) seen.push(`${fs.existsSync(VR.lockFileOfStatus(base)) ? "locked" : "unlocked"}:${readStatusFile(live)?.phase ?? "?"}`);
    rename(from, to);
  });
  let code: number;
  const errs: string[] = [];
  const logErr = console.error, logOut = console.log;
  console.error = (...a: unknown[]): void => { errs.push(a.map(String).join(" ")); };
  console.log = (): void => {};
  try { code = VR.statusMain("Plots__1_1", { phase: "done", run: "run-pub", publish: stage, dir }, "usage"); }
  finally { Reflect.set(fs, "renameSync", rename); console.error = logErr; console.log = logOut; }
  safe("the evidence file is moved in while the status lock is held and the live status already says done; exit 0", () => code === 0 && seen.join(" ") === "locked:done" && fs.existsSync(dest));
  if (code !== 0 || seen.join(" ") !== "locked:done") console.log(`    exit ${code}; renames into design/verify: ${seen.join(" ") || "none"}; ${errs.join(" | ").slice(0, 300)}`);
});

// the probe's exit-3 status write waits on the lock while the run ends: the documented exit 2, not 3
console.log("verify-probe --run — the run ends while the probe's own status write waits:");
await block("probe exit 3 vs an ending run:", async () => {
  const { dir, base, live } = project();
  VR.writeStatus(base, { runId: "run-pe", phase: "renderer-ready", by: "agent" });
  const noPw = mk("dt-run-nopw-race-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const holder = await lockHolder(base);
  let err = "";
  const p = spawn(process.execPath, [path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts"), "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-pe"]);
  p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
  const pDone = new Promise<number | null>((resolve) => p.on("close", resolve));
  // past its start check: it has said the renderer is unavailable and now records exit 3 — behind the lock
  for (const t0 = Date.now(); !/renderer unavailable/.test(err) && Date.now() - t0 < 10_000;) await sleep(10);
  const waiting = /renderer unavailable/.test(err);
  holder.end();
  const [code] = await Promise.all([pDone, holder.done]);
  safe("the probe passed its start check and reached its exit-3 status write before the run ended", () => waiting);
  safe("…the run ended under the lock first → exit 2 (not 3), 'already ended at failed (gave up)'; the failed status is kept", () =>
    code === 2 && err.includes("run run-pe already ended at failed (gave up)") && readStatusFile(live)?.phase === "failed" && readStatusFile(live)?.detail === "gave up");
});

// ---------------------------------------------------------------- CLI --wait
// ---------------------------------------------------------------- which set --status / --wait name (screen-key.ts setKey)
console.log("[key] the set a --status / --wait query names:");
await block("[key] the set a --status / --wait query names:", async () => {
  const { cwd, dir, base, live, cli } = project();
  const index = (rows: Array<{ name: string; id: string }>): void => {
    const f = path.join(cwd, "design", "export", "pages", "index.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ pageDirs: [{ page: "P", dir: "P" }], layers: rows.map((r) => ({ ...r, type: "FRAME", page: "P", file: `pages/P/${r.id.replace(":", "_")}.json` })) }));
  };
  // no export index: only a set name says which set — a layer name is refused, nothing written
  const bare = cli("--status", "Plots", "--phase", "starting", "--new-run");
  safe(`[key] no export index: 'Plots' (a layer name) → exit 2, names no set, nothing written (got ${bare.status}: ${bare.stderr.trim()})`, () =>
    bare.status === 2 && /^'Plots' names no verify set: no export index/m.test(bare.stderr) && !fs.existsSync(path.dirname(live)));
  index([{ name: "Plots", id: "1:1" }, { name: "Sheds", id: "2:2" }]);
  const s1 = cli("--status", "Plots", "--phase", "starting", "--new-run");
  const runId = /^run (\S+) rev 1$/m.exec(s1.stdout)?.[1] ?? "";
  safe(`[key] the exact layer name → the existing set Plots__1_1's live status (got ${s1.status}: ${s1.stderr.trim()})`, () => s1.status === 0 && runId !== "" && readStatusFile(live)?.runId === runId
    && readStatusFile(live)?.screen === "Plots__1_1");
  // the frame is renamed in Figma and re-pulled while the run is open: its set keeps its stem, so the run goes on in the same file
  index([{ name: "Garden Plots", id: "1:1" }, { name: "Sheds", id: "2:2" }]);
  const s2 = cli("--status", "Garden Plots", "--phase", "measuring");
  const s3 = cli("--status", "1:1", "--phase", "driving", "--run", runId);
  safe(`[key] REQUIRED: a mid-run export rename — the new layer name and the node id reach the same live status file, the same run (rev 2, 3) (got ${s2.stdout.trim()} / ${s3.stdout.trim()})`, () =>
    s2.status === 0 && s2.stdout.trim() === `run ${runId} rev 2` && s3.status === 0 && s3.stdout.trim() === `run ${runId} rev 3` && readStatusFile(live)?.rev === 3
    && !fs.readdirSync(path.dirname(live)).some((f) => f.startsWith("Garden")));
  const w = cli("--wait", "Garden Plots", "--run", "run-none", "--timeout", "0.3", "--interval", "0.1");
  safe("[key] --wait names the set the same way (it waits on Plots__1_1's live status)", () => w.status === 5 && w.stderr.includes(`wait  run run-none on ${VR.liveStatusFile(base)}`));
  // a variant set name is taken as written: its own live status
  const v = cli("--status", "Plots__1_1.dark", "--phase", "starting", "--new-run");
  const vLive = VR.liveStatusFile(path.join(dir, "Plots__1_1.dark"));
  safe(`[key] a variant set name → its own live status, beside the base set's (got ${v.status}: ${v.stderr.trim()})`, () =>
    v.status === 0 && vLive !== live && readStatusFile(vLive)?.screen === "Plots__1_1.dark" && readStatusFile(live)?.runId === runId);
  // a node with only a legacy-named set: --status refuses (a run under the new name would start a second set)
  fs.writeFileSync(path.join(dir, "Shed.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "2:2", name: "Sheds" }, nodes: [] }));
  const lg = cli("--status", "Sheds", "--phase", "starting", "--new-run");
  safe(`[key] a node with only a legacy-named set → exit 2 with --migrate --apply, nothing written (got ${lg.status}: ${lg.stderr.trim()})`, () =>
    lg.status === 2 && /legacy-named verify set\(s\) Shed of node 2:2, and none named Sheds__2_2 — .* --migrate --apply, then --status Sheds__2_2/.test(lg.stderr)
    && !fs.existsSync(VR.liveStatusFile(path.join(dir, "Sheds__2_2"))) && !fs.existsSync(VR.liveStatusFile(path.join(dir, "Shed"))));
  const lgName = cli("--status", "Shed", "--phase", "starting", "--new-run");
  safe("[key] the legacy set's own name → exit 2, run --migrate", () => lgName.status === 2 && /Shed is a legacy-named verify set — run verify-screen --migrate --apply/.test(lgName.stderr));
  const near = cli("--status", "gardenplots", "--phase", "starting", "--new-run");
  safe(`[key] a whitespace-insensitive match names no set: exit 2, the candidate listed (got ${near.status}: ${near.stderr.trim()})`, () => near.status === 2 && /^ {2}1:1 {2}Garden Plots$/m.test(near.stderr));
});

console.log("[key] a refusal's commands name the set by basename(base), not the status's screen:");
await block("[key] refusal commands:", async () => {
  const d = mk("dt-run-names-");
  const base = path.join(d, "Plots__1_1");
  // a migrated set: its live status moved with it and still says the old name in `screen`
  const open: VR.VerifyStatusV2 = { schema: VR.STATUS_SCHEMA, screen: "Plots", runId: "run-old", rev: 2, phase: "measuring", detail: "", at: "2026-10-01T00:00:00Z", by: "agent" };
  const ro = new VR.RunOpen(base, open).message, nc = new VR.RunNotCurrent(base, "run-new", open).message;
  safe(`[key] RunOpen / RunNotCurrent say 'of Plots__1_1' and their --wait / --status commands name Plots__1_1, never the old name (got ${nc})`, () =>
    [ro, nc].every((m) => /of Plots__1_1[ :]/.test(m) && m.includes("--wait Plots__1_1 --run run-old") && m.includes("--status Plots__1_1 --phase failed --run run-old") && !/ Plots /.test(m) && !/of Plots[ :]/.test(m)));
});

// A project's export index (design/export/pages/index.json) with these layer rows.
const writeIndex = (cwd: string, rows: Array<{ name: string; id: string }>): void => {
  const f = path.join(cwd, "design", "export", "pages", "index.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ pageDirs: [{ page: "P", dir: "P" }], layers: rows.map((r) => ({ ...r, type: "FRAME", page: "P", file: `pages/P/${r.id.replace(":", "_")}.json` })) }));
};

console.log("[key] a status-only run keeps its set's stem through a Figma rename:");
await block("[key] status-only run:", async () => {
  const { cwd, dir, cli } = project();
  writeIndex(cwd, [{ name: "Old", id: "3:3" }]);
  const q = cli("--status", "Old__3_3", "--phase", "queued", "--new-run");
  const runId = /^run (\S+) rev 1$/m.exec(q.stdout)?.[1] ?? "";
  const oldLive = VR.liveStatusFile(path.join(dir, "Old__3_3")), newLive = VR.liveStatusFile(path.join(dir, "New__3_3"));
  safe(`[key] --status Old__3_3 --new-run opens a run with no set file yet (got ${q.status}: ${q.stderr.trim()})`, () => q.status === 0 && runId !== "" && readStatusFile(oldLive)?.runId === runId);
  safe("[key] openRunSets names the set of that open run", () => JSON.stringify(VR.openRunSets(dir)) === JSON.stringify(["Old__3_3"]));
  // the frame is renamed in Figma and re-pulled: the node id and the new name still reach the open run's status
  writeIndex(cwd, [{ name: "New", id: "3:3" }]);
  const byId = cli("--status", "3:3", "--phase", "starting", "--run", runId);
  const byName = cli("--status", "New", "--phase", "renderer-found");
  safe(`[key] REQUIRED: the node id (--run) and the new name continue run ${runId} in Old__3_3's live status — no New__3_3 status or lock (got ${byId.status}: ${byId.stdout.trim()} / ${byName.status}: ${byName.stdout.trim()})`, () =>
    byId.status === 0 && byId.stdout.trim() === `run ${runId} rev 2` && byName.status === 0 && byName.stdout.trim() === `run ${runId} rev 3`
    && readStatusFile(oldLive)?.rev === 3 && !fs.existsSync(newLive) && !fs.existsSync(newLive + ".lock"));
  // --expect for the node names the set by the open run's stem too
  const screen = path.join(cwd, "New__3_3.json");
  fs.writeFileSync(screen, JSON.stringify({ exportedAt: "2026-10-01T00:00:00.000Z", screen: "New", nodeId: "3:3", nodes: [{ type: "FRAME", id: "3:3", name: "New", children: [] }] }));
  const ex = cli("--expect", screen);
  safe(`[key] --expect for the node writes Old__3_3.expected.json, the open run's set, never New__3_3 (got ${ex.status}: ${ex.stderr.trim().split("\n")[0] ?? ""})`, () =>
    ex.status === 0 && fs.existsSync(path.join(dir, "Old__3_3.expected.json")) && !fs.existsSync(path.join(dir, "New__3_3.expected.json")));
});

console.log("[key] a status-only run whose node another set holds: the end-it command a refusal prints for it ends it:");
await block("[key] status-only run beside another set:", async () => {
  if (POSIX_SH === null) { console.log("  (skipped: no sh on PATH — the printed commands are POSIX-shell quoted, run through Git Bash on Windows)"); return; }
  const sh = POSIX_SH;
  const { cwd, dir, cli } = project();
  writeIndex(cwd, [{ name: "New Racks", id: "5:5" }]);
  const openBase = path.join(dir, "New_Racks__5_5"), openLive = VR.liveStatusFile(openBase);
  VR.writeStatus(openBase, { runId: "run-t", phase: "queued", by: "agent" });
  // meanwhile a set of the node is written under another stem: New_Racks__5_5 is a second name for the node now
  fs.writeFileSync(path.join(dir, "Old_Racks__5_5.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "5:5", name: "Old Racks" }, nodes: [] }));
  const refused = cli("--status", "Old_Racks__5_5", "--phase", "queued", "--new-run");
  const endIt = /end it: (.+?)\)\)/.exec(refused.stderr)?.[1] ?? "";
  safe(`[key] --status Old_Racks__5_5 → exit 2, naming run-t under New_Racks__5_5 with the command that ends it (got ${refused.status}: ${refused.stderr.trim()})`, () =>
    refused.status === 2 && endIt.includes("--status New_Racks__5_5 --phase failed --run run-t --dir "));
  const notEnd = cli("--status", "New_Racks__5_5", "--phase", "measuring", "--run", "run-t");
  const otherRun = cli("--status", "New_Racks__5_5", "--phase", "failed", "--run", "run-other");
  safe(`[key] …under that name, a write that does not end run-t (another phase, another run) → exit 2, nothing written (got ${notEnd.status} / ${otherRun.status})`, () =>
    notEnd.status === 2 && otherRun.status === 2 && readStatusFile(openLive)?.rev === 1);
  const ran = spawnSync(sh, ["-c", endIt], { cwd: os.tmpdir(), encoding: "utf8" });
  safe(`[key] REQUIRED: the printed end-it command, run as printed → exit 0, run-t ended failed (got ${ran.status}: ${ran.stderr.trim()})`, () =>
    ran.status === 0 && readStatusFile(openLive)?.runId === "run-t" && readStatusFile(openLive)?.phase === "failed" && readStatusFile(openLive)?.rev === 2
    && /note {2}another verify set holds New_Racks__5_5's node — only run run-t's end is written under New_Racks__5_5/.test(ran.stderr));
  const after = cli("--status", "Old_Racks__5_5", "--phase", "queued", "--new-run");
  safe(`[key] …then the node's one set takes a new run (got ${after.status}: ${after.stderr.trim()})`, () => after.status === 0);
});

console.log("[key] --status --new-run under a set name the export index does not give its node:");
await block("[key] fresh set name:", async () => {
  const { cwd, dir, cli } = project();
  writeIndex(cwd, [{ name: "Plots", id: "1:1" }, { name: "Garden Beds", id: "4:4" }]);
  const wrong = cli("--status", "Beds__4_4", "--phase", "queued", "--new-run");
  safe(`[key] --status Beds__4_4 --new-run, no file or status of it, the index names 4:4 'Garden Beds' → exit 2 naming Garden_Beds__4_4, nothing written (got ${wrong.status}: ${wrong.stderr.trim()})`, () =>
    wrong.status === 2 && /the export index names the node "Garden Beds", so its set is Garden_Beds__4_4 — pass --status Garden_Beds__4_4/.test(wrong.stderr)
    && !fs.existsSync(VR.liveStatusFile(path.join(dir, "Beds__4_4"))));
  const variant = cli("--status", "Beds__4_4.dark", "--phase", "queued", "--new-run");
  safe(`[key] …a variant of it names the canonical variant (got ${variant.status}: ${variant.stderr.trim()})`, () => variant.status === 2 && /its set is Garden_Beds__4_4\.dark/.test(variant.stderr));
  const right = cli("--status", "Garden_Beds__4_4", "--phase", "queued", "--new-run");
  safe(`[key] …the canonical name opens the run (got ${right.status}: ${right.stderr.trim()})`, () => right.status === 0 && readStatusFile(VR.liveStatusFile(path.join(dir, "Garden_Beds__4_4")))?.phase === "queued");
  // an existing set keeps its stem whatever the index says now (Plots__1_1 exists; the frame is renamed)
  writeIndex(cwd, [{ name: "Garden Plots", id: "1:1" }, { name: "Garden Beds", id: "4:4" }]);
  const kept = cli("--status", "Plots__1_1", "--phase", "queued", "--new-run");
  safe(`[key] …an existing set's name is taken at --new-run though the index renamed its frame (got ${kept.status}: ${kept.stderr.trim()})`, () => kept.status === 0);
});

console.log("[key] a legacy-named set with an open run: its run can end under the old name, then --migrate renames it:");
await block("[key] legacy set, open run:", async () => {
  const { cwd, dir, cli } = project();
  writeIndex(cwd, [{ name: "Plots", id: "1:1" }, { name: "Sheds", id: "2:2" }]);
  fs.writeFileSync(path.join(dir, "Shed.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "2:2", name: "Sheds" }, nodes: [] }));
  const legacyBase = path.join(dir, "Shed");
  VR.writeStatus(legacyBase, { runId: "run-legacy", phase: "measuring", by: "agent" });
  const fresh = cli("--status", "Shed", "--phase", "queued", "--new-run");
  safe(`[key] --status Shed --new-run → exit 2, the open run named with how to end it (got ${fresh.status}: ${fresh.stderr.trim()})`, () =>
    fresh.status === 2 && /Shed is a legacy-named verify set, and its run run-legacy is open \(phase measuring\)/.test(fresh.stderr) && /--status Shed --phase failed --run run-legacy/.test(fresh.stderr)
    && readStatusFile(VR.liveStatusFile(legacyBase))?.rev === 1);
  const mid = cli("--status", "Shed", "--phase", "measured", "--run", "run-legacy");
  safe(`[key] --status Shed --phase measured --run <its run> (not an end) → exit 2, nothing written (got ${mid.status})`, () => mid.status === 2 && readStatusFile(VR.liveStatusFile(legacyBase))?.rev === 1);
  const other = cli("--status", "Shed", "--phase", "failed", "--run", "run-other");
  safe(`[key] --status Shed --phase failed --run <another run> → exit 2 (got ${other.status})`, () => other.status === 2 && readStatusFile(VR.liveStatusFile(legacyBase))?.rev === 1);
  const w = cli("--wait", "Shed", "--run", "run-legacy", "--timeout", "0.3", "--interval", "0.1");
  safe(`[key] --wait Shed waits on the legacy set's live status, with the --migrate note (got ${w.status}: ${w.stderr.trim()})`, () =>
    w.status === 5 && w.stderr.includes(`wait  run run-legacy on ${VR.liveStatusFile(legacyBase)}`) && /note {2}Shed is a legacy-named verify set — once run run-legacy ends, verify-screen --migrate renames it/.test(w.stderr));
  const wOther = cli("--wait", "Shed", "--run", "run-other", "--timeout", "0.3", "--interval", "0.1");
  safe(`[key] --wait Shed --run <another run> → exit 2 at once, naming the open run (no run but run-legacy can be under the old name) (got ${wOther.status}: ${wOther.stderr.trim()})`, () =>
    wOther.status === 2 && /Shed is a legacy-named verify set, and its run run-legacy is open \(phase measuring\)/.test(wOther.stderr) && !wOther.stderr.includes("wait  run"));
  const early = cli("--migrate", "--apply");
  safe(`[key] --migrate --apply while the run is open skips the set (got ${early.status})`, () => early.status === 1 && fs.existsSync(path.join(dir, "Shed.expected.json")));
  const end = cli("--status", "Shed", "--phase", "failed", "--run", "run-legacy", "--detail", "verifier gone");
  safe(`[key] --status Shed --phase failed --run run-legacy ends the run → exit 0 (got ${end.status}: ${end.stderr.trim()})`, () =>
    end.status === 0 && readStatusFile(VR.liveStatusFile(legacyBase))?.phase === "failed");
  const wEnded = cli("--wait", "Shed", "--run", "run-legacy", "--timeout", "5", "--interval", "0.1");
  safe(`[key] --wait Shed --run run-legacy after the run ended → its outcome (exit 1, failed, the detail), not a --migrate refusal (got ${wEnded.status}: ${wEnded.stderr.trim()})`, () =>
    wEnded.status === 1 && /run run-legacy failed \(rev 2, .*\): verifier gone/.test(wEnded.stderr) && /note {2}Shed is a legacy-named verify set — verify-screen --migrate renames it/.test(wEnded.stderr));
  const mig = cli("--migrate", "--apply");
  safe(`[key] …then --migrate --apply renames Shed to Sheds__2_2 (got ${mig.status}: ${mig.stdout.trim()} ${mig.stderr.trim()})`, () =>
    mig.status === 0 && fs.existsSync(path.join(dir, "Sheds__2_2.expected.json")) && !fs.existsSync(path.join(dir, "Shed.expected.json")));
});

console.log("verify-screen --wait:");
await block("verify-screen --wait:", async () => {
  const { dir, base, live, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir));
  fs.writeFileSync(path.join(dir, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [] }));
  cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-a");
  const t0 = Date.now();
  const w1 = cli("--wait", "Plots__1_1", "--run", "run-b", "--timeout", "1", "--interval", "0.1");
  safe("a stale `done` from run A does not end a wait for run B → exit 5 after --timeout", () => w1.status === 5 && /timed out after 1s waiting for run run-b/.test(w1.stderr) && Date.now() - t0 >= 900);
  const w2 = cli("--wait", "Plots__1_1", "--run", "run-a", "--timeout", "5", "--interval", "0.1");
  safe("run A done and the measured file is the one it names → exit 0, prints the --compare command, --out the verify directory", () => w2.status === 0 && w2.stdout.includes(`--compare ${relPrinted("Plots__1_1.expected.json")} ${relPrinted("Plots__1_1.measured.json")} --out ${shellArg(path.join("design", "verify"))}`) && !w2.stdout.includes(`--out ${relPrinted("Plots__1_1")}`));
  safe("…without --interactions: that evidence file was not published in run A", () => !/--interactions/.test(w2.stdout));
  safe("--wait names the live file it waits on", () => w2.stderr.includes(live));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), JSON.stringify({ expectationSha256: "remeasured", nodes: [] }));
  const w3 = cli("--wait", "Plots__1_1", "--run", "run-a", "--timeout", "1", "--interval", "0.1");
  safe("run A done but the measured file changed since → not done: keeps waiting (exit 5), says why", () => w3.status === 5 && /is not the file it names/.test(w3.stderr));
  cli("--status", "Plots__1_1", "--phase", "blocked", "--run", "run-c", "--detail", "blocked on permissions: probe done / compare remaining");
  const w4 = cli("--wait", "Plots__1_1", "--run", "run-c", "--timeout", "5", "--interval", "0.1");
  safe("run C blocked → exit 1 with the detail", () => w4.status === 1 && /blocked on permissions/.test(w4.stderr));
  cli("--status", "Plots__1_1", "--phase", "measuring", "--run", "run-d");
  const w5 = cli("--wait", "Plots__1_1", "--run", "run-d", "--timeout", "10", "--stall", "0.5", "--interval", "0.1");
  safe("no status change for --stall seconds → exit 5 'stalled'", () => w5.status === 5 && /stalled/.test(w5.stderr));
  safe("--wait without --run → exit 2", () => cli("--wait", "Plots__1_1").status === 2);
  // a status that keeps moving is never a stall — rewritten every ~0.3 s under --stall 0.5 for ~2 s
  const moving = new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [VS_TS, "--wait", "Plots__1_1", "--run", "run-m", "--timeout", "2", "--stall", "0.5", "--interval", "0.1"], { cwd: path.dirname(path.dirname(dir)) });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => { if (/stalled/.test(err)) resolve(-1); else resolve(code); });
  });
  const beat = setInterval(() => { VR.writeStatus(base, { runId: "run-m", phase: "driving", by: "agent", detail: "heartbeat" }); }, 300);
  const mc = await moving;
  clearInterval(beat);
  safe("a status rewritten every ~0.3 s under --stall 0.5 → no stall for ~2 s (ends on --timeout, exit 5, never 'stalled')", () => mc === 5);
  // a wait that sees the run finish while it polls — reading the LIVE file (nothing in design/verify changes); the
  // heartbeat run ends first (a --status --run write never lands over another open run)
  VR.writeStatus(base, { runId: "run-m", phase: "failed", by: "agent", detail: "heartbeats over" });
  cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-e");
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir));
  const stage = VR.stageDirOf(base, "run-e");
  fs.writeFileSync(path.join(stage, "Plots__1_1.evidence.json"), JSON.stringify({ interactions: [{ nodeId: "2:4", trigger: "on_click", ok: null }] }));
  // both of the waiter's pipes are read (an unread pipe is a writer blocked on Windows, where a write to a pipe is
  // synchronous), and on a failure the done write's and the waiter's own words are printed
  let out = "", werr = "";
  const waiting = new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [VS_TS, "--wait", "Plots__1_1", "--run", "run-e", "--timeout", "15", "--interval", "0.1"], { cwd: path.dirname(path.dirname(dir)), stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { werr += d.toString(); });
    p.on("close", (code) => resolve(code));
  });
  await sleep(700);
  const doneE = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-e", "--publish", stage);
  const code = await waiting;
  safe("…the done write that ends it, while the wait polls the live status → exit 0, the evidence published", () => doneE.status === 0 && /published 1 file\(s\)/.test(doneE.stderr));
  safe("…a wait that is polling when the run reaches done → exit 0", () => code === 0);
  safe("…and prints --interactions for the evidence published in this run", () => out.includes(`--interactions ${relPrinted("Plots__1_1.evidence.json")}`));
  if (doneE.status !== 0 || code !== 0) console.log(`    (done: exit ${String(doneE.status)}, stderr: ${doneE.stderr.trim()}\n     wait: exit ${String(code)}, stderr: ${werr.trim()})`);
  // the window between done's live write and its commit, held open: done names this run's evidence, not in design/verify yet
  const evStaged = path.join(VR.stageDirOf(base, "run-w"), "Plots__1_1.evidence.json");
  fs.mkdirSync(path.dirname(evStaged), { recursive: true });
  fs.writeFileSync(evStaged, JSON.stringify({ interactions: [{ nodeId: "2:5", trigger: "on_click", ok: true }] }));
  fs.rmSync(path.join(dir, "Plots__1_1.evidence.json"), { force: true });
  VR.writeStatus(base, { runId: "run-w", phase: "done", by: "agent", measuredSha256: sha(path.join(dir, "Plots__1_1.measured.json")), evidenceSha256: sha(evStaged), published: ["Plots__1_1.evidence.json"] });
  let outW = "", errW = "", closedW = false;
  const noteW = /Plots__1_1\.evidence\.json does not exist — still waiting/;
  const waitingW = new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [VS_TS, "--wait", "Plots__1_1", "--run", "run-w", "--timeout", "15", "--interval", "0.1"], { cwd: path.dirname(path.dirname(dir)) });
    p.stdout.on("data", (d: Buffer) => { outW += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { errW += d.toString(); });
    p.on("close", (code) => { closedW = true; resolve(code); });
  });
  // the evidence lands only once the wait has said it is waiting for it (or has exited — the bug), however slow its start
  for (const t0 = Date.now(); !noteW.test(errW) && !closedW && Date.now() - t0 < 10_000;) await sleep(50);
  const sawNote = noteW.test(errW) && !closedW;
  fs.copyFileSync(evStaged, path.join(dir, "Plots__1_1.evidence.json"));
  const codeW = await waitingW;
  // pre-change: fails — the wait exited 0 at once, without --interactions
  safe("done whose evidence is not in design/verify yet (the publish not committed) → keeps waiting, says why", () => sawNote);
  safe("…then the evidence lands → exit 0 with --interactions", () => codeW === 0 && outW.includes(`--interactions ${relPrinted("Plots__1_1.evidence.json")}`));
  // the live file alone moves a wait: design/verify/Plots__1_1.status.json is only the published copy
  fs.rmSync(path.join(dir, "Plots__1_1.status.json"), { force: true });
  VR.writeStatus(base, { runId: "run-f", phase: "failed", by: "agent", detail: "gave up" });
  const w6 = cli("--wait", "Plots__1_1", "--run", "run-f", "--timeout", "3", "--interval", "0.1");
  safe("--wait reads the live status (failed in the run cache, nothing in design/verify) → exit 1", () => w6.status === 1 && /gave up/.test(w6.stderr) && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
});

// ---------------------------------------------------------------- verify-probe --run on an exit 3
console.log("verify-probe --run — an exit 3/4 bumps the status (LOW):");
await block("verify-probe --run exit 3:", async () => {
  const { dir, base, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-x");
  const noPw = mk("dt-run-nopw-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const p = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-x"]);
  const st = VR.readStatus(base);
  safe("probe exit 3 with --run → the first failed attempt: rev bumped, phase measuring, probeFailures 1, detail names the attempt, the user's fix and the one re-run",
    () => p.status === 3 && st !== null && st !== "v1" && st.runId === "run-x" && st.rev === 2 && st.phase === "measuring" && st.probeFailures === 1
      && st.detail === "probe exit 3 — nothing written (failed probe attempt 1 of 2: ask the user to make a renderer available, then re-run the probe once in this run)");
  safe("…stderr: 'status run run-x measuring — failed probe attempt 1 of 2: ask the user to make a renderer available, then re-run the probe once in this run (--run run-x); the next failed attempt ends it failed'",
    () => p.stderr.includes("status run run-x measuring — failed probe attempt 1 of 2: ask the user to make a renderer available, then re-run the probe once in this run (--run run-x); the next failed attempt ends it failed"));
  // the agent's own write between the two attempts keeps the count (it carries forward within the run)
  VR.writeStatus(base, { runId: "run-x", phase: "renderer-ready", by: "agent", detail: "re-running the probe" });
  const kept = VR.readStatus(base);
  safe("…a later write of the same run carries probeFailures forward", () => kept !== null && kept !== "v1" && kept.probeFailures === 1 && kept.phase === "renderer-ready");
  const p2 = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-x"]);
  const st2 = VR.readStatus(base);
  safe("the second failed attempt (exit 3 again) → the probe ends the run itself: phase failed, probeFailures 2, rev 4, by verify-probe, exit 3",
    () => p2.status === 3 && st2 !== null && st2 !== "v1" && st2.runId === "run-x" && st2.phase === "failed" && st2.probeFailures === 2 && st2.rev === 4 && st2.by === "verify-probe"
      && st2.detail === "probe exit 3 — nothing written (failed probe attempt 2 of 2: the probe ended the run failed)");
  safe("…stderr: 'status run run-x failed — failed probe attempt 2 of 2: the probe ended the run failed (a retry is a new run: --new-run)'",
    () => p2.stderr.includes("status run run-x failed — failed probe attempt 2 of 2: the probe ended the run failed (a retry is a new run: --new-run)"));
  const before3 = JSON.stringify(VR.readStatus(base));
  const p3 = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-x"]);
  safe("a third probe in that run → refused before anything starts (exit 2, 'already ended at failed'); the ended run is never reopened",
    () => p3.status === 2 && p3.stderr.includes("run run-x already ended at failed (probe exit 3 — nothing written (failed probe attempt 2 of 2: the probe ended the run failed))") && JSON.stringify(VR.readStatus(base)) === before3);
});

console.log("writeStatus probeFailed — the run's failed probe attempts:");
await block("probeFailed counting:", async () => {
  const { base, live } = project();
  VR.writeStatus(base, { runId: "run-c1", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  VR.writeStatus(base, { runId: "run-c2", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  const other = VR.readStatus(base);
  safe("another run's failed attempt counts from 1 (the count is per run)", () => other !== null && other !== "v1" && other.runId === "run-c2" && other.probeFailures === 1 && other.phase === "measuring");
  const plain = VR.writeStatus(base, { runId: "run-c3", phase: "measuring", by: "agent" });
  safe("a run with no failed attempt has no probeFailures", () => plain.probeFailures === undefined);
  const raw: unknown = JSON.parse(fs.readFileSync(live, "utf8"));
  fs.writeFileSync(live, JSON.stringify({ ...(typeof raw === "object" && raw !== null ? raw : {}), probeFailures: "two" }));
  const mal = VR.readStatus(base);
  safe("a malformed probeFailures is read as none counted, never the whole status", () => mal !== null && mal !== "v1" && mal.runId === "run-c3" && mal.probeFailures === undefined);
  const next = VR.writeStatus(base, { runId: "run-c3", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  safe("…and the next failed attempt counts from 1", () => next.probeFailures === 1 && next.phase === "measuring");

  // a run id is one pass: a successful probe between two failed attempts does not reset the count
  const s = project();
  s.cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-s");
  const first = VR.writeStatus(s.base, { runId: "run-s", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  safe("an exit 4's first attempt → 'failed probe attempt 1 of 2: re-run the probe once in this run' (no renderer to fix)",
    () => first.detail === "probe exit 4 — nothing written (failed probe attempt 1 of 2: re-run the probe once in this run)" && first.phase === "measuring");
  const okWrite = VR.writeStatus(s.base, { runId: "run-s", phase: "measured", by: "verify-probe", detail: "measured" });
  safe("a successful probe in the same run (its `measured` write) keeps probeFailures 1", () => okWrite.probeFailures === 1 && okWrite.phase === "measured");
  const second = VR.writeStatus(s.base, { runId: "run-s", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  safe("…so a later failed attempt in that run is its second: the run ends failed", () => second.probeFailures === 2 && second.phase === "failed");

  // the count is in the durable status `done` publishes into design/verify
  const d = project();
  d.cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-d");
  VR.writeStatus(d.base, { runId: "run-d", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written", probeFailed: 4 });
  fs.writeFileSync(path.join(d.dir, "Plots__1_1.measured.json"), measuredFor(d.dir, { runId: "run-d" }));
  const dd = d.cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-d");
  const durable = readStatusFile(path.join(d.dir, "Plots__1_1.status.json"));
  safe("done after one failed attempt → the published design/verify/Plots__1_1.status.json carries probeFailures 1", () => dd.status === 0 && durable?.phase === "done" && durable.probeFailures === 1);
});

// The probe, too, never reopens an ended run (it writes measuring/measured through writeStatus)
console.log("verify-probe --run on an ended run:");
await block("verify-probe --run ended:", async () => {
  const { dir, base, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  cli("--status", "Plots__1_1", "--phase", "blocked", "--run", "run-pb", "--detail", "blocked on a login wall");
  const before = JSON.stringify(VR.readStatus(base));
  const noPw = mk("dt-run-nopw-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const p = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-pb"]);
  safe("probe --run on a blocked run → exit 2 'already ended at blocked (…) — start a new run', the status untouched", () => p.status === 2
    && p.stderr.includes("run run-pb already ended at blocked (blocked on a login wall) — start a new run with --new-run") && JSON.stringify(VR.readStatus(base)) === before);
});

// A stale verifier's probe --run never writes over a NEWER run of the screen that has not ended (`current`), at its start
// or when that run opens while it runs; over a run that has ended it still writes (fast — a fake Playwright opens the run)
console.log("verify-probe --run — never over another run that has not ended:");
await block("verify-probe --run current:", async () => {
  const { dir, base, live, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  const d = mk("dt-run-fakepw-cur-");
  fs.writeFileSync(path.join(d, "package.json"), "{}");
  const pw = path.join(d, "node_modules", "playwright");
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "playwright", version: "1.60.0", main: "index.js" }));
  // DT_TEST_ON=load: the doc lands when the probe resolves Playwright (after its start check, before its `measuring`
  // write); =launch: when chromium launches (after `measuring`, before the exit-3 attempt write). Launch always fails: exit 3
  fs.writeFileSync(path.join(pw, "index.js"), "const fs = require('fs'); const put = (at) => { if (process.env.DT_TEST_ON === at) fs.writeFileSync(process.env.DT_TEST_LIVE, process.env.DT_TEST_DOC); };\n" +
    "put('load'); module.exports = { chromium: { launch() { put('launch'); throw new Error('fake'); } } };\n");
  const probe = (run: string, env: Record<string, string> = {}): ProcResult =>
    runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", d, "--run", run], { env: { ...process.env, DT_TEST_LIVE: live, ...env } });
  const noFiles = (): boolean => !fs.existsSync(path.join(dir, "Plots__1_1.measured.json")) && !fs.existsSync(path.join(dir, "Plots__1_1.png")) && !fs.existsSync(path.join(dir, "Plots__1_1.status.json"));
  const queuedDoc = (runId: string): string => JSON.stringify({ schema: VR.STATUS_SCHEMA, screen: "Plots__1_1", runId, rev: 1, phase: "queued", detail: "", at: new Date().toISOString(), by: "orchestrator" }, null, 2) + "\n";

  // at its start: an orchestrator queued run-new after the verifier of run-old was handed its id
  cli("--status", "Plots__1_1", "--phase", "queued", "--run", "run-new", "--by", "orchestrator");
  const newDoc = fs.readFileSync(live, "utf8");
  const p1 = probe("run-old");
  safe("--run run-old while the status names run-new, open → exit 2 before anything starts: 'run run-old is not the current run of Plots__1_1: run run-new is open (…)'; run-new's status byte-identical; no files",
    () => p1.status === 2 && p1.stderr.startsWith("verify-probe: run run-old is not the current run of Plots__1_1: run run-new is open (phase queued, rev 1, by orchestrator, ")
      && !/renderer unavailable|chromium did not launch/.test(p1.stderr) && fs.readFileSync(live, "utf8") === newDoc && noFiles());
  if (p1.status !== 2) console.log(p1.stderr);

  // run-new opens between the probe's start check (run-old is the status's run) and its `measuring` write
  VR.writeStatus(base, { runId: "run-new", phase: "failed", by: "orchestrator" });
  cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-old");
  const opened = queuedDoc("run-new2");
  const p2 = probe("run-old", { DT_TEST_ON: "load", DT_TEST_DOC: opened });
  safe("…run-new2 opens after the start check, before the `measuring` write → that write is refused under the lock: exit 2, not 3; run-new2's status byte-identical; no files",
    () => p2.status === 2 && p2.stderr.includes("verify-probe: another run opened while this probe ran — run run-old is not the current run of Plots__1_1: run run-new2 is open (phase queued, rev 1, by orchestrator, ")
      && /end it \([^\n]*--phase failed --run run-new2 --dir [^\n]*\)\n/.test(p2.stderr) && fs.readFileSync(live, "utf8") === opened && noFiles());
  if (p2.status !== 2) console.log(p2.stderr);

  // run-new3 opens after the `measuring` write, before the exit-3 failed-attempt write
  VR.writeStatus(base, { runId: "run-new2", phase: "failed", by: "orchestrator" });
  cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-old2");
  const opened3 = queuedDoc("run-new3");
  const p3 = probe("run-old2", { DT_TEST_ON: "launch", DT_TEST_DOC: opened3 });
  safe("…run-new3 opens after the `measuring` write → the exit-3 attempt write is refused (never counted over run-new3): exit 2, not 3; run-new3's status byte-identical; no attempt line",
    () => p3.status === 2 && p3.stderr.includes("verify-probe: another run opened while this probe ran — run run-old2 is not the current run of Plots__1_1: run run-new3 is open (phase queued, rev 1, by orchestrator, ")
      && fs.readFileSync(live, "utf8") === opened3 && !/failed probe attempt|^status run /m.test(p3.stderr) && noFiles());
  if (p3.status !== 2) console.log(p3.stderr);

  // over a run that has ENDED, a --run is still taken (the `current` contract): its failed attempt is counted
  VR.writeStatus(base, { runId: "run-new3", phase: "done", by: "agent" });
  const p4 = probe("run-old3");
  const st4 = VR.readStatus(base);
  safe("--run run-old3 over run-new3, which has ended (done) → taken: exit 3, the attempt counted in run-old3 (measuring rev 2, probeFailures 1)",
    () => p4.status === 3 && st4 !== null && st4 !== "v1" && st4.runId === "run-old3" && st4.phase === "measuring" && st4.rev === 2 && st4.probeFailures === 1);
  if (p4.status !== 3) console.log(p4.stderr);
  safe("…its status names the run it replaced (replaced {run-new3, done}, carried to the attempt write), and the probe prints one note line saying so", () =>
    st4 !== null && st4 !== "v1" && st4.replaced?.runId === "run-new3" && st4.replaced.phase === "done"
      && p4.stderr.split("\n").filter((l) => l.startsWith("note  run run-old3 replaced run run-new3 (ended at done, ")).length === 1);

  // run-new4 is queued AND ends after the `measuring` write, before the exit-3 failed-attempt write: once its `measuring`
  // is recorded, a --run continues its run — never written over a newer run, open or ended
  VR.writeStatus(base, { runId: "run-old3", phase: "failed", by: "orchestrator" });
  cli("--status", "Plots__1_1", "--phase", "renderer-ready", "--run", "run-old4");
  const ended4 = JSON.stringify({ schema: VR.STATUS_SCHEMA, screen: "Plots__1_1", runId: "run-new4", rev: 2, phase: "done", detail: "", at: new Date().toISOString(), by: "agent" }, null, 2) + "\n";
  const p5 = probe("run-old4", { DT_TEST_ON: "launch", DT_TEST_DOC: ended4 });
  safe("…run-new4 started and ended (done) after the `measuring` write → the exit-3 attempt write is refused: exit 2, not 3, 'was replaced by run run-new4 (done) while this probe ran'; run-new4's status byte-identical; no attempt line, no note, no files",
    () => p5.status === 2 && p5.stderr.includes("verify-probe: run run-old4 was replaced by run run-new4 (done) while this probe ran — nothing more is written in it")
      && fs.readFileSync(live, "utf8") === ended4 && !/failed probe attempt|^status run |^note {2}run run-old4 replaced/m.test(p5.stderr) && noFiles());
  if (p5.status !== 2) console.log(p5.stderr);
});

// a record of a run its writer names (`current`) over ANOTHER run that has ended replaces it — and says so: `replaced`
console.log("writeStatus current over an ended run — `replaced`:");
await block("writeStatus replaced:", async () => {
  const { dir, base, live, cli } = project();
  const yDoc = VR.writeStatus(base, { runId: "run-y", phase: "done", by: "agent" });
  const xDoc = VR.writeStatus(base, { runId: "run-x", phase: "measured", by: "agent" }, { current: true });
  safe("a `current` write of run-x over run-y, which has ended (done) → rev 1 of run-x with replaced {runId run-y, phase done, at = run-y's last write}", () =>
    xDoc.rev === 1 && JSON.stringify(xDoc.replaced) === JSON.stringify({ runId: "run-y", phase: "done", at: yDoc.at }) && JSON.stringify(readStatusFile(live)?.replaced) === JSON.stringify(xDoc.replaced));
  safe("replacedNote: one line naming both runs, the replaced run's phase and time", () =>
    VR.replacedNote(xDoc) === `note  run run-x replaced run run-y (ended at done, ${yDoc.at}) as the screen's last run — recorded as \`replaced\` in run run-x's status`);
  const x2 = VR.writeStatus(base, { runId: "run-x", phase: "driving", by: "agent" }, { current: true });
  const x3 = VR.writeStatus(base, { runId: "run-x", phase: "driving", by: "orchestrator" });
  safe("…carried forward within the run (rev 2, rev 3 without `current`), and no note for those writes", () =>
    x2.rev === 2 && x2.replaced?.runId === "run-y" && x3.rev === 3 && x3.replaced?.runId === "run-y" && VR.replacedNote(x2) === null && VR.replacedNote(x3) === null);
  VR.writeStatus(base, { runId: "run-x", phase: "failed", by: "agent" });
  const fresh = VR.writeStatus(base, { runId: "run-n", phase: "queued", by: "orchestrator" });
  safe("a --new-run style write (no `current`) over an ended run → no replaced: it starts a new run normally", () => fresh.rev === 1 && fresh.replaced === undefined && VR.replacedNote(fresh) === null);
  VR.writeStatus(base, { runId: "run-n", phase: "failed", by: "orchestrator" });
  const ownDoc = VR.writeStatus(base, { runId: "run-own", phase: "measuring", by: "verify-probe" }, { alone: true });
  safe("a probe's own run (`alone`) over an ended run → no replaced", () => ownDoc.rev === 1 && ownDoc.replaced === undefined);
  fs.rmSync(live);
  const none = VR.writeStatus(base, { runId: "run-z", phase: "queued", by: "agent" }, { current: true });
  safe("a `current` write over no status → no replaced", () => none.rev === 1 && none.replaced === undefined);
  fs.rmSync(live);
  fs.writeFileSync(base + ".status.json", JSON.stringify({ screen: "Plots__1_1", phase: "done", detail: "by hand", at: "2026-09-29T19:22:52Z" }));
  const overV1 = VR.writeStatus(base, { runId: "run-z", phase: "queued", by: "agent" }, { current: true });
  safe("…over an older hand-written (v1) status → no replaced", () => overV1.rev === 1 && overV1.replaced === undefined);
  fs.rmSync(base + ".status.json");

  // a malformed replaced is dropped on read, never the whole status
  const parsed: unknown = JSON.parse(fs.readFileSync(live, "utf8"));
  fs.writeFileSync(live, JSON.stringify({ ...(isJsonObject(parsed) ? parsed : {}), replaced: { runId: 7, phase: "done" } }, null, 2) + "\n");
  const bad = VR.readStatus(base);
  safe("a live status with a malformed replaced → read as v2 without it (not 'no status'); isVerifyStatusV2 refuses the malformed one", () =>
    bad !== null && bad !== "v1" && bad.runId === "run-z" && bad.replaced === undefined && !VR.isVerifyStatusV2({ ...bad, replaced: { runId: 7, phase: "done" } }));

  // the CLI: --status --run over a run that ended prints the note, and the durable copy `done` publishes keeps replaced
  VR.writeStatus(base, { runId: "run-z", phase: "blocked", by: "agent", detail: "blocked on permissions" });
  const zAt = readStatusFile(live)?.at ?? "";
  const late = cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-late");
  safe("verify-screen --status --run run-late over run-z, which has ended (blocked) → exit 0, rev 1, one note line naming run-z", () =>
    late.status === 0 && late.stdout.trim() === "run run-late rev 1"
      && late.stderr.split("\n").filter((l) => l === `note  run run-late replaced run run-z (ended at blocked, ${zAt}) as the screen's last run — recorded as \`replaced\` in run run-late's status`).length === 1);
  const again = cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-late");
  safe("…its next write (rev 2) prints no note", () => again.status === 0 && !/^note {2}run run-late replaced/m.test(again.stderr));
  fs.writeFileSync(path.join(dir, "Plots__1_1.measured.json"), measuredFor(dir, { runId: "run-late" }));
  const done = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-late");
  const durable = readStatusFile(path.join(dir, "Plots__1_1.status.json"));
  safe("…its `done` publishes design/verify/Plots__1_1.status.json with replaced {run-z, blocked} (a run id, phase and time — kept)", () =>
    done.status === 0 && durable?.runId === "run-late" && durable.replaced?.runId === "run-z" && durable.replaced.phase === "blocked" && durable.replaced.at === zAt);
});

// No --run: the probe starts a run of its own and ends it — never beside another open run, never reopening an ended one
console.log("verify-probe without --run — a run of its own:");
await block("verify-probe own run:", async () => {
  const { dir, base, live, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  // a project whose Playwright resolves but whose chromium never launches: exit 3 AFTER the run's `measuring` write
  const fakePw = mk("dt-run-fakepw-");
  fs.writeFileSync(path.join(fakePw, "package.json"), "{}");
  const pwDir = path.join(fakePw, "node_modules", "playwright");
  fs.mkdirSync(pwDir, { recursive: true });
  fs.writeFileSync(path.join(pwDir, "package.json"), JSON.stringify({ name: "playwright", version: "1.60.0", main: "index.js" }));
  fs.writeFileSync(path.join(pwDir, "index.js"), "module.exports = { chromium: { launch() { throw new Error('fake'); } } };\n");
  const noPw = mk("dt-run-nopw-own-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const probe = (project: string): ProcResult =>
    runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", project]);
  const ownLine = (stderr: string): string => /^run {4}(\S+) — this probe's own \(no --run\)/m.exec(stderr)?.[1] ?? "";

  // a verifier's run is open (driving): refused before anything starts — its status untouched, no files
  cli("--status", "Plots__1_1", "--phase", "driving", "--run", "run-v", "--detail", "the verifier drives");
  const beforeOpen = fs.readFileSync(live, "utf8");
  const p1 = probe(fakePw);
  safe("beside an open run → exit 2 before anything starts: 'run run-v of Plots__1_1 is open (phase driving, …)', how to wait for / end it; the verifier's status byte-identical; no run started, nothing written",
    () => p1.status === 2 && p1.stderr.startsWith("verify-probe: run run-v of Plots__1_1 is open (phase driving, rev 1, by agent, ") && /--wait Plots__1_1 --run run-v --dir /.test(p1.stderr)
      && /--status Plots__1_1 --phase failed --run run-v --dir /.test(p1.stderr) && fs.readFileSync(live, "utf8") === beforeOpen && ownLine(p1.stderr) === "" && !/renderer unavailable/.test(p1.stderr)
      && !fs.existsSync(path.join(dir, "Plots__1_1.measured.json")) && !fs.existsSync(path.join(dir, "Plots__1_1.png")));
  if (p1.status !== 2) console.log(p1.stderr);

  // the run ended (failed): the probe starts a NEW run — never a write to the ended one — and ends it failed on its exit 3
  cli("--status", "Plots__1_1", "--phase", "failed", "--run", "run-v", "--detail", "gave up");
  const p2 = probe(fakePw);
  const id2 = ownLine(p2.stderr);
  const st2 = VR.readStatus(base);
  safe("after that run ended → its own run: a new id on stderr ('run    <id> — this probe's own'), `measuring` then `failed` 'probe exit 3 — nothing written' (rev 2, by verify-probe); exit 3",
    () => p2.status === 3 && /^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id2) && st2 !== null && st2 !== "v1" && st2.runId === id2 && st2.phase === "failed" && st2.rev === 2
      && st2.by === "verify-probe" && st2.detail === "probe exit 3 — nothing written");
  if (p2.status !== 3) console.log(p2.stderr);
  safe("…the ended run is never reopened: nothing about run-v changed but that the live status now holds the new run; nothing published into design/verify", () =>
    id2 !== "run-v" && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")) && !fs.existsSync(path.join(dir, "Plots__1_1.measured.json")));
  // its own failed run does not block the re-run: that is a new run again
  const p3 = probe(fakePw);
  const id3 = ownLine(p3.stderr);
  const st3 = VR.readStatus(base);
  safe("…the re-run after its own run failed → another new run (a different id), failed rev 2 in turn", () =>
    p3.status === 3 && id3 !== "" && id3 !== id2 && st3 !== null && st3 !== "v1" && st3.runId === id3 && st3.phase === "failed" && st3.rev === 2);
  // no Playwright at all: exit 3 before the first status write — no run is started for it
  const beforeNone = fs.readFileSync(live, "utf8");
  const p4 = probe(noPw);
  safe("no Playwright resolvable → exit 3 before the run's first write: no `run` line, the status byte-identical", () => p4.status === 3 && ownLine(p4.stderr) === "" && fs.readFileSync(live, "utf8") === beforeNone);
  safe("its own run records who started it: ownRun {pid of that probe, this host, startedAt} — carried to its `failed` write", () =>
    st3 !== null && st3 !== "v1" && st3.ownRun?.pid === (p3.pid ?? -1) && st3.ownRun.host === os.hostname() && !Number.isNaN(Date.parse(st3.ownRun.startedAt)));
});

// how a probe's own run ends: a throw, a stop signal, and (SIGKILL) the next probe that finds its pid gone
console.log("verify-probe without --run — how its own run ends (a throw, a signal, a kill):");
await block("verify-probe own run left open:", async () => {
  const { dir, base } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  /** a project whose fake Playwright's chromium.launch is `launch` (JS source) */
  const fakeProject = (launch: string): string => {
    const d = mk("dt-run-fakepw-");
    fs.writeFileSync(path.join(d, "package.json"), "{}");
    const pw = path.join(d, "node_modules", "playwright");
    fs.mkdirSync(pw, { recursive: true });
    fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "playwright", version: "1.60.0", main: "index.js" }));
    fs.writeFileSync(path.join(pw, "index.js"), `module.exports = { chromium: { launch: ${launch} } };\n`);
    return d;
  };
  const args = (project: string): string[] => [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", project];
  const throws = fakeProject("() => { throw new Error('fake'); }");
  const ownLine = (stderr: string): string => /^run {4}(\S+) — this probe's own \(no --run\)/m.exec(stderr)?.[1] ?? "";
  const st = (): VR.VerifyStatusV2 | null => { const s = VR.readStatus(base); return s !== null && s !== "v1" ? s : null; };

  // a throw after `measuring` (a browser whose context cannot be opened for a reason that is not the browser being gone): exit 1, run failed
  const boom = fakeProject("async () => ({ version: () => '1.0', close: async () => {}, newBrowserCDPSession: async () => { throw new Error('no cdp'); }, " +
    "newContext: async () => { throw new Error('fake disk full'); } })");
  const t1 = runSync(process.execPath, args(boom));
  const s1 = st();
  safe("an uncaught error after its `measuring` write → exit 1 (the error printed), and its own run ended `failed` 'probe error: fake disk full — nothing written'", () =>
    t1.status === 1 && /verify-probe: fake disk full/.test(t1.stderr) && s1 !== null && s1.runId === ownLine(t1.stderr) && s1.phase === "failed" && s1.rev === 2
      && s1.detail === "probe error: fake disk full — nothing written");
  if (t1.status !== 1) console.log(t1.stderr);

  // stop signals (POSIX: Windows delivers none to a child's handlers) and a kill outright (SIGKILL; TerminateProcess on
  // Windows), on a probe whose launch never returns
  const hangs = fakeProject("() => new Promise(() => {})");
  /** start a probe that hangs in launch, wait for its own run's `measuring`, then send `sig`; resolves with its exit and stderr */
  const killed = async (sig: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string; id: string; pid: number }> => {
    const p = spawn(process.execPath, args(hangs));
    let err = "";
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => p.on("close", (code, signal) => resolve({ code, signal })));
    for (const t0 = Date.now(); ownLine(err) === "" && Date.now() - t0 < 15_000;) await sleep(20);
    await sleep(200);
    p.kill(sig);
    const r = await closed;
    return { ...r, err, id: ownLine(err), pid: p.pid ?? 0 };
  };
  if (process.platform === "win32") console.log("  (skipped: SIGTERM / SIGINT / SIGHUP — Windows delivers no stop signal to a child's handlers)");
  else {
    for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
      const r = await killed(sig);
      const sS = st();
      safe(`${sig} while measuring → exit ${code} (128 + the signal's number), its own run ended \`failed\` 'probe stopped by ${sig} — nothing written'`, () =>
        r.code === code && r.id !== "" && sS !== null && sS.runId === r.id && sS.phase === "failed" && sS.detail === `probe stopped by ${sig} — nothing written`);
      if (r.code !== code) console.log(`    exit ${String(r.code)} ${String(r.signal)}: ${r.err.slice(0, 400)}`);
    }
    // a stdout reader that never drains (1 MB written, nobody reading) must not hold the exit: the flush is capped
    const floods = fakeProject("() => { process.stdout.write('x'.repeat(1 << 20)); return new Promise(() => {}); }");
    const p = spawn(process.execPath, args(floods));
    p.stdout.pause();
    let err = "";
    p.stderr.on("data", (b: Buffer) => { err += b.toString(); });
    const closed = new Promise<number | null>((resolve) => p.on("exit", (code) => resolve(code)));
    for (const t0 = Date.now(); ownLine(err) === "" && Date.now() - t0 < 15_000;) await sleep(20);
    await sleep(200);
    const sentAt = Date.now();
    p.kill("SIGTERM");
    const stuck = setTimeout(() => p.kill("SIGKILL"), 10_000);
    const code = await closed;
    clearTimeout(stuck);
    const took = Date.now() - sentAt;
    safe(`SIGTERM with stdout never read (1 MB pending) → still exit 143 within the flush cap (took ${took} ms, < 6000), its own run ended \`failed\``, () =>
      code === 143 && took < 6_000 && st()?.phase === "failed");
  }

  // SIGKILL: nothing can answer it — the run stays at measuring, naming the dead probe's pid
  const kill = await killed("SIGKILL");
  const sK = st();
  safe("SIGKILL while measuring → the run stays at `measuring`, its ownRun naming the killed probe's pid on this host", () =>
    (kill.signal === "SIGKILL" || process.platform === "win32") && kill.id !== "" && sK !== null && sK.runId === kill.id && sK.phase === "measuring" && sK.ownRun?.pid === kill.pid && sK.ownRun.host === os.hostname());
  const next = runSync(process.execPath, args(throws));
  const sN = st();
  const nextId = ownLine(next.stderr);
  safe("…the next probe without --run finds that pid gone: says it ends the abandoned run `failed`, starts its own (a new id) and goes on (its fake launch: exit 3, failed)", () =>
    next.status === 3 && next.stderr.includes(`note  run ${kill.id} — abandoned — the probe that started it (pid ${kill.pid} on ${os.hostname()}, `) && nextId !== "" && nextId !== kill.id
      && sN !== null && sN.runId === nextId && sN.phase === "failed" && sN.rev === 2);
  if (next.status !== 3) console.log(next.stderr);
});

// writeStatus `alone` over another probe's own run: abandoned (pid gone) → ended failed under the lock; alive or another host → refused, own-run wording
console.log("writeStatus alone — another probe's own run:");
await block("writeStatus alone own run:", async () => {
  const { dir, base, live } = project();
  const absDir = path.resolve(dir);
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid ?? 999_999; // an exited child's pid (no output read)
  const own = (pid: number, host = os.hostname(), deadline = "2999-01-01T00:00:00.000Z"): VR.OwnRunStamp =>
    ({ pid, host, ...(PID_NS ? { ns: PID_NS } : {}), startedAt: "2026-10-15T08:00:00.000Z", deadline });
  VR.writeStatus(base, { runId: "run-dead", phase: "measuring", by: "verify-probe", ownRun: own(deadPid) });
  const seen: VR.VerifyStatusV2[] = [];
  const doc = VR.writeStatus(base, { runId: "run-next", phase: "measuring", by: "verify-probe" }, { alone: true, abandoned: (d) => { seen.push(d); } });
  const ended = seen[0];
  safe("its probe's pid is gone (same host) → abandonedRun; the write ends it `failed` first (rev 2, 'abandoned — the probe that started it (pid N …) is gone'), hands it to `abandoned`, then writes rev 1 of its own run",
    () => seen.length === 1 && ended !== undefined && ended.runId === "run-dead" && ended.phase === "failed" && ended.rev === 2
      && ended.detail.startsWith(`abandoned — the probe that started it (pid ${deadPid} on ${os.hostname()}, 2026-10-15T08:00:00.000Z) is gone`)
      && doc.runId === "run-next" && doc.rev === 1 && doc.ownRun === undefined && readStatusFile(live)?.runId === "run-next");
  VR.writeStatus(base, { runId: "run-next", phase: "failed", by: "verify-probe" });
  VR.writeStatus(base, { runId: "run-live", phase: "measuring", by: "verify-probe", ownRun: own(process.pid) });
  const liveDoc = fs.readFileSync(live, "utf8");
  const refusedLive = ((): unknown => { try { VR.writeStatus(base, { runId: "run-x", phase: "measuring", by: "verify-probe" }, { alone: true }); return null; } catch (e) { return e; } })();
  const ownWording = (e: unknown, id: string, pid: number, host: string): boolean => e instanceof VR.RunOpen
    && e.message === `run ${id} of Plots__1_1 is a probe's own run (no --run), started at 2026-10-15T08:00:00.000Z by pid ${pid} on ${host} and still open (phase measuring) — ` +
      `a probe without --run starts a run of its own only when no other run of the screen is open; if no probe is running, end it: ${scriptCmd("verify-screen")} --status Plots__1_1 --phase failed --run ${id} --dir ${shellArg(absDir)}`
    && !/--wait/.test(e.message);
  safe("its probe's pid is alive (same host) → RunOpen in own-run wording (when, by which pid, how to end it; no --wait), the status unchanged", () =>
    ownWording(refusedLive, "run-live", process.pid, os.hostname()) && fs.readFileSync(live, "utf8") === liveDoc);
  VR.writeStatus(base, { runId: "run-live", phase: "failed", by: "agent" });
  VR.writeStatus(base, { runId: "run-far", phase: "measuring", by: "verify-probe", ownRun: own(deadPid, "another-host.invalid") });
  const refusedFar = ((): unknown => { try { VR.writeStatus(base, { runId: "run-y", phase: "measuring", by: "verify-probe" }, { alone: true }); return null; } catch (e) { return e; } })();
  safe("started on another host (its pid cannot be probed from here) → refused the same way, never taken for abandoned", () =>
    ownWording(refusedFar, "run-far", deadPid, "another-host.invalid") && VR.abandonedRun(VR.readStatus(base), "run-y") === null && readStatusFile(live)?.runId === "run-far");
  safe("isVerifyStatusV2 reads ownRun (and refuses a malformed one); a write that ends the run carries it", () => {
    const far = readStatusFile(live);
    const next = VR.writeStatus(base, { runId: "run-far", phase: "failed", by: "agent" });
    return far?.ownRun?.host === "another-host.invalid" && !VR.isVerifyStatusV2({ ...far, ownRun: { pid: "1", host: "h", startedAt: "t" } }) && next.ownRun?.host === "another-host.invalid";
  });

  // a writer that continues an own run adopts it: ownRun is dropped, and no later probe takes it for abandoned
  VR.writeStatus(base, { runId: "run-adopt", phase: "measuring", by: "verify-probe", ownRun: own(deadPid) });
  const adopted = VR.writeStatus(base, { runId: "run-adopt", phase: "queued", by: "orchestrator" });
  const measuredIn = VR.writeStatus(base, { runId: "run-adopt", phase: "measured", by: "verify-probe" });
  const refusedAdopted = ((): unknown => { try { VR.writeStatus(base, { runId: "run-z", phase: "measuring", by: "verify-probe" }, { alone: true }); return null; } catch (e) { return e; } })();
  safe("an orchestrator's non-terminal write over a dead probe's own run, then a verifier probe --run's: ownRun dropped; the next probe without --run is refused in the verifier wording, never ends it",
    () => adopted.ownRun === undefined && measuredIn.ownRun === undefined && refusedAdopted instanceof VR.RunOpen
      && refusedAdopted.message.startsWith("run run-adopt of Plots__1_1 is open (phase measured, rev 3, by verify-probe, ") && /that run's verifier passes --run run-adopt/.test(refusedAdopted.message)
      && readStatusFile(live)?.phase === "measured");
  safe("…the own run's own writes (`alone`) keep it carried", () => {
    VR.writeStatus(base, { runId: "run-adopt", phase: "failed", by: "agent" });
    VR.writeStatus(base, { runId: "run-keep", phase: "measuring", by: "verify-probe", ownRun: own(process.pid) }, { alone: true });
    return VR.writeStatus(base, { runId: "run-keep", phase: "measuring", by: "verify-probe", detail: "probe exit 4 — nothing written" }, { alone: true }).ownRun?.pid === process.pid;
  });

  // the deadline: a reused pid (alive) past it is still abandoned; a late probe writes nothing more in its own run
  VR.writeStatus(base, { runId: "run-keep", phase: "failed", by: "verify-probe" });
  VR.writeStatus(base, { runId: "run-late", phase: "measuring", by: "verify-probe", ownRun: own(process.pid, os.hostname(), "2026-01-01T00:00:00.000Z") });
  const lateSeen: VR.VerifyStatusV2[] = [];
  const after = VR.writeStatus(base, { runId: "run-new", phase: "measuring", by: "verify-probe" }, { alone: true, abandoned: (d) => { lateSeen.push(d); } });
  safe("an own run whose pid is alive (or reused) but past its deadline → abandoned: ended `failed` ('is past the run's deadline …'), the next run starts", () =>
    lateSeen.length === 1 && lateSeen[0]?.runId === "run-late" && lateSeen[0].phase === "failed" && (lateSeen[0].detail.endsWith("is past the run's deadline 2026-01-01T00:00:00.000Z; ended by the next probe"))
      && after.runId === "run-new" && after.rev === 1);
  VR.writeStatus(base, { runId: "run-new", phase: "failed", by: "verify-probe" });
  // a late probe (stopped or asleep past its deadline): nobody took its run over → it finishes in it; somebody did → nothing
  VR.writeStatus(base, { runId: "run-own", phase: "measuring", by: "verify-probe", ownRun: own(process.pid, os.hostname(), "2026-01-01T00:00:00.000Z") }, { alone: true });
  let ownFiles = false;
  const finished = VR.writeStatus(base, { runId: "run-own", phase: "done", by: "verify-probe" }, { alone: true, continues: true, before: () => { ownFiles = true; return {}; } });
  safe("its own run past its deadline, still open under the lock (nobody took it over) → its late `done` goes through: files written, rev 2 done", () =>
    ownFiles && finished.runId === "run-own" && finished.phase === "done" && finished.rev === 2);
  for (const [i, phase] of (["done", "failed"] as const).entries()) {
    // A (alive, past its deadline) is late; B takes R1 over (ends it, starts R2) and finishes R2 `done`, published —
    // the ids are numbered per case (R2 ends done in both; `phase` is the late write's)
    const r1 = `r1-late${i}`, r2 = `r2-taker${i}`;
    VR.writeStatus(base, { runId: r1, phase: "measuring", by: "verify-probe", ownRun: own(process.pid, os.hostname(), "2026-01-01T00:00:00.000Z") }, { alone: true });
    VR.writeStatus(base, { runId: r2, phase: "measuring", by: "verify-probe", ownRun: own(process.pid) }, { alone: true });
    const r2done = VR.writeStatus(base, { runId: r2, phase: "done", by: "verify-probe" }, { alone: true, continues: true, after: (d) => VR.publishStatus(base, d) });
    const liveBefore = fs.readFileSync(live, "utf8"), pubBefore = fs.readFileSync(VR.statusFile(base), "utf8");
    let lateFiles = false;
    const late = ((): unknown => { try { VR.writeStatus(base, { runId: r1, phase, by: "verify-probe" }, { alone: true, continues: true, before: () => { lateFiles = true; return {}; } }); return null; } catch (e) { return e; } })();
    safe(`…its run was taken over and the replacement ended done → its late \`${phase}\` is refused (RunReplaced 'replaced by run ${r2} (done)'), \`before\` never runs, the live and published status stay the replacement's`, () =>
      r2done.phase === "done" && late instanceof VR.RunReplaced && late.message === `run ${r1} was replaced by run ${r2} (done) while this probe ran — nothing more is written in it`
        && !lateFiles && fs.readFileSync(live, "utf8") === liveBefore && fs.readFileSync(VR.statusFile(base), "utf8") === pubBefore);
  }
  {
    // the replacement is still OPEN and itself abandoned (its probe's pid is gone, still measuring): the late write is
    // refused as replaced — never taken for the next own run that ends the replacement and records the late run over it
    VR.writeStatus(base, { runId: "r1-late-open", phase: "measuring", by: "verify-probe", ownRun: own(process.pid, os.hostname(), "2026-01-01T00:00:00.000Z") }, { alone: true });
    VR.writeStatus(base, { runId: "r2-gone", phase: "measuring", by: "verify-probe", ownRun: own(deadPid) }, { alone: true, abandoned: () => {} });
    const openBefore = fs.readFileSync(live, "utf8");
    let lateFiles = false, endedIt = false;
    const late = ((): unknown => { try { VR.writeStatus(base, { runId: "r1-late-open", phase: "done", by: "verify-probe" }, { alone: true, continues: true, abandoned: () => { endedIt = true; }, before: () => { lateFiles = true; return {}; } }); return null; } catch (e) { return e; } })();
    safe("…its run was taken over and the replacement is still open but abandoned (pid gone) → its late `done` is refused (RunReplaced 'replaced by run r2-gone (measuring)'): the replacement is not ended, `before` never runs, the status byte-identical", () =>
      VR.abandonedRun(VR.readStatus(base), "r1-late-open") !== null && late instanceof VR.RunReplaced && late.message === "run r1-late-open was replaced by run r2-gone (measuring) while this probe ran — nothing more is written in it"
        && !endedIt && !lateFiles && fs.readFileSync(live, "utf8") === openBefore);
    VR.writeStatus(base, { runId: "r2-gone", phase: "failed", by: "verify-probe" });
  }
  safe("…the same late write without `continues` (its `measuring` was never recorded) is not refused for another run's status", () =>
    VR.writeStatus(base, { runId: "r1-lone", phase: "measuring", by: "verify-probe" }, { alone: true }).rev === 1);
  safe("replacedRun: the one refusal — the status names another v2 run in any phase; never its own run, a v1 file or no status", () => {
    const st = VR.readStatus(base);
    return VR.replacedRun(st, "r-other") instanceof VR.RunReplaced && VR.replacedRun(st, "r1-lone") === null && VR.replacedRun("v1", "x") === null && VR.replacedRun(null, "x") === null;
  });
  VR.writeStatus(base, { runId: "r1-lone", phase: "failed", by: "verify-probe" });
  const overdueDoc = fs.readFileSync(live, "utf8");

  // a malformed ownRun is ignored: the status reads as a run nobody's probe owns (never as no status)
  const parsed: unknown = JSON.parse(overdueDoc);
  const malformed = isJsonObject(parsed) ? { ...parsed, runId: "run-bad", phase: "measuring", ownRun: { pid: "nope" } } : {};
  fs.writeFileSync(live, JSON.stringify(malformed, null, 2) + "\n");
  const readBad = VR.readStatus(base);
  const refusedBad = ((): unknown => { try { VR.writeStatus(base, { runId: "run-b2", phase: "measuring", by: "verify-probe" }, { alone: true }); return null; } catch (e) { return e; } })();
  safe("a live status with a malformed ownRun → read as v2 without it (not 'no status'); the next probe without --run is refused in the verifier wording", () =>
    readBad !== null && readBad !== "v1" && readBad.runId === "run-bad" && readBad.ownRun === undefined && refusedBad instanceof VR.RunOpen && /that run's verifier passes --run run-bad/.test(refusedBad.message));

  // the published copy carries no pid or host: the project commits it
  const withOwn = VR.writeStatus(base, { runId: "run-pub", phase: "done", by: "verify-probe", ownRun: own(process.pid) });
  VR.publishStatus(base, withOwn);
  const published: unknown = JSON.parse(fs.readFileSync(VR.statusFile(base), "utf8"));
  safe("publishStatus writes the done doc WITHOUT ownRun (no pid, no host in design/verify), the rest as the live one", () =>
    withOwn.ownRun !== undefined && isJsonObject(published) && !("ownRun" in published) && JSON.stringify({ ...published, ownRun: withOwn.ownRun }) === JSON.stringify({ ...withOwn }));
});

// the probe passes `alone` on its own run's writes: a run that opens while it runs is never written over (fast — a fake launch writes it)
console.log("verify-probe without --run — another run opened while it runs:");
await block("verify-probe own run alone:", async () => {
  const { dir, live } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  const d = mk("dt-run-fakepw-");
  fs.writeFileSync(path.join(d, "package.json"), "{}");
  const pw = path.join(d, "node_modules", "playwright");
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, "package.json"), JSON.stringify({ name: "playwright", version: "1.60.0", main: "index.js" }));
  // launch (after the probe's `measuring` write) puts a verifier's queued run in the live status, then fails: exit 3
  fs.writeFileSync(path.join(pw, "index.js"), "module.exports = { chromium: { launch() { require('fs').writeFileSync(process.env.DT_TEST_LIVE, process.env.DT_TEST_DOC); throw new Error('fake'); } } };\n");
  const queued = JSON.stringify({ schema: VR.STATUS_SCHEMA, screen: "Plots__1_1", runId: "run-q", rev: 1, phase: "queued", detail: "", at: new Date().toISOString(), by: "orchestrator" }, null, 2) + "\n";
  const p = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", d], { env: { ...process.env, DT_TEST_LIVE: live, DT_TEST_DOC: queued } });
  safe("a run queued while the probe's own run measures → its `failed` write is refused (RunOpen): exit 2, not 3, and the queued run's status byte-identical",
    () => p.status === 2 && fs.readFileSync(live, "utf8") === queued && p.stderr.includes("verify-probe: another run opened while this probe ran; nothing is written — run run-q of Plots__1_1 is open (phase queued, rev 1, by orchestrator, "));
  if (p.status !== 2) console.log(p.stderr);
  // its own run's deadline passes while it runs (the fake launch moves it into the past) and nobody takes it over: its
  // `failed` write goes through (exit 3) — the run is not left at measuring
  VR.writeStatus(path.join(dir, "Plots__1_1"), { runId: "run-q", phase: "failed", by: "orchestrator" });
  fs.writeFileSync(path.join(pw, "index.js"), "module.exports = { chromium: { launch() { const fs = require('fs'); const f = process.env.DT_TEST_LIVE; const d = require(f); " +
    "d.ownRun.deadline = '2026-01-01T00:00:00.000Z'; fs.writeFileSync(f, JSON.stringify(d)); throw new Error('fake'); } } };\n");
  const late = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", d], { env: { ...process.env, DT_TEST_LIVE: live } });
  const lateSt = readStatusFile(live);
  safe("its own run past its deadline while it runs, nobody took it over → its `failed` write goes through: exit 3, the run ended failed (not left at measuring)",
    () => late.status === 3 && lateSt?.phase === "failed" && lateSt.ownRun?.deadline === "2026-01-01T00:00:00.000Z" && lateSt.detail === "probe exit 3 — nothing written");
  if (late.status !== 3) console.log(late.stderr);
  // its run is taken over and the replacement has ENDED while it runs (the fake launch writes that replacement): its
  // `failed` write is refused — never a record over the run that replaced it
  const replacement = JSON.stringify({ schema: VR.STATUS_SCHEMA, screen: "Plots__1_1", runId: "run-b", rev: 2, phase: "done", detail: "", at: new Date().toISOString(), by: "verify-probe" }, null, 2) + "\n";
  fs.writeFileSync(path.join(pw, "index.js"), "module.exports = { chromium: { launch() { require('fs').writeFileSync(process.env.DT_TEST_LIVE, process.env.DT_TEST_DOC); throw new Error('fake'); } } };\n");
  const taken = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", d], { env: { ...process.env, DT_TEST_LIVE: live, DT_TEST_DOC: replacement } });
  safe("its run replaced by one that has ended (done) while it runs → its `failed` write is refused (RunReplaced): exit 2, the replacement's status byte-identical",
    () => taken.status === 2 && fs.readFileSync(live, "utf8") === replacement && /was replaced by run run-b \(done\) while this probe ran — nothing more is written in it/.test(taken.stderr));
  if (taken.status !== 2) console.log(taken.stderr);
});

// ---------------------------------------------------------------- M-a: the run cache stays inside the project
console.log("the run cache stays inside the project (M-a):");
const CACHE = path.join("node_modules", ".cache", "designtwin-verify");
const inTmp = (live: string): boolean => live.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep);
await block("the run cache stays inside the project (M-a):", async () => {
  // an unrelated ancestor has a node_modules (a stray ~/node_modules); the project has none installed yet
  const anc = mk("dt-run-anc-");
  const real = realNative(anc);
  fs.mkdirSync(path.join(anc, "node_modules"));
  const app = path.join(anc, "plots-app");
  fs.mkdirSync(path.join(app, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  const base = path.join(app, "design", "verify", "Plots__1_1");
  safe("an unrelated ancestor's node_modules, none in the project → <project>/node_modules/.cache/designtwin-verify/<S>.status.json (not the ancestor's)",
    () => VR.liveStatusFile(base) === path.join(real, "plots-app", CACHE, "Plots__1_1.status.json"));
  VR.writeStatus(base, { runId: "run-a", phase: "queued", by: "agent" });
  safe("…the write creates <project>/node_modules/.cache/designtwin-verify/ and nothing in the ancestor's node_modules", () =>
    fs.existsSync(path.join(app, CACHE, "Plots__1_1.status.json")) && fs.readdirSync(path.join(anc, "node_modules")).length === 0);
  // the ancestor is a workspace root (workspaces + node_modules) but the project is its own repo (.git): the walk stops there
  fs.writeFileSync(path.join(anc, "package.json"), "{\"name\":\"outer\",\"private\":true,\"workspaces\":[\"*\"]}\n");
  const repo = path.join(anc, "plots-repo");
  fs.mkdirSync(path.join(repo, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"plots-repo\",\"private\":true}\n");
  safe("a workspace root with node_modules ABOVE the project's .git → the project's own cache (never past .git)",
    () => VR.liveStatusFile(path.join(repo, "design", "verify", "Plots__1_1")) === path.join(real, "plots-repo", CACHE, "Plots__1_1.status.json"));
  // the same layout without the .git: the ancestor IS this project's workspace root, dependencies hoisted there
  const member = path.join(anc, "plots-member");
  fs.mkdirSync(path.join(member, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), "{\"name\":\"plots-member\",\"private\":true}\n");
  safe("…without the .git the ancestor is the workspace root (workspaces + node_modules) → its cache, keyed by the verify dir",
    () => path.dirname(VR.liveStatusFile(path.join(member, "design", "verify", "Plots__1_1"))) === path.join(real, CACHE, "dirs", crypto.createHash("sha256").update("plots-member/design/verify").digest("hex").slice(0, 16)));
  // pnpm: pnpm-workspace.yaml marks the root, node_modules there
  const pn = mk("dt-run-pnpm-");
  fs.writeFileSync(path.join(pn, "package.json"), "{\"name\":\"plots-pnpm\",\"private\":true}\n");
  fs.writeFileSync(path.join(pn, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  fs.mkdirSync(path.join(pn, "node_modules"));
  const pnApp = path.join(pn, "apps", "plots");
  fs.mkdirSync(path.join(pnApp, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(pnApp, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  safe("a pnpm workspace (pnpm-workspace.yaml + root node_modules) → the root's cache", () => VR.liveStatusFile(path.join(pnApp, "design", "verify", "Plots__1_1")).startsWith(path.join(realNative(pn), CACHE, "dirs") + path.sep));
  // a design/verify in a repo with no package.json of its own: the package.json search stops at .git too
  const noPkg = path.join(anc, "plots-native");
  fs.mkdirSync(path.join(noPkg, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(noPkg, ".git"));
  const npLive = VR.liveStatusFile(path.join(noPkg, "design", "verify", "Plots__1_1"));
  safe("no package.json inside the repo (.git) → the OS temp dir, never the package.json above the repo", () => inTmp(npLive));
  tmps.push(path.dirname(npLive));
  // Yarn PnP at the workspace root, no node_modules anywhere → temp dir
  const yp = mk("dt-run-pnpws-");
  fs.writeFileSync(path.join(yp, "package.json"), "{\"name\":\"plots-pnp-ws\",\"private\":true,\"workspaces\":[\"apps/*\"]}\n");
  fs.writeFileSync(path.join(yp, ".pnp.cjs"), "// pnp\n");
  const ypApp = path.join(yp, "apps", "plots");
  fs.mkdirSync(path.join(ypApp, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(ypApp, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  const ypLive = VR.liveStatusFile(path.join(ypApp, "design", "verify", "Plots__1_1"));
  safe("Yarn PnP at the workspace root (no node_modules) → the OS temp dir", () => inTmp(ypLive));
  tmps.push(path.dirname(ypLive));
});

console.log("an unwritable run cache — exit 6, one sentence, no stack (M-a):");
await block("an unwritable run cache (M-a):", async () => {
  if (process.platform === "win32") { console.log("  (skipped: mode bits do not make a directory read-only on Windows — chmod 0o555 / 0o000 refuses nothing)"); return; }
  const { cwd, dir, base, live, cli } = project();
  const cache = path.dirname(live);
  fs.mkdirSync(cache, { recursive: true });
  fs.chmodSync(cache, 0o555);
  const s = cli("--status", "Plots__1_1", "--phase", "queued", "--new-run");
  const d = cli("--status", "Plots__1_1", "--phase", "done", "--run", "run-ro", "--publish", mk("dt-run-rostage-"));
  fs.chmodSync(cache, 0o755);
  const msg = /run cache \S+designtwin-verify is not writable \(sandbox write scope\?\) — run from \S+ or allow writes there/;
  safe("--status into a read-only run cache → exit 6, 'run cache <dir> is not writable (sandbox write scope?) — run from <root> or allow writes there'", () =>
    s.status === 6 && msg.test(s.stderr) && s.stderr.includes(realNative(cwd)));
  safe("…no stack trace, nothing on stdout", () => !/\n\s+at /.test(s.stderr) && s.stdout === "");
  safe("…a refused `done --publish` published nothing into design/verify", () => d.status === 6 && !fs.existsSync(path.join(dir, "Plots__1_1.status.json")));
  // --wait on a run cache it cannot read → exit 6 at once, not a --timeout of silence
  VR.writeStatus(base, { runId: "run-w", phase: "driving", by: "agent" });
  fs.chmodSync(cache, 0o000);
  const w = cli("--wait", "Plots__1_1", "--run", "run-w", "--timeout", "5", "--interval", "0.1");
  fs.chmodSync(cache, 0o755);
  safe("--wait on an unreadable run cache → exit 6 naming the cache, no stack", () => w.status === 6 && /run cache \S+ is not readable/.test(w.stderr) && !/\n\s+at /.test(w.stderr));
  // the probe: a refused status write is a warning; the exit contract (here 3: no playwright) holds
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  const noPw = mk("dt-run-nopw2-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  fs.chmodSync(cache, 0o555);
  const p = runSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots__1_1.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-w"]);
  fs.chmodSync(cache, 0o755);
  safe("verify-probe --run with a read-only run cache → still exit 3 (no renderer), a 'warning  run cache … is not writable' line, no stack", () =>
    p.status === 3 && /warning {2}run cache \S+ is not writable \(sandbox write scope\?\)/.test(p.stderr) && !/\n\s+at /.test(p.stderr));
  // the failed attempt could not be counted: the run would sit at its last phase, so the probe says how to end it
  safe("…the attempt is not counted, and a 'status run run-w not counted — …' line says a verify-screen --status write would be refused the same way, so re-run once the cache takes writes — no command to run now",
    () => p.stderr.includes("status run run-w not counted — this failed attempt (exit 3) is not in the run's status (the run cache refused the write). " +
      "Until the run cache takes writes (the warning above says how), no status write of this run is recorded — a verify-screen --status write that ends it would be refused the same way. " +
      "Ask the user to make a renderer available, then re-run the probe once in this run (--run run-w) once it does;")
      && !/--status Plots__1_1 --phase failed --run run-w --detail/.test(p.stderr));
});

// ---------------------------------------------------------------- M-b: one key per directory, whatever its spelling
console.log("one run cache per directory on a case-insensitive filesystem (M-b):");
await block("case-insensitive spellings (M-b):", async () => {
  const cwd = proj("dt-run-case-");
  const insensitive = fs.existsSync(path.join(cwd, "DESIGN"));
  if (!insensitive) { console.log("  (skipped: this filesystem is case-sensitive — Design/Verify is another directory there)"); return; }
  const lower = VR.liveStatusFile(path.join(cwd, "design", "verify", "Plots__1_1"));
  const upper = VR.liveStatusFile(path.join(cwd, "Design", "Verify", "Plots__1_1"));
  safe("`Design/Verify` and `design/verify` → the same live file (the default layout's, not a dirs/<key>/ one)", () => upper === lower && lower === path.join(realNative(cwd), CACHE, "Plots__1_1.status.json"));
  const tmpCase = mk("dt-run-case-bare-");
  fs.mkdirSync(path.join(tmpCase, "design", "verify"), { recursive: true });
  const a = VR.liveStatusFile(path.join(tmpCase, "design", "verify", "Plots__1_1")), b = VR.liveStatusFile(path.join(tmpCase, "DESIGN", "verify", "Plots__1_1"));
  safe("…and the temp-dir fallback keys both spellings to one directory", () => a === b);
  tmps.push(path.dirname(a));
});

for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
// a printed argument is ONE shell word whatever it holds — the shell gives back exactly the string
if (POSIX_SH === null) console.log("  (skipped: no sh on PATH to round-trip the quoting through)");
else {
  const sh = POSIX_SH;
  const words = ["design/verify/Plots__1_1.json", "/tmp/My Plots__1_1/design/verify", "it's here", "a!b c", "$HOME `x` \\ \"q\""];
  const back = words.map((w) => spawnSync(sh, ["-c", `printf %s ${shellArg(w)}`], { encoding: "utf8" }).stdout);
  check("shellArg: a plain path stays bare; spaces, quotes, !, $, backticks and backslashes round-trip through sh as one word",
    shellArg(words[0] ?? "") === words[0] && back.every((b, i) => b === words[i]));
}

report();
