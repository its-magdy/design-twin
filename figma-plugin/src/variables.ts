// Variables (design tokens) + Figma style references. Resolves opaque ids/aliases to the
// human/agent-readable token names — the key win over the REST export.
import type {
  TokenMap, StyleRefs, ModeMap, Variable as IrVariable, VariableCollection as IrVariableCollection, VariableValue as IrVariableValue,
  VariableAlias as IrVariableAlias, VariableComposedColor as IrVariableComposedColor,
} from "../../bridge/src/doc-types.ts";
import { anyProp, rgbaToHex, nonEmpty, putNonEmpty } from "./util";
import { varName, styleNameLookup, getCollection } from "./state";

// The one VARIABLE_ALIAS test. Takes `unknown` because it is fed from several untyped-at-runtime
// places (bound-variable maps, valuesByMode entries, nested per-property binding objects).
export function isVariableAlias(v: unknown): v is VariableAlias {
  return !!v && typeof v === "object" && "type" in v && v.type === "VARIABLE_ALIAS";
}

export async function resolveVar(alias: unknown): Promise<string | undefined> {
  if (!isVariableAlias(alias)) return undefined;
  return varName(alias.id); // e.g. "color/primary" — the semantic token name
}

// Resolve any Figma boundVariables map -> { field: tokenName } (the key win over REST).
// Works for a node's bindings AND the sub-object bindings on effects, paints, gradient stops,
// styled-text runs, and component properties (each carries its own boundVariables map).
// The shape shared by every per-type `boundVariables` map this is fed (node, paint, gradient stop,
// effect, style, text segment, component property). Node maps hold arrays for fills/strokes/effects/
// layoutGrids/text fields and a NESTED per-property object under `componentProperties`; the nested
// object is not an alias, so it resolves to nothing below — unchanged behaviour.
export type BoundVariableMap = {
  readonly [field: string]: VariableAlias | ReadonlyArray<VariableAlias> | { readonly [key: string]: VariableAlias } | undefined;
};

export async function resolveBoundMap(bound: BoundVariableMap | null | undefined): Promise<TokenMap | undefined> {
  if (!bound) return undefined;
  const out: TokenMap = {};
  for (const key of Object.keys(bound)) {
    const val = bound[key];
    if (Array.isArray(val)) {
      const names = (await Promise.all(val.map(resolveVar))).filter((x): x is string => !!x);
      if (names.length) out[key] = names.length === 1 ? names[0] : names;
    } else {
      const n = await resolveVar(val);
      if (n) out[key] = n;
    }
  }
  return nonEmpty(out);
}

// node.boundVariables -> { property: tokenName }
export async function boundTokens(node: SceneNode): Promise<TokenMap | undefined> {
  return resolveBoundMap(node.boundVariables);
}

// Per-node Figma STYLE references (fill/text/effect styles) — the pre-Variables way design
// systems name tokens; resolve the id to the style's name.
export async function styleName(id: string | PluginAPI["mixed"] | undefined | null): Promise<string | undefined> {
  if (!id || id === figma.mixed) return undefined;
  return styleNameLookup(id);
}

// [ node field, output key ]. textStyleId only exists on TEXT nodes, so the `in` check gates it.
const STYLE_FIELDS: Array<[string, keyof StyleRefs]> = [
  ["fillStyleId", "fill"],
  ["strokeStyleId", "stroke"],
  ["effectStyleId", "effect"],
  ["textStyleId", "text"],
  ["gridStyleId", "grid"], // a frame referencing a shared layout-grid style
];

export async function nodeStyles(node: SceneNode): Promise<StyleRefs | undefined> {
  const names = await Promise.all(
    STYLE_FIELDS.map(([field]) => {
      if (!(field in node)) return Promise.resolve(undefined);
      // Style-id fields are `string | figma.mixed`; styleName already returns undefined for mixed.
      const id = anyProp(node, field);
      return typeof id === "string" || id === figma.mixed ? styleName(id) : Promise.resolve(undefined);
    })
  );
  const out: StyleRefs = {};
  STYLE_FIELDS.forEach(([, key], i) => {
    const n = names[i];
    if (n) out[key] = n;
  });
  return nonEmpty(out);
}

