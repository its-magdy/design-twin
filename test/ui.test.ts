// Offline tests for figma-plugin/ui.html — the plugin window's script, run against a fake DOM and a
// fake WebSocket. Covers the bridge connection states (the part a designer reads) and the markup the
// script depends on.
//   node test/ui.test.ts
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { check, report } from "./assert.ts";
import { must } from "./fixtures.ts";

const html = fs.readFileSync(path.join(import.meta.dirname, "..", "figma-plugin", "ui.html"), "utf8");
const scriptMatch = must(/<script>([\s\S]*)<\/script>/.exec(html), "<script> in ui.html");
const script = must(scriptMatch[1], "<script> capture group in ui.html");
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "figma-plugin", "manifest.json"), "utf8")) as { networkAccess: { allowedDomains: string[] } };

// Fake DOM element / WebSocket / timer shapes — only what ui.html's script touches.
interface FakeEl {
  id: string; textContent: string; className: string; hidden: boolean; open: boolean; disabled: boolean;
  value: string; style: Record<string, string>; appendChild(): void; innerHTML: string;
  onclick?: () => void;
}
interface FakeSocket {
  url: string; readyState: number;
  onopen?: () => void; onclose?: (e: { code: number }) => void;
  /** every frame the script sent on this socket, as sent (JSON text) */
  sent: string[];
  close(): void; send(d: string): void;
}
interface Timer { fn: (() => void) | null; ms: number }
interface PluginMsg { type: string; token?: string; source?: string; label?: string; phase?: string; requestId?: string }

// One plugin window: returns handles to drive it. `sockets` collects every WebSocket the script opens.
function boot() {
  const els: Record<string, FakeEl> = {};
  const el = (id: string): FakeEl => (els[id] ||= { id, textContent: "", className: "", hidden: false, open: false, disabled: false, value: "", style: {}, appendChild() {}, innerHTML: "" });
  const sockets: FakeSocket[] = [];
  const posted: PluginMsg[] = [];
  const timers: Timer[] = [];
  class FakeWS implements FakeSocket {
    url: string; readyState = 0;
    sent: string[] = [];
    // assigned by the script under test; `declare` keeps them off the instance until it does
    declare onopen?: () => void; declare onclose?: (e: { code: number }) => void;
    constructor(url: string) { this.url = url; sockets.push(this); }
    close() { this.readyState = 3; }
    send(d: string) { this.sent.push(d); }
  }
  const ctx: Record<string, unknown> & { onmessage?: (e: { data: { pluginMessage: PluginMsg } }) => void } = {
    document: { getElementById: el, readyState: "complete", createElement: () => el("_tmp"), addEventListener() {} },
    window: {},
    parent: { postMessage: (m: { pluginMessage: PluginMsg }) => posted.push(m.pluginMessage) },
    WebSocket: FakeWS,
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id: number) => { const t = timers[id - 1]; if (t) t.fn = null; },
    encodeURIComponent, JSON, String, Math, Uint8Array, console,
  };
  ctx.window = ctx; // the script assigns window.onmessage / window.onerror
  vm.runInNewContext(script, ctx);
  const msg = (m: PluginMsg) => ctx.onmessage?.({ data: { pluginMessage: m } });
  const runTimers = () => { const due = timers.splice(0); for (const t of due) if (t.fn) t.fn(); };
  return { el, sockets, posted, timers, msg, runTimers, last: () => must(sockets[sockets.length - 1], "last socket") };
}
const openIt = (s: FakeSocket) => { s.readyState = 1; s.onopen?.(); };
const closeIt = (s: FakeSocket, code: number) => { s.readyState = 3; s.onclose?.({ code }); };

console.log("markup the script depends on:");
const ids = ["status", "banner", "progress", "bar", "run-sel", "run-full", "cancel", "downloads", "layers", "assets", "lcount", "acount", "connect", "pill", "token", "save-token", "bridge"];
check("every element id the script looks up exists in the markup", ids.every((id) => new RegExp(`id="${id}"`).test(html)));
check("the token input has a real <label for>, not just a placeholder", /<label[^>]*for="token"/.test(html));
check("status and banner are live regions (a finished export is announced)", /id="status"[^>]*aria-live/.test(html) && /id="banner"[^>]*role="alert"/.test(html));
check("the connection section is a <details> that is NOT open by default", /<details id="connect">/.test(html));
check("the ports the UI dials are exactly the ports the manifest allows", (() => {
  const bridgePortsMatch = must(/BRIDGE_PORTS = (\[[^\]]+\])/.exec(script), "BRIDGE_PORTS match in script");
  const dialled = JSON.parse(must(bridgePortsMatch[1], "BRIDGE_PORTS capture group")) as number[];
  const allowed = manifest.networkAccess.allowedDomains.map((d) => Number(d.split(":").pop()));
  return JSON.stringify(dialled) === JSON.stringify(allowed);
})());

