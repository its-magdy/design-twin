// drift-lint.ts — reconcile a codeconnect.local.json map against the LIVE component catalog
// (the `components` array from figma-plugin/code.js buildDesignSystem()/design-system.json).
//
// This is the check Figma's own Code Connect is missing: because it keys on node-id, a deleted/moved
// mapped component makes `publish` succeed silently with a broken link (github.com/figma/code-connect
// /issues/337). We key on the stable publish `key`, so we can catch exactly that.
//
// Resolution is by IDENTITY only (figma.key, then the map key as a key, then figma.id / map key as an
// id). A NAME never auto-binds an entry — if a declared key/id no longer resolves, the entry is
// ORPHANED (error), even when some other component happens to share its name; the same-named component
// is offered only as a *suggestion* in the message. This avoids silently rebinding to the wrong
// component (the failure that would defeat the tool's purpose). Prop names are compared with Figma's
// "#id" suffix stripped on BOTH sides. Returns { errors, warnings, summary }.

import { TYPE_TO_KIND } from "./kinds.ts"; // shared vocab — kept in sync with map-bootstrap
import { snapshotAge } from "../bridge/src/snapshot-meta.ts"; // ONE definition of the freshness stamp
import { errMsg } from "../bridge/src/errmsg.ts"; // ONE thrown-value -> message coercion
import { walkWithHidden } from "./hidden.ts";
import { readDocFile, readJsonFile, readSplitFile, NO_DESIGN_SYSTEM_HINT } from "./catalog-input.ts";
import { isComponentsCatalog } from "./doc-guards.ts";
import { cliParse, scriptCmd } from "./cli-args.ts";
import { parseArgs } from "node:util";
import { visibleInstances, matchByNameAndSignature, isRekeyed } from "./component-match.ts";
import { isJsonObject } from "./types.ts";
import { isScreenDoc, screenRoots } from "./export-shape.ts";
import { isCodeConnectMap, validateMap } from "./map-validate.ts";
import type {
  CodeConnectMap, ComponentPropDef, ComponentsCatalog, DriftCode, DriftFinding, DriftLintResult, FreshnessWarning, MapEntry, PropMap,
  ScreenCoverage, ScreenDoc, VisibleInstance,
} from "./types.ts";
import { readCatalogSet, unionCatalog, catalogSetLine, discoverCatalogs } from "./design-system-dir.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { ifDefined, nullProto } from "../bridge/src/json-util.ts";
import { getOrInit } from "./map-util.ts";

const stripSuffix = (k: string): string => String(k).split("#")[0] ?? ""; // "Size#12:3" -> "Size"; ?? "": split() always returns at least one piece, so it never applies

/** A catalog read beside the named one (components.library.json, libraries/<dir>/components.json, a --catalog). */
export interface ExtraCatalog { file: string; catalog: ComponentsCatalog }
/** What driftLint accepts as `opts`. `extraCatalogs`: map entries also resolve against these (DT-26) —
 *  coverage (unmapped-component) and the freshness banner stay about the named catalog. */
export interface DriftLintOptions { maxAgeMs?: number; now?: number; extraCatalogs?: readonly ExtraCatalog[] }

/** The catalogs a map may also point into, found beside `namedFile` WITHOUT ever exiting: the MCP server
 *  (figma-mcp.ts design_drift_lint) runs driftLint in-process, where any process.exit would take the
 *  whole server down. Same discovery (discoverCatalogs) as readCatalogSet with no --catalog; an absent or
 *  unreadable file is skipped (and so is not in the tool's catalogsRead). */
function discoverExtraCatalogs(namedFile: string): ExtraCatalog[] {
  return discoverCatalogs(namedFile).flatMap((d) => (d.catalog ? [{ file: d.file, catalog: d.catalog }] : []));
}

type Push = (arr: DriftFinding[], code: DriftCode, message: string, extra?: Partial<DriftFinding>) => void;

// ---------------------------------------------------------------- staleness / freshness
// The catalog (design-system.json) is stamped by the plugin itself — collect.ts/components.ts already
// emit `exportedAt` (ISO timestamp, ALWAYS present on a real export) and `file` (figma.root.name) at
// the top level of buildDesignSystem()'s result. No wrapper is invented here — those are the fields
// the plugin actually sends, read as-is.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h, overridable (CLI --max-age <hours> / env)

