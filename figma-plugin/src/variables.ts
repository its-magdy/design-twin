// Variables (design tokens) + Figma style references. Resolves opaque ids/aliases to the
// human/agent-readable token names — the key win over the REST export.
import { Obj, anyProp, rgbaToHex, nonEmpty } from "./util";
import { varName, styleNameLookup, getCollection } from "./state";

export async function resolveVar(alias: any): Promise<string | undefined> {
  if (!alias || alias.type !== "VARIABLE_ALIAS") return undefined;
  return varName(alias.id); // e.g. "color/primary" — the semantic token name
}

// Resolve any Figma boundVariables map -> { field: tokenName } (the key win over REST).
// Works for a node's bindings AND the sub-object bindings on effects, paints, gradient stops,
// styled-text runs, and component properties (each carries its own boundVariables map).
export async function resolveBoundMap(bound: any): Promise<Obj | undefined> {
  if (!bound) return undefined;
  const out: Obj = {};
  for (const key of Object.keys(bound)) {
    const val = bound[key];
    if (Array.isArray(val)) {
      const names = (await Promise.all(val.map(resolveVar))).filter(Boolean);
      if (names.length) out[key] = names.length === 1 ? names[0] : names;
    } else {
      const n = await resolveVar(val);
      if (n) out[key] = n;
    }
  }
  return nonEmpty(out);
}

// node.boundVariables -> { property: tokenName }
export async function boundTokens(node: SceneNode): Promise<Obj | undefined> {
  return resolveBoundMap((node as any).boundVariables);
}

// Per-node Figma STYLE references (fill/text/effect styles) — the pre-Variables way design
// systems name tokens; resolve the id to the style's name.
export async function styleName(id: string | PluginAPI["mixed"] | undefined | null): Promise<string | undefined> {
  if (!id || id === figma.mixed) return undefined;
  return styleNameLookup(id as string);
}

// [ node field, output key ]. textStyleId only exists on TEXT nodes, so the `in` check gates it.
const STYLE_FIELDS: Array<[string, string]> = [
  ["fillStyleId", "fill"],
  ["strokeStyleId", "stroke"],
  ["effectStyleId", "effect"],
  ["textStyleId", "text"],
  ["gridStyleId", "grid"], // a frame referencing a shared layout-grid style
];

export async function nodeStyles(node: SceneNode): Promise<Obj | undefined> {
  const names = await Promise.all(
    STYLE_FIELDS.map(([field]) => (field in node ? styleName(anyProp(node, field) as any) : Promise.resolve(undefined)))
  );
  const out: Obj = {};
  STYLE_FIELDS.forEach(([, key], i) => {
    if (names[i]) out[key] = names[i];
  });
  return nonEmpty(out);
}

// Resolve an opaque {collectionId: modeId} map -> { collectionName: modeName }. Both mode surfaces
// below share this: the remote-collection fallback and the modes lookup live in ONE place, so a
// future change (e.g. resolving mode.parentModeId for extended collections) can't be applied to one
// and missed on the other.
async function resolveModeMap(raw: { [collectionId: string]: string } | undefined, skipSingleMode: boolean): Promise<Obj | undefined> {
  if (!raw || !Object.keys(raw).length) return undefined;
  const out: Obj = {};
  for (const collectionId of Object.keys(raw)) {
    const c = await getCollection(collectionId);
    const modeId = raw[collectionId];
    if (!c || !Array.isArray(c.modes)) {
      out[collectionId] = modeId; // collection unreadable (remote) — keep raw ids over dropping the pin
      continue;
    }
    if (skipSingleMode && c.modes.length <= 1) continue; // no theme choice in a single-mode collection
    const m = c.modes.find((x) => x.modeId === modeId);
    out[c.name] = m ? m.name : modeId;
  }
  return nonEmpty(out);
}

// Which variable MODE(s) a subtree is pinned to (e.g. a card forced to "Dark" while the page
// is "Light") — the missing link for multi-theme codegen. Keyed off explicitVariableModes (the
// actual pin points set ON this node).
export function variableModes(node: SceneNode): Promise<Obj | undefined> {
  return resolveModeMap((node as any).explicitVariableModes, false);
}

