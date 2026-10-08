// commands.ts — THE bridge command/reply contract: every command the plugin's `handleBridge`
// (figma-plugin/src/bridge.ts) accepts, with the argument shape each one reads and the reply shape
// each one returns. Both sides derive from this one map:
//   - the plugin dispatches on `Cmd` (an exhaustive switch — a command added here without a handler
//     fails to compile there);
//   - server-core.ts / daemon.ts / figma-mcp.ts / figma-pull.ts type `request()` per command, so a
//     caller cannot name a reply type the plugin never sends (a hand-mirror of `IndexReply`/`WhoamiReply`
//     was stale once already: an `r.frames` the plugin never produced);
//   - `replyShapeError` is the ONE structural check a reply passes at the point it enters the Node
//     process (server-core.ts), so a plugin answering the wrong shape is a named error, not a
//     TypeError three modules later;
//   - `parseCommandRequest` is its twin on the way IN: the plugin's `handleBridge` narrows the wire's
//     `{ cmd, args }` to a `CommandRequest` through it, so no collector is handed an args shape that
//     was only asserted.
//
// Dependency-free apart from read-opts.ts (itself dependency-free) and type imports: the plugin bundle imports it too, so it
// must type-check under figma-plugin/tsconfig.json (ES2019 lib, no Node types). Reply shapes that ARE
// documents on disk (ScreenExport, LayersDoc, DesignSystemDoc, VariablesDoc, Manifest, Asset) are
// referenced from doc-types.ts, never restated.
import type { Asset, DesignSystemDoc, LayersDoc, Manifest, ScreenExport, VariablesDoc } from "./doc-types.ts";
import { READ_OPTS, type ReadOptName } from "./read-opts.ts";

// ---------------------------------------------------------------- arguments

/** The opt-in read options (read-opts.ts registry), as every walking export accepts them. */
export type ReadOptArgs = Partial<Record<ReadOptName, boolean>>;
/** A command that reads nothing from `args` (`{}` on the wire). */
export type NoArgs = Record<never, never>;

export interface ListPagesArgs {
  /** 1 = page names only (loads nothing); 2 = pages + their top-level layers (the default). Named after
   *  the REST API's `depth` query parameter on GET /v1/files/:key ("Positive integer representing how
   *  deep into the document tree to traverse" — https://developers.figma.com/docs/rest-api/file-endpoints/),
   *  where depth 1 returns pages only and depth 2 pages and their top-level objects. The Plugin API has
   *  no such parameter; collect.ts listPages implements the two levels itself. */
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
  /** Render scale override (default: auto, capped at 2048px on the longest side). Becomes the `value` of
   *  the `{ type: "SCALE", value }` ExportSettingsConstraints passed as ExportSettingsImage.constraint to
   *  exportAsync (assets.ts collectReference) — plugin-api.d.ts: `"SCALE"`: "The size of the exported
   *  image is proportional to the size of the exported layer in Figma. A `value` of 1 means the export
   *  is 100% of the layer size." (https://developers.figma.com/docs/plugins/api/ExportSettings). A value
   *  <= 0 falls back to the default there, as it always has. */
  scale?: number;
}

/** The four write ops figma-plugin/src/writes.ts implements. */
export type WriteOpName = "createFrame" | "createText" | "setFill" | "setText";
/** One write op (writes.ts WriteOp, mirrored): only the fields each op actually reads. Every optional
 *  field admits `undefined` because figma_write hands over its Zod-parsed ops as-is, and Zod types an
 *  `.optional()` field as `T | undefined`; the plugin reads an undefined field exactly as an absent one. */
