// UI <-> main-thread message contract (figma.ui.postMessage / window.onmessage's `pluginMessage`): what the
// window sends (ui.template.html's buttons, and its bridge relay, relay.ts) and what main.ts posts back (its typed
// `post()`, or progress.ts's figma.ui.postMessage). relay.ts is typed against it, so a message renamed here fails
// to compile there; the window's own DOM handling is plain JS and is covered by test/ui.test.ts.
// A leaf: type imports of bridge/src only, so the window's relay (relay.ts) and the tests can import it without the
// main thread's modules (which need the Figma globals).
import type { Asset } from "../../bridge/src/doc-types.ts";

// ---------- UI -> main ----------

export interface GetTokenMsg { type: "get-token"; }
export interface SetTokenMsg { type: "set-token"; token?: string; }
export interface GetIdentityMsg { type: "get-identity"; }
export interface RunSelectionMsg { type: "run-selection"; }
export interface RunFullMsg { type: "run-full"; }
// Three meanings, one message type (main.ts `case "cancel"`):
//   no `id`, no `scope` — the designer's Cancel button (answered with `cancel-ack`, unchanged);
//   `id`                — the bridge gave up on request <id> (relay.ts forwards the socket's
//                         `{ type: "cancel", id }` frame); no ack;
//   `scope: "bridge"`   — the socket closed: every bridge-sourced run is abandoned; no ack.
export interface CancelMsg { type: "cancel"; id?: string; scope?: "bridge"; }
// `args` is the bridge command's own payload, parsed JSON whose shape varies per `cmd` — `unknown`
// until handleBridge (bridge.ts) narrows it per command.
export interface BridgeMsg { type: "bridge"; id?: string; cmd: string; args?: unknown; }

export type UIToMain =
  | GetTokenMsg
  | SetTokenMsg
  | GetIdentityMsg
  | RunSelectionMsg
  | RunFullMsg
  | CancelMsg
  | BridgeMsg;

const UI_TO_MAIN_TYPES: ReadonlySet<UIToMain["type"]> = new Set([
  "get-token", "set-token", "get-identity", "run-selection", "run-full", "cancel", "bridge",
]);

export function isUIToMain(x: unknown): x is UIToMain {
  if (!x || typeof x !== "object") return false;
  const t = (x as { type?: unknown }).type;
  return typeof t === "string" && UI_TO_MAIN_TYPES.has(t as UIToMain["type"]);
}

// ---------- main -> UI: a run's lifecycle and progress (progress.ts posts these) ----------

/** Who asked for a run (progress.ts RunInfo). */
export type RunSource = "ui" | "bridge";
/** The walk's phases a progress tick reports (progress.ts progress()). */
export type Phase = "pages" | "assets" | "design-system";
/** The page the walk is on: 1-based `index` of `of` pages walked. `pageId` is the identity (page names
 *  are not unique); absent only when a caller had no id to give. */
export interface ProgressPage { index: number; of: number; name: string; pageId?: string }
/** The running counters a progress frame carries (each phase reports the ones it has). */
export interface ProgressCounters { nodes?: number; assets?: number; components?: number }
/** `requestId` (a bridge run whose frame carried one) lets the bridge hand the `start` frame the window's relay (relay.ts) sends
 *  to THAT request only, not to every request pending on the connection. */
export interface RunBeginMsg { type: "run-begin"; source: RunSource; label: string; requestId?: string }
/** `abandoned` is present (and `true`) only when the run THREW because the bridge request that asked
 *  for it was abandoned — the one case where the window has no other way to learn why a run ended (a
 *  bridge run's error goes to the socket, never to the window). Absent otherwise, so the designer's
 *  Cancel and every normal run still post exactly `{ type: "run-end" }`. */
export interface RunEndMsg { type: "run-end"; abandoned?: true }
export interface ProgressMsg extends ProgressCounters {
  type: "progress";
  phase: Phase;
  source: RunSource;
  label: string;
  page?: ProgressPage;
}
/** A BRIDGE run accepted while another run is executing: it waits its turn (serializeRun, state.ts).
 *  The window's relay (relay.ts) sends it over the socket — the caller's first sign of life when the file is busy with an
 *  earlier export — and never opens the run chrome for it (the run has not begun). */
export interface QueuedMsg { type: "progress"; phase: "queued"; source: "bridge"; label: string; requestId?: string }
/** A bridge SCENE read that waited (state.ts scheduleRun) has begun. A bracketed run says so with run-begin, which
 *  the relay turns into the same `start` frame for the bridge; a scene read is no run of the window's, so it posts this
 *  instead, which the relay sends and the window shows nothing for. The bridge re-arms that request's budget on it. */
export interface StartMsg { type: "progress"; phase: "start"; source: "bridge"; label: string; requestId?: string }
export type ProgressPost = RunBeginMsg | RunEndMsg | ProgressMsg | QueuedMsg | StartMsg;

// ---------- main -> UI ----------

export interface ErrorMsg { type: "error"; message: string; }
export interface ExportFile { name: string; content: string; copyable?: boolean; }
export interface ExportLayerFile { name: string; content: string; }
export interface FilesMsg {
  type: "files";
  files: ExportFile[];
  layerFiles?: ExportLayerFile[];
  assets: Asset[];
  summary: string;
  warnings: number;
}
export interface TokenMsg { type: "token"; token: string; }
export interface IdentityMsg { type: "identity"; identity: unknown; }
export interface SelectionMsg { type: "selection"; count: number; name: string | null; }
export interface CancelAckMsg { type: "cancel-ack"; accepted: boolean; label: string | null; }
export interface BridgeResultMsg { type: "bridge-result"; id?: string; ok: boolean; result: unknown; error?: string; }

export type MainToUI =
  | ErrorMsg
  | FilesMsg
  | TokenMsg
  | IdentityMsg
  | SelectionMsg
  | CancelAckMsg
  | BridgeResultMsg
  // run-begin / progress / run-end, posted by progress.ts
  | ProgressPost;
