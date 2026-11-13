// commands.ts — THE bridge command/reply contract: every command the plugin's `handleBridge`
// (figma-plugin/src/bridge.ts) accepts, with the argument shape each one reads and the reply shape
// each one returns. Both sides derive from this one map:
//   - the plugin dispatches on `Cmd` (an exhaustive switch — a command added here without a handler
//     fails to compile there);
//   - server-core.ts / daemon.ts / figma-mcp.ts / figma-pull.ts type `request()` per command, so a
//     caller cannot name a reply type the plugin never sends (a hand-mirror of `IndexReply`/`WhoamiReply`
//     was stale once already: an `r.frames` the plugin never produced);
//   - `replyShapeError` is the ONE structural check a reply passes at the point it enters the bridge
//     process (server-core.ts), so a plugin answering the wrong shape is a named error, not a
//     TypeError three modules later;
//   - `parseCommandRequest` is its twin on the way IN: the plugin's `handleBridge` narrows the wire's
//     `{ cmd, args }` to a `CommandRequest` through it, so no collector is handed an args shape that
//     was only asserted;
//   - the run traits (`runKind` / `isExportCmd`): which commands may run alongside which — the plugin's
//     scheduler orders every run from them, and the bridge side reads `export` for its stall check,
//     progress ticks and read plans.
//
// Dependency-free apart from read-opts.ts, tree-spec.ts and patch-spec.ts (all pure) and type imports: the plugin bundle imports it too, so it
// must type-check under figma-plugin/tsconfig.json (ES2019 lib, no Node types). Reply shapes that ARE
// documents on disk (ScreenExport, LayersDoc, DesignSystemDoc, VariablesDoc, Manifest, Asset) are
// referenced from doc-types.ts, never restated.
import type { Asset, DesignSystemDoc, LayersDoc, Manifest, ScreenExport, VariablesDoc } from "./doc-types.ts";
import { isRecord } from "./json-util.ts";
import { READ_OPTS, type ReadOptName } from "./read-opts.ts";
import { checkPatch, describePatch, isPatchSet, patchRefusal, patchRows, type PatchRow, type PatchSet } from "./patch-spec.ts";
import { checkTree, describeTree, isTreeSpec, treeRefusal, type TreeNodeSpec } from "./tree-spec.ts";

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

/** The write ops figma-plugin/src/writes.ts implements (figma_write's Zod enum reads this list). */
export const WRITE_OP_NAMES = ["createFrame", "createText", "setFill", "setText", "setVariableMode", "clearVariableMode", "createTree", "patch", "move", "delete"] as const;
export type WriteOpName = (typeof WRITE_OP_NAMES)[number];
/** One write op (writes.ts applyWrite imports it): only the fields each op actually reads. Every optional
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
  /** setVariableMode / clearVariableMode: a variable collection's name, or its exact id or key */
  collection?: string | undefined;
  /** setVariableMode: a mode's name within `collection`, or its exact modeId */
  mode?: string | undefined;
  /** createTree: the whole screen, one nested spec in the read export's field names (tree-spec.ts). Typed loosely
   *  on the wire: tree-spec.ts checkTree is what narrows it, at all three readers of WRITE_OPS. */
  tree?: TreeNodeSpec | Record<string, unknown> | undefined;
  /** createTree: the page the new frame lands on — its exact name or id (the current page when absent) */
  page?: string | undefined;
  /** patch: the fields to change on node `nodeId`, in the read export's field names (patch-spec.ts). Typed loosely on
   *  the wire, like `tree`: patch-spec.ts checkPatch narrows it, at all three readers of WRITE_OPS. */
  set?: PatchSet | Record<string, unknown> | undefined;
  /** move: the place among the new parent's children (0 = first; the end when absent) */
  index?: number | undefined;
}
export interface WriteArgs {
  ops: WriteOp[];
}

