// Components / instances: main-component name, prop references, overrides, and the whole-file
// design-system catalog (variables + styles + component/variant catalog + hygiene).
import { Obj, propName, errMsg, nonEmpty, exportedAt } from "./util";
import { warn, loadAllPages } from "./state";
import { simplifyFills } from "./paint";
import { simplifyEffects } from "./effects";
import { simplifyGrid } from "./layout";
import { lineH, letterS } from "./text";
import { dumpVariables, resolveBoundMap } from "./variables";
import { collectLibraryComponents } from "./libraries";

// INSTANCE main-component name (the referenced library component), or undefined.
export async function instanceComponent(node: SceneNode): Promise<string | undefined> {
  if (node.type !== "INSTANCE") return undefined;
  try {
    const main = await node.getMainComponentAsync();
    return main ? main.name : undefined;
  } catch (e) {
    return undefined;
  }
}

// componentPropertyReferences: which component property drives this sublayer's visibility / text /
// swapped instance — lets codegen wire a nested layer to a prop instead of hardcoding.
const PROP_REF_KEYS = ["visible", "characters", "mainComponent"];
export function componentPropRefs(node: SceneNode): Obj | undefined {
  if (!("componentPropertyReferences" in node)) return undefined;
  const refs = (node as any).componentPropertyReferences;
  if (!refs) return undefined;
  const out: Obj = {};
  for (const k of PROP_REF_KEYS) {
    if (refs[k]) out[k] = propName(refs[k]);
  }
  return nonEmpty(out);
}

// Instance overrides — the fields directly changed on an instance vs its main component.
const OVERRIDE_CAP = 100;
export function instanceOverrides(node: SceneNode): Obj[] | undefined {
  if (node.type !== "INSTANCE") return undefined;
  const overrides = (node as any).overrides;
  if (!Array.isArray(overrides) || !overrides.length) return undefined;
  const list = overrides
    .filter((o: any) => o && Array.isArray(o.overriddenFields) && o.overriddenFields.length)
    .map((o: any) => ({ id: o.id, fields: o.overriddenFields }));
  if (!list.length) return undefined;
  if (list.length > OVERRIDE_CAP) {
    warn("instance '" + node.name + "' has " + list.length + " overrides — truncated to " + OVERRIDE_CAP);
    return list.slice(0, OVERRIDE_CAP);
  }
  return list;
}

// The component + variant catalog across every page (a feature's states live here).
// Pushes naming/variant-explosion notes into `hygiene`; per-page and per-component failures are
// WARNED, never swallowed — an empty catalog must be distinguishable from "this page has none".
async function collectComponentCatalog(hygiene: string[]): Promise<Obj[]> {
  const components: Obj[] = [];
  const seenNames = new Set<string>();
  // findAllWithCriteria is the extractor's one full-document traversal, and the Plugin API docs call
  // out invisible instance children as its main cost ("several times faster in large documents").
  // A COMPONENT/COMPONENT_SET is never nested inside an instance, so skipping them loses no catalog
  // entry. Scoped to this traversal and restored in `finally` — serialize() deliberately KEEPS hidden
  // nodes, so the flag must not leak into the node walk.
  const prevSkip = (figma as any).skipInvisibleInstanceChildren;
  try {
    try { (figma as any).skipInvisibleInstanceChildren = true; } catch (e) {}
    for (const page of figma.root.children) {
      let nodes: SceneNode[] = [];
      // A page that failed to load throws here (dynamic-page access) — report which page went missing.
      try {
        nodes = page.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] });
      } catch (e) {
        warn("component catalog: page '" + page.name + "' could not be traversed (" + errMsg(e) + ") — its components are missing");
        continue;
      }
      for (const n of nodes as any[]) {
        if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue; // it's a variant
        const entry: Obj = { name: n.name, id: n.id, type: n.type, page: page.name, pageId: page.id };
        if (n.description) entry.description = n.description; // free intent annotation (Code Connect stand-in)
        if (n.remote) entry.remote = true; // consumed library component vs a local one
        if (n.key) entry.key = n.key; // publish key — resolves INSTANCE_SWAP preferredValues keys back to this catalog
        if (Array.isArray(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d: any) => d.uri).filter(Boolean);
        try {
          const defs = n.componentPropertyDefinitions;
          if (defs && Object.keys(defs).length) {
            entry.props = {};
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
              const p: Obj = { key: k, type: d.type };
              if (d.type === "VARIANT") { p.options = d.variantOptions; variantCombos *= (d.variantOptions ? d.variantOptions.length : 1); }
              if (d.defaultValue !== undefined) p.default = d.defaultValue;
              // INSTANCE_SWAP: the curated set of components allowed for this slot -> a typed enum.
              if (d.type === "INSTANCE_SWAP" && Array.isArray(d.preferredValues) && d.preferredValues.length) {
                p.preferredValues = d.preferredValues.map((v: any) => ({ type: v.type, key: v.key }));
              }
              if (d.description) p.description = d.description;
              // A BOOLEAN/TEXT prop whose DEFAULT is driven by a variable at the definition level.
              const dbv = boundPerKey[i];
              if (dbv) p.tokens = dbv;
              entry.props[propName(k)] = p;
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
        components.push(entry);
      }
    }
  } finally {
    try { (figma as any).skipInvisibleInstanceChildren = prevSkip; } catch (e) {}
  }
  return components;
}

