// The write plane's cost meter: what each of the six jobs of the design record (and a new screen's fix round) costs an agent, in tokens and round
// trips, through each route (docs/write-plane-spec.md decision 21). No live Figma.
//   bun test/write-cost.test.ts            measure, print the table, check every route against baseline.json
//   bun test/write-cost.test.ts --record   measure and write the numbers to test/write-cost/baseline.json
//
// What runs: the REAL MCP server (bridge/src/figma-mcp.ts) as a subprocess, spoken to by the MCP SDK's client as an
// agent would, and a fake plugin on its bridge socket whose write, read and list commands run the plugin's REAL code
// (figma-plugin/src, built into fake-figma's VM) against a fake file (write-cost/canvas.ts). So a reply is the text an
// agent would read, byte for byte, and the file afterwards is what the plugin did.
//
// For every route (write-cost/routes.ts) and every job it has a way for (write-cost/jobs.ts): a fresh copy of the
// job's file, "Allow edits" ticked, the route run through a measured session (write-cost/meter.ts), then the job's
// check of the file. A route that leaves the job undone fails; one that finishes it in a way a designer would not
// (a raw colour where the file has a variable) is reported in the gaps under the table. Then each route's numbers must
// equal the ones recorded in baseline.json: a change that makes a route dearer or cheaper fails here until it is
// re-recorded, so the change shows in review. A route with no recorded numbers fails the same way.
//
// Port rule: nothing here binds 8787–8789 (server-core's DT_TEST_EPHEMERAL_PORT seam; HOME and TMPDIR are a temp dir).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ok, report } from "./assert.ts";
import { fakePlugin } from "./fake-plugin.ts";
import type { World } from "./fake-figma.ts";
import type { ListPagesReply, WhoamiReply } from "../bridge/src/commands.ts";
import { isUnknownArray } from "../bridge/src/json-util.ts";
import { estimateTokens, Ledger, PHASES, type Cost } from "./write-cost/meter.ts";
import { JOBS, type AnyJob, type JobId, type Fixture } from "./write-cost/jobs.ts";
import { BASELINE, fileTool, ROUTES, type Route, type RouteRun, type Reply, type Session } from "./write-cost/routes.ts";
import { setTimeout as sleep } from "node:timers/promises";

const RECORD = process.argv.includes("--record");
const BASELINE_FILE = path.join(import.meta.dirname, "write-cost", "baseline.json");
const TOKEN = "write-cost-token";

/** baseline.json: the numbers each route was last recorded at. */
interface Recorded {
  estimator: string;
  /** estimated tokens of figma_write's definition (name, description, input schema), sent once per session */
  toolDefinition: number;
  routes: Record<string, Partial<Record<JobId, Omit<Cost, "byPhase">>>>;
}
const recorded: Recorded | null = fs.existsSync(BASELINE_FILE) ? (JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as Recorded) : null;