// Never silently pass: a catalog with no exportedAt gets an explicit "freshness unknown" warning
// rather than being treated as fresh, and one older than maxAgeMs gets a prominent stale warning
// naming the age. Returns the warning pushed (or undefined when the snapshot is fresh) so callers
// (the CLI) can also print an extra banner for the stale case without re-deriving the check.
function checkFreshness(catalog: { exportedAt?: string | null; file?: string } | null | undefined, push: Push, warnings: DriftFinding[], opts: DriftLintOptions = {}): FreshnessWarning | undefined {
  const maxAgeMs = opts.maxAgeMs !== undefined && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  // Which field and whether it parses is snapshot-meta's rule (figma_status reads the same stamp);
  // only the threshold, the codes and the wording below are this linter's policy.
  const { exportedAt, ageMs, problem } = snapshotAge(catalog, opts.now || Date.now());
  if (problem === "missing") {
    const w: FreshnessWarning = { code: "unknown-freshness", message: "design-system.json has no `exportedAt` timestamp — freshness cannot be verified. Findings are checked against whatever snapshot is on disk, which may be stale; re-export with the current plugin to get a timestamp." };
    push(warnings, w.code, w.message, {});
    return w;
  }
  if (problem === "unparseable") {
    const w: FreshnessWarning = { code: "unknown-freshness", message: `design-system.json's \`exportedAt\` ('${exportedAt}') is not a parseable timestamp — freshness cannot be verified.` };
    push(warnings, w.code, w.message, { ...ifDefined("exportedAt", exportedAt) });
    return w;
  }
  if (typeof ageMs === "number" && ageMs > maxAgeMs) {
    const ageH = (ageMs / 3600000).toFixed(1);
    const maxH = (maxAgeMs / 3600000).toFixed(1);
    const w: FreshnessWarning = {
      code: "stale-snapshot",
      message: `STALE SNAPSHOT: design-system.json was exported ${ageH}h ago (max-age ${maxH}h)${catalog && catalog.file ? ` from '${catalog.file}'` : ""}. Every finding below is checked against that on-disk snapshot, NOT the live Figma file — re-run dtwin / the export tool before trusting them.`,
    };
    push(warnings, w.code, w.message, { ...ifDefined("exportedAt", exportedAt), ageMs, maxAgeMs });
    return w;
  }
  return undefined;
}

