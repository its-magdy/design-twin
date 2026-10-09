// one verification run on disk: status v2 written by the tools, atomic
// writes, --publish from a staging directory, and --wait on a run. Runs design-to-code/verify-run.ts in-process
// and `verify-screen --status / --wait` as the CLI, in temp projects (invented names).
// Run with:  node test/verify-run.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as VR from "../design-to-code/verify-run.ts";
import { shellArg } from "../design-to-code/cli-args.ts";
import { readJsonOrNull } from "../design-to-code/read-json.ts";
import { check, report } from "./assert.ts";

const safe = (name: string, fn: () => boolean): boolean => { let r = false; try { r = fn(); } catch (e) { console.log(`    (threw: ${e instanceof Error ? e.message : String(e)})`); } return check(name, r); };
const VS_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-screen.ts");
const sha = (f: string): string => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
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
  const base = path.join(d, "Plots");
  const a1 = VR.writeStatus(base, { runId: "run-a", phase: "measuring", by: "verify-probe" });
  const a2 = VR.writeStatus(base, { runId: "run-a", phase: "measured", by: "verify-probe", measuredSha256: "1".repeat(64) });
  const b1 = VR.writeStatus(base, { runId: "run-b", phase: "queued", by: "orchestrator" });
  safe("rev counts writes within a run (1, 2), and restarts at 1 for a new run", () => a1.rev === 1 && a2.rev === 2 && b1.rev === 1);
  const onDisk = readStatusFile(VR.liveStatusFile(base));
  tmps.push(path.dirname(VR.liveStatusFile(base)));
  safe("the file is status v2: schema, screen = the base name, machine ISO time, by", () => onDisk !== null && onDisk.schema === VR.STATUS_SCHEMA && onDisk.screen === "Plots" && onDisk.runId === "run-b"
    && !Number.isNaN(Date.parse(onDisk.at)) && onDisk.by === "orchestrator");
  fs.rmSync(VR.liveStatusFile(base));
  fs.writeFileSync(base + ".status.json", JSON.stringify({ screen: "Plots", phase: "done", detail: "measured 12 nodes", at: "2026-09-29T19:22:52Z" }));
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
  const real = fs.realpathSync(cwd);
  const base = path.join(cwd, "design", "verify", "Plots");
  safe("a project with node_modules → <project>/node_modules/.cache/designtwin-verify/<S>.status.json", () => VR.liveStatusFile(base) === path.join(real, "node_modules", ".cache", "designtwin-verify", "Plots.status.json"));
  safe("…the stage dir of a run is <run cache>/stage/<runId>/", () => VR.stageDirOf(base, "run-a") === path.join(real, "node_modules", ".cache", "designtwin-verify", "stage", "run-a"));
  const prevCwd = process.cwd();
  process.chdir(path.join(cwd, "design"));
  const viaRelative = VR.liveStatusFile(path.join("verify", "Plots"));
  process.chdir(prevCwd);
  safe("the same file from a relative path and another cwd (one key for verifier, probe and caller)", () => viaRelative === VR.liveStatusFile(base));
  const other = proj();
  safe("two projects never share a live file", () => VR.liveStatusFile(path.join(other, "design", "verify", "Plots")) !== VR.liveStatusFile(base));
  safe("a verify dir other than design/verify gets its own dirs/<key>/ in the cache", () => VR.liveStatusFile(path.join(cwd, "qa", "Plots")).startsWith(path.join(real, "node_modules", ".cache", "designtwin-verify", "dirs") + path.sep));
  const bare = mk("dt-run-bare-");
  fs.mkdirSync(path.join(bare, "design", "verify"), { recursive: true });
  const bareLive = VR.liveStatusFile(path.join(bare, "design", "verify", "Plots"));
  safe("no node_modules → <os tmpdir>/designtwin-verify/<short sha of the verify dir's realpath>/", () => bareLive.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep)
    && path.basename(path.dirname(bareLive)) === crypto.createHash("sha256").update(fs.realpathSync(path.join(bare, "design", "verify"))).digest("hex").slice(0, 16));
  tmps.push(path.dirname(bareLive));
});

