// `dtwin doctor` — one command that says what is wrong with the setup, and what to do about it.
//
// Every failure this tool has looks the same from the outside: a pull that waits and times out. The
// causes are not the same at all — no token, a token the plugin doesn't have, a port held by a
// forgotten daemon or by the MCP server, a plugin that isn't running, a stale export. Each check here
// names ONE of those, marks it ✓ / ! / ✗, and gives the single next step.
//
// Rules it keeps:
//   - NO side effects. It never mints or persists a token (tokenStore.status() resolves with
//     persist:false), never writes a file, and leaves nothing listening. So it is safe to run at any
//     moment, including while a daemon or the MCP server holds the port.
//   - It never opens a WebSocket to a port someone else holds: the bridge registers every WS client as
//     a PLUGIN client, so a probe would disturb routing for whoever owns that bridge (and a
//     wrong-token probe spams its log). A held port is identified with a plain HTTP GET instead — a
//     `ws` server answers 426 Upgrade Required.
//   - server-core is required LAZILY and only once the port is known to be valid and free: it exits
//     the process on a bad FIGMA_BRIDGE_PORT (at require time) and on EADDRINUSE (in createBridge).
//     Those are findings for doctor to report, not ways for it to die.
//
//   dtwin doctor            # human report; exit 1 only if a check is ✗
//   dtwin doctor --wait 30  # wait longer for the plugin to connect (default 10s)
//   dtwin doctor --json     # { ok, checks: [{ id, title, status, detail, next }] }

const fs = require("fs");
const net = require("net");
const http = require("http");
const path = require("path");
const tokenStore = require("./token-store.js");
const daemon = require("./daemon.js");
const { readSnapshotInfo } = require("./snapshot-meta.js");
const { errMsg } = require("./errmsg.js");
const { isOurMcpEntry } = require("./init.js");

// Mirrors server-core's ALLOWED_PORTS (the manifest's allowedDomains). Restated rather than imported
// because requiring server-core with a bad FIGMA_BRIDGE_PORT exits the process — the very case this
// list exists to diagnose. test/bridge.test.js asserts the two stay equal.
const ALLOWED_PORTS = [8787, 8788, 8789];
// Same threshold drift-lint uses for its STALE SNAPSHOT warning.
const STALE_MS = 24 * 60 * 60 * 1000;

const ok = (id, title, detail) => ({ id, title, status: "ok", detail });
const warn = (id, title, detail, next) => ({ id, title, status: "warn", detail, next });
const fail = (id, title, detail, next) => ({ id, title, status: "fail", detail, next });

// ---------------------------------------------------------------- pure checks

// `range` is package.json's engines.node. Only the ">=N" shape this package uses is understood;
// anything else is reported as unknown rather than guessed at.
function checkNode(version, range) {
  const m = /^>=\s*(\d+)/.exec(range || "");
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  if (!m) return warn("node", "Node.js", `${version} (could not read the required version from package.json)`);
  if (major >= Number(m[1])) return ok("node", "Node.js", `${version} (needs ${range})`);
  return fail("node", "Node.js", `${version} is too old — this package needs ${range}`, "install a newer Node.js (nodejs.org, or your version manager)");
}