/** A WriteOp field that holds a string. */
type WriteStrField = "parentId" | "name" | "fill" | "text" | "nodeId" | "color" | "collection" | "mode" | "page";
/** A WriteOp field an op can require: the string fields, createTree's spec and a patch's fields. */
type WriteField = WriteStrField | "tree" | "set";
/** What each write op IS, in one row — read by figma_write's dry run (writeOpPreview), the wire check
 *  (writeOpError — the gate a `write` command passes in the plugin's handleBridge, via parseCommandRequest, before
 *  writes.ts applyWrites runs; applyWrites repeats it for its direct callers). So a batch the preview calls invalid
 *  is one the plugin refuses before it touches the file, never one it half-applies. */
interface WriteOpRow {
  /** creates = additive (a new node); overwrites = replaces a property on a node the user already has; moves =
   *  reparents a node this plugin session created; deletes = removes one. */
  effect: WriteEffect;
  /** The fields the op cannot run without. */
  required: readonly WriteField[];
  /** The new value the preview shows, by preview key, and the op field it is read from. `newMode: INHERITED` is
   *  the value itself: the op puts the node back on the mode it inherits. */
  shows: { newFill?: WriteStrField; newText?: WriteStrField; collection?: WriteStrField; newMode?: WriteStrField | typeof INHERITED };
}
/** What an op does to the file, as the dry run counts it. */
export type WriteEffect = "creates" | "overwrites" | "moves" | "deletes";
/** What a node's mode for a collection is when none is set on it explicitly: whatever its parent resolves to. */
export const INHERITED = "inherited";
// A Record keyed by the union, like COMMAND_SET: an op added to WRITE_OP_NAMES without a row fails to compile.
export const WRITE_OPS: { readonly [K in WriteOpName]: WriteOpRow } = {
  createFrame: { effect: "creates", required: [], shows: {} },
  createText: { effect: "creates", required: ["text"], shows: { newText: "text" } },
  setFill: { effect: "overwrites", required: ["nodeId", "color"], shows: { newFill: "color" } },
  setText: { effect: "overwrites", required: ["nodeId", "text"], shows: { newText: "text" } },
  setVariableMode: { effect: "overwrites", required: ["nodeId", "collection", "mode"], shows: { collection: "collection", newMode: "mode" } },
  clearVariableMode: { effect: "overwrites", required: ["nodeId", "collection"], shows: { collection: "collection", newMode: INHERITED } },
  createTree: { effect: "creates", required: ["tree"], shows: {} },
  patch: { effect: "overwrites", required: ["nodeId", "set"], shows: {} },
  move: { effect: "moves", required: ["nodeId", "parentId"], shows: {} },
  delete: { effect: "deletes", required: ["nodeId"], shows: {} },
};

/** The fields op `op` requires that `fields` lacks (an undefined field is absent: see WriteOp). */
export function missingWriteFields(op: WriteOpName, fields: Partial<Record<WriteField, unknown>>): WriteField[] {
  return WRITE_OPS[op].required.filter((k) => fields[k] === undefined);
}

/** One step of figma_write's dry run: what op `index` would do, without doing it. */
export interface WritePreviewStep {
  index: number;
  op: WriteOpName;
  effect: WriteEffect;
  /** the node an overwrite changes (null when the op names none); where a create lands */
  target: string | null;
  newFill?: string | undefined;
  newText?: string | undefined;
  /** setVariableMode / clearVariableMode: the collection, the mode it is set to ("inherited" when cleared), and the
   *  change in one sentence. The current mode is in the file, which the preview does not read: the reply names it. */
  collection?: string | undefined;
  newMode?: string | undefined;
  change?: string;
  /** createTree: what the spec has no effect on (x/y inside auto-layout, …) */
  warnings?: string[];
  /** patch: one row per field it sets, with the value it gets */
  fields?: PatchRow[];
  /** "missing <fields>", or every problem with a createTree spec — the plugin refuses the batch up front for the same reason */
  invalid?: string;
}
export function writeOpPreview(o: WriteOp, index: number): WritePreviewStep {
  const row = WRITE_OPS[o.op];
  const creates = row.effect === "creates";
  const missing = missingWriteFields(o.op, o);
  if (o.op === "createTree") return treePreview(o, index, missing);
  if (o.op === "patch") return patchPreview(o, index, missing);
  if (o.op === "move" || o.op === "delete") return structurePreview(o, index, missing);
  return {
    index,
    op: o.op,
    effect: row.effect,
    target: creates ? (o.parentId ? `new node under ${o.parentId}` : "new node on the current page") : o.nodeId || null,
    ...(row.shows.newFill ? { newFill: o[row.shows.newFill] } : {}),
    ...(row.shows.newText ? { newText: o[row.shows.newText] } : {}),
    ...(row.shows.collection ? { collection: o[row.shows.collection] } : {}),
    ...(row.shows.newMode ? modeChange(o, row.shows.newMode) : {}),
    ...(missing.length ? { invalid: `missing ${missing.join(", ")}` } : {}),
  };
}

