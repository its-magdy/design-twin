// map-bootstrap.ts — scaffold a codeconnect.local.json from the extractor's component catalog.
//
// The free-plan equivalent of `figma connect create`: pre-fills every component (keyed by its stable
// publish key) with its real props translated to the transform vocabulary, marked status:"needs-review".
//
// Merge semantics (safe by default — NEVER destroys human work):
//   - An existing entry (ANY status) is PRESERVED; only advisory figma metadata is refreshed and newly-
//     appeared props are added. Existing prop mappings are never overwritten (drift-lint reports prop drift).
//   - An existing entry whose component is absent from the catalog is KEPT, not dropped (drift-lint's
//     `orphaned-entry` surfaces it loudly — bootstrap must not silently delete it).
//   - Only genuinely new components get a fresh needs-review stub.
// The `existing` argument is never mutated (entries are deep-cloned).
import fs from "node:fs";
import type {
  BooleanPropMap, CatalogComponent, CodeConnectMap, ComponentPropDef, ComponentProposal, ComponentsCatalog, EnumPropMap, MapEntry, PropMap,
} from "./types.ts";
import { isJsonObject } from "./types.ts";
import { TYPE_TO_KIND as KIND } from "./kinds.ts"; // shared vocab — kept in sync with drift-lint
import { readDocFile, readJsonFile, readSplitFile, NO_DESIGN_SYSTEM_HINT } from "./catalog-input.ts";
import { isComponentsCatalog, isProposalList } from "./doc-guards.ts";
import { isScreenDoc } from "./export-shape.ts";
import { scriptCmd } from "./cli-args.ts";
import { visibleInstances } from "./component-match.ts";
import { isCodeConnectMap, validateMap } from "./map-validate.ts";
import { readCatalogSet, unionCatalog, catalogSetLine } from "./design-system-dir.ts";
import { isMainFallback } from "../bridge/src/is-main.ts"; // import.meta.main is undefined before Node 24.2
import { nullProto } from "../bridge/src/json-util.ts";
import { writeJsonLike } from "../bridge/src/json-file.ts";

const clone = <T>(o: T): T => structuredClone(o);

// Object.assign(plain-object-target, …sources) invokes the inherited __proto__ SETTER when a source has
// an OWN property literally named "__proto__" — which JSON.parse can produce (`{"__proto__":{...}}`
// is a real own, enumerable property on the parsed object, not a prototype link) — repointing the
// TARGET's prototype instead of copying a normal property (verified: an assigned {} ends up with a
// polluted object as its own [[Prototype]]). safeAssign copies each source's own enumerable keys one at
// a time and skips the three names that could repoint or shadow a prototype, so the merged object keeps
// a normal Object.prototype and drops the hostile key entirely — appropriate here because entry.figma
// is a fixed-shape record (key/id/name/unstable), not a map keyed by untrusted names.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function safeAssign<T extends object, U extends object, V extends object>(target: T, source1: U, source2: V): T & U & V {
  for (const src of [source1, source2]) {
    if (src === undefined || src === null) continue; // Object.assign skips null/undefined sources; mirror that
    for (const k of Object.keys(src)) {
      if (UNSAFE_KEYS.has(k)) continue;
      (target as Record<string, unknown>)[k] = (src as Record<string, unknown>)[k];
    }
  }
  return target as T & U & V;
}

// Split an arbitrary name into alphanumeric words (drops "/", punctuation, whitespace).
const words = (name: string | null | undefined): string[] => String(name || "").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

function pascal(name: string | null | undefined): string {
  // Join ALL "/" segments so "Button/Primary/Danger" keeps its namespace instead of collapsing to "Danger".
  const p = words(name).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "Component";
}
function camel(name: string | null | undefined): string {
  const base = String(name || "").split("/").pop() || ""; // camel keys off the LEAF segment only
  const p = words(base).map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join("");
  return /^[A-Za-z]/.test(p) ? p : "prop";
}

function propEntry(name: string, def: ComponentPropDef): PropMap | null {
  const kind = KIND[def.type];
  if (kind === "enum") {
    const values: Record<string, string> = {}; for (const opt of def.options || []) values[opt] = opt; // identity map to start
    const p: EnumPropMap = { kind, codeProp: camel(name), values };
    if (typeof def.default === "string" || typeof def.default === "number" || typeof def.default === "boolean") { p.default = def.default; p.omitDefault = true; }
    return p;
  }
  if (kind === "boolean") { const p: BooleanPropMap = { kind, codeProp: camel(name) }; if (def.default !== undefined) { p.default = !!def.default; p.omitDefault = true; } return p; }
  if (kind === "string") return { kind, codeProp: /label|text|title/i.test(name) ? "children" : camel(name) };
  if (kind === "instance") return { kind, slot: camel(name) };
  return null;
}

