// Team-library discovery: WHICH published libraries this file consumes, and WHICH library components
// it actually uses.
//
// This module exists because the Plugin API's library surface is far narrower than people assume, and
// every one of those gaps is a place where a plausible-looking "library catalog" would be a lie:
//
//   * figma.teamLibrary has EXACTLY TWO methods — getAvailableLibraryVariableCollectionsAsync() and
//     getVariablesInLibraryCollectionAsync(key). There is NO getAvailableLibraryComponentsAsync.
//     Library MAIN COMPONENTS CANNOT BE ENUMERATED at all. The only route to them is walking the
//     INSTANCE nodes that are already in this file and calling instance.getMainComponentAsync().
//     Everything below follows from that: component counts are "used HERE", never "offered by the
//     library", and we say so in `note` rather than letting a caller read a number that means
//     something else than it looks like.
//   * Both teamLibrary methods require manifest permissions:["teamlibrary"]. A missing permission, a
//     plan without shared libraries, or simply no library enabled all surface here — the first two as
//     a THROW, the third as an empty array. An empty result is a NORMAL outcome (libraries can only be
//     enabled from the Figma UI, never via the API), so it becomes a warning line, never an error.
//   * Only VARIABLES carry a `libraryName`. Components carry none — there is no API that maps a
//     component key back to its source library. So an unattributed remote component is filed under
//     "unknown-library" and never guessed at; a user-maintained registry (see readRegistry) is the
//     only honest way to attribute them.
import { Obj, propName, errMsg, nonEmpty, exportedAt } from "./util";
import { warn, loadAllPages } from "./state";

// The bucket every remote component lands in until a registry says otherwise. Deliberately a visible,
// greppable string in the output rather than an omitted field: "I don't know" must be readable.
export const UNKNOWN_LIBRARY = "unknown-library";

// The user-maintained key -> library-name registry, stored as document plugin data. There is NO API
// that attributes a component key to its library (see the header), so this is the ONLY non-guessed
// source of attribution. Absent/garbage data degrades to "no attribution", never to an exception.
function readRegistry(sink: (m: string) => void): { [componentKey: string]: string } {
  try {
    const raw = (figma.root as any).getPluginData && (figma.root as any).getPluginData("libraryRegistry");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: { [k: string]: string } = {};
    for (const k of Object.keys(parsed)) if (typeof parsed[k] === "string" && parsed[k]) out[k] = parsed[k];
    return out;
  } catch (e) {
    sink("library registry (document pluginData 'libraryRegistry') is unreadable (" + errMsg(e) + ") — remote components stay unattributed");
    return {};
  }
}

// Every INSTANCE in the document. Same traversal discipline as collectComponentCatalog:
// skipInvisibleInstanceChildren makes findAllWithCriteria "several times faster in large documents"
// (Plugin API docs) and costs us nothing — a nested instance INSIDE a hidden instance adds no library
// component that its own top-level instance did not already contribute. Set and restored in `finally`
// because serialize() deliberately KEEPS hidden nodes: the flag must not leak into the node walk.
// A page that failed to load THROWS on findAllWithCriteria (dynamic-page access) — warn with the page
// name and keep going, exactly as the component catalog does. An empty result must never be
// indistinguishable from a document we could not read.
async function allInstances(sink: (m: string) => void): Promise<InstanceNode[]> {
  await loadAllPages("library component scan may be incomplete");
  const out: InstanceNode[] = [];
  const prevSkip = (figma as any).skipInvisibleInstanceChildren;
  try {
    try { (figma as any).skipInvisibleInstanceChildren = true; } catch (e) {}
    for (const page of figma.root.children) {
      try {
        out.push(...(page.findAllWithCriteria({ types: ["INSTANCE"] }) as InstanceNode[]));
      } catch (e) {
        sink("library scan: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") — its library components are missing");
      }
    }
  } finally {
    try { (figma as any).skipInvisibleInstanceChildren = prevSkip; } catch (e) {}
  }
  return out;
}

