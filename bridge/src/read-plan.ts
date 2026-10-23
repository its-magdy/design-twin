// read-plan.ts — what a front-end sends for one read: the command, its arguments, its time budget and the
// line that names it, or the read options that scope does not take.
//
// Both front-ends used to build these themselves — the CLI in exportCmd/screenshotCmd, the MCP server in
// each export tool — and each one restated the rules: which command a scope is, that an empty page list is
// no selector, that a catalog pull takes variantVisuals alone, which budget tier a scope gets (the CLI from
// one call, the MCP server from five spelled-out constants). One function now, so a scope, a tier or a
// read option reaches both at once. The route (route.ts) then carries the plan to the plugin.
//
// The rules it owns:
//   - the command per scope, and its arguments: every read option the scope takes is SAID, as a boolean, in
//     registry order — never left out. The plugin's autoCss resolves only an absent `css`, so leaving one out
//     would quietly switch CSS on for a small node; a decision the plan makes for every caller or none.
//   - `page` is sent only when the list is non-empty (an empty list is the current page, not a selector);
//     a blank entry IS sent, so collectFull warns about it. allPages with pages is sent as asked: collectFull
//     refuses it, one guard for every caller (the CLI also refuses it while reading its arguments).
//   - the refusal: a read option given as true to a scope whose row (read-opts.ts `scopes`) does not list it.
//     Returned as the option names, not a message: each front-end words it in its own terms.
//   - the budget: the scope's tier from TIMEOUTS, or the caller's override (the CLI's --timeout).
//
// Pure and side-effect free: figma-pull.ts and figma-mcp.ts import it at module level.
import { READ_OPT_ROWS } from "./read-opts.ts";
import { TIMEOUTS } from "./timeouts.ts";
import { ifDefined } from "./json-util.ts";
import type { ReadOptName, ReadOptRow, ReadScopeKind } from "./read-opts.ts";
import type { Commands } from "./commands.ts";

export type { ReadScopeKind } from "./read-opts.ts";

/** One read: a scope and what it needs to name its target. */
export type ReadScope =
  | { kind: "node"; nodeId: string }
  | { kind: "selection" }
  /** `pages` empty and `allPages` false: the current page. */
  | { kind: "pages"; allPages: boolean; pages: readonly string[] }
  | { kind: "designSystem" }
  | { kind: "library"; name: string }
  | { kind: "screenshot"; nodeId: string; scale?: number | undefined };

/** Read options as a caller has them: true asks, false or absent does not. Extra keys are ignored. */
export type ReadOptsGiven = Partial<Record<ReadOptName, boolean | undefined>>;

export type ReadCmd = "exportNode" | "exportSelection" | "exportFull" | "exportDesignSystem" | "exportLibrary" | "screenshot";
export interface PlanOf<C extends ReadCmd> {
  cmd: C;
  args: Commands[C]["args"];
  /** The request's budget in ms. */
  timeout: number;
  /** What is being read, for a log line ("node 1:2", "page(s) A, B", "design system only", …). */
  label: string;
}
export type ReadPlan = { [C in ReadCmd]: PlanOf<C> }[ReadCmd];
/** The read options given to a scope that does not take them, in registry order. */
export interface ReadRefusal { refused: ReadOptName[]; scope: ReadScopeKind }

/** The registry rows a scope takes, in registry order. */
export function readOptsFor(kind: ReadScopeKind): ReadOptRow[] {
  return READ_OPT_ROWS.filter((o) => o.scopes.includes(kind));
}

// The scope -> tier rule. A selection is small by construction; the whole file is the long walk; every other
// read (one node, a page or a few, a catalog, one screenshot) is an export's.
function tier(scope: ReadScope): number {
  if (scope.kind === "selection") return TIMEOUTS.selection;
  if (scope.kind === "pages" && scope.allPages) return TIMEOUTS.exportAll;
  return TIMEOUTS.export;
}

function label(scope: ReadScope): string {
  switch (scope.kind) {
    case "node": return `node ${scope.nodeId}`;
    case "selection": return "selection";
    case "pages": return scope.allPages ? "all pages" : scope.pages.length ? `page(s) ${scope.pages.join(", ")}` : "current page";
    case "designSystem": return "design system only";
    case "library": return `library "${scope.name}"`;
    case "screenshot": return `screenshot of ${scope.nodeId}`;
  }
}

/** Every read option the scope takes, as a boolean, in registry order. */
function optsFor(kind: ReadScopeKind, given: ReadOptsGiven): Partial<Record<ReadOptName, boolean>> {
  const o: Partial<Record<ReadOptName, boolean>> = {};
  for (const { name } of readOptsFor(kind)) o[name] = given[name] === true;
  return o;
}

export function planRead(scope: Extract<ReadScope, { kind: "screenshot" }>, given?: ReadOptsGiven, o?: { timeoutMs?: number | undefined }): PlanOf<"screenshot"> | ReadRefusal;
export function planRead(scope: ReadScope, given?: ReadOptsGiven, o?: { timeoutMs?: number | undefined }): ReadPlan | ReadRefusal;
export function planRead(scope: ReadScope, given: ReadOptsGiven = {}, o: { timeoutMs?: number | undefined } = {}): ReadPlan | ReadRefusal {
  const refused = READ_OPT_ROWS.filter((d) => given[d.name] === true && !d.scopes.includes(scope.kind)).map((d) => d.name);
  if (refused.length) return { refused, scope: scope.kind };
  const timeout = o.timeoutMs ?? tier(scope);
  const at = { timeout, label: label(scope) };
  const opts = optsFor(scope.kind, given);
  switch (scope.kind) {
    case "node": return { cmd: "exportNode", args: { nodeId: scope.nodeId, ...opts }, ...at };
    case "selection": return { cmd: "exportSelection", args: opts, ...at };
    case "pages": return { cmd: "exportFull", args: { allPages: scope.allPages, ...(scope.pages.length ? { page: [...scope.pages] } : {}), ...opts }, ...at };
    case "designSystem": return { cmd: "exportDesignSystem", args: opts, ...at };
    case "library": return { cmd: "exportLibrary", args: { asLibrary: scope.name, ...opts }, ...at };
    // A screenshot's row set is empty, so `opts` is too: it renders a PNG and walks nothing.
    case "screenshot": return { cmd: "screenshot", args: { nodeId: scope.nodeId, ...ifDefined("scale", scope.scale) }, ...at };
  }
}
