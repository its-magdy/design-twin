// Tests that the design-to-code CLIs (and the dtwin CLI, MCP server and daemon) never lose the tail of a long stdout.
//   bun test/cli-exit.test.ts
// A CLI that writes to process.stdout and then calls process.exit() is cut off when stdout is a pipe:
// pipe writes are asynchronous on POSIX, so whatever the consumer has not yet read (past the 64 KiB pipe
// buffer) is dropped (https://nodejs.org/api/process.html#a-note-on-process-io). The fix is `main()` returning
// an exit code, set as process.exitCode, so every printed byte flushes first.
//   1. behaviour: run the CLIs with a synthetic screen whose report is far larger than the pipe buffer, into
//      a deliberately slow reader, and demand every byte;
//   2. the queued console (bridge/src/stdio.ts) covers every console method that prints, and runCli's exitCli scope ends
//      when main settles;
//   3. static guard: no design-to-code/*.ts or bridge/src/*.ts calls process.exit() outside a reasoned allow-list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { check, report } from "./assert.ts";
import { catalog, parseAs, screenExport } from "./fixtures.ts";
import { isJsonObject } from "../design-to-code/types.ts";
import type { NodeInput } from "./fixtures.ts";

const D2C = path.join(import.meta.dirname, "..", "design-to-code");
const PIPE_BUFFER = 65536;
// a JSON object, or false (parseAs throws on anything else)
const parses = (text: string): boolean => { try { parseAs(text, isJsonObject, "piped output"); return true; } catch { return false; } };
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- 1. a long report through a slow pipe

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-exit-"));
try {
  // 600 fixed-size, low-contrast labels on a white card: each one draws findings, so the report is hundreds of KB.
  const labels: NodeInput[] = Array.from({ length: 600 }, (_, i) => ({
    type: "TEXT", id: `1:${i + 10}`, name: `Label ${i}`, text: `Invented label number ${i}`,
    font: { size: 14, family: "Inter", weight: "Regular", lineHeight: { unit: "auto" }, color: "#bbbbbb" },
    box: { w: 200, h: 20 },
  }));
  // 600 instances of distinct components the catalog does not have: cross-check lists each one as new work.
  const instances: NodeInput[] = Array.from({ length: 600 }, (_, i) => ({
    type: "INSTANCE", id: `2:${i + 10}`, name: `Widget ${i}`, component: `Widget ${i}`,
    mainComponent: { id: `9:${i}`, key: `KEY_WIDGET_${i}`, name: `Widget ${i}`, setName: `Widget ${i}`, remote: true },
    box: { w: 120, h: 48 },
  }));
  const doc = screenExport([{
    type: "FRAME", id: "1:1", name: "Big Screen", box: { w: 393, h: 852, x: 0, y: 0 },
    layout: { display: "flex", flexDirection: "column", gap: 10, padding: [13, 13, 13, 13] },
    fills: [{ type: "solid", color: "#ffffff" }],
    children: [...labels, ...instances],
  }], { exportedAt: "2026-01-01T00:00:00.000Z", screen: "Big Screen" });
  const file = path.join(tmp, "Big_Screen__1_1.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  const dsDir = path.join(tmp, "design-system");
  fs.mkdirSync(dsDir);
  fs.writeFileSync(path.join(dsDir, "components.local.json"), JSON.stringify(catalog([{ name: "Sample Button", id: "6:0", type: "COMPONENT_SET", key: "KEY_SAMPLE_BUTTON" }])));
  check("fixture: the synthetic screen has a node tree", doc.nodes[0]?.children?.length === 1200);

  // The consumer sleeps a second before reading, so the pipe is full when the CLI finishes writing.
  const slow = (cmd: string): { bytes: number; text: string } => {
    const wc = spawnSync("sh", ["-c", `${cmd} | (sleep 1; wc -c)`], { encoding: "utf8", cwd: tmp, maxBuffer: 1 << 26 });
    const cat = spawnSync("sh", ["-c", `${cmd} | (sleep 1; cat)`], { encoding: "utf8", cwd: tmp, maxBuffer: 1 << 26 });
    return { bytes: Number(wc.stdout.trim()), text: cat.stdout };
  };
  // What the CLI writes, taken from the files a --out run writes (fs writes are synchronous, so nothing is
  // cut): the --json stdout is that same report.
  const outDir = path.join(tmp, "out");
  const run = (script: string, args: string[]): void => {
    const r = spawnSync(process.execPath, [path.join(D2C, script), ...args], { encoding: "utf8", cwd: tmp });
    if (r.status !== 0) throw new Error(`${script} ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  };
  run("audit.ts", [file, "--out", path.join(outDir, "audit")]);
  run("cross-check.ts", [file, "--design-system", dsDir, "--out", path.join(outDir, "cross")]);
  const want = (f: string): Buffer => fs.readFileSync(path.join(outDir, f));

  const cases: Array<{ name: string; script: string; args: string[]; expected: Buffer; json: boolean }> = [
    { name: "audit --json", script: "audit.ts", args: [file, "--json"], expected: want("audit.json"), json: true },
    { name: "cross-check --json", script: "cross-check.ts", args: [file, "--design-system", dsDir, "--json"], expected: want("cross.json"), json: true },
  ];
  for (const c of cases) {
    const cmd = `${q(process.execPath)} ${q(path.join(D2C, c.script))} ${c.args.map(q).join(" ")}`;
    const got = slow(cmd);
    check(`[${c.name}] the report (${c.expected.length} bytes) is bigger than the ${PIPE_BUFFER}-byte pipe buffer, so a cut is visible`, c.expected.length > 1.5 * PIPE_BUFFER);
    check(`[${c.name}] through a slow reader every byte arrives (${got.bytes} of ${c.expected.length})`, got.bytes === c.expected.length);
    check(`[${c.name}] …and the text is byte-identical`, got.text === c.expected.toString("utf8"));
    if (c.json) check(`[${c.name}] …and parses as JSON`, parses(got.text));
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. the queued console and runCli's scope (bridge/src/stdio.ts)
{
  console.log("\nstdio.ts — every console method through the queue; exitCli throws only while a CLI's main runs:");
  const stdioUrl = JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "bridge", "src", "stdio.ts")).href);
  const bun = (code: string, env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 15_000 });
  // Methods that print nothing (the inspector's), the only ones installQueuedConsole may leave as the runtime made them.
  const SILENT = ["profile", "profileEnd", "timeStamp", "takeHeapSnapshot", "record", "recordEnd", "screenshot", "context", "createTask", "Console"];
  const left = bun(`import { installQueuedConsole } from ${stdioUrl};
    const before = Object.fromEntries(Object.getOwnPropertyNames(console).map((k) => [k, console[k]]));
    installQueuedConsole({ logTo: "stderr" });
    process.stdout.write(JSON.stringify(Object.keys(before).filter((k) => typeof before[k] === "function" && console[k] === before[k])));`);
  const untouched = ((): string[] => { try { return JSON.parse(left.stdout) as string[]; } catch { return ["<unreadable: " + left.stdout + left.stderr + ">"]; } })();
  const missed = untouched.filter((k) => !SILENT.includes(k));
  check(`installQueuedConsole replaces every console method that can print (left as is: ${untouched.join(", ") || "none"})` + (missed.length ? ` — NOT rerouted: ${missed.join(", ")}` : ""), left.status === 0 && missed.length === 0);
  // The MCP server's mode: not one byte of any of them on stdout (it carries JSON-RPC only), all of it on stderr.
  const all = bun(`import { installQueuedConsole } from ${stdioUrl};
    installQueuedConsole({ logTo: "stderr" });
    console.log("m-log"); console.info("m-info"); console.debug("m-debug"); console.warn("m-warn"); console.error("m-error");
    console.dir({ m: "dir" }); console.dirxml("m-dirxml"); console.table([{ m: "table" }]); console.trace("m-trace");
    console.assert(false, "m-assert"); console.assert(true, "m-never");
    console.group("m-group"); console.log("m-inner"); console.groupEnd(); console.groupCollapsed("m-collapsed"); console.groupEnd();
    console.count("m-count"); console.count("m-count"); console.countReset("m-count"); console.count("m-count");
    console.time("m-time"); console.timeLog("m-time", "m-extra"); console.timeEnd("m-time"); console.timeEnd("m-none");
    console.write("m-write\\n"); console.clear();`);
  const wants = ["m-log", "m-info", "m-debug", "m-warn", "m-error", "m: 'dir'", "m-dirxml", "m: 'table'", "Trace: m-trace", "Assertion failed: m-assert",
    "m-group\n  m-inner", "m-collapsed", "m-count: 1\nm-count: 2\nm-count: 1", "m-extra", "No such label 'm-none'", "m-write"];
  const absent = wants.filter((w) => !all.stderr.includes(w));
  check(`logTo "stderr": every method's text reaches stderr (${absent.length ? "missing: " + absent.join(" | ") : "all " + wants.length}), the one passing assert prints nothing`,
    all.status === 0 && absent.length === 0 && !all.stderr.includes("m-never") && /m-time: \d+\.\d{3}ms m-extra/.test(all.stderr) && /m-time: \d+\.\d{3}ms\n/.test(all.stderr));
  check(`…and stdout stays empty (${all.stdout.length} bytes)`, all.stdout === "");
  // runCli's scope: exitCli throws CliExit while main runs (sync or async), and no longer once it has settled — a server a
  // CLI started (dtwin mcp) then sees exitCli exactly as when launched directly.
  const scope = bun(`import { runCli, insideCli } from ${stdioUrl};
    const seen = [];
    runCli(() => { seen.push("sync:" + insideCli()); return 0; }, { name: "t" });
    seen.push("after-sync:" + insideCli());
    runCli(() => { throw new Error("boom"); }, { name: "t", errorLine: () => "thrown", errorCode: 0 });
    seen.push("after-throw:" + insideCli());
    runCli(async () => { await null; seen.push("async:" + insideCli()); return 0; }, { name: "t" });
    seen.push("pending:" + insideCli());
    runCli(async () => { await null; throw new Error("late"); }, { name: "t", errorLine: () => "rejected", errorCode: 0 });
    setTimeout(() => process.stdout.write(seen.join(",") + ",settled:" + insideCli() + "\\n"), 20);`);
  check(`runCli: insideCli() is true only while a main runs and false once every main has settled (${scope.stdout.trim()})`,
    scope.status === 0 && scope.stdout.trim() === "sync:true,after-sync:false,after-throw:false,pending:true,async:true,settled:false");
  // `dtwin mcp`'s load-time failure is still that CLI's exit code, with its one line out first (exitCli inside runCli).
  const mcp = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bridge", "src", "figma-pull.ts"), "mcp"], { encoding: "utf8", env: { ...process.env, FIGMA_BRIDGE_PORT: "9999" }, input: "", timeout: 15_000 });
  check(`dtwin mcp with FIGMA_BRIDGE_PORT=9999: exit 1 with the port's one line, not a "failed to start" stack (exit ${mcp.status})`,
    mcp.status === 1 && /FIGMA_BRIDGE_PORT=9999 is not one of 8787, 8788, 8789/.test(mcp.stderr) && !/failed to start/.test(mcp.stderr) && mcp.stdout === "");
}

// ---------------------------------------------------------------- 3. the pattern cannot come back

// file (repo-relative) → [how many process.exit( calls it may hold, why]. Anything else must `return` a code from main()
// (process.exitCode), end through exitCli / exitFlushed (bridge/src/stdio.ts), or set process.exitCode and let the loop end.
// Both trees are scanned: the dtwin CLI, the MCP server and the daemon (bridge/src) end the same way the design-to-code
// CLIs do. design-to-code no longer calls the runtime's exit outside stdio.ts: cliParse and catalog-input go through
// exitCli, the verify-build watchdog and verify-probe's grace / stop-signal exit through exitFlushed; in bridge/src the
// usage/help exits of dtwin, doctor, init and seed go through exitCli, and the exits made while something still holds the
// loop (a failed command's open bridge, a held port, the daemon's and the MCP server's signal / shutdown backstops, the
// crash handler) through exitFlushed.
const ALLOWED: Record<string, [number, string]> = {
  "bridge/src/stdio.ts": [2, "exitCli outside runCli (a suite calling main() in-process, the MCP server importing a module: an immediate exit, as before — inside runCli it throws CliExit and the code becomes process.exitCode) and exitFlushed (exits only once every counted stdout/stderr write is out, or at its cap: the verify-build hook watchdog, verify-probe's grace timer / stop signal, whose exit runs Playwright's exit hook that kills the browser, and the bridge's exits while a server still holds the loop)"],
};
const ROOT = path.join(import.meta.dirname, "..");
const SCANNED = ["design-to-code", path.join("bridge", "src")];
console.log("no process.exit() in design-to-code/*.ts or bridge/src/*.ts outside the allow-list:");
for (const dir of SCANNED) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".ts")).sort()) {
    const rel = path.posix.join(...dir.split(path.sep), f);
    const lines = fs.readFileSync(path.join(ROOT, dir, f), "utf8").split("\n");
    const hits = lines.flatMap((l, i) => (l.trimStart().startsWith("//") ? [] : (l.match(/\bprocess\.exit\(/g) ?? []).map(() => i + 1)));
    const allowed = ALLOWED[rel]?.[0] ?? 0;
    check(`${rel}: ${hits.length} process.exit() call(s), ${allowed} allowed${hits.length > allowed ? ` (lines ${hits.join(", ")}) — return the code from main() and set process.exitCode, or end through exitCli / exitFlushed` : ""}`, hits.length === allowed);
  }
}
check("the scan saw the dtwin entry point (a moved tree would otherwise pass vacuously)", fs.existsSync(path.join(ROOT, "bridge", "src", "figma-pull.ts")) && fs.existsSync(path.join(D2C, "audit.ts")));
for (const [f, [n, why]] of Object.entries(ALLOWED)) check(`allow-list entry ${f} (${n}: ${why}) still exists`, fs.existsSync(path.join(ROOT, f)));

report();
