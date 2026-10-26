// plugin-frames.ts — the plugin <-> bridge protocol on the wire: the JSON each side sends over the socket.
// The bridge's side is server-core.ts (it sends BridgeFrames and parses what comes back); the plugin's side is
// figma-plugin/src/relay.ts, bundled into ui.html, which turns main-thread messages into these frames and these
// frames into main-thread messages. The test suites' fake plugin (test/fake-plugin.ts) drives that same relay.
//
// Dependency-free apart from type imports of commands.ts: the plugin's relay imports it, so it must type-check
// under figma-plugin/tsconfig.json (ES2019 lib, no Node types). server-core.ts re-exports the wire frames.
import type { Cmd, Commands } from "./commands.ts";

/** bridge -> plugin: run one command; the plugin answers with a ReplyFrame carrying the same id. */
export interface CommandFrame<C extends Cmd = Cmd> { id: string; cmd: C; args: Commands[C]["args"] }
/** bridge -> plugin: the bridge gave up on request `id` (timed out, stalled out, or its caller left). */
export interface CancelFrame { type: "cancel"; id: string }
export type BridgeFrame = CommandFrame | CancelFrame;
/** plugin -> bridge: who this plugin is, sent on every socket open. The relay sends null for what it does not
 *  know; a plugin older than version reporting omits pluginVersion. */
export interface HelloFrame {
  type: "hello";
  instanceId?: string | null; file?: string | null; fileKey?: string | null; page?: string | null; pluginVersion?: string | null;
}
/** plugin -> bridge: an unsolicited progress tick (figma-plugin/src/progress.ts), for the run serving `requestId`. */
export interface ProgressFrame {
  type: "progress";
  requestId?: string | null; phase?: string; page?: { index: number; of: number; name?: string | null } | null;
  nodes?: number | null; assets?: number | null;
}
/** plugin -> bridge: the answer to command `id`. */
export type ReplyFrame = { [C in Cmd]: { id: string; ok: true; result: Commands[C]["reply"] } }[Cmd] | { id: string; ok: false; error: string };
/** A ReplyFrame as the relay sends it: the main thread's result, whose shape server-core checks on arrival
 *  (commands.ts replyShapeError) — the relay forwards it, it cannot know it. */
export type RelayedReplyFrame = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
export type PluginWireFrame = HelloFrame | ProgressFrame | ReplyFrame;
