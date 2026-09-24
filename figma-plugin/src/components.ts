// Components / instances: main-component name, prop references, overrides, and the whole-file
// design-system catalog (variables + styles + component/variant catalog + hygiene).
import type {
  IrNode, MainComponentRef, InstanceOverride, CatalogComponent, CatalogVariant, ComponentPropDef,
  DesignSystemDoc, StyleMeta, RadiusCorners, LayoutGridSpec, PaintStyle as IrPaintStyle, TextStyle as IrTextStyle,
  EffectStyle as IrEffectStyle, GridStyle as IrGridStyle,
} from "../../bridge/src/doc-types.ts";
import { propName, propType, errMsg, nonEmpty, putNonEmpty, round, exportedAt, isList } from "./util";
import { warn, loadAllPages, runOpts } from "./state";
import { checkCancelled, enterPage } from "./progress";
import { simplifyFills, simplifyStrokes } from "./paint";
import { simplifyEffects } from "./effects";
import { simplifyGrid } from "./layout";
import { lineH, letterS } from "./text";
import { dumpVariables, resolveBoundMap } from "./variables";
import { collectLibraryComponents } from "./libraries";

// INSTANCE -> its main component, resolved via getMainComponentAsync (mainComponent itself is
// write-only in the Plugin API's typings). Returns the join keys needed to resolve back to the
// component catalog (buildDesignSystem below), not just the display name a bare INSTANCE swap
// override happens to carry.
export async function instanceComponentRef(node: SceneNode): Promise<MainComponentRef | undefined> {
  if (node.type !== "INSTANCE") return undefined;
  try {
    const main = await node.getMainComponentAsync();
    if (!main) return undefined;
    const ref: MainComponentRef = { name: main.name };
    if (main.id) ref.id = main.id;
    if (main.key) ref.key = main.key;
    if (main.remote) ref.remote = true;
    // A REMOTE main's `.parent` may be null (plugin-api.d.ts) — this is documented shape, not a bug.
    const parent = main.parent;
    if (parent && parent.type === "COMPONENT_SET") {
      ref.setId = parent.id;
      if (parent.key) ref.setKey = parent.key;
      ref.setName = parent.name;
      ref.variant = main.name;
    }
    return ref;
  } catch (e) {
    return undefined;
  }
}

// componentPropertyReferences: which component property drives this sublayer's visibility / text /
// swapped instance — lets codegen wire a nested layer to a prop instead of hardcoding.
const PROP_REF_KEYS: Array<"visible" | "characters" | "mainComponent"> = ["visible", "characters", "mainComponent"];
export function componentPropRefs(node: SceneNode): IrNode["propRefs"] {
  if (!("componentPropertyReferences" in node)) return undefined;
  const refs = node.componentPropertyReferences;
  if (!refs) return undefined;
  const out: NonNullable<IrNode["propRefs"]> = {};
  for (const k of PROP_REF_KEYS) {
    const ref = refs[k];
    if (ref) out[k] = propName(ref);
  }
  return nonEmpty(out);
}

// Instance overrides — the fields directly changed on an instance vs its main component.
const OVERRIDE_CAP = 100;
export function instanceOverrides(node: SceneNode): InstanceOverride[] | undefined {
  if (node.type !== "INSTANCE") return undefined;
  const overrides = node.overrides;
  if (!Array.isArray(overrides) || !overrides.length) return undefined;
  const list = overrides
    .filter((o) => o && Array.isArray(o.overriddenFields) && o.overriddenFields.length)
    .map((o): InstanceOverride => ({ id: o.id, fields: o.overriddenFields }));
  if (!list.length) return undefined;
  if (list.length > OVERRIDE_CAP) {
    warn("instance '" + node.name + "' has " + list.length + " overrides — truncated to " + OVERRIDE_CAP);
    return list.slice(0, OVERRIDE_CAP);
  }
  return list;
}

