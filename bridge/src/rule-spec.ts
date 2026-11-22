// A bulk patch by rule (`patchWhere`, docs/write-plane-spec.md decision 8): one patch that changes every layer matching a
// rule within a scope, its cost independent of how many match.
//
//   {op: "patchWhere", where: {text?, fill?, variable?, instanceOf?, name?}, scope?, set, token?}
//
// `where` holds one or more rule kinds, all of which must hold for a layer: `text` (a text's characters equal), `fill` (a
// visible solid fill equal to the hex colour, by its 8-bit channels and opacity), `variable` (a layer bound to the
// variable: its name, id or key), `instanceOf` (an instance of the component or component set: its name, id or key) and
// `name` (the layer's name; `*` stands for any run of characters, nothing else is special). `scope`: "selection",
// "page" (the current page, the default), "file" (every page), or a list of page names or ids. Layers inside an instance,
// a main component or a component set are never matched: they follow their main component, which a `patch` of it
// changes once.
//
// The dry run answers with a count per page and a few samples (RuleMatch), never the whole list, and a token for those
// matches; a real run that matches more than RULE_TOKEN_MIN layers must carry it, and one whose matches changed since
// is refused. This module is the pure half — the check, the words, the token; figma-plugin/src/rules.ts reads the file.
// Dependency-free apart from hex-color.ts and name-match.ts (pure): the plugin bundle imports it.
import { HEX_COLOR_HINT, parseHexColor } from "./hex-color.ts";
import { quoteList } from "./name-match.ts";

/** A real run that matches more layers than this must carry the token its dry run returned (the review's layer limit). */
export const RULE_TOKEN_MIN = 25;
/** The most layers one rule may match: a larger change is several, each narrower (a scope, another kind). */
export const MAX_RULE_MATCHES = 2000;
/** How many matches the dry run shows as samples. */
export const RULE_SAMPLES = 3;