// `s` is tokenStore.status().
function checkToken(s) {
  if (s.activeSource === "ephemeral") {
    return warn("token", "Bridge token", `none saved yet (${s.path} does not exist)`, "run `dtwin init` — or any pull: the first bridge start creates it and prints it once to paste into the plugin");
  }
  if (s.shadowed) {
    return warn("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) is OVERRIDING the saved token in ${s.path}`, "make sure the plugin has the env var's token — or unset FIGMA_BRIDGE_TOKEN to go back to the saved one");
  }
  if (s.activeSource === "env") return ok("token", "Bridge token", `from FIGMA_BRIDGE_TOKEN (fingerprint ${s.fingerprint})`);
  if (s.loosePerms) return warn("token", "Bridge token", `saved in ${s.path} (fingerprint ${s.fingerprint}), but the file is readable by other users`, `chmod 600 ${s.path}`);
  return ok("token", "Bridge token", `saved in ${s.path} (fingerprint ${s.fingerprint})`);
}

const fileNames = (clients) => (clients || []).map((c) => c.file || "(unidentified)").join(", ");

// One bridge serves several Figma files at once (one client per open plugin window). With more than
// one connected, resolveClient() refuses any plugin-reaching command that doesn't say WHICH file —
// correct, but doctor used to report both connections as a plain ✓, so the next command's refusal
// came as a surprise (live run #2). A connected-and-ambiguous bridge is healthy AND needs a flag;
// say both.
function connectedDetail(clients, prefix) {
  const detail = `${prefix}: ${fileNames(clients)}`;
  if ((clients || []).length < 2) return { detail };
  return {
    detail: `${detail} — ${clients.length} files, so commands must say which`,
    next: "add `--client <connId|fileKey|part of the file name>` to every command that reaches the plugin (`dtwin list clients` lists them; MCP: a `client` argument)",
  };
}

// `st` is daemon.status(port): null when none is running. No daemon is the normal state, not a problem.
function checkDaemon(st, port) {
  if (!st) return ok("daemon", "Daemon", `none running on port ${port} (optional — \`dtwin serve\` keeps the connection open between pulls)`);
  const who = st.pluginConnected ? `plugin connected: ${fileNames(st.clients)}` : "no plugin connected to it";
  return ok("daemon", "Daemon", `running (pid ${st.pid}, port ${st.port}) — ${who}`);
}

// `raw` is FIGMA_BRIDGE_PORT. Returns { port } or { problem: <check> }.
function resolvePort(raw) {
  if (!raw) return { port: ALLOWED_PORTS[0] };
  const n = Number(raw);
  if (ALLOWED_PORTS.includes(n)) return { port: n };
  return { problem: fail("port", "Port", `FIGMA_BRIDGE_PORT=${raw} is not one of ${ALLOWED_PORTS.join(", ")} — the Figma plugin may only open sockets to ports named in its manifest, so nothing could ever connect`, `unset FIGMA_BRIDGE_PORT, or set it to one of ${ALLOWED_PORTS.join(", ")}`) };
}

// `probe` is probePort()'s result; `st` the daemon status for the same port.
function checkPort(port, probe, st) {
  if (probe.free) return ok("port", "Port", `${port} is free`);
  if (st) return ok("port", "Port", `${port} is held by the dtwin daemon (pid ${st.pid}) — pulls route through it`);
  const others = ALLOWED_PORTS.filter((p) => p !== port).join(" or ");
  if (probe.holder === "websocket") {
    return warn("port", "Port", `${port} is held by a WebSocket server that is not a dtwin daemon — most likely the Design Twin MCP server (Claude Code), or a pull still running`, `use the MCP tools (writeToDisk:true) while it runs, or stop it, or run this CLI on another port: FIGMA_BRIDGE_PORT=${others}`);
  }
  return fail("port", "Port", `${port} is held by another program (${probe.detail})`, `find it with \`lsof -i :${port}\` and stop it, or use FIGMA_BRIDGE_PORT=${others} — the plugin walks all three`);
}

// `r` is probePlugin()'s result, or { skipped } when it could not run.
function checkPlugin(r, waitSec) {
  const title = "Figma plugin";
  if (r.skipped) return warn("plugin", title, `not checked — ${r.skipped}`, r.next);
  if (r.clients && r.clients.length) {
    const c = connectedDetail(r.clients, "connected");
    return { id: "plugin", title, status: "ok", detail: c.detail, ...(c.next ? { next: c.next } : {}) };
  }
  if (r.badToken) {
    return fail("plugin", title, `a plugin IS running, but with a different token (fingerprint ${r.badToken.fingerprint || "none — its token field is empty"} vs expected ${r.expected})`, "run `dtwin --show-token`, paste it into the plugin's \"Bridge token\" field, Save");
  }
  if (r.error) return fail("plugin", title, `could not open a bridge to check: ${r.error}`);
  return fail("plugin", title, `no plugin connected within ${waitSec}s`, "in Figma DESKTOP open the file and run Plugins → Development → Design Twin (keep its window open); `--wait 30` waits longer");
}

// Everything about the project in `cwd`. Several checks, none of them ✗: doctor is also run outside a
// project (to debug the connection), where all of this is legitimately absent.
function checkProject(cwd, now = Date.now()) {
  const out = [];
  const designDir = path.join(cwd, "design");
  if (!fs.existsSync(designDir)) {
    out.push(warn("project", "Project", `no design/ in ${cwd}`, "run `dtwin init` in the root of the project you are building (skip this if you are only testing the connection)"));
  } else {
    const hasTarget = fs.existsSync(path.join(designDir, "target.json"));
    out.push(hasTarget ? ok("project", "Project", "design/ and design/target.json present") : warn("project", "Project", "design/ present, but no design/target.json", "run `dtwin init` (it detects the stack), or build-screen will ask on first run"));

    const snap = readSnapshotInfo(designDir);
    // "no export" means no export of ANY shape — design-system.json, a page walk's pages/index.json,
    // or a single-screen design/<Screen>.json (snapshot-meta.js checks all three; naming only the
    // first sent someone who had just pulled a screen off to re-run a pull they had already run).
    if (!snap) out.push(warn("export", "Export", "nothing exported yet (no design-system.json, pages/index.json or screen JSON in design/)", "dtwin list   →   dtwin pull design --node <id>   (or --page <name> / --design-system)"));
    else if (snap.error) out.push(warn("export", "Export", snap.error, "re-run the pull"));
    else if (snap.warning) out.push(warn("export", "Export", snap.warning, "re-run the pull"));
    else {
      const ageMs = now - Date.parse(snap.exportedAt);
      const h = ageMs / 3600000;
      const age = h < 1 ? `${Math.max(0, Math.round(ageMs / 60000))} min` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)} days`;
      const from = snap.sourceFile ? ` from '${snap.sourceFile}'` : "";
      out.push(ageMs > STALE_MS ? warn("export", "Export", `exported ${age} ago${from} — the Figma file may have moved on`, "re-run the pull before building from it") : ok("export", "Export", `exported ${age} ago${from}`));
    }

    const map = path.join(cwd, "codeconnect.local.json");
    out.push(fs.existsSync(map) ? ok("map", "Component map", "codeconnect.local.json present") : warn("map", "Component map", "no codeconnect.local.json — builds cannot reuse your existing components yet", "scaffold one after a pull: /designtwin:build-screen walks you through it"));
  }

  const mcpFile = path.join(cwd, ".mcp.json");
  if (fs.existsSync(mcpFile)) {
    let servers = null;
    try { servers = JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers || {}; } catch (e) { out.push(warn("mcp", "MCP registration", ".mcp.json is not valid JSON: " + errMsg(e), "fix it, then `dtwin init --mcp`")); }
    if (servers) {
      const mine = Object.keys(servers).find((k) => isOurMcpEntry(servers[k]));
      if (!mine) out.push(ok("mcp", "MCP registration", "not registered in .mcp.json (optional — `dtwin init --mcp` adds it)"));
      else if (mine === "designtwin") out.push(ok("mcp", "MCP registration", 'registered as "designtwin" in .mcp.json'));
      else out.push(warn("mcp", "MCP registration", `registered under the legacy key "${mine}" — it still works, but new setups use "designtwin" ("figma" collides with Figma's own MCP server)`, `rename the "${mine}" key in .mcp.json to "designtwin", then restart Claude Code`));
    }
  }
  return out;
}

