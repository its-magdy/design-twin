// UI <-> main-thread message contract (figma.ui.postMessage / window.onmessage's `pluginMessage`).
// Derived from what figma-plugin/ui.html actually sends (`parent.postMessage({pluginMessage:{...}})`)
// and what main.ts actually posts back (`figma.ui.postMessage({...})`) — see ui.html around the
// `send()` helper (line ~216) and its handlers (~430-562), and main.ts's figma.ui.onmessage.
import type { Obj } from "./util";
import type { Asset } from "./state";
import type { ScreenDoc, LayersDoc, DesignSystemDoc } from "../../bridge/src/doc-types.ts";
import type { VariablesDump } from "./variables";

// ---------- UI -> main ----------

export interface GetTokenMsg { type: "get-token"; }
export interface SetTokenMsg { type: "set-token"; token?: string; }
export interface GetIdentityMsg { type: "get-identity"; }
export interface RunSelectionMsg { type: "run-selection"; }
export interface RunFullMsg { type: "run-full"; }
export interface CancelMsg { type: "cancel"; }
// `args` is the bridge command's own payload — shape varies per `cmd` (handleBridge in bridge.ts is
// itself untyped at the boundary), so it stays structurally loose here rather than widening handleBridge.
export interface BridgeMsg { type: "bridge"; id?: string; cmd: string; args?: Obj; }

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
  | BridgeResultMsg;

// ---------- export-result shapes runExport's `toFiles` helpers read ----------
// Fields actually accessed in main.ts, typed against the SAME doc shapes the bridge side already
// declares (bridge/src/doc-types.ts) plus variables.ts's own VariablesDump — collect.ts's
// collectSelection/collectFull are still typed `Promise<Obj>` (out of scope for this pass), so main.ts
// asserts its result to these interfaces once (see the `collectSelectionTyped`/`collectFullTyped`
// wrappers) rather than reading through `any`.
export interface ScreenExportResult {
  screenName: string;
  screen: ScreenDoc;
  variables: VariablesDump;
  assets: Asset[];
}

export interface FullExportResult {
  layersDoc: LayersDoc;
  designSystem: DesignSystemDoc;
  assets: Asset[];
}
