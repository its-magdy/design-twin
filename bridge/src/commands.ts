// commands.ts — THE bridge command/reply contract: every command the plugin's `handleBridge`
// (figma-plugin/src/bridge.ts) accepts, with the argument shape each one reads and the reply shape
// each one returns. Both sides derive from this one map:
//   - the plugin dispatches on `Cmd` (an exhaustive switch — a command added here without a handler
//     fails to compile there);
//   - server-core.ts / daemon.ts / figma-mcp.ts / figma-pull.ts type `request()` per command, so a
//     caller can no longer name a reply type the plugin never sends (the `IndexReply`/`WhoamiReply`
//     hand-mirrors this replaces were stale once already: an `r.frames` the plugin never produced);
//   - `replyShapeError` is the ONE structural check a reply passes at the point it enters the Node
//     process (server-core.ts), so a plugin answering the wrong shape is a named error, not a
//     TypeError three modules later.
//
// Dependency-free apart from type imports (like read-opts.ts): the plugin bundle imports it too, so it
// must type-check under figma-plugin/tsconfig.json (ES2019 lib, no Node types). Reply shapes that ARE
// documents on disk (ScreenExport, LayersDoc, DesignSystemDoc, VariablesDoc, Manifest, Asset) are
// referenced from doc-types.ts, never restated.
import type { Asset, DesignSystemDoc, LayersDoc, Manifest, ScreenExport, VariablesDoc } from "./doc-types.ts";
import type { ReadOptName } from "./read-opts.ts";

// ---------------------------------------------------------------- arguments

/** The opt-in read options (read-opts.ts registry), as every walking export accepts them. */
export type ReadOptArgs = Partial<Record<ReadOptName, boolean>>;
/** A command that reads nothing from `args` (`{}` on the wire). */
export type NoArgs = Record<never, never>;

export interface ListPagesArgs {
  /** 1 = page names only (loads nothing); 2 = pages + their top-level layers (the default). */
  depth?: 1 | 2;
}
export interface NodeArgs {
  /** A node id (any form node-id.ts accepts — the plugin normalises it). */
  nodeId: string;
}
/** collect.ts CollectOpts: the read options plus the page scope. `page` and `allPages` are exclusive. */
export interface ExportFullArgs extends ReadOptArgs {
  allPages?: boolean;
  page?: string | string[];
}
/** The catalog-only pulls accept ONE read option: variantVisuals enriches the component catalog they build. */
export interface DesignSystemArgs {
  variantVisuals?: boolean;
}
export interface ExportLibraryArgs extends DesignSystemArgs {
  /** The library's display name (what libraries/<slug>-<key>/ is named after). Defaults to figma.root.name. */
  asLibrary?: string;
}
export interface ExportNodeArgs extends ReadOptArgs, NodeArgs {}
export interface ScreenshotArgs extends NodeArgs {
  /** Render scale override (default: auto, capped at 2048px on the longest side). */
  scale?: number;
}

/** The four write ops figma-plugin/src/writes.ts implements. */
export type WriteOpName = "createFrame" | "createText" | "setFill" | "setText";
/** One write op (writes.ts WriteOp, mirrored): only the fields each op actually reads. */
export interface WriteOp {
  op: WriteOpName;
  parentId?: string;
  name?: string;
  width?: number;
  height?: number;
  layoutMode?: "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  padding?: [number, number, number, number];
  fill?: string;
  text?: string;
  fontSize?: number;
  nodeId?: string;
  color?: string;
}
export interface WriteArgs {
  ops: WriteOp[];
}

// ---------------------------------------------------------------- replies

export interface PingReply {
  pong: true;
  page: string;
  file: string;
  /** only when figma.fileKey is readable (private-plugin API) */
  fileKey?: string;
}

/** bridge.ts `whoami`: the plugin instance's identity (see the handler's comment for what each answers). */
export interface WhoamiReply {
  instanceId: string;
  startedAt: number;
  uptimeMs: number;
  file: string;
  page: string;
  pageId: string;
  editorType: string;
  pluginVersion: string;
  /** null when `figma.fileKey` is unavailable (not a private plugin) */
  fileKey: string | null;
  fileKeyAvailable: boolean;
}