// The other catalogs only get a one-line warning when their own stamp is missing, unparseable or older
// than max-age — the prominent banner (and the returned FreshnessWarning) stays about the named catalog.
function checkExtraFreshness(x: ExtraCatalog, push: Push, warnings: DriftFinding[], opts: DriftLintOptions): void {
  const maxAgeMs = opts.maxAgeMs !== undefined && opts.maxAgeMs > 0 ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const { exportedAt, ageMs, problem } = snapshotAge(x.catalog, opts.now || Date.now());
  if (problem) push(warnings, "unknown-freshness", `${x.file} has ${problem === "missing" ? "no `exportedAt` timestamp" : `an unparseable \`exportedAt\` ('${exportedAt}')`} — map entries resolved in it may be stale.`, { ...ifDefined("exportedAt", exportedAt) });
  else if (typeof ageMs === "number" && ageMs > maxAgeMs) push(warnings, "stale-snapshot", `${x.file} was exported ${(ageMs / 3600000).toFixed(1)}h ago (max-age ${(maxAgeMs / 3600000).toFixed(1)}h) — map entries resolved in it are checked against that snapshot.`, { ...ifDefined("exportedAt", exportedAt), ageMs, maxAgeMs });
}

// Index a props object by base name (Figma's "#id" suffix stripped), warning on — and recording —
// any two distinct keys that collapse to the same base so callers skip order-dependent errors on it.
interface IndexedProps<T> { props: Record<string, T>; ambiguous: Set<string> }
function indexPropsByBase(rawProps: Record<string, ComponentPropDef> | undefined, valKey: "def", subject: string, push: Push, warnings: DriftFinding[], mapKey: string): IndexedProps<{ orig: string; def: ComponentPropDef }>;
function indexPropsByBase(rawProps: Record<string, PropMap> | undefined, valKey: "prop", subject: string, push: Push, warnings: DriftFinding[], mapKey: string): IndexedProps<{ orig: string; prop: PropMap }>;
function indexPropsByBase(rawProps: Record<string, unknown> | undefined, valKey: string, subject: string, push: Push, warnings: DriftFinding[], mapKey: string): IndexedProps<{ orig: string; [k: string]: unknown }> {
  // null-prototype map: a prop whose base name is literally "__proto__"/"constructor" is indexed and
  // compared like any other, instead of silently mutating a prototype and being skipped from drift checks.
  const ambiguous = new Set<string>(), out: Record<string, { orig: string; [k: string]: unknown }> = nullProto();
  for (const k of Object.keys(rawProps || {})) {
    const b = stripSuffix(k);
    const prev = out[b]; // null-prototype and never set to undefined: defined exactly when `b in out`
    if (prev !== undefined && prev.orig !== k) {
      push(warnings, "ambiguous-prop", `${subject} has two props with base name '${b}' ('${prev.orig}', '${k}') — comparison skipped`, { mapKey, prop: b });
      ambiguous.add(b);
    }
    out[b] = { orig: k, [valKey]: (rawProps || {})[k] };
  }
  return { props: out, ambiguous };
}

function driftLint(map: CodeConnectMap | null | undefined, catalog: ComponentsCatalog | null | undefined, opts?: DriftLintOptions): DriftLintResult {
  const errors: DriftFinding[] = [], warnings: DriftFinding[] = [];
  const push: Push = (arr, code, message, extra) => arr.push(Object.assign({ code, message }, extra || {}));

  const freshness = checkFreshness(catalog, push, warnings, opts || {});
  const extras = (opts && opts.extraCatalogs) || [];
  for (const x of extras) checkExtraFreshness(x, push, warnings, opts || {});

  const comps = (catalog && catalog.components) || [];
  const byKey = new Map<string, CatalogEntry>(), byId = new Map<string, CatalogEntry>(), byName = new Map<string, CatalogEntry[]>();
  // Within ONE catalog a repeated key is a real problem (today's warning, and the last row wins as
  // before). ACROSS catalogs the same key is the same component seen twice (a library's own
  // components.json and the design file's sampled components.library.json): the first catalog wins, silently.
  const index = (list: readonly CatalogEntry[], primary: boolean, file?: string): void => {
    const own = new Map<string, CatalogEntry>(), claimed = new Set<string>();
    for (const c of list) {
      if (c.key) {
        const dup = own.get(c.key);
        if (dup) push(warnings, "duplicate-key", `two catalog components share key '${c.key}' ('${dup.name}' and '${c.name}')${file ? ` in ${file}` : ""}`, { key: c.key });
        own.set(c.key, c);
        if (!byKey.has(c.key) || claimed.has(c.key)) { byKey.set(c.key, c); claimed.add(c.key); }
      }
      // Node ids are unique only within ONE Figma file: an id from another catalog (a library's "1:5")
      // must never resolve an entry whose own component was deleted — ids index the named catalog only.
      if (c.id && primary) byId.set(c.id, c);
      if (c.name) getOrInit(byName, c.name, () => []).push(c);
    }
  };
  index(comps, true);
  for (const x of extras) index(x.catalog.components || [], false, x.file);
  const inNamed = new Set<CatalogEntry>(comps);
  const mappedIds = new Set<string>();           // catalog key/id values that got matched (for coverage)
  const compToEntries = new Map<CatalogEntry, string[]>();       // component -> [mapKey] (double-map detection)
  const entries = (map && map.components) || {};

  for (const [mapKey, e] of Object.entries(entries)) {
    const f: Partial<MapEntry["figma"]> = e.figma || {};
    // Identity resolution. An author-declared figma.key/figma.id is an explicit identity CLAIM and is
    // authoritative: if it's present we resolve by it ALONE and never fall through to the map key. That
    // fallthrough would let a coincidental map-key collision silently rebind a stale entry to an
    // unrelated live component — precisely the drift this tool exists to catch (a deleted/unpublished
    // component would look "mapped" instead of orphaned). Only when the entry declares no figma identity
    // do we lean on the map key, which may itself be a publish key OR (unpublished) a node id.
    let comp: CatalogEntry | undefined;
    if (f.key) comp = byKey.get(f.key);            // published: key is the stable identity — stale key -> orphaned
    else if (f.id) comp = byId.get(f.id);          // unpublished/local: declared node id is the identity
    else comp = byKey.get(mapKey) || byId.get(mapKey); // no explicit identity: the map key is the only handle

    if (!comp) {
      // Orphaned — a NAME is never allowed to rebind; only suggested.
      const sameName = f.name && byName.get(f.name);
      const onlyNamed = sameName && sameName.length === 1 ? sameName[0] : undefined;
      const suggestedKey = onlyNamed ? onlyNamed.key : undefined;
      push(errors, "orphaned-entry",
        `map entry '${mapKey}' (was '${f.name || "?"}'${f.id ? ", id " + f.id : ""}) has no matching component in Figma — deleted, moved, or unpublished${suggestedKey ? ` (a component named '${f.name}' exists with key ${suggestedKey} — verify before re-pointing)` : ""}`,
        { mapKey, ...ifDefined("suggestedKey", suggestedKey) });
      continue;
    }
    if (comp.key) mappedIds.add(comp.key);
    if (comp.id && inNamed.has(comp)) mappedIds.add(comp.id); // ids are per file — only the named catalog's
    getOrInit(compToEntries, comp, () => []).push(mapKey);

    if (f.name && comp.name && f.name !== comp.name) {
      push(warnings, "stale-name", `map entry '${mapKey}' remembers name '${f.name}' but component is now '${comp.name}' (rename — refresh advisory metadata)`, { mapKey, from: f.name, to: comp.name });
    }

    // Prop comparison — strip Figma's #id suffix on both sides so the two conventions line up. If two
    // distinct keys collapse to the same base name, surface it (never silently shadow one away) and
    // record the base so we DON'T emit an order-dependent kind/enum error on an ambiguous prop.
    const { props: catProps, ambiguous: catAmbiguous } = indexPropsByBase(comp.props, "def", `component '${comp.name}'`, push, warnings, mapKey);
    const { props: mapProps, ambiguous: mapAmbiguous } = indexPropsByBase(e.props, "prop", `map entry '${mapKey}'`, push, warnings, mapKey);

    for (const [pn, mp] of Object.entries(mapProps)) if (!(pn in catProps)) push(errors, "stale-prop", `'${mapKey}'.props.${mp.orig} does not exist on the Figma component`, { mapKey, prop: pn });
    for (const [pn, cp] of Object.entries(catProps)) if (!(pn in mapProps)) push(warnings, "uncovered-prop", `'${mapKey}': Figma prop '${cp.orig}' (${cp.def.type}) is not mapped`, { mapKey, prop: pn });

    for (const [pn, mp] of Object.entries(mapProps)) {
      const cp = catProps[pn]; if (!cp || catAmbiguous.has(pn) || mapAmbiguous.has(pn)) continue; // ambiguous base (either side) -> already warned, don't emit order-dependent errors
      const prop = mp.prop;
      const kind = prop.kind, expected = TYPE_TO_KIND[cp.def.type];
      if (expected && kind && kind !== expected) { push(errors, "kind-mismatch", `'${mapKey}'.props.${mp.orig}: map kind '${kind}' but Figma type is ${cp.def.type} (expected '${expected}')`, { mapKey, prop: pn }); continue; }
      if (prop.kind === "enum") {
        const values = prop.values || {};
        if (!Array.isArray(cp.def.options)) { push(warnings, "no-variant-options", `'${mapKey}'.props.${mp.orig}: component exposes no variant options — enum values can't be verified`, { mapKey, prop: pn }); continue; }
        for (const opt of Object.keys(values)) if (!cp.def.options.includes(opt)) push(errors, "unknown-variant-value", `'${mapKey}'.props.${mp.orig}: maps option '${opt}' that is not a Figma variant option`, { mapKey, prop: pn });
        for (const opt of cp.def.options) if (!(opt in values)) push(warnings, "unmapped-variant-value", `'${mapKey}'.props.${mp.orig}: variant option '${opt}' has no code mapping (will be omitted)`, { mapKey, prop: pn });
      }
    }
  }

  // Double-mapping: two entries targeting one component is conflicting drift.
  for (const [comp, keys] of compToEntries) if (keys.length > 1) push(errors, "double-mapped", `component '${comp.name}' is mapped by ${keys.length} entries (${keys.join(", ")}) — only one code target may win`, { keys });

  // Coverage: a component is unmapped iff none of its identifiers were matched. The denominator is
  // counted in this same pass — a second filter over `comps` would just re-apply the same predicate.
  let catalogComponents = 0;
  for (const c of comps) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    catalogComponents++;
    if ((c.key && mappedIds.has(c.key)) || (c.id && mappedIds.has(c.id))) continue;
    push(warnings, "unmapped-component", `component '${c.name}'${c.key ? " (key " + c.key + ")" : " (unpublished — no key)"} has no map entry`, { ...ifDefined("key", c.key), name: c.name });
  }

  // `mapped` stays "components of the named catalog that have an entry" (so mapped <= catalogComponents);
  // entries that resolved in another catalog are counted on their own.
  let mapped = 0, mappedElsewhere = 0;
  for (const comp of compToEntries.keys()) if (inNamed.has(comp)) mapped++; else mappedElsewhere++;
  return { errors, warnings, freshness, summary: { entries: Object.keys(entries).length, catalogComponents, mapped, mappedElsewhere, errorCount: errors.length, warningCount: warnings.length } };
}
/** A catalog row as this linter reads it (components.local.json / design-system.json `components[]`). */
type CatalogEntry = ComponentsCatalog["components"][number];

