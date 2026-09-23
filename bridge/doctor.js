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
const LAYOUT = require("./project-layout.js");
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

// `s` is tokenStore.status(). `pluginCheck` (P4 livetest-4 #328) is the ALREADY-COMPUTED plugin check
// from later in run() — passed in only when `s.shadowed` is true, so the shadowed-token note can say
// what actually happened instead of a blanket "make sure the plugin has it": a connection succeeding
// under the overriding token IS the evidence it was accepted; a connection that never happened means
// this could not be checked at all, which is a different, more honest thing to say than "make sure".
// `viaDaemon` matters because a connection routed THROUGH an already-running daemon proves nothing
// about THIS process's token: the daemon authenticated the plugin once, at its own start, and every
// later command's socket auth is skipped — a bogus FIGMA_BRIDGE_TOKEN still shows "connected" there
// (livetest-4 #328's exact repro: `list clients` works and `doctor` says ok:true with a bogus token).
// Only a connection THIS process itself negotiated (no daemon in front) is real evidence either way.
function checkToken(s, pluginCheck, viaDaemon) {
  if (s.activeSource === "ephemeral") {
    return warn("token", "Bridge token", `none saved yet (${s.path} does not exist)`, "run `dtwin init` — or any pull: the first bridge start creates it and prints it once to paste into the plugin");
  }
  if (s.shadowed) {
    if (pluginCheck && pluginCheck.status === "ok" && !viaDaemon) {
      return ok("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path} — the plugin connected using it, so the override is working as intended`);
    }
    if (pluginCheck && pluginCheck.status === "fail" && /different token/.test(pluginCheck.detail || "")) {
      return fail("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path}, and the connected plugin rejected it`, "paste `dtwin --show-token`'s value into the plugin, or unset FIGMA_BRIDGE_TOKEN to go back to the saved token");
    }
    const why = viaDaemon
      ? "a running daemon already holds an authenticated connection, so this override was not exercised by this check"
      : pluginCheck && pluginCheck.detail ? `plugin: ${pluginCheck.detail}` : "no daemon/plugin reachable";
    return warn("token", "Bridge token", `FIGMA_BRIDGE_TOKEN (${s.fingerprint}) OVERRIDES the saved token in ${s.path} — whether the plugin accepts it could not be checked (${why})`, "make sure the plugin has the env var's token — or unset FIGMA_BRIDGE_TOKEN to go back to the saved one");
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
//
// Finding 327: also surfaces a stale plugin bundle here — the ONE place doctor already reports which
// files are connected, so a version mismatch is seen in the same breath rather than needing a second
// command. `pluginStale` is computed server-side (server-core.js's `describe()`), so doctor doesn't
// duplicate the version-compare logic; it just relays whichever client(s) are behind.
function connectedDetail(clients, prefix) {
  const detail = `${prefix}: ${fileNames(clients)}`;
  const stale = (clients || []).map((c) => c.pluginStale).filter(Boolean);
  if ((clients || []).length < 2 && !stale.length) return { detail };
  const bits = [];
  if ((clients || []).length >= 2) bits.push(`${detail} — ${clients.length} files, so commands must say which`);
  const nexts = [];
  if ((clients || []).length >= 2) nexts.push("add `--client <connId|fileKey|part of the file name>` to every command that reaches the plugin (`dtwin list clients` lists them; MCP: a `client` argument)");
  if (stale.length) nexts.push(...new Set(stale));
  return {
    detail: bits.length ? bits[0] : detail,
    next: nexts.length ? nexts.join(" ") : undefined,
  };
}

// `st` is daemon.status(port): null when none is running. Without a daemon, every `dtwin pull` starts
// its own throwaway bridge and waits out the plugin's full reconnect window — the difference between
// an 8s pull and a 300s+ timeout (findings 202/213/220), and `--client c1` becomes reconnect-order
// roulette (finding 209) instead of a stable id across a daemon's lifetime. That is a real cost, not a
// cosmetic one, so a missing daemon is reported `warn`, never `ok` — "optional" undersold it.
function checkDaemon(st, port) {
  if (!st) {
    return warn(
      "daemon", "Daemon",
      `none running on port ${port} — every pull will start its own bridge and wait out the plugin's reconnect window (this is what turns a normal export into a 300s+ timeout, and makes --client c1 unstable across runs)`,
      "run `dtwin serve` in a background terminal before pulling — it keeps one bridge alive so plugins stay connected between commands"
    );
  }
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
    // A stale plugin bundle IS a problem worth a warn, unlike the multi-client case (still `ok` — being
    // connected to several files at once is healthy, it just needs `--client`). Only staleness demotes
    // the status; an ambiguous-but-current multi-client connection stays `ok` exactly as before.
    const stale = r.clients.some((cl) => cl.pluginStale);
    return { id: "plugin", title, status: stale ? "warn" : "ok", detail: c.detail, ...(c.next ? { next: c.next } : {}) };
  }
  if (r.badToken) {
    return fail("plugin", title, `a plugin IS running, but with a different token (fingerprint ${r.badToken.fingerprint || "none — its token field is empty"} vs expected ${r.expected})`, "run `dtwin --show-token`, paste it into the plugin's \"Bridge token\" field, Save");
  }
  if (r.error) return fail("plugin", title, `could not open a bridge to check: ${r.error}`);
  return fail("plugin", title, `no plugin connected within ${waitSec}s`, "in Figma DESKTOP open the file and run Plugins → Development → Design Twin (keep its window open); `--wait 30` waits longer");
}

const ageStr = (ms) => { const h = ms / 3600000; return h < 1 ? `${Math.max(0, Math.round(ms / 60000))} min` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)} days`; };

// P4 #33: the root pages/index.json's `layers[]` already carries every screen's `sourceFile` and
// `exportedAt` (write-out.js stamps both; a screen pulled before that field existed simply has no
// `sourceFile`, which is told apart from a real value rather than defaulting to the design system's).
// Reading it directly means this never has to guess by opening each screen file, or fall back to
// whichever document snapshot-meta happened to pick first — the exact bug this replaces (finding 33:
// "attributes the whole export to the wrong Figma file").
function exportSourceCounts(exportDir, now) {
  const screensByFile = new Map(); // file (or "" for unstamped) -> [{exportedAt}]
  const note = (l) => { const key = l.sourceFile || ""; if (!screensByFile.has(key)) screensByFile.set(key, []); screensByFile.get(key).push(l.exportedAt); };
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(exportDir, "pages", "index.json"), "utf8"));
    // The root `layers[]` only ever holds what write-out.js's writeScreen path has merged into it — a
    // whole-page pull's layers never backfill it (mergeRootIndex only appends the ONE entry its own
    // call passed). So the true, complete list is every PAGE's own index, keyed by `file` so a screen
    // present in BOTH (a single-screen re-pull of a frame the original page walk also wrote) counts
    // once — root wins that merge since it is the more recently written of the two.
    const byFile = new Map();
    for (const p of idx.pageDirs || []) {
      try { const pi = JSON.parse(fs.readFileSync(path.join(exportDir, p.index), "utf8")); for (const l of pi.layers || []) if (l && l.file) byFile.set(l.file, l); } catch { /* page index missing/corrupt */ }
    }
    for (const l of idx.layers || []) if (l && l.file) byFile.set(l.file, l);
    for (const l of byFile.values()) note(l);
  } catch { /* no page index — a design-system-only or as-yet-empty export */ }
  let designSystem = null;
  const maybe = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(exportDir, rel), "utf8")); } catch { return null; } };
  const dsDoc = maybe("design-system.json") || maybe(path.join("design-system", "tokens.json"));
  if (dsDoc && dsDoc.file) designSystem = { file: dsDoc.file, exportedAt: dsDoc.exportedAt };

  const parts = [];
  let newestOverall = null;
  const noteNewest = (iso) => { const t = Date.parse(iso); if (!Number.isNaN(t) && (newestOverall === null || t > newestOverall)) newestOverall = t; };
  for (const [file, ats] of screensByFile) {
    if (!file) continue;
    const newest = ats.reduce((a, b) => (Date.parse(b) > Date.parse(a || 0) ? b : a), ats[0]);
    noteNewest(newest);
    parts.push(`${ats.length} screen(s) from '${file}' (newest ${ageStr(now - Date.parse(newest))} ago)`);
  }
  const unstamped = (screensByFile.get("") || []).length;
  if (unstamped) parts.push(`${unstamped} screen(s) (source not recorded — pulled by an older bridge; re-pull to stamp it)`);
  if (designSystem) {
    noteNewest(designSystem.exportedAt);
    parts.push(`design system from '${designSystem.file}' (${ageStr(now - Date.parse(designSystem.exportedAt))} ago)`);
  }
  return { parts, newestOverall };
}

// Everything about the project in `cwd`. Several checks, none of them ✗: doctor is also run outside a
// project (to debug the connection), where all of this is legitimately absent.
function checkProject(cwd, now = Date.now()) {
  const out = [];
  const designDir = path.join(cwd, LAYOUT.DESIGN_DIR);
  if (!fs.existsSync(designDir)) {
    out.push(warn("project", "Project", `no design/ in ${cwd}`, "run `dtwin init` in the root of the project you are building (skip this if you are only testing the connection)"));
  } else {
    const hasTarget = fs.existsSync(path.join(cwd, LAYOUT.TARGET_FILE));
    out.push(hasTarget ? ok("project", "Project", "design/ and design/target.json present") : warn("project", "Project", "design/ present, but no design/target.json", "run `dtwin init` (it detects the stack), or build-screen will ask on first run"));

    // Which layout this project uses, said out loud. A project created before the export/ split keeps
    // working, but "where do my files land" must never be a thing the user has to infer.
    const ex = LAYOUT.findExportDir(cwd);
    if (ex.layout === "legacy-flat") {
      out.push(warn("layout", "Layout", "this project uses the older flat layout — exports live directly in design/, beside your hand-owned target.json / plan / audit",
        "it keeps working as is. To adopt the current split, move the export into design/export/ (pages/, design-system/, assets/, variables.json, libraries/) so `rm -rf design/export` can never take your decisions with it"));
    } else if (ex.layout === "export-subdir" && ex.parallelLegacy) {
      // P4 #14/#33/#203: a stray `dtwin pull design ...` wrote a SECOND export tree directly under
      // design/ (design/pages/, design/assets/, design/variables.json, design/design-system/) beside
      // the real one at design/export/. Doctor reads only design/export/ below, so say so out loud —
      // silently picking one, as before, is exactly the trap this project is in.
      out.push(warn("layout", "Layout", `found BOTH layouts: reading ${ex.rel}/ (the current one), but design/pages/, design/assets/, design/variables.json and/or design/design-system/ ALSO exist beside it — a stray pull wrote a second, parallel export tree`,
        "the two trees can disagree (e.g. two different variables.json). Move anything real out of the stray design/pages, design/assets, design/variables.json, design/design-system into design/export/, then remove them — never `dtwin pull design ...` (that outDir already contains export/); use `dtwin pull --node <id>` etc."));
    }

    const snap = readSnapshotInfo(ex.dir);
    // "no export" means no export of ANY shape — design-system.json, a page walk's pages/index.json,
    // or a single-screen pages/<Page>/<Screen>.json (snapshot-meta.js checks all three; naming only
    // the first sent someone who had just pulled a screen off to re-run a pull they had already run).
    if (!snap) out.push(warn("export", "Export", `nothing exported yet (no design-system.json, pages/index.json or screen JSON in ${ex.rel}/)`, "dtwin list   →   dtwin pull --node <id>   (or --page <name> / --design-system)"));
    else if (snap.error) out.push(warn("export", "Export", snap.error, "re-run the pull"));
    else if (snap.warning) out.push(warn("export", "Export", snap.warning, "re-run the pull"));
    else {
      const ageMs = now - Date.parse(snap.exportedAt);
      // P4 #33: build the headline from the per-source counts (screens grouped by their OWN stamped
      // source file, plus the design system's), rather than the single file snapshot-meta happened to
      // pick — the exact bug that reported "exported 12h ago from 'Design System - NERA (Copy)'" on a
      // project with 5 TeamSmart screens and 1 NERA design system, attributing every screen to the
      // wrong file. Falls back to the old single-file line when nothing has per-source data yet (an
      // export entirely from before this field existed, or a bare design-system-only pull).
      const counts = exportSourceCounts(ex.dir, now);
      if (counts.parts.length) {
        const detail = counts.parts.join(" + ");
        const stale = counts.newestOverall !== null && now - counts.newestOverall > STALE_MS;
        out.push(stale
          ? warn("export", "Export", `${detail} — the Figma file may have moved on`, "re-run the pull before building from it")
          : ok("export", "Export", detail));
      } else {
        const age = ageStr(ageMs);
        const from = snap.sourceFile ? ` from '${snap.sourceFile}'` : "";
        out.push(ageMs > STALE_MS ? warn("export", "Export", `exported ${age} ago${from} — the Figma file may have moved on`, "re-run the pull before building from it") : ok("export", "Export", `exported ${age} ago${from}`));
      }
    }

    const map = LAYOUT.findMapFile(cwd);
    out.push(
      map.missing
        ? warn("map", "Component map", `no ${LAYOUT.MAP_FILE} — builds cannot reuse your existing components yet`, "scaffold one after a pull: /designtwin:build-screen walks you through it")
        : map.legacy
          ? warn("map", "Component map", "codeconnect.local.json is at the repo root (the older location)", `it still works. Moving it to ${LAYOUT.MAP_FILE} keeps every hand-owned file in one place`)
          : ok("map", "Component map", `${LAYOUT.MAP_FILE} present`)
    );
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
  // A shadowed token's real answer depends on the plugin check below (P4 livetest-4 #328) — emit it
  // once that is known, rather than a static "make sure" note before anything has actually been
  // checked. Every other case is unaffected and keeps its original position, right after Node.js.
  if (!tok.shadowed) add(checkToken(tok));

  const { port, problem } = resolvePort(process.env.FIGMA_BRIDGE_PORT);
  let pluginCheck;
  let viaDaemon = false;
  if (problem) {
    add(problem);
    pluginCheck = checkPlugin({ skipped: "the port setting has to be fixed first" });
    add(pluginCheck);
  } else {
    const st = await daemon.status(port).catch(() => null);
    add(checkDaemon(st, port));
    const probe = await probePort(port);
    add(checkPort(port, probe, st));

    if (st) {
      viaDaemon = true;
      // The daemon owns the bridge, so its view IS the answer — no second bridge needed (or possible).
      // Status is `ok` unless a connected client is running a stale plugin bundle (finding 327) — that
      // demotion is independent of, and composes with, the shadowed-token classification below (P4
      // #328), which reads `pluginCheck.status` to decide whether the token warning is real.
      pluginCheck = st.pluginConnected
        ? (() => {
            const c = connectedDetail(st.clients, "connected (through the daemon)");
            const stale = (st.clients || []).some((cl) => cl.pluginStale);
            return { id: "plugin", title: "Figma plugin", status: stale ? "warn" : "ok", detail: c.detail, ...(c.next ? { next: c.next } : {}) };
          })()
        : fail("plugin", "Figma plugin", "the daemon is running, but no plugin is connected to it", "in Figma DESKTOP open the file and run Plugins → Development → Design Twin; if its window says the token is wrong, re-paste `dtwin --show-token`");
      add(pluginCheck);
    } else if (!probe.free) {
      pluginCheck = checkPlugin({ skipped: `port ${port} is held by something else, and probing it would disturb it`, next: probe.holder === "websocket" ? "if that is the MCP server, ask Claude Code to call figma_status — it reports the plugin connection" : undefined });
      add(pluginCheck);
    } else if (tok.activeSource === "ephemeral") {
      pluginCheck = checkPlugin({ skipped: "there is no token yet, and doctor never creates one", next: "run `dtwin init`, paste the token into the plugin, then run doctor again" });
      add(pluginCheck);
    } else {
      if (onWait) onWait(waitSec);
      pluginCheck = checkPlugin(await probePlugin(port, waitSec * 1000), waitSec);
      add(pluginCheck);
    }
  }
  if (tok.shadowed) add(checkToken(tok, pluginCheck, viaDaemon));

  add(...checkProject(cwd));
  // P4 #203: a "not checked" warn (the plugin probe skipped, a port held by something else, etc.) is
  // not advice like an ordinary warn — it means a check that was supposed to answer "can this project
  // actually pull anything" never ran. `ok: true` beside one of those is worse than `ok: false`: it
  // tells an automated caller (or a human skimming --json) that everything was verified when in fact
  // it wasn't. Only a genuine "not checked" counts here — a warn about project state (stale export,
  // legacy layout, parallel layout, no map) is real advice and must not flip the roll-up.
  const notChecked = (c) => c.status === "warn" && /not checked/i.test(c.detail || "");
  return { ok: !checks.some((c) => c.status === "fail" || notChecked(c)), checks };
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
