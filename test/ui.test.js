// Offline tests for figma-plugin/ui.html — the plugin window's script, run against a fake DOM and a
// fake WebSocket. Covers the bridge connection states (the part a designer reads) and the markup the
// script depends on.
//   node test/ui.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { check, report } = require("./assert");

const html = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "ui.html"), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "manifest.json"), "utf8"));

// One plugin window: returns handles to drive it. `sockets` collects every WebSocket the script opens.
function boot() {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: "", className: "", hidden: false, open: false, disabled: false, value: "", style: {}, appendChild() {}, innerHTML: "" });
  const sockets = [];
  const posted = [];
  const timers = [];
  function FakeWS(url) { this.url = url; this.readyState = 0; sockets.push(this); }
  FakeWS.prototype.close = function () { this.readyState = 3; };
  FakeWS.prototype.send = function () {};
  const ctx = {
    document: { getElementById: el, readyState: "complete", createElement: () => el("_tmp"), addEventListener() {} },
    window: {},
    parent: { postMessage: (m) => posted.push(m.pluginMessage) },
    WebSocket: FakeWS,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    encodeURIComponent, JSON, String, Math, Uint8Array, console,
  };
  ctx.window = ctx; // the script assigns window.onmessage / window.onerror
  vm.runInNewContext(script, ctx);
  const msg = (m) => ctx.onmessage({ data: { pluginMessage: m } });
  const runTimers = () => { const due = timers.splice(0); for (const t of due) if (t.fn) t.fn(); };
  return { el, sockets, posted, timers, msg, runTimers, last: () => sockets[sockets.length - 1] };
}
const openIt = (s) => { s.readyState = 1; s.onopen(); };
const closeIt = (s, code) => { s.readyState = 3; s.onclose({ code }); };

console.log("markup the script depends on:");
const ids = ["status", "banner", "progress", "bar", "run-sel", "run-full", "cancel", "downloads", "layers", "assets", "lcount", "acount", "connect", "pill", "token", "save-token", "bridge"];
check("every element id the script looks up exists in the markup", ids.every((id) => new RegExp(`id="${id}"`).test(html)));
check("the token input has a real <label for>, not just a placeholder", /<label[^>]*for="token"/.test(html));
check("status and banner are live regions (a finished export is announced)", /id="status"[^>]*aria-live/.test(html) && /id="banner"[^>]*role="alert"/.test(html));
check("the connection section is a <details> that is NOT open by default", /<details id="connect">/.test(html));
check("the ports the UI dials are exactly the ports the manifest allows", (() => {
  const dialled = JSON.parse(/BRIDGE_PORTS = (\[[^\]]+\])/.exec(script)[1]);
  const allowed = manifest.networkAccess.allowedDomains.map((d) => Number(d.split(":").pop()));
  return JSON.stringify(dialled) === JSON.stringify(allowed);
})());

console.log("theming:");
const css = /<style>([\s\S]*)<\/style>/.exec(html)[1].replace(/\/\*[\s\S]*?\*\//g, "");
check("no color is hardcoded without going through a Figma theme variable", (() => {
  const bare = css.split("\n").filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l.replace(/var\(--figma-color-[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/g, "")));
  if (bare.length) console.log("    bare literals:", bare.map((l) => l.trim()));
  return bare.length === 0;
})());
check("main.ts asks Figma for the theme variables", /showUI\(__html__,\s*\{[^}]*themeColors:\s*true/.test(fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "src", "main.ts"), "utf8")));

console.log("connection states:");
check("no token saved → 'not set up', neutral, section stays closed, nothing is dialled", (() => {
  const w = boot(); w.msg({ type: "token", token: "" });
  return w.el("pill").textContent === "not set up" && w.el("pill").className === "" && w.el("connect").open === false && w.sockets.length === 0;
})());
check("connected → green 'connected' naming the port", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); openIt(w.last());
  return w.el("pill").textContent === "connected" && w.el("bridge").className === "on" && /8787/.test(w.el("bridge").textContent);
})());
check("close 4401 → 'token rejected': red, says what to run, OPENS the section, stays on that port, retries slowly", (() => {
  const w = boot(); w.msg({ type: "token", token: "stale" }); closeIt(w.last(), 4401);
  const slow = w.timers.some((t) => t.ms === 15000);
  w.runTimers();
  return w.el("pill").textContent === "token rejected" && w.el("bridge").className === "bad" && /dtwin --show-token/.test(w.el("bridge").textContent)
    && w.el("connect").open === true && slow && /:8787\//.test(w.last().url);
})());
check("nothing listening → walks every allowed port, THEN says 'not running' (neutral, not an error) with how to start one", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" });
  closeIt(w.last(), 1006); const afterOne = w.el("pill").textContent; w.runTimers();
  closeIt(w.last(), 1006); w.runTimers();
  closeIt(w.last(), 1006);
  const ports = w.sockets.map((s) => /:(\d+)\//.exec(s.url)[1]).join(",");
  return afterOne === "connecting…" && ports === "8787,8788,8789" && w.el("pill").textContent === "not running" && w.el("bridge").className === ""
    && /dtwin --serve/.test(w.el("bridge").textContent) && w.el("connect").open === false;
})());
check("a bridge that WAS connected and went away → 'waiting', worded as normal (a one-shot dtwin pull ended)", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); openIt(w.last()); closeIt(w.last(), 1000);
  return w.el("pill").textContent === "waiting" && w.el("bridge").className === "" && /reconnects by itself/.test(w.el("bridge").textContent);
})());
check("saving a new token after a rejection reconnects at once, not after the 15s retry", (() => {
  const w = boot(); w.msg({ type: "token", token: "stale" }); closeIt(w.last(), 4401);
  const before = w.sockets.length;
  w.el("token").value = "fresh"; w.el("save-token").onclick();
  return w.sockets.length === before + 1 && /token=fresh/.test(w.last().url) && w.posted.some((p) => p.type === "set-token" && p.token === "fresh");
})());
check("only ONE reconnect is ever pending, however many closes arrive", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last();
  closeIt(s, 1006); closeIt(s, 1006);
  return w.timers.filter((t) => t.fn).length === 1;
})());

report();
