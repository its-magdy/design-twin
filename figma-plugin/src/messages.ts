// UI <-> main-thread message contract (figma.ui.postMessage / window.onmessage's `pluginMessage`).
// Derived from what figma-plugin/ui.html actually sends (`parent.postMessage({pluginMessage:{...}})`)
// and what main.ts actually posts back (`figma.ui.postMessage({...})`) — see ui.html around the
// `send()` helper (line ~216) and its handlers (~430-562), and main.ts's figma.ui.onmessage.
import type { Asset } from "./state";
import type { ProgressPost } from "./progress";

// ---------- UI -> main ----------

export interface GetTokenMsg { type: "get-token"; }
export interface SetTokenMsg { type: "set-token"; token?: string; }
export interface GetIdentityMsg { type: "get-identity"; }
export interface RunSelectionMsg { type: "run-selection"; }
export interface RunFullMsg { type: "run-full"; }
// Three meanings, one message type (main.ts `case "cancel"`):
//   no `id`, no `scope` — the designer's Cancel button (answered with `cancel-ack`, unchanged);
//   `id`                — the bridge gave up on request <id> (ui.html forwards the socket's
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
