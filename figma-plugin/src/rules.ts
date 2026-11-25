// A bulk patch by rule (writes: patchWhere; docs/write-plane-spec.md decision 8): the layers a rule matches within its
// scope, each resolved as a patch of its own (patch.ts), so the batch checks, applies and puts back every one of them
// exactly as it would a patch by id.
//
// The rule (bridge/src/rule-spec.ts checkRule, run by the wire check and again by applyWrites) is answered here, against
// the file: the scope's pages load, its layers are walked in document order — never into an instance, a main component
// or a component set (their layers follow the main component) — and a layer matches when every kind the rule gives
// holds. A `variable` or `instanceOf` name resolves first, never guessed (decision 15): against the file's local
// variables and those its layers in scope are bound to, or the components its instances in scope are of.
//
// What the dry run and the review see of the matches is a RuleMatch: counts per page, a few samples, and a token for
// exactly these matches. A real run with more than RULE_TOKEN_MIN matches must carry the token, and one whose matches
// changed since is refused, as is one that matches nothing; once the designer approves (or previews) a batch that
// waited, the matches are counted again and must still be the ones its card showed (`expect`).
import type { WriteImpactStep, WriteOp } from "../../bridge/src/commands.ts";
import { isPatchSet } from "../../bridge/src/patch-spec.ts";
import { checkRule, describeScope, describeWhere, globMatch, MAX_RULE_MATCHES, RULE_SAMPLES, RULE_TOKEN_MIN, ruleToken, solidMatches, tokenCount, type CheckedRule, type RuleMatch } from "../../bridge/src/rule-spec.ts";
import { matchByName, quoteList } from "../../bridge/src/name-match.ts";
import { changesBefore, resolvePatchNode, type PatchTarget } from "./patch";
import { patchUses, resolveRefs, type RefResolution, type Use } from "./tree-refs";
import { boundVariableIds } from "./sources";
import { errMsg } from "./util";
import type { OpProblem } from "./write-batch";
import { goneAmong, goneFrom, inDocument, nodeById, removedWith } from "./node-lookup";

/** A patchWhere op whose rule matched and whose every match resolved as a patch. */
export interface RuleTarget {
  /** one resolved patch per matched layer, in document order */
  matches: PatchTarget[];
  match: RuleMatch;
  /** the matched layers' ids, in document order */
  ids: string[];
  /** scope "selection": the selected layers it looked in, by id — an approval looks in these again, whatever is selected
   *  by then (Show me and a preview change the selection) */
  selection?: string[];
}

/** What a card showed of a rule op: the token of its matches and, for scope "selection", the layers it looked in. */
export interface ShownRule { token: string; selection?: string[] }

/** This plugin session's own salt in every token (rule-spec.ts ruleToken): a token from another session or file is not
 *  one of these. Not a secret: it only tells this session's dry runs from any other's. */
const SESSION_SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);

/** A layer the rule matched, and its page. */
interface Hit { node: SceneNode; page: PageNode }

/** True when `n` is inside an instance, a main component or a component set (or is a main component or set itself). */
function inSource(n: BaseNode): boolean {
  for (let a: BaseNode | null = n; a && a.type !== "PAGE" && a.type !== "DOCUMENT"; a = a.parent) {
    if (a.type === "COMPONENT" || a.type === "COMPONENT_SET") return true;
    if (a !== n && a.type === "INSTANCE") return true;
  }
  return false;
}
const pageOf = (n: BaseNode): PageNode | null => {
  let p: BaseNode | null = n.parent;
  while (p && p.type !== "PAGE") p = p.parent;
  return p && p.type === "PAGE" ? p : null;
};
async function loadPage(p: PageNode): Promise<void> {
  if (typeof p.loadAsync === "function") await p.loadAsync(); // dynamic-page: before its layers are walked
}

/** The layers the scope holds, in document order, each once: what a rule is tested against. Problems go to `bad`. Each
 *  page load (and each selected layer's lookup) is an await the designer can delete a page or a layer at (node-lookup.ts):
 *  a page is checked once it loads, before its layers are read, and every layer once the last await is done. Gone, it
 *  is missing: no layers come back. */