// a monorepo with hoisted dependencies — node_modules only at the workspace root, none beside the app's package.json
await block("the run cache in a monorepo:", async () => {
  const ws = mk("dt-run-ws-");
  const real = fs.realpathSync(ws);
  fs.writeFileSync(path.join(ws, "package.json"), "{\"name\":\"plots-ws\",\"private\":true,\"workspaces\":[\"apps/*\"]}\n");
  fs.mkdirSync(path.join(ws, "node_modules"));
  const app = path.join(ws, "apps", "plots");
  fs.mkdirSync(path.join(app, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  const fromApp = (() => { const prev = process.cwd(); process.chdir(app); try { return VR.liveStatusFile(path.join("design", "verify", "Plots")); } finally { process.chdir(prev); } })();
  const fromRoot = (() => { const prev = process.cwd(); process.chdir(ws); try { return VR.liveStatusFile(path.join("apps", "plots", "design", "verify", "Plots")); } finally { process.chdir(prev); } })();
  const fromAbs = VR.liveStatusFile(path.join(app, "design", "verify", "Plots"));
  const cache = path.join(real, "node_modules", ".cache", "designtwin-verify");
  safe("root node_modules only → the live file is under <workspace root>/node_modules/.cache/designtwin-verify/, never the os tmpdir", () => fromAbs.startsWith(cache + path.sep) && !fromAbs.startsWith(path.join(os.tmpdir(), "designtwin-verify")));
  safe("…the same file from the app's cwd, the workspace root's cwd and an absolute path", () => fromApp === fromAbs && fromRoot === fromAbs);
  safe("…keyed by the verify dir's path relative to the root (apps/plots/design/verify → dirs/<key>/)", () => path.dirname(fromAbs) === path.join(cache, "dirs", crypto.createHash("sha256").update("apps/plots/design/verify").digest("hex").slice(0, 16)));
  const other = path.join(ws, "apps", "charts", "design", "verify");
  fs.mkdirSync(other, { recursive: true });
  safe("…two apps of one workspace never share a live file", () => VR.liveStatusFile(path.join(other, "Plots")) !== fromAbs);
  // Yarn PnP-like: package.json + .pnp.cjs, no node_modules anywhere above → the tmpdir fallback
  const pnp = mk("dt-run-pnp-");
  fs.writeFileSync(path.join(pnp, "package.json"), "{\"name\":\"plots-pnp\",\"private\":true}\n");
  fs.writeFileSync(path.join(pnp, ".pnp.cjs"), "// pnp\n");
  fs.mkdirSync(path.join(pnp, "design", "verify"), { recursive: true });
  const pnpLive = VR.liveStatusFile(path.join(pnp, "design", "verify", "Plots"));
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
type Cli = (...a: string[]) => ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
function project(): { cwd: string; dir: string; base: string; live: string; cli: Cli } {
  const cwd = proj();
  const dir = path.join(cwd, "design", "verify");
  fs.writeFileSync(path.join(dir, "Plots.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "1:1", name: "Plots" }, nodes: [] }, null, 2) + "\n");
  const cli: Cli = (...a: string[]) => spawnSync(process.execPath, [VS_TS, ...a], { cwd, encoding: "utf8" });
  const base = path.join(dir, "Plots");
  return { cwd, dir, base, live: VR.liveStatusFile(base), cli };
}
const measuredFor = (dir: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ expectationSha256: sha(path.join(dir, "Plots.expected.json")), nodes: [], ...extra });
await block("verify-screen --status:", async () => {
  const { cwd, dir, live, cli } = project();
  const before = treeState(cwd);
  const s1 = cli("--status", "Plots", "--phase", "starting", "--new-run", "--detail", "renderer check");
  const m = /^run (\S+) rev 1$/m.exec(s1.stdout);
  const runId = m ? m[1] ?? "" : "";
  safe("--new-run prints `run <id> rev 1` and writes the LIVE status (run cache); stderr names that file", () => s1.status === 0 && runId !== "" && readStatusFile(live)?.detail === "renderer check" && s1.stderr.includes(`status ${fs.realpathSync(path.dirname(live))}`));
  const s2 = cli("--status", "Plots", "--phase", "driving");
  cli("--status", "Plots", "--phase", "driving", "--detail", "heartbeat");
  safe("no --run continues the run in progress (rev 2, same id)", () => s2.status === 0 && s2.stdout.trim() === `run ${runId} rev 2`);
  safe("heartbeats never create or modify anything in the project tree (outside node_modules) — design/verify has no status file", () => treeState(cwd) === before && !fs.existsSync(path.join(dir, "Plots.status.json")));
  safe("an unknown phase → exit 2, nothing changed", () => cli("--status", "Plots", "--phase", "comparing").status === 2 && readStatusFile(live)?.rev === 3);
  safe("--run and --new-run together → exit 2", () => cli("--status", "Plots", "--phase", "starting", "--run", "x", "--new-run").status === 2);
  safe("--run that is not a run id → exit 2", () => cli("--status", "Plots", "--phase", "starting", "--run", "../x").status === 2);
  const d0 = cli("--status", "Plots", "--phase", "done", "--run", runId);
  safe("done with no measured file → refused, exit 1", () => d0.status === 1 && /measured\.json does not exist/.test(d0.stderr));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), nodes: [] }));
  const d1 = cli("--status", "Plots", "--phase", "done", "--run", runId);
  safe("done with a measured file taken against another expectation → refused, exit 1", () => d1.status === 1 && /measured against expectation 000000000000…/.test(d1.stderr));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), JSON.stringify({ nodes: [] }));
  safe("done with a measured file naming no expectation → refused, exit 1", () => cli("--status", "Plots", "--phase", "done", "--run", runId).status === 1);
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "another-run" }));
  const d4 = cli("--status", "Plots", "--phase", "done", "--run", runId);
  safe("done with a measured file whose runId is another run → refused, exit 1", () => d4.status === 1 && /measured in run another-run/.test(d4.stderr));
  safe("…and no refused done published a status into design/verify", () => !fs.existsSync(path.join(dir, "Plots.status.json")));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId }));
  fs.writeFileSync(path.join(dir, "Plots.evidence.json"), JSON.stringify({ interactions: [] }));
  const d2 = cli("--status", "Plots", "--phase", "done", "--run", runId);
  const st = readStatusFile(live);
  safe("done with the right measured file → exit 0; the status names the expected and measured shas", () => d2.status === 0 && st?.phase === "done"
    && st.expectationSha256 === sha(path.join(dir, "Plots.expected.json")) && st.measuredSha256 === sha(path.join(dir, "Plots.measured.json")));
  safe("done publishes the final status into design/verify/Plots.status.json (the same document as the live one)", () => fs.existsSync(path.join(dir, "Plots.status.json")) && fs.readFileSync(path.join(dir, "Plots.status.json"), "utf8") === fs.readFileSync(live, "utf8"));
  safe("an evidence file this run never published is not hashed as this run's", () => st?.evidenceSha256 === undefined && /was not published in run/.test(d2.stderr));
  const c1 = cli("--status", "Plots", "--phase", "driving");
  safe("no --run after the run ended (done) → exit 2 'pass --run <id> or --new-run'", () => c1.status === 2 && /pass --run <id> or --new-run/.test(c1.stderr));
  fs.rmSync(live);
  fs.writeFileSync(path.join(dir, "Plots.status.json"), JSON.stringify({ screen: "Plots", phase: "driving", detail: "hand-written", at: "2026-09-29T19:22:52Z" }));
  const c2 = cli("--status", "Plots", "--phase", "driving");
  safe("no --run over an older hand-written (v1) status → exit 2", () => c2.status === 2 && /pass --run <id> or --new-run/.test(c2.stderr));
  fs.rmSync(path.join(dir, "Plots.status.json"));
  safe("no --run and no status at all → exit 2", () => cli("--status", "Plots", "--phase", "starting").status === 2);
  safe("the published status is read when there is no live one (a v2 fallback)", () => {
    VR.publishStatus(path.join(dir, "Plots"), { schema: VR.STATUS_SCHEMA, screen: "Plots", runId: "run-old", rev: 4, phase: "done", detail: "", at: "2026-09-30T00:00:00Z", by: "agent" });
    const r = VR.readStatusAt(path.join(dir, "Plots"));
    return r !== null && r.file === path.join(dir, "Plots.status.json") && r.status !== "v1" && r.status.runId === "run-old";
  });
});

