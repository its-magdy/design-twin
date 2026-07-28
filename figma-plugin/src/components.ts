// Components / instances: main-component name, prop references, overrides, and the whole-file
// design-system catalog (variables + styles + component/variant catalog + hygiene).
import { Obj, propName, errMsg, nonEmpty } from "./util";
import { warn } from "./state";
import { simplifyFills } from "./paint";
import { simplifyEffects } from "./effects";
import { simplifyGrid } from "./layout";
import { lineH, letterS } from "./text";
import { dumpVariables, resolveBoundMap } from "./variables";

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
        const entry: Obj = { name: n.name, id: n.id, type: n.type, page: page.name };
        if (n.description) entry.description = n.description; // free intent annotation (Code Connect stand-in)
        if (n.remote) entry.remote = true; // consumed library component vs a local one
        if (n.key) entry.key = n.key; // publish key — resolves INSTANCE_SWAP preferredValues keys back to this catalog
        if (Array.isArray(n.documentationLinks) && n.documentationLinks.length) entry.docs = n.documentationLinks.map((d: any) => d.uri).filter(Boolean);
        try {
          const defs = n.componentPropertyDefinitions;
          if (defs && Object.keys(defs).length) {
            entry.props = {};
            let variantCombos = 1;
            for (const k of Object.keys(defs)) {
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
              const dbv = await resolveBoundMap(d.boundVariables);
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
  if (figma.loadAllPagesAsync) {
    try { await figma.loadAllPagesAsync(); } catch (e) { warn("loadAllPagesAsync failed (component catalog may be incomplete): " + errMsg(e)); }
  }
  const components = await collectComponentCatalog(hygiene);

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
    exportedAt: new Date().toISOString(),
    file: (figma.root && figma.root.name) || undefined,
    colorProfile, // legacy | srgb | display-p3 — whether emitted colors should be sRGB or wide-gamut
    collections: vars.collections,
    variables: vars.variables,
    styles,
    components,
    hygiene: vars.hygiene.concat(hygiene), // variable hygiene first, then component hygiene
  };
}