async function layersIn(rule: CheckedRule, bad: (m: string) => void, selected?: readonly string[]): Promise<{ hits: Hit[]; selection?: string[] }> {
  const scoped = await scopeLayers(rule, bad, selected);
  return goneAmong(scoped.hits.map((h) => h.node), bad, "layer") ? { hits: [] } : scoped;
}
async function scopeLayers(rule: CheckedRule, bad: (m: string) => void, selected?: readonly string[]): Promise<{ hits: Hit[]; selection?: string[] }> {
  const out: Hit[] = [];
  const seen = new Set<string>();
  const walk = (n: SceneNode, page: PageNode): void => {
    if (n.type === "COMPONENT" || n.type === "COMPONENT_SET" || seen.has(n.id)) return;
    seen.add(n.id);
    out.push({ node: n, page });
    if (n.type === "INSTANCE") return;
    if ("children" in n) for (const k of n.children) walk(k, page);
  };
  const s = rule.scope;
  if (s === "selection") {
    // On approval: the layers that were selected when the card went up, wherever the selection is now.
    let sel: SceneNode[] = figma.currentPage.selection.slice();
    if (selected) {
      sel = [];
      for (const id of selected) {
        let n: BaseNode | null = null;
        try { n = await nodeById(id); } catch { n = null; }
        if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") sel.push(n);
      }
    }
    if (!sel.length) { bad("scope \"selection\": " + (selected ? "the selected layers it looked in are gone" : "nothing is selected in Figma — select the layers to look in, or use \"page\" or \"file\"")); return { hits: out }; }
    // Each looked up at an await: one found, then deleted at a later one's lookup, is missing, never read.
    if (goneAmong(sel, bad, "layer")) return { hits: out };
    for (const n of sel) if (!inSource(n)) walk(n, pageOf(n) || figma.currentPage);
    return { hits: out, selection: sel.map((n) => n.id) };
  }
  let pages: PageNode[];
  if (s === undefined || s === "page") pages = [figma.currentPage];
  else if (s === "file") pages = figma.root.children.slice();
  else {
    pages = [];
    const all = figma.root.children.slice();
    for (const ref of s) {
      const m = matchByName(ref, all, (p) => p.name, (p) => [p.id]);
      if (m.kind === "one") { if (pages.indexOf(m.item) < 0) pages.push(m.item); }
      else if (m.kind === "many") bad("scope: page '" + ref + "' matches " + m.matches.length + " pages — name one by id: " + m.matches.slice(0, 3).map((p) => "'" + p.name + "' (" + p.id + ")").join(", "));
      else bad("scope: no page is named '" + ref + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : ""));
    }
  }
  for (const p of pages) {
    // Deleted while an earlier page loaded, or as it loads: missing, never loaded or read (its fields throw).
    if (goneFrom(p, bad, "page")) continue;
    try { await loadPage(p); } catch (e) { if (!goneFrom(p, bad, "page")) bad("page '" + p.name + "' could not be read (" + errMsg(e) + ")"); continue; }
    if (goneFrom(p, bad, "page")) continue;
    for (const k of p.children) walk(k, p);
  }
  return { hits: out };
}

/** The main component an instance is of (null: none, or its lookup failed). */
async function mainOf(n: InstanceNode): Promise<ComponentNode | null> {
  try { return await n.getMainComponentAsync(); } catch { return null; }
}

/** The components an instance whose main component is `main` is of, as a rule may name them, read once every instance's
 *  lookup is done (a main found at one await can be deleted, detached or moved out of its set at a later one's): `live`,
 *  its main and the set it is a variant of now, when the main is in the document; `retained`, a main out of the document
 *  that the instance still returns, not removed (soft-deleted: Figma keeps it for its instances and an undo), which a
 *  rule names only by its exact id or key, never its name, and never by a set it was in; a removed one, neither (its
 *  fields throw when read). */
function ownersNow(main: ComponentNode | null): { live: Array<ComponentNode | ComponentSetNode>; retained: ComponentNode | null } {
  if (!main || removedWith(main)) return { live: [], retained: null };
  if (!inDocument(main)) return { live: [], retained: main };
  const set = main.parent;
  return { live: set && set.type === "COMPONENT_SET" ? [main, set] : [main], retained: null };
}