console.log("done — the probe's record of this run:");
await block("done — the probe's record of this run:", async () => {
  const { dir, base, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-p" }));
  // the probe wrote `measured` naming the file it wrote; an agent heartbeat followed (the sha carries forward)
  VR.writeStatus(base, { runId: "run-p", phase: "measured", by: "verify-probe", measuredSha256: sha(path.join(dir, "Plots.measured.json")) });
  VR.writeStatus(base, { runId: "run-p", phase: "driving", by: "agent" });
  safe("a later write of the same run still names the probe's measured sha", () => { const st = VR.readStatus(base); return st !== null && st !== "v1" && st.measuredSha256 === sha(path.join(dir, "Plots.measured.json")); });
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-p", nodes: [{ nodeId: "9:9", styles: {} }] }));
  const d = cli("--status", "Plots", "--phase", "done", "--run", "run-p");
  safe("the measured file changed since the probe recorded it in this run → done refused, exit 1", () => d.status === 1 && /recorded measured file/.test(d.stderr));
});

console.log("verify-screen --status --publish (staging):");
await block("verify-screen --status --publish (staging):", async () => {
  const { cwd, dir, base, live, cli } = project();
  const s = cli("--status", "Plots", "--phase", "driving", "--new-run");
  const runId = /^run (\S+) rev 1$/m.exec(s.stdout)?.[1] ?? "";
  const stage = VR.stageDirOf(base, runId);
  safe("--status prints and creates the run's stage dir in the run cache", () => s.stderr.includes(`stage  ${stage}`) && fs.statSync(stage).isDirectory());
  fs.writeFileSync(path.join(stage, "Plots.evidence.json"), JSON.stringify({ interactions: [{ nodeId: "2:4", trigger: "on_click", ok: true }] }));
  fs.writeFileSync(path.join(stage, "Plots-dialog.png"), "png bytes");
  fs.mkdirSync(path.join(stage, "nested"));
  const p = cli("--status", "Plots", "--phase", "driving", "--run", runId, "--publish", stage);
  const st = readStatusFile(live);
  safe("copies every regular file of the stage dir into design/verify; the status lists them", () => p.status === 0
    && fs.readFileSync(path.join(dir, "Plots-dialog.png"), "utf8") === "png bytes" && fs.existsSync(path.join(dir, "Plots.evidence.json"))
    && JSON.stringify(st?.published) === JSON.stringify(["Plots-dialog.png", "Plots.evidence.json"]) && !fs.existsSync(path.join(dir, "nested")));
  safe("…through a tmp file in the target dir: none left behind", () => !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  fs.writeFileSync(path.join(stage, "Plots.report.json"), "{}");
  fs.writeFileSync(path.join(stage, "Plots-dialog.png"), "changed");
  const r = cli("--status", "Plots", "--phase", "driving", "--run", runId, "--publish", stage);
  safe("a stage dir holding a tool-owned file (report/expected/status) → refused, exit 1, nothing copied", () => r.status === 1 && fs.readFileSync(path.join(dir, "Plots-dialog.png"), "utf8") === "png bytes" && !fs.existsSync(path.join(dir, "Plots.report.json")));
  safe("publishing the verify dir into itself → refused", () => "error" in VR.publishStaged(dir, dir));
  // the same directory spelt through a symlink (or a ../ path) is still the verify dir — compared by realpath
  const alias = path.join(cwd, "verify-alias");
  fs.symlinkSync(dir, alias);
  const aliasR = VR.publishStaged(alias, dir);
  safe("a symlink to the verify dir as the stage dir → refused (realpath), nothing copied", () => "error" in aliasR && aliasR.error.includes("verify directory itself"));
  safe("…and a ../ spelling of it → refused", () => "error" in VR.publishStaged(path.join(dir, "..", "verify"), dir));
  fs.unlinkSync(alias);
  fs.rmSync(path.join(stage, "Plots.report.json"));
  // statusRun writes the status between prepare and commit — a refused write aborts, publishing nothing
  const prep = VR.prepareStaged(stage, dir);
  const prepped = "files" in prep && fs.readFileSync(prep.tmpOf("Plots-dialog.png"), "utf8") === "changed" && fs.readFileSync(path.join(dir, "Plots-dialog.png"), "utf8") === "png bytes";
  if ("files" in prep) prep.abort();
  safe("prepareStaged copies beside the destination without replacing it; abort removes the copies, the published file unchanged",
    () => prepped && fs.readFileSync(path.join(dir, "Plots-dialog.png"), "utf8") === "png bytes" && !fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
  // done validates BEFORE it publishes — and validates the staged measured file when the stage holds one
  fs.writeFileSync(path.join(stage, "Plots.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), nodes: [] }));
  fs.writeFileSync(path.join(stage, "Plots-hover.png"), "hover");
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir));
  const bad = cli("--status", "Plots", "--phase", "done", "--run", runId, "--publish", stage);
  safe("done --publish with a staged measured file taken against another expectation → refused, NOTHING copied", () => bad.status === 1 && /measured against expectation/.test(bad.stderr)
    && !fs.existsSync(path.join(dir, "Plots-hover.png")) && fs.readFileSync(path.join(dir, "Plots-dialog.png"), "utf8") === "png bytes");
  fs.writeFileSync(path.join(stage, "Plots.measured.json"), measuredFor(dir, { runId }));
  const ok = cli("--status", "Plots", "--phase", "done", "--run", runId, "--publish", stage);
  const fin = readStatusFile(live);
  safe("…a good staged measured file → done: published, measuredSha256 = the staged (now published) file", () => ok.status === 0 && fin?.phase === "done" && fs.existsSync(path.join(dir, "Plots-hover.png"))
    && fin.measuredSha256 === sha(path.join(dir, "Plots.measured.json")) && fin.measuredSha256 === sha(path.join(stage, "Plots.measured.json")));
  safe("evidence published in this run is hashed at done", () => fin?.evidenceSha256 === sha(path.join(dir, "Plots.evidence.json")));
});

// `--phase measured` is the probe's recovery when its own `measured` write was refused — it records the measured
// file's sha after the same checks done applies, so compare and done can tell the file apart from a later one
console.log("--status --phase measured — the recovery records the measured file:");
await block("--status --phase measured:", async () => {
  const { dir, base, live, cli } = project();
  cli("--status", "Plots", "--phase", "measuring", "--run", "run-r");
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-r" }));
  const m = cli("--status", "Plots", "--phase", "measured", "--run", "run-r");
  const st = readStatusFile(live);
  safe("measured with the right file → exit 0; the status names its measuredSha256 and expectationSha256", () => m.status === 0 && st?.phase === "measured"
    && st.measuredSha256 === sha(path.join(dir, "Plots.measured.json")) && st.expectationSha256 === sha(path.join(dir, "Plots.expected.json")));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-r", nodes: [{ nodeId: "9:9", styles: {} }] }));
  const d = cli("--status", "Plots", "--phase", "done", "--run", "run-r");
  safe("…the file changed after that record → done refused 'recorded measured file', exit 1", () => d.status === 1 && /recorded measured file/.test(d.stderr));
  const { dir: dir2, base: base2, live: live2, cli: cli2 } = project();
  cli2("--status", "Plots", "--phase", "measuring", "--run", "run-s");
  fs.writeFileSync(path.join(dir2, "Plots.measured.json"), JSON.stringify({ expectationSha256: "0".repeat(64), runId: "run-s", nodes: [] }));
  const x1 = cli2("--status", "Plots", "--phase", "measured", "--run", "run-s");
  safe("measured with a file taken against another expectation → refused, exit 1, the status unchanged", () => x1.status === 1 && /measured against expectation 000000000000…/.test(x1.stderr) && readStatusFile(live2)?.phase === "measuring");
  fs.writeFileSync(path.join(dir2, "Plots.measured.json"), measuredFor(dir2, { runId: "run-other" }));
  const x2 = cli2("--status", "Plots", "--phase", "measured", "--run", "run-s");
  safe("measured with a file of another run → refused, exit 1", () => x2.status === 1 && /measured in run run-other/.test(x2.stderr));
  fs.rmSync(path.join(dir2, "Plots.measured.json"));
  safe("measured with no measured file → refused, exit 1", () => cli2("--status", "Plots", "--phase", "measured", "--run", "run-s").status === 1);
  // the probe wrote into the run's stage dir (--out <stage>/Plots): that file is the one recorded
  const stage = VR.stageDirOf(base2, "run-s");
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, "Plots.measured.json"), measuredFor(dir2, { runId: "run-s" }));
  const x3 = cli2("--status", "Plots", "--phase", "measured", "--run", "run-s");
  safe("…a measured file in the run's stage dir → recorded (its sha)", () => x3.status === 0 && readStatusFile(live2)?.measuredSha256 === sha(path.join(stage, "Plots.measured.json")));
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
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir));
  fs.writeFileSync(path.join(stage, "Plots-hover.png"), "hover");
  // file-write-create denied in the run cache: access(W_OK) on it still succeeds, creating a file there does not
  const profile = `(version 1)(allow default)(deny file-write-create (subpath ${JSON.stringify(fs.realpathSync(cache))}))`;
  const probeAccess = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", `require("fs").accessSync(${JSON.stringify(cache)}, 2)`], { encoding: "utf8" });
  if (probeAccess.status !== 0) { console.log(`  (skipped: sandbox-exec unavailable here or access() refused too: ${probeAccess.stderr.split("\n")[0]})`); return; }
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, VS_TS, "--status", "Plots", "--phase", "done", "--run", "run-sb", "--publish", stage], { cwd, encoding: "utf8" });
  safe("[write probe] done --publish where the run cache refuses file creation (access(W_OK) still ok) → exit 6 BEFORE publishing: nothing copied into design/verify", () =>
    r.status === 6 && /is not writable/.test(r.stderr) && !fs.existsSync(path.join(dir, "Plots-hover.png")) && !fs.existsSync(path.join(dir, "Plots.status.json")));
  safe("[write probe] …and no probe file is left in the run cache", () => !fs.readdirSync(cache).some((f) => f.startsWith(".w-")));
  void base;
});