/** One selected node (figma.currentPage.selection, summarised). */
export interface SelectionEntry {
  id: string;
  name: string;
  type: string;
}

/** collect.ts summarize(): the ONLY shape the cheap index reads emit. `hasChildren` is listChildren-only. */
export interface NodeSummary {
  name: string;
  id: string;
  type: string;
  w?: number;
  h?: number;
  hidden?: true;
  hasChildren?: boolean;
}
/** One page of a listPages reply. `frames` is present at depth 2 only, and absent on an `unreadable` page. */
export interface PageSummary {
  name: string;
  id: string;
  current?: true;
  unreadable?: true;
  frames?: NodeSummary[];
}
export interface ListPagesReply {
  exportedAt: string;
  file: string;
  depth: 1 | 2;
  pages: PageSummary[];
  manifest: { pages: number; frames?: number; warnings: string[] };
}
export interface ListChildrenReply {
  exportedAt: string;
  id: string;
  name: string;
  type: string;
  children: NodeSummary[];
  manifest: { children: number; warnings: string[] };
}

/** One variable collection of a library (libraries.ts). `variableCount` is omitted when it could not be read. */
export interface LibraryCollection {
  key: string;
  name: string;
  variableCount?: number;
}
/** One library row of a listLibraries reply — the open file itself (`kind: "local"`) or an enabled library. */
export interface LibraryRow {
  key: string;
  name: string;
  kind: "local" | "library";
  variableCollections: LibraryCollection[];
  /** USAGE-derived (components of that library used in this file); absent when it cannot be attributed */
  componentCount?: number;
  note?: string;
}
export interface ListLibrariesReply {
  exportedAt: string;
  file?: string;
  libraries: LibraryRow[];
  warnings: string[];
}

/** collect.ts collectFull: the design system + the page walk + every asset the walk exported. */
export interface FullExportReply {
  designSystem: DesignSystemDoc;
  layersDoc: LayersDoc;
  assets: Asset[];
}
/** collect.ts collectDesignSystemOnly / collectLibraryFile: the catalog alone (a library's carries `source.role`). */
export interface DesignSystemReply {
  designSystem: DesignSystemDoc;
}
/** collect.ts screenResult (collectSelection / collectNode): one screen doc, its token slice, its assets,
 *  and the page/node identity repeated at the top level for the writer's routing. */
export interface ScreenReply {
  screenName: string;
  screen: ScreenExport;
  variables: VariablesDoc;
  assets: Asset[];
  page?: string;
  pageId?: string;
  nodeId?: string;
}
/** collect.ts collectScreenshot: one node's reference PNG (in `assets`, named by `reference`). */
export interface ScreenshotReply {
  id: string;
  name: string;
  type: string;
  reference: string;
  manifest: Manifest;
  assets: Asset[];
}
/** Every reply write-out.ts knows how to land on disk. The members are told apart by the fields only
 *  they carry (`screen` / `reference` / `layersDoc`), which is what writeAny narrows on. */
export type ExportReply = FullExportReply | DesignSystemReply | ScreenReply | ScreenshotReply;

/** One applied write op: the id of the node it created or changed (writes.ts applyWrite). */
export interface AppliedWrite {
  id?: string;
}
/** writes.ts WriteResult, mirrored: `ok: false` on a partial failure, with what was applied before it. */
export interface WriteResult {
  ok: boolean;
  applied: AppliedWrite[];
  failedAt?: number;
  failedOp?: string;
  error?: string;
}

// ---------------------------------------------------------------- the map

export interface Commands {
  ping: { args: NoArgs; reply: PingReply };
  whoami: { args: NoArgs; reply: WhoamiReply };
  getSelection: { args: NoArgs; reply: SelectionEntry[] };
  listPages: { args: ListPagesArgs; reply: ListPagesReply };
  listChildren: { args: NodeArgs; reply: ListChildrenReply };
  listLibraries: { args: NoArgs; reply: ListLibrariesReply };
  exportFull: { args: ExportFullArgs; reply: FullExportReply };
  exportDesignSystem: { args: DesignSystemArgs; reply: DesignSystemReply };
  exportLibrary: { args: ExportLibraryArgs; reply: DesignSystemReply };
  exportSelection: { args: ReadOptArgs; reply: ScreenReply };
  exportNode: { args: ExportNodeArgs; reply: ScreenReply };
  screenshot: { args: ScreenshotArgs; reply: ScreenshotReply };
  write: { args: WriteArgs; reply: WriteResult };
}