// ComponentNode/ComponentSetNode carry their own visual properties (fills/strokes/effects/
// cornerRadius/opacity/blendMode), same as every other SceneNode per the Plugin API, and — unlike
// getCSSAsync/exportAsync/measurements — reading them costs nothing extra: they are plain synchronous
// property getters (Figma's own API only marks the genuinely expensive calls with an `Async` suffix),
// so there is no reason to gate them behind an opt-in flag the way the page-walk read options are.
// Mirrors serialize.ts's per-node visual reads (fills/strokes/effects/corner/opacity/blendMode) so a
// consumer sees the same shape it would from a page walk; kept local rather than imported to avoid a
// components.ts <-> serialize.ts import cycle (serialize.ts already imports from components.ts).
type CornerKey = "topLeftRadius" | "topRightRadius" | "bottomRightRadius" | "bottomLeftRadius";
const VISUAL_CORNER_KEYS: Array<[CornerKey, keyof RadiusCorners]> = [
  ["topLeftRadius", "tl"],
  ["topRightRadius", "tr"],
  ["bottomRightRadius", "br"],
  ["bottomLeftRadius", "bl"],
];
type Visuals = NonNullable<CatalogComponent["visuals"]>;
async function simplifyVisuals(node: ComponentNode | ComponentSetNode): Promise<Visuals | undefined> {
  const out: Visuals = {};
  const [fills, strokes, effects] = await Promise.all([
    simplifyFills("fills" in node ? node.fills : undefined),
    simplifyStrokes(node),
    simplifyEffects("effects" in node ? node.effects : undefined),
  ]);
  if (fills) out.fills = fills;
  if (strokes) out.strokes = strokes;
  if (effects) out.effects = effects;
  if ("cornerRadius" in node) {
    if (node.cornerRadius !== figma.mixed && node.cornerRadius) out.radius = node.cornerRadius;
    else if (node.cornerRadius === figma.mixed) {
      const corners: RadiusCorners = {};
      for (const [k, s] of VISUAL_CORNER_KEYS) {
        if (!(k in node)) continue;
        const r = node[k];
        if (typeof r === "number" && r) corners[s] = r;
      }
      putNonEmpty(out, "radius", corners);
    }
  }
  if ("opacity" in node && typeof node.opacity === "number" && node.opacity < 1) out.opacity = round(node.opacity);
  if ("blendMode" in node && node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") out.blendMode = String(node.blendMode).toLowerCase();
  return nonEmpty(out);
}

// A variant's own prop VALUES (not definitions — componentPropertyDefinitions throws on a variant).
// variantProperties is deprecated for INSTANCES (use InstanceNode.componentProperties instead), but
// NOT deprecated for components/variants in a component set — `main` here is the main COMPONENT node,
// so this read is the supported path — prefer it when present, else parse the name Figma guarantees is
// "Prop=Val, ...".
function variantValues(main: ComponentNode): Record<string, string> | undefined {
  try {
    if (main.variantProperties && Object.keys(main.variantProperties).length) return { ...main.variantProperties };
  } catch (e) {}
  const name: string = main.name || "";
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return nonEmpty(out);
}

// Function type of serialize.ts's `serialize` — injected as a parameter rather than imported, since
// serialize.ts already imports FROM components.ts (instanceComponentRef/componentPropRefs/
// instanceOverrides) and a direct import back here would be a cycle.
type SerializeFn = (node: SceneNode, depth: number, parentControlsLayout?: boolean) => Promise<IrNode | null>;

// Per-variant visual/layout truth (opt-in, runOpts.variantVisuals): the master COMPONENT itself, not
// the COMPONENT_SET wrapper's own selection-chrome visuals. Depth-capped well below serialize.ts's
// MAX_DEPTH (this rides along on --design-system, which is documented as cheap) and forced to skip
// asset export — a design-system pull has no asset manifest path, so a real exportAsync render here
// would silently orphan files no writer ever looks for.
const VARIANT_WALK_DEPTH = 3;
async function serializeVariant(main: ComponentNode, serialize: SerializeFn): Promise<IrNode | null> {
  const prevSkipAssets = runOpts.skipAssets;
  try {
    runOpts.skipAssets = true;
    return await serialize(main, 60 - VARIANT_WALK_DEPTH); // depth budget: MAX_DEPTH - N levels below main
  } finally {
    runOpts.skipAssets = prevSkipAssets;
  }
}

// The component + variant catalog across every page (a feature's states live here).
// Pushes naming/variant-explosion notes into `hygiene`; per-page and per-component failures are
// WARNED, never swallowed — an empty catalog must be distinguishable from "this page has none".
async function collectComponentCatalog(hygiene: string[], asLibrary?: boolean, serialize?: SerializeFn): Promise<CatalogComponent[]> {
  const components: CatalogComponent[] = [];
  const pendingPublish: { entry: CatalogComponent; node: ComponentNode | ComponentSetNode }[] = [];
  const seenNames = new Set<string>();
  const variantsBySet = new Map<string, ComponentNode[]>(); // setId -> variant COMPONENT nodes, collected in the same pass
  const entriesBySetId = new Map<string, CatalogComponent>(); // setId -> that COMPONENT_SET's catalog entry
  // findAllWithCriteria is the extractor's one full-document traversal, and the Plugin API docs call
  // out invisible instance children as its main cost ("several times faster in large documents").
  // A COMPONENT/COMPONENT_SET is never nested inside an instance, so skipping them loses no catalog
  // entry. Scoped to this traversal and restored in `finally` — serialize() deliberately KEEPS hidden
  // nodes, so the flag must not leak into the node walk.
  const prevSkip = figma.skipInvisibleInstanceChildren;
  try {
    try { figma.skipInvisibleInstanceChildren = true; } catch (e) {}
    // This is the extractor's OTHER multi-page walk (findAllWithCriteria over every page), and on a
    // design-system file it is the slow half of a --design-system pull, which has no page walk to
    // report progress from at all. Same two safe-point rules as collect.ts: cancel between pages,
    // announce the boundary unthrottled. `catalogPages` is read once — figma.root.children is a getter
    // that materialises a fresh wrapper array on every read.
    const catalogPages = figma.root.children;
    let catalogIndex = 0;
    for (const page of catalogPages) {
      checkCancelled();
      enterPage("design-system", ++catalogIndex, catalogPages.length, page.name, page.id, { components: components.length });
      let nodes: Array<ComponentNode | ComponentSetNode> = [];
      // A page that failed to load throws here (dynamic-page access) — report which page went missing.
      try {
        nodes = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
      } catch (e) {
        warn("component catalog: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") — its components are missing");
        continue;
      }
      for (const n of nodes) {
        if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") {
          // A variant — findAllWithCriteria already found it in this same traversal, so record it for
          // the visuals pass below rather than walking the tree a second time to re-find it.
          if (runOpts.variantVisuals) {
            const list = variantsBySet.get(n.parent.id);
            if (list) list.push(n); else variantsBySet.set(n.parent.id, [n]);
          }
          continue;
        }
        const entry: CatalogComponent = { name: n.name, id: n.id, type: n.type, page: page.name, pageId: page.id };
        if (n.description) entry.description = n.description; // free intent annotation (Code Connect stand-in)
        if (n.remote) entry.remote = true; // consumed library component vs a local one
        if (n.key) entry.key = n.key; // publish key — resolves INSTANCE_SWAP preferredValues keys back to this catalog
        if (isList(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d) => d.uri).filter(Boolean);
        try {
          const defs = n.componentPropertyDefinitions;
          if (defs && Object.keys(defs).length) {
            const props: Record<string, ComponentPropDef> = {};
            entry.props = props;
            let variantCombos = 1;
            // The per-definition binding lookups are independent of each other, so fan them out ONCE
            // instead of awaiting inside the page->component->property loop: awaited in place, a
            // design-system file paid one serialized round trip per property definition in the file.
            const keys = Object.keys(defs);
            const boundPerKey = await Promise.all(keys.map((k) => resolveBoundMap(defs[k].boundVariables)));
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              const d = defs[k];
              // Keep the REAL #uid key + type + default (needed to address TEXT/BOOL/SWAP/SLOT props).
              const p: ComponentPropDef = { key: k, type: propType(d.type) };
              if (d.type === "VARIANT") { p.options = d.variantOptions; variantCombos *= (d.variantOptions ? d.variantOptions.length : 1); }
              if (d.defaultValue !== undefined) p.default = d.defaultValue;
              // INSTANCE_SWAP and SLOT: the curated set of components allowed -> a typed enum.
              // plugin-api.d.ts 1.139.0 L9594 (editComponentProperty): "`preferredValues` is only supported
              // for `'INSTANCE_SWAP'` and `'SLOT'` properties" — a SLOT's `allowPreferredValuesOnly` (below)
              // is meaningless without this list.
              if ((d.type === "INSTANCE_SWAP" || d.type === "SLOT") && Array.isArray(d.preferredValues) && d.preferredValues.length) {
                p.preferredValues = d.preferredValues.map((v) => ({ type: v.type, key: v.key }));
              }
              if (d.description) p.description = d.description;
              // SLOT rules. plugin-api.d.ts 1.139.0 L11018, ComponentPropertyDefinitions entry:
              // `slotSettings?: SlotSettings`, and L9596 (editComponentProperty): "`slotSettings` is only
              // supported for `'SLOT'` properties". SlotSettings (L10993-10999) = { stretchChildOnInsert?,
              // displayEmptyByDefault?, minChildren?: number | null, maxChildren?: number | null,
              // allowPreferredValuesOnly? } — every member optional and no defaults documented, so each is
              // carried as set; a null min/max (no limit) is omitted, and an all-empty object is dropped.
              if (d.type === "SLOT" && d.slotSettings) {
                const ss = d.slotSettings;
                const slot: NonNullable<ComponentPropDef["slotSettings"]> = {};
                if (typeof ss.stretchChildOnInsert === "boolean") slot.stretchChildOnInsert = ss.stretchChildOnInsert;
                if (typeof ss.displayEmptyByDefault === "boolean") slot.displayEmptyByDefault = ss.displayEmptyByDefault;
                if (typeof ss.minChildren === "number") slot.minChildren = ss.minChildren;
                if (typeof ss.maxChildren === "number") slot.maxChildren = ss.maxChildren;
                if (typeof ss.allowPreferredValuesOnly === "boolean") slot.allowPreferredValuesOnly = ss.allowPreferredValuesOnly;
                putNonEmpty(p, "slotSettings", slot);
              }
              // A BOOLEAN/TEXT prop whose DEFAULT is driven by a variable at the definition level.
              const dbv = boundPerKey[i];
              if (dbv) p.tokens = dbv;
              props[propName(k)] = p;
            }
            if (variantCombos > 30) hygiene.push("variant explosion: '" + n.name + "' has " + variantCombos + " combinations (>30 — consider boolean/instance-swap props)");
          }
        } catch (e) {
          // Dropping every prop of a component is exactly the kind of gap the map/drift tooling would
          // then report as "component exposes no props" — say so instead of failing silently.
          warn("component '" + n.name + "': property definitions unreadable (" + errMsg(e) + ") — props omitted");
        }
        // Naming hygiene
        if (/^(Component|Frame)\s*\d+$/.test(n.name)) hygiene.push("unnamed component: '" + n.name + "'");
        if (seenNames.has(n.name)) hygiene.push("duplicate component name: '" + n.name + "'");
        seenNames.add(n.name);
        // The component/variant's own fills/strokes/effects/corner/opacity/blendMode. Awaited
        // per-component in place, not fanned out like publish status below: unlike a real round trip
        // (getPublishStatusAsync), these are synchronous property reads wrapped in a Promise.all only
        // to reuse the shared paint/effects helpers, so there is no serialization cost to batch away.
        try {
          const visuals = await simplifyVisuals(n);
          if (visuals) entry.visuals = visuals;
        } catch (e) {
          warn("component '" + n.name + "': visuals unreadable (" + errMsg(e) + ") — visuals omitted");
        }
        // Collected, not awaited: one getPublishStatusAsync per component inside the page->component
        // loop would serialize a round trip per component. Fanned out once, after the walk.
        if (asLibrary) pendingPublish.push({ entry, node: n });
        if (runOpts.variantVisuals && n.type === "COMPONENT_SET") entriesBySetId.set(n.id, entry);
        // A standalone COMPONENT (not a variant inside a set — those were already filtered out above)
        // has no COMPONENT_SET wrapper to hang variants[] off of, but it is exactly as "one master node
        // worth walking" as every variant is, so give it the same serializeVariant treatment and attach
        // the tree directly as entry.node rather than entry.variants[].node.
        if (runOpts.variantVisuals && n.type === "COMPONENT" && serialize) {
          try {
            const node = await serializeVariant(n, serialize);
            if (node) entry.node = node;
          } catch (e) {
            warn("component '" + n.name + "': visuals unreadable (" + errMsg(e) + ") — node tree omitted");
          }
        }
        components.push(entry);
      }
    }
  } finally {
    try { figma.skipInvisibleInstanceChildren = prevSkip; } catch (e) {}
  }
  // Per-variant visual truth (opt-in). Runs AFTER skipInvisibleInstanceChildren is restored to its
  // prior value: serialize() deliberately KEEPS hidden nodes (hidden variant states are real design),
  // so the catalog traversal's flag must not leak into this walk.
  if (runOpts.variantVisuals && serialize && variantsBySet.size) {
    for (const [setId, variants] of variantsBySet) {
      const entry = entriesBySetId.get(setId);
      if (!entry) continue; // the owning COMPONENT_SET entry failed earlier in the loop — nothing to attach to
      const out: CatalogVariant[] = [];
      for (const v of variants) {
        try {
          const node = await serializeVariant(v, serialize);
          const o: CatalogVariant = { id: v.id, name: v.name };
          if (v.key) o.key = v.key;
          const values = variantValues(v);
          if (values) o.values = values;
          if (node) o.node = node;
          out.push(o);
        } catch (e) {
          warn("component '" + v.name + "': variant visuals unreadable (" + errMsg(e) + ") — omitted");
        }
      }
      if (out.length) entry.variants = out;
    }
  }
  if (pendingPublish.length) {
    const statuses = await Promise.all(pendingPublish.map((p) => publishOf(p.node)));
    for (let i = 0; i < pendingPublish.length; i++) {
      const s = statuses[i];
      if (s) pendingPublish[i].entry.publish = s;
    }
  }
  return components;
}