// ---------------------------------------------------------------- probes (I/O)

// Is the port free, and if not, what kind of thing holds it? Binds exactly as the bridge does
// (127.0.0.1), then lets go at once. Never opens a WebSocket — see the header.
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => {
      if (e.code !== "EADDRINUSE") return resolve({ free: false, holder: "unknown", detail: errMsg(e) });
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 426 ? { free: false, holder: "websocket" } : { free: false, holder: "http", detail: `an HTTP server, answered ${res.statusCode}` });
      });
      req.on("timeout", () => req.destroy(new Error("no HTTP answer")));
      req.on("error", (err) => resolve({ free: false, holder: "unknown", detail: "not an HTTP server: " + errMsg(err) }));
    });
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve({ free: true })));
  });
}

// Open a real bridge on the (free) port and see whether a plugin shows up. The plugin retries every
// 3s and may be walking three ports, hence the wait. The bridge's own stderr chatter is muted for the
// duration: doctor reports the same facts itself, in one place. ALWAYS closes.
async function probePlugin(port, waitMs) {
  const realError = console.error;
  console.error = () => {};
  let bridge = null;
  try {
    const core = require("./server-core");
    bridge = core.createBridge(port);
    const start = Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Only a refusal from THIS probe counts — authStats is module-wide.
    const refused = () => { const b = core.authStats().lastBadToken; return b && b.at >= start ? b : null; };
    while (Date.now() - start < waitMs && !bridge.isConnected() && !refused()) await sleep(200);
    if (bridge.isConnected()) {
      // The file name arrives in a hello just after the socket opens — give it a moment.
      for (let i = 0; i < 10 && bridge.listClients().some((c) => !c.identified); i++) await sleep(150);
      return { clients: bridge.listClients() };
    }
    return { clients: [], badToken: refused(), expected: core.authStats().expected };
  } catch (e) {
    return { clients: [], error: errMsg(e) };
  } finally {
    if (bridge) bridge.close();
    console.error = realError;
  }
}

// ---------------------------------------------------------------- run + report

