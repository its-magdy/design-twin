// What each front-end SENDS for each read, end to end: the real `dtwin` process and the real MCP server,
// both routed through a recording daemon (the real daemon.serve over a fake bridge that logs every
// forwarded request and answers it). The read plan (read-plan.ts) is unit-tested in read-plan.test.ts;
// this suite is what keeps the two CALLERS on it — a front-end that builds a request of its own, picks
// its own budget, or declares a different set of read options fails here.
//   bun test/read-plan-e2e.test.ts
// Binds the daemon socket for FIGMA_BRIDGE_PORT=8789, like cli-pull and mcp-smoke: the runner runs suites
// one at a time, never beside them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { check, report } from "./assert.ts";
import { dtwin as runDtwin } from "./children.ts";
import { manifest, screenReply, clientRow } from "./fixtures.ts";
import * as daemon from "../bridge/src/daemon.ts";
import { writeAny } from "../bridge/src/write-out.ts";
import { stampSource } from "../bridge/src/source-stamp.ts";
import { READ_OPTS } from "../bridge/src/read-opts.ts";
import type { Cmd, Commands, ExportReply } from "../bridge/src/commands.ts";
import type { DaemonBridge } from "../bridge/src/daemon.ts";

const PORT = 8789;
const TOKEN = "read-plan-e2e-token";
const ROOT = path.join(import.meta.dirname, "..");
const MCP = path.join(ROOT, "bridge", "src", "figma-mcp.ts");

// ---------------------------------------------------------------- the recording daemon
interface Rec { cmd: string; args: unknown; timeoutMs: number | undefined }
let log: Rec[] = [];
const client = clientRow({ connId: "c1", file: "Read Plan File", fileKey: "RPKEY" });
// A 4x3 PNG header (signature + IHDR): all writeScreenshot's size read needs.
const PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(4, 16); b.writeUInt32BE(3, 20);
  return b.toString("base64");
})();
const designSystem = { file: "Read Plan File", exportedAt: "2026-01-01T00:00:00Z", variables: [], collections: [], components: [] };
const screen = () => screenReply({ screenName: "Sample", screen: { nodes: [{ id: "1:2", type: "FRAME", name: "Sample" }] }, page: "Home", pageId: "0:1", nodeId: "1:2" });
const replies: { [C in "exportNode" | "exportSelection" | "exportDesignSystem" | "exportLibrary" | "exportFull" | "screenshot"]: () => Commands[C]["reply"] } = {
  exportNode: screen,
  exportSelection: screen,
  exportDesignSystem: () => ({ designSystem: { ...designSystem } }),
  exportLibrary: () => ({ designSystem: { ...designSystem, source: { role: "library", name: "Lib", fileKey: "RPKEY" } } }),
  exportFull: () => ({ designSystem: { ...designSystem }, layersDoc: { exportedAt: "t", manifest: manifest(), layers: [], index: [] }, assets: [] }),
  screenshot: () => ({ id: "1:2", name: "Sample", type: "FRAME", reference: "assets/1_2_ref.png", manifest: manifest(), assets: [{ id: "1:2", name: "Sample", format: "png", file: "1_2_ref.png", base64: PNG, kind: "reference" }] }),
};
const isRecorded = (c: string): c is keyof typeof replies => c in replies;
const fake: DaemonBridge = {
  port: PORT,
  isConnected: () => true,
  async request<C extends Cmd>(cmd: C, args: Commands[C]["args"] | undefined, o: { timeoutMs?: number | undefined }) {
    log.push({ cmd, args: args ?? null, timeoutMs: o.timeoutMs });
    if (!isRecorded(cmd)) throw new Error("the recording daemon answers export commands only, not " + cmd);
    const reply: unknown = replies[cmd]();
    return { reply: reply as Commands[C]["reply"], client };
  },
  close() {},
  listClients: () => [client],
};
process.env.FIGMA_BRIDGE_PORT = String(PORT);
// The token named, so on Windows the pipe is named from this suite's token and never the user's saved one.
const served = await daemon.serve(fake, { port: PORT, idleMs: 0, signals: false, token: TOKEN });

const work = fs.mkdtempSync(path.join(os.tmpdir(), "read-plan-e2e-"));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FIGMA_BRIDGE_TOKEN_FILE" && k !== "DTWIN_PORT") env[k] = v;
Object.assign(env, { FIGMA_BRIDGE_PORT: String(PORT), FIGMA_BRIDGE_TOKEN: TOKEN });