// PublishStatus is only meaningful INSIDE the library file: Figma returns "UNPUBLISHED" for every
// object when queried from a consuming file or a branch, so emitting it on the normal path would be a
// plausible-looking lie rather than a missing field. Gated on library mode for exactly that reason.
// https://developers.figma.com/docs/plugins/api/PublishStatus/
// CURRENT = published and in sync | CHANGED = published with local edits | UNPUBLISHED = never published.
// Per-object and async (N round trips), so callers fan it out; a rejection yields undefined ("unknown"),
// never a guessed "UNPUBLISHED".
async function publishOf(o: PublishableMixin | null | undefined): Promise<string | undefined> {
  try {
    if (!o || typeof o.getPublishStatusAsync !== "function") return undefined;
    const s = await o.getPublishStatusAsync();
    return s ? String(s).toLowerCase() : undefined;
  } catch (e) {
    return undefined;
  }
}

/** buildDesignSystem's doc: DesignSystemDoc with every section it always writes made required. */
export type BuiltDesignSystem = DesignSystemDoc & Required<Pick<DesignSystemDoc, "collections" | "variables" | "components" | "styles" | "hygiene">>;

export async function buildDesignSystem(opts?: { asLibrary?: string }, serialize?: SerializeFn): Promise<BuiltDesignSystem> {
  const asLibrary = !!(opts && opts.asLibrary);
  // getLocal*StylesAsync can throw on some file states — default to [] rather than aborting the build.
  const safeList = async <T>(fn: () => Promise<T[]>): Promise<T[]> => { try { return await fn(); } catch (e) { return []; } };
  // Four independent style-list reads — fetch them concurrently rather than one after another.
  const [paint, text, effect, grid] = await Promise.all([
    safeList(() => figma.getLocalPaintStylesAsync()),
    safeList(() => figma.getLocalTextStylesAsync()),
    safeList(() => figma.getLocalEffectStylesAsync()),
    safeList(() => (figma.getLocalGridStylesAsync ? figma.getLocalGridStylesAsync() : Promise.resolve<GridStyle[]>([]))),
  ]);

  const hygiene: string[] = [];
  // Component + variant catalog across every page (a feature's states live here).
  await loadAllPages("component catalog may be incomplete");
  const components = await collectComponentCatalog(hygiene, asLibrary, serialize);

  // LIBRARY components. findAllWithCriteria({types:["COMPONENT",...]}) above only ever finds mains
  // that live IN this document, so a file whose entire design system is a consumed library produced a
  // catalog of zero components while every screen was full of instances of them — the component-side
  // twin of the missing-library-variables bug variables.ts already fixes. Library mains cannot be
  // enumerated (there is no getAvailableLibraryComponentsAsync), so they are recovered by walking
  // instances; see libraries.ts for why their props may be inferred rather than defined.
  // Wrapped: this is an ADDITION to the catalog, and it must never be able to take the catalog with it.
  // In LIBRARY mode this walk is skipped entirely: inside the library file the components ARE local
  // (findAllWithCriteria above already found every one of them), so the instance walk — the most
  // expensive traversal in the module — would recover almost nothing while paying full cost. Any
  // remote main it did find belongs to a DIFFERENT library and is that library's export to make.
  if (asLibrary) {
    hygiene.push(
      "library mode: this catalog is the COMPLETE set of components defined in this library file. " +
        "Publish status is per-object (publish: current | changed | unpublished); Figma exposes no way to list what the " +
        "last PUBLISHED snapshot contained, so a component deleted here but still live in the library is not visible."
    );
  } else try {
    const seenKeys = new Set<string | undefined>(components.map((c) => c.key).filter(Boolean));
    const remote = await collectLibraryComponents((m) => warn(m));
    let added = 0;
    for (const entry of remote) {
      if (seenKeys.has(entry.key)) continue; // already catalogued locally (a library main present in-file)
      seenKeys.add(entry.key);
      components.push(entry);
      added++;
    }
    if (added) {
      hygiene.push(
        added + " component(s) in this catalog come from a published LIBRARY, not this file — flagged remote:true. " +
          "Entries with derivedFrom:\"instances\" have props INFERRED from the instances present here (a sample, not the complete set)."
      );
    }
  } catch (e) {
    warn("library component catalog failed (" + errMsg(e) + ") — components consumed from published libraries are missing from the catalog");
  }

  let colorProfile: string | undefined;
  try { if (figma.root && figma.root.documentColorProfile) colorProfile = String(figma.root.documentColorProfile).toLowerCase(); } catch (e) {}

  // Styles resolve BEFORE dumpVariables: every resolveBoundMap() below records the variable ids these
  // styles reference, and dumpVariables uses that record to pull in referenced LIBRARY variables that
  // getLocalVariablesAsync can't see. Resolving them after the dump would leave those tokens undefined.
  // The three async style mappings are independent of one another — resolve them concurrently instead
  // of awaiting three separate Promise.all batches in sequence inside the object literal.
  // The catalog fields every style shares, regardless of kind. `key` is the durable cross-file
  // identity — the exact analogue of the component `key` above and the variable `key` in variables.ts.
  // Without it a consuming file's styleId (which resolves to a NAME only) cannot be joined back to the
  // library catalog this style came from, which is the whole point of a library export.
  // https://developers.figma.com/docs/plugins/api/PaintStyle/
  const styleMeta = async (s: BaseStyle): Promise<StyleMeta> => {
    const m: StyleMeta = {};
    if (s.key) m.key = s.key;
    if (s.id) m.id = s.id;
    if (s.remote) m.remote = true;
    if (isList(s.documentationLinks) && s.documentationLinks.length) {
      m.docs = s.documentationLinks.map((d) => d.uri).filter(Boolean);
    }
    if (asLibrary) {
      const p = await publishOf(s);
      if (p) m.publish = p;
    }
    return m;
  };

  const [paintStyles, textStyles, effectStyles] = await Promise.all([
    // Paint styles carry their ACTUAL colors, not just a name.
    // `tokens` (boundVariables) was read for TEXT styles only, so a paint style bound to a color
    // variable silently lost that link — the binding is what makes it a token rather than a hex.
    Promise.all(paint.map(async (s): Promise<IrPaintStyle> => ({ name: s.name, paints: await simplifyFills(s.paints), tokens: await resolveBoundMap(s.boundVariables), description: s.description || undefined, ...(await styleMeta(s)) }))),
    Promise.all(
      text.map(async (s): Promise<IrTextStyle> => ({
          name: s.name,
          size: s.fontSize,
          font: s.fontName && s.fontName.family,
          weight: s.fontName && s.fontName.style,
          lineHeight: lineH(s.lineHeight),
          letterSpacing: letterS(s.letterSpacing),
          case: s.textCase && s.textCase !== "ORIGINAL" ? s.textCase.toLowerCase() : undefined,
          decoration: s.textDecoration && s.textDecoration !== "NONE" ? s.textDecoration.toLowerCase() : undefined,
          paragraphSpacing: s.paragraphSpacing || undefined,
          paragraphIndent: s.paragraphIndent || undefined,
          leadingTrim: s.leadingTrim && s.leadingTrim !== "NONE" ? String(s.leadingTrim).toLowerCase() : undefined,
          listSpacing: s.listSpacing || undefined,
          // TextStyle.textWrapStyle (Plugin API 2026-08-14) — AUTO | BALANCE | PRETTY; AUTO is the
          // default and is skipped. Maps 1:1 onto CSS `text-wrap`. Same read as text.ts's per-node
          // one, minus the mixed guard: a TextStyle is uniform by definition.
          textWrap: s.textWrapStyle && s.textWrapStyle !== "AUTO"
            ? String(s.textWrapStyle).toLowerCase() : undefined,
        tokens: await resolveBoundMap(s.boundVariables),
        description: s.description || undefined,
        ...(await styleMeta(s)),
      }))
    ),
    Promise.all(effect.map(async (s): Promise<IrEffectStyle> => ({ name: s.name, effects: await simplifyEffects(s.effects), tokens: await resolveBoundMap(s.boundVariables), description: s.description || undefined, ...(await styleMeta(s)) }))),
  ]);
  const styles = {
    paint: paintStyles,
    text: textStyles,
    effect: effectStyles,
    // Layout-grid styles (column/row grids) — the responsive grid tokens. The grid VALUES are sync;
    // the shared catalog meta (key/publish) is not, so the map is fanned out like its three siblings.
    grid: await Promise.all(
      grid.map(async (s): Promise<IrGridStyle> => ({
        name: s.name,
        grids: Array.isArray(s.layoutGrids) ? s.layoutGrids.map(simplifyGrid).filter((g): g is LayoutGridSpec => !!g) : undefined,
        tokens: await resolveBoundMap(s.boundVariables),
        description: s.description || undefined,
        ...(await styleMeta(s)),
      }))
    ),
  };

  // LAST: the referenced-variable record is only complete once nodes, component props and styles have
  // all resolved, and dumpVariables uses it to include library variables this file merely consumes.
  const vars = await dumpVariables(opts);

  // PROVENANCE. `exportedAt`/`file` stay top-level — snapshot-meta.js and drift-lint.js read them
  // off whatever catalog they are handed, and `file` must keep answering "which ONE Figma file is
  // this?". `source` is purely additive: role tells a consumer whether it is holding the design file's
  // own catalog or a library's, and collectionKeys is the join back to --list-libraries, which reports
  // collection keys but no library fileKey (libraries.ts: libraries themselves have no key).
  let source: DesignSystemDoc["source"];
  if (asLibrary) {
    let fileKey: string | undefined;
    try { if (typeof figma.fileKey !== "undefined") fileKey = figma.fileKey || undefined; } catch (e) {}
    if (!fileKey) hygiene.push("figma.fileKey unavailable — the library output directory falls back to a name slug, so a RENAMED library will land in a new directory");
    source = {
      role: "library",
      libraryName: (opts && opts.asLibrary) || (figma.root && figma.root.name) || undefined,
      fileKey,
      collectionKeys: vars.collections.map((c) => c.key).filter((k): k is string => !!k),
    };
  }

  return {
    exportedAt: exportedAt(),
    file: (figma.root && figma.root.name) || undefined,
    source,
    colorProfile, // legacy | srgb | display_p3 — whether emitted colors should be sRGB or wide-gamut
    collections: vars.collections,
    variables: vars.variables,
    styles,
    components,
    hygiene: vars.hygiene.concat(hygiene), // variable hygiene first, then component hygiene
  };
}