/** The layers of `layers` op `rule` matches, in document order. A `variable` or `instanceOf` name that matches nothing
 *  or several things goes to `bad` (and nothing matches). Resolving either name awaits: every layer is checked after
 *  those awaits, before the name is matched and any layer read again (node-lookup.ts); one gone is missing. */
async function matchesOf(rule: CheckedRule, layers: readonly Hit[], bad: (m: string) => void): Promise<Hit[]> {
  const w = rule.where;
  let variableId: string | null = null;
  if (w.variable !== undefined) {
    // The file's own variables, and every variable a layer in scope is bound to (a library's, by its name too).
    const pool = new Map<string, Variable>();
    for (const v of await figma.variables.getLocalVariablesAsync()) pool.set(v.id, v);
    const ids = new Set<string>();
    for (const h of layers) for (const id of boundVariableIds(h.node)) ids.add(id);
    for (const id of ids) {
      if (pool.has(id)) continue;
      let v: Variable | null = null;
      try { v = await figma.variables.getVariableByIdAsync(id); } catch { v = null; }
      if (v) pool.set(id, v);
    }
    if (goneAmong(layers.map((h) => h.node), bad, "layer")) return [];
    const m = matchByName(w.variable, [...pool.values()], (v) => v.name, (v) => [v.id, v.key]);
    if (m.kind === "one") variableId = m.item.id;
    else if (m.kind === "many") { bad("where.variable: '" + w.variable + "' matches " + m.matches.length + " variables — pass one's id or key: " + m.matches.slice(0, 3).map((v) => "'" + v.name + "' (" + v.id + ")").join(", ")); return []; }
    else { bad("where.variable: no variable of this file, nor any a layer in " + describeScope(rule.scope) + " uses, is named '" + w.variable + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "")); return []; }
  }
  // A component set by its name, id or key matches every variant's instances; one variant (by its id or key, or its own
  // name, "State=On") only its own.
  const owners = new Map<string, Array<ComponentNode | ComponentSetNode>>();
  let ownerId: string | null = null;
  if (w.instanceOf !== undefined) {
    const mains = new Map<string, ComponentNode | null>();
    for (const h of layers) {
      if (h.node.type !== "INSTANCE") continue;
      mains.set(h.node.id, await mainOf(h.node));
    }
    if (goneAmong(layers.map((h) => h.node), bad, "layer")) return [];
    // Each instance's component was found at an await and held across the later ones': what it is of is read only now
    // (ownersNow). One deleted or detached by now, or before (soft-deleted), is no component of the file by its name
    // (node-lookup.ts), and a variant moved out of its set is no longer of the set; only a main the instance still
    // returns and that is not removed is named by its exact id or key, as it was before it went.
    const pool = new Map<string, ComponentNode | ComponentSetNode>();
    const retained = new Map<string, ComponentNode>();
    for (const [id, main] of mains) {
      const now = ownersNow(main);
      owners.set(id, now.retained ? [now.retained] : now.live);
      for (const o of now.live) pool.set(o.id, o);
      if (now.retained) retained.set(now.retained.id, now.retained);
    }
    const ref = w.instanceOf;
    const byExact = (c: ComponentNode | ComponentSetNode): boolean => c.id === ref || c.key === ref;
    const kept = [...retained.values()].filter(byExact);
    // An exact id or key wins outright (matchByName): a retained main by its own, when no live component has it.
    const keptOne = kept.length === 1 && ![...pool.values()].some(byExact) ? kept[0] : undefined;
    const m = keptOne ? { kind: "one" as const, item: keptOne } : matchByName(ref, [...pool.values()], (c) => c.name, (c) => [c.id, c.key]);
    if (m.kind === "one") ownerId = m.item.id;
    else if (m.kind === "many") { bad("where.instanceOf: '" + w.instanceOf + "' matches " + m.matches.length + " components the instances in scope are of — pass one's id or key: " + m.matches.slice(0, 3).map((c) => "'" + c.name + "' (" + c.id + (c.remote ? ", a library's" : "") + ")").join(", ")); return []; }
    else { bad("where.instanceOf: no instance in " + describeScope(rule.scope) + " is of a component named '" + w.instanceOf + "'" + (m.candidates.length ? "; closest: " + quoteList(m.candidates) : "")); return []; }
  }
  const out: Hit[] = [];
  for (const h of layers) {
    const n = h.node;
    if (w.name !== undefined && !globMatch(w.name, n.name)) continue;
    if (w.text !== undefined && (n.type !== "TEXT" || n.characters !== w.text)) continue;
    if (w.fill !== undefined) {
      const fills: unknown = "fills" in n ? n.fills : null;
      const hex = w.fill;
      if (!Array.isArray(fills) || !fills.some((p: Paint) => p.type === "SOLID" && p.visible !== false && solidMatches(p.color, p.opacity, hex))) continue;
    }
    if (variableId !== null && !boundVariableIds(n).has(variableId)) continue;
    if (ownerId !== null) { const os = owners.get(n.id); if (!os || !os.some((o) => o.id === ownerId)) continue; }
    out.push(h);
  }
  return out;
}