/** How long the opt-in live meta check may take before it is abandoned (a warning, never a hang). */
const LIVE_META_TIMEOUT_MS = 10_000;

/** checkLiveFreshness() result: Figma's own `last_modified` for the file, if the meta endpoint answered. */
export interface LiveFreshness { lastModified: string | undefined; aheadOfSnapshot: boolean | undefined }

// Strictly opt-in live check: GET /v1/files/:key/meta (Tier 3, ~10/min even on free files) and compare
// Figma's own `last_modified` against the snapshot's `exportedAt`. Skipped WITHOUT ERROR whenever a
// token or file key is absent — this repo deliberately never requires a REST token, so the offline
// exportedAt/maxAge check above must carry the whole guarantee on its own; this is only a sharper
// answer when the caller happens to have credentials lying around.
async function checkLiveFreshness(fileKey: string | undefined, token: string | undefined, exportedAt: string | null | undefined): Promise<LiveFreshness | null> {
  if (!fileKey || !token) return null; // opt-in: nothing configured, nothing attempted
  // A hung connection must not hold the CLI open: the whole request gets LIVE_META_TIMEOUT_MS, then the
  // caller's catch turns the TimeoutError into the usual "could not verify" warning.
  const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/meta`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(LIVE_META_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /v1/files/${fileKey}/meta -> ${res.status} ${res.statusText}`);
  // The REST response is arbitrary JSON: only `file.last_modified` (an ISO string) is read.
  const body: unknown = await res.json();
  const lastModified = isJsonObject(body) && isJsonObject(body.file) && typeof body.file.last_modified === "string" ? body.file.last_modified : undefined;
  if (!lastModified) return { lastModified: undefined, aheadOfSnapshot: undefined };
  const aheadOfSnapshot = exportedAt ? Date.parse(lastModified) > Date.parse(exportedAt) : undefined;
  return { lastModified, aheadOfSnapshot };
}