// One instance -> its main component, or null. getMainComponentAsync REJECTS on a detached/broken
// instance (and on a main that lives in a library the file can no longer reach), and a single such
// instance must not take the whole catalog down with it.
async function mainOf(inst: InstanceNode): Promise<ComponentNode | null> {
  try {
    return await (inst as any).getMainComponentAsync();
  } catch (e) {
    return null;
  }
}

// The display name of a main component. For a VARIANT, the useful name is the COMPONENT SET's
// ("Button"), not the variant's ("Size=md, State=hover").
// CRITICAL: for a REMOTE main, `.parent` MAY BE NULL (plugin-api.d.ts:6092 — a library component is
// not necessarily materialised inside a parent in this document). Optional-chaining it is not
// defensive padding, it is the documented shape. A crash here would have taken out the whole catalog
// for exactly the files this module exists to serve.
function mainNames(main: ComponentNode): { name: string; variantOf?: string } {
  const parent: any = (main as any).parent || null;
  if (parent && parent.type === "COMPONENT_SET") return { name: parent.name, variantOf: main.name };
  return { name: main.name };
}

// componentPropertyDefinitions THROWS on a variant ("Can only get component property definitions of a
// component set or non-variant component") — it is a getter, not a field, so merely READING it is the
// failure. Returns undefined for "unavailable", which is the caller's signal to fall back to observed
// instance props. Never conflate the two: an inferred option list is a SAMPLE, a definition list is
// COMPLETE, and downstream codegen that mistakes one for the other emits a type with missing cases.
function tryDefinitions(main: ComponentNode): Obj | undefined {
  try {
    const defs = (main as any).componentPropertyDefinitions;
    if (!defs || !Object.keys(defs).length) return undefined;
    const props: Obj = {};
    for (const k of Object.keys(defs)) {
      const d = defs[k];
      const p: Obj = { key: k, type: d.type };
      if (d.type === "VARIANT" && Array.isArray(d.variantOptions)) p.options = d.variantOptions;
      if (d.defaultValue !== undefined) p.default = d.defaultValue;
      if (d.type === "INSTANCE_SWAP" && Array.isArray(d.preferredValues) && d.preferredValues.length) {
        p.preferredValues = d.preferredValues.map((v: any) => ({ type: v.type, key: v.key }));
      }
      if (d.description) p.description = d.description;
      props[propName(k)] = p;
    }
    return nonEmpty(props);
  } catch (e) {
    return undefined;
  }
}

// Fallback attribution of a remote component's shape: aggregate `instance.componentProperties` (the
// per-instance RESOLVED props, already read at serialize.ts:110) across every instance sharing a main
// key. Three instances at Size=sm/md/lg tell us those three options EXIST; they cannot tell us whether
// an "xl" also exists. Hence `derivedFrom:"instances"` on the entry and `observed` (not `options`) as
// the field name — the vocabulary itself has to stop a caller treating a sample as an enum.
function aggregateFromInstances(instances: InstanceNode[]): Obj | undefined {
  const props: Obj = {};
  for (const inst of instances) {
    let cp: any;
    try { cp = (inst as any).componentProperties; } catch (e) { continue; }
    if (!cp) continue;
    for (const k of Object.keys(cp)) {
      const v = cp[k];
      if (!v) continue;
      const name = propName(k);
      const p = props[name] || (props[name] = { key: k, type: v.type, observed: [] as any[] });
      // Values are primitives (string/boolean) for VARIANT/TEXT/BOOLEAN and a component key for
      // INSTANCE_SWAP — all safely comparable with indexOf. Uniqued so an option list of 3 does not
      // become a list of 300 on a file with 300 buttons.
      if (v.value !== undefined && p.observed.indexOf(v.value) === -1) p.observed.push(v.value);
    }
  }
  return nonEmpty(props);
}