/** A createTree op's preview: where the frame lands, what it makes in one sentence, and — for a spec the plugin would
 *  refuse — every problem (the same list writeOpError refuses with). */
function treePreview(o: WriteOp, index: number, missing: readonly string[]): WritePreviewStep {
  const base = { index, op: o.op, effect: "creates" as const, target: o.page ? `new frame on page '${o.page}'` : "new frame on the current page" };
  if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
  const { problems, summary } = checkTree(o.tree);
  if (problems.length || !isTreeSpec(o.tree)) return { ...base, invalid: problems.join("\n") };
  return { ...base, change: describeTree(o.tree, o.page, summary), ...(summary.warnings.length ? { warnings: summary.warnings } : {}) };
}

/** A patch op's preview: the node, one row per field it sets, the change in one sentence — or every problem. */
function patchPreview(o: WriteOp, index: number, missing: readonly string[]): WritePreviewStep {
  const base = { index, op: o.op, effect: "overwrites" as const, target: o.nodeId || null };
  if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
  const { problems, summary } = checkPatch(o.set);
  if (problems.length || !isPatchSet(o.set)) return { ...base, invalid: problems.join("\n") };
  return { ...base, fields: patchRows(o.set, summary), change: describePatch(o.nodeId, summary) };
}

/** A move or delete op's preview: the change in one sentence. Whether the node was created this session is checked
 *  by the plugin (the preview reads no file). */
function structurePreview(o: WriteOp, index: number, missing: readonly string[]): WritePreviewStep {
  const base = { index, op: o.op, effect: WRITE_OPS[o.op].effect, target: o.nodeId || null };
  if (missing.length) return { ...base, invalid: `missing ${missing.join(", ")}` };
  const only = " — only a node this plugin session created (checked when applied)";
  const change = o.op === "delete"
    ? `deletes node ${o.nodeId} and everything inside it${only}; deletes run after every other op of the batch has landed`
    : `moves node ${o.nodeId} into ${o.parentId}${o.index !== undefined ? ` at index ${o.index}` : " as its last child"}${only}; put back if a later op fails`;
  return { ...base, change };
}

