// slice-sources.js — which screen(s) each Figma variable KEY came from.
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

function sourcesOf(doc, docPath, fs, path) {
  const out = new Map();
  const add = (key, screen) => {
    if (typeof key !== "string" || !key || !screen) return;
    if (!out.has(key)) out.set(key, []);
    if (!out.get(key).includes(screen)) out.get(key).push(screen);
  };
  const base = docPath ? path.dirname(docPath) : ".";
  for (const sl of Array.isArray(doc && doc._slices) ? doc._slices : []) {
    if (!sl) continue;
    let read = false;
    if (typeof sl.file === "string" && fs && path) {
      try {
        const slice = JSON.parse(fs.readFileSync(path.join(base, sl.file.replace(/\.json$/, ".vars.json")), "utf8"));
        for (const v of slice.variables || []) add(v && v.key, sl.screen);
        read = true;
      } catch (_) { /* not on disk — fall through to what the merge recorded */ }
    }
    if (!read) for (const k of Array.isArray(sl.keys) ? sl.keys : []) add(k, sl.screen);
  }
  for (const c of Array.isArray(doc && doc._conflicts) ? doc._conflicts : []) {
    for (const vr of (c && c.variants) || []) for (const sc of vr.screens || []) add(vr.key, sc);
  }
  if (!out.size && docPath && /\.vars\.json$/.test(docPath)) {
    for (const v of (doc && doc.variables) || []) add(v && v.key, path.basename(docPath, ".vars.json"));
  }
  return out;
}

// The variables context of a set of screen files — ONE implementation for cross-check.js and audit.js
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
function variablesContext(screenFiles, varsFile, fs, path, opts) {
  const readJson = (f) => { try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; } catch (_) { return null; } };
  const files = screenFiles || [];
  const own = files.map((f) => readJson(String(f).replace(/\.json$/, ".vars.json")));
  let variablesPath = varsFile || null;
  if (!variablesPath && files.length) {
    const exportRoot = path.resolve(path.dirname(files[0]), "..", "..");
    const rootVars = path.join(exportRoot, "variables.json");
    const sibling = path.join(path.dirname(files[0]), "variables.json");
    if (fs.existsSync(rootVars)) variablesPath = rootVars;
    else if (fs.existsSync(sibling)) variablesPath = sibling;
    else if (opts && opts.sliceFallback && files.length === 1 && own[0]) variablesPath = String(files[0]).replace(/\.json$/, ".vars.json");
  }
  const variablesDoc = readJson(variablesPath);
  let staleLegacy = null;
  if (files.length) {
    const legacy = path.join(path.resolve(path.dirname(files[0]), "..", ".."), "..", "variables.json");
    if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(variablesPath || "")) staleLegacy = legacy;
  }
  return { own, variablesPath, variablesDoc, sliceSources: variablesDoc ? sourcesOf(variablesDoc, variablesPath, fs, path) : null, staleLegacy };
}

module.exports = { sourcesOf, variablesContext };