function freshEntry(c: CatalogComponent): MapEntry {
  const figma: MapEntry["figma"] = { name: c.name || c.key || c.id || "Unnamed" }; // figma.name must always be a string
  if (c.key) figma.key = c.key; else figma.unstable = true;
  if (c.id) figma.id = c.id;
  const entry: MapEntry = { figma, code: { module: "TODO: import path", export: pascal(c.name || "Component") }, status: "needs-review" };
  // props is keyed by an untrusted Figma property NAME — null-prototype so a property literally called
  // "__proto__" becomes an ordinary own key instead of repointing this object's prototype (see KEYS.prop
  // in map-validate.ts for the same reasoning). Serializes with JSON.stringify like any plain object.
  const props: Record<string, PropMap> = nullProto();
  const defs = c.props || {};
  for (const [pn, def] of Object.entries(defs)) { const pe = propEntry(pn, def); if (pe) props[pn] = pe; }
  if (Object.keys(props).length) entry.props = props;
  return entry;
}

function bootstrap(catalog: ComponentsCatalog | null | undefined, existing?: CodeConnectMap | null): CodeConnectMap {
  // components is a string-keyed map; use a null-prototype object so a component whose key/id is
  // literally "__proto__"/"constructor" becomes a real own entry instead of silently vanishing
  // (which would violate the "never destroys human work" contract). Serializes to JSON normally.
  const out: CodeConnectMap = { version: 1, components: nullProto() };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev: Record<string, MapEntry> = (existing && existing.components) || {};
  // Index prev entries by EVERY identifier they carry (their map key + figma.key + figma.id), so a
  // component that changes how it's identified (e.g. an id-keyed entry whose component later gains a
  // publish key) reuses its existing entry instead of producing a duplicate.
  const prevByIdent = new Map<string, string>();
  for (const [pk, pe] of Object.entries(prev)) {
    if (!prevByIdent.has(pk)) prevByIdent.set(pk, pk);
    const pf: Partial<MapEntry["figma"]> = pe.figma || {};
    if (pf.key && !prevByIdent.has(pf.key)) prevByIdent.set(pf.key, pk);
    if (pf.id && !prevByIdent.has(pf.id)) prevByIdent.set(pf.id, pk);
  }
  const usedPrev = new Set<string>();

  for (const c of (catalog && catalog.components) || []) {
    if (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET") continue;
    const id = c.key || c.id;
    if (!id) continue;
    // A node id is unique only within one Figma file: a keyed component must not take over an entry
    // that already names a DIFFERENT publish key just because the two share an id (a library "1:5" in a
    // map that also holds this file's "1:5") — that would re-point a hand-made mapping at another component.
    const keyClash = (x: string): boolean => {
      if (!c.key || x === c.key) return false;
      const pk = prevByIdent.get(x);
      const pkKey = pk ? (prev[pk]?.figma || {}).key : undefined;
      return !!pkKey && pkKey !== c.key;
    };
    const matchKey = [c.key, c.id, id].find((x) => x && prevByIdent.has(x) && !keyClash(x));
    const prevKey = matchKey ? prevByIdent.get(matchKey) : null;
    const prevEntry = prevKey ? prev[prevKey] : null;

    if (prevKey && prevEntry) { // prevEntry implies prevKey — spelled out for the type
      // Preserve ALL human work regardless of status — a `needs-review` stub can still carry half-
      // finished edits (a renamed export, mapped props) before its import path is filled, so we never
      // regenerate wholesale. Refresh only advisory metadata, add newly-appeared props, and regenerate
      // a prop whose Figma TYPE changed (its old mapping is definitionally invalid — the only safe
      // overwrite). A genuinely-stale stub is simply kept; drift-lint reports its staleness.
      usedPrev.add(prevKey);
      const entry = clone(prevEntry);
      entry.figma = safeAssign({}, entry.figma, { name: c.name || (entry.figma && entry.figma.name) || "Unnamed" });
      if (c.id) entry.figma.id = c.id;
      if (c.key) entry.figma.key = c.key; else if (!entry.figma.key) entry.figma.unstable = true;
      // Rebuild props on a null-proto object (see freshEntry) — a catalog prop literally named
      // "__proto__" must not repoint this object's prototype when written below.
      const props: Record<string, PropMap> = nullProto();
      if (entry.props) Object.assign(props, entry.props); // safe: props has no prototype to hijack
      entry.props = props;
      const defs = c.props || {};
      for (const [pn, cdef] of Object.entries(defs)) {
        const kind = KIND[cdef.type], ex = props[pn];
        if (!ex || (kind && ex.kind && ex.kind !== kind)) { const pe = propEntry(pn, cdef); if (pe) props[pn] = pe; }
      }
      if (!Object.keys(props).length) delete entry.props;
      // An entry filed under a key that is NOT one of this component's own identifiers was put there on
      // purpose — a confirmed re-key proposal is filed under the SCREEN's instance key (the catalog's
      // key was re-minted by a file duplication) so an instance lookup finds it. Keep it
      // there; moving it to the catalog key would silently unmap every instance again.
      out.components[prevKey !== c.key && prevKey !== c.id ? prevKey : id] = entry;
    } else {
      out.components[id] = freshEntry(c);
    }
  }

  // Keep existing entries whose component is genuinely absent from the catalog (drift-lint's
  // orphaned-entry surfaces them) — never silently delete human work.
  for (const [pk, pe] of Object.entries(prev)) if (!usedPrev.has(pk) && !(pk in out.components)) out.components[pk] = clone(pe);
  return out;
}

export interface ProposalsReport { confirmed: number; added: number; kept: number; skipped: string[] }

// Stubs for CONFIRMED name+prop-signature matches only (cross-check.ts `componentProposals`, see
// component-match.ts). Why a separate path: when a file was duplicated, 0 of the screen's instance
// keys are in the catalog, and a full bootstrap wrote 318 stubs of which none was on the screen
// — a list nobody can evaluate. Here every stub is one the user already said yes
// to, filed under the screen's OWN instance key (what build-screen looks an instance up by), with
// figma.key/id pointing at the catalog component whose props it was matched on.
// Never auto-accepts: an entry without `confirmed: true` is skipped. Never overwrites: an existing
// entry under the same key is kept as it is.
// `others`: catalogs read beside `catalog` (libraries) — joined by publish KEY only, since a node id is
// unique only within one Figma file (a library's "1:5" is not this file's "1:5").
function bootstrapFromProposals(proposals: readonly ComponentProposal[] | null | undefined, catalog: ComponentsCatalog | null | undefined, existing?: CodeConnectMap | null, others?: ComponentsCatalog | null): { map: CodeConnectMap; report: ProposalsReport } {
  const out: CodeConnectMap = { version: 1, components: nullProto() };
  if (existing && existing.figmaFileKey) out.figmaFileKey = existing.figmaFileKey;
  const prev: Record<string, MapEntry> = (existing && existing.components) || {};
  for (const [pk, pe] of Object.entries(prev)) out.components[pk] = clone(pe);
  const comps = (catalog && catalog.components) || [];
  const report: ProposalsReport = { confirmed: 0, added: 0, kept: 0, skipped: [] };
  for (const p of proposals || []) {
    if (!p || p.confirmed !== true) continue;
    report.confirmed++;
    const want: { key?: string; id?: string } = p.catalog || {};
    // A proposal with a key is matched by that key ALONE (named catalog first, then the others): its id
    // may belong to another file, and a local component sharing it is unrelated. Only a keyless proposal
    // falls back to its id, and only in the named catalog (the file that id belongs to).
    const c = want.key
      ? comps.find((x) => x.key === want.key) || ((others && others.components) || []).find((x) => x.key === want.key)
      : want.id ? comps.find((x) => x.id === want.id) : undefined;
    const mapKey = (p.instanceKeys || [])[0];
    if (!c) { report.skipped.push(`'${p.name}': catalog component ${want.id || want.key || "?"} is not in this catalog`); continue; }
    if (!mapKey) { report.skipped.push(`'${p.name}': the proposal carries no instance key to file it under`); continue; }
    if (mapKey in out.components) { report.kept++; continue; }
    const entry = freshEntry(c);
    out.components[mapKey] = entry;
    report.added++;
    for (const extra of (p.instanceKeys || []).slice(1)) report.skipped.push(`'${p.name}': also used under instance key ${extra} — filed once, under ${mapKey}`);
  }
  return { map: out, report };
}

// A cross-check report, an audit report (its crossFile), or a bare array — of rows cross-check.ts wrote
// (a person only adds `confirmed: true` to them; doc-guards.ts isProposalList checks each is a row).
function proposalsIn(doc: unknown): ComponentProposal[] | null {
  if (isProposalList(doc)) return doc;
  if (isJsonObject(doc) && isProposalList(doc.componentProposals)) return doc.componentProposals;
  if (isJsonObject(doc) && isJsonObject(doc.crossFile) && isProposalList(doc.crossFile.componentProposals)) return doc.crossFile.componentProposals;
  return null;
}

export { bootstrap, bootstrapFromProposals, proposalsIn };

// CLI: node design-to-code/map-bootstrap.ts <design-system/components.local.json> [existing-map.json] [--out <file>]
// The catalog argument is the SPLIT component file, not design-system.json — that is a slim pointer
// manifest since the split and carries no `components` array (see bridge/src/design-system-layout.ts).
// Without --out the map goes to stdout. With --out it is written to that file; when the file already
// exists and no existing-map was named, it IS the existing map — so re-running merges into it (the
// "never destroys human work" semantics above) instead of replacing it with fresh stubs.
function main(argv: string[]): number {
  const usage = `usage: ${scriptCmd("map-bootstrap")} <design-system/components.local.json> [existing-map.json] [--out <file>] [--from-proposals <cross-check report.json>] [--screen <screen.json>] [--catalog <components.json>]...`;
  if (argv.includes("--help") || argv.includes("-h")) { console.log(usage); return 0; }
  let outFile: string | null = null, proposalsFile: string | null = null, screenFile: string | null = null;
  // --catalog is repeatable: each names one more catalog (beyond the ones found beside the named one)
  // that --screen / --from-proposals may take a component from.
  const extraCatalogFiles: string[] = [];
  for (let ci = argv.indexOf("--catalog"); ci !== -1; ci = argv.indexOf("--catalog")) {
    const next = argv[ci + 1];
    if (!next || next.startsWith("--")) { console.error("--catalog needs a component catalog .json (components.json / components.library.json)\n" + usage); return 1; }
    extraCatalogFiles.push(next);
    argv.splice(ci, 2);
  }
  const pi = argv.indexOf("--from-proposals");
  if (pi !== -1) {
    const next = argv[pi + 1];
    if (!next || next.startsWith("--")) { console.error("--from-proposals needs the JSON report the cross-check (or audit) script wrote with --out/--json\n" + usage); return 1; }
    proposalsFile = next;
    argv.splice(pi, 2);
  }
  const si = argv.indexOf("--screen");
  if (si !== -1) {
    const next = argv[si + 1];
    if (!next || next.startsWith("--")) { console.error("--screen needs a screen export .json\n" + usage); return 1; }
    screenFile = next;
    argv.splice(si, 2);
  }
  const o = argv.indexOf("--out");
  if (o !== -1) {
    const next = argv[o + 1];
    if (!next || next.startsWith("--")) { console.error("--out needs a file path\n" + usage); return 1; }
    outFile = next;
    argv.splice(o, 2);
  }
  const unknown = argv.find((a) => a.startsWith("--"));
  if (unknown) { console.error(`unknown option ${unknown}\n${usage}`); return 1; }
  const [catalogFile, existingArg] = argv;
  if (!catalogFile) { console.error(usage); return 1; }
  const catalog = readSplitFile(catalogFile, "component catalog", isComponentsCatalog, "components", "design-system/components.local.json",
    NO_DESIGN_SYSTEM_HINT + "\n       Or build without a component map: every instance then counts as new (build-screen, step 1).");
  // A screen's components often live in a library — the sampled components.library.json beside
  // the catalog, a pulled libraries/<dir>/components.json, a --catalog. --screen and --from-proposals take
  // components from all of them; a FULL bootstrap (neither flag) stays the named catalog alone, since
  // stubbing a whole library is again an unreviewable list.
  // The set is read ONLY for those two flags: a full bootstrap must not start failing (exit 2) on a
  // broken components.library.json it never uses.
  const sources = screenFile || proposalsFile ? readCatalogSet(catalogFile, catalog, extraCatalogFiles, screenFile ?? undefined,
    (f) => console.error(`map-bootstrap: warn  ${f} is not a readable component catalog — skipped`)) : [{ file: catalogFile, catalog, role: "named" as const }];
  const union = unionCatalog(sources);
  // Other catalogs' rows, without their node ids: an id is unique only within one Figma file, so a
  // library's "1:5" must neither be matched by id nor merge into an existing entry filed under this file's "1:5".
  const others: ComponentsCatalog = { components: unionCatalog(sources.slice(1)).components.filter((c) => !!c.key && !catalog.components.some((n) => n.key === c.key)).map(({ id: _foreignId, ...c }) => c) };
  if (screenFile || proposalsFile) console.error(`map-bootstrap: ${catalogSetLine(sources)}`);
  const existingFile = existingArg || outFile;
  // A person's map (hand-edited): bootstrap merges into it and REWRITES it, so it is validated first
  // and an invalid one is refused, untouched. Merging trusted the shape: an array `components` was
  // walked by index and written back as `{"0": …}`, silently destroying the person's work.
  const existingRaw = existingFile && fs.existsSync(existingFile) ? readJsonFile(existingFile, "existing map") : null;
  let existing: CodeConnectMap | null = null;
  if (existingRaw !== null) {
    const valid = validateMap(existingRaw);
    if (!valid.ok || !isCodeConnectMap(existingRaw)) {
      valid.errors.forEach((e) => console.error(`map-bootstrap: ${existingFile}: ${e.path || "(root)"}: ${e.message}`));
      console.error(`map-bootstrap: ${existingFile} is not a valid component map (${valid.errors.length} error(s)) — refusing to rewrite it. Fix it (\`${scriptCmd("map-validate")} ${existingFile}\`) or move it aside. Nothing was written.`);
      return 1;
    }
    existing = existingRaw;
  }
  if (proposalsFile) {
    const doc = readJsonFile(proposalsFile, "proposals report");
    const proposals = proposalsIn(doc);
    if (!proposals) { console.error(`map-bootstrap: ${proposalsFile} has no componentProposals — run \`${scriptCmd("cross-check")} <screen.json> --out <base>\` (or --json) and pass the JSON it wrote`); return 1; }
    const { map, report } = bootstrapFromProposals(proposals, catalog, existing, others);
    if (!report.confirmed) {
      console.error(`map-bootstrap: none of the ${proposals.length} proposal(s) in ${proposalsFile} is confirmed. Show the user the list, set "confirmed": true on each ` +
        `entry they accept, and re-run. Nothing was written — proposals are never accepted automatically.`);
      return 1;
    }
    const out = JSON.stringify(map, null, 2) + "\n";
    if (outFile) fs.writeFileSync(outFile, out); else process.stdout.write(out);
    for (const sk of report.skipped) console.error(`warn  ${sk}`);
    console.error(`map-bootstrap: ${report.confirmed} confirmed proposal(s) → ${report.added} new stub(s), ${report.kept} already mapped${outFile ? ` — wrote ${outFile}` : ""}`);
    return 0;
  }
  // A full bootstrap on a real catalog stubs EVERY component in the file (318 on the
  // live run) — a list nobody can evaluate, and none of them may even be on the screen the user is
  // about to build. When --screen is given, scope the catalog to the keys/ids that screen's own
  // VISIBLE instances actually reference first, so the "confirm the stubs" step is small and every
  // entry is one the screen actually needs. Run the screen-coverage/cross-check BEFORE this (the
  // skill's own ordering), then pass its screen json here.
  let scopedCatalog: ComponentsCatalog = catalog;
  if (screenFile) {
    const screenDoc = readDocFile(screenFile, "screen export", isScreenDoc);
    const used = new Set<string>();
    for (const i of visibleInstances(screenDoc, "screen")) {
      if (i.key) used.add(i.key);
      if (i.setKey) used.add(i.setKey);
    }
    const all = union.components;
    const fromNamed = catalog.components.filter((c) => (c.key && used.has(c.key)) || (c.id && used.has(c.id)));
    const fromLibs = others.components.filter((c) => c.key && used.has(c.key)); // by key only (see `others`)
    const scoped = [...fromNamed, ...fromLibs];
    scopedCatalog = safeAssign({}, catalog, { components: scoped });
    const fromOthers = fromLibs.length;
    console.error(`map-bootstrap: --screen scoped the catalog${sources.length > 1 ? `s` : ""} from ${all.length} to ${scoped.length} component(s) this screen actually uses` +
      (fromOthers ? ` (${fromOthers} of them from a library catalog).` : "."));
  }
  const written = bootstrap(scopedCatalog, existing);
  if (!outFile) {
    process.stdout.write(JSON.stringify(written, null, 2) + "\n");
  } else {
    writeJsonLike(outFile, written); // a person's hand-edited map: atomic, in its own format
    const entries = Object.values(written.components);
    const review = entries.filter((e) => e.status === "needs-review").length;
    console.error(`map-bootstrap: wrote ${outFile} — ${entries.length} component(s), ${review} needing review${existing ? " (merged into the existing map)" : ""}`);
  }
  return 0;
}

if (import.meta.main ?? isMainFallback(import.meta.url)) process.exitCode = main(process.argv.slice(2));