// ---------------------------------------------------------------- the catalog
// Every LIBRARY (remote) component this file uses, deduped by publish key.
// Deduped by `.key` and NOT by name: two libraries can ship a "Button", and a component that was
// renamed in the library still has to merge with its older instances. The key is the durable identity.
export async function collectLibraryComponents(sinkIn?: (m: string) => void): Promise<Obj[]> {
  const sink = sinkIn || warn;
  const registry = readRegistry(sink);
  const instances = await allInstances(sink);
  // One awaited getMainComponentAsync per instance, serialized, is a round trip per instance — a
  // design-system file has thousands. Fan them out in one batch, the same fix the component catalog's
  // boundVariables lookups got.
  const mains = await Promise.all(instances.map((i) => mainOf(i)));

  // key -> { main, instances[] }. Built first so aggregateFromInstances sees ALL instances of a key.
  const byKey = new Map<string, { main: ComponentNode; instances: InstanceNode[] }>();
  let unkeyed = 0;
  for (let i = 0; i < instances.length; i++) {
    const main = mains[i];
    if (!main) continue;
    if (!(main as any).remote) continue; // local mains are already in collectComponentCatalog
    const key = (main as any).key;
    if (!key) { unkeyed++; continue; } // a remote main with no publish key cannot be deduped or mapped
    const bucket = byKey.get(key);
    if (bucket) bucket.instances.push(instances[i]);
    else byKey.set(key, { main, instances: [instances[i]] });
  }
  if (unkeyed) sink(unkeyed + " remote component instance(s) have a main component with no publish key — omitted from the library catalog");

  const out: Obj[] = [];
  for (const [key, bucket] of byKey) {
    const names = mainNames(bucket.main);
    const entry: Obj = {
      name: names.name,
      key,
      type: "COMPONENT",
      remote: true,
      source: registry[key] || UNKNOWN_LIBRARY,
      uses: bucket.instances.length, // how many instances of it are in THIS file
    };
    if (names.variantOf) entry.variant = names.variantOf;
    if ((bucket.main as any).description) entry.description = (bucket.main as any).description;
    const defs = tryDefinitions(bucket.main);
    if (defs) {
      entry.props = defs;
      entry.derivedFrom = "definitions";
    } else {
      const observed = aggregateFromInstances(bucket.instances);
      if (observed) entry.props = observed;
      // Stamped even when there are no props at all: "we fell back" is itself the information.
      entry.derivedFrom = "instances";
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- the cheap discovery call
// Variable collections per enabled library. Wrapped whole: a missing "teamlibrary" permission and a
// plan without shared libraries BOTH throw here, and neither is a reason to fail the call — the
// component half below works regardless and is the half that needs no permission at all.
async function libraryVariableCollections(sink: (m: string) => void): Promise<Map<string, Obj[]>> {
  const byLibrary = new Map<string, Obj[]>();
  let collections: Array<{ name: string; key: string; libraryName: string }> = [];
  try {
    collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
  } catch (e) {
    sink(
      "team-library variables unavailable (" + errMsg(e) + ") — needs manifest permissions:[\"teamlibrary\"] " +
        "and a plan with shared libraries; library COMPONENTS below are unaffected"
    );
    return byLibrary;
  }
  if (!collections || !collections.length) {
    // NOT an error. Libraries can only be enabled from the Figma UI (Assets > Libraries), never via
    // the API, so "none enabled" is the default state of a fresh file and must read as such.
    // Scoped to what this call actually answers. Worded as a flat "no libraries are enabled" it
    // contradicted the "LIBRARIES (2)" printed immediately below, whose rows come from the COMPONENT
    // side and from this file itself (live finding 17) — two true statements that read as one lie.
    sink(
      "no team libraries are enabled for this file, so no library VARIABLE collections are listed — " +
        "any rows below come from this file itself or from components it consumes. Enable libraries in " +
        "Figma (Assets > Libraries) if you expected more; an empty list here is normal, not a failure"
    );
    return byLibrary;
  }
  // Independent per-collection reads — fan out rather than paying one round trip per collection.
  const counts = await Promise.all(
    collections.map(async (c) => {
      try {
        const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
        return vars ? vars.length : 0;
      } catch (e) {
        // One unreadable collection must not zero out the rest — count omitted, reason said out loud.
        sink("library collection '" + c.name + "': variables could not be listed (" + errMsg(e) + ") — count omitted");
        return undefined;
      }
    })
  );
  for (let i = 0; i < collections.length; i++) {
    const c = collections[i];
    const lib = c.libraryName || UNKNOWN_LIBRARY;
    const entry: Obj = { key: c.key, name: c.name };
    if (counts[i] !== undefined) entry.variableCount = counts[i];
    const list = byLibrary.get(lib);
    if (list) list.push(entry);
    else byLibrary.set(lib, [entry]);
  }
  return byLibrary;
}

// The CHEAP discovery call: which libraries feed this file, so a caller can decide what to pull.
// Deliberately NOT part of an export — it is the "what's out there?" map, the twin of listPages.
export async function listLibraries(): Promise<Obj> {
  const warnings: string[] = [];
  const sink = (m: string) => warnings.push(m);

  // The two halves are independent (variables need a permission, components need a document walk), so
  // run them together — and so that a throw in one cannot mean "no libraries" for the other.
  const [varsByLibrary, components] = await Promise.all([
    libraryVariableCollections(sink),
    collectLibraryComponents(sink).catch((e) => {
      sink("library component scan failed (" + errMsg(e) + ") — component counts are missing, variable collections below are unaffected");
      return [] as Obj[];
    }),
  ]);

  // Component counts per attributed source. Components carry NO library name (there is no such API),
  // so unless the registry attributed them they all land in one "unknown-library" bucket. Bucketing
  // them under a plausible-looking library name would be a guess, and a guess here is worse than a
  // blank: it invites a caller to "pull the rest of that library", which cannot be done at all.
  const compBySource = new Map<string, number>();
  for (const c of components) compBySource.set(c.source, (compBySource.get(c.source) || 0) + 1);

  const libraries: Obj[] = [];

  // The local file first — it is a "library" from the consumer's point of view (its own variables and
  // components), and listing it makes the remote entries interpretable by contrast.
  const localCollections: Obj[] = [];
  try {
    const [colls, vars] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);
    const perColl = new Map<string, number>();
    for (const v of vars) perColl.set(v.variableCollectionId, (perColl.get(v.variableCollectionId) || 0) + 1);
    for (const c of colls) localCollections.push({ key: (c as any).key || c.id, name: c.name, variableCount: perColl.get(c.id) || 0 });
  } catch (e) {
    sink("local variable collections could not be listed (" + errMsg(e) + ")");
  }
  libraries.push({
    key: (figma as any).fileKey || "local",
    name: (figma.root && figma.root.name) || "(this file)",
    kind: "local",
    variableCollections: localCollections,
    componentCount: undefined, // local components are enumerated properly by the design-system catalog
    note: "this file — its local components are listed in full by the design-system export, not counted here",
  });

  const seenSources = new Set<string>();
  for (const [libName, collections] of varsByLibrary) {
    seenSources.add(libName);
    const componentCount = compBySource.get(libName);
    libraries.push({
      key: collections.length ? collections[0].key : libName, // libraries themselves have no key — a collection key is the closest stable handle
      name: libName,
      kind: "library",
      variableCollections: collections,
      componentCount,
      note:
        componentCount === undefined
          ? "variable collections are complete; component attribution is impossible via the API — any components from this library are counted under '" + UNKNOWN_LIBRARY + "'"
          : "componentCount counts components USED IN THIS FILE (attributed by the local registry), not everything the library offers — library components cannot be enumerated",
    });
  }
  // Sources that came only from components (the normal case: everything unattributed).
  for (const [source, count] of compBySource) {
    if (seenSources.has(source)) continue;
    libraries.push({
      key: source,
      name: source,
      kind: "library",
      variableCollections: [],
      componentCount: count,
      note:
        source === UNKNOWN_LIBRARY
          ? "components consumed from published libraries that the API cannot attribute to a source (only VARIABLES carry a libraryName). componentCount counts DISTINCT components USED IN THIS FILE, not what any library offers."
          : "componentCount counts components USED IN THIS FILE (attributed by the local registry), not everything the library offers",
    });
  }

  return { exportedAt: exportedAt(), file: (figma.root && figma.root.name) || undefined, libraries, warnings };
}

// No test-surface global here: main.ts imports listLibraries/collectLibraryComponents and exposes
// them on the single `__designExport` namespace alongside every other entry point. A second global
// registered from this module would be a parallel surface for the harness to keep in sync — and the
// repo has already paid for parallel lists of the same thing once (see bridge/read-opts.js).
