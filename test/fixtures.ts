// fixtures.ts — typed builders for the tests' hand-made inputs (design-to-code documents, bridge
// replies), and runtime-asserting readers for the emitters' outputs.
//
// A test fixture used to be an object literal forced into its type with `as unknown as TokensDoc`. That
// hid how far the fixtures had drifted from what the producer writes: 36 variables with no `tier`, 30
// collections with no `theming`, 30 map entries with no `figma.name`, nodes with no `id`. Each builder
// here takes the fields a test cares about and fills the rest THE WAY THE PRODUCER DOES
// (figma-plugin/src/variables.ts, map-bootstrap.ts, …), so a fixture is a real document of its type.
//
// A deliberately MALFORMED input (a null, a component with no name, a value of the wrong type) goes
// through malformed(), the one place a test says "this does not satisfy the type, on purpose".
//
// The readers (leafAt, asColor, modesOf, …) replace the old type-only "view" casts over the emitters'
// output: a path that is not there fails as a named assertion, not as a TypeError three lines later.
import type {
  CatalogComponent, CodeConnectMap, ComponentPropDef, ComponentsCatalog, IrNode, Manifest, MapEntry, PropMap, ScreenExport, TokensDoc,
  Variable, VariableCollection, VariableValue,
} from "../design-to-code/types.ts";
import type {
  DtcgColor, DtcgDimension, DtcgFigmaExtension, DtcgGroup, DtcgLeaf, DtcgLeafValue, ResolverDoc, ResolverModifier,
} from "../design-to-code/tokens.ts";
import type { BooleanPropMap, EnumPropMap, InstancePropMap, StringPropMap } from "../design-to-code/types.ts";
import type { Asset, VariablesDoc } from "../bridge/src/doc-types.ts";
import type { ScreenReply } from "../bridge/src/commands.ts";
import type { Stamped } from "../bridge/src/write-out.ts";
import type { ClientRow } from "../bridge/src/server-core.ts";
import type { DocGuard } from "../design-to-code/doc-guards.ts";
import { readJson } from "../design-to-code/read-json.ts";

/** A fixture failed to be what the test assumed. Thrown by the readers below. */
export class FixtureError extends Error {
  override name = "FixtureError";
}
const fail = (msg: string): never => { throw new FixtureError(msg); };

/**
 * A deliberately malformed input: `x` does NOT satisfy `T`, and the test is about what the code does
 * with it. The one sanctioned escape from the type system in the tests (see test/assert.ts).
 */
export function malformed<T>(x: unknown): T {
  const u: unknown = x;
  return u as T;
}

// ------------------------------------------------------------------ variables / collections / tokens

/** A variable as a test writes it: `tier` optional (derived as the producer derives it). */
export type VariableInput = Omit<Variable, "tier"> & { tier?: Variable["tier"] };
/** A collection as a test writes it: `theming` optional (the producer writes `modes.length > 1`). */
export type CollectionInput = Omit<VariableCollection, "theming"> & { theming?: boolean };

const isAliasValue = (v: VariableValue): boolean => typeof v === "object" && v !== null && "aliasOf" in v;

/** figma-plugin/src/variables.ts: alias => semantic; raw + narrowed scopes => semantic; raw + unscoped => primitive. */
export function variable(v: VariableInput): Variable {
  const tier = v.tier ?? (Object.values(v.values).some(isAliasValue) ? "semantic"
    : v.scopes && v.scopes.some((s) => s !== "ALL_SCOPES") ? "semantic" : "primitive");
  return { ...v, tier };
}
export function collection(c: CollectionInput): VariableCollection {
  return { ...c, theming: c.theming ?? c.modes.length > 1 };
}
/** A token document (tokens.json / variables.json / a .vars.json) from test-shaped variables and collections. */
export type TokensInput = Omit<TokensDoc, "variables" | "collections"> & { variables?: VariableInput[]; collections?: CollectionInput[] };
export function tokens(doc: TokensInput): TokensDoc {
  const { variables, collections, ...rest } = doc;
  return { ...rest, ...(collections ? { collections: collections.map(collection) } : {}), ...(variables ? { variables: variables.map(variable) } : {}) };
}

// ------------------------------------------------------------------ component catalog

