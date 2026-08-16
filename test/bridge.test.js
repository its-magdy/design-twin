// Offline tests for the BRIDGE layer — the two files the plugin harness can't reach:
//   1. bridge/server-core.js  — verifyClient, the bridge's only real access control (token + Origin
//      + loopback Host). Previously reachable only through a live WebSocket handshake, so untested.
//   2. bridge/seed-components.js — a CLI, so it's driven as a subprocess in a temp dir.
// Run with:  node test/bridge.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { ok, report } = require("./assert");

// A fixed token so verifyClient's comparisons are deterministic. server-core reads this at require
// time, so it must be set BEFORE the module is loaded.
const TOKEN = "test-token-abc123";
process.env.FIGMA_BRIDGE_TOKEN = TOKEN;
const core = require("../bridge/server-core.js");

// ---------------------------------------------------------------- server-core: auth
// verifyClient(info, done) calls done(true) to accept, or done(false, code, msg) to reject.
function verify({ token, origin, host }) {
  const url = token === undefined ? "/" : "/?token=" + encodeURIComponent(token);
  const info = { origin, req: { url, headers: { host: host === undefined ? "127.0.0.1:8787" : host } } };
  let result;
  core.verifyClient(info, (accepted, code) => { result = { accepted, code }; });
  return result;
}

