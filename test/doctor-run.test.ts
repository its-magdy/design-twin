// doctor.run() over a fake observer (bridge-observer.ts): every branch of the bridge part of the report — a bad port,
// a daemon with or without a plugin (and one too old to report versions), a port held by something else, no token
// yet, and the observer's own probe bridge (connected, several files, a wrong token, nobody, could not open) — with
// no socket, no port and no daemon. The real observer's probes are checked against real sockets in bridge.test.ts.
//   bun test/doctor-run.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, report } from "./assert.ts";
import { clientRow, malformed } from "./fixtures.ts";
import * as doctor from "../bridge/src/doctor.ts";
import type { Check, Report } from "../bridge/src/doctor.ts";
import type { BridgeObserver, Holding, OwnView } from "../bridge/src/bridge-observer.ts";
import type { BridgeSettings, SettingsResult } from "../bridge/src/settings.ts";
import type { TokenStatus } from "../bridge/src/token-store.ts";
import type { DaemonStatusView } from "../bridge/src/daemon.ts";
import type { ClientRow } from "../bridge/src/server-core.ts";
import { BRIDGE_VERSION } from "../bridge/src/staleness.ts";
import { PLUGIN_MENU } from "../bridge/src/hints.ts";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-doctor-run-"));
const settings = (source: "file" | "ephemeral" = "file"): BridgeSettings => ({
  port: 8787,
  token: { ok: true, resolved: { token: "t", source, path: "/cfg/bridge-token", created: false } },
  maxPayload: { mb: 128, bytes: 128 * 1024 * 1024 },
  idleMs: 0,
  idleRaw: undefined,
  ephemeralPort: false,
});
const tokS: TokenStatus = { path: "/cfg/bridge-token", stored: true, envSet: false, activeSource: "file", fingerprint: "abcd1234", loosePerms: false, shadowed: false };

/** A fake observer that says `holding`, and `own` when watched — recording what it was asked. */
function fake(holding: Holding, own: OwnView = { via: "own", clients: [], badToken: null, expected: "ffff0000" }) {
  const calls = { factory: [] as BridgeSettings[], holder: 0, watch: [] as number[], onWait: [] as number[] };
  const observer = (s: BridgeSettings): BridgeObserver => {
    calls.factory.push(s);
    return {
      holder: async () => { calls.holder++; return holding; },
      watch: async (ms) => { calls.watch.push(ms); return own; },
    };
  };
  return { observer, calls };
}

async function runWith(o: { settings?: SettingsResult; holding?: Holding; own?: OwnView; token?: TokenStatus; env?: NodeJS.ProcessEnv }): Promise<{ r: Report; calls: ReturnType<typeof fake>["calls"]; plugin: Check | undefined; byId: (id: string) => Check | undefined }> {
  const f = fake(o.holding ?? { via: "free", port: { free: true }, refused: null }, o.own);
  const r = await doctor.run({
    cwd, waitSec: 7, settings: o.settings ?? { ok: true, settings: settings() }, observer: f.observer,
    token: o.token ?? tokS, env: o.env ?? {}, onWait: (s) => f.calls.onWait.push(s),
  });
  const byId = (id: string) => r.checks.find((c) => c.id === id);
  return { r, calls: f.calls, plugin: byId("plugin"), byId };
}

const daemonAt = (over: Partial<DaemonStatusView>): Holding => ({ via: "daemon", status: { daemon: true, pid: 77, port: 8787, ...over }, port: { free: false, holder: "websocket" }, refused: null });
const current = (file: string, connId = "c1"): ClientRow => clientRow({ connId, file, identified: true, pluginVersion: BRIDGE_VERSION });

console.log("\ndoctor.run — a port setting no plugin can reach:");
{
  const { r, calls, plugin, byId } = await runWith({ settings: { ok: false, problem: "bad port" }, env: { FIGMA_BRIDGE_PORT: "9999" } });
  check("the port check fails, naming the value", byId("port")?.status === "fail" && /9999/.test(byId("port")?.detail ?? ""));
  check("the plugin check is skipped, so the report is not ok", plugin?.skipped === true && r.ok === false);
  check("the observer is never made or asked", calls.factory.length === 0 && calls.holder === 0 && calls.watch.length === 0);
}