export async function buildDesignSystem(): Promise<Obj> {
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
  const components = await collectComponentCatalog(hygiene);

  // LIBRARY components. findAllWithCriteria({types:["COMPONENT",...]}) above only ever finds mains
  // that live IN this document, so a file whose entire design system is a consumed library produced a
  // catalog of zero components while every screen was full of instances of them — the component-side
  // twin of the missing-library-variables bug variables.ts already fixes. Library mains cannot be
  // enumerated (there is no getAvailableLibraryComponentsAsync), so they are recovered by walking
  // instances; see libraries.ts for why their props may be inferred rather than defined.
  // Wrapped: this is an ADDITION to the catalog, and it must never be able to take the catalog with it.
  try {
    const seenKeys = new Set(components.map((c) => c.key).filter(Boolean));
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
  try { if (figma.root && (figma.root as any).documentColorProfile) colorProfile = String((figma.root as any).documentColorProfile).toLowerCase(); } catch (e) {}

  // Styles resolve BEFORE dumpVariables: every resolveBoundMap() below records the variable ids these
  // styles reference, and dumpVariables uses that record to pull in referenced LIBRARY variables that
  // getLocalVariablesAsync can't see. Resolving them after the dump would leave those tokens undefined.
  // The three async style mappings are independent of one another — resolve them concurrently instead
  // of awaiting three separate Promise.all batches in sequence inside the object literal.
  const [paintStyles, textStyles, effectStyles] = await Promise.all([
    // Paint styles carry their ACTUAL colors, not just a name.
    Promise.all(paint.map(async (s) => ({ name: s.name, paints: await simplifyFills(s.paints), description: s.description || undefined }))),
    Promise.all(
      text.map(async (s) => ({
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
          textWrap: (s as any).textWrapStyle && (s as any).textWrapStyle !== "AUTO"
            ? String((s as any).textWrapStyle).toLowerCase() : undefined,
        tokens: await resolveBoundMap((s as any).boundVariables),
        description: s.description || undefined,
      }))
    ),
    Promise.all(effect.map(async (s) => ({ name: s.name, effects: await simplifyEffects(s.effects), description: s.description || undefined }))),
  ]);
  const styles = {
    paint: paintStyles,
    text: textStyles,
    effect: effectStyles,
    // Layout-grid styles (column/row grids) — the responsive grid tokens. Sync, so no await needed.
    grid: grid.map((s) => ({ name: s.name, grids: Array.isArray(s.layoutGrids) ? s.layoutGrids.map(simplifyGrid).filter(Boolean) : undefined, description: s.description || undefined })),
  };

  // LAST: the referenced-variable record is only complete once nodes, component props and styles have
  // all resolved, and dumpVariables uses it to include library variables this file merely consumes.
  const vars = await dumpVariables();

  return {
    exportedAt: exportedAt(),
    file: (figma.root && figma.root.name) || undefined,
    colorProfile, // legacy | srgb | display-p3 — whether emitted colors should be sRGB or wide-gamut
    collections: vars.collections,
    variables: vars.variables,
    styles,
    components,
    hygiene: vars.hygiene.concat(hygiene), // variable hygiene first, then component hygiene
  };
}