console.log("theming:");
const styleMatch = must(/<style>([\s\S]*)<\/style>/.exec(html), "<style> in ui.html");
const css = must(styleMatch[1], "<style> capture group in ui.html").replace(/\/\*[\s\S]*?\*\//g, "");
check("no color is hardcoded without going through a Figma theme variable", (() => {
  const bare = css.split("\n").filter((l) => /#[0-9a-fA-F]{3,8}\b/.test(l.replace(/var\(--figma-color-[a-z-]+,\s*#[0-9a-fA-F]{3,8}\)/g, "")));
  if (bare.length) console.log("    bare literals:", bare.map((l) => l.trim()));
  return bare.length === 0;
})());
check("main.ts asks Figma for the theme variables", /showUI\(__html__,\s*\{[^}]*themeColors:\s*true/.test(fs.readFileSync(path.join(import.meta.dirname, "..", "figma-plugin", "src", "main.ts"), "utf8")));

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
  const ports = w.sockets.map((s) => must(/:(\d+)\//.exec(s.url), `port in socket url '${s.url}'`)[1]).join(",");
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
  w.el("token").value = "fresh"; w.el("save-token").onclick?.();
  return w.sockets.length === before + 1 && /token=fresh/.test(w.last().url) && w.posted.some((p) => p.type === "set-token" && p.token === "fresh");
})());
check("only ONE reconnect is ever pending, however many closes arrive", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last();
  closeIt(s, 1006); closeIt(s, 1006);
  return w.timers.filter((t) => t.fn).length === 1;
})());

console.log("liveness frames relayed to the bridge (group 14):");
// The bridge's stall check reads any frame as life. A bridge run's run-begin used to stay inside the
// window, so a cold export was silent on the socket until its first asset tick.
const progressFrames = (s: FakeSocket) => s.sent.filter((d) => (JSON.parse(d) as { type?: string }).type === "progress");
check("[LIVE-3] run-begin of a BRIDGE run → the socket gets {type:\"progress\",phase:\"start\"} at once", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last(); openIt(s);
  w.msg({ type: "run-begin", source: "bridge", label: "exportNode" });
  return progressFrames(s).join("|") === '{"type":"progress","phase":"start"}';
})());
check("[LIVE-3] run-begin of a UI run → nothing on the socket", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last(); openIt(s);
  w.msg({ type: "run-begin", source: "ui", label: "current selection" });
  return progressFrames(s).length === 0 && w.el("run-full").disabled === true; // …while the window's own chrome still opens
})());
check("[LIVE-4] a `queued` frame is relayed over the socket but does NOT open the run chrome (the run has not begun)", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last(); openIt(s);
  const statusBefore = w.el("status").textContent;
  w.msg({ type: "progress", phase: "queued", source: "bridge", label: "exportNode" });
  const relayed = progressFrames(s).map((d) => (JSON.parse(d) as { phase?: string }).phase).join(",");
  return relayed === "queued" && w.el("run-full").disabled === false && w.el("cancel").textContent === "" && w.el("status").textContent === statusBefore;
})());
check("[LIVE-4] …and during a UI run a `queued` frame leaves that run's status line alone", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); openIt(w.last());
  w.msg({ type: "run-begin", source: "ui", label: "current selection" });
  const during = w.el("status").textContent;
  w.msg({ type: "progress", phase: "queued", source: "bridge", label: "exportNode" });
  return w.el("status").textContent === during && /Exporting/.test(during);
})());
// Review 1 L-8: the frames name their run's request, so the bridge delivers them to that request only.
check("[L-8] run-begin of a bridge run with a requestId → the `start` frame carries it; a `queued` frame keeps its requestId", (() => {
  const w = boot(); w.msg({ type: "token", token: "t" }); const s = w.last(); openIt(s);
  w.msg({ type: "progress", phase: "queued", source: "bridge", label: "exportNode", requestId: "rB-2" });
  w.msg({ type: "run-begin", source: "bridge", label: "exportNode", requestId: "rA-1" });
  return progressFrames(s).join("|") === '{"type":"progress","phase":"queued","requestId":"rB-2"}|{"type":"progress","phase":"start","requestId":"rA-1"}';
})());

report();
