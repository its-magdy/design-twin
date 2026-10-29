// bridge/src/read-run.ts: one read, executed once — the plan sent through the route to the file named, its ticks
// relayed (the meter, the caller, `queued` said once), cancellable, timed, and its reply stamped with the file that
// answered before any writer sees it. Through an in-process route over a real server-core bridge and the fake plugin
// (test/fake-plugin.ts): no CLI or MCP process is spawned. The bridge binds an ephemeral port.
//   bun test/read-run.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fakePlugin, HANG, type FakePlugin, type Handlers } from "./fake-plugin.ts";
import { check, report } from "./assert.ts";
import { screenReply } from "./fixtures.ts";
import { settingsAt } from "./bridge-settings.ts";
import { planRead } from "../bridge/src/read-plan.ts";
import { meteredRequest, runRead, tickMessage } from "../bridge/src/read-run.ts";
import type { ReadMeter } from "../bridge/src/read-run.ts";
import type { PlanOf } from "../bridge/src/read-plan.ts";
import type { ProgressTick } from "../bridge/src/server-core.ts";

const TOKEN = "read-run-test-token";
process.env.FIGMA_BRIDGE_TOKEN = TOKEN;
process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "read-run-")); // mkdtemp: 0700, ours
const core = await import("../bridge/src/server-core.ts");
const { createRoute, ownUpstream } = await import("../bridge/src/route.ts");

const asErr = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
const node = (file: string) => screenReply({ screenName: file, nodeId: "1:2", page: "Home", pageId: "0:1", screen: { screen: file, exportedAt: "2026-10-01T00:00:00.000Z", nodes: [] } });

async function plugin(port: number, file: string, on: Handlers): Promise<FakePlugin> {
  const p = fakePlugin(port, { token: TOKEN, hello: { instanceId: "fig-" + file, file, fileKey: "KEY-" + file, page: "Home", pluginVersion: "0.0.0" }, on, unhandled: HANG });
  await p.opened;
  await sleep(50); // the hello lands before anything is asked
  return p;
}

const b = core.createBridge(settingsAt(0), { settleMs: 0, heartbeatMs: 0 });
await b.listening;
const port = b.boundPort();
if (port === null) throw new Error("the bridge did not bind");
const route = createRoute(async () => ownUpstream(b), { connectWaitMs: 0, oneShot: false });
const planOf = (nodeId: string): PlanOf<"exportNode"> => {
  const p = planRead({ kind: "node", nodeId });
  if ("refused" in p || p.cmd !== "exportNode") throw new Error("not a node plan");
  return p;
};