export type Cmd = keyof Commands;
export type CmdArgs<C extends Cmd> = Commands[C]["args"];
export type CmdReply<C extends Cmd> = Commands[C]["reply"];

/** A command with its arguments, as a discriminated union — `switch (req.cmd)` narrows `req.args`. */
export type CommandRequest = { [C in Cmd]: { cmd: C; args: Commands[C]["args"] } }[Cmd];

// The runtime twin of `Cmd`. A Record keyed by the union is checked both ways by the compiler: a
// command added to `Commands` without a row here fails to compile, and so does a stray row.
const COMMAND_SET: Record<Cmd, true> = {
  ping: true,
  whoami: true,
  getSelection: true,
  listPages: true,
  listChildren: true,
  listLibraries: true,
  exportFull: true,
  exportDesignSystem: true,
  exportLibrary: true,
  exportSelection: true,
  exportNode: true,
  screenshot: true,
  write: true,
};

export function isCmd(x: string): x is Cmd {
  return Object.prototype.hasOwnProperty.call(COMMAND_SET, x);
}

/** Every command name, in declaration order. */
export const COMMANDS: readonly Cmd[] = Object.keys(COMMAND_SET).filter(isCmd);

// ---------------------------------------------------------------- reply shape checks

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Each check names the FIRST thing wrong, in the caller's vocabulary ("`pages` is not an array"), so
// the message that reaches a user says what the plugin sent instead of what the reader tripped over.
// Deliberately light — the required top-level fields and their kind — the documents inside are the
// producer's contract (doc-types.ts), not re-validated here.
type Field = [name: string, kind: "string" | "number" | "boolean" | "array" | "object"];

function fields(r: unknown, spec: Field[]): string | null {
  if (!isRecord(r)) return "not an object";
  for (const [name, kind] of spec) {
    const v = r[name];
    const bad =
      kind === "array" ? !Array.isArray(v)
      : kind === "object" ? !isRecord(v)
      : typeof v !== kind;
    if (bad) return v === undefined ? `\`${name}\` is missing` : `\`${name}\` is not ${kind === "array" ? "an array" : kind === "object" ? "an object" : "a " + kind}`;
  }
  return null;
}

const REPLY_CHECKS: { [C in Cmd]: (r: unknown) => string | null } = {
  ping: (r) => (isRecord(r) && r.pong === true ? null : isRecord(r) ? "`pong` is not true" : "not an object"),
  whoami: (r) => fields(r, [["instanceId", "string"], ["file", "string"]]),
  getSelection: (r) => (Array.isArray(r) ? null : "not an array"),
  listPages: (r) => fields(r, [["pages", "array"], ["manifest", "object"]]),
  listChildren: (r) => fields(r, [["id", "string"], ["children", "array"], ["manifest", "object"]]),
  listLibraries: (r) => fields(r, [["libraries", "array"], ["warnings", "array"]]),
  exportFull: (r) => fields(r, [["designSystem", "object"], ["layersDoc", "object"], ["assets", "array"]]),
  exportDesignSystem: (r) => fields(r, [["designSystem", "object"]]),
  exportLibrary: (r) => fields(r, [["designSystem", "object"]]),
  exportSelection: (r) => fields(r, [["screenName", "string"], ["screen", "object"], ["assets", "array"]]),
  exportNode: (r) => fields(r, [["screenName", "string"], ["screen", "object"], ["assets", "array"]]),
  screenshot: (r) => fields(r, [["id", "string"], ["reference", "string"], ["assets", "array"]]),
  write: (r) => fields(r, [["ok", "boolean"], ["applied", "array"]]),
};

/** What is structurally wrong with `reply` for `cmd`, or null when it has the shape `Commands[cmd]["reply"]` promises. */
export function replyShapeError(cmd: Cmd, reply: unknown): string | null {
  return REPLY_CHECKS[cmd](reply);
}