export interface WriteOp {
  op: WriteOpName;
  parentId?: string | undefined;
  name?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  layoutMode?: "HORIZONTAL" | "VERTICAL" | undefined;
  itemSpacing?: number | undefined;
  padding?: [number, number, number, number] | undefined;
  fill?: string | undefined;
  text?: string | undefined;
  fontSize?: number | undefined;
  nodeId?: string | undefined;
  color?: string | undefined;
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
  /** number of direct children, when they are readable */
  childCount?: number;
  /** first-visible-text title, only on rows that share name + size with another row of the same listing */
  title?: string;
  /** colliding rows whose titles do not tell them apart — ≤ 3 texts this row shows and its twins do not */
  distinctTexts?: string[];
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
  /** the node's width/height and the render scale the plugin used — absent from an older plugin. */
  w?: number;
  h?: number;
  scale?: number;
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

// ---------------------------------------------------------------- argument shape checks

/** What a node-scoped command answers when it has no node id. ONE string on purpose: the wire check
 *  below and the collectors (collect.ts, for their direct callers) both throw it, so a caller sees the
 *  same text whichever of them catches the omission. */
export const NO_NODE_ID = "No node id provided.";

// The argument twin of REPLY_CHECKS: each names the FIRST argument that does not have the type its
// `*Args` interface declares, or returns null. Two rules keep every call that worked before this
// check working:
//   - an UNDECLARED key is ignored, never refused. The collectors have only ever read the keys they
//     know (applyOpts walks runOpts' keys, listPages reads `depth`, autoCss spreads and reads `css`),
//     so an extra key — e.g. a read option sent to a catalog pull — has always been harmless.
//   - `undefined` is "absent" (JSON drops it on the wire; in-process callers pass it for "default").
// `null` is NOT "absent" for an optional key (no typed sender produces it) — except `nodeId`, where the
// collectors have always mapped null to NO_NODE_ID, and that answer is kept.
type ArgsCheck = (a: Record<string, unknown>) => string | null;

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number";

/** `key` is absent or passes `ok`. `what` completes "`label` is not …" (`label` defaults to `key`). */
function opt(a: Record<string, unknown>, key: string, ok: (v: unknown) => boolean, what: string, label: string = key): string | null {
  const v = a[key];
  return v === undefined || ok(v) ? null : `\`${label}\` is not ${what}`;
}
/** The first non-null of a list of checks, or null. */
function first(errs: Array<string | null>): string | null {
  for (const e of errs) if (e !== null) return e;
  return null;
}

const READ_OPT_NAMES: readonly ReadOptName[] = READ_OPTS.map((o) => o.name);
const readOptArgs: ArgsCheck = (a) => first(READ_OPT_NAMES.map((k) => opt(a, k, isBool, "a boolean")));
const nodeArgs: ArgsCheck = (a) =>
  a.nodeId === undefined || a.nodeId === null ? NO_NODE_ID : isStr(a.nodeId) ? null : "`nodeId` is not a string";
const designSystemArgs: ArgsCheck = (a) => opt(a, "variantVisuals", isBool, "a boolean");
const isPageSel = (v: unknown): boolean => isStr(v) || (Array.isArray(v) && v.every(isStr));

// A Record keyed by the union, like COMMAND_SET: an op added to WriteOpName without a row fails to compile.
const WRITE_OP_SET: Record<WriteOpName, true> = { createFrame: true, createText: true, setFill: true, setText: true };
const isWriteOpName = (v: unknown): boolean => isStr(v) && Object.prototype.hasOwnProperty.call(WRITE_OP_SET, v);
const isPadding = (v: unknown): boolean => Array.isArray(v) && v.length === 4 && v.every(isNum);
const WRITE_STR_FIELDS = ["parentId", "name", "fill", "text", "nodeId", "color"];
const WRITE_NUM_FIELDS = ["width", "height", "itemSpacing", "fontSize"];
/** Op `i` of a write batch against WriteOp: `op` names one of the four ops, every other declared field has its type. */
function writeOpError(o: unknown, i: number): string | null {
  const at = `ops[${i}]`;
  if (!isRecord(o)) return `\`${at}\` is not an object`;
  if (!isWriteOpName(o.op)) return `\`${at}.op\` is not one of ${Object.keys(WRITE_OP_SET).join(" | ")}`;
  return first([
    ...WRITE_STR_FIELDS.map((k) => opt(o, k, isStr, "a string", `${at}.${k}`)),
    ...WRITE_NUM_FIELDS.map((k) => opt(o, k, isNum, "a number", `${at}.${k}`)),
    opt(o, "layoutMode", (v) => v === "HORIZONTAL" || v === "VERTICAL", "HORIZONTAL or VERTICAL", `${at}.layoutMode`),
    opt(o, "padding", isPadding, "four numbers", `${at}.padding`),
  ]);
}
const writeArgs: ArgsCheck = (a) => {
  if (!Array.isArray(a.ops)) return a.ops === undefined ? "`ops` is missing" : "`ops` is not an array";
  return first(a.ops.map(writeOpError));
};

/** NoArgs: nothing is read, so nothing can be wrong (see the undeclared-key rule above). */
const noArgs: ArgsCheck = () => null;

const ARGS_CHECKS: { [C in Cmd]: ArgsCheck } = {
  ping: noArgs,
  whoami: noArgs,
  getSelection: noArgs,
  listPages: (a) => opt(a, "depth", (v) => v === 1 || v === 2, "1 or 2"),
  listChildren: nodeArgs,
  listLibraries: noArgs,
  exportFull: (a) => first([readOptArgs(a), opt(a, "allPages", isBool, "a boolean"), opt(a, "page", isPageSel, "a string or an array of strings")]),
  exportDesignSystem: designSystemArgs,
  exportLibrary: (a) => first([designSystemArgs(a), opt(a, "asLibrary", isStr, "a string")]),
  exportSelection: readOptArgs,
  exportNode: (a) => first([nodeArgs(a), readOptArgs(a)]),
  screenshot: (a) => first([nodeArgs(a), opt(a, "scale", isNum, "a number")]),
  write: writeArgs,
};

/** What is wrong with `args` for `cmd` — the text a caller sees — or null when it has the shape
 *  `Commands[cmd]["args"]` declares. A missing node id reads NO_NODE_ID verbatim (what the collectors
 *  answered before this check existed); anything else names the command it was sent to. */
export function argsShapeError(cmd: Cmd, args: unknown): string | null {
  if (!isRecord(args)) return `bad ${cmd} args: not an object`;
  const e = ARGS_CHECKS[cmd](args);
  return e === null || e === NO_NODE_ID ? e : `bad ${cmd} args: ${e}`;
}

/** The type-level face of ARGS_CHECKS (a predicate cannot be read off a table of `string | null`). */
function hasArgs<C extends Cmd>(cmd: C, a: Record<string, unknown>): a is Record<string, unknown> & Commands[C]["args"] {
  return ARGS_CHECKS[cmd](a) === null;
}

export type ParsedRequest = { ok: true; req: CommandRequest } | { ok: false; error: string };

/**
 * The wire's `{ cmd, args }` as a `CommandRequest`, or the error to answer with. `args` that is not an
 * object (absent, null, an array) reads as `{}` — what handleBridge has always done — so an
 * argument-less command keeps working whatever its sender put there, and a node-scoped one answers
 * NO_NODE_ID. A switch rather than a table lookup because it is what lets each branch build its own
 * `{ cmd, args }` member without an assertion: inside `case "x"` both `cmd` and (after the predicate)
 * `a` have that command's types.
 */
export function parseCommandRequest(cmd: string, args: unknown): ParsedRequest {
  if (!isCmd(cmd)) return { ok: false, error: "unknown cmd: " + cmd };
  const a: Record<string, unknown> = isRecord(args) ? args : {};
  const bad = (): ParsedRequest => ({ ok: false, error: argsShapeError(cmd, a) ?? `bad ${cmd} args` });
  switch (cmd) {
    case "ping": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "whoami": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "getSelection": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "listPages": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "listChildren": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "listLibraries": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "exportFull": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "exportDesignSystem": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "exportLibrary": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "exportSelection": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "exportNode": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "screenshot": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    case "write": return hasArgs(cmd, a) ? { ok: true, req: { cmd, args: a } } : bad();
    default: {
      // Exhaustive: a command added to `Commands` without a case here fails to compile.
      const exhaustive: never = cmd;
      return { ok: false, error: "unknown cmd: " + String(exhaustive) };
    }
  }
}