/** A prop definition as a test writes it: `key` optional (the producer keeps the real "#uid" key; tests default it to the name). */
export type PropDefInput = Omit<ComponentPropDef, "key"> & { key?: string };
export type ComponentInput = Omit<CatalogComponent, "props"> & { props?: Record<string, PropDefInput> };
export function component(c: ComponentInput): CatalogComponent {
  const { props, ...rest } = c;
  if (!props) return rest;
  const out: Record<string, ComponentPropDef> = {};
  for (const [name, def] of Object.entries(props)) out[name] = { ...def, key: def.key ?? name };
  return { ...rest, props: out };
}
export function catalog(components: ComponentInput[], stamp: Omit<ComponentsCatalog, "components"> = {}): ComponentsCatalog {
  return { ...stamp, components: components.map(component) };
}

// ------------------------------------------------------------------ codeconnect.local.json

/** A map entry as a test writes it: `code` optional (a placeholder target is filled), figma.name REQUIRED —
 *  map-bootstrap always writes it, and drift-lint compares it (stale-name). */
export type MapEntryInput = Omit<MapEntry, "code"> & { code?: MapEntry["code"] };
export function mapEntry(e: MapEntryInput): MapEntry {
  return { ...e, code: e.code ?? { module: "@/fixture", export: e.figma.name.replace(/[^A-Za-z0-9]/g, "") || "Fixture" } };
}
export function codeMap(components: Record<string, MapEntryInput>, extra: Omit<CodeConnectMap, "version" | "components"> = {}): CodeConnectMap {
  const out: Record<string, MapEntry> = {};
  for (const [k, e] of Object.entries(components)) out[k] = mapEntry(e);
  return { version: 1, ...extra, components: out };
}

// ------------------------------------------------------------------ IR nodes / screen exports

/** A pull's manifest: every counter the producer (state.ts manifest()) writes, zero unless given. */
export function manifest(m: Partial<Manifest> = {}): Manifest {
  return { nodes: 0, skipped: 0, truncated: 0, assetsFailed: 0, assetsSkipped: 0, assetsSkippedInvisible: 0, assetsGeometry: 0, warnings: [], ...m };
}

/** A node as a test writes it: `name` optional (defaults to its type, as a Figma layer's default name does). */
export type NodeInput = Omit<IrNode, "name" | "children"> & { name?: string; children?: NodeInput[] };
export function node(n: NodeInput): IrNode {
  const { children, ...rest } = n;
  return { ...rest, name: n.name ?? String(n.type), ...(children ? { children: children.map(node) } : {}) };
}
export function screenExport(nodes: NodeInput[], meta: Omit<ScreenExport, "nodes"> = {}): ScreenExport {
  return { ...meta, nodes: nodes.map(node) };
}

// ------------------------------------------------------------------ bridge replies / rows (bridge.test.ts)

/** A single-screen pull reply as a test writes it: `variables`/`assets` optional, the screen's nodes as
 *  NodeInput and its manifest partial. */
export type ScreenReplyInput = Omit<Stamped<ScreenReply>, "screen" | "variables" | "assets"> & {
  screen: Omit<ScreenExport, "nodes" | "manifest"> & { nodes: NodeInput[]; manifest?: Partial<Manifest> | undefined };
  variables?: VariablesDoc;
  assets?: Asset[];
};
/** figma-plugin/src/collect.ts screenResult: the screen always carries a manifest, the reply always a
 *  variables dump (all three arrays, empty for a screen that binds none) and an assets array. */
export function screenReply(r: ScreenReplyInput): Stamped<ScreenReply> {
  const { screen, variables, assets, ...rest } = r;
  const { nodes, manifest: m, ...meta } = screen;
  return {
    ...rest,
    screen: { ...meta, nodes: nodes.map(node), manifest: manifest(m) },
    variables: variables ?? { collections: [], variables: [], hygiene: [] },
    assets: assets ?? [],
  };
}

/** A connected-client row (server-core.ts listClients): nothing known until given — a client that has
 *  not identified itself, and a plugin that has not reported its version. */
export function clientRow(r: Partial<ClientRow> = {}): ClientRow {
  return { connId: "c0", file: null, fileKey: null, page: null, instanceId: null, connectedAt: 0, uptimeMs: 0, identified: false, pluginVersion: null, pluginStale: null, ...r };
}

// ------------------------------------------------------------------ readers over the emitters' output

