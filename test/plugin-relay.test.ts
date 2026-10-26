// The plugin's half of the bridge protocol (figma-plugin/src/relay.ts), in-process: each translation between the
// main thread's messages (messages.ts) and the socket's frames (bridge/src/plugin-frames.ts), on its own. The window
// it is bundled into is test/ui.test.ts's; every bridge suite drives it through test/fake-plugin.ts.
//   bun test/plugin-relay.test.ts
import { check, report } from "./assert.ts";
import { createRelay, type RelayFrame } from "../figma-plugin/src/relay.ts";
import type { UIToMain } from "../figma-plugin/src/messages.ts";

function harness() {
  const frames: RelayFrame[] = [];
  const posted: UIToMain[] = [];
  const relay = createRelay({ toSocket: (f) => frames.push(f), toMain: (m) => posted.push(m) });
  return { relay, frames, posted, wire: () => frames.map((f) => JSON.stringify(f)) };
}
const identity = { instanceId: "inst-1", startedAt: 1, uptimeMs: 2, file: "Sample App", page: "Home", pageId: "0:1", editorType: "figma", pluginVersion: "0.1.0" };

console.log("main thread -> socket:");
check("identity → hello with the five fields; fileKey only when fileKeyAvailable", (() => {
  const h = harness();
  h.relay.fromMain({ type: "identity", identity: { ...identity, fileKey: "KEY", fileKeyAvailable: true } });
  h.relay.fromMain({ type: "identity", identity: { ...identity, fileKey: "KEY", fileKeyAvailable: false } });
  return h.wire().join("|") === '{"type":"hello","instanceId":"inst-1","file":"Sample App","fileKey":"KEY","page":"Home","pluginVersion":"0.1.0"}'
    + '|{"type":"hello","instanceId":"inst-1","file":"Sample App","fileKey":null,"page":"Home","pluginVersion":"0.1.0"}';
})());
check("an identity read that failed ({error}) → a hello of nulls (the bridge lists the connection unnamed)", (() => {
  const h = harness();
  h.relay.fromMain({ type: "identity", identity: { error: "boom" } });
  return h.wire().join() === '{"type":"hello","instanceId":null,"file":null,"fileKey":null,"page":null,"pluginVersion":null}';
})());
check("bridge-result → the reply frame for its id: {id, ok:true, result} / {id, ok:false, error}", (() => {
  const h = harness();
  h.relay.fromMain({ type: "bridge-result", id: "r1-1", ok: true, result: { pong: true, page: "Home", file: "F" } });
  h.relay.fromMain({ type: "bridge-result", id: "r1-2", ok: false, result: undefined, error: "export cancelled by the designer in Figma" });
  return h.wire().join("|") === '{"id":"r1-1","ok":true,"result":{"pong":true,"page":"Home","file":"F"}}'
    + '|{"id":"r1-2","ok":false,"error":"export cancelled by the designer in Figma"}';
})());
check("a bridge-result with no id (no bridge request waits on it) → nothing on the socket", (() => {
  const h = harness();
  h.relay.fromMain({ type: "bridge-result", ok: true, result: 1 });
  return h.frames.length === 0;
})());
check("run-begin of a bridge run → {progress, phase:start} carrying its requestId; a UI run's → nothing", (() => {
  const h = harness();
  h.relay.fromMain({ type: "run-begin", source: "bridge", label: "exportNode", requestId: "rA-1" });
  h.relay.fromMain({ type: "run-begin", source: "bridge", label: "exportNode" });
  h.relay.fromMain({ type: "run-begin", source: "ui", label: "current selection" });
  return h.wire().join("|") === '{"type":"progress","phase":"start","requestId":"rA-1"}|{"type":"progress","phase":"start"}';
})());
check("a bridge run's progress tick → phase, page, nodes, assets copied; a UI run's tick and run-end → nothing", (() => {
  const h = harness();
  h.relay.fromMain({ type: "progress", phase: "pages", source: "bridge", label: "exportFull", page: { index: 2, of: 5, name: "P2" }, nodes: 120, assets: 3 });
  h.relay.fromMain({ type: "progress", phase: "pages", source: "ui", label: "full file", nodes: 1 });
  h.relay.fromMain({ type: "run-end" });
  return h.wire().join("|") === '{"type":"progress","phase":"pages","page":{"index":2,"of":5,"name":"P2"},"nodes":120,"assets":3}';
})());
check("`queued` / `start` progress posts → relayed with their requestId", (() => {
  const h = harness();
  h.relay.fromMain({ type: "progress", phase: "queued", source: "bridge", label: "exportNode", requestId: "rB-2" });
  h.relay.fromMain({ type: "progress", phase: "start", source: "bridge", label: "listPages", requestId: "rS-1" });
  return h.wire().join("|") === '{"type":"progress","phase":"queued","requestId":"rB-2"}|{"type":"progress","phase":"start","requestId":"rS-1"}';
})());
check("window-only messages (selection, files, token, cancel-ack, error) → nothing on the socket", (() => {
  const h = harness();
  h.relay.fromMain({ type: "selection", count: 1, name: "Card" });
  h.relay.fromMain({ type: "token", token: "t" });
  h.relay.fromMain({ type: "cancel-ack", accepted: true, label: "x" });
  h.relay.fromMain({ type: "error", message: "m" });
  h.relay.fromMain({ type: "files", files: [], assets: [], summary: "s", warnings: 0 });
  return h.frames.length === 0 && h.posted.length === 0;
})());

console.log("socket -> main thread:");
check("a command frame → {type:bridge, id, cmd, args}", (() => {
  const h = harness();
  h.relay.fromSocket(JSON.stringify({ id: "r1-3", cmd: "exportNode", args: { nodeId: "1:2" } }));
  return JSON.stringify(h.posted) === '[{"type":"bridge","id":"r1-3","cmd":"exportNode","args":{"nodeId":"1:2"}}]';
})());
check("a cancel frame with a string id → a main-thread cancel of that request", (() => {
  const h = harness();
  h.relay.fromSocket(JSON.stringify({ type: "cancel", id: "r1-4" }));
  return JSON.stringify(h.posted) === '[{"type":"cancel","id":"r1-4"}]';
})());
check("an id-less (or non-string-id) cancel frame → DROPPED: the bridge cannot press the designer's Cancel button", (() => {
  const h = harness();
  h.relay.fromSocket(JSON.stringify({ type: "cancel" }));
  h.relay.fromSocket(JSON.stringify({ type: "cancel", id: 7 }));
  return h.posted.length === 0;
})());
check("unparseable text and non-object JSON → nothing posted", (() => {
  const h = harness();
  for (const d of ["{", "null", "5", '"x"', "[1]"]) h.relay.fromSocket(d);
  return h.posted.length === 0;
})());
check("a frame with no string cmd still reaches the main thread (handleBridge answers it by id, no wait for a timeout)", (() => {
  const h = harness();
  h.relay.fromSocket(JSON.stringify({ id: "r1-5" }));
  return JSON.stringify(h.posted) === '[{"type":"bridge","id":"r1-5","cmd":"undefined"}]';
})());

console.log("socket lifecycle:");
check("socket opened → the main thread is asked who this file is (get-identity)", (() => {
  const h = harness();
  h.relay.socketOpened();
  return JSON.stringify(h.posted) === '[{"type":"get-identity"}]' && h.frames.length === 0;
})());
check("socket closed → cancel scope:bridge (every bridge run abandoned)", (() => {
  const h = harness();
  h.relay.socketClosed();
  return JSON.stringify(h.posted) === '[{"type":"cancel","scope":"bridge"}]';
})());

report();