// ---------------------------------------------------------------- coverage of a SCREEN
//
// driftLint's own coverage number is the catalog measured against the map — which on the live run
// printed "318/318 components mapped · 0 error(s)" for a map that covered 0% of the screen about to be
// built (finding 65). Both numbers were true and neither answered the question a builder is asking.
//
// This one does: of the components actually placed on the screen, how many can you reuse? It keys on
// the instance's mainComponent set key (a screen using six Button variants is ONE component to map),
// and it deliberately reports zero as an error rather than as an empty success.

interface UsedSet { setName: string; instances: number; hiddenInstances: number; key: string; variantKey: string | undefined }

function screenCoverage(map: CodeConnectMap | null | undefined, catalog: ComponentsCatalog | null | undefined, screenDocs: ReadonlyArray<ScreenDoc | null | undefined> | null | undefined): ScreenCoverage {
  const entries = (map && map.components) || {};
  const mapKeys = new Set<string>();
  for (const [k, entry] of Object.entries(entries)) {
    const f: Partial<MapEntry["figma"]> = entry.figma || {};
    if (f.key) mapKeys.add(f.key);
    if (f.id) mapKeys.add(f.id);
    mapKeys.add(k);
  }
  const catKeys = new Set(((catalog && catalog.components) || []).map((c) => c.key).filter((k): k is string => !!k));

  // Counted over EVERY instance in the export, as before — but each set also records how many of its
  // instances sit on layers the designer switched off (hidden.ts's predicate), so the headline can say
  // how many of "the components on this screen" will never be built at all (livetest-3: 45 of Global
  // Policies' 87 instances are hidden).
  const used = new Map<string, UsedSet>(); // set key -> { setName, instances, hiddenInstances }
  for (const doc of screenDocs || []) {
    for (const r of screenRoots(doc)) walkWithHidden(r, (n, c) => {
      if (n.type !== "INSTANCE" || !n.mainComponent) return;
      const mc = n.mainComponent;
      const id = mc.setKey || mc.key;
      if (!id) return;
      const u = getOrInit(used, id, () => ({ setName: mc.setName || mc.name, instances: 0, hiddenInstances: 0, key: id, variantKey: mc.key }));
      u.instances++;
      if (c.hidden) u.hiddenInstances++;
    });
  }

  const rows = [...used.values()].map((u) => ({
    ...u,
    inCatalog: catKeys.has(u.key) || (!!u.variantKey && catKeys.has(u.variantKey)),
    inMap: mapKeys.has(u.key) || (!!u.variantKey && mapKeys.has(u.variantKey)),
  }));
  const instances = rows.reduce((n, r) => n + r.instances, 0);
  const hiddenInstances = rows.reduce((n, r) => n + r.hiddenInstances, 0);
  const hiddenOnly = rows.filter((r) => r.instances === r.hiddenInstances).length;
  const inCatalog = rows.filter((r) => r.inCatalog).length;
  const inMap = rows.filter((r) => r.inMap).length;
  return {
    distinct: rows.length,
    instances,
    hiddenInstances,
    hiddenOnly,
    inCatalog,
    inMap,
    catalogPct: rows.length ? Math.round((inCatalog / rows.length) * 100) : null,
    mapPct: rows.length ? Math.round((inMap / rows.length) * 100) : null,
    unmapped: rows.filter((r) => !r.inMap).map((r) => ({ setName: r.setName, key: r.key, instances: r.instances })),
  };
}