// the run cache vanished (node_modules removed / reinstalled mid-run) — its own sentence, still exit 6
console.log("a run cache that disappeared:");
await block("a run cache that disappeared:", async () => {
  const cwd = mk("dt-run-gone-");
  fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd, "design", "verify"), { recursive: true });
  // node_modules mid-reinstall: a link to a directory that is gone — every write under it is ENOENT
  fs.symlinkSync(path.join(cwd, "gone-node-modules"), path.join(cwd, "node_modules"));
  const r = spawnSync(process.execPath, [VS_TS, "--status", "Plots", "--phase", "queued", "--new-run"], { cwd, encoding: "utf8" });
  safe("--status into a run cache that no longer exists → exit 6, 'run cache <dir> disappeared — was node_modules reinstalled during the run?', not 'not writable'", () =>
    r.status === 6 && /run cache \S+ disappeared — was node_modules reinstalled during the run\?/.test(r.stderr) && !/not writable/.test(r.stderr) && !/\n\s+at /.test(r.stderr));
  safe("the class says the same for ENOENT; a permission refusal keeps 'not writable (sandbox write scope?)'", () =>
    /disappeared — was node_modules reinstalled/.test(new VR.RunCacheUnwritable("/c", "/r", "ENOENT").message) && /not writable \(sandbox write scope\?\)/.test(new VR.RunCacheUnwritable("/c", "/r", "EACCES").message));
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
  const subLive = VR.liveStatusFile(path.join(sub, "design", "verify", "Plots"));
  safe("a submodule (.git is a file) with no package.json inside → the OS temp dir, never the package.json above it", () => inTmpDir(subLive));
  tmps.push(path.dirname(subLive));
  const { cwd, live } = project();
  const t0 = Date.now();
  const w = spawnSync(process.execPath, [VS_TS, "--wait", "Plots", "--run", "run-none", "--timeout", "0.5", "--interval", "0.1"], { cwd, encoding: "utf8" });
  safe("--wait before any run cache exists → keeps waiting and ends on --timeout (exit 5), not 'not readable' (6)", () =>
    !fs.existsSync(path.dirname(live)) && w.status === 5 && /timed out after 0.5s/.test(w.stderr) && Date.now() - t0 >= 400);
});

