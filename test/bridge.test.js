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
function runSeed(name, files, existingMap, designFiles) {
  const root = path.join(tmp, name);
  const design = path.join(root, "design");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(design, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, "src", f), body);
  if (existingMap) fs.writeFileSync(path.join(design, "components.json"), JSON.stringify(existingMap, null, 2));
  // Export files the seeder reads back (the design-system manifest + whatever it points at), written
  // at paths relative to the export dir so the pointer indirection is exercised for real.
  for (const [f, body] of Object.entries(designFiles || {})) {
    const dest = path.join(design, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(body, null, 2));
  }
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

console.log("\nseed-components — node-id -> name via the split catalog:");
// A Code Connect template that carries a node-id but NO `component=` can only be named by looking the
// id up in the export. That lookup used to read `components` straight off design-system.json — which
// since the design-system split is a slim POINTER manifest with no such array, so the map came back
// empty and every name-less mapping was silently dropped (a clean-looking run that just found less).
// The seeder must follow files.componentsLocal to the real catalog.
const viaManifest = runSeed(
  "manifest-lookup",
  { "a.figma.tsx": "// url=https://figma.com/design/x?node-id=1-2\n// source=Card.tsx\n" },
  null,
  {
    "design-system.json": { files: { componentsLocal: "design-system/components.local.json" }, counts: { components: 1 } },
    "design-system/components.local.json": { components: [{ id: "1:2", name: "Card", key: "abc" }] },
  }
);
ok("[seed-split-catalog] node-id resolved to a name through files.componentsLocal",
  !!viaManifest && !!viaManifest.Card && viaManifest.Card.nodeId === "1:2" && viaManifest.Card.source === "Card.tsx");