/** The rule kinds, in the order the words list them. */
export const RULE_KINDS = ["text", "fill", "variable", "instanceOf", "name"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type RuleWhere = Partial<Record<RuleKind, string>>;
/** Where a rule looks: the selection (and everything inside it), the current page, every page, or the pages named. */
export type RuleScope = "selection" | "page" | "file" | string[];
const SCOPE_WORDS: readonly string[] = ["selection", "page", "file"];

/** What a dry run (and a real run's refusal) says of a rule's matches: never the full list. */
export interface RuleMatch {
  total: number;
  /** each page with a match, in the file's order, and how many */
  pages: Array<{ page: string; count: number }>;
  /** the first few matches, in document order */
  samples: Array<{ id: string; name: string; page: string }>;
  /** the token a real run of this op sends back (`token`), standing for this change on these layers */
  token: string;
  /** true when a real run needs the token (more than RULE_TOKEN_MIN matches) */
  needsToken: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isKind = (k: string): k is RuleKind => (RULE_KINDS as readonly string[]).indexOf(k) >= 0;

/** A patchWhere op's rule fields, narrowed. */
export interface CheckedRule { where: RuleWhere; scope: RuleScope | undefined }

/** Every problem with op `o`'s rule fields (`where`, `scope`, `token`, and a `nodeId` it must not have), by path under
 *  `at` ("ops[3]"); the narrowed rule when there are none. The patch's `set` is patch-spec.ts checkPatch's. */
export function checkRule(o: Record<string, unknown>, at: string): { problems: string[]; rule: CheckedRule | null } {
  const problems: string[] = [];
  const where: RuleWhere = {};
  const w = o.where;
  if (!isObj(w)) problems.push(at + ".where: must be an object of the rule, e.g. {text: \"Sign in\"} (" + RULE_KINDS.join(", ") + ")");
  else {
    let kinds = 0;
    for (const k of Object.keys(w)) {
      const v = w[k];
      if (v === undefined) continue;
      if (!isKind(k)) { problems.push(at + ".where." + k + ": not a rule kind (" + RULE_KINDS.join(", ") + ")"); continue; }
      if (!isStr(v) || v === "") { problems.push(at + ".where." + k + ": must be a non-empty string"); continue; }
      if (k === "fill" && !parseHexColor(v)) { problems.push(at + ".where.fill: '" + v + "' is not " + HEX_COLOR_HINT); continue; }
      where[k] = v;
      kinds++;
    }
    if (!kinds && !problems.length) problems.push(at + ".where: give at least one of " + RULE_KINDS.join(", "));
  }
  const s = o.scope;
  let scope: RuleScope | undefined;
  if (s === undefined) scope = undefined;
  else if (isStr(s) && SCOPE_WORDS.indexOf(s) >= 0) scope = s as RuleScope;
  else if (Array.isArray(s)) {
    if (!s.length) problems.push(at + ".scope: name at least one page, or use \"page\", \"file\" or \"selection\"");
    const pages: string[] = [];
    s.forEach((p: unknown, i) => { if (isStr(p) && p !== "") pages.push(p); else problems.push(at + ".scope[" + i + "]: must be a page's name or id"); });
    scope = pages;
  } else problems.push(at + ".scope: must be \"selection\", \"page\" (the current page, the default), \"file\" (every page) or a list of page names");
  if (o.token !== undefined && (!isStr(o.token) || o.token === "")) problems.push(at + ".token: must be the token string the dry run returned");
  if (o.nodeId !== undefined) problems.push(at + ".nodeId: a patchWhere has none — its rule picks the layers (a `patch` changes one node by id)");
  return { problems, rule: problems.length ? null : { where, scope } };
}

/** The rule in the words a designer reads: "text “Sign in” and an instance of 'Button'". */
export function describeWhere(w: RuleWhere): string {
  const parts: string[] = [];
  for (const k of RULE_KINDS) {
    const v = w[k];
    if (v === undefined) continue;
    if (k === "text") parts.push("text “" + v + "”");
    else if (k === "fill") parts.push("fill " + v.toLowerCase());
    else if (k === "variable") parts.push("variable '" + v + "'");
    else if (k === "instanceOf") parts.push("an instance of '" + v + "'");
    else parts.push("name '" + v + "'");
  }
  return parts.join(" and ");
}

/** Where the rule looks, in words. */
export function describeScope(s: RuleScope | string | undefined): string {
  if (s === undefined || s === "page") return "the current page";
  if (s === "selection") return "the selection";
  if (s === "file") return "every page";
  if (typeof s === "string") return "scope '" + s + "'"; // not a scope (the check says so): as given
  return (s.length === 1 ? "page " : "pages ") + quoteList(s);
}

/** `name` against `pattern`, where `*` is any run of characters (an empty one too) and everything else is itself, case
 *  included. Linear in practice: the classic wildcard walk, backtracking only to the last star. */
export function globMatch(pattern: string, name: string): boolean {
  let p = 0, n = 0, star = -1, mark = 0;
  while (n < name.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === name[n]) { p++; n++; }
    else if (p < pattern.length && pattern[p] === "*") { star = p++; mark = n; }
    else if (star >= 0) { p = star + 1; n = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** A solid paint's colour (0–1 channels) and opacity against a hex colour, by 8-bit channels; an alpha pair in the hex
 *  is the paint's opacity (none: opaque). */
export function solidMatches(c: { r: number; g: number; b: number }, opacity: number | undefined, hex: string): boolean {
  const h = parseHexColor(hex);
  if (!h) return false;
  const b8 = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);
  const a = opacity === undefined ? 1 : opacity;
  return b8(c.r) === b8(h.r) && b8(c.g) === b8(h.g) && b8(c.b) === b8(h.b) && b8(a) === b8(h.a === undefined ? 1 : h.a);
}

/** `v` as JSON with every object's keys sorted, so the same op written in another key order hashes alike. */
function canonical(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
/** Two 32-bit FNV-1a hashes of `s` (different offsets), as 16 hex digits: no crypto in the plugin, and a token only has
 *  to tell one set of matches from another, not resist forgery (the designer's consent is the gate). */
function hash16(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  const hex = (x: number): string => ("0000000" + (x >>> 0).toString(16)).slice(-8);
  return hex(a) + hex(b);
}

/** The token of op `o`'s matches `ids`: "<count>.<hash of the rule, the scope, the change and the sorted ids>". The same
 *  change on the same layers gives the same token; anything else another. */
export function ruleToken(o: { where?: unknown; scope?: unknown; set?: unknown }, ids: readonly string[]): string {
  const sorted = ids.slice().sort();
  return sorted.length + "." + hash16(canonical({ where: o.where, scope: o.scope === undefined ? "page" : o.scope, set: o.set }) + "|" + sorted.join(","));
}

/** The match count a token carries, or null when the string is not one. */
export function tokenCount(t: string): number | null {
  const m = /^(\d+)\.[0-9a-f]{16}$/.exec(t);
  return m && m[1] !== undefined ? Number(m[1]) : null;
}