/** The dry run's view of a rule's matches: counts per page in the file's order, the first few, the token. */
function matchOf(op: WriteOp, hits: readonly Hit[]): RuleMatch {
  const pages: Array<{ page: string; count: number }> = [];
  const byPage = new Map<PageNode, { page: string; count: number }>();
  for (const h of hits) {
    let row = byPage.get(h.page);
    if (!row) { row = { page: h.page.name, count: 0 }; byPage.set(h.page, row); pages.push(row); }
    row.count++;
  }
  return {
    total: hits.length, pages,
    samples: hits.slice(0, RULE_SAMPLES).map((h) => ({ id: h.node.id, name: h.node.name, page: h.page.name })),
    token: ruleToken(op, hits.map((h) => h.node.id + "@" + h.page.id), SESSION_SALT),
    needsToken: hits.length > RULE_TOKEN_MIN,
  };
}

/** How a batch's rules are resolved: as a real run first sent (its tokens checked), as the designer approved it (its
 *  matches compared with the card's: `expect`, op index → what it showed), or for the dry run (no token checks). */
export type RuleMode = { kind: "submit" } | { kind: "approved"; expect: ReadonlyMap<number, ShownRule> } | { kind: "dryRun" };

/**
 * Resolve every patchWhere op of a batch: its scope and rule against the file, every match as a patch (patch.ts
 * resolvePatchNode, the same checks as a patch by id), the names its `set` uses (one lookup for the batch). Every problem
 * is listed, one per op for its matches (counted, with a few named), so the refusal stays small however many match.
 */