// printed commands run as printed from a project whose path holds a space
console.log("printed commands quote their paths:");
await block("printed commands quote paths:", async () => {
  const cwd = mk("dt run space-");
  fs.writeFileSync(path.join(cwd, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  fs.mkdirSync(path.join(cwd, "node_modules"));
  const dir = path.join(cwd, "design", "verify");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Plots.expected.json"), JSON.stringify({ schema: "designtwin/verify-expectation@2", frame: { nodeId: "1:1", name: "Plots" }, nodes: [] }, null, 2) + "\n");
  const cli = (...a: string[]) => spawnSync(process.execPath, [VS_TS, ...a], { cwd: os.tmpdir(), encoding: "utf8" });
  const s = cli("--status", "Plots", "--phase", "driving", "--run", "run-q", "--dir", dir);
  const stageLine = /^stage {2}(.+)$/m.exec(s.stderr)?.[1] ?? "";
  const echoed = spawnSync("/bin/sh", ["-c", `printf %s ${stageLine}`], { encoding: "utf8" }).stdout;
  safe("--status prints the stage dir as one shell word (the path holds a space)", () => s.status === 0 && echoed === VR.stageDirOf(path.join(dir, "Plots"), "run-q"));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-q" }));
  cli("--status", "Plots", "--phase", "done", "--run", "run-q", "--dir", dir);
  const w = cli("--wait", "Plots", "--run", "run-q", "--dir", dir, "--timeout", "5", "--interval", "0.1");
  const ran = spawnSync("/bin/sh", ["-c", w.stdout.trim()], { cwd: os.tmpdir(), encoding: "utf8" });
  safe("--wait's printed --compare runs as printed from another directory (exit 0/1, the report written beside the measured file)", () =>
    w.status === 0 && (ran.status === 0 || ran.status === 1) && fs.existsSync(path.join(dir, "Plots.report.json")));
});

// an ended run stays ended — a write after done/failed/blocked would replace its phase and detail
console.log("verify-screen --status — a run that ended takes no more writes:");
await block("verify-screen --status after an ended run:", async () => {
  const { dir, live, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir));
  cli("--status", "Plots", "--phase", "measured", "--run", "run-blk");
  cli("--status", "Plots", "--phase", "blocked", "--run", "run-blk", "--detail", "blocked on permissions: compare remaining");
  const before = fs.readFileSync(live, "utf8");
  const stage = mk("dt-run-endstage-");
  fs.writeFileSync(path.join(stage, "Plots.evidence.json"), JSON.stringify({ interactions: [] }));
  const d1 = cli("--status", "Plots", "--phase", "done", "--run", "run-blk", "--by", "orchestrator", "--publish", stage);
  safe("blocked → done in the same run: exit 2, 'run <id> already ended at blocked (<detail>) — start a new run with --new-run'", () => d1.status === 2
    && d1.stderr.includes("run run-blk already ended at blocked (blocked on permissions: compare remaining) — start a new run with --new-run"));
  safe("…the status is unchanged (still blocked, same rev and detail), nothing published into design/verify", () => fs.readFileSync(live, "utf8") === before
    && !fs.existsSync(path.join(dir, "Plots.status.json")) && !fs.existsSync(path.join(dir, "Plots.evidence.json")));
  cli("--status", "Plots", "--phase", "failed", "--run", "run-fld", "--detail", "renderer gone");
  const d2 = cli("--status", "Plots", "--phase", "done", "--run", "run-fld");
  safe("failed → done in the same run: exit 2, names the failed phase and its detail; status stays failed", () => d2.status === 2
    && d2.stderr.includes("run run-fld already ended at failed (renderer gone)") && readStatusFile(live)?.phase === "failed");
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir, { runId: "run-dn" }));
  cli("--status", "Plots", "--phase", "done", "--run", "run-dn");
  const doneDoc = fs.readFileSync(live, "utf8");
  const d3 = cli("--status", "Plots", "--phase", "measuring", "--run", "run-dn");
  safe("done → measuring in the same run: exit 2 'already ended at done — start a new run'; the done status is unchanged", () => d3.status === 2
    && d3.stderr.includes("run run-dn already ended at done — start a new run with --new-run") && fs.readFileSync(live, "utf8") === doneDoc);
  cli("--status", "Plots", "--phase", "blocked", "--run", "run-blk2", "--detail", "blocked again");
  const n = cli("--status", "Plots", "--phase", "starting", "--new-run");
  safe("…a new run after a blocked one is written (exit 0, rev 1, phase starting)", () => n.status === 0 && /^run \S+ rev 1$/m.test(n.stdout) && readStatusFile(live)?.phase === "starting");
  // the refusal lives in writeStatus itself — a writer that checked at its start (the probe, whose
  // `measured` write comes up to its time budget later) cannot reopen a run that was ended meanwhile.
  const base = path.join(dir, "Plots");
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

// ---------------------------------------------------------------- CLI --wait
console.log("verify-screen --wait:");
await block("verify-screen --wait:", async () => {
  const { dir, base, live, cli } = project();
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir));
  fs.writeFileSync(path.join(dir, "Plots.evidence.json"), JSON.stringify({ interactions: [] }));
  cli("--status", "Plots", "--phase", "done", "--run", "run-a");
  const t0 = Date.now();
  const w1 = cli("--wait", "Plots", "--run", "run-b", "--timeout", "1", "--interval", "0.1");
  safe("a stale `done` from run A does not end a wait for run B → exit 5 after --timeout", () => w1.status === 5 && /timed out after 1s waiting for run run-b/.test(w1.stderr) && Date.now() - t0 >= 900);
  const w2 = cli("--wait", "Plots", "--run", "run-a", "--timeout", "5", "--interval", "0.1");
  safe("run A done and the measured file is the one it names → exit 0, prints the --compare command", () => w2.status === 0 && /--compare design\/verify\/Plots\.expected\.json design\/verify\/Plots\.measured\.json --out design\/verify\/Plots/.test(w2.stdout));
  safe("…without --interactions: that evidence file was not published in run A", () => !/--interactions/.test(w2.stdout));
  safe("--wait names the live file it waits on", () => w2.stderr.includes(live));
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), JSON.stringify({ expectationSha256: "remeasured", nodes: [] }));
  const w3 = cli("--wait", "Plots", "--run", "run-a", "--timeout", "1", "--interval", "0.1");
  safe("run A done but the measured file changed since → not done: keeps waiting (exit 5), says why", () => w3.status === 5 && /is not the file it names/.test(w3.stderr));
  cli("--status", "Plots", "--phase", "blocked", "--run", "run-c", "--detail", "blocked on permissions: probe done / compare remaining");
  const w4 = cli("--wait", "Plots", "--run", "run-c", "--timeout", "5", "--interval", "0.1");
  safe("run C blocked → exit 1 with the detail", () => w4.status === 1 && /blocked on permissions/.test(w4.stderr));
  cli("--status", "Plots", "--phase", "measuring", "--run", "run-d");
  const w5 = cli("--wait", "Plots", "--run", "run-d", "--timeout", "10", "--stall", "0.5", "--interval", "0.1");
  safe("no status change for --stall seconds → exit 5 'stalled'", () => w5.status === 5 && /stalled/.test(w5.stderr));
  safe("--wait without --run → exit 2", () => cli("--wait", "Plots").status === 2);
  // a status that keeps moving is never a stall — rewritten every ~0.3 s under --stall 0.5 for ~2 s
  const moving = new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [VS_TS, "--wait", "Plots", "--run", "run-m", "--timeout", "2", "--stall", "0.5", "--interval", "0.1"], { cwd: path.dirname(path.dirname(dir)) });
    let err = "";
    p.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    p.on("close", (code) => { if (/stalled/.test(err)) resolve(-1); else resolve(code); });
  });
  const beat = setInterval(() => { VR.writeStatus(base, { runId: "run-m", phase: "driving", by: "agent", detail: "heartbeat" }); }, 300);
  const mc = await moving;
  clearInterval(beat);
  safe("a status rewritten every ~0.3 s under --stall 0.5 → no stall for ~2 s (ends on --timeout, exit 5, never 'stalled')", () => mc === 5);
  // a wait that sees the run finish while it polls — reading the LIVE file (nothing in design/verify changes)
  cli("--status", "Plots", "--phase", "driving", "--run", "run-e");
  fs.writeFileSync(path.join(dir, "Plots.measured.json"), measuredFor(dir));
  const stage = VR.stageDirOf(base, "run-e");
  fs.writeFileSync(path.join(stage, "Plots.evidence.json"), JSON.stringify({ interactions: [{ nodeId: "2:4", trigger: "on_click", ok: null }] }));
  let out = "";
  const waiting = new Promise<number | null>((resolve) => {
    const p = spawn(process.execPath, [VS_TS, "--wait", "Plots", "--run", "run-e", "--timeout", "15", "--interval", "0.1"], { cwd: path.dirname(path.dirname(dir)) });
    p.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    p.on("close", (code) => resolve(code));
  });
  await new Promise((r) => setTimeout(r, 700));
  cli("--status", "Plots", "--phase", "done", "--run", "run-e", "--publish", stage);
  const code = await waiting;
  safe("…a wait that is polling when the run reaches done → exit 0", () => code === 0);
  safe("…and prints --interactions for the evidence published in this run", () => /--interactions design\/verify\/Plots\.evidence\.json/.test(out));
  // the live file alone moves a wait: design/verify/Plots.status.json is only the published copy
  fs.rmSync(path.join(dir, "Plots.status.json"), { force: true });
  VR.writeStatus(base, { runId: "run-f", phase: "failed", by: "agent", detail: "gave up" });
  const w6 = cli("--wait", "Plots", "--run", "run-f", "--timeout", "3", "--interval", "0.1");
  safe("--wait reads the live status (failed in the run cache, nothing in design/verify) → exit 1", () => w6.status === 1 && /gave up/.test(w6.stderr) && !fs.existsSync(path.join(dir, "Plots.status.json")));
});