// validateMap is re-exported so the MCP server's lazily-loaded drift-lint layer (bridge/src/figma-mcp.ts
// DriftLintModule) can apply the same map gate as the CLI below from this one module.
export { driftLint, discoverExtraCatalogs, validateMap, screenCoverage, checkFreshness, checkLiveFreshness, DEFAULT_MAX_AGE_MS };

// The CLI's inputs are files the user named. The MAP goes through map-validate.ts's full validator
// (below): the old "is it an object" guard let {"components":{"X":null}} through to driftLint, which
// died on it with a TypeError and a stack. The catalog and the screens are checked by their
// doc-guards.ts / export-shape.ts guards as they are read — a wrong file is a one-line error, exit 2.

// CLI: node design-to-code/drift-lint.ts <codeconnect.local.json> <design-system/components.local.json>
//        [--screen design/pages/<Page>/<Screen>.json]... [--catalog <components.json>]... [--max-age <hours>]
// Beside the named catalog it also reads components.library.json in the same dir and every
// libraries/<dir>/components.json of the export (design-system-dir.ts readCatalogSet), and names them all.
// Exit: 1 for a lint error (map-invalid, orphaned-entry, …); 0% screen coverage and catalog-rekeyed are
// warnings with a question to confirm (owner decision D13) — they do not fail the run.
// The catalog argument is the SPLIT component file — design-system.json is a slim pointer manifest
// since the split and has no `components` array (see bridge/design-system-layout.js).
async function main(argv: string[]): Promise<number> {
  const USAGE = `usage: ${scriptCmd("drift-lint")} <map.json> <design-system/components.local.json> [--screen design/pages/<Page>/<Screen>.json]... [--catalog <components.json>]... [--max-age <hours>]`;
  // --screen is repeatable: a build usually spans a screen plus its modals, and the question
  // "how much of this can I reuse" is about all of them together.
  const OPTIONS = { "max-age": { type: "string" }, screen: { type: "string", multiple: true }, catalog: { type: "string", multiple: true }, help: { type: "boolean", short: "h" } } as const;
  const { values: flags, positionals } = cliParse("drift-lint", argv, OPTIONS, USAGE, 2, (args) => parseArgs({ args, options: OPTIONS, allowPositionals: true }));
  if (flags.help) { console.log(USAGE); return 0; }
  let maxAgeHours: number | undefined;
  if (flags["max-age"] !== undefined) {
    maxAgeHours = Number(flags["max-age"]);
    if (!(maxAgeHours > 0)) { console.error("--max-age expects a positive number of hours"); return 2; }
  } else if (process.env.DRIFT_MAX_AGE_HOURS) {
    maxAgeHours = Number(process.env.DRIFT_MAX_AGE_HOURS);
    if (!(maxAgeHours > 0)) { console.error("DRIFT_MAX_AGE_HOURS expects a positive number of hours"); return 2; }
  }
  const maxAgeMs = maxAgeHours ? maxAgeHours * 3600000 : undefined;
  const screenFiles: string[] = flags.screen || [];

  const [mapFile, catalogFile] = positionals;
  if (!mapFile || !catalogFile) { console.error(USAGE); return 2; }
  const catalog = readSplitFile(catalogFile, "component catalog", isComponentsCatalog, "components", "design-system/components.local.json",
    NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  const mapRaw = readJsonFile(mapFile, "component map", `Scaffold one with \`${scriptCmd("map-bootstrap")} <components.local.json> --out codeconnect.local.json\`.`);
  // Validate BEFORE linting: driftLint trusts the map's shape. Printed like the lint's own errors,
  // one per line, and exit 1 — the same code a lint error gets (2 is kept for usage mistakes).
  const valid = validateMap(mapRaw);
  if (!valid.ok) {
    valid.errors.forEach((e) => console.error(`ERROR  [map-invalid] ${mapFile}: ${e.path || "(root)"}: ${e.message}`));
    console.error(`\n${mapFile} is not a valid component map (${valid.errors.length} error(s)) — fix it, or check it with \`${scriptCmd("map-validate")} ${mapFile}\`.`);
    return 1;
  }
  if (!isCodeConnectMap(mapRaw)) return 1; // unreachable: validateMap just passed (isCodeConnectMap IS that check)
  const map = mapRaw;
  const sources = readCatalogSet(catalogFile, catalog, flags.catalog || [], screenFiles[0],
    (f) => console.error(`warn   [catalog-unreadable] ${f} is not a readable component catalog — skipped (map entries that live only there will show as orphaned).`));
  console.error(catalogSetLine(sources));
  const extraCatalogs = sources.slice(1).map((x) => ({ file: x.file, catalog: x.catalog }));
  const union = unionCatalog(sources);
  const res = driftLint(map, catalog, { ...ifDefined("maxAgeMs", maxAgeMs), extraCatalogs });
  res.errors.forEach((e) => console.error(`ERROR  [${e.code}] ${e.message}`));
  res.warnings.forEach((w) => console.error(`warn   [${w.code}] ${w.message}`));
  const s = res.summary;
  console.error(`\n${s.mapped}/${s.catalogComponents} components mapped${s.mappedElsewhere ? ` (+${s.mappedElsewhere} map entr${s.mappedElsewhere === 1 ? "y" : "ies"} resolved in the other catalog(s))` : ""} · ${s.errorCount} error(s), ${s.warningCount} warning(s)`);
  console.error(`      (that number is the CATALOG measured against the map — it says nothing about any particular screen.)`);

  // The number a builder is actually asking for. Printed last, because it is the headline.
  if (screenFiles.length) {
    const read = screenFiles.map((f) => ({ file: f, doc: readDocFile(f, "screen export", isScreenDoc) }));
    const docs = read.map((r) => r.doc);
    const cov = screenCoverage(map, union, docs); // "in the catalog" = in ANY catalog read
    if (!cov.distinct) {
      console.error(`\nSCREEN COVERAGE: the given screen export(s) contain no INSTANCE nodes — nothing to reuse either way.`);
    } else {
      console.error(
        `\nSCREEN COVERAGE: ${cov.inMap}/${cov.distinct} (${cov.mapPct}%) of the component sets placed on this screen are in your map (by component key)` +
          ` · ${cov.inCatalog}/${cov.distinct} (${cov.catalogPct}%) are even in the catalog` +
          ` · ${cov.instances} instance(s) total, ${cov.hiddenInstances} of them on hidden layers` +
          (cov.hiddenOnly ? ` (${cov.hiddenOnly} set(s) appear ONLY on hidden layers and will not be built)` : "")
      );
      console.error(`       (this says which components you can REUSE by key — not which ones the build contains; that is verify's job.)`);
      // 0% by key is also exactly what a DUPLICATED design-system file looks like — every key re-minted,
      // every name and prop signature intact (livetest-3 #226). Tell the two cases apart before
      // pointing the user at "the wrong library".
      const none: VisibleInstance[] = [];
      // D13: both 0% cases are a WARNING with a question to confirm (as cross-check's catalog-rekeyed /
      // catalog-covers-nothing are) — "you exported the wrong library" has a default (build every
      // instance as new) and is the user's call, not a failed lint. Exit stays 0 for them.
      // Re-key is a question about the NAMED catalog (cross-check asks it the same way): the other catalogs
      // are passed as its `library` side — a sampled third-party row matching by key is not the design
      // system's own component, and must not hide that the named catalog was re-keyed.
      const others: ComponentsCatalog = { components: extraCatalogs.flatMap((x) => x.catalog.components) };
      const rekey = cov.mapPct === 0 ? matchByNameAndSignature(none.concat(...read.map((r) => visibleInstances(r.doc, r.file))), catalog, others) : null;
      if (cov.mapPct === 0 && rekey && isRekeyed(rekey)) {
        console.error(
          `warn   [catalog-rekeyed] NONE of the ${cov.distinct} components on this screen resolve to your map or catalog by key — but ` +
            `${rekey.summary.proposed} of the ${rekey.summary.withCandidates} visible component name(s) that exist in the catalog also match it by prop signature.\n` +
            `       That is the SAME library under new keys (one of the Figma files is a duplicate, or the library was re-published), not a foreign one.\n` +
            `       Get the confirmation list with \`${scriptCmd("cross-check")} <screen.json> --design-system <dir> --out design/audit/<screen>.cross\`, have the user\n` +
            `       confirm it (set "confirmed": true per entry), then \`${scriptCmd("map-bootstrap")} <components.local.json> --out <map> --from-proposals design/audit/<screen>.cross.json\`.\n` +
            `       Confirm: ${rekey.summary.proposed} component(s) match the catalog by name and prop signature but not by key (a duplicated or re-published file) — are they the same components? Until confirmed, build every instance as new.`
        );
      } else if (cov.mapPct === 0) {
        console.error(
          `warn   [screen-coverage] NONE of the ${cov.distinct} components on this screen resolve to your map by key` +
            (cov.inCatalog ? ` (${cov.inCatalog} of them are in the catalog(s) read — \`${scriptCmd("map-bootstrap")} ${catalogFile} --screen <screen.json> --out <map>\` stubs those).\n` : `, nor to any catalog read.\n`) +
            `       The catalog you exported is not the library this screen is built from — a green "mapped" count above measures\n` +
            `       the catalog against itself. Open an instance in Figma and use "Go to main component" to find the owning file,\n` +
            `       then export it with \`dtwin pull --as-library "<name>"\` (CLI only — the MCP server has no library export).\n` +
            `       Confirm: is ${catalogFile}${extraCatalogs.length ? ` (or any of the ${extraCatalogs.length} other catalog(s) read)` : ""} the component library this screen is built from? Until confirmed, build every instance as new.`
        );
      } else if (cov.unmapped.length) {
        console.error(
          `warn   [screen-coverage] ${cov.unmapped.length} component(s) on this screen have no map entry: ` +
            cov.unmapped.slice(0, 6).map((u) => `'${u.setName}' (${u.instances}x)`).join(", ") + (cov.unmapped.length > 6 ? ", …" : "")
        );
      }
    }
  } else {
    console.error(`note   pass --screen <screen.json> to get the number that matters: how much of THAT screen your map covers.`);
  }

  // Strictly opt-in: only attempted when both are present, and any failure is a warning, never a
  // crash — this check is a bonus on top of the offline exportedAt/maxAge guarantee above, not a
  // replacement for it.
  const fileKey = process.env.FIGMA_FILE_KEY;
  const token = process.env.FIGMA_TOKEN;
  if (fileKey && token) {
    try {
      const live = await checkLiveFreshness(fileKey, token, catalog.exportedAt);
      if (live && live.aheadOfSnapshot) console.error(`warn   [live-meta] the live Figma file was modified (${live.lastModified}) AFTER this snapshot was exported (${catalog.exportedAt}) — it is confirmed stale, not just old.`);
    } catch (e) {
      console.error(`warn   [live-meta] could not verify against the live file: ${errMsg(e)}`);
    }
  }
  // A rejection main() did not catch still crashes the process (it is not handled below).
  return res.errors.length ? 1 : 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; }); // exitCode, not exit(): every printed line flushes first