// The EFFECTIVE variable mode per collection at this node, resolving pins inherited from ANY
// ancestor — including the PAGE — which explicitVariableModes (node-local pins only) misses. This is
// the fix for single-node exports ("paste a Figma link"): a card whose theme is pinned to "Dark" on
// its page reads the collection DEFAULT (Light) via explicitVariableModes alone, silently baking a
// Light build of a Dark design for value-baking targets (SwiftUI / Compose / RN, which resolve tokens
// at build time rather than cascading names at runtime like CSS). Emitted at the EXPORT ROOT only —
// every node inherits some effective mode, so per-node emission would be pure noise. Single-mode
// collections carry no theme choice, so they're skipped (only multi-mode/theming collections matter).
export function resolvedModes(node: SceneNode): Promise<Obj | undefined> {
  return resolveModeMap((node as any).resolvedVariableModes, true);
}

// valuesByMode does NOT resolve aliases and is keyed by opaque modeId — resolve alias targets to
// names and re-key by mode name. COLOR values carry alpha ({r,g,b,a}) — fold to hex so alpha survives.
async function resolveModeValue(v: VariableValue, resolvedType: VariableResolvedDataType): Promise<any> {
  const val = v as any;
  if (val && val.type === "VARIABLE_ALIAS") return { aliasOf: (await varName(val.id)) || val.id };
  if (resolvedType === "COLOR" && val && typeof val.r === "number") return rgbaToHex(val);
  return v;
}

export interface VariablesDump {
  collections: Array<{ name: string; modes: string[]; default?: string; theming: boolean; extended?: boolean; hiddenFromPublishing?: boolean; key?: string }>;
  variables: Obj[];
  hygiene: string[];
}