/** The text of a tool reply's content blocks. */
function replyText(r: unknown): Reply {
  const content: unknown = typeof r === "object" && r !== null && "content" in r ? r.content : undefined;
  const parts = isUnknownArray(content) ? content : [];
  const text = parts.map((c) => (typeof c === "object" && c !== null && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
  const isError = typeof r === "object" && r !== null && "isError" in r && r.isError === true;
  return { text, isError };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwc-"));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
for (const k of ["FIGMA_DAEMON_IDLE_MIN", "FIGMA_EXPORT_DIR", "FIGMA_BRIDGE_TOKEN_FILE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) delete env[k];
Object.assign(env, {
  HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, "AppData"), TMPDIR: dir, TEMP: dir, TMP: dir,
  FIGMA_BRIDGE_PORT: "8789", FIGMA_BRIDGE_TOKEN: TOKEN, MAX_MCP_OUTPUT_TOKENS: "", DT_TEST_EPHEMERAL_PORT: "1",
});

interface Row { job: AnyJob; route: Route; cost: Cost | null; problems: string[]; gaps: string[]; error: string | null }

void (async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(import.meta.dirname, "..", "bridge", "src", "figma-mcp.ts")], env, cwd: dir, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (d: Buffer) => { stderr += String(d); });
  const client = new Client({ name: "write-cost", version: "0.0.0" });
  const rows: Row[] = [];
  let toolDefinition = 0;
  try {
    await client.connect(transport);
    let port = 0;
    for (let i = 0; i < 400 && !port; i++) {
      const m = /\[bridge\] DT_TEST_EPHEMERAL_PORT: 8789 -> (\d+)/.exec(stderr);
      if (m) port = Number(m[1]); else await sleep(25);
    }
    ok("the MCP server is up and its bridge is listening", port > 0);
    if (!port) { console.log(stderr); report(); return; }

    const write = (await client.listTools()).tools.find((t) => t.name === "figma_write");
    toolDefinition = estimateTokens(JSON.stringify({ name: write?.name, description: write?.description, inputSchema: write?.inputSchema }));
    ok("figma_write is listed (its definition is measured)", write !== undefined);

    // The plugin: every command runs against the current job's file.
    let world: World | null = null;
    const on = (): World => { if (!world) throw new Error("no job is running"); return world; };
    const plugin = fakePlugin(port, {
      token: TOKEN, hello: { instanceId: "fig-wc", file: "Sample App", page: "Screens" },
      on: {
        ping: () => ({ pong: true, page: "Screens", file: "Sample App" }),
        whoami: (): WhoamiReply => ({ instanceId: "fig-wc", startedAt: 0, uptimeMs: 1, file: "Sample App", page: "Screens", pageId: "", editorType: "figma", pluginVersion: "0.0.0", fileKey: null, fileKeyAvailable: false, editsAllowed: true }),
        // Awaited here: the VM's promise is not this realm's Promise, which fake-plugin.ts tells answers apart by.
        write: async (a) => await on().api.applyWrites(a.ops.map((o) => ({ ...o }))),
        exportNode: async (a) => await on().api.collectNode(a.nodeId, a),
        listPages: async (a): Promise<ListPagesReply> => {
          const r = await on().api.listPages(a.depth !== undefined ? { depth: a.depth } : {});
          return { ...r, depth: r.depth === 1 ? 1 : 2 };
        },
      },
    });
    await plugin.opened;

    for (const route of ROUTES) {
      for (const job of JOBS) {
        const run = route.jobs[job.id] as RouteRun<JobId> | undefined;
        if (!run) continue;
        const fx = job.fixture() as Fixture<JobId>;
        world = fx.c.world();
        await world.allowEdits();
        const ledger = new Ledger();
        const session: Session = {
          dir,
          async call(tool, args, phase) {
            const r = replyText(await client.callTool({ name: tool, arguments: args }));
            ledger.record(tool, args, phase, r.text, r.isError);
            return r;
          },
          file(tool, args, phase) {
            const r = fileTool(dir, tool, args);
            ledger.record(tool, args, phase, r.text, r.isError);
            if (r.isError) throw new Error(`${tool} failed: ${r.text}`);
            return r;
          },
        };
        let error: string | null = null;
        try { await run(session, fx.brief); } catch (e) { error = e instanceof Error ? e.message : String(e); }
        const v = fx.check();
        rows.push({ job, route, cost: ledger.cost(), problems: v.problems, gaps: v.gaps, error });
        world = null;
      }
    }
    plugin.stop();
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- the table
  const n = (x: number): string => x.toLocaleString("en-US");
  const baseOf = (id: JobId): Omit<Cost, "byPhase"> | undefined => recorded?.routes[BASELINE]?.[id];
  const lines = [
    `Write cost per job (tokens estimated as characters / 4; figma_write's definition adds ${n(toolDefinition)} once per session)`,
    "",
    "| job | route | calls (find/write/verify/fix) | ops | out tok | in tok | total tok | vs baseline |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const c = r.cost;
    if (!c) continue;
    const base = baseOf(r.job.id);
    const vs = r.route.name === BASELINE || !base ? "—" : `${Math.round((1 - c.total / base.total) * 100)}% less (${n(base.total - c.total)})`;
    lines.push(`| ${r.job.title} | ${r.route.name} | ${c.calls} (${PHASES.map((p) => c.byPhase[p]).join("/")}) | ${c.ops} | ${n(c.out)} | ${n(c.in)} | ${n(c.total)} | ${vs} |`);
  }
  const gapLines = rows.flatMap((r) => r.gaps.map((g) => `- ${r.job.title}, ${r.route.name}: ${g}`));
  if (gapLines.length) lines.push("", "Done, but not the way a designer would have it:", ...gapLines);
  console.log("\n" + lines.join("\n") + "\n");

  // ---- the checks
  ok("every job has a fixture and a baseline route", JOBS.every((j) => rows.some((r) => r.job.id === j.id && r.route.name === BASELINE)));
  for (const r of rows) {
    const label = `[${r.route.name}] ${r.job.title}`;
    ok(`${label}: the route ran without a failed call${r.error ? ` (${r.error})` : ""}`, r.error === null && (r.cost?.calls ?? 0) > 0);
    ok(`${label}: the file shows the job done${r.problems.length ? ` (${r.problems.slice(0, 3).join("; ")})` : ""}`, r.problems.length === 0);
  }
  if (RECORD) {
    const routes: Recorded["routes"] = {};
    for (const r of rows) {
      if (!r.cost) continue;
      const { byPhase: _byPhase, ...flat } = r.cost;
      (routes[r.route.name] ??= {})[r.job.id] = flat;
    }
    const out: Recorded = { estimator: "ceil(characters / 4)", toolDefinition, routes };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 2) + "\n");
    console.log(`recorded ${rows.length} route/job costs to ${path.relative(process.cwd(), BASELINE_FILE)}`);
  } else {
    const again = "if the change is meant, re-record with: bun test/write-cost.test.ts --record";
    ok(`baseline.json exists (${again})`, recorded !== null);
    ok(`figma_write's definition costs what baseline.json says (${n(toolDefinition)} vs ${n(recorded?.toolDefinition ?? 0)}; ${again})`, recorded?.toolDefinition === toolDefinition);
    for (const r of rows) {
      const want = recorded?.routes[r.route.name]?.[r.job.id];
      const got = r.cost;
      const same = !!want && !!got && want.calls === got.calls && want.ops === got.ops && want.out === got.out && want.in === got.in && want.total === got.total;
      ok(`[${r.route.name}] ${r.job.title}: costs what baseline.json recorded (${got ? `${got.calls} calls, ${got.ops} ops, ${n(got.total)} tok` : "not measured"}` +
        `${want ? ` vs ${want.calls} calls, ${want.ops} ops, ${n(want.total)} tok` : ", nothing recorded"}; ${again})`, same);
    }
  }
  report();
})().catch((e: unknown) => {
  ok(`the suite ran to the end (${e instanceof Error ? e.stack ?? e.message : String(e)})`, false);
  report();
});