export async function resolveRuleOps(ops: readonly WriteOp[], mode: RuleMode = { kind: "submit" }): Promise<{ targets: Map<number, RuleTarget>; problems: OpProblem[]; imports: RefResolution["imports"]; importCount: number; matches: Map<number, RuleMatch> }> {
  const targets = new Map<number, RuleTarget>();
  const matches = new Map<number, RuleMatch>();
  const problems: OpProblem[] = [];
  const uses: Use[] = [];
  const loaded = new Map<string, Promise<string | null>>();
  const loadFont = (f: FontName): Promise<string | null> => {
    const key = f.family + "|" + f.style;
    let p = loaded.get(key);
    if (!p) { p = figma.loadFontAsync(f).then(() => null, () => "font '" + f.family + " " + f.style + "' is not available in this file"); loaded.set(key, p); }
    return p;
  };
  for (const [index, op] of ops.entries()) {
    if (op.op !== "patchWhere") continue;
    const bad = (message: string): void => { problems.push({ index, op: op.op, message }); };
    const rule = checkRule({ ...op }, "ops[" + index + "]").rule;
    const set: unknown = op.set;
    // Checked by writeOpError already; this is the narrowing, and a last line.
    if (!rule || !isPatchSet(set)) { bad("the op did not pass its check"); continue; }
    const before = problems.length;
    const shown = mode.kind === "approved" ? mode.expect.get(index) : undefined;
    const scoped = await layersIn(rule, bad, shown ? shown.selection : undefined);
    const hits = await matchesOf(rule, scoped.hits, bad);
    if (problems.length > before) continue;
    const match = matchOf(op, hits);
    matches.set(index, match);
    const what = "its rule (" + describeWhere(rule.where) + ") matches ";
    if (hits.length > MAX_RULE_MATCHES) { bad(what + hits.length + " layers on " + describeScope(rule.scope) + ", over " + MAX_RULE_MATCHES + ": narrow it (another kind, a name) or its scope (pages, the selection)"); continue; }
    if (mode.kind === "approved") {
      if (shown !== undefined && shown.token !== match.token) { bad("the layers its rule matches are not the ones the card showed (" + String(tokenCount(shown.token)) + " then, " + hits.length + " now, or on other pages): send it again"); continue; }
    } else if (mode.kind === "submit") {
      if (!hits.length) { bad(what + "no layer on " + describeScope(rule.scope) + ": nothing to change (a dry run shows what it matches)"); continue; }
      if (op.token === undefined && match.needsToken) { bad(what + hits.length + " layers (over " + RULE_TOKEN_MIN + "): dry-run the batch first (dryRun: true) and send this op again with the `token` its `match` gives"); continue; }
      if (op.token !== undefined && op.token !== match.token) {
        const was = tokenCount(op.token);
        const why = was === null ? "a token it did not give" : was === hits.length ? was + " then and now: other layers, or a token from before the plugin was reloaded or from another file" : was + " then, " + hits.length + " now";
        bad("the layers its rule matches changed since the dry run that gave its token (" + why + "): dry-run it again and send the new `token`");
        continue;
      }
    }
    // Each match as a patch of its own: the same checks, the same keeping and putting back.
    const later = changesBefore(ops, index);
    const fontsLater = ops.slice(0, index).some((o) => o.op === "setVariable" || o.op === "createVariables");
    const resolved: PatchTarget[] = [];
    const named: string[] = [];
    let misfits = 0;
    for (const h of hits) {
      const said: string[] = [];
      const t = await resolvePatchNode(h.node, set, later, loadFont, (m) => { said.push(m); }, fontsLater);
      if (t && !said.length) { resolved.push(t); continue; }
      misfits++;
      // A match deleted since it was found (at an earlier match's awaits) is named by its id alone: its name throws; so
      // does its page's, when that went.
      if (named.length < RULE_SAMPLES) named.push((inDocument(h.node) ? "'" + h.node.name + "' " : "") + "(" + h.node.id + (h.page !== figma.currentPage && inDocument(h.page) ? ", page '" + h.page.name + "'" : "") + "): " + (said.length ? said.join("; ") : "cannot take this patch"));
    }
    if (misfits) { bad(misfits + " of the " + hits.length + " layers its rule matches cannot take this patch — narrow the rule (another kind, a name) or the scope: " + named.join(" | ") + (misfits > named.length ? " | …" : "")); continue; }
    // The names its `set` uses resolve in the dry run too (nothing is imported until a real run applies).
    uses.push(...patchUses(index, set).map((u) => ({ ...u, op: op.op })));
    targets.set(index, { matches: resolved, match, ids: hits.map((h) => h.node.id), ...(scoped.selection ? { selection: scoped.selection } : {}) });
  }
  const r = uses.length ? await resolveRefs(uses, loadFont) : null;
  if (r) {
    problems.push(...r.problems);
    for (const t of targets.values()) for (const p of t.matches) p.refs = r.refs;
  }
  return { targets, problems, imports: r ? r.imports : async () => ({ problems: [], revoked: false }), importCount: r ? r.importCount : 0, matches };
}

/** The dry run's file-side half for the batch's patchWhere ops (writeImpact): each one's matches, or why the file
 *  refuses it as it is now (a page or name that matches nothing, a layer the patch does not fit). Reads only. */
export async function ruleImpact(ops: readonly WriteOp[]): Promise<WriteImpactStep[]> {
  if (!ops.some((o) => o.op === "patchWhere")) return [];
  const { problems, matches } = await resolveRuleOps(ops, { kind: "dryRun" });
  const out: WriteImpactStep[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.op !== "patchWhere") continue;
    const said = problems.filter((p) => p.index === index).map((p) => p.message);
    const match = matches.get(index);
    out.push({ index, op: op.op, ...(match ? { match } : {}), ...(said.length ? { problem: said.join("; ") } : {}) });
  }
  return out;
}