export async function dumpVariables(): Promise<VariablesDump> {
  const [collections, localVars] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  // ONE index keyed by collection id. Name, mode list and mode count are all derived from it, so
  // merging a referenced remote collection is a single insert — the four parallel maps this replaced
  // had to be written in lockstep, and missing one silently degraded the output (opaque mode ids).
  const collById = new Map<string, VariableCollection>(collections.map((c) => [c.id, c]));
  const collOf = (cid: string): VariableCollection | undefined => collById.get(cid);
  const localIds = new Set(localVars.map((v) => v.id));
  const variables: Obj[] = [];
  const hygiene: string[] = [];

  // Library (remote) variables this file CONSUMES. getLocalVariablesAsync returns only variables
  // defined in this file ("Returns all local variables in the current file" — Plugin API), but node
  // bindings resolve remote ones by id, so a file whose design system lives in a published library
  // would emit screens full of token names with no matching token definitions: the DTCG/CSS emitters
  // downstream would silently drop exactly the tokens the screens use. varName.ids() is the set of
  // variable ids anything in this run actually referenced — fetch the non-local ones by id and
  // include them, flagged remote:true. Collections/modes for them are resolved on demand below.
  // varName.obj() reads the run's memo cache — the walk ALREADY fetched each of these ids (that's how
  // they got into ids()) and kept only .name, so this reuses that object instead of paying a second
  // round trip per id. What remains is a cache read per id rather than the awaited-in-a-loop fetch
  // this replaced, which serialized hundreds of round trips at the end of every library-backed export.
  const referenced = varName.ids().filter((id) => !localIds.has(id));
  const remoteVars = ((await Promise.all(referenced.map((id) => varName.obj(id)))) as Array<Variable | null>)
    .filter(Boolean) as Variable[];

  // Merge each referenced remote collection so their values key by readable mode names
  // ("Light"/"Dark") rather than opaque mode ids. Independent id lookups — fetch them concurrently.
  const missingCollIds = [...new Set(remoteVars.map((v) => v.variableCollectionId).filter((cid) => cid && !collById.has(cid)))];
  for (const c of await Promise.all(missingCollIds.map((cid) => getCollection(cid)))) {
    if (c) collById.set(c.id, c);
  }
  // Built AFTER the merge so remote modes are included; first collection to claim a modeId wins,
  // which keeps local names ahead of library ones exactly as before.
  const allCollections = [...collById.values()];
  const modeName: { [modeId: string]: string } = {};
  for (const c of allCollections) for (const m of c.modes) if (!(m.modeId in modeName)) modeName[m.modeId] = m.name;
  // Everything we managed to resolve — local OR pulled in from a library above. An alias is only
  // genuinely BROKEN when its target is in neither set.
  const resolvedIds = new Set(localIds);
  for (const v of remoteVars) resolvedIds.add(v.id);
  if (remoteVars.length) {
    hygiene.push(
      remoteVars.length + " variable(s) referenced by this file come from a published LIBRARY, not this file — " +
        "included below with remote:true (getLocalVariablesAsync cannot enumerate them)"
    );
  }

  for (const v of localVars.concat(remoteVars)) {
    const values: Obj = {};
    let hasAlias = false;
    for (const modeId of Object.keys(v.valuesByMode)) {
      const raw = v.valuesByMode[modeId] as any;
      if (raw && raw.type === "VARIABLE_ALIAS") {
        hasAlias = true;
        // Was `!localIds.has(raw.id)`, which fired on every LEGITIMATE library alias once remote
        // variables started being resolved above — so a library-consuming file's hygiene list filled
        // with non-issues. Only report an alias whose target we genuinely could not resolve.
        if (!resolvedIds.has(raw.id)) hygiene.push("broken alias in '" + v.name + "' — target " + raw.id + " could not be resolved");
      }
      values[modeName[modeId] || modeId] = await resolveModeValue(raw, v.resolvedType);
    }
    const rec: Obj = {
      name: v.name,
      type: v.resolvedType,
      collection: (collOf(v.variableCollectionId) || ({} as VariableCollection)).name,
      // tier: alias => semantic; raw+meaningfully-scoped => semantic leaf; raw+unscoped => primitive.
      // ALL_SCOPES is Figma's default catch-all (it pollutes every picker — see the hygiene flag below),
      // so it does NOT count as a meaningful scope; otherwise almost every variable would read semantic.
      tier: hasAlias ? "semantic" : (v.scopes && v.scopes.some((s) => s !== "ALL_SCOPES")) ? "semantic" : "primitive",
      values,
    };
    if (v.scopes && v.scopes.length) rec.scopes = v.scopes;
    if (v.codeSyntax && Object.keys(v.codeSyntax).length) rec.codeSyntax = v.codeSyntax; // {WEB,ANDROID,iOS}
    if (v.description) rec.description = v.description; // token-intent annotation (Code Connect stand-in)
    if (v.remote) rec.remote = true;
    // Designer-marked private: hidden when publishing the file as a library. The DTCG emitter should
    // exclude/tag these rather than leak internal primitives into the public token API. Only meaningful
    // for local vars (the API guarantees it's false when remote).
    if (v.hiddenFromPublishing) rec.hiddenFromPublishing = true;
    // Durable cross-file identity (importVariableByKeyAsync) — rename-proof anchor for the tooling/ map +
    // drift-lint. Mirrors the component `key` precedent; present on local and published variables.
    if (v.key) rec.key = v.key;
    variables.push(rec);

    // Hygiene (all computable from what we already read):
    if (v.scopes && v.scopes.indexOf("ALL_SCOPES") !== -1) hygiene.push("ALL_SCOPES on '" + v.name + "' (pollutes every picker)");
    const modeCount = (collOf(v.variableCollectionId) || { modes: [] as VariableCollection["modes"] }).modes.length || 1;
    if (!hasAlias && v.resolvedType === "COLOR" && modeCount > 1) {
      hygiene.push("semantic color '" + v.name + "' holds a raw value in a multi-mode collection (breaks theming)");
    }
  }
  return {
    // Local collections plus any LIBRARY collection a referenced remote variable belongs to — the
    // token emitters need each collection's default mode to pick the `:root` value.
    collections: allCollections.map((c) => ({
      name: c.name,
      modes: c.modes.map((m) => m.name),
      // Which mode is the base/`:root` default (vs. the override theme) — codegen otherwise guesses.
      default: modeName[c.defaultModeId] || undefined,
      theming: c.modes.length > 1,
      // Extended collection (its modes inherit from a root collection via parentModeId) — codegen
      // should treat it as an override layer, not a standalone theme. Flag it; deep parent-mode
      // resolution (mode.parentModeId -> root mode) is deferred.
      extended: (c as any).isExtension === true ? true : undefined,
      hiddenFromPublishing: (c as any).hiddenFromPublishing === true ? true : undefined,
      key: (c as any).key || undefined, // durable cross-file collection identity
    })),
    variables,
    hygiene,
  };
}