console.log("server-core — handshake auth:");
ok("[auth] correct token accepted", verify({ token: TOKEN, origin: "null" }).accepted === true);
ok("[auth] wrong token rejected 401", (() => { const r = verify({ token: "nope", origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] missing token rejected 401", (() => { const r = verify({ origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] empty token rejected", verify({ token: "", origin: "null" }).accepted === false);
// The CSWSH case the file's own comment calls out: a sandboxed attacker iframe also sends "null",
// so Origin must NOT be sufficient on its own — only the token decides.
ok("[auth] Origin:null WITHOUT token still rejected (CSWSH)", verify({ origin: "null" }).accepted === false);
ok("[auth] real website origin rejected 403", (() => { const r = verify({ token: TOKEN, origin: "https://evil.example" }); return r.accepted === false && r.code === 403; })());
ok("[auth] localhost origin allowed", verify({ token: TOKEN, origin: "http://localhost:3000" }).accepted === true);
// DNS-rebinding: Origin looks fine but Host points at an attacker-controlled name.
ok("[auth] non-loopback Host rejected 403 (DNS rebinding)", (() => { const r = verify({ token: TOKEN, origin: "null", host: "evil.example:8787" }); return r.accepted === false && r.code === 403; })());
ok("[auth] ::1 Host allowed", verify({ token: TOKEN, origin: "null", host: "[::1]:8787" }).accepted === true);
// A token that differs only in LENGTH must not throw (timingSafeEqual requires equal lengths).
ok("[auth] length-mismatched token rejected, no throw", verify({ token: "short", origin: "null" }).accepted === false);
ok("[auth] safeEqual is length-safe", core.safeEqual("abc", "abcdef") === false && core.safeEqual("abc", "abc") === true);

// ---------------------------------------------------------------- seed-components CLI
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seed-test-"));
const seed = path.join(__dirname, "..", "bridge", "seed-components.js");
function runSeed(name, files, existingMap) {
  const root = path.join(tmp, name);
  const design = path.join(root, "design");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(design, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, "src", f), body);
  if (existingMap) fs.writeFileSync(path.join(design, "components.json"), JSON.stringify(existingMap, null, 2));
  execFileSync(process.execPath, [seed, root, design], { stdio: "pipe" });
  const out = path.join(design, "components.json");
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
}
const tpl = (comp, id, src) => `// url=https://figma.com/design/x?node-id=${id}\n// component=${comp}\n// source=${src}\n`;

console.log("\nseed-components — node-id forms:");
const forms = runSeed("forms", {
  "a.figma.tsx": tpl("DashForm", "1-2", "a.tsx"),
  "b.figma.tsx": tpl("ColonEnc", "3%3A4", "b.tsx"),
  "c.figma.tsx": tpl("ColonRaw", "5:6", "c.tsx"),
  "d.figma.tsx": tpl("Nested", "I7-8;9-10", "d.tsx"),
});
ok("[id-dash] node-id=1-2 -> 1:2", forms.DashForm && forms.DashForm.nodeId === "1:2");
ok("[id-encoded] node-id=3%3A4 -> 3:4", forms.ColonEnc && forms.ColonEnc.nodeId === "3:4");
ok("[id-colon] node-id=5:6 -> 5:6", forms.ColonRaw && forms.ColonRaw.nodeId === "5:6");
ok("[id-nested] instance path I7-8;9-10 -> I7:8;9:10", forms.Nested && forms.Nested.nodeId === "I7:8;9:10");

console.log("\nseed-components — reserved-key hardening:");
// A component literally named "__proto__" used to resolve to Object.prototype: its entry vanished
// from components.json AND the backfills landed on the prototype, after which no OTHER entry could
// be filled either (their `=== undefined` checks became false). Both halves are asserted here.
const poisoned = runSeed(
  "poison",
  { "a.figma.tsx": tpl("__proto__", "1-2", "evil.tsx"), "z.figma.tsx": tpl("Widget", "5-5", "widget.tsx") },
  { Widget: { component: "Widget", import: "@/ui", props: {} } }
);
ok("[sec-seed-proto-kept] '__proto__' entry is a real own key, not dropped",
  Object.prototype.hasOwnProperty.call(poisoned, "__proto__") && poisoned["__proto__"].source === "evil.tsx");
ok("[sec-seed-no-starve] unrelated entry still backfilled after a '__proto__' entry",
  poisoned.Widget.source === "widget.tsx" && poisoned.Widget.nodeId === "5:5");
ok("[sec-seed-no-pollute] Object.prototype was not mutated",
  ({}).source === undefined && ({}).nodeId === undefined);
ok("[seed-preserves-human-fields] hand-authored import survives the merge", poisoned.Widget.import === "@/ui");

fs.rmSync(tmp, { recursive: true, force: true });

// ------------------------------------------------- server-core: post-connect request timeout
// Regression for a LIVE failure (2026-07-28, first real run against Figma): an --all-pages pull on a
// ~1000-node design system blew past server-core's 120s default and reported
// "timed out waiting for the Figma plugin (is the right file open?)". That diagnosis is provably
// wrong — request() only runs AFTER isConnected() passed and the command was sent, so the socket was
// up and the file WAS open. It sent debugging in the wrong direction. No offline test could catch it:
// the mock harness answers instantly, so a timeout never elapsed. This drives the REAL socket path
// with a client that deliberately never replies.
const WebSocket = require("../bridge/node_modules/ws");

// A bridge plus an OPEN, authenticated client on it. The `?token=` query and the "null" origin are
// exactly what verifyClient gates on, so that handshake shape lives in one place — three copies meant
// a change to the auth contract broke three tests in three spots. Ports start above 8787 so a bridge
// the user has running is never collided with.
let nextPort = 8797;
async function connectedBridge() {
  const port = nextPort++;
  const bridge = core.createBridge(port);
  const client = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
  await new Promise((res, rej) => { client.on("open", res); client.on("error", rej); });
  return { bridge, client };
}

// Drive one in-flight request to a socket close and hand back the rejection. The three disconnect
// cases differ only in close code/reason, so the setup — connect, start a request, let it register,
// close the peer, shut the bridge down (otherwise every case leaks a listening WS server for the rest
// of the run) — lives here once.
async function disconnectErr(code, reason) {
  const { bridge, client } = await connectedBridge();
  let err;
  const inflight = bridge.request("exportFull", {}, 20000).catch((e) => { err = e; });
  await new Promise((r) => setTimeout(r, 60)); // let the request register before the close lands
  client.close(code, reason);
  await inflight;
  bridge.close();
  return err;
}

(async () => {
  const { bridge, client } = await connectedBridge();

  let err;
  try { await bridge.request("exportFull", {}, 1100); } catch (e) { err = e; } // client never answers
  client.close();
  bridge.close();

  console.log("\nserver-core — post-connect request timeout:");
  ok("[to-connected] the client really was connected before the request", bridge.isConnected() === true || !!err);
  ok("[to-msg] a stalled request rejects", !!err);
  ok("[to-msg] does NOT blame the file/connection — the socket was up",
    !!err && !/right file open/i.test(err.message));
  ok("[to-msg] names the command that stalled", !!err && /exportFull/.test(err.message));
  ok("[to-msg] states the budget that elapsed", !!err && /within 1s/.test(err.message));
  ok("[to-msg] points at the real remedies (--timeout, plugin window)",
    !!err && /--timeout/.test(err.message) && /plugin window/i.test(err.message));

  // ------------------------------------------- server-core: disconnect diagnosis
  // Second LIVE failure (2026-07-28): the same --all-pages pull died at ~11min with a bare
  // "Figma plugin disconnected before replying." — no close code, no socket error, nothing to act on,
  // because ws.on("error") was `() => {}` and the close handler discarded `code`. A disconnect has
  // several distinct causes (1009 payload overflow vs a plugin-side crash) that need different fixes,
  // so the message must distinguish them.
  const dErr = await disconnectErr(1009, "max payload size exceeded"); // the payload-overflow disconnect

  console.log("\nserver-core — disconnect diagnosis:");
  ok("[dc] an in-flight request rejects on disconnect", !!dErr);
  ok("[dc] the close CODE is surfaced (was discarded)", !!dErr && /1009/.test(dErr.message));
  ok("[dc] the close reason is surfaced", !!dErr && /max payload size exceeded/i.test(dErr.message));
  ok("[dc] 1009 names the actual knob to turn", !!dErr && /FIGMA_BRIDGE_MAX_PAYLOAD_MB/.test(dErr.message));
  ok("[dc] and suggests pulling less at once", !!dErr && /--all-pages/.test(dErr.message));

  // A plain close with no error must NOT be misreported as a payload problem — it points at the
  // plugin console instead, which is where a crash/OOM actually shows up.
  const pErr = await disconnectErr(1001, ""); // peer went away, no socket error

  ok("[dc-plain] a non-1009 close does NOT blame the payload limit",
    !!pErr && !/FIGMA_BRIDGE_MAX_PAYLOAD_MB/.test(pErr.message));
  ok("[dc-plain] it points at the plugin console instead",
    !!pErr && /Open Console/i.test(pErr.message));
  ok("[dc-plain] and still reports the close code", !!pErr && /1001/.test(pErr.message));

  // ------------------------------------------ server-core: the ONE-connection rule, made observable
  // The bridge keeps a single plugin socket and terminates the previous one — the behaviour that
  // decides whether two open Figma files can use it at once. It had no direct coverage: the live
  // handshake helper above existed, but nothing ever opened a SECOND client against the same bridge,
  // so the takeover path (and the bookkeeping the --whoami probe reports) ran only in production.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port);
    const open = () => new Promise((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
      c.on("open", () => res(c));
      c.on("error", rej);
    });

    const first = await open();
    const infoOne = bridge.connectionInfo();
    // A request in flight on the FIRST connection when the second arrives: the caller must be told,
    // not left hanging until its timeout. This is the exact experience of running the plugin in a
    // second file mid-export.
    let stolenErr;
    const inflight = bridge.request("exportFull", {}, 20000).catch((e) => { stolenErr = e; });
    await new Promise((r) => setTimeout(r, 60));

    const second = await open();
    await new Promise((r) => setTimeout(r, 120)); // let the terminate + close handler land
    const infoTwo = bridge.connectionInfo();
    await inflight;

    console.log("\nserver-core — single-connection takeover (the two-files question):");
    ok("[takeover] the first connection is reported with an id", !!infoOne.connId && infoOne.connected === true);
    ok("[takeover] no takeover is recorded for a lone connection", infoOne.takeovers === 0);
    ok("[takeover] a second connection is counted", infoTwo.connectionsThisRun === 2);
    ok("[takeover] and IS recorded as a takeover", infoTwo.takeovers === 1);
    ok("[takeover] the surviving connection is the NEWER one", infoTwo.connId !== infoOne.connId);
    ok("[takeover] the bridge stays connected (the new socket serves)", infoTwo.connected === true);
    ok("[takeover] lastTakeoverAt is stamped", typeof infoTwo.lastTakeoverAt === "number" && infoTwo.lastTakeoverAt > 0);
    // The displaced caller must fail fast rather than wait out its 20s budget.
    ok("[takeover] an in-flight request on the displaced socket rejects promptly", !!stolenErr);

    try { first.terminate(); } catch (e) {}
    try { second.close(); } catch (e) {}
    bridge.close();

    // After everything closes, the probe must report disconnected rather than a stale live socket.
    const infoClosed = bridge.connectionInfo();
    ok("[takeover] connectionInfo reports disconnected once closed", infoClosed.connected === false);
    ok("[takeover] and zeroes the uptime instead of growing forever", infoClosed.connectionUptimeMs === 0);
  }

  // ---------------------------------------------------------------- figma-pull: argument parsing
  // Untested until now, and it was the fiddliest code in the CLI: value-taking flags, an `=` form,
  // a repeatable flag, and a positional [outDir] that must not swallow any of their values.
  // Requiring the module must NOT start a bridge — see the require.main guard in figma-pull.js.
  const pull = require("../bridge/figma-pull.js");
  const parse = (argv) => pull.parseArgs(argv);
  const usage = (argv) => { try { parse(argv); return null; } catch (e) { return e instanceof pull.UsageError ? e.message : "WRONG ERROR: " + e.message; } };

  console.log("\nfigma-pull — argument parsing:");
  // The regression: `--timeout` with no value fell into the validator's own `!== undefined` exemption,
  // so it was silently IGNORED and the default applied — invisible until the export died at a limit
  // the caller believed they had raised. A flag that cannot be honoured must fail, never default.
  ok("[args] --timeout with no value is an ERROR, not a silent default", /positive number/.test(usage(["--timeout"]) || ""));
  ok("[args] --timeout followed by another flag is an ERROR too", /positive number/.test(usage(["--timeout", "--no-assets"]) || ""));
  ok("[args] --timeout= (empty) is an ERROR", /positive number/.test(usage(["--timeout="]) || ""));
  ok("[args] --timeout 0 is rejected", /positive number/.test(usage(["--timeout", "0"]) || ""));
  ok("[args] --timeout abc is rejected", /positive number/.test(usage(["--timeout", "abc"]) || ""));
  ok("[args] --timeout 600 -> 600000ms", parse(["--timeout", "600"]).exportTimeoutMs === 600000);
  ok("[args] --timeout=600 -> 600000ms (= form)", parse(["--timeout=600"]).exportTimeoutMs === 600000);
  // A near-miss flag must not be read as this one: `startsWith("--timeout")` used to swallow it.
  ok("[args] an unrelated --timeout-ish flag is not consumed as --timeout",
    parse(["--timeout-ms", "5"]).exportTimeoutMs === 300000);
  ok("[args] default timeout scales with the work (selection < page < all-pages)", (() => {
    const s = parse(["--selection"]).exportTimeoutMs, p = parse([]).exportTimeoutMs, a = parse(["--all-pages"]).exportTimeoutMs;
    return s === 120000 && p === 300000 && a === 900000 && s < p && p < a;
  })());

  // outDir is positional, so every value-taking flag above must be excluded from the search — the
  // failure this guards is `--children 131:1879` writing an export into a directory named "131:1879".
  ok("[args] --children <id> value is not mistaken for outDir", (() => {
    const r = parse(["--children", "131:1879"]);
    return r.childrenId === "131:1879" && r.outDir === "design";
  })());
  ok("[args] --timeout value is not mistaken for outDir", parse(["--timeout", "600"]).outDir === "design");
  ok("[args] --page value is not mistaken for outDir", parse(["--page", "1:2"]).outDir === "design");
  ok("[args] a real positional outDir is still picked up", parse(["out", "--page", "1:2"]).outDir === "out");
  ok("[args] outDir works AFTER a value flag too", parse(["--page", "1:2", "out"]).outDir === "out");

  ok("[args] --page is repeatable", (() => { const p = parse(["--page", "1:2", "--page", "3:4"]).pageSel; return p.length === 2 && p[0] === "1:2" && p[1] === "3:4"; })());
  ok("[args] --page= form works and mixes with the space form", (() => { const p = parse(["--page=1:2", "--page", "3:4"]).pageSel; return p.length === 2 && p[0] === "1:2"; })());
  ok("[args] --page with no value is an ERROR", /needs an id or name/.test(usage(["--page"]) || ""));
  ok("[args] --page= empty is an ERROR", /needs an id or name/.test(usage(["--page="]) || ""));
  ok("[args] --children with no value is an ERROR", /needs a node id/.test(usage(["--children"]) || ""));
  // Parity: --page and --timeout both take `=`, so --children silently rejecting it was a papercut.
  ok("[args] --children= form is accepted", parse(["--children=131:1879"]).childrenId === "131:1879");
  // --children now goes through node-id.js, the same parser figma_list_children uses, so the CLI and
  // the MCP twin accept the SAME inputs. Previously the raw token went straight to the plugin, whose
  // only normalisation is replace(/-/g, ":") — so a pasted design URL worked via MCP and failed here.
  ok("[args] --children accepts the DASH form (normalised to colons)",
    parse(["--children", "131-1879"]).childrenId === "131:1879");
  ok("[args] --children accepts a full figma.com design URL",
    parse(["--children", "https://www.figma.com/design/abc123/NERA?node-id=131-1879&t=x"]).childrenId === "131:1879");
  ok("[args] --children accepts a percent-encoded id",
    parse(["--children=131%3A1879"]).childrenId === "131:1879");
  ok("[args] --children accepts a nested-instance path",
    parse(["--children", "I131-1879;12-34"]).childrenId === "I131:1879;12:34");
  // An id shape node-id.js doesn't recognise must keep working exactly as before rather than becoming
  // a new hard failure — the plugin is the authority on what resolves, not this parser.
  ok("[args] an unrecognised id shape is passed through untouched",
    parse(["--children", "weird_id"]).childrenId === "weird_id");
  ok("[args] --children= empty is an ERROR", /needs a node id/.test(usage(["--children="]) || ""));
  ok("[args] --no-assets sets skipAssets", parse(["--no-assets"]).readOpts.skipAssets === true);
  ok("[args] --list implies depth 2, --list-pages depth 1", (() => {
    const l = parse(["--list"]), lp = parse(["--list-pages"]);
    return l.listOnly && l.listDepth === 2 && lp.listOnly && lp.listDepth === 1;
  })());

  // Scope flags are mutually exclusive and the loser was DISCARDED IN SILENCE: collectFull is
  // `if (allPages) … else if (page)`, so `--all-pages --page Foo` exported all 25 pages while the
  // caller waited for one, and `--selection --page Foo` never forwarded the page at all. Both hand
  // back a plausible export of the WRONG scope — the failure nobody notices. Refuse instead.
  ok("[args] --all-pages + --page is an ERROR", /different scopes/.test(usage(["--all-pages", "--page", "1:2"]) || ""));
  ok("[args] --selection + --page is an ERROR", /different scopes/.test(usage(["--selection", "--page", "1:2"]) || ""));
  ok("[args] --selection + --all-pages is an ERROR", /different scopes/.test(usage(["--selection", "--all-pages"]) || ""));
  ok("[args] each scope flag ALONE is still fine", (() => {
    return parse(["--selection"]).selection && parse(["--all-pages"]).allPages && parse(["--page", "1:2"]).pageSel.length === 1;
  })());

  // --design-system: the "just the design system, no page walk" scope. Same exclusivity family as
  // --selection/--all-pages/--page, and — like the list commands — no read options apply, since it
  // never walks a node.
  ok("[args] --design-system alone parses and sets the flag", parse(["--design-system"]).designSystemOnly === true);
  ok("[args] --design-system + --all-pages is an ERROR", /different scopes/.test(usage(["--design-system", "--all-pages"]) || ""));
  ok("[args] --design-system + --selection is an ERROR", /different scopes/.test(usage(["--design-system", "--selection"]) || ""));
  ok("[args] --design-system + --page is an ERROR", /different scopes/.test(usage(["--design-system", "--page", "1:2"]) || ""));
  ok("[args] --design-system + a read option is an ERROR (no node walk to apply it to)",
    /node\/page walk/.test(usage(["--design-system", "--css"]) || ""));
  ok("[args] --design-system + --serve is an ERROR", /manages the background bridge/.test(usage(["--serve", "--design-system"]) || ""));
  // --list/--children print a structural index and exit(0) before any export runs, so an export flag
  // combined with one of them is a no-op the caller has no way to observe.
  ok("[args] --list + --page is an ERROR", /structural index/.test(usage(["--list", "--page", "1:2"]) || ""));
  ok("[args] --children + --all-pages is an ERROR", /structural index/.test(usage(["--children", "1:2", "--all-pages"]) || ""));
  ok("[args] --list + --children is an ERROR (two different queries)", /only one/.test(usage(["--list", "--children", "1:2"]) || ""));
  // Read options are ADDITIVE, not scopes — they must keep composing with any one scope flag.
  ok("[args] read options still compose with a scope flag", (() => {
    const r = parse(["--page", "1:2", "--no-assets", "--css", "--timeout", "60"]);
    return r.pageSel.length === 1 && r.readOpts.skipAssets && r.readOpts.css && r.exportTimeoutMs === 60000;
  })());
  // …but only with a SCOPE flag. The list ops emit structural fields only — they never serialize a
  // node, so every read option is inert there and used to be discarded without a word. Refused as a
  // group, --no-assets included: it is equally inert (nothing renders on that path), and exempting it
  // would leave the caller guessing which flags survive a list.
  ok("[args] --list + --css is an ERROR (read option would be ignored)", /silently ignored/.test(usage(["--list", "--css"]) || ""));
  ok("[args] the refusal names the offending flag", /--css/.test(usage(["--list", "--css"]) || ""));
  ok("[args] …and the command that cannot use it", /--list\b/.test(usage(["--list", "--css"]) || ""));
  ok("[args] --list-pages names ITSELF, not --list", /--list-pages/.test(usage(["--list-pages", "--motion"]) || ""));
  ok("[args] --children + a read option is an ERROR too", /--children/.test(usage(["--children", "1:2", "--measurements"]) || ""));
  ok("[args] --no-assets is refused on --list as well (no carve-out)", /--no-assets/.test(usage(["--list", "--no-assets"]) || ""));
  ok("[args] every read option is covered, none silently survives a list", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => usage(["--list", f]) !== null);
  })());
  ok("[args] multiple offenders are all named at once", (() => {
    const m = usage(["--list", "--css", "--motion"]) || "";
    return /--css/.test(m) && /--motion/.test(m);
  })());
  // --timeout is NOT a read option: it genuinely applies to the list ops' own budget, so it must
  // keep composing with them.
  ok("[args] --timeout still composes with --list", (() => {
    const r = parse(["--list", "--timeout", "600"]);
    return r.listOnly === true && r.listTimeoutMs === 600000;
  })());
  ok("[args] a bare --list is of course still fine", parse(["--list"]).listOnly === true);

  // ---------------------------------------------------------------- figma-pull: --list-libraries
  // The library-discovery member of the cheap-index family. It must join EVERY guard the other two
  // are in — a new index command that gets added to the parser but forgotten by one guard is the
  // silent-loss bug this whole section exists to prevent, just wearing a new flag.
  console.log("\nfigma-pull — --list-libraries:");
  ok("[lib] --list-libraries parses as its own command", (() => {
    const r = parse(["--list-libraries"]);
    return r.listLibraries === true && r.listOnly === false && r.childrenId === null;
  })());
  // The prefix trap: `--list` is matched by exact includes(), so --list-libraries must NOT also read
  // as --list (which would run listPages and print the wrong thing entirely).
  ok("[lib] --list-libraries is NOT swallowed by --list", parse(["--list-libraries"]).listOnly === false);
  ok("[lib] it takes the LIST timeout tier, and --timeout raises it", (() => {
    const d = parse(["--list-libraries"]), t = parse(["--list-libraries", "--timeout", "600"]);
    return d.listTimeoutMs === 300000 && t.listTimeoutMs === 600000;
  })());
  // Like --list/--children it prints and exits before any export runs, so a scope flag alongside it
  // is a no-op the caller cannot observe.
  ok("[lib] --list-libraries + --page is an ERROR", /structural index/.test(usage(["--list-libraries", "--page", "1:2"]) || ""));
  ok("[lib] --list-libraries + --all-pages is an ERROR", /structural index/.test(usage(["--list-libraries", "--all-pages"]) || ""));
  ok("[lib] --list-libraries + --selection is an ERROR", /structural index/.test(usage(["--list-libraries", "--selection"]) || ""));
  ok("[lib] the refusal names --list-libraries, not another index command",
    /--list-libraries/.test(usage(["--list-libraries", "--all-pages"]) || ""));
  // Two index commands: only one would ever run and print; the other would vanish silently.
  ok("[lib] --list-libraries + --list is an ERROR", /only one/.test(usage(["--list-libraries", "--list"]) || ""));
  ok("[lib] --list-libraries + --children is an ERROR", /only one/.test(usage(["--list-libraries", "--children", "1:2"]) || ""));
  // Read options are equally inert here — it reports library identity/usage, never a serialized node.
  ok("[lib] every read option is refused on --list-libraries, none silently survives", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => /silently ignored/.test(usage(["--list-libraries", f]) || ""));
  })());
  ok("[lib] and the refusal names both the flag and this command",
    (() => { const m = usage(["--list-libraries", "--css"]) || ""; return /--css/.test(m) && /--list-libraries/.test(m); })());
  // --timeout genuinely applies (it is the list budget), so it must keep composing.
  ok("[lib] --timeout still composes with --list-libraries", parse(["--list-libraries", "--timeout", "60"]).listTimeoutMs === 60000);
  ok("[lib] a daemon command alongside it is refused",
    /cannot be combined with --list-libraries/.test(usage(["--serve", "--list-libraries"]) || ""));

  // ------------------------------------------------------------------------ figma-pull: --whoami
  // The identity/liveness probe joins the index-command family, so it must inherit every guard that
  // family has — the point of routing it through indexCmds rather than giving it a private branch.
  console.log("\nfigma-pull — --whoami:");
  ok("[whoami] parses as its own command", parse(["--whoami"]).whoami === true);
  ok("[whoami] is off by default", parse(["design"]).whoami === false);
  ok("[whoami] writes no outDir (it prints, like the other index commands)",
    parse(["--whoami"]).listOnly === false && parse(["--whoami"]).whoami === true);
  ok("[whoami] + an export scope is an ERROR", /cannot be combined/.test(usage(["--whoami", "--all-pages"]) || ""));
  ok("[whoami] + --list is an ERROR (two index commands)", /only one/.test(usage(["--whoami", "--list"]) || ""));
  ok("[whoami] + --list-libraries is an ERROR", /only one/.test(usage(["--whoami", "--list-libraries"]) || ""));
  ok("[whoami] every read option is refused, none silently survives", (() => {
    const flags = ["--css", "--measurements", "--plugin-data", "--motion", "--shared-data", "--no-assets"];
    return flags.every((f) => /silently ignored/.test(usage(["--whoami", f]) || ""));
  })());
  // The refusal must describe what --whoami actually emits, not claim it prints a structural index.
  ok("[whoami] the refusal describes what it DOES emit",
    /connection\/plugin identity/.test(usage(["--whoami", "--css"]) || ""));
  ok("[whoami] a daemon command alongside it is refused",
    /cannot be combined with --whoami/.test(usage(["--serve", "--whoami"]) || ""));

  // Output rendering. The EMPTY case is the one that matters most: zero libraries is a NORMAL result
  // (free plan, or no library enabled in the Figma UI, or a plugin imported before the manifest
  // gained "teamlibrary") and must read as an explanation, not as a failure or an empty table.
  const emptyOut = pull.formatLibraries({ libraries: [], warnings: [] });
  ok("[lib] the empty case says so in words, not as a blank table", /No libraries reported/.test(emptyOut));
  ok("[lib] and states it is a normal outcome", /normal outcome/i.test(emptyOut));
  ok("[lib] and names the stale-plugin cause first (a reload is the usual fix)",
    /teamlibrary/.test(emptyOut) && /re-import/i.test(emptyOut) &&
    emptyOut.indexOf("teamlibrary") < emptyOut.search(/free plan/i));
  ok("[lib] and that libraries are enabled only in the Figma UI", /Figma UI/.test(emptyOut));
  ok("[lib] a missing libraries field is treated as empty, not a crash",
    /No libraries reported/.test(pull.formatLibraries({})));

  const libOut = pull.formatLibraries({
    libraries: [
      { key: "k1", name: "This file", kind: "local", componentCount: 3, variableCollections: [{ key: "c1", name: "Primitives", variableCount: 40 }] },
      { key: "k2", name: "NERA Design System", kind: "library", componentCount: 12,
        variableCollections: [{ key: "c2", name: "Semantic", variableCount: 120 }, { key: "c3", name: "Brand", variableCount: 8 }],
        note: "variable collections unavailable on this plan" },
    ],
    warnings: [],
  });
  ok("[lib] it prints a table, not raw JSON", !/^\s*[{[]/.test(libOut) && /LIBRARIES \(2\)/.test(libOut));
  ok("[lib] every library name appears", /This file/.test(libOut) && /NERA Design System/.test(libOut));
  ok("[lib] local vs library kind is shown", /\blocal\b/.test(libOut) && /\blibrary\b/.test(libOut));
  ok("[lib] variable counts are summed per library", /\b128\b/.test(libOut) && /\b40\b/.test(libOut));
  ok("[lib] each collection is listed with its own count", /Primitives \(40 variables\)/.test(libOut) && /Brand \(8 variables\)/.test(libOut));
  ok("[lib] a per-library note is surfaced rather than dropped", /note: variable collections unavailable/.test(libOut));
  // The counts are the part a reader will over-trust, so the caveat ships with every render.
  ok("[lib] component counts are labelled usage-derived", /USAGE-derived/.test(libOut));
  ok("[lib] and the no-enumeration limit is stated", /no API to enumerate/.test(libOut));
  // Alignment: the columns must line up, or it is JSON with extra steps.
  ok("[lib] the table columns are aligned across rows", (() => {
    // The header and both data rows must start their NAME column at the same offset — the one thing
    // that makes this a table rather than JSON with extra steps.
    const rows = libOut.split("\n").filter((l) => /^ {2}(KIND|local|library) /.test(l));
    const nameAt = rows.map((l) => ["This file", "NERA Design System", "NAME"].reduce((n, s) => (l.includes(s) ? l.indexOf(s) : n), -1));
    return rows.length === 3 && new Set(nameAt).size === 1 && nameAt[0] > 0;
  })());

  // The MCP twin. Checked against the BUILT bundle for the same reason writeToDisk is: the source
  // compiling is not evidence the tool shipped — and Zod silently strips anything undeclared.
  // Read here rather than reusing the `mcpSrc` below: this section runs first, and a const declared
  // further down is in its temporal dead zone.
  const libMcpSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "figma-mcp.mjs"), "utf8");
  ok("[lib] figma_list_libraries is registered in the built MCP bundle", /"figma_list_libraries"/.test(libMcpSrc));
  ok("[lib] it sends the listLibraries bridge command", /"listLibraries"/.test(libMcpSrc));
  (() => {
    const body = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_libraries"'), libMcpSrc.indexOf('"figma_list_children"'));
    ok("[lib] it is annotated read-only", /READ_ONLY/.test(body));
    // It is a DISCOVERY call: no arguments to get wrong, and the cheap budget tier, not an export's.
    ok("[lib] it declares no inputSchema — nothing to pass", !/inputSchema/.test(body));
    ok("[lib] it uses the shared cheap list timeout tier, not an export budget",
      /TIMEOUTS\.list/.test(body) && !/exportTimeout/.test(body));
    // Compactness is the contract for a discovery call — it must not hand back an unbounded payload.
    ok("[lib] the result is compacted to the documented fields", /variableCollections/.test(body) && /componentCount/.test(body));
    ok("[lib] warnings survive the compaction (they explain an empty list)", /warnings/.test(body));
    ok("[lib] the usage-derived caveat travels with the result", /USAGE-derived/.test(body));
    ok("[lib] the empty case is explained in-result, not left ambiguous", /NORMAL outcome/.test(body));
    ok("[lib] and the stale-plugin/teamlibrary cause is named", /teamlibrary/.test(body));
  })();

  // ---------------------------------------------------------------- figma-pull: writePages layout
  // safe() folds every non-alphanumeric to "_", so DISTINCT page names collide. Sharing one directory
  // meant the second page's index.json OVERWROTE the first's — the first page's layer files stayed on
  // disk but vanished from every index, invisible to an agent following the manifest.
  console.log("\nfigma-pull — writePages layout:");
  // The pages/ layout is read back a dozen times below; one reader so a layout change (e.g. the index
  // filename) is one edit, not twelve.
  const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(...p), "utf8"));
  const pagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-pages-"));
  pull.writePages(pagesDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }, { name: "C", id: "3:3" }],
    layers: [
      { name: "A", id: "1:1", page: "Design System", pageId: "0:1", tree: {} },
      { name: "B", id: "2:2", page: "Design/System", pageId: "0:2", tree: {} }, // folds to the SAME dir as above
      { name: "C", id: "3:3", page: "Screens", pageId: "0:3", tree: {} },
    ],
  });
  const rootIndex = readJson(pagesDir, "pages", "index.json");
  ok("[wp] every page gets its own directory, even when names fold alike",
    new Set(rootIndex.pageDirs.map((p) => p.dir)).size === 3);
  ok("[wp] each page's own name is preserved (only the DIRECTORY is disambiguated)",
    rootIndex.pageDirs.map((p) => p.page).join("|") === "Design System|Design/System|Screens");
  // The real regression: no layer may exist on disk yet be absent from its page index.
  ok("[wp] no layer is orphaned — every layer file is listed in its page's index", (() => {
    let listed = 0;
    for (const pd of rootIndex.pageDirs) {
      const idx = readJson(pagesDir, "pages", pd.dir, "index.json");
      if (idx.layers.length !== pd.layers) return false;
      for (const l of idx.layers) { if (!fs.existsSync(path.join(pagesDir, l.file))) return false; listed++; }
    }
    return listed === 3;
  })());
  ok("[wp] each page index reports the page it actually describes", (() => {
    const seen = rootIndex.pageDirs.map((pd) =>
      readJson(pagesDir, "pages", pd.dir, "index.json").page);
    return seen.join("|") === "Design System|Design/System|Screens";
  })());
  // Each pageDirs entry POINTS at its index file, exactly as each layer entry points at its own file.
  // Reassembling "pages/<dir>/index.json" from `dir` is right on this path and wrong on the plugin's
  // browser-download twin, where the HTML spec forces the same file to land flat as
  // "pages__<dir>__index.json" — so the pointer, not the convention, is the contract.
  ok("[wp] every page index is addressable by a pointer, not by convention",
    rootIndex.pageDirs.every((pd) => typeof pd.index === "string" && fs.existsSync(path.join(pagesDir, pd.index))));
  ok("[wp] and the pointer is relative to outDir, like each layer's `file`",
    rootIndex.pageDirs.every((pd) => !path.isAbsolute(pd.index) && pd.index.startsWith("pages/")));
  ok("[wp] the root index carries the run manifest, not the layer bodies",
    rootIndex.exportedAt === "t" && rootIndex.layers === undefined);
  ok("[wp] pages/ exists even for a zero-layer run", (() => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "figma-empty-"));
    pull.writePages(empty, { exportedAt: "t", index: [], layers: [] });
    return fs.existsSync(path.join(empty, "pages"));
  })());
  ok("[wp] each page dir carries the page ID, so two entries are tellable apart by more than a dir name",
    rootIndex.pageDirs.map((p) => p.pageId).join("|") === "0:1|0:2|0:3");
  fs.rmSync(pagesDir, { recursive: true, force: true });

  // The name-keyed bug's OTHER half: `uniqueDir()` only fixed page names that DIFFER but fold to the
  // same safe() string. Figma's Plugin API documents no uniqueness constraint on PageNode.name, and
  // two pages can be named identically — those were bucketed together (one dir, one index, one
  // pageDirs entry claiming both pages' layers), and uniqueDir never fired because only one bucket
  // was ever built. Identity is the page ID; the name is for display.
  const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-duppage-"));
  pull.writePages(dupDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }],
    layers: [
      { name: "A", id: "1:1", page: "Screens", pageId: "0:1", tree: {} },
      { name: "B", id: "2:2", page: "Screens", pageId: "0:9", tree: {} }, // SAME name, different page
    ],
  });
  const dupIndex = readJson(dupDir, "pages", "index.json");
  ok("[wp] two DISTINCT pages sharing a name stay two pages", dupIndex.pageDirs.length === 2);
  ok("[wp] and get separate directories", new Set(dupIndex.pageDirs.map((p) => p.dir)).size === 2);
  ok("[wp] each keeping the real (identical) page name, disambiguated only by id",
    dupIndex.pageDirs.every((p) => p.page === "Screens") &&
    dupIndex.pageDirs.map((p) => p.pageId).join("|") === "0:1|0:9");
  ok("[wp] and one layer each, not both in one bucket", (() => dupIndex.pageDirs.every((pd) => {
    const idx = readJson(dupDir, "pages", pd.dir, "index.json");
    return pd.layers === 1 && idx.layers.length === 1 && idx.pageId === pd.pageId;
  }))());
  fs.rmSync(dupDir, { recursive: true, force: true });

  // Exports written before pageId existed must still lay out — fall back to the name as the key.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-oldpage-"));
  pull.writePages(oldDir, {
    exportedAt: "t",
    index: [{ name: "A", id: "1:1" }, { name: "B", id: "2:2" }],
    layers: [{ name: "A", id: "1:1", page: "Screens", tree: {} }, { name: "B", id: "2:2", page: "Screens", tree: {} }],
  });
  const oldIndex = readJson(oldDir, "pages", "index.json");
  ok("[wp] a pre-pageId export still groups by name (one bucket) rather than splitting per layer",
    oldIndex.pageDirs.length === 1 && oldIndex.pageDirs[0].layers === 2);
  ok("[wp] and OMITS pageId rather than emitting a null — absence means 'export predates page ids'",
    !("pageId" in oldIndex.pageDirs[0]));
  fs.rmSync(oldDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- stdout is not truncated on exit
  // --list / --children print their WHOLE payload to stdout, and an agent reads this CLI through a
  // PIPE. Node's stdout is asynchronous for pipes, so the process.exit(0) these branches used to end
  // with discarded everything still buffered: measured 369,799 bytes written, 65,536 delivered — cut
  // at one pipe buffer, yielding truncated JSON that fails to parse with nothing to say why.
  // bridge.close() replaces it: it releases the WS server (the handle that was keeping the loop alive,
  // and the reason an exit call was there at all) and lets Node drain stdout on its own.
  // Driven as a subprocess because that is the only way to observe the real thing — the pipe, the
  // async write, and the exit are all process-level. Payload is deliberately far over the 64KB pipe
  // buffer, since anything under it passes either way and would not have caught the bug.
  const exitDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-exit-"));
  const exitScript = path.join(exitDir, "drain.js");
  fs.writeFileSync(exitScript, [
    'process.env.FIGMA_BRIDGE_TOKEN = "t";',
    `const { createBridge } = require(${JSON.stringify(path.resolve(__dirname, "../bridge/server-core.js"))});`,
    "const bridge = createBridge(0);", // port 0 -> ephemeral, so the suite never fights a real bridge on 8787
    'const big = JSON.stringify({ pages: Array.from({ length: 4000 }, (_, i) => ({ id: "1:" + i, name: "page " + i, w: 100, h: 200 })) }, null, 2);',
    'process.stderr.write("BYTES:" + big.length + "\\n");',
    "console.log(big);",
    "bridge.close();", // the fix under test: no process.exit()
  ].join("\n"));
  const drained = spawnSync(process.execPath, [exitScript], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const intended = Number((/BYTES:(\d+)/.exec(drained.stderr || "") || [])[1]);
  ok("[exit] the harness actually produced a payload larger than a pipe buffer", intended > 65536);
  ok("[exit] closing the bridge lets the process exit on its own (no hang, no process.exit)",
    drained.status === 0 && !drained.error);
  // The regression itself: every byte survives. Under the old process.exit(0) this landed at 65,536.
  ok("[exit] the WHOLE payload reaches a pipe — stdout is not truncated",
    drained.stdout.length === intended + 1); // +1 for console.log's newline
  ok("[exit] and the delivered payload is still parseable JSON",
    (() => { try { return JSON.parse(drained.stdout).pages.length === 4000; } catch { return false; } })());
  fs.rmSync(exitDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- staleness stamp: write-through + figma_status
  // design-system.json's `exportedAt`/`file` are stamped by the PLUGIN (collect.ts/components.ts), not
  // by figma-pull — this only proves the CLI's write path is faithful (never strips or re-derives the
  // stamp) and that snapshot-meta.js (the shared reader figma_status uses) reads it back correctly.
  console.log("\nfigma-pull / figma-mcp — snapshot freshness stamp:");
  const { readSnapshotInfo } = require("../bridge/snapshot-meta.js");
  const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-stamp-"));
  const stampedAt = new Date(Date.now() - 5 * 3600000).toISOString(); // 5h old
  pull.writeJson(stampDir, "design-system.json", { exportedAt: stampedAt, file: "My Design File", components: [] }, true);
  const stamped = JSON.parse(fs.readFileSync(path.join(stampDir, "design-system.json"), "utf8"));
  ok("[stamp] figma-pull writes design-system.json's exportedAt through unchanged", stamped.exportedAt === stampedAt);
  ok("[stamp] and the file name too", stamped.file === "My Design File");

  const info = readSnapshotInfo(stampDir);
  ok("[status] readSnapshotInfo finds the export and reports its exportedAt", info && info.exportedAt === stampedAt);
  ok("[status] and the source file name, under sourceFile (distinct from its OWN `file` = the json path)",
    info && info.sourceFile === "My Design File" && info.file === path.join(stampDir, "design-system.json"));
  ok("[status] and computes a plausible age (~5h, generously bounded)",
    info && info.ageMs > 4.9 * 3600000 && info.ageMs < 5.1 * 3600000);

  ok("[status] missing export dir -> null, not a throw (not-yet-exported is not an error)",
    readSnapshotInfo(path.join(stampDir, "does-not-exist")) === null);

  const noStampDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-nostamp-"));
  pull.writeJson(noStampDir, "design-system.json", { components: [] }, true); // no exportedAt at all
  const noStampInfo = readSnapshotInfo(noStampDir);
  ok("[status] a snapshot with no exportedAt reports a warning instead of pretending it's fresh",
    noStampInfo && noStampInfo.exportedAt === undefined && typeof noStampInfo.warning === "string");

  const badJsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "figma-badjson-"));
  fs.mkdirSync(badJsonDir, { recursive: true });
  fs.writeFileSync(path.join(badJsonDir, "design-system.json"), "{ not valid json");
  const badInfo = readSnapshotInfo(badJsonDir);
  ok("[status] unparseable design-system.json reports an error, not a crash", badInfo && typeof badInfo.error === "string");

  ok("[status] FIGMA_EXPORT_DIR env is honored when no outDir arg is given", (() => {
    const prev = process.env.FIGMA_EXPORT_DIR;
    process.env.FIGMA_EXPORT_DIR = stampDir;
    try {
      return readSnapshotInfo().exportedAt === stampedAt;
    } finally {
      if (prev === undefined) delete process.env.FIGMA_EXPORT_DIR; else process.env.FIGMA_EXPORT_DIR = prev;
    }
  })());

  fs.rmSync(stampDir, { recursive: true, force: true });
  fs.rmSync(noStampDir, { recursive: true, force: true });
  fs.rmSync(badJsonDir, { recursive: true, force: true });

  // figma-mcp.mts wires readSnapshotInfo into figma_status's result unconditionally (both the
  // connected and not-connected branches carry `snapshot`) — checked statically here rather than by
  // importing figma-mcp.mjs, whose top-level createBridge()/main() open a real WS server + stdio
  // transport and would hang the test process.
  const mcpSrc = fs.readFileSync(path.join(__dirname, "..", "bridge", "figma-mcp.mjs"), "utf8");
  ok("[status] figma-mcp.mjs (built) wires snapshot-meta's readSnapshotInfo into figma_status",
    /snapshot-meta\.js/.test(mcpSrc) && /readSnapshotInfo/.test(mcpSrc));
  ok("[status] figma_status reports `snapshot` on BOTH the connected and disconnected branches",
    (() => {
      const toolBody = mcpSrc.slice(mcpSrc.indexOf('"figma_status"'), mcpSrc.indexOf('"figma_get_selection"'));
      return (toolBody.match(/snapshot/g) || []).length >= 3; // definition + both branches
    })());

  // ---------------------------------------------------------------- write-out: the shared writer
  // write-out.js is the ONE writer both front-ends go through. These check the two things that make
  // the MCP path complete on its own: asset BYTES land on disk (stripAssets throws them away inline,
  // and the CLI cannot be run to fill the gap while the MCP holds port 8787), and what comes BACK is
  // a compact index — counts and paths, never node payloads.
  const OUT = require("../bridge/write-out.js");
  const wdir = fs.mkdtempSync(path.join(os.tmpdir(), "write-out-"));

  const full = OUT.writeAny(path.join(wdir, "design"), {
    designSystem: {
      file: "Demo",
      exportedAt: "2026-08-12T00:00:00.000Z",
      colorProfile: "srgb",
      collections: [{ id: "VariableCollectionId:1:1", name: "Core", modes: ["Light"] }],
      variables: [{ name: "color/bg", type: "COLOR" }],
      styles: { paint: [{ name: "Brand" }], text: [], effect: [], grid: [] },
      components: [
        { key: "k1", name: "Button", id: "2:1", page: "Home", pageId: "1:0" },
        { key: "k2", name: "Card", remote: true, derivedFrom: "instances" },
      ],
      hygiene: ["variant explosion: 'Button'"],
    },
    layersDoc: {
      index: [{ id: "1:2", name: "Hero", type: "FRAME", pageId: "1:0", page: "Home" }],
      layers: [{ id: "1:2", name: "Hero", type: "FRAME" }],
    },
    assets: [
      { id: "1:3", file: "icon.svg", text: "<svg/>" },
      { id: "1:4", file: "img.png", base64: Buffer.from("hi").toString("base64") },
    ],
  });
  ok("[write-out] the full export writes design-system.json",
    fs.existsSync(path.join(wdir, "design", "design-system.json")));
  ok("[write-out] asset BYTES land on disk — the thing the inline MCP path cannot do",
    fs.readFileSync(path.join(wdir, "design", "assets", "icon.svg"), "utf8") === "<svg/>" &&
    fs.readFileSync(path.join(wdir, "design", "assets", "img.png"), "utf8") === "hi");
  ok("[write-out] base64 assets are decoded, not written as base64 text",
    fs.readFileSync(path.join(wdir, "design", "assets", "img.png"), "utf8") !== Buffer.from("hi").toString("base64"));
  ok("[write-out] it reports the asset count it actually wrote", full.wrote.assets === 2);
  ok("[write-out] and a layer-file count", full.wrote.layerFiles === 1);
  // The whole point of the writeToDisk path: the RESULT is an index, not the export.
  // "no payload" means no serialized NODES — not the absence of the word "layers", which legitimately
  // appears in pageDirs as a per-page COUNT. Assert on the things only a real node tree carries.
  ok("[write-out] the returned index carries NO node payload",
    (() => {
      const s = JSON.stringify(full);
      return !s.includes("\"children\"") && !s.includes("FRAME") && !s.includes("\"Hero\"");
    })());
  ok("[write-out] the freshness stamp survives the write byte-for-byte",
    JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")).exportedAt ===
      "2026-08-12T00:00:00.000Z");

  // --- the design-system split (bridge/design-system-layout.js) -------------------------------
  // The catalog is no longer one flat object: Figma's own model has three separate systems
  // (VariableCollections+Variables / Paint|Text|Effect|GridStyle / Components), and library
  // components are not nodes in this file at all.
  // The eight parts land in design-system/ — design/tokens.json and design/components.json at the
  // export ROOT are the user's hand-authored, non-regenerable config maps and must not be clobbered.
  const readDS = (n) => JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system", n), "utf8"));
  ok("[ds-split] tokens.json carries the collections + variables, and nothing else's payload",
    (() => { const t = readDS("tokens.json");
      return t.collections.length === 1 && t.variables.length === 1 && !t.styles && !t.components; })());
  ok("[ds-split] styles are split one file per type — styles.paint.json/text/effect/grid",
    (() => { const p = readDS("styles.paint.json").styles, t = readDS("styles.text.json").styles,
        e = readDS("styles.effect.json").styles, g = readDS("styles.grid.json").styles;
      return p.length === 1 && Array.isArray(t) && t.length === 0 && Array.isArray(e) && Array.isArray(g); })());
  ok("[ds-split] components.local.json holds only real nodes in this file (id/page/pageId)",
    (() => { const c = readDS("components.local.json").components;
      return c.length === 1 && c[0].key === "k1" && !!c[0].id && !!c[0].pageId; })());
  ok("[ds-split] components.library.json holds only remote:true entries — inferred from instances, not nodes here",
    (() => { const c = readDS("components.library.json").components;
      return c.length === 1 && c[0].key === "k2" && c[0].remote === true && c[0].id === undefined; })());
  ok("[ds-split] hygiene.json is the lint report on its own", readDS("hygiene.json").hygiene.length === 1);
  ok("[ds-split] every split file repeats the freshness stamp, so drift-lint/figma_status work off any of them",
    ["tokens.json", "styles.paint.json", "styles.text.json", "styles.effect.json", "styles.grid.json",
     "components.local.json", "components.library.json", "hygiene.json"]
      .every((n) => readDS(n).exportedAt === "2026-08-12T00:00:00.000Z" && readDS(n).file === "Demo"));
  ok("[ds-split] design-system.json is now a slim manifest: stamp + pointers, no bulk data",
    (() => { const m = JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8"));
      return m.file === "Demo" && m.colorProfile === "srgb" && m.files.tokens === "design-system/tokens.json" &&
        m.files.componentsLibrary === "design-system/components.library.json" && !m.variables && !m.components && !m.styles; })());
  ok("[ds-split] the manifest counts local and library components, and each style bucket, separately",
    (() => { const c = JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")).counts;
      return c.variables === 1 && c.components === 1 && c.libraryComponents === 1 && c.hygiene === 1 &&
        c.stylesPaint === 1 && c.stylesText === 0 && c.stylesEffect === 0 && c.stylesGrid === 0; })());

  // --- the --design-system / figma_export_design_system result shape: { designSystem } only, no
  // layersDoc/assets. This is what OUT.writeExport receives on that path (figma-pull.js's
  // designSystemOnly branch and figma-mcp.mts's exportResult both call writeAny -> writeExport with
  // exactly this shape) — must degrade cleanly with no pages/ and no assets/ written.
  const dsOnlyDir = path.join(wdir, "ds-only");
  const dsOnlyResult = OUT.writeExport(dsOnlyDir, {
    designSystem: { exportedAt: "2026-08-16T00:00:00.000Z", file: "Demo", colorProfile: "srgb",
      collections: [], variables: [], styles: { paint: [], text: [], effect: [], grid: [] }, components: [], hygiene: [] },
  });
  ok("[ds-only] writeExport with no layersDoc/assets still writes the design-system split",
    fs.existsSync(path.join(dsOnlyDir, "design-system.json")) && fs.existsSync(path.join(dsOnlyDir, "design-system", "tokens.json")));
  ok("[ds-only] and writes NO pages/ or assets/ directory",
    !fs.existsSync(path.join(dsOnlyDir, "pages")) && !fs.existsSync(path.join(dsOnlyDir, "assets")));
  ok("[ds-only] wrote.layerFiles/pageDirs/assets all report zero, not a crash",
    dsOnlyResult.wrote.layerFiles === 0 && dsOnlyResult.wrote.pageDirs === 0 && dsOnlyResult.wrote.assets === 0);
  ok("[ds-split] and the write result reports the same counts back to the MCP caller",
    full.wrote.designSystemCounts && full.wrote.designSystemCounts.libraryComponents === 1);

  // A manifest-only asset (no bytes — e.g. one the plugin skipped) must not be counted as written.
  const skipped = OUT.writeAny(path.join(wdir, "skip"), {
    designSystem: { file: "D" },
    assets: [{ id: "9:9", file: "none.svg" }],
  });
  ok("[write-out] a bytes-less asset entry is reported as skipped, not written",
    skipped.wrote.assets === 0 && skipped.wrote.assetsSkipped === 1);

  // The selection/node shape takes the other writer — dispatched on the RESULT, so a tool never has
  // to know which writer its own command implies.
  const sel = OUT.writeAny(path.join(wdir, "sel"), {
    screenName: "Login/Screen", screen: { id: "2:1" }, variables: { a: 1 }, assets: [],
  });
  ok("[write-out] the selection shape writes a screen file named with safe()",
    fs.existsSync(path.join(wdir, "sel", "Login_Screen.json")));
  ok("[write-out] and variables.json alongside it", fs.existsSync(path.join(wdir, "sel", "variables.json")));
  ok("[write-out] writeAny dispatched on shape, not on the caller's command", !!sel.wrote.screen);

  // outDir resolves against the CWD — for the MCP server that is the project Claude Code started in,
  // so an export lands in the project being built, not next to the bridge's own source.
  ok("[write-out] a relative outDir resolves against process.cwd()",
    OUT.resolveOutDir("design") === path.resolve(process.cwd(), "design"));
  ok("[write-out] FIGMA_EXPORT_DIR is the fallback — the same var snapshot-meta.js reads",
    (() => {
      const prev = process.env.FIGMA_EXPORT_DIR;
      process.env.FIGMA_EXPORT_DIR = "custom-out";
      const got = OUT.resolveOutDir(undefined);
      if (prev === undefined) delete process.env.FIGMA_EXPORT_DIR; else process.env.FIGMA_EXPORT_DIR = prev;
      return got === path.resolve(process.cwd(), "custom-out");
    })());
  // outDir on the MCP side is a MODEL-supplied argument, and path.resolve honours "../.." and
  // absolute paths — so without this an export could be written anywhere the process can write.
  // Confined to the server's cwd, which is also exactly what the option's description promises.
  const escapes = (p) => { try { OUT.assertInsideCwd(p); return false; } catch (e) { return /must stay inside/.test(e.message); } };
  ok("[write-out] a relative outDir is accepted", !escapes("design") && !escapes("src/design"));
  ok("[write-out] '..' traversal out of the project is refused", escapes("../../../../tmp/pwned"));
  ok("[write-out] an absolute path outside the project is refused", escapes("/tmp/pwned"));
  ok("[write-out] the refusal names the offending path and the fix",
    (() => { try { OUT.assertInsideCwd("/tmp/pwned"); return false; } catch (e) { return /\/tmp\/pwned/.test(e.message) && /relative path/.test(e.message); } })());
  ok("[write-out] the cwd itself is allowed", !escapes("."));
  fs.rmSync(wdir, { recursive: true, force: true });

  // The built bundle must actually expose the flag — the source compiling is not evidence the tool
  // schema shipped it (Zod strips undeclared keys, so a forgotten declaration is a SILENT drop).
  ok("[write-out] all three export tools declare writeToDisk in the built bundle",
    (mcpSrc.match(/writeToDisk/g) || []).length >= 3);
  ok("[write-out] the built bundle routes writes through write-out.js",
    /write-out\.js/.test(mcpSrc) && /writeAny/.test(mcpSrc));

  // ---------------------------------------------------------------- daemon: hold the bridge open
  // The daemon exists because a one-shot run pays a plugin reconnect every time AND only one process
  // can hold port 8787. These drive it against a FAKE bridge — no Figma, no WebSocket — so the
  // queueing, framing and lifecycle are testable offline, which is where the interesting failures are.
  const daemon = require("../bridge/daemon.js");
  const D_PORT = 19787; // not 8787: a test must never contend with a real bridge the user is running

  const calls = [];
  const fakeBridge = {
    port: D_PORT,
    isConnected: () => true,
    close: () => calls.push("close"),
    waitForConnection: async () => {},
    request: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "boom") throw new Error("plugin exploded");
      return { echo: cmd, big: "x".repeat((args && args.n) || 0) };
    },
  };

  ok("[daemon] with none running, connect() is null — callers fall back to their own bridge",
    (await daemon.connect(D_PORT)) === null);
  ok("[daemon] and --stop reports there was nothing to stop", (await daemon.stop(D_PORT)) === false);

  // A socket FILE left by a crashed daemon is not a running daemon. If this read as "alive", every
  // later CLI run would fail until the user hand-deleted a file they don't know about.
  fs.writeFileSync(daemon.sockPath(D_PORT), "");
  ok("[daemon] a stale socket file reads as NO daemon, not as a hang",
    (await daemon.connect(D_PORT)) === null);

  await daemon.serve(fakeBridge, { port: D_PORT });
  ok("[daemon] --serve starts over a stale socket file", !!(await daemon.connect(D_PORT)));
  const dstat = await daemon.status(D_PORT);
  ok("[daemon] status reports the pid, port and whether the PLUGIN is connected",
    dstat.pid === process.pid && dstat.port === D_PORT && dstat.pluginConnected === true);

  // Starting a second daemon must REFUSE, not silently steal the socket out from under the first.
  let dblErr = null;
  try { await daemon.serve(fakeBridge, { port: D_PORT }); } catch (e) { dblErr = e; }
  ok("[daemon] a second --serve is refused rather than stealing the live socket",
    !!dblErr && /already running/.test(dblErr.message));
  ok("[daemon] and the refusal names the way out", !!dblErr && /--stop/.test(dblErr.message));

  const dcli = await daemon.connect(D_PORT);
  ok("[daemon] a request round-trips", (await dcli.request({ cmd: "listPages", timeoutMs: 5000 }, 5000)).echo === "listPages");
  let dReqErr = null;
  try { await dcli.request({ cmd: "boom", timeoutMs: 5000 }, 5000); } catch (e) { dReqErr = e; }
  ok("[daemon] a plugin-side failure propagates to the client as an error, not a silent empty result",
    !!dReqErr && /plugin exploded/.test(dReqErr.message));

  // Requests are SERIALIZED. The plugin is single-threaded and its heavy commands mutate shared
  // per-run state, so concurrent exports interleave badly — the daemon must behave like a sequence of
  // one-shot runs, which is what every existing caller was written against.
  const order = [];
  await Promise.all(["q1", "q2", "q3"].map((c) => dcli.request({ cmd: c, timeoutMs: 5000 }, 5000).then(() => order.push(c))));
  ok("[daemon] concurrent client requests run ONE at a time, in arrival order", order.join(",") === "q1,q2,q3");

  // Newline-delimited framing has to survive a payload that arrives in many chunks — a real export is
  // megabytes, and reassembling it wrongly would corrupt every large pull.
  const big = await dcli.request({ cmd: "exportFull", args: { n: 4e6 }, timeoutMs: 30000 }, 30000);
  ok("[daemon] a multi-megabyte reply is reassembled intact across chunks", big.big.length === 4e6);

  // Idle shutdown config is reported in MS, not rounded minutes: a sub-minute window rounded to "0"
  // reads as "disabled", which is the opposite of true. (The reap itself is time-based and covered by
  // a manual run rather than a 40s sleep in the suite; what's asserted here is the wiring.)
  ok("[daemon] status reports the idle window in ms, and how long it has been idle",
    typeof dstat.idleForMs === "number" && (dstat.idleMs === null || dstat.idleMs > 0));
  ok("[daemon] a client probe counts as activity — idleForMs stays small while in use",
    dstat.idleForMs < 60000);

  ok("[daemon] --stop stops it", (await daemon.stop(D_PORT)) === true);
  ok("[daemon] and removes the socket file, so the next --serve is not blocked",
    !fs.existsSync(daemon.sockPath(D_PORT)));
  ok("[daemon] stopping closes the underlying bridge", calls.includes("close"));

  // parseArgs owns the daemon flags — a daemon command takes the whole invocation, so combining it
  // with a pull must be refused rather than silently starting a daemon and dropping the export.
  const parseThrows = (args) => { try { pull.parseArgs(args); return null; } catch (e) { return e.message; } };
  ok("[daemon] --serve is refused alongside an export scope",
    /cannot be combined with --all-pages/.test(parseThrows(["--serve", "--all-pages"]) || ""));
  ok("[daemon] --stop is refused alongside a read option",
    /cannot be combined with --css/.test(parseThrows(["--stop", "--css"]) || ""));
  ok("[daemon] two daemon commands at once are refused",
    /different commands/.test(parseThrows(["--serve", "--stop"]) || ""));
  ok("[daemon] a daemon command alone parses", pull.parseArgs(["--serve"]).daemonCmd === "--serve");
  ok("[daemon] and an ordinary pull still parses with no daemon command",
    pull.parseArgs(["design", "--all-pages"]).daemonCmd === null);

  // ---------------------------------------------------------------- report
  report();
})();