// `onCheck` sees each result the moment it is known, and `onWait` fires before the one slow step (the
// plugin wait). Printing only at the end meant a caller with a short timeout — an agent shelling out —
// got NOTHING, not even the instant Node/token answers, if the plugin wait outlived it.
async function run({ cwd = process.cwd(), waitSec = 10, onCheck, onWait } = {}) {
  const checks = [];
  const add = (...cs) => { for (const c of cs) { checks.push(c); if (onCheck) onCheck(c); } };
  const engines = (() => { try { return require("./package.json").engines.node; } catch (e) { return null; } })();
  add(checkNode(process.version, engines));

  const tok = tokenStore.status();
  add(checkToken(tok));

  const { port, problem } = resolvePort(process.env.FIGMA_BRIDGE_PORT);
  if (problem) {
    add(problem, checkPlugin({ skipped: "the port setting has to be fixed first" }));
  } else {
    const st = await daemon.status(port).catch(() => null);
    add(checkDaemon(st, port));
    const probe = await probePort(port);
    add(checkPort(port, probe, st));

    if (st) {
      // The daemon owns the bridge, so its view IS the answer — no second bridge needed (or possible).
      add(st.pluginConnected
        ? (() => { const c = connectedDetail(st.clients, "connected (through the daemon)");
            return { id: "plugin", title: "Figma plugin", status: "ok", detail: c.detail, ...(c.next ? { next: c.next } : {}) }; })()
        : fail("plugin", "Figma plugin", "the daemon is running, but no plugin is connected to it", "in Figma DESKTOP open the file and run Plugins → Development → Design Twin; if its window says the token is wrong, re-paste `dtwin --show-token`"));
    } else if (!probe.free) {
      add(checkPlugin({ skipped: `port ${port} is held by something else, and probing it would disturb it`, next: probe.holder === "websocket" ? "if that is the MCP server, ask Claude Code to call figma_status — it reports the plugin connection" : undefined }));
    } else if (tok.activeSource === "ephemeral") {
      add(checkPlugin({ skipped: "there is no token yet, and doctor never creates one", next: "run `dtwin init`, paste the token into the plugin, then run doctor again" }));
    } else {
      if (onWait) onWait(waitSec);
      add(checkPlugin(await probePlugin(port, waitSec * 1000), waitSec));
    }
  }

  add(...checkProject(cwd));
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

const MARK = { ok: "✓", warn: "!", fail: "✗" };

const formatCheck = (c) => `${MARK[c.status]} ${c.title}: ${c.detail}` + (c.next ? `\n    → ${c.next}` : "");
function verdict(report) {
  const n = (s) => report.checks.filter((c) => c.status === s).length;
  return n("fail") ? `${n("fail")} problem(s) to fix${n("warn") ? `, ${n("warn")} note(s)` : ""}.` : n("warn") ? `No blocking problems; ${n("warn")} note(s) above.` : "All good.";
}

async function main(argv) {
  let waitSec = 10;
  let json = false;
  const usage = "Usage: dtwin doctor [--wait <seconds>] [--json]";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log("dtwin doctor [--wait <seconds>] [--json]\n\n  Checks the whole setup and says what to do next: Node version, bridge token, daemon, port,\n  whether the Figma plugin can connect (and whether it has the right token), and the project in\n  the current directory. Changes nothing: no token is created, no file is written.\n  --wait N   seconds to wait for the plugin to connect (default 10; it retries every 3s)\n  --json     machine output: { ok, checks: [{ id, title, status, detail, next }] }\n\n  Exit code 1 only when a check is ✗ (a note, !, is not a failure).");
      process.exit(0);
    } else if (a === "--wait" || a.startsWith("--wait=")) {
      const v = a === "--wait" ? argv[++i] : a.slice("--wait=".length);
      waitSec = Number(v);
      if (!v || !Number.isFinite(waitSec) || waitSec < 0) { console.error(`[dtwin doctor] error: --wait needs a number of seconds. ${usage}`); process.exit(1); }
    } else { console.error(`[dtwin doctor] error: unknown argument: ${a}. ${usage}`); process.exit(1); }
  }
  // Human output streams; --json stays one document at the end (a consumer parses it whole).
  const report = await run(json ? { waitSec } : {
    waitSec,
    onCheck: (c) => console.log(formatCheck(c)),
    onWait: (sec) => console.log(`… waiting up to ${sec}s for the Figma plugin to connect (run it in Figma now; --wait 0 skips)`),
  });
  console.log(json ? JSON.stringify(report, null, 2) : "\n" + verdict(report));
  // exitCode, not exit(): let stdout drain (a piped --json would otherwise be cut short).
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = { ALLOWED_PORTS, checkNode, checkToken, checkDaemon, resolvePort, checkPort, checkPlugin, checkProject, probePort, probePlugin, run, main };
