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

module.exports = { sourcesOf };