try {
  console.log("tickMessage: a tick, said");
  {
    const t = (x: Partial<ProgressTick>): ProgressTick => ({ phase: null, page: null, nodes: null, assets: null, ...x });
    check("phase, page, nodes, assets", tickMessage(t({ phase: "pages", page: { index: 2, of: 3, name: "Home" }, nodes: 120, assets: 4 })) === "pages, page 2 of 3 (Home), 120 nodes, 4 assets");
    check("no phase: `export`; an unnamed page has no name", tickMessage(t({ page: { index: 1, of: 1, name: null } })) === "export, page 1 of 1");
  }

  // Two files open: the run reaches the one named, and its reply is stamped with that one.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const app = await plugin(port, "Sample App", {
    exportNode: async (_args, ctx) => {
      ctx.progress({ phase: "queued", page: null, nodes: null, assets: null });
      ctx.progress({ phase: "queued", page: null, nodes: null, assets: null });
      ctx.progress({ phase: "pages", page: { index: 1, of: 1, name: "Home" }, nodes: 5, assets: null });
      await gate;
      return node("Sample App");
    },
  });
  const kit = await plugin(port, "Kit", { exportNode: () => node("Kit"), ping: () => ({ pong: true, page: "Home", file: "Kit" }) });

  console.log("a read, run once");
  {
    const heard: string[] = [];
    const meter: ReadMeter = { sent: () => heard.push("sent"), replied: () => heard.push("replied"), tick: (ph) => heard.push("tick:" + String(ph)) };
    const ticks: string[] = [];
    let queued = 0;
    const tally = { exportMs: 0, writeMs: 0 };
    setTimeout(release, 120);
    const run = await runRead(route, planOf("1:2"), { target: "Sample App", meter, tally, onProgress: (t) => ticks.push(String(t.phase)), onQueued: () => queued++ });
    check("the plan was sent to the file named, as planned", app.commands("exportNode").length === 1 && kit.commands("exportNode").length === 0
      && JSON.stringify(app.commands("exportNode")[0]?.args) === JSON.stringify(planOf("1:2").args));
    check(`the reply is stamped with the file that answered (got ${String(run.reply.sourceFile)})`, run.reply.sourceFile === "Sample App" && run.reply.sourceFileKey === "KEY-Sample App" && run.client?.file === "Sample App");
    check(`every tick reaches the caller (got ${ticks.join(",")})`, ticks.join(",") === "queued,queued,pages");
    check("`queued` is said once, however many queued ticks", queued === 1);
    check(`the meter hears sent, each tick, then replied (got ${heard.join(",")})`, heard.join(",") === "sent,tick:queued,tick:queued,tick:pages,replied");
    check(`the request is timed, and added to the tally (${run.requestMs} ms)`, run.requestMs >= 100 && Math.abs(tally.exportMs - run.requestMs) <= 5);
    check("nothing written yet: write is 0", run.durationMs().write === 0 && run.durationMs().total >= run.requestMs);
    let seen: unknown;
    const out = run.write((r) => { seen = r.sourceFile; const t = Date.now(); while (Date.now() - t < 20) { /* a write that takes time */ } return "wrote"; });
    check("write hands the writer the stamped reply, and returns what it wrote", seen === "Sample App" && out === "wrote");
    const d = run.durationMs();
    check(`…timed, and added to the tally (${d.write} ms)`, d.write >= 20 && tally.writeMs === d.write && d.total >= d.request + d.write - 2);
  }

  console.log("a read with no meter and no listener");
  {
    const run = await runRead(route, planOf("1:2"), { target: "Kit" });
    check("stamped all the same", run.reply.sourceFile === "Kit");
  }

  console.log("a request that is not a read, measured the same way");
  {
    const heard: string[] = [];
    const tally = { exportMs: 0, writeMs: 0 };
    const { sent, ms } = await meteredRequest(() => route.request("ping", {}, { target: "Kit" }), { meter: { sent: () => heard.push("sent"), replied: () => heard.push("replied"), tick: () => {} }, tally });
    check("the meter hears it; its time is added to the tally", heard.join(",") === "sent,replied" && sent.client?.file === "Kit" && Math.abs(tally.exportMs - ms) <= 5);
    const failed = { exportMs: 0, writeMs: 0 };
    const why = await meteredRequest(() => route.request("ping", {}, { target: "Nobody" }), { tally: failed }).then(() => "resolved", (e: unknown) => asErr(e).message);
    check(`a request that fails rejects as it did, its time still counted (${why})`, why !== "resolved" && failed.exportMs >= 0);
  }

  console.log("cancel");
  {
    const mute = await plugin(port, "Mute", { exportNode: () => HANG });
    const ac = new AbortController();
    const pending = runRead(route, planOf("1:2"), { target: "Mute", signal: ac.signal }).then(() => "resolved", (e: unknown) => asErr(e).message);
    await sleep(150);
    ac.abort(new Error("caller gave up"));
    const why = await pending;
    for (let i = 0; i < 40 && mute.cancels.length === 0; i++) await sleep(25);
    check(`an aborted run rejects (${why}), and the plugin is told`, why !== "resolved" && mute.cancels.length === 1);
    mute.terminate();
  }
  app.terminate();
  kit.terminate();
} finally {
  b.close();
}

report();