// Resolve an opaque {collectionId: modeId} map -> { collectionName: modeName }. Both mode surfaces
// below share this: the remote-collection fallback and the modes lookup live in ONE place, so a
// future change (e.g. resolving mode.parentModeId for extended collections) can't be applied to one
// and missed on the other.
async function resolveModeMap(raw: { [collectionId: string]: string } | undefined, skipSingleMode: boolean): Promise<ModeMap | undefined> {
  if (!raw || !Object.keys(raw).length) return undefined;
  const out: ModeMap = {};
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
export function variableModes(node: SceneNode): Promise<ModeMap | undefined> {
  return resolveModeMap(node.explicitVariableModes, false);
}

// The EFFECTIVE variable mode per collection at this node, resolving pins inherited from ANY
// ancestor — including the PAGE — which explicitVariableModes (node-local pins only) misses. This is
// the fix for single-node exports ("paste a Figma link"): a card whose theme is pinned to "Dark" on
// its page reads the collection DEFAULT (Light) via explicitVariableModes alone, silently baking a
// Light build of a Dark design for value-baking targets (SwiftUI / Compose / RN, which resolve tokens
// at build time rather than cascading names at runtime like CSS). Emitted at the EXPORT ROOT only —
// every node inherits some effective mode, so per-node emission would be pure noise. Single-mode
// collections carry no theme choice, so they're skipped (only multi-mode/theming collections matter).
export function resolvedModes(node: SceneNode): Promise<ModeMap | undefined> {
  return resolveModeMap(node.resolvedVariableModes, true);
}

// A composed colour (typings 1.139, Update 139): {color, opacity} where the colour, the opacity or both
// are aliases. The only VariableValue member with an `opacity` key (RGB/RGBA/MotionEasing/VariableAlias
// have none), so this is the one test.
function isComposedColor(v: VariableValue): v is VariableComposedColor {
  return typeof v === "object" && "opacity" in v && "color" in v;
}
// Figma's two members are told apart by whether `color` is an alias; a guard narrows the whole union
// (a property check alone would narrow `color` but not `opacity`).
function colorIsAlias(v: VariableComposedColor): v is Extract<VariableComposedColor, { color: VariableAlias }> {
  return isVariableAlias(v.color);
}
// Every alias id a raw per-mode value holds: a top-level alias, or the nested alias(es) of a composed
// colour. ONE place, so the library pull (aliasTargets) and the "broken alias" hygiene check see a
// composed colour's aliases exactly as they see a top-level one.
function aliasIds(v: VariableValue): string[] {
  if (isVariableAlias(v)) return v.id ? [v.id] : [];
  if (!isComposedColor(v)) return [];
  const out: string[] = [];
  if (isVariableAlias(v.color) && v.color.id) out.push(v.color.id);
  if (isVariableAlias(v.opacity) && v.opacity.id) out.push(v.opacity.id);
  return out;
}

// An alias -> {aliasOf: target name}, falling back to the raw id when the target cannot be resolved.
async function aliasValue(a: VariableAlias): Promise<IrVariableAlias> {
  return { aliasOf: (await varName(a.id)) || a.id };
}

// Each half of a composed colour is emitted the way it would be on its own: an alias as {aliasOf}, the
// raw colour folded to hex (alpha kept), the raw opacity as Figma's number verbatim — a 0–100
// percentage: "An opacity percentage from 0 to 100, or an alias to a FLOAT variable" (REST API
// variables types, VariableComposedColor.opacity, https://developers.figma.com/docs/rest-api/variables-types/).
// It is NOT rescaled to 0–1 here: the IR keeps Figma's number, and each consumer converts (doc-types ComposedColor).
async function composedValue(v: VariableComposedColor): Promise<IrVariableComposedColor> {
  if (colorIsAlias(v)) {
    const [color, opacity] = await Promise.all([aliasValue(v.color), isVariableAlias(v.opacity) ? aliasValue(v.opacity) : v.opacity]);
    return { composed: { color, opacity } };
  }
  return { composed: { color: rgbaToHex(v.color), opacity: await aliasValue(v.opacity) } };
}

// valuesByMode does NOT resolve aliases and is keyed by opaque modeId — resolve alias targets to
// names and re-key by mode name. COLOR values carry alpha ({r,g,b,a}) — fold to hex so alpha survives.
async function resolveModeValue(v: VariableValue, resolvedType: VariableResolvedDataType): Promise<IrVariableValue> {
  if (isVariableAlias(v)) return aliasValue(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (isComposedColor(v)) return composedValue(v);
  if (resolvedType === "COLOR" && "r" in v && typeof v.r === "number") return rgbaToHex(v);
  return verbatimValue(v);
}

// An EASING variable's value is a MotionEasing OBJECT (and an RGB under a non-COLOR type cannot occur).
// It is emitted verbatim, as it always was — but doc-types' VariableValue has no object member other
// than {aliasOf} and {composed}, and widening it there breaks design-to-code's token emitters (tokens.ts dtcgValue,
// tokens-native.ts resolve), which hand the raw value on as a primitive. Until those handle it, this is
// the one place a value is widened into the documented union.
function verbatimValue(v: RGB | RGBA | MotionEasing): IrVariableValue {
  const o: object = v;
  return o as IrVariableValue;
}

export interface VariablesDump {
  collections: IrVariableCollection[];
  variables: IrVariable[];
  hygiene: string[];
}

// asLibrary: emit per-variable/per-collection publish status. Gated because Figma returns
// "UNPUBLISHED" for every object when asked from a consuming file or a branch — see components.ts's
// publishOf. https://developers.figma.com/docs/plugins/api/PublishStatus/
export async function dumpVariables(opts?: { asLibrary?: string }): Promise<VariablesDump> {
  const asLibrary = !!(opts && opts.asLibrary);
  // Filled during the variable loop, resolved in ONE fan-out afterwards (one round trip per variable,
  // awaited in place, would serialize the whole dump).
  const pendingPublish: { rec: IrVariable; obj: Variable }[] = [];
  const publishOf = async (o: Variable | VariableCollection): Promise<string | undefined> => {
    try {
      if (!asLibrary || !o || typeof o.getPublishStatusAsync !== "function") return undefined;
      const s = await o.getPublishStatusAsync();
      return s ? String(s).toLowerCase() : undefined;
    } catch (e) {
      return undefined;
    }
  };
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
  const variables: IrVariable[] = [];
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
  // Resolved to a FIXED POINT, because varName.ids() is only a SNAPSHOT of what the run had
  // referenced by this point — i.e. variables bound to NODES. A variable's own alias target is looked
  // up later (resolveModeValue, below), so a library primitive referenced ONLY as another variable's
  // alias was never in this set: its NAME still resolved on demand (so `aliasOf` showed a friendly
  // name) while the variable itself was dropped from `variables[]`. That produced a dangling
  // reference downstream — the exact silent-drop this block exists to prevent, just one level further
  // in — AND a false "broken alias … could not be resolved" hygiene line for a target that resolves
  // fine. Found on a real library-backed file (4 dangling refs, 0 genuinely broken).
  // Alias chains can be several levels deep (semantic -> semantic -> primitive), so iterate until no
  // new ids appear rather than doing one extra pass.
  const aliasTargets = (v: Variable): string[] => {
    const out: string[] = [];
    for (const modeId of Object.keys(v.valuesByMode || {})) out.push(...aliasIds(v.valuesByMode[modeId]));
    return out;
  };
  const remoteVars: Variable[] = [];
  const seen = new Set<string>(localIds);
  // Seed with node-referenced ids AND the alias targets of local variables — a local semantic token
  // pointing at a library primitive is the common case and is not otherwise in ids().
  let frontier = [...new Set(varName.ids().concat(...localVars.map(aliasTargets)))].filter((id) => !seen.has(id));
  while (frontier.length) {
    for (const id of frontier) seen.add(id);
    const fetched = ((await Promise.all(frontier.map((id) => varName.obj(id)))))
      .filter(Boolean) as Variable[];
    remoteVars.push(...fetched);
    frontier = [...new Set(([] as string[]).concat(...fetched.map(aliasTargets)))].filter((id) => !seen.has(id));
  }

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
    const values: IrVariable["values"] = {};
    let hasAlias = false;
    // Mode values resolve independently, so the (async) resolution fans out while the synchronous
    // alias/hygiene bookkeeping stays a plain loop. Awaited per mode, a 500-variable x 3-mode file
    // chained ~1500 round trips onto the tail of every export.
    const modeIds = Object.keys(v.valuesByMode);
    const resolved = await Promise.all(modeIds.map((modeId) =>
      resolveModeValue(v.valuesByMode[modeId], v.resolvedType)));
    for (let i = 0; i < modeIds.length; i++) {
      const modeId = modeIds[i];
      const raw = v.valuesByMode[modeId];
      // A composed colour always holds at least one alias (Figma's own constraint), so it is an alias
      // for the tier and for the "raw value in a multi-mode collection" hygiene check below.
      if (isVariableAlias(raw) || isComposedColor(raw)) hasAlias = true;
      // Top-level alias: its id as before (even an empty one); composed colour: each nested alias id.
      for (const id of isVariableAlias(raw) ? [raw.id] : aliasIds(raw)) {
        // Was `!localIds.has(raw.id)`, which fired on every LEGITIMATE library alias once remote
        // variables started being resolved above — so a library-consuming file's hygiene list filled
        // with non-issues. Only report an alias whose target we genuinely could not resolve.
        if (!resolvedIds.has(id)) hygiene.push("broken alias in '" + v.name + "' — target " + id + " could not be resolved");
      }
      values[modeName[modeId] || modeId] = resolved[i];
    }
    const rec: IrVariable = {
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
    putNonEmpty(rec, "codeSyntax", v.codeSyntax); // {WEB,ANDROID,iOS}
    if (v.description) rec.description = v.description; // token-intent annotation (Code Connect stand-in)
    if (v.remote) rec.remote = true;
    // Designer-marked private: hidden when publishing the file as a library. The DTCG emitter should
    // exclude/tag these rather than leak internal primitives into the public token API. Only meaningful
    // for local vars (the API guarantees it's false when remote).
    if (v.hiddenFromPublishing) rec.hiddenFromPublishing = true;
    // Durable cross-file identity (importVariableByKeyAsync) — rename-proof anchor for the design-to-code/ map +
    // drift-lint. Mirrors the component `key` precedent; present on local and published variables.
    if (v.key) rec.key = v.key;
    if (asLibrary) pendingPublish.push({ rec, obj: v });
    variables.push(rec);

    // Hygiene (all computable from what we already read):
    if (v.scopes && v.scopes.indexOf("ALL_SCOPES") !== -1) hygiene.push("ALL_SCOPES on '" + v.name + "' (pollutes every picker)");
    const modeCount = (collOf(v.variableCollectionId) || { modes: [] as VariableCollection["modes"] }).modes.length || 1;
    if (!hasAlias && v.resolvedType === "COLOR" && modeCount > 1) {
      hygiene.push("semantic color '" + v.name + "' holds a raw value in a multi-mode collection (breaks theming)");
    }
  }
  // Publish status, fanned out once: variables first, then collections (a collection carries its own
  // status — a variable can be CURRENT inside a collection that has never been published).
  if (pendingPublish.length) {
    const st = await Promise.all(pendingPublish.map((p) => publishOf(p.obj)));
    for (let i = 0; i < pendingPublish.length; i++) if (st[i]) pendingPublish[i].rec.publish = st[i];
  }
  const collPublish: Record<string, string> = {};
  if (asLibrary) {
    const st = await Promise.all(allCollections.map((c) => publishOf(c)));
    for (let i = 0; i < allCollections.length; i++) { const s = st[i]; if (s) collPublish[allCollections[i].id] = s; }
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
      extended: c.isExtension === true ? true : undefined,
      hiddenFromPublishing: c.hiddenFromPublishing === true ? true : undefined,
      key: c.key || undefined, // durable cross-file collection identity
      publish: collPublish[c.id] || undefined, // library mode only
    })),
    variables,
    hygiene,
  };
}