console.log("\ndoctor.run — a daemon holds the bridge:");
{
  const s = settings();
  const f = fake(daemonAt({ pluginConnected: true, clients: [current("App")] }));
  const r = await doctor.run({ cwd, waitSec: 7, settings: { ok: true, settings: s }, observer: f.observer, token: tokS, env: {} });
  const plugin = r.checks.find((c) => c.id === "plugin");
  check("the observer gets the settings run() was given, and is asked once", f.calls.factory.length === 1 && f.calls.factory[0] === s && f.calls.holder === 1);
  check("its view is the answer: connected through the daemon, ok, no probe bridge", plugin?.status === "ok" && /through the daemon/.test(plugin.detail) && f.calls.watch.length === 0);
  check("the daemon and port checks say the daemon holds it", r.checks.find((c) => c.id === "daemon")?.status === "ok" && /held by the dtwin daemon \(pid 77\)/.test(r.checks.find((c) => c.id === "port")?.detail ?? ""));
}
{
  // A daemon whose own rows predate version reporting (no pluginVersion KEY at all): the daemon is stale, a warn.
  const old = malformed<ClientRow>({ connId: "c1", file: "Old Daemon File", identified: true });
  const { plugin } = await runWith({ holding: daemonAt({ pluginConnected: true, clients: [old] }) });
  check("a daemon-relayed row with no pluginVersion key demotes the plugin check to a warn naming the daemon restart",
    plugin?.status === "warn" && /dtwin serve/.test(plugin.next ?? ""));
}
{
  const { plugin } = await runWith({ holding: daemonAt({ pluginConnected: true, clients: [current("App"), current("Library", "c2")] }) });
  check("two files through the daemon: still ok, saying commands must pick one", plugin?.status === "ok" && /2 files/.test(plugin.detail) && /--client/.test(plugin.next ?? ""));
}
{
  const { plugin } = await runWith({ holding: daemonAt({ pluginConnected: false, clients: [] }) });
  check("a daemon with no plugin: a failure naming the plugin step and the token paste",
    plugin?.status === "fail" && (plugin.next ?? "").includes(PLUGIN_MENU) && /--show-token/.test(plugin.next ?? ""));
}
{
  const shadowed: TokenStatus = { ...tokS, envSet: true, activeSource: "env", shadowed: true };
  const { byId } = await runWith({ holding: daemonAt({ pluginConnected: true, clients: [current("App")] }), token: shadowed });
  check("a shadowed token through a daemon proves nothing: could not be checked", byId("token")?.status === "warn" && /could not be checked/.test(byId("token")?.detail ?? ""));
}

console.log("\ndoctor.run — the port is held by something else:");
{
  const { plugin, byId, calls } = await runWith({ holding: { heldBy: "websocket", port: { free: false, holder: "websocket" }, refused: null } });
  check("a WebSocket holder: skipped, pointing at figma_status, and never probed", plugin?.skipped === true && /figma_status/.test(plugin.next ?? "") && calls.watch.length === 0);
  check("…and the port check is a note", byId("port")?.status === "warn");
}
{
  const { plugin, byId } = await runWith({ holding: { heldBy: "http", detail: "an HTTP server, answered 200", port: { free: false, holder: "http", detail: "an HTTP server, answered 200" }, refused: null } });
  check("an HTTP holder: skipped with no figma_status step, and the port check fails", plugin?.skipped === true && plugin.next === undefined && byId("port")?.status === "fail");
}

console.log("\ndoctor.run — a refused daemon socket location:");
{
  const { byId } = await runWith({ holding: { via: "free", port: { free: true }, refused: "the socket directory /x is not private" } });
  check("the daemon check fails with the reason", byId("daemon")?.status === "fail" && /not private/.test(byId("daemon")?.detail ?? ""));
}

console.log("\ndoctor.run — the port is free:");
{
  const { plugin, calls } = await runWith({ settings: { ok: true, settings: settings("ephemeral") } });
  check("no token yet: skipped, naming init — no wait, no probe bridge", plugin?.skipped === true && /dtwin init/.test(plugin.next ?? "") && calls.watch.length === 0 && calls.onWait.length === 0);
}
{
  const { plugin, calls } = await runWith({ own: { via: "own", clients: [current("App")], badToken: null, expected: "ffff0000" } });
  check("a plugin on the probe bridge: ok, after onWait and one watch of waitSec", plugin?.status === "ok" && /connected: App/.test(plugin.detail)
    && calls.onWait.join() === "7" && calls.watch.join() === "7000");
}
{
  const { plugin } = await runWith({ own: { via: "own", clients: [current("App"), current("Library", "c2")], badToken: null, expected: null } });
  check("two files on the probe bridge: ok, naming --client", plugin?.status === "ok" && /--client/.test(plugin.next ?? ""));
}
{
  const { plugin } = await runWith({ own: { via: "own", clients: [], badToken: { at: 1, fingerprint: "11111111" }, expected: "22222222" } });
  check("a refused token: a failure with both fingerprints and the paste step",
    plugin?.status === "fail" && /11111111/.test(plugin.detail) && /22222222/.test(plugin.detail) && /--show-token/.test(plugin.next ?? ""));
}
{
  const { plugin } = await runWith({});
  check("nobody came: a failure naming the plugin step and --wait", plugin?.status === "fail" && /within 7s/.test(plugin.detail) && (plugin.next ?? "").includes(PLUGIN_MENU) && /--wait/.test(plugin.next ?? ""));
}
{
  const { plugin } = await runWith({ own: { error: "EADDRINUSE" } });
  check("a probe bridge that could not open: a failure saying why", plugin?.status === "fail" && /could not open a bridge to check: EADDRINUSE/.test(plugin.detail));
}

report();
