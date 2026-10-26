// The plugin's half of the bridge protocol: the relay between the main thread (messages.ts, over the UI
// iframe's postMessage) and the bridge socket (bridge/src/plugin-frames.ts). The main thread has no network and
// the iframe has no scene, so every bridge exchange passes through here, translated both ways:
//   identity                 -> `hello` (fileKey only when the main thread could read it)
//   bridge-result            -> the reply frame for its request id
//   run-begin / progress     -> progress frames, for a BRIDGE run only, carrying its requestId
//   a socket `cancel {id}`   -> a main-thread cancel of that request (an id-less one is dropped)
//   a socket command frame   -> a main-thread `bridge` message
//   the socket opened        -> ask the main thread who this file is (its answer becomes the `hello`)
//   the socket closed        -> cancel scope:bridge (every bridge run is abandoned)
//
// It is DOM-free and socket-free: the window (ui.html) owns the socket, the port walk and the reconnect, and hands
// the relay two ports to talk through. build.ts bundles this module into ui.html as the global `DesignTwinRelay`;
// test/fake-plugin.ts drives the same module, so a field renamed on either side fails to compile here or fails
// the bridge suites, rather than breaking only in Figma.
import { ifDefined, isRecord } from "../../bridge/src/json-util.ts";
import type { WhoamiReply } from "../../bridge/src/commands.ts";
import type { HelloFrame, ProgressFrame, RelayedReplyFrame } from "../../bridge/src/plugin-frames.ts";
import type { BridgeResultMsg, MainToUI, ProgressPost, UIToMain } from "./messages.ts";

/** A frame the relay sends the bridge. */
export type RelayFrame = HelloFrame | ProgressFrame | RelayedReplyFrame;

export interface RelayPorts {
  /** Put a frame on the socket. The window drops it when the socket is not open, as it always has: a frame for
   *  a bridge that is gone has no one to read it. */
  toSocket(frame: RelayFrame): void;
  /** Post a message to the main thread. */
  toMain(msg: UIToMain): void;
}

export interface Relay {
  /** A main-thread message: relays what the bridge must hear of it (the window still reads every message). */
  fromMain(m: MainToUI): void;
  /** A frame's text as the socket delivered it. */
  fromSocket(data: unknown): void;
  socketOpened(): void;
  socketClosed(): void;
}

// The identity fields the hello reads, named by WhoamiReply's keys so a rename there fails to compile here.
// The identity is `unknown` on the message (main.ts posts whatever its whoami read answered, or `{error}`), so
// each is read for its type and an absent or empty one goes out as null.
const idStr = (idn: Record<string, unknown>, k: keyof WhoamiReply): string | null => {
  const v = idn[k];
  return typeof v === "string" && v ? v : null;
};

/** The `hello` for the main thread's identity answer. */
export function helloFrame(identity: unknown): HelloFrame {
  const idn = isRecord(identity) ? identity : {};
  return {
    type: "hello",
    instanceId: idStr(idn, "instanceId"),
    file: idStr(idn, "file"),
    // Only a readable key: a plugin without the private API reports fileKeyAvailable:false (and fileKey null).
    fileKey: idn.fileKeyAvailable === true ? idStr(idn, "fileKey") : null,
    page: idStr(idn, "page"),
    // The plugin's build version (build-options.ts), so the bridge can tell a stale plugin from a reloaded one.
    pluginVersion: idStr(idn, "pluginVersion"),
  };
}

/** The reply frame for a bridge-result, or null for one with no request id (nothing on the bridge waits for it). A
 *  failure with no message goes out as "" — server-core names it ("plugin error"), one fallback for both. */
export function replyFrame(m: BridgeResultMsg): RelayedReplyFrame | null {
  if (m.id === undefined) return null;
  return m.ok ? { id: m.id, ok: true, result: m.result } : { id: m.id, ok: false, error: m.error ?? "" };
}

/** The progress frame for a run-lifecycle / progress post, or null when the bridge has nothing to hear: a UI run
 *  (no bridge caller waits on it) and run-end. `requestId`, when the run's bridge frame carried one, lets the
 *  bridge deliver the frame to THAT request only. */
export function progressFrame(m: ProgressPost): ProgressFrame | null {
  // A bridge run has really started: tell the bridge at once, as a progress frame (the one kind every bridge
  // already reads as life). Until the walk's first page/asset tick — a cold page load plus a long serialize can
  // take a minute — this is the caller's only sign that the run began.
  if (m.type === "run-begin") return m.source === "bridge" ? { type: "progress", phase: "start", ...ifDefined("requestId", m.requestId) } : null;
  if (m.type !== "progress" || m.source !== "bridge") return null;
  // A tick: the bridge's only sign of life during a long export (exportAsync is one long await with no
  // intermediate reply), which tells a slow-but-working export from a stalled connection. progress.ts throttles.
  // A `queued` / `start` frame names its run.
  return {
    type: "progress",
    phase: m.phase,
    ...("requestId" in m ? ifDefined("requestId", m.requestId) : {}),
    ...("page" in m ? ifDefined("page", m.page) : {}),
    ...("nodes" in m ? ifDefined("nodes", m.nodes) : {}),
    ...("assets" in m ? ifDefined("assets", m.assets) : {}),
  };
}

/** The main-thread message for a socket frame's text, or null when the main thread must not hear it. */
export function mainMessageFor(data: unknown): UIToMain | null {
  let f: unknown;
  try { f = JSON.parse(String(data)) as unknown; } catch { return null; }
  if (!isRecord(f)) return null;
  // `{ type: "cancel", id }` with no `cmd`: the bridge gave up on request <id> (its caller timed out, stalled
  // out, or went away). The main thread aborts that run if it is executing or drops it if it is queued. A cancel
  // with no string id is DROPPED: an id-less `cancel` is the designer's button to the main thread, and the bridge
  // must not be able to press it.
  if (f.type === "cancel" && f.cmd === undefined) return typeof f.id === "string" ? { type: "cancel", id: f.id } : null;
  // A command. An odd one (no string cmd) still goes through: handleBridge answers "unknown cmd" for its id,
  // which the bridge reads at once rather than waiting out its timeout.
  return { type: "bridge", ...ifDefined("id", typeof f.id === "string" ? f.id : undefined), cmd: typeof f.cmd === "string" ? f.cmd : String(f.cmd), args: f.args };
}

export function createRelay(ports: RelayPorts): Relay {
  return {
    fromMain(m) {
      if (m.type === "identity") { ports.toSocket(helloFrame(m.identity)); return; }
      if (m.type === "bridge-result") { const r = replyFrame(m); if (r) ports.toSocket(r); return; }
      if (m.type === "run-begin" || m.type === "progress") { const p = progressFrame(m); if (p) ports.toSocket(p); }
    },
    fromSocket(data) {
      const msg = mainMessageFor(data);
      if (msg) ports.toMain(msg);
    },
    // Announce which FILE this is on every open, reconnects included: the bridge accepts several plugin instances
    // at once (one per open file) and routes by identity. Only the main thread can read it (figma.* lives there).
    // Never cached: if Figma restarts the plugin runtime the instanceId changes, and re-reading it on each open is
    // what keeps the bridge's listing honest.
    socketOpened() { ports.toMain({ type: "get-identity" }); },
    // The socket that asked for any bridge work is gone, and a reply carrying an id nobody on the next bridge
    // knows is dropped — so finishing a bridge run is pure waste that queues every later command behind it.
    // Abandon them all (UI-started runs are untouched).
    socketClosed() { ports.toMain({ type: "cancel", scope: "bridge" }); },
  };
}