// ---------------------------------------------------------------- verify-probe --run on an exit 3
console.log("verify-probe --run — an exit 3/4 bumps the status (LOW):");
await block("verify-probe --run exit 3:", async () => {
  const { dir, base, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  cli("--status", "Plots", "--phase", "renderer-ready", "--run", "run-x");
  const noPw = mk("dt-run-nopw-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const p = spawnSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-x"], { encoding: "utf8" });
  const st = VR.readStatus(base);
  safe("probe exit 3 with --run → status rev bumped, phase measuring, detail 'probe exit 3 — nothing written'", () => p.status === 3 && st !== null && st !== "v1" && st.runId === "run-x" && st.rev === 2 && st.phase === "measuring" && st.detail === "probe exit 3 — nothing written");
});

// The probe, too, never reopens an ended run (it writes measuring/measured through writeStatus)
console.log("verify-probe --run on an ended run:");
await block("verify-probe --run ended:", async () => {
  const { dir, base, cli } = project();
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  cli("--status", "Plots", "--phase", "blocked", "--run", "run-pb", "--detail", "blocked on a login wall");
  const before = JSON.stringify(VR.readStatus(base));
  const noPw = mk("dt-run-nopw-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  const p = spawnSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-pb"], { encoding: "utf8" });
  safe("probe --run on a blocked run → exit 2 'already ended at blocked (…) — start a new run', the status untouched", () => p.status === 2
    && p.stderr.includes("run run-pb already ended at blocked (blocked on a login wall) — start a new run with --new-run") && JSON.stringify(VR.readStatus(base)) === before);
});