/** dtwin to completion (test/children.ts), killed with SIGKILL at 40 s. */
async function dtwin(args: string[]): Promise<{ code: number | null; stderr: string }> {
  const r = await runDtwin(args, { cwd: work, env, timeoutMs: 40_000 });
  return { code: r.status, stderr: r.stderr };
}
/** The one request a run sent, as `cmd args timeoutMs` — or "none". */
const sent = (): string => {
  const rows = log.map((r) => `${r.cmd} ${JSON.stringify(r.args)} ${r.timeoutMs}`);
  log = [];
  return rows.length === 1 ? (rows[0] ?? "") : rows.length ? rows.join(" | ") : "none";
};

// ---------------------------------------------------------------- what each read sends
const OFF = '"css":false,"measurements":false,"pluginData":false,"motion":false,"sharedData":false,"variantVisuals":false,"skipAssets":false';
const W = {
  node: `exportNode {"nodeId":"1:2",${OFF}} 300000`,
  nodeCss: `exportNode {"nodeId":"1:2",${OFF.replace('"css":false', '"css":true').replace('"skipAssets":false', '"skipAssets":true')}} 300000`,
  selection: `exportSelection {${OFF}} 120000`,
  page: `exportFull {"allPages":false,${OFF}} 300000`,
  pages: `exportFull {"allPages":false,"page":["P1","P2"],${OFF}} 300000`,
  blank: `exportFull {"allPages":false,"page":[""],${OFF}} 300000`,
  one: `exportFull {"allPages":false,"page":["P1"],${OFF}} 300000`,
  all: `exportFull {"allPages":true,${OFF}} 900000`,
  allPlusPage: `exportFull {"allPages":true,"page":["P1"],${OFF}} 900000`,
  ds: 'exportDesignSystem {"variantVisuals":false} 300000',
  dsVv: 'exportDesignSystem {"variantVisuals":true} 300000',
  lib: 'exportLibrary {"asLibrary":"Lib","variantVisuals":false} 300000',
  libVv: 'exportLibrary {"asLibrary":"Lib","variantVisuals":true} 300000',
  shot: 'screenshot {"nodeId":"1:2"} 300000',
};

console.log("\nread plan end to end — the CLI:");
const cliCases: Array<[string[], string]> = [
  [["--node", "1:2"], W.node], [["--node", "1:2", "--css", "--no-assets"], W.nodeCss], [["--selection"], W.selection],
  [[], W.page], [["--page", "P1", "--page", "P2"], W.pages], [["--page", ""], W.blank], [["--all-pages"], W.all],
  [["--design-system"], W.ds], [["--design-system", "--variant-visuals"], W.dsVv],
  [["--as-library", "Lib"], W.lib], [["--as-library", "Lib", "--variant-visuals"], W.libVv],
  [["--screenshot", "1:2"], W.shot],
  [["--node", "1:2", "--timeout", "7"], W.node.replace(/300000$/, "7000")],
  [["--screenshot", "1:2", "--timeout", "7"], W.shot.replace(/300000$/, "7000")],
  [["--all-pages", "--timeout", "7"], W.all.replace(/900000$/, "7000")],
];
for (const [args, want] of cliCases) {
  const r = await dtwin([...args, "out"]);
  const got = sent();
  check(`dtwin ${args.join(" ") || "(current page)"} -> ${want}`, r.code === 0 && got === want);
  if (r.code !== 0 || got !== want) console.log(`    got exit ${r.code}: ${got}\n    ${r.stderr.split("\n").filter(Boolean).slice(-2).join("\n    ")}`);
}
const refusals: Array<[string[], RegExp]> = [
  [["--design-system", "--css"], /--css is a read option for a node\/page walk — --design-system skips that walk entirely/],
  [["--as-library", "Lib", "--no-assets"], /--no-assets is a read option for a node\/page walk — --as-library skips that walk entirely/],
  [["--design-system", "--css", "--no-assets", "--variant-visuals"], /--css \/ --no-assets are read options for a node\/page walk/],
  [["--screenshot", "1:2", "--css"], /--css is a read option for a full export — --screenshot only renders a PNG/],
  [["--screenshot", "1:2", "--variant-visuals", "--motion"], /--motion \/ --variant-visuals are read options for a full export/],
  [["--all-pages", "--page", "P1"], /--all-pages and --page select different scopes — pass only one\./],
];
for (const [args, re] of refusals) {
  const r = await dtwin([...args, "out"]);
  const got = sent();
  check(`dtwin ${args.join(" ")} is refused before anything is sent`, r.code === 1 && got === "none" && re.test(r.stderr));
}

