// Tests that the design-to-code CLIs never lose the tail of a long stdout.
//   node test/cli-exit.test.ts
// A CLI that writes to process.stdout and then calls process.exit() is cut off when stdout is a pipe:
// pipe writes are asynchronous on POSIX, so whatever the consumer has not yet read (past the 64 KiB pipe
// buffer) is dropped (https://nodejs.org/api/process.html#a-note-on-process-io). The fix is `main()` returning
// an exit code, set as process.exitCode, so every printed byte flushes first.
//   1. behaviour: run the CLIs with a synthetic screen whose report is far larger than the pipe buffer, into
//      a deliberately slow reader, and demand every byte;
//   2. static guard: no design-to-code/*.ts calls process.exit() outside a reasoned allow-list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

// ---------------------------------------------------------------- 2. the pattern cannot come back

// file → [how many process.exit( calls it may hold, why]. Anything else must `return` a code from main().
const ALLOWED: Record<string, [number, string]> = {
  "cli-args.ts": [1, "cliParse rejects a bad command line before the tool has written anything to stdout"],
  "catalog-input.ts": [3, "input-file guards: every current caller reads its inputs before writing any stdout, and they print only to stderr — a NEW caller must do the same, or this exit truncates piped output again"],
  "verify-build.ts": [1, "the hook watchdog: it fires when the process is hung (a stuck read), where a clean exit is not available"],
};
console.log("no process.exit() in design-to-code/*.ts outside the allow-list:");
for (const f of fs.readdirSync(D2C).filter((x) => x.endsWith(".ts")).sort()) {
  const lines = fs.readFileSync(path.join(D2C, f), "utf8").split("\n");
  const hits = lines.flatMap((l, i) => (l.trimStart().startsWith("//") ? [] : (l.match(/\bprocess\.exit\(/g) ?? []).map(() => i + 1)));
  const allowed = ALLOWED[f]?.[0] ?? 0;
  check(`${f}: ${hits.length} process.exit() call(s), ${allowed} allowed${hits.length > allowed ? ` (lines ${hits.join(", ")}) — return the code from main() and set process.exitCode` : ""}`, hits.length === allowed);
}
for (const [f, [n, why]] of Object.entries(ALLOWED)) check(`allow-list entry ${f} (${n}: ${why}) still exists`, fs.existsSync(path.join(D2C, f)));

report();