// ---------------------------------------------------------------- M-a: the run cache stays inside the project
console.log("the run cache stays inside the project (M-a):");
const CACHE = path.join("node_modules", ".cache", "designtwin-verify");
const inTmp = (live: string): boolean => live.startsWith(path.join(os.tmpdir(), "designtwin-verify") + path.sep);
await block("the run cache stays inside the project (M-a):", async () => {
  // an unrelated ancestor has a node_modules (a stray ~/node_modules); the project has none installed yet
  const anc = mk("dt-run-anc-");
  const real = fs.realpathSync(anc);
  fs.mkdirSync(path.join(anc, "node_modules"));
  const app = path.join(anc, "plots-app");
  fs.mkdirSync(path.join(app, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), "{\"name\":\"plots-app\",\"private\":true}\n");
  const base = path.join(app, "design", "verify", "Plots");
  safe("an unrelated ancestor's node_modules, none in the project → <project>/node_modules/.cache/designtwin-verify/<S>.status.json (not the ancestor's)",
    () => VR.liveStatusFile(base) === path.join(real, "plots-app", CACHE, "Plots.status.json"));
  VR.writeStatus(base, { runId: "run-a", phase: "queued", by: "agent" });
  safe("…the write creates <project>/node_modules/.cache/designtwin-verify/ and nothing in the ancestor's node_modules", () =>
    fs.existsSync(path.join(app, CACHE, "Plots.status.json")) && fs.readdirSync(path.join(anc, "node_modules")).length === 0);
  // the ancestor is a workspace root (workspaces + node_modules) but the project is its own repo (.git): the walk stops there
  fs.writeFileSync(path.join(anc, "package.json"), "{\"name\":\"outer\",\"private\":true,\"workspaces\":[\"*\"]}\n");
  const repo = path.join(anc, "plots-repo");
  fs.mkdirSync(path.join(repo, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"plots-repo\",\"private\":true}\n");
  safe("a workspace root with node_modules ABOVE the project's .git → the project's own cache (never past .git)",
    () => VR.liveStatusFile(path.join(repo, "design", "verify", "Plots")) === path.join(real, "plots-repo", CACHE, "Plots.status.json"));
  // the same layout without the .git: the ancestor IS this project's workspace root, dependencies hoisted there
  const member = path.join(anc, "plots-member");
  fs.mkdirSync(path.join(member, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), "{\"name\":\"plots-member\",\"private\":true}\n");
  safe("…without the .git the ancestor is the workspace root (workspaces + node_modules) → its cache, keyed by the verify dir",
    () => path.dirname(VR.liveStatusFile(path.join(member, "design", "verify", "Plots"))) === path.join(real, CACHE, "dirs", crypto.createHash("sha256").update("plots-member/design/verify").digest("hex").slice(0, 16)));
  // pnpm: pnpm-workspace.yaml marks the root, node_modules there
  const pn = mk("dt-run-pnpm-");
  fs.writeFileSync(path.join(pn, "package.json"), "{\"name\":\"plots-pnpm\",\"private\":true}\n");
  fs.writeFileSync(path.join(pn, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  fs.mkdirSync(path.join(pn, "node_modules"));
  const pnApp = path.join(pn, "apps", "plots");
  fs.mkdirSync(path.join(pnApp, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(pnApp, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  safe("a pnpm workspace (pnpm-workspace.yaml + root node_modules) → the root's cache", () => VR.liveStatusFile(path.join(pnApp, "design", "verify", "Plots")).startsWith(path.join(fs.realpathSync(pn), CACHE, "dirs") + path.sep));
  // a design/verify in a repo with no package.json of its own: the package.json search stops at .git too
  const noPkg = path.join(anc, "plots-native");
  fs.mkdirSync(path.join(noPkg, "design", "verify"), { recursive: true });
  fs.mkdirSync(path.join(noPkg, ".git"));
  const npLive = VR.liveStatusFile(path.join(noPkg, "design", "verify", "Plots"));
  safe("no package.json inside the repo (.git) → the OS temp dir, never the package.json above the repo", () => inTmp(npLive));
  tmps.push(path.dirname(npLive));
  // Yarn PnP at the workspace root, no node_modules anywhere → temp dir
  const yp = mk("dt-run-pnpws-");
  fs.writeFileSync(path.join(yp, "package.json"), "{\"name\":\"plots-pnp-ws\",\"private\":true,\"workspaces\":[\"apps/*\"]}\n");
  fs.writeFileSync(path.join(yp, ".pnp.cjs"), "// pnp\n");
  const ypApp = path.join(yp, "apps", "plots");
  fs.mkdirSync(path.join(ypApp, "design", "verify"), { recursive: true });
  fs.writeFileSync(path.join(ypApp, "package.json"), "{\"name\":\"plots\",\"private\":true}\n");
  const ypLive = VR.liveStatusFile(path.join(ypApp, "design", "verify", "Plots"));
  safe("Yarn PnP at the workspace root (no node_modules) → the OS temp dir", () => inTmp(ypLive));
  tmps.push(path.dirname(ypLive));
});

console.log("an unwritable run cache — exit 6, one sentence, no stack (M-a):");
await block("an unwritable run cache (M-a):", async () => {
  const { cwd, dir, base, live, cli } = project();
  const cache = path.dirname(live);
  fs.mkdirSync(cache, { recursive: true });
  fs.chmodSync(cache, 0o555);
  const s = cli("--status", "Plots", "--phase", "queued", "--new-run");
  const d = cli("--status", "Plots", "--phase", "done", "--run", "run-ro", "--publish", mk("dt-run-rostage-"));
  fs.chmodSync(cache, 0o755);
  const msg = /run cache \S+designtwin-verify is not writable \(sandbox write scope\?\) — run from \S+ or allow writes there/;
  safe("--status into a read-only run cache → exit 6, 'run cache <dir> is not writable (sandbox write scope?) — run from <root> or allow writes there'", () =>
    s.status === 6 && msg.test(s.stderr) && s.stderr.includes(fs.realpathSync(cwd)));
  safe("…no stack trace, nothing on stdout", () => !/\n\s+at /.test(s.stderr) && s.stdout === "");
  safe("…a refused `done --publish` published nothing into design/verify", () => d.status === 6 && !fs.existsSync(path.join(dir, "Plots.status.json")));
  // --wait on a run cache it cannot read → exit 6 at once, not a --timeout of silence
  VR.writeStatus(base, { runId: "run-w", phase: "driving", by: "agent" });
  fs.chmodSync(cache, 0o000);
  const w = cli("--wait", "Plots", "--run", "run-w", "--timeout", "5", "--interval", "0.1");
  fs.chmodSync(cache, 0o755);
  safe("--wait on an unreadable run cache → exit 6 naming the cache, no stack", () => w.status === 6 && /run cache \S+ is not readable/.test(w.stderr) && !/\n\s+at /.test(w.stderr));
  // the probe: a refused status write is a warning; the exit contract (here 3: no playwright) holds
  const PROBE_TS = path.join(import.meta.dirname, "..", "design-to-code", "verify-probe.ts");
  const noPw = mk("dt-run-nopw2-");
  fs.writeFileSync(path.join(noPw, "package.json"), "{}");
  fs.chmodSync(cache, 0o555);
  const p = spawnSync(process.execPath, [PROBE_TS, "--expected", path.join(dir, "Plots.expected.json"), "--url", "http://127.0.0.1:9/", "--project", noPw, "--run", "run-w"], { encoding: "utf8" });
  fs.chmodSync(cache, 0o755);
  safe("verify-probe --run with a read-only run cache → still exit 3 (no renderer), a 'warning  run cache … is not writable' line, no stack", () =>
    p.status === 3 && /warning {2}run cache \S+ is not writable \(sandbox write scope\?\)/.test(p.stderr) && !/\n\s+at /.test(p.stderr));
});

// ---------------------------------------------------------------- M-b: one key per directory, whatever its spelling
console.log("one run cache per directory on a case-insensitive filesystem (M-b):");
await block("case-insensitive spellings (M-b):", async () => {
  const cwd = proj("dt-run-case-");
  const insensitive = fs.existsSync(path.join(cwd, "DESIGN"));
  if (!insensitive) { console.log("  (skipped: this filesystem is case-sensitive — Design/Verify is another directory there)"); return; }
  const lower = VR.liveStatusFile(path.join(cwd, "design", "verify", "Plots"));
  const upper = VR.liveStatusFile(path.join(cwd, "Design", "Verify", "Plots"));
  safe("`Design/Verify` and `design/verify` → the same live file (the default layout's, not a dirs/<key>/ one)", () => upper === lower && lower === path.join(fs.realpathSync(cwd), CACHE, "Plots.status.json"));
  const tmpCase = mk("dt-run-case-bare-");
  fs.mkdirSync(path.join(tmpCase, "design", "verify"), { recursive: true });
  const a = VR.liveStatusFile(path.join(tmpCase, "design", "verify", "Plots")), b = VR.liveStatusFile(path.join(tmpCase, "DESIGN", "verify", "Plots"));
  safe("…and the temp-dir fallback keys both spellings to one directory", () => a === b);
  tmps.push(path.dirname(a));
});

for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
// a printed argument is ONE shell word whatever it holds — the shell gives back exactly the string
{
  const words = ["design/verify/Plots.json", "/tmp/My Plots/design/verify", "it's here", "a!b c", "$HOME `x` \\ \"q\""];
  const back = words.map((w) => spawnSync("/bin/sh", ["-c", `printf %s ${shellArg(w)}`], { encoding: "utf8" }).stdout);
  check("shellArg: a plain path stays bare; spaces, quotes, !, $, backticks and backslashes round-trip through sh as one word",
    shellArg(words[0] ?? "") === words[0] && back.every((b, i) => b === words[i]));
}

report();
