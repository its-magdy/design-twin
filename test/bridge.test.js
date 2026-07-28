// Offline tests for the BRIDGE layer — the two files the plugin harness can't reach:
//   1. bridge/server-core.js  — verifyClient, the bridge's only real access control (token + Origin
//      + loopback Host). Previously reachable only through a live WebSocket handshake, so untested.
//   2. bridge/seed-components.js — a CLI, so it's driven as a subprocess in a temp dir.
// Run with:  node test/bridge.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { ok, report } = require("./assert");

// A fixed token so verifyClient's comparisons are deterministic. server-core reads this at require
// time, so it must be set BEFORE the module is loaded.
process.env.FIGMA_BRIDGE_TOKEN = "test-token-abc123";
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
ok("[auth] correct token accepted", verify({ token: "test-token-abc123", origin: "null" }).accepted === true);
ok("[auth] wrong token rejected 401", (() => { const r = verify({ token: "nope", origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] missing token rejected 401", (() => { const r = verify({ origin: "null" }); return r.accepted === false && r.code === 401; })());
ok("[auth] empty token rejected", verify({ token: "", origin: "null" }).accepted === false);
// The CSWSH case the file's own comment calls out: a sandboxed attacker iframe also sends "null",
// so Origin must NOT be sufficient on its own — only the token decides.
ok("[auth] Origin:null WITHOUT token still rejected (CSWSH)", verify({ origin: "null" }).accepted === false);
ok("[auth] real website origin rejected 403", (() => { const r = verify({ token: "test-token-abc123", origin: "https://evil.example" }); return r.accepted === false && r.code === 403; })());
ok("[auth] localhost origin allowed", verify({ token: "test-token-abc123", origin: "http://localhost:3000" }).accepted === true);
// DNS-rebinding: Origin looks fine but Host points at an attacker-controlled name.
ok("[auth] non-loopback Host rejected 403 (DNS rebinding)", (() => { const r = verify({ token: "test-token-abc123", origin: "null", host: "evil.example:8787" }); return r.accepted === false && r.code === 403; })());
ok("[auth] ::1 Host allowed", verify({ token: "test-token-abc123", origin: "null", host: "[::1]:8787" }).accepted === true);
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

// ---------------------------------------------------------------- report
report();