/** A mode op's preview fields: the new mode and the plain sentence of what changes. */
function modeChange(o: WriteOp, shows: WriteStrField | typeof INHERITED): { newMode: string | undefined; change: string } {
  const newMode = shows === INHERITED ? INHERITED : o[shows];
  const node = `node ${o.nodeId || "?"}`, coll = `'${o.collection || "?"}'`;
  // The op decides (clear vs set), never the mode's name: a mode can itself be called "inherited".
  const change = shows === INHERITED
    ? `${node}: the ${coll} variable mode goes from its current mode to inherited (whatever its parent uses)`
    : `${node}: the ${coll} variable mode goes from its current mode to '${newMode || "?"}'`;
  return { newMode, change: change + " — the reply names the mode it replaced; the names are checked against the file when applied" };
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
  /** Whether the designer has ticked "Allow edits" in the plugin window (edits.ts). Absent from a plugin
   *  built before the opt-in existed — which applies every write it is sent. */
  editsAllowed?: boolean;
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
  /** what the row's counts do and do not mean; the plugin sets it on every row */
  note: string;
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

/** One applied write op: the id of the node it created, changed, moved or deleted (writes.ts applyWrite). A variable-mode op also
 *  names the collection and the mode before and after (by name; "inherited" when no mode was set on the node). */
export interface AppliedWrite {
  id?: string;
  /** createTree: how many nodes the tree made (`instances` only when it made any) */
  created?: { frames: number; texts: number; instances?: number };
  /** createTree / patch: the raw values where a variable or text style could stand (colours, spacing, radii, stroke
   *  weights, a tree's texts without a style); absent when none */
  unbound?: number;
  /** createTree: the id of each node the spec gave a `handle`, by handle (absent when none did) */
  handles?: Record<string, string>;
  collection?: string;
  from?: string;
  to?: string;
  /** move: the node's new parent */
  parentId?: string;
  /** delete: the node is gone */
  deleted?: true;
}
/** Why a whole batch was refused before any op ran — the one refusal a caller must hand to the PERSON at
 *  the Figma window rather than fix itself. `edits-off`: the designer has not ticked "Allow edits"
 *  (figma-plugin/src/edits.ts); nothing in the file changed. */
export type WriteRefusal = "edits-off";
/** The sentence a refused `edits-off` batch carries as `error`, and what figma_write shows the agent. */
export const EDITS_OFF_MESSAGE =
  "Edits are off in the Design Twin plugin — tick 'Allow edits' in the plugin window, then retry. Nothing in the file was changed.";
/** writes.ts applyWrites' reply: `ok: false` on a partial failure, with what was applied before it. A batch
 *  refused whole carries `refused` (and no `failedAt`: no op was tried); one stopped partway because the designer
 *  unticked "Allow edits" carries `refused` AND `failedAt`, with the applied prefix. */
export interface WriteResult {
  ok: boolean;
  applied: AppliedWrite[];
  failedAt?: number;
  failedOp?: string;
  error?: string;
  refused?: WriteRefusal;
  /** On a failure: the changes earlier in the batch that were undone — values put back as they were, nodes the batch
   *  created removed, moved nodes back where they were (they are not in `applied`). Absent when there were none, and
   *  when the batch stopped because edits were turned off. */
  restored?: AppliedWrite[];
  /** What the batch accepted but had no effect (a createTree spec's x/y inside auto-layout, …). Absent when none. */
  warnings?: string[];
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

/** A command with its arguments, as a discriminated union — `switch (req.cmd)` narrows `req.args`. */
export type CommandRequest = { [C in Cmd]: { cmd: C; args: Commands[C]["args"] } }[Cmd];

// ---------------------------------------------------------------- run traits

/**
 * How a command runs in the plugin relative to every other run in that file — the ONE rule, enforced by the
 * plugin's run scheduler (figma-plugin/src/state.ts scheduleRun) for every caller alike: a CLI or MCP request
 * through any bridge, and the plugin window's own export buttons.
 *   - exclusive: mutates the plugin's shared per-run state (assets, stats, warnings, memo caches) or the
 *     document. Runs alone, in arrival order, bracketed as a run (the window shows it; it can be cancelled).
 *   - scene: reads scene nodes and mutates nothing, but must not overlap an exclusive run. An export's
 *     catalogue walk holds figma.skipInvisibleInstanceChildren on across its awaits; a listing inside that
 *     window silently omits hidden layers of instances (listLibraries also toggles the flag itself), and
 *     getSelection's reads of a selected hidden instance layer throw (Plugin API docs,
 *     figma.skipInvisibleInstanceChildren). So it waits its turn on the same chain, but is not bracketed: it
 *     takes milliseconds, and the window has no export to show for it.
 *   - identity: reads only figma.root / figma.currentPage — no node walk. Answers at once, DURING an export:
 *     "is that file still there, and which file is it?" must not wait out a 12-minute pull.
 */
export type RunKind = "exclusive" | "scene" | "identity";

export interface CommandTraits {
  run: RunKind;
  /** Walks a tree into an export (a reply write-out.ts lands on disk) and can run for minutes: the commands a
   *  one-shot bridge's stall check and progress ticks are for (route.ts), and a read plan can send (read-plan.ts). */
  export: boolean;
}

// The runtime twin of `Cmd`, carrying each command's traits. `satisfies` a Record keyed by the union, so the
// compiler checks it both ways (a command added to `Commands` without a row here fails to compile, and so does a
// stray row) while keeping each row's literal types for ExportCmd below.
const COMMAND_TRAITS = {
  ping: { run: "identity", export: false },
  whoami: { run: "identity", export: false },
  getSelection: { run: "scene", export: false },
  listPages: { run: "scene", export: false },
  listChildren: { run: "scene", export: false },
  listLibraries: { run: "scene", export: false },
  exportFull: { run: "exclusive", export: true },
  exportDesignSystem: { run: "exclusive", export: true },
  exportLibrary: { run: "exclusive", export: true },
  exportSelection: { run: "exclusive", export: true },
  exportNode: { run: "exclusive", export: true },
  screenshot: { run: "exclusive", export: true },
  write: { run: "exclusive", export: false },
} as const satisfies Record<Cmd, CommandTraits>;

export function isCmd(x: string): x is Cmd {
  return Object.prototype.hasOwnProperty.call(COMMAND_TRAITS, x);
}

/** Every command name, in declaration order. */
export const COMMANDS: readonly Cmd[] = Object.keys(COMMAND_TRAITS).filter(isCmd);

/** The commands whose traits say `export: true`. */
export type ExportCmd = { [C in Cmd]: (typeof COMMAND_TRAITS)[C]["export"] extends true ? C : never }[Cmd];

/** How `cmd` runs relative to other runs in its file (RunKind). */
export function runKind(cmd: Cmd): RunKind {
  return COMMAND_TRAITS[cmd].run;
}

/** Is `cmd` a command whose traits say it is an export (any string: an unknown one is not). */
export function isExportCmd(cmd: string): cmd is ExportCmd {
  return isCmd(cmd) && COMMAND_TRAITS[cmd].export;
}

// ---------------------------------------------------------------- reply shape checks

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
//     know (Run.useReads walks the read-option names, listPages reads `depth`, autoCss spreads and reads `css`),
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

const isWriteOpName = (v: unknown): v is WriteOpName => isStr(v) && Object.prototype.hasOwnProperty.call(WRITE_OPS, v);
const isPadding = (v: unknown): boolean => Array.isArray(v) && v.length === 4 && v.every(isNum);
const WRITE_STR_FIELDS: readonly WriteStrField[] = ["parentId", "name", "fill", "text", "nodeId", "color", "collection", "mode", "page"];
const WRITE_NUM_FIELDS = ["width", "height", "itemSpacing", "fontSize"];
const isIndex = (v: unknown): boolean => isNum(v) && Number.isInteger(v) && v >= 0;
/** Op `i` of a write batch against WriteOp: `op` names one of the ops, every other declared field has its
 *  type, and the op's row in WRITE_OPS has every field it requires. The wire check (argsShapeError, which the
 *  plugin's handleBridge applies to every `write` before it runs) is this, and writes.ts applyWrites repeats it. */
export function writeOpError(o: unknown, i: number): string | null {
  const at = `ops[${i}]`;
  if (!isRecord(o)) return `\`${at}\` is not an object`;
  const op = o.op;
  if (!isWriteOpName(op)) return `\`${at}.op\` is not one of ${WRITE_OP_NAMES.join(" | ")}`;
  const typeErr = first([
    ...WRITE_STR_FIELDS.map((k) => opt(o, k, isStr, "a string", `${at}.${k}`)),
    ...WRITE_NUM_FIELDS.map((k) => opt(o, k, isNum, "a number", `${at}.${k}`)),
    opt(o, "layoutMode", (v) => v === "HORIZONTAL" || v === "VERTICAL", "HORIZONTAL or VERTICAL", `${at}.layoutMode`),
    opt(o, "padding", isPadding, "four numbers", `${at}.padding`),
    opt(o, "index", isIndex, "a whole number ≥ 0", `${at}.index`),
  ]);
  if (typeErr !== null) return typeErr;
  const missing = missingWriteFields(op, o);
  if (missing.length) return `\`${at}\` (${op}): missing ${missing.join(", ")}`;
  if (op === "createTree") {
    const { problems } = checkTree(o.tree);
    if (problems.length) return treeRefusal(problems.map((p) => p.replace(/^tree/, `${at}.tree`)));
  }
  if (op === "patch") {
    const { problems } = checkPatch(o.set, `${at}.set`);
    if (problems.length) return patchRefusal(problems);
  }
  return null;
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
  const bad = (): ParsedRequest => ({ ok: false, error: argsShapeError(cmd, a) || `bad ${cmd} args` });
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