const isDtcgLeaf = (n: DtcgGroup | DtcgLeaf): n is DtcgLeaf => n.$value !== undefined;
/** The DTCG node at a dotted path, or undefined — for asserting that something was NOT emitted. */
export function nodeAt(tree: DtcgGroup | undefined, dotted: string): DtcgGroup | DtcgLeaf | undefined {
  let cur: DtcgGroup | DtcgLeaf | undefined = tree;
  for (const seg of dotted.split(".")) {
    if (cur === undefined || isDtcgLeaf(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}
/** The DTCG node at a dotted path ("color.primary"), which must be a leaf. */
export function leafAt(tree: DtcgGroup | undefined, dotted: string): DtcgLeaf {
  const n = nodeAt(tree, dotted);
  return n !== undefined && isDtcgLeaf(n) ? n : fail(`'${dotted}' is not a DTCG leaf`);
}
/** A leaf's `$extensions["figma.com"]`. */
export function figmaExt(leaf: DtcgLeaf): DtcgFigmaExtension {
  return (leaf.$extensions && leaf.$extensions["figma.com"]) || fail("leaf has no $extensions[\"figma.com\"]");
}
/** A leaf's per-mode values ($extensions["figma.com"].modes). */
export function modesOf(leaf: DtcgLeaf): Record<string, DtcgLeafValue> {
  return figmaExt(leaf).modes || fail("leaf has no per-mode values");
}
export function asColor(v: DtcgLeafValue | undefined): DtcgColor {
  // typeof null === "object", so without the null check `"colorSpace" in v` throws a raw TypeError
  // instead of this function's own FixtureError.
  return v !== null && typeof v === "object" && "colorSpace" in v ? v : fail(`not a DTCG colour: ${JSON.stringify(v)}`);
}
export function asDimension(v: DtcgLeafValue | undefined): DtcgDimension {
  return v !== null && typeof v === "object" && "unit" in v ? v : fail(`not a DTCG dimension: ${JSON.stringify(v)}`);
}
/** A resolver modifier by name. */
export function modifierOf(r: ResolverDoc, name: string): ResolverModifier {
  return (r.modifiers && r.modifiers[name]) || fail(`resolver has no modifier '${name}'`);
}
/** A resolver set file by $ref. */
export function fileAt(files: Record<string, DtcgGroup>, ref: string | undefined): DtcgGroup {
  return (ref !== undefined && files[ref]) || fail(`no resolver file '${String(ref)}'`);
}

// ------------------------------------------------------------------ map props (bootstrap output)

function propOf(m: CodeConnectMap, key: string, prop: string): PropMap {
  const e = m.components[key] || fail(`map has no entry '${key}'`);
  return (e.props && e.props[prop]) || fail(`map entry '${key}' has no prop '${prop}'`);
}
export function enumProp(m: CodeConnectMap, key: string, prop: string): EnumPropMap {
  const p = propOf(m, key, prop);
  return p.kind === "enum" ? p : fail(`'${key}'.props.${prop} is kind '${p.kind}', not enum`);
}
export function boolProp(m: CodeConnectMap, key: string, prop: string): BooleanPropMap {
  const p = propOf(m, key, prop);
  return p.kind === "boolean" ? p : fail(`'${key}'.props.${prop} is kind '${p.kind}', not boolean`);
}
export function stringProp(m: CodeConnectMap, key: string, prop: string): StringPropMap {
  const p = propOf(m, key, prop);
  return p.kind === "string" ? p : fail(`'${key}'.props.${prop} is kind '${p.kind}', not string`);
}
export function instanceProp(m: CodeConnectMap, key: string, prop: string): InstancePropMap {
  const p = propOf(m, key, prop);
  return p.kind === "instance" ? p : fail(`'${key}'.props.${prop} is kind '${p.kind}', not instance`);
}
/** A prop of any kind (for `.kind` / `.codeProp` checks that do not care which). */
export function anyProp(m: CodeConnectMap, key: string, prop: string): PropMap {
  return propOf(m, key, prop);
}
/** The value of a required-by-the-test lookup (Array.find, Map.get): a named failure instead of `!`. */
export function must<T>(x: T | null | undefined, what: string): T {
  return x ?? fail(`expected ${what}`);
}

// ------------------------------------------------------------------ JSON on disk / on stdout

/** A fixture file (or a file a CLI under test wrote), checked against its doc-guards.ts guard. */
export function readFixture<T>(file: string, guard: DocGuard<T>): T {
  const r = readJson(file, guard);
  return "doc" in r ? r.doc : fail(`'${file}' ${r.error}`);
}
/** JSON text (a CLI's --json stdout), checked against a guard. */
export function parseAs<T>(text: string, guard: DocGuard<T>, what: string): T {
  let parsed: unknown;
  try { const value: unknown = JSON.parse(text); parsed = value; } catch { return fail(`${what}: not JSON — ${text.slice(0, 120)}`); }
  return guard(parsed) ? parsed : fail(`${what}: ${guard.expected ? "is not " + guard.expected : "has the wrong shape"}`);
}
