// slice-sources.ts — which screen(s) each Figma variable KEY came from.
//
// design/export/variables.json is the UNION of every single-screen pull, keyed on the variable's
// Figma key. Names are not unique in it (livetest-3: two `Spacing / Space 4`, 24 and 16), so any
// message about a collision has to say which screen each of the colliding variables belongs to —
// otherwise it gets attributed to screens that are not involved (finding 40). The union lists its
// contributing pulls under `_slices`, and every pull keeps its raw slice beside the screen as
// <Screen>.vars.json, so the answer is on disk. Read those first (ground truth); then the per-slice
// `keys` a newer merge records; then the per-variant `screens` of its `_conflicts`.
//
// Best effort by design: a slice file that is missing just leaves that screen out of the answer.
import fs from "node:fs";
import path from "node:path";
import type { TokensDoc } from "./types.ts";
import { isTokensDoc } from "./doc-guards.ts";
import { readJson, readJsonOrNull } from "./read-json.ts";

/** Map(variable key -> [screen label]) */
export type SliceSources = Map<string, string[]>;

export interface VariablesContext {
  /** each screen's own slice, <Screen>.vars.json beside it (null if absent) */
  own: Array<TokensDoc | null>;
  variablesPath: string | null;
  variablesDoc: TokensDoc | null;
  sliceSources: SliceSources | null;
  staleLegacy: string | null;
  /** variables files that EXIST but could not be used (unreadable, not JSON, not a token catalog): the
   *  CLIs fail loud on these rather than reading "no variables" into a broken file */
  invalid: Array<{ file: string; error: string }>;
}

function sourcesOf(doc: TokensDoc | null | undefined, docPath: string | null | undefined): SliceSources {
  const out: SliceSources = new Map();
  const add = (key: unknown, screen: string | null | undefined): void => {
    if (typeof key !== "string" || !key || !screen) return;
    const list = out.get(key) || [];
    if (!list.includes(screen)) list.push(screen);
    out.set(key, list);
  };
  const base = docPath ? path.dirname(docPath) : ".";
  for (const sl of doc && Array.isArray(doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string") {
      // Not on disk, or not a token slice — fall through to what the merge recorded.
      const slice = readJsonOrNull(path.join(base, sl.file.replace(/\.json$/, ".vars.json")), isTokensDoc);
      if (slice) {
        for (const v of slice.variables || []) add(v.key, sl.screen);
        read = true;
      }
    }
    if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
  }
  for (const c of doc && Array.isArray(doc._conflicts) ? doc._conflicts : []) {
    // Only a same-name conflict carries `variants`; `in` is the same duck-typing the JS did.
    for (const vr of (c && "variants" in c && c.variants) || []) for (const sc of vr.screens || []) add(vr.key, sc);
  }
  if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
    for (const v of (doc && doc.variables) || []) add(v.key, path.basename(docPath, ".vars.json"));
  }
  return out;
}

// The variables context of a set of screen files — ONE implementation for cross-check.ts and audit.ts
// (livetest-3 #311: the audit embedded cross-check but fed it only the merged union, so its build gate
// raised Create Activity Type's `Space 4` blocker against Job Roles, while cross-check on the same
// screen did not).
//   own[i]        the screen's own slice, <Screen>.vars.json beside it (null if absent)
//   variablesPath the file used as `variables`: --variables if given, else the export root's merged
//                 variables.json (screen at design/export/pages/<Page>/<Screen>.json → two levels up),
//                 else a legacy variables.json beside the screen; never a stale design/variables.json
//                 above design/export/. With opts.sliceFallback, a lone screen's own slice stands in
//                 when there is no union at all (collection provenance still has something to read).
//   sliceSources  Map(key -> [screen]) for the union, for attributing its collisions
//   staleLegacy   path of an ignored design/variables.json above design/export/, if one exists
function variablesContext(screenFiles: readonly string[] | null | undefined, varsFile: string | null | undefined, opts?: { sliceFallback?: boolean }): VariablesContext {
  // Absent is null (a screen with no slice beside it); present-but-broken is recorded in `invalid`.
  const invalid: Array<{ file: string; error: string }> = [];
  const readTokens = (f: string | null | undefined): TokensDoc | null => {
    if (!f) return null;
    const r = readJson(f, isTokensDoc);
    if ("doc" in r) return r.doc;
    if (!r.missing) invalid.push({ file: f, error: r.error });
    return null;
  };
  const files = screenFiles || [];
  const own = files.map((f) => readTokens(String(f).replace(/\.json$/, ".vars.json")));
  let variablesPath = varsFile || null;
  if (!variablesPath && files.length) {
    const exportRoot = path.resolve(path.dirname(files[0]), "..", "..");
    const rootVars = path.join(exportRoot, "variables.json");
    const sibling = path.join(path.dirname(files[0]), "variables.json");
    if (fs.existsSync(rootVars)) variablesPath = rootVars;
    else if (fs.existsSync(sibling)) variablesPath = sibling;
    else if (opts && opts.sliceFallback && files.length === 1 && own[0]) variablesPath = String(files[0]).replace(/\.json$/, ".vars.json");
  }
  const variablesDoc = readTokens(variablesPath);
  let staleLegacy: string | null = null;
  if (files.length) {
    const legacy = path.join(path.resolve(path.dirname(files[0]), "..", ".."), "..", "variables.json");
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(variablesPath || "")) staleLegacy = legacy;
  }
  return { own, variablesPath, variablesDoc, sliceSources: variablesDoc ? sourcesOf(variablesDoc, variablesPath) : null, staleLegacy, invalid };
}

export { sourcesOf, variablesContext };