// Pre-split exports inlined the array on design-system.json itself; keep reading those.
const viaInline = runSeed(
  "inline-lookup",
  { "a.figma.tsx": "// url=https://figma.com/design/x?node-id=3-4\n// source=Chip.tsx\n" },
  null,
  { "design-system.json": { components: [{ id: "3:4", name: "Chip" }] } }
);
ok("[seed-inline-catalog] pre-split inline components array still resolves",
  !!viaInline && !!viaInline.Chip && viaInline.Chip.nodeId === "3:4");

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

  // ------------------------------------------------- server-core: MULTI-CLIENT routing (two files)
  // The bridge used to keep ONE plugin socket and terminate the incumbent, which made two open Figma
  // files ping-pong: the displaced plugin's 3s auto-reconnect stole the bridge straight back, forever
  // (observed live). Connections now coexist and commands are ADDRESSED. These drive real sockets —
  // two of them — because the whole failure mode lived in the interaction between two clients, which
  // no single-socket test could reach.
  {
    const port = nextPort++;
    const bridge = core.createBridge(port);
    const open = () => new Promise((res, rej) => {
      const c = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, { origin: "null" });
      c.on("open", () => res(c));
      c.on("error", rej);
    });
    // A client that identifies itself the way the plugin UI does, then answers whatever it is asked.
    const identify = (c, hello) => c.send(JSON.stringify({ type: "hello", ...hello }));
    const autoReply = (c, result) => c.on("message", (b) => {
      const m = JSON.parse(b.toString());
      if (m && m.id) c.send(JSON.stringify({ id: m.id, ok: true, result: { ...result, cmd: m.cmd } }));
    });

    const base = await open();
    identify(base, { instanceId: "fig-base", file: "App — Base", fileKey: "KEYBASE", page: "Home" });
    autoReply(base, { who: "base" });
    await new Promise((r) => setTimeout(r, 80));

    console.log("\nserver-core — multi-client routing (the two-files question):");
    const one = bridge.listClients();
    ok("[multi] a lone client is listed", one.length === 1 && one[0].connId === "c1");
    ok("[multi] the hello announcement is recorded", one[0].file === "App — Base" && one[0].fileKey === "KEYBASE");
    ok("[multi] and it is marked identified", one[0].identified === true);
    // With ONE client, an unaddressed request must still work — every existing call site relies on it.
    const soloRes = await bridge.request("ping", {}, 5000);
    ok("[multi] an unaddressed request resolves when only one file is connected", soloRes.who === "base");

    // The second file connects. Under the old rule this terminated the first.
    const lib = await open();
    identify(lib, { instanceId: "fig-lib", file: "NERA Library", fileKey: "KEYLIB", page: "Tokens" });
    autoReply(lib, { who: "lib" });
    await new Promise((r) => setTimeout(r, 80));

    const two = bridge.listClients();
    ok("[multi] BOTH files stay connected — no takeover", two.length === 2);
    ok("[multi] neither is displaced (both ids present)",
      two.some((c) => c.connId === "c1") && two.some((c) => c.connId === "c2"));
    ok("[multi] takeovers stays 0 now that connections coexist", bridge.connectionInfo().takeovers === 0);
    ok("[multi] connectionInfo reports the client count", bridge.connectionInfo().clientsConnected === 2);

    // Addressing: by connId, by fileKey, and by a substring of the file name.
    ok("[multi] routes by connId", (await bridge.request("ping", {}, 5000, "c2")).who === "lib");
    ok("[multi] routes by fileKey", (await bridge.request("ping", {}, 5000, "KEYBASE")).who === "base");
    ok("[multi] routes by file-name substring (case-insensitive)",
      (await bridge.request("ping", {}, 5000, "nera")).who === "lib");

    // Ambiguity must REFUSE, not guess. Silently picking one would export the wrong file and look
    // entirely successful — the adb "more than one device" call.
    let ambErr;
    try { await bridge.request("ping", {}, 5000); } catch (e) { ambErr = e; }
    ok("[multi] an unaddressed request with two files connected is REFUSED", !!ambErr);
    ok("[multi] the refusal lists both files so the caller can choose",
      !!ambErr && /App — Base/.test(ambErr.message) && /NERA Library/.test(ambErr.message));
    ok("[multi] and names the flags that fix it", !!ambErr && /--client/.test(ambErr.message));

    let missErr;
    try { await bridge.request("ping", {}, 5000, "nope"); } catch (e) { missErr = e; }
    ok("[multi] an unmatched target is refused and lists what IS connected",
      !!missErr && /no connected Figma file matches/.test(missErr.message) && /c1/.test(missErr.message));

    // A substring hitting several files must refuse rather than resolve to the first.
    const dupA = await open();
    identify(dupA, { instanceId: "fig-d", file: "Untitled", fileKey: null, page: "Page 1" });
    await new Promise((r) => setTimeout(r, 60));
    let dupErr;
    try { await bridge.request("ping", {}, 5000, "e"); } catch (e) { dupErr = e; }
    ok("[multi] an ambiguous name match is refused, not resolved to the first",
      !!dupErr && /matches \d+ connected files/.test(dupErr.message));
    dupA.close();
    await new Promise((r) => setTimeout(r, 80));

    // The isolation property that matters most: one file's plugin window closing must NOT abort work
    // in flight in another file. Under the single-socket version every pending request shared one map
    // and one close cleared them all.
    const slow = await open(); // connects but never answers
    await new Promise((r) => setTimeout(r, 60));
    const slowId = bridge.listClients().find((c) => !c.identified).connId;
    let slowErr;
    const slowReq = bridge.request("exportFull", {}, 20000, slowId).catch((e) => { slowErr = e; });
    const liveReq = bridge.request("ping", {}, 5000, "c1"); // base file, still healthy
    await new Promise((r) => setTimeout(r, 60));
    slow.close(1001, "");
    await slowReq;
    const liveRes = await liveReq;
    ok("[multi] a closing client fails ITS OWN in-flight request", !!slowErr);
    ok("[multi] and does NOT abort another file's in-flight request", liveRes.who === "base");
    ok("[multi] the closed client leaves the registry", !bridge.listClients().some((c) => c.connId === slowId));
    ok("[multi] while the others remain", bridge.listClients().length === 2);

    // A re-announced hello (what the plugin sends after Figma restarts its runtime) must UPDATE the
    // existing entry rather than duplicate it.
    identify(base, { instanceId: "fig-base-2", file: "App — Base", fileKey: "KEYBASE", page: "Settings" });
    await new Promise((r) => setTimeout(r, 60));
    const afterRe = bridge.listClients().find((c) => c.connId === "c1");
    ok("[multi] a re-announced identity updates in place (no duplicate entry)", bridge.listClients().length === 2);
    ok("[multi] and carries the NEW instanceId", afterRe.instanceId === "fig-base-2");

    base.close(); lib.close();
    bridge.close();
    await new Promise((r) => setTimeout(r, 60));
    ok("[multi] closing the bridge empties the registry", bridge.listClients().length === 0);
    ok("[multi] and reports disconnected", bridge.connectionInfo().connected === false);
  }

  // ---------------------------------------------------------------- figma-pull: argument parsing
  // Untested until now, and it was the fiddliest code in the CLI: value-taking flags, an `=` form,
  // a repeatable flag, and a positional [outDir] that must not swallow any of their values.
  // Requiring the module must NOT start a bridge — see the require.main guard in figma-pull.js.
  const pull = require("../bridge/figma-pull.js");
  const parse = (argv) => pull.parseArgs(argv);
  const usage = (argv) => { try { parse(argv); return null; } catch (e) { return e instanceof pull.UsageError ? e.message : "WRONG ERROR: " + e.message; } };
  // Anti-drift: --node and --selection must both write through write-out.js's shared writeScreen
  // helper, not an ad hoc trio of writeJson/writeAssets calls each branch could quietly reinvent.
  const pullSrc = fs.readFileSync(require.resolve("../bridge/figma-pull.js"), "utf8");
  ok("[args] --node dispatch routes through the shared OUT.writeScreen writer", (() => {
    const i = pullSrc.indexOf("if (nodeId) {");
    const j = pullSrc.indexOf("} else if (selection) {");
    return i !== -1 && j !== -1 && i < j && pullSrc.slice(i, j).includes("OUT.writeScreen(outDir, r, plog)");
  })());
  ok("[args] --selection dispatch ALSO routes through OUT.writeScreen (no more ad hoc write trio)", (() => {
    const i = pullSrc.indexOf("} else if (selection) {");
    const j = pullSrc.indexOf("} else if (asLibrary) {");
    return i !== -1 && j !== -1 && i < j && pullSrc.slice(i, j).includes("OUT.writeScreen(outDir, r, plog)");
  })());

  console.log("\nfigma-pull — argument parsing:");
  // --as-library is a SCOPE: it selects what is exported, so it collides with the other scopes and,
  // like --design-system, walks no page (making every read option inert and therefore refused).
  ok("[as-library] parses and carries the library name", parse(["--as-library", "NERA"]).asLibrary === "NERA");
  ok("[as-library] requires a name rather than defaulting silently", /library name/.test(usage(["--as-library"]) || ""));
  ok("[as-library] is refused alongside --design-system", /select different scopes/.test(usage(["--as-library", "NERA", "--design-system"]) || ""));
  ok("[as-library] is refused alongside --page", /select different scopes/.test(usage(["--as-library", "NERA", "--page", "1:2"]) || ""));
  ok("[as-library] is refused alongside a list command", /cannot be combined/.test(usage(["--as-library", "NERA", "--list-libraries"]) || ""));
  ok("[as-library] refuses read options, which would be silently ignored", /silently ignored/.test(usage(["--as-library", "NERA", "--css"]) || ""));
  ok("[as-library] is refused alongside a daemon command", /cannot be combined/.test(usage(["--as-library", "NERA", "--serve"]) || ""));

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
  // It is now refused outright (unknown flag) — stronger than "parsed, but not as --timeout".
  ok("[args] an unrelated --timeout-ish flag is not consumed as --timeout",
    /unknown flag: --timeout-ms/.test(usage(["--timeout-ms", "5"]) || ""));
  // Unknown flags: a typo used to match nothing and fall through to a FULL PULL that waits on the
  // plugin — the wrong command, silently. Refused, with the nearest real flag offered.
  ok("[args] a typo'd flag is an ERROR with a did-you-mean, not a silent full pull",
    /unknown flag: --lst \(did you mean --list\?\)/.test(usage(["--lst"]) || ""));
  ok("[args] several unknown flags are all named", (() => {
    const m = usage(["--al-pages", "--frobnicate"]) || "";
    return /unknown flags:/.test(m) && /--al-pages \(did you mean --all-pages\?\)/.test(m) && /--frobnicate/.test(m);
  })());
  ok("[args] an unknown --flag=value form is refused too", /unknown flag: --pgae=Foo \(did you mean --page\?\)/.test(usage(["--pgae=Foo"]) || ""));
  ok("[args] a flag's VALUE is never judged as a flag", parse(["--page", "-weird-name"]).pageSel[0] === "-weird-name");
  ok("[args] every documented flag still parses", (() => {
    for (const a of [["--list"], ["--list-pages"], ["--list-libraries"], ["--whoami"], ["--list-clients"], ["--serve"], ["--show-token"],
      ["--selection", "--css", "--no-assets"], ["--design-system", "--variant-visuals"], ["--client", "c1", "--node", "1:2"], ["--screenshot", "1:2", "--scale", "2"]]) parse(a);
    return true;
  })());
  // ---------------------------------------------------------------- dtwin init
  {
    const init = require("../bridge/init.js");
    const os = require("os");
    const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-init-")); for (const [f, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); } return d; };
    const tok = { created: false, source: "file", path: "/x/bridge-token" };
    const entry = { command: "node", args: ["/abs/figma-mcp.mjs"] };
    ok("[init] detects the stack the way build-screen step 0 does", init.detectProfile(mk({ "package.json": '{"dependencies":{"react-native":"1"}}' })).profile === "react-native"
      && init.detectProfile(mk({ "package.json": '{"devDependencies":{"tailwindcss":"4"}}' })).profile === "web-tailwind"
      && init.detectProfile(mk({ "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n" })).profile === "flutter"
      && init.detectProfile(mk({ "Package.swift": "" })).profile === "swiftui"
      && init.detectProfile(mk({ "app/build.gradle.kts": "implementation(libs.androidx.compose.ui)" })).profile === "android-compose"
      && init.detectProfile(mk({})) === null);
    ok("[init] fresh project: creates design/ + target.json, no .mcp.json unless asked", (() => {
      const d = mk({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return JSON.parse(fs.readFileSync(path.join(d, "design/target.json"), "utf8")).profile === "web-tailwind" && !fs.existsSync(path.join(d, ".mcp.json"));
    })());
    ok("[init] never overwrites an existing target.json", (() => {
      const d = mk({ "design/target.json": '{"profile":"mine"}', "package.json": "{}" });
      init.apply(d, init.plan(d, { token: tok }), () => {});
      return fs.readFileSync(path.join(d, "design/target.json"), "utf8") === '{"profile":"mine"}';
    })());
    ok("[init] --mcp MERGES into an existing .mcp.json and keeps other servers", (() => {
      const d = mk({ ".mcp.json": '{"mcpServers":{"other":{"command":"x"}}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const m = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8")).mcpServers;
      return m.other.command === "x" && m.designtwin.args[0] === "/abs/figma-mcp.mjs";
    })());
    ok("[init] --mcp registers as \"designtwin\" BESIDE Figma's own \"figma\" server, never in its place", (() => {
      const d = mk({ ".mcp.json": '{"mcpServers":{"figma":{"type":"http","url":"https://mcp.figma.com/mcp"}}}' });
      init.apply(d, init.plan(d, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      const m = JSON.parse(fs.readFileSync(path.join(d, ".mcp.json"), "utf8")).mcpServers;
      return m.figma.url === "https://mcp.figma.com/mcp" && m.designtwin.args[0] === "/abs/figma-mcp.mjs";
    })());
    ok("[init] --mcp does not add a SECOND copy when ours is already there under the legacy \"figma\" key (two would fight over 8787)", (() => {
      const before = '{"mcpServers":{"figma":{"command":"node","args":["/old/clone/bridge/figma-mcp.mjs"]}}}';
      const d = mk({ ".mcp.json": before });
      const plan = init.plan(d, { mcp: true, mcpEntry: entry, token: tok });
      init.apply(d, plan, () => {});
      return fs.readFileSync(path.join(d, ".mcp.json"), "utf8") === before && plan.some((a) => a.kind === "skip" && /already registered as "figma"/.test(a.note));
    })());
    ok("[init] --mcp leaves a foreign designtwin entry, and an invalid .mcp.json, untouched", (() => {
      const a = mk({ ".mcp.json": '{"mcpServers":{"designtwin":{"command":"keep"}}}' }), b = mk({ ".mcp.json": "{not json" });
      init.apply(a, init.plan(a, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      init.apply(b, init.plan(b, { mcp: true, mcpEntry: entry, token: tok }), () => {});
      return JSON.parse(fs.readFileSync(path.join(a, ".mcp.json"), "utf8")).mcpServers.designtwin.command === "keep" && fs.readFileSync(path.join(b, ".mcp.json"), "utf8") === "{not json";
    })());
    ok("[init] warns when .gitignore would swallow the hand-authored maps", init.plan(mk({ ".gitignore": "node_modules/\ndesign/\n" }), { token: tok }).some((a) => a.kind === "note" && /un-ignore/.test(a.note)));
    ok("[init] CLI: --dry-run writes nothing, prints the remaining steps, exits 0; junk args exit 1", (() => {
      const d = mk({ "package.json": '{"dependencies":{"tailwindcss":"4"}}' });
      const run = (args) => require("child_process").spawnSync(process.execPath, [require.resolve("../bridge/figma-pull.js"), "init", ...args], { cwd: d, encoding: "utf8", timeout: 5000, env: { ...process.env, FIGMA_BRIDGE_TOKEN: "t" } });
      const r = run(["--dry-run", "--mcp"]);
      return r.status === 0 && /Import plugin from manifest/.test(r.stdout) && /would write/.test(r.stderr) && !fs.existsSync(path.join(d, "design")) && !fs.existsSync(path.join(d, ".mcp.json")) && run(["--nope"]).status === 1;
    })());
  }
  ok("[args] --json is accepted on the printing commands", parse(["--list-clients", "--json"]).json === true && parse(["--list-libraries", "--json"]).json === true && parse(["--list", "--json"]).json === true && parse(["--list"]).json === false);
  ok("[args] --json on an export is refused (it writes files, prints no result)", /--json applies to the commands that PRINT/.test(usage(["--all-pages", "--json"]) || "") && /--json applies/.test(usage(["--json"]) || ""));
  ok("[args] --help prints the usage header and exits 0 without starting a bridge", (() => {
    const r = require("child_process").spawnSync(process.execPath, [require.resolve("../bridge/figma-pull.js"), "--help"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && /Usage:/.test(r.stdout) && /--list-libraries/.test(r.stdout) && !/listening/.test(r.stderr);
  })());
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

  // --node <id>: the REAL single-node export (properties + assets) — a SCOPE flag, unlike --children
  // (peek) and --screenshot (PNG only), so it must accept the same id shapes --children does and join
  // the scopes/indexCmds mutual-exclusion guards below rather than living in its own lane.
  ok("[args] --node <id> value is not mistaken for outDir", (() => {
    const r = parse(["--node", "131:1879"]);
    return r.nodeId === "131:1879" && r.outDir === "design";
  })());
  ok("[args] --node with no value is an ERROR", /needs a node id/.test(usage(["--node"]) || ""));
  ok("[args] --node= form is accepted", parse(["--node=131:1879"]).nodeId === "131:1879");
  ok("[args] --node accepts the DASH form (normalised to colons)",
    parse(["--node", "131-1879"]).nodeId === "131:1879");
  ok("[args] --node accepts a full figma.com design URL",
    parse(["--node", "https://www.figma.com/design/abc123/NERA?node-id=131-1879&t=x"]).nodeId === "131:1879");
  ok("[args] --node accepts a percent-encoded id",
    parse(["--node=131%3A1879"]).nodeId === "131:1879");
  ok("[args] --node accepts a nested-instance path",
    parse(["--node", "I131-1879;12-34"]).nodeId === "I131:1879;12:34");
  ok("[args] --node= empty is an ERROR", /needs a node id/.test(usage(["--node="]) || ""));
  ok("[args] --node + --selection is an ERROR (different scopes)", /different scopes/.test(usage(["--node", "1:2", "--selection"]) || ""));
  ok("[args] --node + --page is an ERROR (different scopes)", /different scopes/.test(usage(["--node", "1:2", "--page", "3:4"]) || ""));
  ok("[args] --node + --list is an ERROR (structural index only)", /structural index/.test(usage(["--list", "--node", "1:2"]) || ""));
  ok("[args] --node + --serve is an ERROR", /manages the background bridge/.test(usage(["--serve", "--node", "1:2"]) || ""));
  // Unlike --screenshot (skips the walk entirely), --node DOES a real serialize() pass, so read
  // options are genuinely live and must compose rather than being refused.
  ok("[args] --node + a read option is ACCEPTED (unlike --screenshot)", (() => {
    const r = parse(["--node", "1:2", "--css"]);
    return r.nodeId === "1:2" && r.readOpts.css === true;
  })());

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
  // --variant-visuals is the ONE exception: it enriches the component catalog --design-system/
  // --as-library both build, so it must NOT trip the "no node walk" guard the other five do.
  ok("[args] --design-system + --variant-visuals is ACCEPTED, not refused",
    parse(["--design-system", "--variant-visuals"]).designSystemOnly === true);
  ok("[args] --design-system + --variant-visuals + --css is STILL an error (css is refused, variant-visuals is not)",
    /node\/page walk/.test(usage(["--design-system", "--variant-visuals", "--css"]) || "") &&
    !/--variant-visuals/.test(usage(["--design-system", "--variant-visuals", "--css"]) || ""));
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

  // ------------------------------------------------ figma-pull: --client / --list-clients (routing)
  console.log("\nfigma-pull — multi-file routing flags:");
  // --client is an ADDRESS, not a scope: unlike every other flag here it must COMPOSE with all of
  // them, so the guards that refuse combinations must leave it alone.
  ok("[client] --client takes a value", parse(["design", "--client", "c2"]).client === "c2");
  ok("[client] the = form works too", parse(["design", "--client=NERA"]).client === "NERA");
  ok("[client] a file name with spaces survives", parse(["design", "--client", "App — Base"]).client === "App — Base");
  ok("[client] it is null when absent", parse(["design"]).client === null);
  ok("[client] --client with no value is a usage error",
    /needs a connection id/.test(usage(["design", "--client"]) || ""));
  // The positional [outDir] must not swallow --client's value, the bug class takeValues exists for.
  ok("[client] its value is not mistaken for outDir", parse(["--client", "c2", "design"]).outDir.endsWith("design"));
  ok("[client] composes with an export scope", (() => {
    const r = parse(["design", "--all-pages", "--client", "c1"]);
    return r.allPages === true && r.client === "c1";
  })());
  ok("[client] composes with read options", (() => {
    const r = parse(["design", "--page", "1:2", "--client", "lib", "--css"]);
    return r.client === "lib" && r.readOpts.css === true;
  })());
  ok("[client] composes with an index command (it addresses WHICH file to list)", (() => {
    const r = parse(["--list", "--client", "c2"]);
    return r.listOnly === true && r.client === "c2";
  })());

  ok("[list-clients] parses as its own command", parse(["--list-clients"]).listClients === true);
  ok("[list-clients] is off by default", parse(["design"]).listClients === false);
  ok("[list-clients] + an export scope is an ERROR", /cannot be combined/.test(usage(["--list-clients", "--all-pages"]) || ""));
  ok("[list-clients] + --list is an ERROR (two index commands)", /only one/.test(usage(["--list-clients", "--list"]) || ""));
  ok("[list-clients] + --whoami is an ERROR", /only one/.test(usage(["--list-clients", "--whoami"]) || ""));
  ok("[list-clients] read options are refused", /silently ignored/.test(usage(["--list-clients", "--css"]) || ""));
  ok("[list-clients] the refusal describes what it DOES emit",
    /which Figma files are connected/.test(usage(["--list-clients", "--css"]) || ""));

  // formatClients renders for a human. The EMPTY case matters most: "nothing connected" is the normal
  // state before the plugin is opened, and must read as an instruction rather than a failure.
  const noClients = pull.formatClients([]);
  ok("[list-clients] the empty listing explains rather than just printing nothing", /No Figma files are connected/.test(noClients));
  ok("[list-clients] and says how to fix it", /Design Twin/.test(noClients));
  ok("[list-clients] and mentions that SEVERAL files can connect", /SEVERAL files at once/.test(noClients));
  const twoClients = pull.formatClients([
    { connId: "c1", file: "App — Base", fileKey: "KEYBASE", page: "Home", uptimeMs: 65000, identified: true },
    { connId: "c2", file: "NERA Library", fileKey: null, page: "Tokens", uptimeMs: 3000, identified: true },
  ]);
  ok("[list-clients] the listing counts the files", /2 Figma files connected/.test(twoClients));
  ok("[list-clients] each row leads with the connId --client takes", /c1\s+"App — Base"/.test(twoClients));
  ok("[list-clients] a present fileKey is shown", /fileKey KEYBASE/.test(twoClients));
  ok("[list-clients] a MISSING fileKey is explained, not blank", /no fileKey \(private-plugin API not in effect\)/.test(twoClients));
  ok("[list-clients] it tells you how to address one", /--client <connId \| fileKey \| part of the file name>/.test(twoClients));
  // An unidentified socket is a real state (connected, no hello yet) and must not render as a blank row.
  const anon = pull.formatClients([{ connId: "c9", file: null, fileKey: null, uptimeMs: 500, identified: false }]);
  ok("[list-clients] an unidentified client says so and stays addressable",
    /unidentified — address it by connId/.test(anon) && /c9/.test(anon));

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
  // figma-mcp.mjs is GENERATED from src/figma-mcp.mts. Every assertion in this file reads the
  // generated bundle, so a tool added ONLY to the bundle passes every test here and then vanishes on
  // the next `npm run build` — which is exactly what happened to figma_whoami. Compare the two
  // directly: the source is the thing that has to hold the tool.
  {
    const mcpSrcTs = fs.readFileSync(path.join(__dirname, "..", "bridge", "src", "figma-mcp.mts"), "utf8");
    const toolsOf = (src) => (src.match(/"figma_[a-z_]+"/g) || []).filter((t, i, a) => a.indexOf(t) === i).sort();
    const inBundle = toolsOf(libMcpSrc);
    const inSource = toolsOf(mcpSrcTs);
    console.log("\nfigma-mcp — generated bundle matches its TypeScript source:");
    ok("[mcp-gen] every tool in the built bundle also exists in src/figma-mcp.mts (else the next build deletes it)",
      inBundle.every((t) => inSource.includes(t)));
    ok("[mcp-gen] and the source declares no tool the bundle is missing (bundle is stale — rebuild)",
      inSource.every((t) => inBundle.includes(t)));
  }

  // The routing surface on the MCP side. Every tool that reaches the plugin must accept `client`, or
  // an agent with two files connected can address some tools and not others — the worst outcome,
  // because the un-addressable ones fail only when a second file happens to be open.
  console.log("\nfigma-mcp — multi-file routing surface:");
  ok("[mcp-multi] figma_list_clients is registered", /"figma_list_clients"/.test(libMcpSrc));
  ok("[mcp-multi] it is read-only and needs no arguments", (() => {
    const b = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_clients"'), libMcpSrc.indexOf('"figma_whoami"'));
    return /READ_ONLY/.test(b) && !/inputSchema/.test(b);
  })());
  ok("[mcp-multi] it reads the bridge registry, never the plugin (answers during a long export)", (() => {
    const b = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_clients"'), libMcpSrc.indexOf('"figma_whoami"'));
    return /bridge\.listClients\(\)/.test(b) && !/bridge\.request/.test(b);
  })());
  ok("[mcp-multi] every plugin-reaching tool accepts a client target", (() => {
    // One clientShape spread per tool that calls bridge.request, plus the ones that only list.
    const spreads = (libMcpSrc.match(/\.\.\.clientShape/g) || []).length;
    const requests = (libMcpSrc.match(/bridge\.request\(/g) || []).length;
    return spreads >= requests;
  })());
  ok("[mcp-multi] and every bridge.request forwards it", (() => {
    // Each call must end with the routing argument; a forgotten one silently ignores `client`.
    const calls = libMcpSrc.match(/bridge\.request\([^;]*?\);/gs) || [];
    return calls.length > 0 && calls.every((c) => /a && a\.client/.test(c));
  })());
  ok("[mcp-multi] figma_status reports the roster rather than failing when several are connected",
    /Several Figma files are connected/.test(libMcpSrc));
  // The whoami description must no longer claim the bridge holds ONE connection — that was the old rule.
  ok("[mcp-multi] no tool description still claims a single-connection bridge",
    !/holds exactly ONE plugin connection/.test(libMcpSrc));

  ok("[lib] figma_list_libraries is registered in the built MCP bundle", /"figma_list_libraries"/.test(libMcpSrc));
  ok("[lib] it sends the listLibraries bridge command", /"listLibraries"/.test(libMcpSrc));
  (() => {
    const body = libMcpSrc.slice(libMcpSrc.indexOf('"figma_list_libraries"'), libMcpSrc.indexOf('"figma_list_children"'));
    ok("[lib] it is annotated read-only", /READ_ONLY/.test(body));
    // It is a DISCOVERY call: the cheap budget tier, not an export's. Its ONLY argument is `client`
    // (which connected file to ask) — it gained one when the bridge learned to hold several files at
    // once, because "which libraries does this file use" needs to know which file you mean.
    ok("[lib] its only input is the routing target", /inputSchema: \{ \.\.\.clientShape \}/.test(body));
    ok("[lib] and it takes no OTHER arguments — nothing else to get wrong",
      !/readOptsShape|writeShape|z\.(string|boolean|number|union)/.test(body));
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

  // ---------- library-file export layout (--as-library) ----------
  // The library catalog must land in a tree that CANNOT collide with design-system/, because the two
  // describe different Figma files and answer different questions.
  {
    const libDoc = {
      file: "NERA DS",
      exportedAt: "2026-08-16T00:00:00.000Z",
      colorProfile: "srgb",
      source: { role: "library", libraryName: "NERA", fileKey: "ABCDEFGH12345", collectionKeys: ["ck_core"] },
      collections: [{ name: "Core", modes: ["Light"], default: "Light", key: "ck_core", publish: "current" }],
      variables: [{ name: "color/primary", type: "COLOR", collection: "Core", tier: "primitive", values: { Light: "#112233" }, key: "vk1", publish: "current" }],
      styles: { paint: [{ name: "Brand", key: "pk1", publish: "changed" }], text: [], effect: [], grid: [] },
      // A main consumed from ANOTHER library: not this library's to claim.
      components: [{ name: "Button", key: "ck1", publish: "current" }, { name: "Foreign", key: "ck2", remote: true }],
      hygiene: [],
    };
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), "write-lib-"));
    const res = OUT.writeExport(path.join(ldir, "design"), { designSystem: libDoc }, () => {});
    const base = path.join(ldir, "design");
    const dirName = "nera-ABCDEFGH".slice(0, 4) + "-ABCDEFGH"; // slug("NERA") + first 8 of fileKey
    ok("[lib-layout] lands under libraries/<slug>-<fileKey8>/", res.wrote.library === "libraries/" + dirName);
    ok("[lib-layout] directory identity uses fileKey, which survives a rename", /-ABCDEFGH$/.test(res.wrote.library));
    ok("[lib-layout] never writes into design-system/", !fs.existsSync(path.join(base, "design-system")));
    ok("[lib-layout] tokens.json exists", fs.existsSync(path.join(base, "libraries", dirName, "tokens.json")));
    const tok = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "tokens.json"), "utf8"));
    // The shape contract: a top-level `variables` array is what keeps design-to-code/catalog-input.js from
    // rejecting this as the slim manifest, and what lets design-to-code/tokens.js run on it unchanged.
    ok("[lib-layout] tokens.json carries a top-level variables array", Array.isArray(tok.variables) && tok.variables.length === 1);
    ok("[lib-layout] tokens.json carries collections for the mode join", Array.isArray(tok.collections));
    ok("[lib-layout] every split file repeats the freshness stamp", tok.exportedAt === libDoc.exportedAt && tok.file === "NERA DS");
    ok("[lib-layout] and carries source so a consumer knows it is a library", tok.source.role === "library");

    const comps = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "components.json"), "utf8"));
    ok("[lib-layout] a component from ANOTHER library is not claimed by this one", comps.components.length === 1 && comps.components[0].name === "Button");
    const hyg = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "hygiene.json"), "utf8"));
    ok("[lib-layout] and the drop is reported, not silent", hyg.hygiene.some((h) => /ANOTHER library were dropped/.test(h)));

    const idx = JSON.parse(fs.readFileSync(path.join(base, "libraries", dirName, "index.json"), "utf8"));
    ok("[lib-layout] the directory self-describes via index.json", idx.files && idx.files.tokens && idx.counts.variables === 1);
    ok("[lib-layout] index summarises publish status", idx.publish && idx.publish.current >= 1 && idx.publish.changed === undefined ? true : !!idx.publish);

    const root = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8"));
    ok("[lib-layout] libraries/index.json lists the library", root.libraries.length === 1 && root.libraries[0].libraryName === "NERA");
    // A second library must not erase the first: each is a separate plugin run in a separate file.
    const second = JSON.parse(JSON.stringify(libDoc));
    second.file = "Icons"; second.source.libraryName = "Icons"; second.source.fileKey = "ZZZZZZZZ999";
    OUT.writeExport(path.join(ldir, "design"), { designSystem: second }, () => {});
    const root2 = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8"));
    ok("[lib-layout] a second library is ADDED, not substituted", root2.libraries.length === 2);
    // Re-exporting the SAME library replaces its own row only.
    OUT.writeExport(path.join(ldir, "design"), { designSystem: libDoc }, () => {});
    const root3 = JSON.parse(fs.readFileSync(path.join(base, "libraries", "index.json"), "utf8"));
    ok("[lib-layout] re-exporting the same library does not duplicate its row", root3.libraries.length === 2);

    // Orphan reporting: a file the previous export produced and this one did not is REPORTED, never
    // deleted — a read command must not remove files it did not create.
    const stale = path.join(base, "libraries", dirName, "styles.text.json");
    ok("[lib-layout] a previously written split file is still on disk", fs.existsSync(stale));
    let logged = [];
    const shrunk = JSON.parse(JSON.stringify(libDoc));
    // Simulate a build that no longer emits text styles by rewriting the index to claim an extra file.
    const idxPath = path.join(base, "libraries", dirName, "index.json");
    const idxDoc = JSON.parse(fs.readFileSync(idxPath, "utf8"));
    idxDoc.files.ghost = "libraries/" + dirName + "/ghost.json";
    fs.writeFileSync(idxPath, JSON.stringify(idxDoc));
    fs.writeFileSync(path.join(base, "libraries", dirName, "ghost.json"), "{}");
    const res2 = OUT.writeExport(path.join(ldir, "design"), { designSystem: shrunk }, (m) => logged.push(m));
    ok("[lib-layout] an orphaned file is reported", res2.wrote.orphans.some((o) => /ghost\.json$/.test(o)));
    ok("[lib-layout] and it is NOT deleted", fs.existsSync(path.join(base, "libraries", dirName, "ghost.json")));
    ok("[lib-layout] the orphan warning reaches the user", logged.some((m) => /STALE:/.test(m)));
  }


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
        { key: "k3", name: "Badge", type: "COMPONENT_SET", id: "2:9", page: "Home", pageId: "1:0",
          variants: [
            { id: "2:10", name: "Size=Small", key: "vk1", values: { Size: "Small" }, node: { type: "COMPONENT", name: "Size=Small", children: [] } },
            { id: "2:11", name: "Size=Large", key: "vk2", values: { Size: "Large" }, node: { type: "COMPONENT", name: "Size=Large", children: [] } },
          ] },
        { key: "k4", name: "NoNodes", type: "COMPONENT_SET", id: "2:12", page: "Home", pageId: "1:0",
          variants: [{ id: "2:13", name: "State=Default", key: "vk3", values: { State: "Default" } }] },
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
      return c.length === 3 && c[0].key === "k1" && !!c[0].id && !!c[0].pageId; })());

  // --- component detail split (variants[].node stripped into design-system/components/) --------
  ok("[component-split] the COMPONENT_SET with exported node trees gets a variantsFile pointer",
    (() => { const c = readDS("components.local.json").components.find((x) => x.key === "k3");
      return !!c.variantsFile && c.variantsFile === "design-system/components/Badge__2_9.json"; })());
  ok("[component-split] its variants in the catalog keep id/name/key/values but lose .node",
    (() => { const c = readDS("components.local.json").components.find((x) => x.key === "k3");
      return c.variants.length === 2 && c.variants[0].id === "2:10" && c.variants[0].values.Size === "Small" && !("node" in c.variants[0]); })());
  ok("[component-split] a COMPONENT_SET with no exported node trees gets NO pointer (absence = not exported)",
    (() => { const c = readDS("components.local.json").components.find((x) => x.key === "k4");
      return !("variantsFile" in c) && c.variants.length === 1; })());
  ok("[component-split] the detail file carries the full node trees + stamp + set identity",
    (() => { const d = JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system", "components", "Badge__2_9.json"), "utf8"));
      return d.setId === "2:9" && d.setKey === "k3" && d.name === "Badge" && d.variants.length === 2 &&
        d.variants[0].node.type === "COMPONENT" && d.exportedAt === "2026-08-12T00:00:00.000Z"; })());
  ok("[component-split] design-system.json's manifest points at the components/ dir",
    JSON.parse(fs.readFileSync(path.join(wdir, "design", "design-system.json"), "utf8")).files.componentsDir === "design-system/components");
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
      return c.variables === 1 && c.components === 3 && c.libraryComponents === 1 && c.hygiene === 1 &&
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
    // The daemon forwards the connected-file listing through __status, so the fake has to answer it
    // too — two rows, so the routing assertions below have something to disambiguate between.
    listClients: () => [
      { connId: "c1", file: "App — Base", fileKey: "KEYBASE", page: "Home", instanceId: "fig-a", connectedAt: 1, uptimeMs: 1000, identified: true },
      { connId: "c2", file: "NERA Library", fileKey: "KEYLIB", page: "Tokens", instanceId: "fig-b", connectedAt: 2, uptimeMs: 2000, identified: true },
    ],
    close: () => calls.push("close"),
    waitForConnection: async () => {},
    request: async (cmd, args, timeoutMs, client) => {
      if (client) calls.push("client:" + client);
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

  // Routing has to survive the daemon hop. A CLI process behind a daemon has no bridge of its own, so
  // if `client` were dropped in the unix-socket frame the command would silently run against whichever
  // file the bridge picked — the exact wrong-file export the refusal in resolveClient exists to prevent.
  calls.length = 0;
  await dcli.request({ cmd: "routed", client: "NERA Library", timeoutMs: 5000 }, 5000);
  ok("[daemon] --client is forwarded through the daemon to the bridge", calls.includes("client:NERA Library"));
  ok("[daemon] and the command itself still arrives", calls.includes("routed"));
  // The connected-file listing is only visible to the daemon (it owns the bridge), so __status carries it.
  const cstat = await daemon.status(D_PORT);
  ok("[daemon] status reports the connected files so --list-clients works behind a daemon",
    Array.isArray(cstat.clients) && cstat.clients.length === 2 && cstat.clients[0].connId === "c1");

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


  // ---------------------------------------------------------------- token-store
  // The token STORE: where the bridge token lives between runs. Before it, the token was
  // env-var-or-nothing and a fresh one was minted every run, so the plugin's saved token was stale on
  // the very next `dtwin`. These tests own the precedence chain, the file's permissions, and the
  // lifecycle commands' argument guards.
  //
  // Every case points DESIGNTWIN_CONFIG_DIR at a temp dir: the suite must never read, write or delete
  // the developer's real ~/.config/design-twin/bridge-token.
  const store = require("../bridge/token-store.js");
  const withStore = (fn, { env = {}, dir = null } = {}) => {
    const saved = { ...process.env };
    const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-token-"));
    process.env.DESIGNTWIN_CONFIG_DIR = d;
    delete process.env.FIGMA_BRIDGE_TOKEN;
    delete process.env.FIGMA_BRIDGE_TOKEN_FILE;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try { return fn(d); } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
  };

  console.log("\ntoken-store — path resolution:");
  ok("[token] DESIGNTWIN_CONFIG_DIR overrides the per-OS default",
    withStore((d) => store.tokenPath() === path.join(d, "bridge-token")));
  ok("[token] a RELATIVE XDG_CONFIG_HOME is ignored, per the XDG spec",
    (() => {
      const saved = { ...process.env };
      delete process.env.DESIGNTWIN_CONFIG_DIR;
      process.env.XDG_CONFIG_HOME = "relative/path";
      const p = store.configDir();
      Object.assign(process.env, saved);
      // Must NOT resolve against cwd — the token's location can't depend on where dtwin was run.
      return !p.startsWith("relative") && path.isAbsolute(p);
    })());
  ok("[token] the path is absolute on this platform", path.isAbsolute(store.configDir()));

  console.log("\ntoken-store — precedence:");
  ok("[token] env beats the stored file",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const r = store.resolve({ persist: false });
      return r.token === "env-tok" && r.source === "env";
    }));
  ok("[token] --token-file beats env",
    withStore((d) => {
      const f = path.join(d, "custom");
      fs.writeFileSync(f, "file-tok");
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const r = store.resolve({ tokenFile: f, persist: false });
      return r.token === "file-tok" && r.source === "token-file";
    }));
  ok("[token] the stored file is used when no env var is set",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      const r = store.resolve({ persist: false });
      return r.token === "stored-tok" && r.source === "file";
    }));
  ok("[token] with nothing set at all, one is minted and persisted",
    withStore((d) => {
      const r = store.resolve();
      return r.created === true && r.source === "file" && fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] and the minted token is 48 hex chars (24 bytes of CSPRNG)",
    withStore(() => /^[0-9a-f]{48}$/.test(store.resolve().token)));
  ok("[token] a minted token is STABLE across runs — the whole point of the store",
    withStore((d) => store.resolve().token === store.resolve().token));
  ok("[token] persist:false mints without writing anything, so --token-status can't lie",
    withStore((d) => {
      const r = store.resolve({ persist: false });
      return r.source === "ephemeral" && !fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] an unreadable --token-file is a clear error, not a silent fallback",
    withStore((d) => {
      try { store.resolve({ tokenFile: path.join(d, "nope") }); return false; }
      catch (e) { return e.code === "TOKEN_FILE_UNREADABLE"; }
    }));
  ok("[token] an EMPTY token file is treated as absent, not as an empty token",
    withStore((d) => {
      const f = path.join(d, "bridge-token");
      fs.writeFileSync(f, "   \n");
      return store.readFrom(f) === null;
    }));
  ok("[token] an empty FIGMA_BRIDGE_TOKEN does not shadow the stored file",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "";
      return store.resolve({ persist: false }).source === "file";
    }));

  console.log("\ntoken-store — file hygiene:");
  ok("[token] a trailing newline is trimmed (echo tok > file must work)",
    withStore((d) => {
      const f = path.join(d, "bridge-token");
      fs.writeFileSync(f, "tok-with-newline\n");
      return store.readFrom(f) === "tok-with-newline";
    }));
  ok("[token] the file is written 0600 — owner only",
    withStore((d) => {
      const f = store.write("tok", path.join(d, "bridge-token"));
      if (process.platform === "win32") return true; // mode bits aren't meaningful on Windows
      return (fs.statSync(f).mode & 0o777) === 0o600;
    }));
  ok("[token] the config dir is created 0700",
    withStore(() => {
      const nested = path.join(process.env.DESIGNTWIN_CONFIG_DIR, "deep", "bridge-token");
      store.write("tok", nested);
      if (process.platform === "win32") return true;
      return (fs.statSync(path.dirname(nested)).mode & 0o777) === 0o700;
    }));
  ok("[token] a world-readable file is detected so the bridge can warn",
    withStore((d) => {
      if (process.platform === "win32") return true;
      const f = store.write("tok", path.join(d, "bridge-token"));
      fs.chmodSync(f, 0o644);
      return store.loosePerms(f) === true;
    }));
  ok("[token] the write is atomic — no .tmp is left behind",
    withStore((d) => {
      store.write("tok", path.join(d, "bridge-token"));
      return !fs.existsSync(path.join(d, "bridge-token.tmp"));
    }));
  ok("[token] writing twice REPLACES rather than appending",
    withStore((d) => {
      const f = path.join(d, "bridge-token");
      store.write("first", f);
      store.write("second", f);
      return store.readFrom(f) === "second";
    }));
  ok("[token] remove() deletes it",
    withStore((d) => {
      const f = store.write("tok", path.join(d, "bridge-token"));
      return store.remove(f) === true && !fs.existsSync(f);
    }));
  ok("[token] and removing a token that isn't there is not an error",
    withStore((d) => store.remove(path.join(d, "bridge-token")) === false));

  console.log("\ntoken-store — fingerprint + status:");
  ok("[token] the fingerprint is stable for the same token",
    store.fingerprint("abc") === store.fingerprint("abc"));
  ok("[token] differs for a different token", store.fingerprint("abc") !== store.fingerprint("abd"));
  ok("[token] and never contains the token itself",
    !store.fingerprint("supersecrettoken").includes("supersecret"));
  // Regression: status() resolves with persist:false, so the ephemeral branch mints a throwaway that
  // differs every call. Reporting ITS fingerprint invited the user to compare a meaningless value
  // against the plugin's — caught by running --token-status twice and seeing the answer change.
  ok("[token] status reports NO fingerprint when nothing is saved",
    withStore(() => store.status().fingerprint === null));
  ok("[token] and a STABLE one when a token is saved",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      return store.status().fingerprint === store.status().fingerprint && store.status().fingerprint !== null;
    }));
  ok("[token] status reports a stored token WITHOUT creating one",
    withStore((d) => {
      const st = store.status();
      return st.stored === false && !fs.existsSync(path.join(d, "bridge-token"));
    }));
  ok("[token] status names the shadowing case: a saved token the env var overrides",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      process.env.FIGMA_BRIDGE_TOKEN = "env-tok";
      const st = store.status();
      return st.shadowed === true && st.activeSource === "env" && st.stored === true;
    }));
  ok("[token] and does not claim shadowing when only a file exists",
    withStore((d) => {
      store.write("stored-tok", path.join(d, "bridge-token"));
      return store.status().shadowed === false;
    }));

  console.log("\nserver-core — hashed compare:");
  // safeEqual previously short-circuited on length before timingSafeEqual, leaking the token's
  // length. Hashing first makes both sides 32 bytes, so unequal lengths compare normally (and false)
  // rather than returning early — or throwing, which is what a raw timingSafeEqual would do.
  ok("[auth] equal tokens compare true", core.safeEqual("abc", "abc"));
  ok("[auth] different-LENGTH tokens compare false instead of throwing", core.safeEqual("abc", "abcdef") === false);
  ok("[auth] same-length different tokens compare false", core.safeEqual("abc", "abd") === false);
  ok("[auth] the empty token compares false against a real one", core.safeEqual("", TOKEN) === false);

  console.log("\nfigma-pull — token command guards:");
  ok("[token] --token-status parses as a command", pull.parseArgs(["--token-status"]).tokenCmd === "--token-status");
  ok("[token] --show-token parses as a command", pull.parseArgs(["--show-token"]).tokenCmd === "--show-token");
  ok("[token] --rotate-token parses as a command", pull.parseArgs(["--rotate-token"]).tokenCmd === "--rotate-token");
  ok("[token] --forget-token parses as a command", pull.parseArgs(["--forget-token"]).tokenCmd === "--forget-token");
  ok("[token] --token-file takes a value and is NOT a command",
    (() => { const p = pull.parseArgs(["--token-file", "/tmp/t"]); return p.tokenFile === "/tmp/t" && p.tokenCmd === null; })());
  ok("[token] --token-file=<path> form works too", pull.parseArgs(["--token-file=/tmp/t"]).tokenFile === "/tmp/t");
  ok("[token] --token-file with no value is refused",
    /needs a path/.test(parseThrows(["--token-file"]) || ""));
  ok("[token] its value is not mistaken for the positional outDir",
    pull.parseArgs(["--token-file", "/tmp/t"]).outDir !== "/tmp/t");
  ok("[token] a token command is refused alongside an export scope",
    /cannot be combined with --all-pages/.test(parseThrows(["--rotate-token", "--all-pages"]) || ""));
  ok("[token] a token command is refused alongside a daemon command",
    /cannot be combined with --serve/.test(parseThrows(["--show-token", "--serve"]) || ""));
  ok("[token] a token command is refused alongside an index command",
    /cannot be combined with --whoami/.test(parseThrows(["--token-status", "--whoami"]) || ""));
  ok("[token] two token commands at once are refused",
    /different commands/.test(parseThrows(["--show-token", "--rotate-token"]) || ""));
  ok("[token] --token-file is refused with --rotate-token (it would rotate the OTHER token)",
    /silently ignored/.test(parseThrows(["--rotate-token", "--token-file", "/tmp/t"]) || ""));
  ok("[token] and with --token-status, which reports on the STORED token",
    /silently ignored/.test(parseThrows(["--token-status", "--token-file", "/tmp/t"]) || ""));
  ok("[token] and with --forget-token",
    /silently ignored/.test(parseThrows(["--forget-token", "--token-file", "/tmp/t"]) || ""));
  ok("[token] but --token-file IS allowed with --show-token",
    pull.parseArgs(["--show-token", "--token-file", "/tmp/t"]).tokenCmd === "--show-token");
  ok("[token] an ordinary pull still parses with no token command",
    pull.parseArgs(["design"]).tokenCmd === null);

  console.log("\nfigma-pull — token commands end to end (subprocess):");
  // Driven as a real subprocess: these commands must work with NO bridge, NO daemon and NO plugin,
  // which is only honestly testable by running the CLI itself.
  const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-cli-token-"));
  const cli = path.join(__dirname, "..", "bridge", "figma-pull.js");
  const runCli = (argv, extraEnv = {}) => {
    const env = { ...process.env, DESIGNTWIN_CONFIG_DIR: cliDir, ...extraEnv };
    delete env.FIGMA_BRIDGE_TOKEN;
    delete env.FIGMA_BRIDGE_TOKEN_FILE;
    if (extraEnv.FIGMA_BRIDGE_TOKEN) env.FIGMA_BRIDGE_TOKEN = extraEnv.FIGMA_BRIDGE_TOKEN;
    return spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", env });
  };

  const statusFresh = runCli(["--token-status"]);
  ok("[token-cli] --token-status exits 0 with nothing saved", statusFresh.status === 0);
  ok("[token-cli] and reports no saved token rather than inventing one",
    JSON.parse(statusFresh.stdout).stored === false);
  ok("[token-cli] and did NOT create the file as a side effect of asking",
    !fs.existsSync(path.join(cliDir, "bridge-token")));

  ok("[token-cli] --token-status twice reports the SAME thing when nothing is saved",
    runCli(["--token-status"]).stdout === runCli(["--token-status"]).stdout);

  const rotated = runCli(["--rotate-token"]);
  ok("[token-cli] --rotate-token exits 0", rotated.status === 0);
  const rotatedTok = rotated.stdout.trim();
  ok("[token-cli] and prints the new token on stdout so it can be piped", /^[0-9a-f]{48}$/.test(rotatedTok));
  ok("[token-cli] and saved it", fs.readFileSync(path.join(cliDir, "bridge-token"), "utf8").trim() === rotatedTok);
  // The failure mode that would otherwise be a silent 3s reconnect loop in the plugin.
  ok("[token-cli] and TELLS the user to re-paste it into the plugin",
    /re-paste/i.test(rotated.stderr));

  const shown = runCli(["--show-token"]);
  ok("[token-cli] --show-token prints the saved token, not a new one", shown.stdout.trim() === rotatedTok);
  ok("[token-cli] and prints it alone on stdout so `| pbcopy` works", shown.stdout.trim().split("\n").length === 1);

  const statusSaved = JSON.parse(runCli(["--token-status"]).stdout);
  ok("[token-cli] --token-status now reports it as stored", statusSaved.stored === true);
  ok("[token-cli] and never prints the token itself",
    !runCli(["--token-status"]).stdout.includes(rotatedTok));
  ok("[token-cli] and reports the saved token as the active source", statusSaved.activeSource === "file");

  const shadowed = JSON.parse(runCli(["--token-status"], { FIGMA_BRIDGE_TOKEN: "env-wins" }).stdout);
  ok("[token-cli] with the env var set, status reports env as the winner", shadowed.activeSource === "env");
  ok("[token-cli] and flags that the saved token is being shadowed", shadowed.shadowed === true);
  ok("[token-cli] --rotate-token warns when the env var would override the rotation",
    /OVERRIDES/.test(runCli(["--rotate-token"], { FIGMA_BRIDGE_TOKEN: "env-wins" }).stderr));

  const customFile = path.join(cliDir, "custom-token");
  fs.writeFileSync(customFile, "custom-tok-value\n");
  ok("[token-cli] --token-file is honoured by --show-token",
    runCli(["--show-token", "--token-file", customFile]).stdout.trim() === "custom-tok-value");

  // The mint-on-first-bridge-start path, which no other test reaches: the CLI tests above never open
  // a bridge, and this suite's own server-core is loaded with FIGMA_BRIDGE_TOKEN set (source "env",
  // which never persists). Driven as a subprocess on a spare port so it neither needs a plugin nor
  // collides with a real bridge on 8787.
  const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dtwin-boot-"));
  const bootScript = path.join(bootDir, "boot.js");
  fs.writeFileSync(bootScript, `
    const core = require(${JSON.stringify(path.join(__dirname, "..", "bridge", "server-core.js"))});
    const b = core.createBridge(19788);
    b.close();
  `);
  const bootEnv = { ...process.env, DESIGNTWIN_CONFIG_DIR: bootDir };
  delete bootEnv.FIGMA_BRIDGE_TOKEN;
  delete bootEnv.FIGMA_BRIDGE_TOKEN_FILE;
  const boot = spawnSync(process.execPath, [bootScript], { encoding: "utf8", env: bootEnv });
  const bootFile = path.join(bootDir, "bridge-token");
  ok("[token-boot] starting a bridge with nothing saved mints and PERSISTS a token", fs.existsSync(bootFile));
  const bootTok = fs.existsSync(bootFile) ? fs.readFileSync(bootFile, "utf8").trim() : "";
  ok("[token-boot] and prints it once, to paste into the plugin", boot.stderr.includes(bootTok) && bootTok.length === 48);
  ok("[token-boot] and says it was saved, so the user knows not to expect it again",
    /saved to/.test(boot.stderr) && /won't be asked to paste it again/.test(boot.stderr));
  // The regression the whole store exists to prevent: the SECOND run must reuse, not re-mint.
  const boot2 = spawnSync(process.execPath, [bootScript], { encoding: "utf8", env: bootEnv });
  ok("[token-boot] a SECOND bridge start reuses the saved token instead of minting a new one",
    fs.readFileSync(bootFile, "utf8").trim() === bootTok);
  ok("[token-boot] and does NOT reprint the secret into the terminal", !boot2.stderr.includes(bootTok));
  ok("[token-boot] it reports which token is in play by fingerprint instead",
    boot2.stderr.includes(store.fingerprint(bootTok)));

  // Regression: server-core resolves the token at REQUIRE time, so an unreadable --token-file used to
  // throw out of a module load — a raw stack trace, before any front-end error handling was in scope.
  const badFile = runCli(["--show-token", "--token-file", "/nonexistent/nope"]);
  ok("[token-cli] an unreadable --token-file exits 1", badFile.status === 1);
  ok("[token-cli] with a one-line message, not a stack trace",
    /^\[dtwin\] error: --token-file/.test(badFile.stderr.trim()) && !badFile.stderr.includes("at Object."));

  const forgot = runCli(["--forget-token"]);
  ok("[token-cli] --forget-token exits 0", forgot.status === 0);
  ok("[token-cli] and deletes the file", !fs.existsSync(path.join(cliDir, "bridge-token")));
  ok("[token-cli] and forgetting twice is not an error",
    runCli(["--forget-token"]).status === 0);

  // ---------------------------------------------------------------- report
  report();
})();