console.log("\nread plan end to end — the MCP server:");
const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env, cwd: work, stderr: "ignore" });
const mc = new Client({ name: "read-plan-e2e", version: "0.0.0" });
await mc.connect(transport);
const mcpCases: Array<[string, Record<string, unknown>, string]> = [
  ["figma_export_url", { url: "1:2" }, W.node], ["figma_export_url", { url: "1:2", css: true, skipAssets: true }, W.nodeCss],
  ["figma_export_selection", {}, W.selection],
  ["figma_export_full", {}, W.page], ["figma_export_full", { page: [] }, W.page], ["figma_export_full", { page: ["P1", "P2"] }, W.pages],
  ["figma_export_full", { page: [""] }, W.blank], ["figma_export_full", { page: "P1" }, W.one], ["figma_export_full", { allPages: true }, W.all],
  ["figma_export_full", { allPages: true, page: ["P1"] }, W.allPlusPage], ["figma_export_full", { allPages: true, page: [] }, W.all],
  // The one approved change: an omitted variantVisuals is now said as false (applyOpts reads `!!` either way).
  ["figma_export_design_system", {}, W.ds], ["figma_export_design_system", { variantVisuals: false }, W.ds], ["figma_export_design_system", { variantVisuals: true }, W.dsVv],
  // Not declared on this tool, so stripped by the SDK before the handler — as it always was.
  ["figma_export_design_system", { css: true, skipAssets: true }, W.ds],
  ["figma_screenshot", { nodeId: "1:2" }, W.shot], ["figma_screenshot", { nodeId: "1:2", css: true }, W.shot],
];
for (const [name, a, want] of mcpCases) {
  const r = await mc.callTool({ name, arguments: { ...a, writeToDisk: false } });
  const got = sent();
  check(`${name} ${JSON.stringify(a)} -> ${want}`, r.isError !== true && got === want);
  if (r.isError === true || got !== want) console.log(`    got ${got}${r.isError === true ? " (isError)" : ""}`);
}

console.log("\nread plan end to end — the read options each MCP tool declares:");
const { tools } = await mc.listTools();
const declared = (name: string): string[] => {
  const props = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
  return READ_OPTS.map((o) => o.name).filter((n) => n in props);
};
const ALL = READ_OPTS.map((o) => o.name).join(",");
for (const t of ["figma_export_full", "figma_export_selection", "figma_export_url"]) check(`${t} declares every read option`, declared(t).join(",") === ALL);
check("figma_export_design_system declares variantVisuals alone", declared("figma_export_design_system").join(",") === "variantVisuals");
check("figma_screenshot declares none", declared("figma_screenshot").length === 0);
await mc.close();

console.log("\nread plan end to end — the CLI writes what writeAny writes:");
// The CLI now stamps every reply and writes it through writeAny, as the MCP server does. The files must be
// what writeAny makes of the same stamped reply (a catalog or a screenshot never reads the stamp) — up to the
// clock: a writer stamps when IT wrote (variables.json `at`, libraries/index.json `generatedAt`), so ISO times are masked.
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = f.endsWith(".png") ? fs.readFileSync(f).toString("base64") : fs.readFileSync(f, "utf8").replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>");
    }
  };
  walk(dir);
  return out;
};
const writes: Array<[string[], () => ExportReply]> = [
  [["--node", "1:2"], replies.exportNode], [["--selection"], replies.exportSelection], [["--page", "P1"], replies.exportFull],
  [["--design-system"], replies.exportDesignSystem], [["--as-library", "Lib"], replies.exportLibrary], [["--screenshot", "1:2"], replies.screenshot],
];
for (const [i, [args, reply]] of writes.entries()) {
  const viaCli = path.join(work, `cli-${i}`), viaAny = path.join(work, `any-${i}`);
  const r = await dtwin([...args, viaCli]);
  sent();
  writeAny(viaAny, stampSource({ reply: reply(), client }));
  const a = tree(viaCli), b = tree(viaAny);
  check(`dtwin ${args.join(" ")} writes the files writeAny writes (${Object.keys(a).length} file(s))`, r.code === 0 && Object.keys(a).length > 0 && JSON.stringify(a) === JSON.stringify(b));
}

served.shutdown();
fs.rmSync(work, { recursive: true, force: true });
report();
